import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import {
  chmod,
  mkdir,
  open,
  realpath,
  rename,
  stat,
  unlink,
} from 'node:fs/promises'
import { homedir } from 'node:os'
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  resolve,
} from 'node:path'
import {
  ClaustrumCredentialError,
  type ClaustrumClientOptions as ClaustrumEnrollmentClientOptions,
  ClaustrumClient as ClaustrumWireClient,
  type EnrollmentPollOutcome,
  type EnrollmentTokenFile,
  writeEnrollmentTokenFile,
} from '@cortexkit/claustrum-client'
import { acquireRefreshFileLock } from './accounts.js'
import { parseJsonRedacted } from './json.js'
import {
  createWindowsOwnerOnly,
  isSafeWindowsParent,
  type OwnerOnlyOptions,
  readWindowsOwnerOnly,
} from './owner-only.ts'
import { anthropicAuthStateRoot } from './state-layout-paths.ts'

export const CLAUSTRUM_OPENCODE_ENROLLMENT_NAME = 'anthropic-auth-opencode'
export const CLAUSTRUM_PI_ENROLLMENT_NAME = 'anthropic-auth-pi'
const ENROLLMENT_SCHEMA = 1
const ENROLLMENT_FILE_MAX_BYTES = 16 * 1024
const ENROLLMENT_LOCK_TTL_MS = 30_000
const TOKEN_RE = /^[0-9a-f]{64}$/
// Claustrum's closed EnrollmentRefusal vocabulary marks every code here
// permanent. claustrum#69: the client currently relabels module Error frames
// transient/retry, so the producer's code must take precedence over action.
// pending_queue_full, store_error and transport_error remain retryable.
const TERMINAL_ENROLLMENT_CODES = new Set([
  'invalid_params',
  'pending_exists',
  'not_found',
  'already_consumed',
  'superseded',
  'stale_generation',
])

export interface ClaustrumEnrollmentClient {
  enrollPropose(input: {
    name: string
    requestSecretHash: string
  }): Promise<{ requestId: string }>
  enrollPoll(input: {
    requestId: string
    requestSecret: string
  }): Promise<EnrollmentPollOutcome>
}

export interface ClaustrumEnrollmentConnection
  extends ClaustrumEnrollmentClient {
  close(): void
}

export function connectClaustrumEnrollmentClient(
  options: ClaustrumEnrollmentClientOptions = {},
): Promise<ClaustrumEnrollmentConnection> {
  return ClaustrumWireClient.connect(options)
}

interface PendingEnrollmentState {
  version: 1
  phase: 'pending'
  proposedName: string
  requestSecret: string
  requestId?: string
  createdAt: number
  updatedAt: number
}

interface ApprovedEnrollmentState {
  version: 1
  phase: 'approved'
  proposedName: string
  approvedName?: string
  tokenGeneration: number
  updatedAt: number
}

interface TerminalEnrollmentState {
  version: 1
  phase: 'denied' | 'blocked'
  proposedName: string
  errorCode?: string
  updatedAt: number
}

type EnrollmentState =
  | PendingEnrollmentState
  | ApprovedEnrollmentState
  | TerminalEnrollmentState

export type ClaustrumEnrollmentStatus =
  | { state: 'idle' }
  | {
      state: 'pending'
      proposedName: string
      requestId?: string
      retryCode?: string
    }
  | {
      state: 'approved'
      proposedName: string
      approvedName?: string
      tokenGeneration: number
    }
  | { state: 'denied'; proposedName: string }
  | { state: 'blocked'; proposedName: string; code: string }
  | { state: 'unavailable'; proposedName: string; code: string }
  | { state: 'busy' }

export interface ClaustrumEnrollmentPaths {
  statePath: string
  tokenPath: string
}

export function getClaustrumEnrollmentPaths(
  tokenPath: string,
): ClaustrumEnrollmentPaths {
  const extension = extname(tokenPath) || '.json'
  const stem = basename(tokenPath, extname(tokenPath))
  return {
    statePath: join(dirname(tokenPath), `${stem}-state${extension}`),
    tokenPath,
  }
}

/** Resolve the independently enrolled host's owner-only token and state paths. */
export function getHostClaustrumEnrollmentPaths(
  host: 'opencode' | 'pi',
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): ClaustrumEnrollmentPaths {
  const configured =
    env[
      `${host.toUpperCase()}_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE`
    ]?.trim()
  const tokenPath = configured
    ? isAbsolute(configured)
      ? configured
      : resolve(cwd, configured)
    : join(
        anthropicAuthStateRoot({
          xdgStateHome: env.XDG_STATE_HOME,
          home: homedir(),
          acceptRelative: true,
        }),
        `${host}-enrollment.json`,
      )
  return getClaustrumEnrollmentPaths(tokenPath)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function validGeneration(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1
}

function decodeEnrollmentState(value: unknown): EnrollmentState {
  if (
    !isRecord(value) ||
    value.version !== ENROLLMENT_SCHEMA ||
    typeof value.proposedName !== 'string' ||
    value.proposedName.length === 0
  ) {
    throw new Error('invalid Claustrum enrollment state')
  }
  if (value.phase === 'pending') {
    if (
      !TOKEN_RE.test(String(value.requestSecret ?? '')) ||
      (value.requestId !== undefined &&
        (typeof value.requestId !== 'string' ||
          value.requestId.length === 0)) ||
      !validTimestamp(value.createdAt) ||
      !validTimestamp(value.updatedAt)
    ) {
      throw new Error('invalid Claustrum enrollment state')
    }
    return {
      version: 1,
      phase: 'pending',
      proposedName: value.proposedName,
      requestSecret: value.requestSecret as string,
      ...(value.requestId !== undefined && {
        requestId: value.requestId as string,
      }),
      createdAt: value.createdAt,
      updatedAt: value.updatedAt,
    }
  }
  if (value.phase === 'approved') {
    if (
      (value.approvedName !== undefined &&
        (typeof value.approvedName !== 'string' ||
          value.approvedName.length === 0)) ||
      !validGeneration(value.tokenGeneration) ||
      !validTimestamp(value.updatedAt)
    ) {
      throw new Error('invalid Claustrum enrollment state')
    }
    return {
      version: 1,
      phase: 'approved',
      proposedName: value.proposedName,
      ...(value.approvedName !== undefined && {
        approvedName: value.approvedName as string,
      }),
      tokenGeneration: value.tokenGeneration,
      updatedAt: value.updatedAt,
    }
  }
  if (value.phase === 'denied' || value.phase === 'blocked') {
    if (
      (value.errorCode !== undefined && typeof value.errorCode !== 'string') ||
      !validTimestamp(value.updatedAt)
    ) {
      throw new Error('invalid Claustrum enrollment state')
    }
    return {
      version: 1,
      phase: value.phase,
      proposedName: value.proposedName,
      ...(value.errorCode !== undefined && {
        errorCode: value.errorCode as string,
      }),
      updatedAt: value.updatedAt,
    }
  }
  throw new Error('invalid Claustrum enrollment state')
}

function decodeTokenFile(value: unknown): EnrollmentTokenFile {
  if (
    !isRecord(value) ||
    !TOKEN_RE.test(String(value.token ?? '')) ||
    !validGeneration(value.token_generation)
  ) {
    throw new Error('invalid Claustrum enrollment token file')
  }
  return {
    token: value.token as string,
    token_generation: value.token_generation,
  }
}

function validateReadableSecretFile(metadata: {
  isFile(): boolean
  mode: number
  uid: number
}): void {
  if (!metadata.isFile()) {
    throw new Error('Claustrum enrollment file must be a regular file')
  }
  if ((metadata.mode & 0o077) !== 0) {
    throw new Error('Claustrum enrollment file must be owner-only')
  }
  const expectedUid = process.getuid?.()
  if (expectedUid !== undefined && metadata.uid !== expectedUid) {
    throw new Error(
      'Claustrum enrollment file must be owned by the current user',
    )
  }
}

async function readBoundedJson(
  path: string,
  ownership: OwnerOnlyOptions = {},
): Promise<unknown | undefined> {
  let descriptor: Awaited<ReturnType<typeof open>> | undefined
  try {
    const bytes = await readWindowsOwnerOnly(path, ownership)
    if (bytes !== undefined) {
      if (bytes.length > ENROLLMENT_FILE_MAX_BYTES)
        throw new Error('Claustrum enrollment file is too large')
      return parseJsonRedacted(bytes.toString('utf8'))
    }
    descriptor = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new Error('Claustrum enrollment file could not be opened safely')
  }
  try {
    validateReadableSecretFile(await descriptor.stat())
    const source = Buffer.alloc(ENROLLMENT_FILE_MAX_BYTES + 1)
    const { bytesRead } = await descriptor.read(source, 0, source.byteLength, 0)
    if (bytesRead > ENROLLMENT_FILE_MAX_BYTES) {
      throw new Error('Claustrum enrollment file is too large')
    }
    return parseJsonRedacted(source.subarray(0, bytesRead).toString('utf8'))
  } finally {
    await descriptor.close()
  }
}

export async function refuseWritableAncestor(
  parent: string,
  ownership: OwnerOnlyOptions = {},
  metadataAt: (path: string) => Promise<{ mode: number } | undefined> = (
    path,
  ) => stat(path).catch(() => undefined),
): Promise<void> {
  const safe = await isSafeWindowsParent(parent, ownership)
  if (safe === true) return
  if (safe === false)
    throw new Error('Claustrum enrollment path has an unsafe writable ancestor')
  let component: string
  try {
    component = await realpath(parent)
  } catch {
    return
  }
  for (;;) {
    const metadata = await metadataAt(component)
    if (
      metadata &&
      (metadata.mode & 0o022) !== 0 &&
      (metadata.mode & 0o1000) === 0
    ) {
      throw new Error(
        'Claustrum enrollment path has an unsafe writable ancestor',
      )
    }
    const next = dirname(component)
    if (next === component) return
    component = next
  }
}

async function writeStateAtomic(
  path: string,
  state: EnrollmentState,
  beforeRename: () => Promise<void>,
): Promise<void> {
  const parent = dirname(path)
  await mkdir(parent, { recursive: true, mode: 0o700 })
  await refuseWritableAncestor(parent)
  const bytes = `${JSON.stringify(state)}\n`
  if (Buffer.byteLength(bytes) > ENROLLMENT_FILE_MAX_BYTES) {
    throw new Error('Claustrum enrollment state is too large')
  }
  const temporary = join(
    parent,
    `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`,
  )
  let descriptor: Awaited<ReturnType<typeof open>> | undefined
  try {
    const nativeCreated = await createWindowsOwnerOnly(temporary, bytes)
    descriptor = await open(
      temporary,
      nativeCreated ? fsConstants.O_RDWR : 'wx',
      0o600,
    )
    if (!nativeCreated) await descriptor.writeFile(bytes, 'utf8')
    await descriptor.sync()
    await descriptor.close()
    descriptor = undefined
    await chmod(temporary, 0o600)
    await beforeRename()
    await rename(temporary, path)
  } finally {
    await descriptor?.close().catch(() => {})
    await unlink(temporary).catch(() => {})
  }
}

async function writeTokenAtomic(
  path: string,
  value: EnrollmentTokenFile,
  writeTokenFile: typeof writeEnrollmentTokenFile,
  beforeRename: () => Promise<void>,
): Promise<void> {
  const staged = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`,
  )
  try {
    // The client writes token bytes with owner-only permissions or Windows ACLs
    // but cannot check the ceremony lock before replacing the token. Stage through
    // the client, then check ownership immediately before renaming into place.
    await writeTokenFile(staged, value)
    await beforeRename()
    await rename(staged, path)
  } finally {
    await unlink(staged).catch(() => {})
  }
}

export async function readClaustrumEnrollmentStatus(
  paths: ClaustrumEnrollmentPaths,
  proposedName = CLAUSTRUM_OPENCODE_ENROLLMENT_NAME,
  ownership: OwnerOnlyOptions = {},
): Promise<ClaustrumEnrollmentStatus> {
  const tokenValue = await readBoundedJson(paths.tokenPath, ownership)
  const token =
    tokenValue === undefined ? undefined : decodeTokenFile(tokenValue)
  const stateValue = await readBoundedJson(paths.statePath, ownership)
  const state =
    stateValue === undefined ? undefined : decodeEnrollmentState(stateValue)
  if (token) {
    return {
      state: 'approved',
      proposedName: state?.proposedName ?? proposedName,
      ...(state?.phase === 'approved' &&
        state.approvedName !== undefined && {
          approvedName: state.approvedName,
        }),
      tokenGeneration: token.token_generation,
    }
  }
  if (!state) return { state: 'idle' }
  if (state.phase === 'pending') {
    return {
      state: 'pending',
      proposedName: state.proposedName,
      ...(state.requestId !== undefined && { requestId: state.requestId }),
    }
  }
  if (state.phase === 'approved') {
    return {
      state: 'blocked',
      proposedName: state.proposedName,
      code: 'missing_token',
    }
  }
  if (state.phase === 'denied')
    return { state: 'denied', proposedName: state.proposedName }
  return {
    state: 'blocked',
    proposedName: state.proposedName,
    code: state.errorCode ?? 'unknown',
  }
}

/** Read fresh bearer material for a scoped operation; never publish this value. */
export async function readClaustrumEnrollmentToken(
  tokenPath: string,
): Promise<EnrollmentTokenFile> {
  await refuseWritableAncestor(tokenPath)
  const value = await readBoundedJson(tokenPath)
  if (value === undefined)
    throw new Error('Claustrum enrollment is not configured')
  return decodeTokenFile(value)
}

function statusFromState(state: EnrollmentState): ClaustrumEnrollmentStatus {
  if (state.phase === 'pending') {
    return {
      state: 'pending',
      proposedName: state.proposedName,
      ...(state.requestId !== undefined && { requestId: state.requestId }),
    }
  }
  if (state.phase === 'approved') {
    return {
      state: 'approved',
      proposedName: state.proposedName,
      ...(state.approvedName !== undefined && {
        approvedName: state.approvedName,
      }),
      tokenGeneration: state.tokenGeneration,
    }
  }
  if (state.phase === 'denied')
    return { state: 'denied', proposedName: state.proposedName }
  return {
    state: 'blocked',
    proposedName: state.proposedName,
    code: state.errorCode ?? 'unknown',
  }
}

export class ClaustrumEnrollmentManager {
  readonly #client: ClaustrumEnrollmentClient
  readonly #paths: ClaustrumEnrollmentPaths
  readonly #proposedName: string
  readonly #now: () => number
  readonly #mintSecret: () => string
  readonly #writeTokenFile: typeof writeEnrollmentTokenFile

  constructor(options: {
    client: ClaustrumEnrollmentClient
    paths: ClaustrumEnrollmentPaths
    proposedName: string
    now?: () => number
    mintSecret?: () => string
    writeTokenFile?: typeof writeEnrollmentTokenFile
  }) {
    this.#client = options.client
    this.#paths = options.paths
    this.#proposedName = options.proposedName
    this.#now = options.now ?? Date.now
    this.#mintSecret =
      options.mintSecret ?? (() => randomBytes(32).toString('hex'))
    this.#writeTokenFile = options.writeTokenFile ?? writeEnrollmentTokenFile
  }

  async status(): Promise<ClaustrumEnrollmentStatus> {
    return readClaustrumEnrollmentStatus(this.#paths, this.#proposedName)
  }

  async resetTerminal(): Promise<ClaustrumEnrollmentResetResult> {
    return resetClaustrumEnrollmentState(this.#paths, this.#proposedName)
  }

  async reconcile(): Promise<ClaustrumEnrollmentStatus> {
    await mkdir(dirname(this.#paths.statePath), {
      recursive: true,
      mode: 0o700,
    })
    const lock = await acquireRefreshFileLock({
      name: 'ceremony',
      path: this.#paths.statePath,
      ttlMs: ENROLLMENT_LOCK_TTL_MS,
      renew: true,
    })
    if (!lock) return { state: 'busy' }
    try {
      const existingToken = await readBoundedJson(this.#paths.tokenPath)
      const token =
        existingToken === undefined ? undefined : decodeTokenFile(existingToken)
      const stateValue = await readBoundedJson(this.#paths.statePath)
      let state =
        stateValue === undefined ? undefined : decodeEnrollmentState(stateValue)
      if (state && state.proposedName !== this.#proposedName) {
        throw new Error(
          'Claustrum enrollment state belongs to a different consumer',
        )
      }
      if (token) {
        if (!state || state.phase === 'pending') {
          const approved: ApprovedEnrollmentState = {
            version: 1,
            phase: 'approved',
            proposedName: state?.proposedName ?? this.#proposedName,
            tokenGeneration: token.token_generation,
            updatedAt: this.#now(),
          }
          await writeStateAtomic(this.#paths.statePath, approved, () =>
            lock.assertOwned(),
          )
          state = approved
        }
        return {
          state: 'approved',
          proposedName: state.proposedName,
          ...(state.phase === 'approved' &&
            state.approvedName !== undefined && {
              approvedName: state.approvedName,
            }),
          tokenGeneration: token.token_generation,
        }
      }
      if (state?.phase === 'approved') {
        const blocked: TerminalEnrollmentState = {
          version: 1,
          phase: 'blocked',
          proposedName: state.proposedName,
          errorCode: 'missing_token',
          updatedAt: this.#now(),
        }
        await writeStateAtomic(this.#paths.statePath, blocked, () =>
          lock.assertOwned(),
        )
        return statusFromState(blocked)
      }
      if (state && state.phase !== 'pending') return statusFromState(state)
      if (!state) {
        const now = this.#now()
        state = {
          version: 1,
          phase: 'pending',
          proposedName: this.#proposedName,
          requestSecret: this.#mintSecret(),
          createdAt: now,
          updatedAt: now,
        }
        if (!TOKEN_RE.test(state.requestSecret))
          throw new Error('invalid minted Claustrum enrollment secret')
        await writeStateAtomic(this.#paths.statePath, state, () =>
          lock.assertOwned(),
        )
      }

      if (!state.requestId) {
        try {
          const requestSecretHash = createHash('sha256')
            .update(Buffer.from(state.requestSecret, 'hex'))
            .digest('hex')
          const proposed = await this.#client.enrollPropose({
            name: state.proposedName,
            requestSecretHash,
          })
          state = {
            ...state,
            requestId: proposed.requestId,
            updatedAt: this.#now(),
          }
          await writeStateAtomic(this.#paths.statePath, state, () =>
            lock.assertOwned(),
          )
        } catch (error) {
          if (error instanceof ClaustrumCredentialError) {
            if (
              !TERMINAL_ENROLLMENT_CODES.has(error.code) &&
              (error.code === 'pending_queue_full' || error.action === 'retry')
            ) {
              return {
                state: 'pending',
                proposedName: state.proposedName,
                retryCode: error.code,
              }
            }
            const blocked: TerminalEnrollmentState = {
              version: 1,
              phase: 'blocked',
              proposedName: state.proposedName,
              errorCode: error.code,
              updatedAt: this.#now(),
            }
            await writeStateAtomic(this.#paths.statePath, blocked, () =>
              lock.assertOwned(),
            )
            return statusFromState(blocked)
          }
          throw error
        }
      }

      const requestId = state.requestId
      if (!requestId) return statusFromState(state)
      try {
        const outcome = await this.#client.enrollPoll({
          requestId,
          requestSecret: state.requestSecret,
        })
        if (outcome.status === 'pending') return statusFromState(state)
        if (outcome.status === 'denied') {
          const denied: TerminalEnrollmentState = {
            version: 1,
            phase: 'denied',
            proposedName: state.proposedName,
            updatedAt: this.#now(),
          }
          await writeStateAtomic(this.#paths.statePath, denied, () =>
            lock.assertOwned(),
          )
          return statusFromState(denied)
        }
        await writeTokenAtomic(
          this.#paths.tokenPath,
          {
            token: outcome.token,
            token_generation: outcome.tokenGeneration,
          },
          this.#writeTokenFile,
          () => lock.assertOwned(),
        )
        const approved: ApprovedEnrollmentState = {
          version: 1,
          phase: 'approved',
          proposedName: state.proposedName,
          approvedName: outcome.name,
          tokenGeneration: outcome.tokenGeneration,
          updatedAt: this.#now(),
        }
        await writeStateAtomic(this.#paths.statePath, approved, () =>
          lock.assertOwned(),
        )
        return statusFromState(approved)
      } catch (error) {
        if (!(error instanceof ClaustrumCredentialError)) throw error
        if (
          !TERMINAL_ENROLLMENT_CODES.has(error.code) &&
          error.action === 'retry'
        ) {
          return {
            state: 'pending',
            proposedName: state.proposedName,
            requestId,
            retryCode: error.code,
          }
        }
        const blocked: TerminalEnrollmentState = {
          version: 1,
          phase: 'blocked',
          proposedName: state.proposedName,
          errorCode: error.code,
          updatedAt: this.#now(),
        }
        await writeStateAtomic(this.#paths.statePath, blocked, () =>
          lock.assertOwned(),
        )
        return statusFromState(blocked)
      }
    } finally {
      await lock.release()
    }
  }
}

export type ClaustrumEnrollmentResetResult =
  | 'reset'
  | 'idle'
  | 'refused-pending'
  | 'refused-approved'
  | 'busy'

/** Reset local terminal metadata without connecting to the credential daemon. */
export async function resetClaustrumEnrollmentState(
  paths: ClaustrumEnrollmentPaths,
  proposedName: string,
): Promise<ClaustrumEnrollmentResetResult> {
  await mkdir(dirname(paths.statePath), { recursive: true, mode: 0o700 })
  const lock = await acquireRefreshFileLock({
    name: 'ceremony',
    path: paths.statePath,
    ttlMs: ENROLLMENT_LOCK_TTL_MS,
    renew: true,
  })
  if (!lock) return 'busy'
  try {
    if ((await readBoundedJson(paths.tokenPath)) !== undefined)
      return 'refused-approved'
    const value = await readBoundedJson(paths.statePath)
    if (value === undefined) return 'idle'
    const state = decodeEnrollmentState(value)
    if (state.proposedName !== proposedName)
      throw new Error(
        'Claustrum enrollment state belongs to a different consumer',
      )
    if (state.phase === 'pending') return 'refused-pending'
    await lock.assertOwned()
    await unlink(paths.statePath)
    return 'reset'
  } finally {
    await lock.release()
  }
}
