import { readFile } from 'node:fs/promises'
import {
  discoverNativeVaultInventory,
  inspectNativeHostAuthEntry,
  type NativeCustodyActivationHooks,
  type NativeCustodyInventory,
  publishNativeVaultRosterSeed,
  publishNativeVaultRuntimeSeed,
  readNativeMigrationJournal,
  requireNoSupervisedAuthContentSnapshot,
  runNativeCustodyActivation,
  runNativeMigration,
} from '@cortexkit/anthropic-auth-core'

import {
  enrollNativeVaultForHost,
  type NativeVaultEnrollmentOptions,
} from './native-enrollment.ts'
import {
  type NativeSetupPaths,
  resolveNativeSetupPaths,
} from './native-paths.ts'
import { assertHostsStopped } from './process-fence.ts'
import type { CommandRunner, HarnessKind, ProcessFence } from './types.ts'

export class NativeVaultActivationError extends Error {
  constructor(
    public readonly code:
      | 'auth-content-refused'
      | 'host-auth-invalid'
      | 'primary-conflict'
      | 'consent-required',
  ) {
    super(
      {
        'auth-content-refused':
          'Run setup without OPENCODE_AUTH_CONTENT in the environment.',
        'host-auth-invalid': 'The host auth file could not be read safely.',
        'primary-conflict':
          'Pi has a stored Anthropic API key, which would take precedence over the vault account. Remove it in Pi, then rerun setup.',
        'consent-required':
          'Pi has a stored Anthropic OAuth login. Rerun setup and agree to remove it so the vault account serves requests.',
      }[code],
    )
    this.name = 'NativeVaultActivationError'
  }
}

export interface NativeVaultActivationOptions {
  env: NodeJS.ProcessEnv
  runner: CommandRunner
  fence: ProcessFence
  /** The user's explicit consent to delete Pi's stored Anthropic OAuth login. */
  removePiAnthropicAuth: boolean
  /**
   * Tests override the host paths, enrollment client and vault listing;
   * production resolves them from the host's environment.
   */
  paths?: NativeSetupPaths
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

/**
 * Explicit offline switch of one host to vault custody: enroll this host,
 * finish (or start) its migration, then activate vault custody. Each host is
 * enrolled and activated on its own; nothing here runs at host startup.
 */
export async function activateNativeVaultForHost(
  host: HarnessKind,
  options: NativeVaultActivationOptions,
): Promise<'committed' | 'already-vault'> {
  const env = { ...options.env }
  // Checked before every write below: OPENCODE_AUTH_CONTENT (an auth snapshot
  // a supervising OpenCode passes down) must be unset, and no host may run.
  const processFence = async () => {
    try {
      requireNoSupervisedAuthContentSnapshot(env)
    } catch {
      throw new NativeVaultActivationError('auth-content-refused')
    }
    await assertHostsStopped(options.fence)
  }
  await processFence()
  const plan = options.paths ?? (await resolveNativeSetupPaths(host, env))
  let entry: ReturnType<typeof inspectNativeHostAuthEntry>
  try {
    entry = inspectNativeHostAuthEntry(
      host,
      await readHostAuth(plan.hostAuthPath),
    )
  } catch {
    throw new NativeVaultActivationError('host-auth-invalid')
  }
  if (host === 'pi') {
    // Consent to remove an OAuth login never covers a Pi API key.
    if (entry.kind === 'api_key')
      throw new NativeVaultActivationError('primary-conflict')
    if (entry.kind !== 'absent' && !options.removePiAnthropicAuth)
      throw new NativeVaultActivationError('consent-required')
  }
  await enrollNativeVaultForHost(host, {
    env,
    runner: options.runner,
    processFence,
    ...options.enrollment,
  })
  const discover =
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
  const journal = await readNativeMigrationJournal(plan.paths)
  // A retired (fully finished) migration is not rerun, because rerunning it
  // would repair host auth that the activation now checks. Otherwise finish
  // or start the migration; a first migration records that vault custody was
  // requested, which keeps serving refused until the activation commits.
  if (journal?.phase !== 'retired')
    await runNativeMigration({
      paths: plan.paths,
      legacyConfigPath: plan.legacyConfigPath,
      legacyStatePath: plan.legacyStatePath,
      host,
      hostAuthPath: plan.hostAuthPath,
      routingSourcePath: plan.routingSourcePath,
      routingDestinationPath: plan.routingDestinationPath,
      env,
      processFence,
      removePiAnthropicAuth: options.removePiAnthropicAuth,
      custody: {
        discover,
        publishSeed: publishNativeVaultRosterSeed,
        publishRuntimeSeed: publishNativeVaultRuntimeSeed,
      },
      ...(journal ? {} : { requestVaultActivation: true }),
    })
  const result = await runNativeCustodyActivation(
    {
      paths: plan.paths,
      host,
      env,
      processFence,
      removePiAnthropicAuth: options.removePiAnthropicAuth,
      discover,
    },
    options.hooks,
  )
  return result.status
}
