import { readFile } from 'node:fs/promises'
import {
  assertHostsStopped,
  createNativeAccountRuntime,
  discoverNativeVaultInventory,
  inspectNativeHostAuthEntry,
  type NativeCustodyActivationHooks,
  type NativeCustodyInventory,
  NativePiAuthSlotError,
  nativePiAuthSlotPaths,
  openNativePiAuthSlot,
  readNativeEnrollmentMode,
  requireNoSupervisedAuthContentSnapshot,
} from '@cortexkit/anthropic-auth-core'
import {
  enrollNativeVaultForHost,
  grantNativeVaultForHost,
  type NativeVaultEnrollmentOptions,
  nativeVaultGrantArgs,
} from './native-enrollment.ts'
import { nativeSetupFileFingerprint } from './native-local.ts'
import {
  type NativeSetupPaths,
  resolveNativeSetupPaths,
} from './native-paths.ts'
import {
  type CommandRunner,
  type HarnessKind,
  type ProcessFence,
  SetupRefusal,
  setupProcessInspectionMessage,
} from './types.ts'

type HostIndependentActivationCode =
  | 'auth-content-refused'
  | 'host-auth-invalid'
  | 'primary-conflict'
  | 'consent-required'
  | 'primary-unverified'

/** Activation codes whose remedy names the host, so the host is required. */
type HostActivationCode = 'no-read-grant' | 'grant-reaches-nothing'

const HOST_LABELS = { opencode: 'OpenCode', pi: 'Pi' } as const

function activationMessage(
  code: HostIndependentActivationCode | HostActivationCode,
  host: HarnessKind,
  approvedName?: string,
): string {
  switch (code) {
    case 'auth-content-refused':
      return 'Run setup without OPENCODE_AUTH_CONTENT in the environment.'
    case 'host-auth-invalid':
      return 'The host auth file could not be read safely.'
    case 'primary-conflict':
      return 'Pi has a stored Anthropic API key, which would take precedence over the vault account. Remove it in Pi, then rerun setup.'
    case 'consent-required':
      return 'Pi has stored Anthropic authentication. Explicit consent is required to move it aside for vault use.'
    case 'primary-unverified':
      return 'The vault has no verified default Claude account. Sign in through the vault and rerun setup.'
    case 'no-read-grant':
      return `${HOST_LABELS[host]} has no read grant in the vault, so setup cannot see any Claude login. Run ${['ck', ...nativeVaultGrantArgs(host, approvedName)].join(' ')}, then rerun setup.`
    case 'grant-reaches-nothing':
      return `${HOST_LABELS[host]}'s vault read grant reaches no Claude login: no vault login carries the anthropic-native category, which logins saved before vault categories existed lack. Run ck auth reclassify --from-registry, check the logins with ck auth status, then rerun setup.`
  }
}

export class NativeVaultActivationError extends Error {
  readonly code: HostIndependentActivationCode | HostActivationCode

  constructor(code: HostIndependentActivationCode)
  constructor(
    code: HostActivationCode,
    host: HarnessKind,
    approvedName?: string,
  )
  constructor(
    code: HostIndependentActivationCode | HostActivationCode,
    readonly host: HarnessKind = 'opencode',
    readonly approvedName?: string,
  ) {
    // The remedy includes only a validated principal name; vault replies and
    // caught error messages are never displayed as free-form text.
    super(activationMessage(code, host, approvedName))
    this.name = 'NativeVaultActivationError'
    this.code = code
  }
}

/**
 * Why setup found no verified default account, from its latest vault listing.
 * The listing's grant reach separates an enrollment with no grant at all from
 * a grant that reaches no login. It is undefined when the vault is too old to
 * report grants or setup never saw a listing; that, and a listing that did
 * reach logins, keep the generic message.
 */
function unservedCode(
  inventory: NativeCustodyInventory | undefined,
): 'primary-unverified' | HostActivationCode {
  const reach = inventory?.grantReach
  if (
    !reach ||
    inventory.credentials.length > 0 ||
    inventory.skipped.length > 0
  )
    return 'primary-unverified'
  return reach.grants === 0 ? 'no-read-grant' : 'grant-reaches-nothing'
}

export interface NativeVaultActivationOptions {
  env: NodeJS.ProcessEnv
  runner: CommandRunner
  fence: ProcessFence
  /** Consent to move Pi's stored authentication aside; never consent to delete it. */
  removePiAnthropicAuth: boolean
  /**
   * Tests override the host paths, enrollment client and vault listing;
   * production resolves them from the host's environment.
   */
  paths?: NativeSetupPaths
  /** Set false for OpenCode 2, whose setup must not read the OpenCode 1 auth file. */
  inspectOpenCodeAuth?: boolean
  enrollment?: Pick<
    NativeVaultEnrollmentOptions,
    'paths' | 'client' | 'ckBinary' | 'connectionFile'
  >
  discover?: () => Promise<NativeCustodyInventory>
  hooks?: NativeCustodyActivationHooks
}

async function readHostAuth(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    if ((error as { code?: unknown }).code === 'ENOENT') return undefined
    throw new NativeVaultActivationError('host-auth-invalid')
  }
}

export interface NativeVaultPreflight {
  priorMode: 'local' | 'claustrum'
  fingerprint: string
  separateOpenCodeLogin?: boolean
}

export async function fingerprintNativeVaultInputs(
  host: HarnessKind,
  options: NativeVaultActivationOptions,
): Promise<string> {
  if (host === 'opencode') return 'opencode'
  const plan =
    options.paths ?? (await resolveNativeSetupPaths(host, options.env))
  const entry = inspectNativeHostAuthEntry(
    host,
    await readHostAuth(plan.hostAuthPath),
  )
  const slot = openNativePiAuthSlot({
    env: options.env,
    authPath: plan.hostAuthPath,
  })
  const { stashPath } = nativePiAuthSlotPaths({
    env: options.env,
    authPath: plan.hostAuthPath,
  })
  return JSON.stringify([
    entry.digest,
    await slot.inspect(),
    await nativeSetupFileFingerprint(stashPath),
  ])
}

function validateVaultAuthContent(options: NativeVaultActivationOptions): void {
  try {
    requireNoSupervisedAuthContentSnapshot(options.env)
  } catch {
    throw new NativeVaultActivationError('auth-content-refused')
  }
}

async function vaultProcessFence(
  options: NativeVaultActivationOptions,
): Promise<void> {
  validateVaultAuthContent(options)
  try {
    await assertHostsStopped(options.fence, options.env)
  } catch (error) {
    const message = setupProcessInspectionMessage(error)
    if (message) throw new SetupRefusal(message)
    throw error
  }
}

/** Validate vault inputs before the runner enrolls any selected host. */
export async function preflightNativeVaultForHost(
  host: HarnessKind,
  options: NativeVaultActivationOptions,
): Promise<NativeVaultPreflight> {
  const env = { ...options.env }
  validateVaultAuthContent({ ...options, env })
  const plan = options.paths ?? (await resolveNativeSetupPaths(host, env))
  const separateOpenCodeLogin =
    host === 'opencode' &&
    options.inspectOpenCodeAuth !== false &&
    inspectNativeHostAuthEntry(
      'opencode',
      await readHostAuth(plan.hostAuthPath),
    ).kind === 'oauth'
  if (host === 'pi') {
    const entry = inspectNativeHostAuthEntry(
      'pi',
      await readHostAuth(plan.hostAuthPath),
    )
    const slot = await openNativePiAuthSlot({
      env,
      authPath: plan.hostAuthPath,
    }).inspect()
    if (slot.slot === 'placeholder' && slot.stash === 'missing')
      throw new NativePiAuthSlotError('missing-stash')
    if (
      entry.kind !== 'absent' &&
      slot.slot !== 'placeholder' &&
      !options.removePiAnthropicAuth
    )
      throw new NativeVaultActivationError('consent-required')
  }
  return {
    priorMode: await readNativeEnrollmentMode(host, env),
    fingerprint: await fingerprintNativeVaultInputs(host, { ...options, env }),
    separateOpenCodeLogin,
  }
}

/** Grant native-account read access and require a vault-backed default Claude account with an account identity before moving Pi's login aside. */
export async function completeNativeVaultActivation(
  host: HarnessKind,
  options: NativeVaultActivationOptions,
  preflight: NativeVaultPreflight,
): Promise<'committed' | 'already-vault'> {
  const env = { ...options.env }
  const processFence = () => vaultProcessFence({ ...options, env })
  validateVaultAuthContent({ ...options, env })
  const plan = options.paths ?? (await resolveNativeSetupPaths(host, env))
  if (
    (await fingerprintNativeVaultInputs(host, options)) !==
    preflight.fingerprint
  )
    throw new NativeVaultActivationError('host-auth-invalid')
  const approvedName = await grantNativeVaultForHost(host, {
    env,
    runner: options.runner,
    processFence,
    ckBinary: options.enrollment?.ckBinary,
    paths: options.enrollment?.paths,
  })
  const listVault =
    options.discover ??
    (() =>
      discoverNativeVaultInventory({
        paths: plan.paths,
        host,
        env:
          host === 'pi'
            ? {
                ...env,
                OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_CONNECTION_FILE:
                  env.PI_ANTHROPIC_AUTH_CLAUSTRUM_CONNECTION_FILE,
              }
            : env,
      }))
  // Keep this setup's own latest listing to explain an empty result.
  let listed: NativeCustodyInventory | undefined
  const discover = async () => {
    listed = await listVault()
    return listed
  }
  const runtime = createNativeAccountRuntime({
    paths: plan.paths,
    host,
    vault: { env, discover },
  })
  try {
    await processFence()
    await runtime.vault.refresh()
    const snapshot = await runtime.read()
    const main = snapshot.accounts.find((row) => row.id === 'main')
    if (
      snapshot.mode !== 'claustrum' ||
      !main?.accountIdentity ||
      main.source !== 'vault'
    ) {
      const code = unservedCode(listed)
      throw code === 'primary-unverified'
        ? new NativeVaultActivationError(code)
        : new NativeVaultActivationError(code, host, approvedName)
    }
    if (host === 'pi') {
      const slot = openNativePiAuthSlot({
        env,
        authPath: plan.hostAuthPath,
      })
      const current = await slot.inspect()
      // Do not call a mutator without its fence, even for an observed no-op:
      // the auth slot could change before enterVault acquires its lock.
      if (current.slot !== 'placeholder' || current.stash !== 'valid') {
        await processFence()
        await slot.enterVault()
      }
    }
    return preflight.priorMode === 'claustrum' ? 'already-vault' : 'committed'
  } finally {
    await runtime.close()
  }
}

/** Outside runSetup, check inputs, enroll the host, then grant and activate vault access. runSetup owns enrollment and calls preflight and completion separately. */
export async function activateNativeVaultForHost(
  host: HarnessKind,
  options: NativeVaultActivationOptions,
): Promise<'committed' | 'already-vault'> {
  const operation = { ...options, env: { ...options.env } }
  const preflight = await preflightNativeVaultForHost(host, operation)
  await enrollNativeVaultForHost(host, {
    env: operation.env,
    runner: operation.runner,
    processFence: () => vaultProcessFence(operation),
    ...operation.enrollment,
    grantPermissions: false,
  })
  return completeNativeVaultActivation(host, operation, preflight)
}
