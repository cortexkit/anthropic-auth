/**
 * Setup and CLI failures can contain credential echoes from child processes
 * or remote responses. Only recognized setup argument errors, fixed remedies
 * and verified lists of running OpenCode or Pi processes appear on screen.
 * Other failures show a fixed step label, failure code and private diagnostic
 * file path. Details are bounded and scrubbed by the shared authentication
 * library using known credentials and Bearer, JWT and `sk-` token patterns.
 * If private storage is unavailable, stderr gets only closed error metadata,
 * never messages, paths or stacks from the command or its failed diagnostic save.
 *
 * Thrown values, credential lists and environments are read only through own
 * data properties: getters, iterators, `toJSON`, `toString` and proxy traps are
 * never run. An own name of ProcessInspectionError suppresses duplicate output:
 * the shared setup runner prints its process-inspection refusal before rethrowing.
 */
import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { types as utilTypes } from 'node:util'
import {
  anthropicAuthStateRoot,
  createProviderErrorRedactor,
  createWindowsOwnerOnly,
  ensureWindowsOwnerOnlyDirectory,
  formatLogLine,
  HOLDER_REGISTRATION_ERROR_MESSAGES,
  isOwnerOnly,
  isSecretKey,
  isStateLayoutRefusalCode,
  type NativeCustodyErrorCode,
  NativeMigrationError,
  NativePiAuthSlotError,
  type OwnerOnlyOptions,
  PRIVATE_FILES_UNAVAILABLE_MESSAGE,
  type ProviderErrorRedactor,
  RELOCATED_MESSAGE,
  STATE_LAYOUT_REFUSAL_CODES,
  STATE_LAYOUT_REFUSAL_PUBLIC_MESSAGES,
  // From Core, not common-auth: Core bundles its own copy of runSetup, and
  // only that copy's setupEnrollment can see the outcomes runSetup recorded.
  setupEnrollment,
  stateLayoutRefusalPublicMessage,
} from '@cortexkit/anthropic-auth-core'
import type {
  SetupCommandError,
  SetupEnrollmentOutcome,
} from '@cortexkit/common-auth/setup'

import { NativeVaultActivationError } from './setup/native-activation.ts'
import {
  NATIVE_VAULT_HOST_NAMES,
  NativeVaultEnrollmentError,
} from './setup/native-enrollment.ts'
import { ProcessFenceViolationError } from './setup/process-fence.ts'

const STAGE_LABELS = {
  'setup-activation': 'Vault custody setup',
  'setup-opencode-config': 'OpenCode configuration',
  'setup-pi-install': 'Pi extension installation',
  'setup-pi': 'Pi setup',
  'setup-process-check': 'Host process check',
  'cli-setup': 'Setup',
  'cli-login': 'Login',
  'cli-api-add': 'API route setup',
  'cli-list': 'Account listing',
  'cli-relay-setup': 'Relay setup',
  'cli-relay-workers-dev': 'Workers.dev enablement',
  'cli-command': 'Command',
} as const

export type CliFailureStage = keyof typeof STAGE_LABELS

interface FailureReportOptions {
  ownership?: OwnerOnlyOptions
  stderr?: (line: string) => void
}

/**
 * Returns its argument unchanged, but fails to type-check unless the list
 * names every member of `Code`, so a code added to an error class cannot be
 * missed here.
 */
function everyCode<Code extends string>() {
  return <const List extends readonly Code[]>(
    list: List &
      ([Exclude<Code, List[number]>] extends [never]
        ? unknown
        : { missingCodes: Exclude<Code, List[number]> }),
  ): List => list
}

const SETUP_HOSTS = ['opencode', 'pi'] as const
const ENROLLMENT_OUTCOMES: ReadonlySet<unknown> =
  new Set<SetupEnrollmentOutcome>(['enrolled', 'not-enrolled', 'unknown'])

const ACTIVATION_CODES = everyCode<NativeVaultActivationError['code']>()([
  'auth-content-refused',
  'host-auth-invalid',
  'primary-conflict',
  'consent-required',
  'primary-unverified',
  'no-read-grant',
  'grant-reaches-nothing',
])
const ENROLLMENT_CODES = everyCode<NativeVaultEnrollmentError['code']>()([
  'enrollment-refused',
  'enrollment-reset',
  'approval-refused',
  'permission-refused',
])
const MIGRATION_CODES = everyCode<NativeMigrationError['code']>()([
  'invalid-source',
  'unsafe-source',
  'consent-required',
  'primary-unverified',
  'migration-busy',
  'ownership-lost',
  'retirement-refused',
  'pool-populated',
  'host-login-present',
  'settings-changed',
])
const PI_SLOT_CODES = everyCode<NativePiAuthSlotError['code']>()([
  'invalid-options',
  'invalid-auth',
  'unsafe-path',
  'lock-timeout',
  'lock-compromised',
  'io',
])
const CUSTODY_CODES = everyCode<NativeCustodyErrorCode>()([
  'closed',
  'not-enrolled',
  'invalid-token',
  'unavailable',
  'identity-changed',
  'identity-unasserted',
  'insufficient-validity',
  'invalid-material',
  'not-active',
  'route-unavailable',
  'route-declined',
  'no-receipt',
  'unsafe-file',
  'invalid-state',
  'wrong-consumer',
  'roster-busy',
  'host-slot-login',
  'host-slot-placeholder',
  'placeholder-refresh',
  'invalid-order',
])

const ERROR_FIELD_VALUES = {
  name: new Set([
    'Error',
    'TypeError',
    'SyntaxError',
    'RangeError',
    'AggregateError',
    'AbortError',
    'PrivateFileError',
    'PrivateFilesUnavailableError',
    'DiagnosticFileError',
    'NativeRuntimeError',
    'NativeAuthorityError',
    'NativeMigrationError',
    'NativeMigrationSourceError',
    'NativeHostAuthError',
    'NativeHostAuthWriteError',
    'NativePiAuthSlotError',
    'NativeCustodyError',
    'NativeVaultActivationError',
    'NativeVaultEnrollmentError',
    'SetupCommandError',
    'HostNotEnrolledError',
    'ProcessFenceViolationError',
    'ProcessInspectionError',
    'LockOwnershipError',
    'LockContentionError',
    'ClaustrumConsumerError',
    'ClaustrumCredentialError',
    'RelocatedError',
    'HolderRegistrationError',
    'StateLayoutRefusalError',
  ]),
  code: new Set<string>([
    ...ACTIVATION_CODES,
    ...ENROLLMENT_CODES,
    ...MIGRATION_CODES,
    ...PI_SLOT_CODES,
    ...CUSTODY_CODES,
    'EACCES',
    'EPERM',
    'ENOENT',
    'EEXIST',
    'ENOTDIR',
    'EISDIR',
    'ENOTEMPTY',
    'EBUSY',
    'ETIMEDOUT',
    'ECONNREFUSED',
    'ECONNRESET',
    'ECANCELED',
    'EIO',
    'EINVAL',
    'ENOTSUP',
    'ENOSYS',
    'ENOMEM',
    'EMFILE',
    'ENFILE',
    'ELOOP',
    'EROFS',
    'EXDEV',
    'ENAMETOOLONG',
    'EBADF',
    'EPIPE',
    'ENOSPC',
    'EINTR',
    'ERR_INVALID_ARG_TYPE',
    'ERR_INVALID_ARG_VALUE',
    'ERR_OUT_OF_RANGE',
    'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM',
    'ERR_PRIVATE_FILES_SECURITY',
    'ERR_PRIVATE_FILES_UNAVAILABLE',
    'ERR_PRIVATE_FILE',
    'ERR_DIAGNOSTICS_DIRECTORY_UNAVAILABLE',
    'ERR_DIAGNOSTICS_NOT_DIRECTORY',
    'ERR_DIAGNOSTICS_NOT_OWNER_ONLY',
    'unsafe-runtime',
    'invalid-runtime',
    'runtime-io',
    'runtime-conflict',
    'publication-refused',
    'invalid-journal',
    'source-io',
    'source-changed',
    'source-too-large',
    'write-io',
    'relocated',
    'lock-timeout',
    'managed-folder',
    'malformed',
    ...STATE_LAYOUT_REFUSAL_CODES,
  ]),
  stage: new Set([
    'safe-parent',
    'verify',
    'directory',
    'read',
    'create',
    'directory-create',
    'rename',
    'stage-directory',
    'stage-create',
    'before-rename',
    'published-callback',
    'published-verify',
    'directory-sync-unsupported',
  ]),
  reason: new Set([
    'wrong-owner',
    'extra-ace',
    'not-protected',
    'null-dacl',
    'empty-dacl',
    'reparse-point',
    'unsupported-filesystem',
    // common-auth's reason when the Windows private-files addon did not load.
    'native-addon-unavailable',
    'unsafe-ancestor',
    'wrong-kind',
    'io-error',
    'mode',
    'writable-by-others',
  ]),
}

/**
 * Every fixed message a known failure can carry. Messages of error classes
 * this package can import are produced by constructing that class with each
 * of its codes. NativeCustodyError is exported only as a type, so its fixed
 * message is derived from the closed code list. Plain Error messages and
 * unexported authority, runtime and metadata errors need literal entries.
 * If those messages change, the generic diagnostic path handles them instead
 * of displaying unchecked text.
 */
const CLOSED_MESSAGES: ReadonlySet<string> = new Set([
  ...ACTIVATION_CODES.flatMap((code) =>
    code === 'no-read-grant' || code === 'grant-reaches-nothing'
      ? SETUP_HOSTS.map(
          (host) => new NativeVaultActivationError(code, host).message,
        )
      : [new NativeVaultActivationError(code).message],
  ),
  ...ENROLLMENT_CODES.map(
    (code) => new NativeVaultEnrollmentError(code).message,
  ),
  ...MIGRATION_CODES.map((code) => new NativeMigrationError(code).message),
  ...PI_SLOT_CODES.map((code) => new NativePiAuthSlotError(code).message),
  ...CUSTODY_CODES.map((code) => `Native custody refused: ${code}`),
  // An enrollment that could not be read because the private-files native
  // backend did not load names that cause and its remedy instead.
  PRIVATE_FILES_UNAVAILABLE_MESSAGE,
  // A newer version moved this host's account state; or a registration that
  // must succeed failed. Both carry fixed text that names no path.
  RELOCATED_MESSAGE,
  ...HOLDER_REGISTRATION_ERROR_MESSAGES,
  // Where the account state is could not be decided safely. These are the
  // fixed texts of those refusals; their own messages name files.
  ...STATE_LAYOUT_REFUSAL_PUBLIC_MESSAGES,
  // Local sign-in is forbidden while vault custody remains connected.
  'Disconnect from the vault first.',
  // CLI input validation uses fixed messages rather than error codes.
  'Native account changes require offline setup without OPENCODE_AUTH_CONTENT',
  'Local login cannot be verified while OPENCODE_AUTH_CONTENT is set',
  'Authentication failed',
  'API fallback base URL must be an http(s) URL without embedded credentials',
  'API key is required',
  'Vault routes cannot be replaced with a local API key',
  'Cloudflare API token is required',
  'Cloudflare account ID is required',
  'Relay Worker URL is required',
  '--claustrum and --no-claustrum cannot be used together.',
  'Setup requires a TTY or --yes.',
  'Multiple OpenCode generations found. Choose --opencode=1|2|both before running noninteractive setup.',
  'Claustrum is not available. Start ck, or omit vault-only flags and use --no-claustrum for local sign-in.',
  // Offline local setup refuses an unverified account identity.
  'Claude sign-in did not establish an account UUID',
  // Each selected host needs separate storage.
  'Native setup storage paths overlap between selected hosts',
  // Migration requires distinct credential and runtime storage paths.
  'Anthropic account storage paths overlap; migration requires separate files',
  'Anthropic account migration is required. Stop OpenCode, LiteCode and Pi, then run npx @cortexkit/opencode-anthropic-auth setup',
  'Anthropic account migration is incomplete; resume setup',
  'Anthropic account migration journal is invalid',
  'Anthropic account migration journal changed',
  // Runtime safety checks use these fixed refusal messages.
  'Anthropic runtime state is invalid',
  'Anthropic runtime file is not owner-only regular storage',
  'Anthropic runtime storage is unavailable',
  'Anthropic runtime observation is older than persisted state',
  'Anthropic runtime publication was refused',
  // Shared setup's vault enrollment refusals (HostNotEnrolledError) with
  // fixed text. common-auth 0.24.0 and later show them as thrown; earlier
  // releases replaced them with one generic message.
  'Claustrum connection failed; start ck and rerun setup.',
  'Claustrum enrollment refused; inspect its status with ck before rerunning setup.',
  'Invalid enrollment request id.',
  // Keep both fixed remedies admitted while Core builds may bundle either
  // common-auth release.
  'This Claustrum vault does not support connecting plugins yet, so setup cannot connect to it. Run setup without --claustrum to use local accounts.',
  'This Claustrum vault is too old to connect plugins. Run ck upgrade to move to Claustrum v0.2.0 or newer (read "Upgrading from v0.1.3" in its release notes first), or run setup without --claustrum to use local accounts.',
  // Metadata-read failures without an HTTP status have one fixed message.
  // knownFailureMessage also accepts an appended, validated HTTP status code.
  'OAuth metadata read failed',
])

/** Vault names the shared setup runner proposes for each host. */
const VAULT_HOST_NAMES = Object.values(NATIVE_VAULT_HOST_NAMES).join('|')

const INCOMPLETE_ENROLLMENT_MESSAGE =
  'Claustrum enrollment did not complete. Inspect and approve with ck, then rerun setup.'

/**
 * Shared setup's HostNotEnrolledError messages that embed vetted values: the
 * request id setup already printed (letters, digits, `_` and `-`), the host's
 * vault name, and a snake_case vault error code. Each pattern admits exactly
 * those shapes, so no other text can reach the screen through them.
 */
const HOST_NOT_ENROLLED_PATTERNS = [
  new RegExp(
    `^Claustrum approval is still pending\\. In another terminal, run: ck auth enroll approve --request-id [A-Za-z0-9_-]{1,128} --name (?:${VAULT_HOST_NAMES}) and then rerun setup\\.$`,
  ),
  /^The vault never created the enrollment request \(last error: [a-z][a-z0-9_]{0,63}\)\. Check that ck is running, then rerun setup\.$/,
]

/**
 * Executable names ProcessFenceViolationError prints, compared case-
 * insensitively; it prints any other process as "host".
 */
const FENCE_HOST_NAMES: ReadonlySet<string> = new Set([
  'opencode',
  'litecode',
  'opencode2',
  'pi',
  'host',
])
/** Maximum host entries accepted when rebuilding a process-fence message. */
const MAX_FENCE_HOSTS = 64
/** Maximum entries read from a command's submitted-credentials array. */
const MAX_SUBMITTED_SECRETS = 256
/** Maximum environment keys inspected; more makes collection fail closed. */
const MAX_ENV_KEYS = 4096

/** Characters of raw text inspected before redaction. */
const RAW_WINDOW_CHARS = 64 * 1024
/** UTF-8 bytes of redacted detail kept per diagnostics file. */
export const CLI_FAILURE_DETAIL_MAX_BYTES = 4 * 1024
/** Nested `cause` errors described in a failure's detail before stopping. */
const MAX_CAUSE_DEPTH = 3

export const CLI_FAILURE_OMITTED =
  '[output beyond the diagnostic limit omitted]'
export const CLI_FAILURE_WITHHELD =
  '[output withheld: no line break within the inspected window]'
export const CLI_FAILURE_SECRETS_UNREADABLE =
  '[detail withheld: the known credentials could not be read safely]'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/** An own data property's value; accessors and missing keys give undefined. */
function ownData(value: object, key: string): unknown {
  const field = Object.getOwnPropertyDescriptor(value, key)
  return field !== undefined && 'value' in field ? field.value : undefined
}

function isInspectable(value: unknown): value is object {
  return (
    value !== null &&
    (typeof value === 'object' || typeof value === 'function') &&
    !utilTypes.isProxy(value)
  )
}

/**
 * Own data elements of a real array, or undefined when it is a proxy, has a
 * hole or accessor, or is longer than `max`.
 */
function ownDataElements(value: unknown, max: number): unknown[] | undefined {
  if (!isInspectable(value) || !Array.isArray(value)) return undefined
  const length = ownData(value, 'length')
  if (typeof length !== 'number' || length > max) return undefined
  const elements: unknown[] = []
  for (let index = 0; index < length; index += 1) {
    const field = Object.getOwnPropertyDescriptor(value, String(index))
    if (field === undefined || !('value' in field)) return undefined
    elements.push(field.value)
  }
  return elements
}

/**
 * The `activeHosts` list of a ProcessFenceViolationError, when it is a real
 * array whose every entry has a non-negative integer `pid` and a `command`
 * from FENCE_HOST_NAMES, all as own data properties; otherwise undefined.
 */
function closedFenceHosts(
  value: unknown,
): Array<{ pid: number; command: string }> | undefined {
  const entries = ownDataElements(value, MAX_FENCE_HOSTS)
  if (entries === undefined || entries.length === 0) return undefined
  const hosts: Array<{ pid: number; command: string }> = []
  for (const entry of entries) {
    if (!isInspectable(entry)) return undefined
    const pid = ownData(entry, 'pid')
    const command = ownData(entry, 'command')
    if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid < 0)
      return undefined
    if (
      typeof command !== 'string' ||
      !FENCE_HOST_NAMES.has(command.toLowerCase())
    )
      return undefined
    hosts.push({ pid, command })
  }
  return hosts
}

/**
 * Returns display text, '' when the runner already printed its process-inspection
 * refusal, or undefined to fall through to reportThrownFailure. Runner errors
 * cross a bundle boundary, so only own data properties classify them.
 * Display text must be a fixed remedy, the runner's unknown-argument message,
 * an OAuth metadata error matching its own integer HTTP status (100–599),
 * a shared-setup enrollment refusal matching HOST_NOT_ENROLLED_PATTERNS, or
 * a running-host list or vault grant remedy rebuilt from validated fields.
 */
export function knownFailureMessage(error: unknown): string | undefined {
  try {
    if (!isInspectable(error)) return undefined
    if (ownData(error, 'name') === 'ProcessInspectionError') return ''
    const message = ownData(error, 'message')
    if (typeof message !== 'string') return undefined
    if (
      ownData(error, 'name') === 'HostNotEnrolledError' &&
      message === INCOMPLETE_ENROLLMENT_MESSAGE
    )
      return message
    if (CLOSED_MESSAGES.has(message)) return message
    // A state layout refusal's message names files; show its fixed text.
    if (ownData(error, 'name') === 'StateLayoutRefusalError') {
      const code = ownData(error, 'code')
      if (isStateLayoutRefusalCode(code))
        return stateLayoutRefusalPublicMessage(code)
    }
    if (
      ownData(error, 'name') === 'NativeVaultActivationError' &&
      ownData(error, 'code') === 'no-read-grant'
    ) {
      const host = ownData(error, 'host')
      const approvedName = ownData(error, 'approvedName')
      if (
        (host === 'opencode' || host === 'pi') &&
        typeof approvedName === 'string'
      ) {
        // The constructor validates the principal before building the command.
        // Compare the whole remedy so no other error text reaches the terminal.
        const rebuilt = new NativeVaultActivationError(
          'no-read-grant',
          host,
          approvedName,
        ).message
        if (message === rebuilt) return rebuilt
      }
    }
    if (message.startsWith('Unknown setup argument: ')) return message
    if (
      ownData(error, 'name') === 'HostNotEnrolledError' &&
      HOST_NOT_ENROLLED_PATTERNS.some((pattern) => pattern.test(message))
    )
      return message
    // common-auth 0.24.0 and later refuse every Windows private-file
    // operation with this code when the native addon did not load. Their
    // own message names a file path, so show the fixed remedy instead.
    if (ownData(error, 'code') === 'ERR_PRIVATE_FILES_UNAVAILABLE')
      return PRIVATE_FILES_UNAVAILABLE_MESSAGE
    const status = ownData(error, 'status')
    if (
      typeof status === 'number' &&
      Number.isInteger(status) &&
      status >= 100 &&
      status <= 599 &&
      message === `OAuth metadata read failed: ${status}`
    )
      return message
    const hosts = closedFenceHosts(ownData(error, 'activeHosts'))
    if (hosts) {
      const rebuilt = new ProcessFenceViolationError(hosts).message
      if (message === rebuilt) return rebuilt
    }
  } catch {
    // Unreadable values are treated as unknown.
  }
  return undefined
}

/**
 * The vault enrollment outcome runSetup recorded for each selected host when
 * it failed after enrollment began, or undefined when it recorded none.
 * runSetup keeps that record beside the thrown value rather than on it, and
 * the setupEnrollment that Core re-exports looks it up; it is asked only for a
 * real (non-proxy) object, and each entry is accepted only when its host and
 * outcome are own data properties holding known values, so no getter or proxy
 * trap runs.
 */
export function setupEnrollmentOutcomes(
  error: unknown,
):
  | { host: (typeof SETUP_HOSTS)[number]; outcome: SetupEnrollmentOutcome }[]
  | undefined {
  try {
    if (!isInspectable(error)) return undefined
    const entries = ownDataElements(setupEnrollment(error), SETUP_HOSTS.length)
    if (entries === undefined) return undefined
    const outcomes: {
      host: (typeof SETUP_HOSTS)[number]
      outcome: SetupEnrollmentOutcome
    }[] = []
    for (const entry of entries) {
      if (!isInspectable(entry)) return undefined
      const host = SETUP_HOSTS.find((name) => name === ownData(entry, 'host'))
      const outcome = ownData(entry, 'outcome')
      if (host === undefined || !ENROLLMENT_OUTCOMES.has(outcome))
        return undefined
      outcomes.push({ host, outcome: outcome as SetupEnrollmentOutcome })
    }
    return outcomes
  } catch {
    return undefined
  }
}

/**
 * Exact credentials a failing command may echo: the strings in `submitted`
 * (the API key, OAuth code and tokens, or Cloudflare and relay tokens the CLI
 * command handled) plus every environment value whose name Core's
 * `isSecretKey` treats as secret (for example `*_TOKEN`, `*_API_KEY`,
 * `*_SECRET`), since child processes receive that environment. Empty values are
 * skipped; every other value counts, however short. Returns undefined when
 * either input is a proxy, has accessors or non-string credentials, or is too
 * large to inspect, so the caller can withhold detail instead of logging it
 * with a credential left out.
 */
export function collectKnownSecrets(
  env: unknown,
  submitted: unknown = [],
): string[] | undefined {
  try {
    const secrets = new Set<string>()
    const values = ownDataElements(submitted, MAX_SUBMITTED_SECRETS)
    if (values === undefined) return undefined
    for (const value of values) {
      if (typeof value !== 'string') return undefined
      if (value !== '') secrets.add(value)
    }
    if (!isInspectable(env)) return undefined
    const keys = Reflect.ownKeys(env)
    if (keys.length > MAX_ENV_KEYS) return undefined
    for (const key of keys) {
      if (typeof key !== 'string' || !isSecretKey(key)) continue
      const field = Object.getOwnPropertyDescriptor(env, key)
      if (field === undefined) continue
      if (!('value' in field)) return undefined
      if (field.value === undefined || field.value === '') continue
      if (typeof field.value !== 'string') return undefined
      secrets.add(field.value)
    }
    return [...secrets]
  } catch {
    return undefined
  }
}

function utf8Head(text: string, maxBytes: number): string {
  const bytes = encoder.encode(text)
  if (bytes.length <= maxBytes) return text
  let end = Math.max(0, maxBytes)
  // Step back off continuation bytes so a code point is never split.
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1
  return decoder.decode(bytes.subarray(0, end))
}

function utf8Tail(text: string, maxBytes: number): string {
  const bytes = encoder.encode(text)
  if (bytes.length <= maxBytes) return text
  let start = bytes.length - Math.max(0, maxBytes)
  while (start < bytes.length && ((bytes[start] ?? 0) & 0xc0) === 0x80)
    start += 1
  return decoder.decode(bytes.subarray(start))
}

/**
 * Redact first, bound second. Raw text is only ever cut at a line break and
 * the partial line is dropped, so a credential is never split before the
 * redactor sees it whole. The redacted lines are then kept up to the byte
 * limit; cutting already-redacted text cannot reveal anything new.
 */
export function boundRedactedDetail(
  text: string,
  redactor: Pick<ProviderErrorRedactor, 'redactText'>,
  keep: 'head' | 'tail',
): string[] {
  let window = text
  let omitted = false
  if (text.length > RAW_WINDOW_CHARS) {
    omitted = true
    if (keep === 'tail') {
      const lineBreak = text.indexOf('\n', text.length - RAW_WINDOW_CHARS)
      window = lineBreak === -1 ? '' : text.slice(lineBreak + 1)
    } else {
      const lineBreak = text.lastIndexOf('\n', RAW_WINDOW_CHARS)
      window = lineBreak === -1 ? '' : text.slice(0, lineBreak)
    }
    if (window === '') return [CLI_FAILURE_WITHHELD]
  }
  const lines = redactor.redactText(window).split(/\r?\n/)
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  if (keep === 'tail') lines.reverse()
  const kept: string[] = []
  let budget = CLI_FAILURE_DETAIL_MAX_BYTES
  for (const line of lines) {
    const size = encoder.encode(line).length + 1
    if (size <= budget) {
      kept.push(line)
      budget -= size
      continue
    }
    if (kept.length === 0)
      kept.push(
        keep === 'tail'
          ? utf8Tail(line, budget - 1)
          : utf8Head(line, budget - 1),
      )
    omitted = true
    break
  }
  if (keep === 'tail') kept.reverse()
  if (omitted) {
    if (keep === 'tail') kept.unshift(CLI_FAILURE_OMITTED)
    else kept.push(CLI_FAILURE_OMITTED)
  }
  return kept
}

function errorKind(value: object): string {
  let current: object | null = value
  for (let depth = 0; current !== null && depth < 8; depth += 1) {
    if (utilTypes.isProxy(current)) break
    const name = ownData(current, 'name')
    if (typeof name === 'string') return name
    current = Object.getPrototypeOf(current) as object | null
  }
  return 'object'
}

/** Closed metadata remains safe to display even when private storage is unavailable. */
function stableErrorFields(value: unknown, secrets: string[] | undefined) {
  const fields: Partial<Record<keyof typeof ERROR_FIELD_VALUES, string>> = {}
  if (secrets === undefined) return fields
  try {
    if (!isInspectable(value)) return fields
    const redactor = createProviderErrorRedactor(secrets)
    try {
      for (const key of ['name', 'code', 'stage', 'reason'] as const) {
        const field = key === 'name' ? errorKind(value) : ownData(value, key)
        if (
          typeof field === 'string' &&
          ERROR_FIELD_VALUES[key].has(field) &&
          redactor.redactText(field) === field
        )
          fields[key] = field
      }
    } finally {
      redactor.dispose()
    }
  } catch {
    // Unreadable metadata is omitted rather than coercing an untrusted value.
    return {}
  }
  return fields
}

/**
 * Core's bundle contains its own SetupCommandError constructor, so instanceof
 * against a separately imported constructor would reject the runner's errors.
 * Read own data fields instead.
 */
function setupCommandDetails(error: unknown):
  | (Pick<SetupCommandError, 'exitCode' | 'signal' | 'stderrTail'> & {
      step: string
    })
  | undefined {
  if (!isInspectable(error)) return undefined
  const step = ownData(error, 'step')
  const exitCode = ownData(error, 'exitCode')
  const signal = ownData(error, 'signal')
  const stderrTail = ownData(error, 'stderrTail')
  if (
    typeof step !== 'string' ||
    step.length === 0 ||
    !(
      exitCode === null ||
      (typeof exitCode === 'number' && Number.isInteger(exitCode))
    ) ||
    !(signal === null || typeof signal === 'string') ||
    typeof stderrTail !== 'string'
  )
    return undefined
  return { step, exitCode, signal, stderrTail }
}

/** Own data fields of a thrown value as text, without running its code. */
function describeThrown(value: unknown, depth: number): string[] {
  if (
    value === null ||
    (typeof value !== 'object' && typeof value !== 'function')
  )
    return [`thrown ${typeof value}: ${String(value)}`]
  if (utilTypes.isProxy(value)) return ['thrown proxy (not inspected)']
  const lines: string[] = []
  const kind = errorKind(value)
  const message = ownData(value, 'message')
  lines.push(
    typeof message === 'string'
      ? `${kind}: ${message}`
      : `${kind} (no message)`,
  )
  const code = ownData(value, 'code')
  if (typeof code === 'string' || typeof code === 'number')
    lines.push(`code: ${code}`)
  const stack = ownData(value, 'stack')
  if (typeof stack === 'string') lines.push(stack)
  const cause = ownData(value, 'cause')
  if (cause !== undefined) {
    if (depth >= MAX_CAUSE_DEPTH) lines.push('caused by: [not described]')
    else lines.push('caused by:', ...describeThrown(cause, depth + 1))
  }
  return lines
}

/** A string environment entry, read without running accessors. */
function envText(env: object, key: string): string | undefined {
  const value = ownData(env, key)
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * Private per-user directory for failure details:
 * `$XDG_STATE_HOME/cortexkit/anthropic-auth/diagnostics`, falling back to
 * `~/.local/state`, which also holds host enrollment files. Undefined when
 * reading the environment would invoke caller code.
 */
export function cliDiagnosticsDirectory(env: unknown): string | undefined {
  if (!isInspectable(env)) return undefined
  const home = envText(env, 'HOME')
  const root = anthropicAuthStateRoot({
    xdgStateHome: envText(env, 'XDG_STATE_HOME'),
    home: home && isAbsolute(home) ? home : homedir(),
  })
  return join(root, 'diagnostics')
}

/**
 * Write one failure detail to a new owner-only file and return its path, or
 * undefined if that cannot be done safely. An existing non-private leaf
 * directory is refused, never repaired. POSIX checks its uid/mode and creates
 * missing directories with mode 0700; Windows uses native DACL checks and
 * private directory creation. Files are exclusive mode 0600 on POSIX and
 * protected owner-only DACL storage on Windows; a leaf symlink is never followed.
 */
export async function writeDiagnosticFile(
  env: unknown,
  stage: CliFailureStage,
  contents: string,
  ownership: OwnerOnlyOptions = {},
): Promise<string | undefined> {
  return (await writeDiagnosticResult(env, stage, contents, ownership)).path
}

interface DiagnosticWriteResult {
  path?: string
  error?: unknown
}

async function writeDiagnosticResult(
  env: unknown,
  stage: CliFailureStage,
  contents: string,
  ownership: OwnerOnlyOptions = {},
): Promise<DiagnosticWriteResult> {
  const refuse = (code: string): DiagnosticWriteResult => ({
    error: { name: 'DiagnosticFileError', code },
  })
  try {
    const directory = cliDiagnosticsDirectory(env)
    if (directory === undefined)
      return refuse('ERR_DIAGNOSTICS_DIRECTORY_UNAVAILABLE')
    if (!(await ensureWindowsOwnerOnlyDirectory(directory, ownership))) {
      await mkdir(directory, { recursive: true, mode: 0o700 })
      const metadata = await lstat(directory)
      if (!metadata.isDirectory())
        return refuse('ERR_DIAGNOSTICS_NOT_DIRECTORY')
      if (
        !(await isOwnerOnly(
          directory,
          () =>
            (metadata.mode & 0o077) === 0 &&
            metadata.uid === process.getuid?.(),
          ownership,
        ))
      )
        return refuse('ERR_DIAGNOSTICS_NOT_OWNER_ONLY')
    }
    const path = join(
      directory,
      `${stage}-${Date.now()}-${process.pid}-${randomUUID()}.log`,
    )
    if (await createWindowsOwnerOnly(path, contents, ownership)) return { path }
    const handle = await open(
      path,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        (constants.O_NOFOLLOW ?? 0),
      0o600,
    )
    try {
      await handle.writeFile(contents, 'utf8')
    } finally {
      await handle.close()
    }
    return { path }
  } catch (error) {
    return { error }
  }
}

async function recordFailure(
  stage: CliFailureStage,
  code: string,
  env: unknown,
  submitted: unknown,
  fields: Record<string, unknown>,
  detail: () => { text: string; keep: 'head' | 'tail' },
  failure: unknown,
  options: FailureReportOptions = {},
): Promise<string> {
  let lines: string[]
  const secrets = collectKnownSecrets(env, submitted)
  if (secrets === undefined) lines = [CLI_FAILURE_SECRETS_UNREADABLE]
  else {
    try {
      const redactor = createProviderErrorRedactor(secrets)
      try {
        const { text, keep } = detail()
        lines = boundRedactedDetail(text, redactor, keep)
      } finally {
        redactor.dispose()
      }
    } catch {
      lines = ['[failure detail could not be recorded]']
    }
  }
  const label = STAGE_LABELS[stage]
  // The shared formatLogLine formatter receives only fixed header fields. The
  // detail lines are already redacted and bounded and are appended as they
  // are: formatLogLine's payload redaction replaces any whole string value
  // matching "Bearer <text>", so "Bearer [REDACTED]" would lose the text
  // around the placeholder.
  const header = formatLogLine('error', 'cli', `${label} failed`, {
    stage,
    code,
    ...fields,
  })
  const saved = await writeDiagnosticResult(
    env,
    stage,
    `${[header, ...lines].join('\n')}\n`,
    options.ownership,
  )
  const path = saved.path
  if (path === undefined) {
    const metadata = {
      error: stableErrorFields(failure, secrets),
      saveError: stableErrorFields(saved.error, secrets),
    }
    try {
      const write =
        options.stderr ?? ((line: string) => process.stderr.write(line))
      write(`CLI failure metadata: ${JSON.stringify(metadata)}\n`)
    } catch {
      // Failure reporting must preserve the original command result.
    }
  }
  return path === undefined
    ? `${label} failed (${code}). Details could not be saved to a private diagnostics file.`
    : `${label} failed (${code}). Details were written to ${path}`
}

/**
 * Screen text for a thrown failure. A known failure is returned word for word
 * and not recorded; anything else is recorded in a private diagnostics file
 * and replaced by a fixed line naming that file. `env` supplies both the
 * secret-named values to scrub and the diagnostics location; `submitted`
 * holds the credentials the failing command handled.
 * When the private file cannot be saved, one allowlisted metadata line is
 * also emitted to stderr without changing the fixed screen text.
 */
export async function reportThrownFailure(
  stage: CliFailureStage,
  error: unknown,
  env: unknown,
  submitted: unknown = [],
  options: FailureReportOptions = {},
): Promise<string> {
  const known = knownFailureMessage(error)
  if (known !== undefined) return known
  const command = setupCommandDetails(error)
  return recordFailure(
    stage,
    `${stage}/unexpected-error`,
    env,
    submitted,
    {},
    () => ({
      text: [
        ...(command
          ? [
              `step: ${command.step}`,
              `exitCode: ${command.exitCode}`,
              `signal: ${command.signal}`,
            ]
          : []),
        ...describeThrown(error, 0),
        ...(command ? [`stderrTail:\n${command.stderrTail}`] : []),
      ].join('\n'),
      keep: 'head',
    }),
    error,
    options,
  )
}

/** Screen text for a child process that exited unsuccessfully; its stderr tail goes to the diagnostics file. */
export async function reportInstallerFailure(
  stage: CliFailureStage,
  result: { exitCode: number; stderr: string },
  env: unknown,
): Promise<string> {
  return recordFailure(
    stage,
    `${stage}/installer-exit`,
    env,
    [],
    { exitCode: Number.isInteger(result.exitCode) ? result.exitCode : null },
    () => ({
      text: typeof result.stderr === 'string' ? result.stderr : '',
      keep: 'tail',
    }),
    undefined,
  )
}
