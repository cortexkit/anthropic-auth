import { constants as fsConstants } from 'node:fs'
import * as fs from 'node:fs/promises'
import { homedir, userInfo } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import {
  type BindIdentity,
  type CatalogEntry,
  type CloseRouteOptions,
  type ManagedCallOptions,
  type ManagedCloseRouteOptions,
  type RequestOptions,
  type RouteHandle,
  type RouteOpenOptions,
  type RouteTarget,
  SubcCallError,
  SubcClient,
  type SubscribeOptions,
  type Subscription,
} from '@cortexkit/subc-client'
import type { ClaustrumConfig, OAuthAccount } from './accounts.ts'
import { parseJsonRedacted } from './json'
import { logger } from './logger'

export type ClaustrumEndpoint = {
  host: string
  port: number
}

export type ClaustrumDetection =
  | {
      status: 'available'
      schema: number
      wireVersion: number
      endpoints: ClaustrumEndpoint[]
    }
  | {
      status: 'absent'
      path: string
    }
  | {
      status: 'malformed'
      path: string
      reason: string
    }

export function getDefaultClaustrumConnectionPath(): string {
  const uid = process.getuid?.() ?? userInfo().uid
  return `/run/user/${uid}/subc-connection.json`
}

type CustodyHandlesEnvironment = Readonly<Record<string, string | undefined>>

export function resolveCustodyHandlesPath(
  config: Pick<ClaustrumConfig, 'handlesFile'> | undefined,
  env: CustodyHandlesEnvironment,
): string {
  const configuredPath = config?.handlesFile?.trim()
  if (configuredPath) return configuredPath

  const environmentPath = env.CLAUSTRUM_OPENCODE_HANDLES
  if (environmentPath && isAbsolute(environmentPath)) return environmentPath

  const configHome =
    env.XDG_CONFIG_HOME?.trim() || join(env.HOME || homedir(), '.config')
  return join(configHome, 'cortexkit', 'opencode-handles.json')
}

export function getDefaultClaustrumHandlesPath(): string {
  return resolveCustodyHandlesPath(undefined, process.env)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isEndpoint(value: unknown): value is ClaustrumEndpoint {
  return (
    isRecord(value) &&
    typeof value.host === 'string' &&
    value.host.trim().length > 0 &&
    typeof value.port === 'number' &&
    Number.isInteger(value.port) &&
    value.port > 0 &&
    value.port <= 65_535
  )
}

export async function detectClaustrumConnection(
  path = getDefaultClaustrumConnectionPath(),
): Promise<ClaustrumDetection> {
  let raw: string
  try {
    raw = await fs.readFile(path, 'utf8')
  } catch (error) {
    const code = errorCode(error)
    if (code === 'ENOENT') return { status: 'absent', path }
    return {
      status: 'malformed',
      path,
      reason: `unreadable (${code})`,
    }
  }

  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return {
      status: 'malformed',
      path,
      reason: 'invalid JSON',
    }
  }

  if (
    !isRecord(value) ||
    typeof value.schema !== 'number' ||
    !Number.isFinite(value.schema) ||
    typeof value.wire_version !== 'number' ||
    !Number.isFinite(value.wire_version) ||
    !Array.isArray(value.endpoints) ||
    value.endpoints.length === 0 ||
    !value.endpoints.every(isEndpoint)
  ) {
    return {
      status: 'malformed',
      path,
      reason:
        'connection file has an invalid schema, wire_version, or endpoints',
    }
  }

  return {
    status: 'available',
    schema: value.schema,
    wireVersion: value.wire_version,
    endpoints: value.endpoints.map((endpoint) => ({
      host: endpoint.host,
      port: endpoint.port,
    })),
  }
}

export const CUSTODY_TOMBSTONE_PREFIX = 'claustrum-tombstone:v1:'

export function custodyTombstoneKey(provider: string): string {
  return `${CUSTODY_TOMBSTONE_PREFIX}${provider}`
}

export function isCustodyTombstoneValue(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(CUSTODY_TOMBSTONE_PREFIX)
}

export function isCustodyTombstoneOAuth(
  auth: unknown,
  provider: string,
): boolean {
  if (!isRecord(auth) || auth.type !== 'oauth') return false
  const key = custodyTombstoneKey(provider)
  return auth.refresh === key && auth.access === key
}

export class CustodyTombstoneRefreshError extends Error {
  readonly code = 'custody_tombstone_refresh'

  constructor(public readonly provider: string) {
    super(
      `${provider} main slot is vault-custodied; local refresh is forbidden — the vault-served main path is not yet implemented`,
    )
    this.name = 'CustodyTombstoneRefreshError'
  }
}

export function assertNotCustodyTombstone(
  refreshToken: unknown,
  provider: string,
): void {
  if (isCustodyTombstoneValue(refreshToken)) {
    throw new CustodyTombstoneRefreshError(provider)
  }
}

export type CustodyHandleAccount = {
  label: string
  handle: string
  credentialId: string
}

export type CustodyHandleManifest = {
  version: 1
  provider: 'anthropic'
  serve: 'anthropic-auth'
  accounts: ReadonlyArray<CustodyHandleAccount>
  superseded: ReadonlySet<string>
}

export type CustodyHandleResolution =
  | { status: 'resolved'; source: 'manifest' | 'legacy'; handle: string }
  | {
      status: 'unresolved'
      reason:
        | 'missing-label'
        | 'invalid-label'
        | 'duplicate-label'
        | 'missing-entry'
        | 'foreign-serve'
        | 'superseded'
    }

type ParsedCustodyHandleManifest = {
  version: 1
  provider: string
  serve: string
  accounts: ReadonlyArray<CustodyHandleAccount>
  superseded: ReadonlySet<string>
}

const CUSTODY_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/
// The suffix is base64url for 256 CSPRNG bits; its charset is not fixture-derived.
const CUSTODY_HANDLE_PATTERN = /^ckh_[A-Za-z0-9_-]{43}$/
const RESERVED_CUSTODY_IDS = new Set(['__proto__', 'constructor', 'prototype'])

function isCustodyId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    CUSTODY_ID_PATTERN.test(value) &&
    !RESERVED_CUSTODY_IDS.has(value)
  )
}

export function isValidCustodyHandle(value: unknown): value is string {
  return typeof value === 'string' && CUSTODY_HANDLE_PATTERN.test(value)
}

function legacyOrUnresolved(
  account: OAuthAccount,
  reason: Extract<CustodyHandleResolution, { status: 'unresolved' }>['reason'],
): CustodyHandleResolution {
  if (account.claustrumHandle) {
    return {
      status: 'resolved',
      source: 'legacy',
      handle: account.claustrumHandle,
    }
  }
  return { status: 'unresolved', reason }
}

/**
 * | manifest state | legacy handle | result |
 * | --- | --- | --- |
 * | matching ready entry | any | manifest handle |
 * | absent or invalid | present | legacy handle |
 * | no matching ready entry | present | legacy handle |
 * | foreign serve | any | unresolved |
 */
export function resolveCustodyHandle(input: {
  account: OAuthAccount
  manifest: CustodyHandleManifest | undefined
  duplicateOAuthLabels?: ReadonlySet<string>
}): CustodyHandleResolution {
  const { account, manifest, duplicateOAuthLabels } = input
  if (manifest && manifest.serve !== 'anthropic-auth') {
    return { status: 'unresolved', reason: 'foreign-serve' }
  }
  if (!account.label) return legacyOrUnresolved(account, 'missing-label')
  if (!isCustodyId(account.label)) {
    return legacyOrUnresolved(account, 'invalid-label')
  }
  if (duplicateOAuthLabels?.has(account.label)) {
    return legacyOrUnresolved(account, 'duplicate-label')
  }
  if (!manifest) return legacyOrUnresolved(account, 'missing-entry')

  const entry = manifest.accounts.find(
    (candidate) =>
      candidate.label === account.label &&
      candidate.credentialId === `oauth:anthropic:${account.label}`,
  )
  if (!entry) return legacyOrUnresolved(account, 'missing-entry')
  if (manifest.superseded.has(entry.handle)) {
    return { status: 'unresolved', reason: 'superseded' }
  }
  return { status: 'resolved', source: 'manifest', handle: entry.handle }
}

export function readCustodyHandles(
  json: unknown,
  provider: string,
  serve: string,
): ParsedCustodyHandleManifest {
  if (!isCustodyId(provider)) {
    throw new Error('invalid manifest provider')
  }
  if (
    !isRecord(json) ||
    !Object.hasOwn(json, 'version') ||
    json.version !== 1
  ) {
    throw new Error('invalid manifest version')
  }
  if (!Object.hasOwn(json, 'providers') || !Array.isArray(json.providers)) {
    throw new Error('missing manifest providers')
  }
  const providerEntries = json.providers.filter(
    (entry): entry is Record<string, unknown> =>
      isRecord(entry) &&
      Object.hasOwn(entry, 'provider') &&
      entry.provider === provider,
  )
  if (providerEntries.length === 0) {
    throw new CustodyManifestSelectionError('missing-provider')
  }
  const source = providerEntries.find(
    (entry) => Object.hasOwn(entry, 'serve') && entry.serve === serve,
  )
  if (!source) throw new CustodyManifestSelectionError('foreign-serve')
  if (!Object.hasOwn(source, 'accounts') || !Array.isArray(source.accounts)) {
    throw new Error('invalid manifest accounts')
  }
  const superseded = new Set<string>()
  return {
    version: 1,
    provider,
    serve,
    accounts: source.accounts.map((entry) => {
      if (!isRecord(entry)) throw new Error('invalid account entry')
      if (
        !Object.hasOwn(entry, 'label') ||
        !Object.hasOwn(entry, 'handle') ||
        !Object.hasOwn(entry, 'credential_id') ||
        typeof entry.label !== 'string' ||
        !isCustodyId(entry.label)
      )
        throw new Error('invalid account label')
      if (
        typeof entry.handle !== 'string' ||
        !isValidCustodyHandle(entry.handle)
      ) {
        throw new Error('invalid account handle')
      }
      if (
        typeof entry.credential_id !== 'string' ||
        entry.credential_id.length === 0
      ) {
        throw new Error('invalid account credential id')
      }
      if (Object.hasOwn(entry, 'superseded')) {
        if (!Array.isArray(entry.superseded)) {
          throw new Error('invalid superseded handles')
        }
        for (const handle of entry.superseded) {
          if (!isValidCustodyHandle(handle)) {
            throw new Error('invalid superseded handle')
          }
          superseded.add(handle)
        }
      }
      return {
        label: entry.label,
        handle: entry.handle,
        credentialId: entry.credential_id,
      }
    }),
    superseded,
  }
}

type CustodyHandleManifestReadResult =
  | { status: 'ready'; manifest: CustodyHandleManifest }
  | { status: 'absent' }
  | { status: 'ignored'; reason: 'foreign-serve' | 'missing-provider' }
  | { status: 'invalid'; reason: string }

class CustodyManifestSelectionError extends Error {
  constructor(readonly reason: 'foreign-serve' | 'missing-provider') {
    super(reason)
  }
}

const MAX_CUSTODY_MANIFEST_BYTES = 256 * 1024

function errorCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException).code
  return typeof code === 'string' ? code : 'unknown'
}

function validateManifestFile(
  stats: Awaited<ReturnType<typeof fs.lstat>>,
  expectedUid: number,
): string | null {
  const mode = Number(stats.mode)
  if (stats.isSymbolicLink()) return 'manifest is a symlink'
  if (!stats.isFile()) return 'manifest is not a regular file'
  if ((mode & 0o777) !== 0o600) return 'manifest mode must be 0600'
  if (stats.uid !== expectedUid) return 'manifest owner does not match'
  return null
}

function validateManifestParent(
  stats: Awaited<ReturnType<typeof fs.lstat>>,
  expectedUid: number,
): string | null {
  const mode = Number(stats.mode)
  if (stats.uid !== expectedUid) return 'manifest parent owner does not match'
  if ((mode & 0o002) !== 0 && (mode & 0o1000) === 0) {
    return 'manifest parent is world-writable'
  }
  return null
}

export class CustodyHandleManifestReader {
  #cache:
    | {
        mtimeMs: number
        size: number
        result: Extract<
          CustodyHandleManifestReadResult,
          { status: 'ready' | 'ignored' }
        >
      }
    | undefined

  readonly #options: {
    path: string
    provider: 'anthropic'
    serve: 'anthropic-auth'
    expectedUid?: number
  }

  constructor(options: {
    path: string
    provider: 'anthropic'
    serve: 'anthropic-auth'
    expectedUid?: number
  }) {
    this.#options = options
  }

  async read(): Promise<CustodyHandleManifestReadResult> {
    const expectedUid =
      this.#options.expectedUid ?? process.getuid?.() ?? userInfo().uid
    let pathStats: Awaited<ReturnType<typeof fs.lstat>>
    try {
      pathStats = await fs.lstat(this.#options.path)
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return { status: 'absent' }
      return { status: 'invalid', reason: `unreadable (${errorCode(error)})` }
    }

    const fileReason = validateManifestFile(pathStats, expectedUid)
    if (fileReason) return { status: 'invalid', reason: fileReason }

    try {
      const parentReason = validateManifestParent(
        await fs.lstat(dirname(this.#options.path)),
        expectedUid,
      )
      if (parentReason) return { status: 'invalid', reason: parentReason }
    } catch (error) {
      return { status: 'invalid', reason: `unreadable (${errorCode(error)})` }
    }

    let handle: fs.FileHandle | undefined
    try {
      handle = await fs.open(
        this.#options.path,
        fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
      )
      // The validated descriptor, not the path, is the authority for content and metadata after open.
      const openedStats = await handle.stat()
      const openedFileReason = validateManifestFile(openedStats, expectedUid)
      if (openedFileReason)
        return { status: 'invalid', reason: openedFileReason }

      if (
        this.#cache?.mtimeMs === openedStats.mtimeMs &&
        this.#cache.size === openedStats.size
      ) {
        return this.#cache.result
      }

      const bytes = new Uint8Array(MAX_CUSTODY_MANIFEST_BYTES + 1)
      const { bytesRead } = await handle.read(bytes, 0, bytes.byteLength, 0)
      if (bytesRead > MAX_CUSTODY_MANIFEST_BYTES) {
        return { status: 'invalid', reason: 'manifest exceeds maximum size' }
      }

      let json: unknown
      try {
        json = parseJsonRedacted(
          new TextDecoder().decode(bytes.subarray(0, bytesRead)),
        )
      } catch (error) {
        return {
          status: 'invalid',
          reason: error instanceof Error ? error.message : 'invalid JSON',
        }
      }

      let parsed: ParsedCustodyHandleManifest
      try {
        parsed = readCustodyHandles(
          json,
          this.#options.provider,
          this.#options.serve,
        )
      } catch (error) {
        if (error instanceof CustodyManifestSelectionError) {
          const result = { status: 'ignored', reason: error.reason } as const
          this.#cache = {
            mtimeMs: openedStats.mtimeMs,
            size: openedStats.size,
            result,
          }
          return result
        }
        return {
          status: 'invalid',
          reason: error instanceof Error ? error.message : 'invalid manifest',
        }
      }

      const manifest: CustodyHandleManifest = {
        version: parsed.version,
        provider: this.#options.provider,
        serve: this.#options.serve,
        accounts: parsed.accounts,
        superseded: parsed.superseded,
      }
      const result = { status: 'ready', manifest } as const
      this.#cache = {
        mtimeMs: openedStats.mtimeMs,
        size: openedStats.size,
        result,
      }
      return result
    } catch (error) {
      return { status: 'invalid', reason: `unreadable (${errorCode(error)})` }
    } finally {
      await handle?.close().catch(() => {})
    }
  }
}

export type ClaustrumClientOptions = {
  connectionFile?: string
  handshakeTimeoutMs?: number
  connector?: ClaustrumConnector
}

export type ClaustrumConnector = (options: {
  connectionFile: string
  handshakeTimeoutMs?: number
}) => Promise<SubcClient>

export class ClaustrumClient {
  #client: SubcClient
  readonly #connector: ClaustrumConnector
  readonly #connectionFile: string
  readonly #handshakeTimeoutMs?: number
  #reconnecting: Promise<void> | null = null
  #nextReconnectAt = 0
  #closed = false

  private constructor(
    client: SubcClient,
    connector: ClaustrumConnector,
    connectionFile: string,
    handshakeTimeoutMs?: number,
  ) {
    this.#client = client
    this.#connector = connector
    this.#connectionFile = connectionFile
    this.#handshakeTimeoutMs = handshakeTimeoutMs
  }

  static async connect(
    options: ClaustrumClientOptions = {},
  ): Promise<ClaustrumClient> {
    const connectionFile =
      options.connectionFile ?? getDefaultClaustrumConnectionPath()
    const connector =
      options.connector ??
      ((connectOptions) => SubcClient.connect(connectOptions))
    const client = await connector({
      connectionFile,
      handshakeTimeoutMs: options.handshakeTimeoutMs,
    })
    return new ClaustrumClient(
      client,
      connector,
      connectionFile,
      options.handshakeTimeoutMs,
    )
  }

  async catalogList(moduleId?: string): Promise<CatalogEntry[]> {
    return this.#client.catalogList(moduleId)
  }

  async routeOpen(
    target: RouteTarget,
    identity: BindIdentity,
    options: Omit<RouteOpenOptions, 'consumerIdentity'> = {},
  ): Promise<RouteHandle> {
    // The host process inherits aft's supervised-spawn environment; null is the
    // library contract that omits that identity instead of impersonating aft.
    return this.#client.routeOpen(target, identity, {
      ...options,
      consumerIdentity: null,
    })
  }

  async request(
    handle: RouteHandle,
    body: unknown,
    options: RequestOptions = {},
  ): Promise<unknown> {
    return this.#client.request(handle, body, options)
  }

  async call<Response = unknown>(
    moduleId: string,
    method: string,
    params?: unknown,
    options: Omit<ManagedCallOptions, 'consumerIdentity'> = {},
  ): Promise<Response> {
    try {
      return await this.#client.call<Response>(moduleId, method, params, {
        ...options,
        consumerIdentity: null,
      })
    } catch (error) {
      if (!this.#shouldReconnect(error)) throw error
      await this.#reconnect()
      return this.#client.call<Response>(moduleId, method, params, {
        ...options,
        consumerIdentity: null,
      })
    }
  }

  subscribe(
    handle: RouteHandle,
    body: unknown,
    onEvent: (event: Uint8Array) => void,
    options: SubscribeOptions = {},
  ): Subscription {
    return this.#client.subscribe(handle, body, onEvent, options)
  }

  async closeRoute(
    handle: RouteHandle,
    options: CloseRouteOptions = {},
  ): Promise<void> {
    return this.#client.closeRoute(handle, options)
  }

  async closeManagedRoute(
    target: Extract<
      RouteTarget,
      { kind: 'management_surface' | 'tool_provider' }
    >,
    identity: BindIdentity,
    options: Omit<ManagedCloseRouteOptions, 'consumerIdentity'> = {},
  ): Promise<void> {
    return this.#client.closeManagedRoute(target, identity, {
      ...options,
      consumerIdentity: null,
    })
  }

  close(): void {
    this.#closed = true
    this.#client.close()
  }

  #shouldReconnect(error: unknown): boolean {
    return (
      !this.#closed &&
      error instanceof SubcCallError &&
      error.kind === 'terminal' &&
      error.code !== 'missing_identity' &&
      error.code !== 'invalid_control_body'
    )
  }

  async #reconnect(): Promise<void> {
    if (this.#closed) throw new Error('Claustrum client is closed')
    if (this.#reconnecting) {
      await this.#reconnecting
      return
    }
    const now = Date.now()
    if (now < this.#nextReconnectAt) {
      throw new Error('Claustrum client reconnect is backed off')
    }
    this.#nextReconnectAt = now + CLAUSTRUM_CREDENTIAL_REFRESH_BACKOFF_MS
    this.#reconnecting = this.#connector({
      connectionFile: this.#connectionFile,
      handshakeTimeoutMs: this.#handshakeTimeoutMs,
    })
      .then((client) => {
        if (this.#closed) {
          client.close()
          throw new Error('Claustrum client is closed')
        }
        const previous = this.#client
        this.#client = client
        previous.close()
      })
      .finally(() => {
        this.#reconnecting = null
      })
    await this.#reconnecting
  }
}

export function connectClaustrumClient(
  options: ClaustrumClientOptions = {},
): Promise<ClaustrumClient> {
  return ClaustrumClient.connect(options)
}

export const CLAUSTRUM_MODULE_ID = 'claustrum'
export const DEFAULT_CLAUSTRUM_CREDENTIAL_MIN_TTL_MS = 120_000
const CLAUSTRUM_CREDENTIAL_REFRESH_BACKOFF_MS = 60_000
export const ERROR_CLASS_WIRE_SET = [
  'transient',
  'permanent',
  'auth_required',
  'context_overflow',
] as const

export type ClaustrumCredentialErrorClass =
  (typeof ERROR_CLASS_WIRE_SET)[number]

export type ClaustrumCredentialErrorAction =
  | 'gone'
  | 'reauth'
  | 'retry'
  | 'reduce_and_retry'

export type ClaustrumCredential = {
  payload: string
  expiresAtMs: number | null
  recordVersion: number
  projectId?: string
  accountId?: string
}

export type ClaustrumServedCredential = Pick<
  ClaustrumCredential,
  'recordVersion'
>
export type ClaustrumReporterSource =
  | 'direct'
  | 'relay_status_field'
  | 'relay_message_parse'

export class ClaustrumCredentialError extends Error {
  readonly errorClass: ClaustrumCredentialErrorClass

  constructor(
    message: string,
    public readonly code: string,
    errorClass: ClaustrumCredentialErrorClass,
    public readonly action: ClaustrumCredentialErrorAction,
  ) {
    super(message)
    this.name = 'ClaustrumCredentialError'
    this.errorClass = errorClass
  }
}

export type ClaustrumCredentialCacheOptions = {
  identity?: BindIdentity
  now?: () => number
  minTtlMs?: number
}

type CredentialGetResult = {
  payload: string
  expiresAtMs: number | null
  recordVersion: number
  projectId?: string
  accountId?: string
}

function credentialErrorAction(
  errorClass: ClaustrumCredentialErrorClass,
): ClaustrumCredentialErrorAction {
  switch (errorClass) {
    case 'permanent':
      return 'gone'
    case 'auth_required':
      return 'reauth'
    case 'context_overflow':
      return 'reduce_and_retry'
    case 'transient':
      return 'retry'
  }
}

function asCredentialError(
  response: unknown,
  fallbackCode = 'invalid_response',
): ClaustrumCredentialError {
  const result =
    isRecord(response) && isRecord(response.result)
      ? response.result
      : undefined
  const error = result && isRecord(result.error) ? result.error : undefined
  const rawErrorClass = error?.class
  const errorClass =
    typeof rawErrorClass === 'string' &&
    (ERROR_CLASS_WIRE_SET as readonly string[]).includes(rawErrorClass)
      ? (rawErrorClass as ClaustrumCredentialErrorClass)
      : 'transient'
  if (
    typeof rawErrorClass !== 'string' ||
    !(ERROR_CLASS_WIRE_SET as readonly string[]).includes(rawErrorClass)
  ) {
    logger.warn('claustrum', 'unrecognised credential error class', {
      errorClass: rawErrorClass ?? null,
    })
  }
  const code =
    error && typeof error.code === 'string' ? error.code : fallbackCode
  return new ClaustrumCredentialError(
    `Claustrum credential request failed: ${code}`,
    code,
    errorClass,
    credentialErrorAction(errorClass),
  )
}

function asCredentialCallError(error: unknown): Error {
  if (error instanceof ClaustrumCredentialError) {
    return error
  }
  if (error instanceof SubcCallError && error.kind === 'terminal') {
    logger.warn('claustrum', 'terminal credential call failed', {
      code: error.code ?? null,
      message: error.message,
    })
    return new ClaustrumCredentialError(
      `Claustrum credential request failed: ${error.message}`,
      error.code ?? 'terminal_error',
      'transient',
      'retry',
    )
  }
  const message = error instanceof Error ? error.message : String(error)
  const code =
    isRecord(error) && typeof error.code === 'string'
      ? error.code
      : 'transport_error'
  return new ClaustrumCredentialError(
    `Claustrum credential request failed: ${message}`,
    code,
    'transient',
    'retry',
  )
}

function decodeCredentialGetResponse(response: unknown): CredentialGetResult {
  const result =
    isRecord(response) && isRecord(response.result)
      ? response.result
      : undefined

  if (result && isRecord(result.error)) {
    throw asCredentialError(response)
  }

  const payload = result?.payload
  if (
    !Array.isArray(payload) ||
    payload.length === 0 ||
    !payload.every(
      (value) =>
        typeof value === 'number' &&
        Number.isInteger(value) &&
        value >= 0 &&
        value <= 255,
    )
  ) {
    throw asCredentialError(response)
  }

  const recordVersion = result?.record_version
  if (
    typeof recordVersion !== 'number' ||
    !Number.isSafeInteger(recordVersion) ||
    recordVersion < 0
  ) {
    throw asCredentialError(response, 'invalid_record_version')
  }

  const rawExpiresAtMs = result?.expires_at_ms
  const expiresAtMs =
    rawExpiresAtMs === null || rawExpiresAtMs === undefined
      ? null
      : typeof rawExpiresAtMs === 'number' && Number.isFinite(rawExpiresAtMs)
        ? rawExpiresAtMs
        : undefined
  if (expiresAtMs === undefined) {
    throw asCredentialError(response, 'invalid_expiry')
  }

  const decoded = new TextDecoder().decode(Uint8Array.from(payload))

  return {
    payload: decoded,
    expiresAtMs,
    recordVersion,
    ...(typeof result?.project_id === 'string' && {
      projectId: result.project_id,
    }),
    ...(typeof result?.account_id === 'string' && {
      accountId: result.account_id,
    }),
  }
}

export class ClaustrumCredentialCache {
  readonly #cache = new Map<string, ClaustrumCredential>()
  readonly #inFlight = new Map<string, Promise<ClaustrumCredential>>()
  readonly #client: ClaustrumClient
  readonly #identity?: BindIdentity
  readonly #now: () => number
  readonly #refreshBackoffUntil = new Map<string, number>()
  #minTtlMs: number

  constructor(
    client: ClaustrumClient,
    options: ClaustrumCredentialCacheOptions = {},
  ) {
    this.#client = client
    this.#identity = options.identity
    this.#now = options.now ?? Date.now
    this.#minTtlMs = options.minTtlMs ?? DEFAULT_CLAUSTRUM_CREDENTIAL_MIN_TTL_MS
    if (!Number.isSafeInteger(this.#minTtlMs) || this.#minTtlMs < 0) {
      throw new RangeError('minTtlMs must be a non-negative safe integer')
    }
  }

  async get(
    handle: string,
    minTtlMs = this.#minTtlMs,
    options: { cacheIf?: () => boolean } = {},
  ): Promise<ClaustrumCredential> {
    if (!Number.isSafeInteger(minTtlMs) || minTtlMs < 0) {
      throw new RangeError('minTtlMs must be a non-negative safe integer')
    }
    const now = this.#now()
    const cached = this.#cache.get(handle)
    if (cached && cached.expiresAtMs !== null && cached.expiresAtMs > now) {
      if (cached.expiresAtMs - now <= minTtlMs) {
        this.#refreshIfApproachingExpiry(handle, now, minTtlMs)
      }
      return cached
    }
    if (cached) {
      this.#cache.delete(handle)
      this.#refreshBackoffUntil.delete(handle)
    }

    const pending = this.#inFlight.get(handle)
    if (pending) return pending

    const load = this.#load(handle, minTtlMs, options.cacheIf)
    this.#inFlight.set(handle, load)
    try {
      return await load
    } finally {
      if (this.#inFlight.get(handle) === load) this.#inFlight.delete(handle)
    }
  }

  peek(handle: string): ClaustrumCredential | undefined {
    return this.#cache.get(handle)
  }

  abandonPending(handle: string): void {
    this.#inFlight.delete(handle)
  }

  seedForTest(handle: string, credential: ClaustrumCredential): void {
    this.#cache.set(handle, credential)
  }

  reduceMinTtlMs(): number {
    this.#minTtlMs = Math.floor(this.#minTtlMs / 2)
    return this.#minTtlMs
  }

  async reportAuthFailure(
    handle: string,
    providerStatus: number,
    servedCredential: ClaustrumServedCredential,
    reporterSource?: ClaustrumReporterSource,
  ): Promise<void>
  async reportAuthFailure(
    handle: string,
    servedCredential: ClaustrumServedCredential,
    providerStatus?: number,
    reporterSource?: ClaustrumReporterSource,
  ): Promise<void>
  async reportAuthFailure(
    handle: string,
    providerStatusOrServedCredential: number | ClaustrumServedCredential,
    servedCredentialOrStatus?: ClaustrumServedCredential | number,
    reporterSource?: ClaustrumReporterSource,
  ): Promise<void> {
    const providerStatus =
      typeof providerStatusOrServedCredential === 'number'
        ? providerStatusOrServedCredential
        : typeof servedCredentialOrStatus === 'number'
          ? servedCredentialOrStatus
          : 401
    const servedCredential =
      typeof providerStatusOrServedCredential === 'number'
        ? typeof servedCredentialOrStatus === 'object' &&
          servedCredentialOrStatus !== null
          ? servedCredentialOrStatus
          : undefined
        : providerStatusOrServedCredential
    const recordVersion = servedCredential?.recordVersion
    if (
      typeof recordVersion !== 'number' ||
      !Number.isSafeInteger(recordVersion) ||
      recordVersion < 0
    ) {
      throw new TypeError(
        'record_version is required from the credential served to the provider',
      )
    }

    try {
      let response: unknown
      try {
        response = await this.#client.call(
          CLAUSTRUM_MODULE_ID,
          'credential.report_auth_failure',
          {
            handle,
            provider_status: providerStatus,
            record_version: recordVersion,
            ...(reporterSource ? { reporter_source: reporterSource } : {}),
          },
          { identity: this.#identity },
        )
      } catch (error) {
        throw asCredentialCallError(error)
      }
      const result =
        isRecord(response) && isRecord(response.result)
          ? response.result
          : undefined
      if (result && isRecord(result.error)) {
        throw asCredentialError(response)
      }
    } finally {
      this.invalidate(handle, recordVersion)
    }
  }

  invalidate(handle: string, recordVersion?: number): void {
    const cached = this.#cache.get(handle)
    if (
      cached &&
      (recordVersion === undefined || cached.recordVersion === recordVersion)
    ) {
      this.#cache.delete(handle)
    }
  }

  close(): void {
    this.#client.close()
  }

  #refreshIfApproachingExpiry(
    handle: string,
    now: number,
    minTtlMs: number,
  ): void {
    if (this.#inFlight.has(handle)) return
    const retryAt = this.#refreshBackoffUntil.get(handle)
    if (retryAt !== undefined && retryAt > now) return

    this.#refreshBackoffUntil.set(
      handle,
      now + CLAUSTRUM_CREDENTIAL_REFRESH_BACKOFF_MS,
    )
    const load = this.#load(handle, minTtlMs)
    this.#inFlight.set(handle, load)
    void load
      .catch(() => {})
      .finally(() => {
        if (this.#inFlight.get(handle) === load) this.#inFlight.delete(handle)
      })
  }

  async #load(
    handle: string,
    minTtlMs: number,
    cacheIf?: () => boolean,
  ): Promise<ClaustrumCredential> {
    let response: unknown
    try {
      response = await this.#client.call(
        CLAUSTRUM_MODULE_ID,
        'credential.get',
        {
          handle,
          force_refresh: false,
          min_ttl_ms: minTtlMs,
        },
        { identity: this.#identity },
      )
    } catch (error) {
      throw asCredentialCallError(error)
    }
    const result = decodeCredentialGetResponse(response)
    const credential: ClaustrumCredential = {
      payload: result.payload,
      expiresAtMs: result.expiresAtMs,
      recordVersion: result.recordVersion,
      ...(result.projectId !== undefined && { projectId: result.projectId }),
      ...(result.accountId !== undefined && { accountId: result.accountId }),
    }
    if (
      credential.expiresAtMs !== null &&
      credential.expiresAtMs > this.#now() &&
      (cacheIf?.() ?? true)
    ) {
      this.#cache.set(handle, credential)
    }
    return credential
  }
}

export type ConnectClaustrumCredentialCacheOptions = ClaustrumClientOptions &
  ClaustrumCredentialCacheOptions & {
    enabled?: boolean
  }

export async function connectClaustrumCredentialCache(
  options: ConnectClaustrumCredentialCacheOptions = {},
): Promise<ClaustrumCredentialCache | null> {
  if (options.enabled !== true) return null

  const {
    enabled: _enabled,
    identity,
    now,
    minTtlMs,
    ...clientOptions
  } = options
  const client = await connectClaustrumClient(clientOptions)
  return new ClaustrumCredentialCache(client, { identity, now, minTtlMs })
}
