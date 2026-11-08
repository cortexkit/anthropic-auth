import {
  readClaustrumEnrollmentStatus,
  vaultAuthority,
} from '@cortexkit/common-auth/claustrum'

import { getHostClaustrumEnrollmentPaths } from './claustrum-enrollment.ts'
import { logger } from './logger.ts'
import { NativeCustodyError } from './native-custody.ts'
import { assertHostAuthorityStable } from './native-vault-host.ts'
import { closeNativeVaultAuthority } from './native-vault-invalidation.ts'

const stages = new Set([
  'safe-parent',
  'directory',
  'verify',
  'read',
  'open',
  'decode',
])
const reasons = new Set([
  'unsupported-filesystem',
  'wrong-owner',
  'extra-ace',
  'not-protected',
  'null-dacl',
  'empty-dacl',
  'reparse-point',
  'unsafe-ancestor',
  'wrong-kind',
  'io-error',
  'mode',
  'invalid-state',
  'invalid-token',
  'unsafe-file',
  'ENOENT',
  'EACCES',
  'EPERM',
  'ETIMEDOUT',
  'ERR_PRIVATE_FILES_SECURITY',
])

/**
 * Codes and reasons that mean the Windows private-files native addon did not
 * load. common-auth 0.24.0 and later refuse with code
 * `ERR_PRIVATE_FILES_UNAVAILABLE` and reason `native-addon-unavailable`
 * instead of passing through the backend's `unsupported-filesystem`.
 */
const addonUnavailable = new Set([
  'ERR_PRIVATE_FILES_UNAVAILABLE',
  'native-addon-unavailable',
])

/** Logged reasons that mean the private-files backend, not the enrollment, failed. */
const privateFilesUnavailableReasons = new Set([
  'unsupported-filesystem',
  'native-addon-unavailable',
])

// Enrollment mode INFO records already emitted this process. Native keys cover
// the host, token file and mode; hosted keys cover only the host and mode because
// Thalamus custody does not use enrollment files.
const loggedEnrollmentModes = new Set<string>()

/** Test-only reset for the once-per-process enrollment mode log. */
export function __resetEnrollmentModeLogForTests(): void {
  loggedEnrollmentModes.clear()
}

function resolveEnrollmentSource(
  host: 'opencode' | 'pi',
  env: NodeJS.ProcessEnv,
): 'env' | 'default' {
  const configured =
    env[
      `${host.toUpperCase()}_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE`
    ]?.trim()
  return configured ? 'env' : 'default'
}

async function maybeLogEnrollmentMode(
  host: 'opencode' | 'pi',
  paths: ReturnType<typeof getHostClaustrumEnrollmentPaths>,
  mode: 'local' | 'claustrum',
  env: NodeJS.ProcessEnv,
  readStatus: typeof readClaustrumEnrollmentStatus,
): Promise<void> {
  const key = `${host}${'\0'}${paths.tokenPath}${'\0'}${mode}`
  if (loggedEnrollmentModes.has(key)) return
  // Names come from the enrollment status file, never from token bytes. A
  // status read failure still logs the mode without names rather than
  // changing the mode decision.
  let proposedName: string | undefined
  let approvedName: string | undefined
  try {
    const status = await readStatus(paths, `anthropic-auth-${host}`)
    if (status && typeof status === 'object' && 'proposedName' in status) {
      const name = (status as { proposedName?: unknown }).proposedName
      if (typeof name === 'string' && name.length > 0) proposedName = name
    }
    if (status && typeof status === 'object' && 'approvedName' in status) {
      const name = (status as { approvedName?: unknown }).approvedName
      if (typeof name === 'string' && name.length > 0) approvedName = name
    }
  } catch {
    // Leave the names undefined and log the mode below.
  }
  loggedEnrollmentModes.add(key)
  logger.info('enrollment', 'Native enrollment mode', {
    host,
    tokenPath: paths.tokenPath,
    source: resolveEnrollmentSource(host, env),
    ...(proposedName !== undefined ? { proposedName } : {}),
    ...(approvedName !== undefined ? { approvedName } : {}),
    mode,
  })
}

async function logRefusal(
  host: 'opencode' | 'pi',
  paths: ReturnType<typeof getHostClaustrumEnrollmentPaths>,
  readStatus: typeof readClaustrumEnrollmentStatus,
): Promise<string> {
  let stage = 'enrollment'
  let reason = 'unreadable'
  let unavailable = false
  try {
    // The shared authority intentionally closes errors. A failure-only probe
    // recovers diagnostic codes without changing the authority decision.
    await readStatus(paths, `anthropic-auth-${host}`)
  } catch (error) {
    let current: unknown = error
    for (
      let depth = 0;
      depth < 4 && current && typeof current === 'object';
      depth++
    ) {
      const detail = current as {
        stage?: string
        reason?: string
        code?: string
        kind?: string
        cause?: unknown
      }
      if (detail.stage && stages.has(detail.stage)) stage = detail.stage
      for (const value of [detail.kind, detail.code, detail.reason]) {
        if (value && reasons.has(value)) reason = value
        if (value && addonUnavailable.has(value)) unavailable = true
      }
      current = detail.cause
    }
  }
  // A missing addon explains every other refusal in the chain (an inner
  // cause may carry an unrelated code such as ENOENT), so it wins.
  if (unavailable) reason = 'native-addon-unavailable'
  logger.warn('enrollment', 'Native enrollment authority refused', {
    host,
    stage,
    reason,
  })
  return reason
}

/**
 * Shown instead of `Native custody refused: invalid-token` when the
 * enrollment files could not be read because the private-files backend did
 * not load. Older common-auth passes on the backend's
 * `unsupported-filesystem`, which is what every private-file check returns on
 * Windows when the @cortexkit/private-files native addon did not load; newer
 * common-auth refuses with `ERR_PRIVATE_FILES_UNAVAILABLE`. Either way the
 * enrollment itself may be fine.
 */
export const PRIVATE_FILES_UNAVAILABLE_MESSAGE =
  "Private file support didn't load on this machine (@cortexkit/private-files). Reinstall the plugin; if this persists, report it with your OS and Node version."

/**
 * The enrollment refusal for a private-files backend that did not load. It
 * keeps the `invalid-token` code, so every caller that branches on the code
 * treats it exactly as before; only the message names the cause and remedy.
 */
export class NativePrivateFilesUnavailableError extends NativeCustodyError {
  constructor() {
    super('invalid-token')
    this.message = PRIVATE_FILES_UNAVAILABLE_MESSAGE
  }
}

/** Host authority takes precedence over enrollment files and account settings. */
export async function readNativeEnrollmentMode(
  host: 'opencode' | 'pi',
  env: NodeJS.ProcessEnv = process.env,
  dependencies = {
    enrollmentAuthority: vaultAuthority,
    readClaustrumEnrollmentStatus,
  },
): Promise<'local' | 'claustrum'> {
  assertHostAuthorityStable()
  const paths = getHostClaustrumEnrollmentPaths(host, env)
  const authority = await dependencies.enrollmentAuthority(
    paths,
    `anthropic-auth-${host}`,
  )
  assertHostAuthorityStable()
  if (authority === 'host') {
    const key = `${host}${'\0'}hosted`
    if (!loggedEnrollmentModes.has(key)) {
      loggedEnrollmentModes.add(key)
      logger.info('enrollment', 'Native enrollment mode', {
        host,
        mode: 'hosted',
        source: 'thalamus',
      })
    }
    return 'claustrum'
  }
  if (authority !== 'vault')
    closeNativeVaultAuthority(
      getHostClaustrumEnrollmentPaths(host, env).tokenPath,
    )
  if (authority === 'unreadable') {
    const reason = await logRefusal(
      host,
      paths,
      dependencies.readClaustrumEnrollmentStatus,
    )
    assertHostAuthorityStable()
    if (privateFilesUnavailableReasons.has(reason))
      throw new NativePrivateFilesUnavailableError()
    throw new NativeCustodyError('invalid-token')
  }
  const mode = authority === 'vault' ? 'claustrum' : 'local'
  await maybeLogEnrollmentMode(
    host,
    paths,
    mode,
    env,
    dependencies.readClaustrumEnrollmentStatus,
  )
  assertHostAuthorityStable()
  return mode
}
