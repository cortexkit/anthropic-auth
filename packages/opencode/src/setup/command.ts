import { types } from 'node:util'
import {
  assertHostsStopped,
  createProcessFence,
  decideOpenCodeStateLayoutOnce,
  decidePiStateLayout,
  isVaultHosted,
  type NativeHolderRegistration,
  NativePiAuthSlotError,
  NativeSetupSettingsWriteError,
  openNativePiAuthSlot,
  publishNativeEmptyInit,
  readNativeEnrollmentMode,
  releaseNativeMigrationPreflight,
  requireNoSupervisedAuthContentSnapshot,
  restoreLegacyLayout,
  runSetup,
  type SetupCallbackContext,
  type SetupIO,
  type SetupPlugin,
  StateLayoutRefusalError,
  setupUsage,
  VAULT_HOST_CONNECT_REFUSAL,
} from '@cortexkit/anthropic-auth-core'
import { confirm } from '@cortexkit/common-auth/auth-menu'
import {
  knownFailureMessage,
  reportThrownFailure,
  setupEnrollmentOutcomes,
} from '../cli-failure.ts'
import { CLAUDE_POOL_LOGIN_STEP } from '../v2/activation.ts'
import { defaultCommandRunner } from './command-runner.ts'
import {
  completeNativeVaultActivation,
  fingerprintNativeVaultInputs,
  type NativeVaultPreflight,
  preflightNativeVaultForHost,
} from './native-activation.ts'
import {
  NATIVE_VAULT_HOST_DISPLAY_NAMES,
  NATIVE_VAULT_HOST_NAMES,
  nativeVaultConnectionFile,
  nativeVaultHostPaths,
} from './native-enrollment.ts'
import {
  fingerprintNativeLocalPlan,
  inspectSetupHostAuth,
  installAbsentNativePlaceholder,
  migrateNativeLocalForHost,
  type NativeLocalPlan,
  nativeLocalProcessFence,
  planNativeLocalSetup,
  requireNativeLocalEnrollment,
  revalidateNativeLocalPlan,
  SEPARATE_HOST_LOGIN_NOTICE,
} from './native-local.ts'
import { loginNativeOffline } from './native-login.ts'
import {
  requireDisjointNativeSetupPaths,
  resolveNativeSetupPaths,
} from './native-paths.ts'
import {
  getSetupPackageVersion,
  OPENCODE_PACKAGE_NAME,
  PI_PACKAGE_NAME,
} from './paths.ts'
import {
  type HarnessKind,
  SetupRefusal,
  setupProcessInspectionMessage,
  setupRefusalMessage,
} from './types.ts'

export interface SetupCommandOptions extends SetupIO {
  migrateLocal?: typeof migrateNativeLocalForHost
  localLogin?: typeof loginNativeOffline
  vaultPreflight?: typeof preflightNativeVaultForHost
  vaultActivate?: typeof completeNativeVaultActivation
  /** Replaces the restore of the legacy layout; tests only. */
  restoreLegacy?: typeof restoreLegacyLayout
}

const OPENCODE_VAULT_LOGIN_WARNING =
  'Warning: OpenCode holds a separate Anthropic OAuth login. Remove the separate OpenCode Anthropic login, then choose "Claude via credential vault". Setup has left that login unchanged.'

/** How users run setup; the help's usage line shows it. */
const SETUP_COMMAND = 'npx @cortexkit/opencode-anthropic-auth setup'

const REMOVE_PI_AUTH = '--remove-pi-auth'
const RESTORE_LEGACY = '--restore-legacy'
const YES_ALIAS = '-y'
const HELP_FLAGS = ['--help', '-h']

/**
 * The flags this command handles itself before handing the remaining
 * arguments to the shared setup parser. The argument handling in
 * `runSetupCommand` and the help text both read these names, so the help
 * cannot drift from what the command accepts.
 */
const COMMAND_FLAGS: ReadonlyArray<{ label: string; description: string }> = [
  {
    label: REMOVE_PI_AUTH,
    description:
      'Agree in advance to move a stored Pi Anthropic login out of the way: into the local account pool, or aside privately for vault use (restored on disconnect).',
  },
  {
    label: RESTORE_LEGACY,
    description:
      "Move anthropic-auth's state from the CortexKit state folder back into OpenCode's config folder, for example before going back to an older version. Close every OpenCode, OpenCode 2 server and Pi first. Use it on its own.",
  },
  { label: YES_ALIAS, description: 'Same as --yes.' },
  { label: HELP_FLAGS.join(', '), description: 'Show this help.' },
]

/**
 * The text `setup --help` prints: the shared parser's own flag list (which
 * comes from the same copy of common-auth that parses the arguments), then the
 * flags and limits this command adds.
 */
function setupHelpText(): string {
  const width = Math.max(...COMMAND_FLAGS.map((flag) => flag.label.length))
  return [
    setupUsage({ command: SETUP_COMMAND }),
    '',
    'Also accepted by this command:',
    ...COMMAND_FLAGS.map(
      (flag) => `  ${flag.label.padEnd(width)}  ${flag.description}`,
    ),
    '',
    '--login cannot be combined with --claustrum, or with --opencode=2: for OpenCode 2, sign in from OpenCode itself.',
  ].join('\n')
}

function hostPlan<Value>(
  plans: ReadonlyMap<HarnessKind, Value>,
  host: HarnessKind,
): Value {
  const plan = plans.get(host)
  if (!plan) throw new Error('Missing setup plan')
  return plan
}

export async function runSetupCommand(
  argv: string[] = [],
  options: SetupCommandOptions = {},
): Promise<number> {
  const env = { ...(options.env ?? process.env) }
  const terminal = options.terminal ?? {
    input: process.stdin,
    output: process.stdout,
    signals: process,
  }
  const print = (text: string) => terminal.output.write(`${text}\n`)
  // The shared parser has no help flag of its own, so help is answered here,
  // before any argument check or host inspection.
  if (argv.some((arg) => HELP_FLAGS.includes(arg))) {
    print(setupHelpText())
    return 0
  }
  if (isVaultHosted()) {
    print(VAULT_HOST_CONNECT_REFUSAL)
    return 1
  }
  if (argv.includes(RESTORE_LEGACY))
    return runRestoreLegacy(argv, options, env, print)
  const args = argv
    .filter((arg) => arg !== REMOVE_PI_AUTH)
    .map((arg) => (arg === YES_ALIAS ? '--yes' : arg))
  const login = args.includes('--login')
  if (login && args.includes('--claustrum')) {
    print(
      'Local sign-in and vault setup are two separate choices. Use --login or --claustrum, not both.',
    )
    return 1
  }
  if (login && args.includes('--opencode=2')) {
    print(CLAUDE_POOL_LOGIN_STEP)
    return 1
  }
  const runner = options.runner ?? defaultCommandRunner
  const fence =
    options.fence ?? createProcessFence(runner, { platform: options.platform })
  const migrateLocal = options.migrateLocal ?? migrateNativeLocalForHost
  const local = new Map<HarnessKind, NativeLocalPlan>()
  const vault = new Map<HarnessKind, NativeVaultPreflight>()
  const paths = new Map<
    HarnessKind,
    Awaited<ReturnType<typeof resolveNativeSetupPaths>>
  >()
  const consent = new Map<HarnessKind, boolean>()
  const holderRegistrations: NativeHolderRegistration[] = []
  let classified = false
  let phase: Parameters<typeof reportThrownFailure>[0] = 'setup-process-check'
  const localOptions = (host: HarnessKind) => ({
    env,
    fence,
    paths: paths.get(host),
    removePiAnthropicAuth: consent.get(host) ?? false,
    reportSettings: print,
  })
  const vaultOptions = (host: HarnessKind) => ({
    ...localOptions(host),
    runner,
  })

  async function piConsent(context: SetupCallbackContext) {
    if (!context.hosts.includes('pi')) return
    const plan = hostPlan(paths, 'pi')
    const entry = await inspectSetupHostAuth('pi', plan.hostAuthPath)
    if (entry.kind === 'absent') return
    {
      const slot = await openNativePiAuthSlot({
        env,
        authPath: plan.hostAuthPath,
      }).inspect()
      if (slot.slot === 'placeholder' && slot.stash === 'missing')
        throw new NativePiAuthSlotError('missing-stash')
      if (context.mode === 'claustrum') {
        if (slot.slot === 'placeholder') return
      }
    }
    if (argv.includes(REMOVE_PI_AUTH)) {
      consent.set('pi', true)
      return
    }
    const message =
      context.mode === 'claustrum'
        ? 'Pi has stored Anthropic authentication. Rerun with --remove-pi-auth to preserve it privately during vault use and restore it on disconnect.'
        : 'Pi has a stored Anthropic login. Rerun with --remove-pi-auth to move it into the native account pool.'
    if (args.includes('--yes') || !terminal.input.isTTY)
      throw new SetupRefusal(message)
    const answer = await confirm(
      terminal,
      context.mode === 'claustrum'
        ? 'Move Pi authentication aside privately for vault use, then restore it on disconnect?'
        : 'Move the Pi Anthropic OAuth login into the native account pool and remove its stored copy?',
    )
    if (!answer)
      throw new SetupRefusal(
        'Native account-pool setup cannot finish while the stored Pi OAuth token takes precedence.',
      )
    consent.set('pi', true)
  }

  async function revalidateVault(host: HarnessKind, enrolled: boolean) {
    const expected = hostPlan(vault, host)
    const mode = await readNativeEnrollmentMode(host, env)
    if (
      mode !== (enrolled ? 'claustrum' : expected.priorMode) ||
      (await fingerprintNativeVaultInputs(host, vaultOptions(host))) !==
        expected.fingerprint
    )
      throw new SetupRefusal(
        'Setup inputs changed. Rerun setup with all hosts stopped.',
      )
  }

  const plugin: SetupPlugin = {
    packages: { opencode: OPENCODE_PACKAGE_NAME, pi: PI_PACKAGE_NAME },
    version: await getSetupPackageVersion(),
    displayName: 'CortexKit Anthropic Auth',
    slashCommand: '/claude',
    vault: {
      connectionFile: nativeVaultConnectionFile(
        env.PI_ANTHROPIC_AUTH_CLAUSTRUM_CONNECTION_FILE &&
          !env.OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_CONNECTION_FILE
          ? 'pi'
          : 'opencode',
        env,
      ),
      hosts: {
        opencode: {
          name: NATIVE_VAULT_HOST_NAMES.opencode,
          displayName: NATIVE_VAULT_HOST_DISPLAY_NAMES.opencode,
          requestedGrants: [
            { selector: { category: 'anthropic-native' }, operation: 'read' },
          ],
          paths: nativeVaultHostPaths('opencode', env),
        },
        pi: {
          name: NATIVE_VAULT_HOST_NAMES.pi,
          displayName: NATIVE_VAULT_HOST_DISPLAY_NAMES.pi,
          requestedGrants: [
            { selector: { category: 'anthropic-native' }, operation: 'read' },
          ],
          paths: nativeVaultHostPaths('pi', env),
        },
      },
    },
    async beforeSignIn(host, context) {
      phase = context.mode === 'claustrum' ? 'setup-activation' : 'cli-setup'
      if (!classified) {
        requireNoSupervisedAuthContentSnapshot(env)
        // Decide where OpenCode's account state is before resolving any of
        // its paths; every later resolution in this process uses the same
        // answer. The decision also records that setup uses those files, so a
        // later version never moves them while setup runs.
        if (context.hosts.includes('opencode')) {
          const decision = await decideOpenCodeStateLayoutOnce({
            role: 'setup',
            env,
          })
          if (decision.kind !== 'state-home' && decision.registration)
            holderRegistrations.push(decision.registration)
        }
        for (const selected of context.hosts)
          paths.set(selected, await resolveNativeSetupPaths(selected, env))
        await requireDisjointNativeSetupPaths([...paths.values()])
        // Pi's files never move; setup still records its use of them.
        if (context.hosts.includes('pi'))
          holderRegistrations.push(
            (
              await decidePiStateLayout({
                paths: hostPlan(paths, 'pi').paths,
                role: 'setup',
              })
            ).registration,
          )
        if (context.mode === 'claustrum') {
          const files = context.hosts.map((selected) =>
            nativeVaultConnectionFile(selected, env),
          )
          const connectionFile = files[0]
          if (new Set(files).size !== 1 || !connectionFile)
            throw new SetupRefusal(
              'Selected hosts use different vault connection files.',
            )
          plugin.vault.connectionFile = connectionFile
        }
        if (
          context.mode === 'local' &&
          login &&
          context.hosts.includes('opencode') &&
          context.opencodeGeneration === '2'
        )
          throw new SetupRefusal(CLAUDE_POOL_LOGIN_STEP)
        if (context.mode === 'local') {
          await requireNativeLocalEnrollment(context.hosts, env)
          for (const selected of context.hosts)
            await nativeLocalProcessFence(selected, localOptions(selected))()
        }
        await piConsent(context)
        for (const selected of context.hosts) {
          if (context.mode === 'claustrum') {
            vault.set(
              selected,
              await (options.vaultPreflight ?? preflightNativeVaultForHost)(
                selected,
                {
                  ...vaultOptions(selected),
                  inspectOpenCodeAuth: context.opencodeGeneration !== '2',
                },
              ),
            )
            if (hostPlan(vault, selected).separateOpenCodeLogin)
              print(OPENCODE_VAULT_LOGIN_WARNING)
          } else {
            local.set(
              selected,
              await planNativeLocalSetup(
                selected,
                localOptions(selected),
                selected === 'opencode' && context.opencodeGeneration === '2',
              ),
            )
          }
        }
        classified = true
      } else if (context.mode === 'claustrum')
        await revalidateVault(host, false)
      else
        await revalidateNativeLocalPlan(
          hostPlan(local, host),
          localOptions(host),
        )
    },
    async signInLocal(host) {
      const plan = hostPlan(local, host)
      if (!login) {
        if (plan.generation2) print(CLAUDE_POOL_LOGIN_STEP)
        return
      }
      await revalidateNativeLocalPlan(plan, localOptions(host))
      await migrateLocal(host, {
        ...localOptions(host),
        login: options.localLogin ?? loginNativeOffline,
        preflight: plan.preflight,
        skipMigration: plan.action === 'skip',
        beforeCommit: () => revalidateNativeLocalPlan(plan, localOptions(host)),
      })
      plan.fingerprint = await fingerprintNativeLocalPlan(plan, env)
      if (plan.notice) print(SEPARATE_HOST_LOGIN_NOTICE)
    },
    async beforeRegister(host, mode) {
      if (mode === 'local')
        await revalidateNativeLocalPlan(
          hostPlan(local, host),
          localOptions(host),
        )
      else {
        await revalidateVault(host, true)
        await (options.vaultActivate ?? completeNativeVaultActivation)(
          host,
          vaultOptions(host),
          hostPlan(vault, host),
        )
        hostPlan(vault, host).fingerprint = await fingerprintNativeVaultInputs(
          host,
          vaultOptions(host),
        )
      }
    },
    async migrate(host, context) {
      if (context.mode === 'claustrum') {
        await revalidateVault(host, true)
        // runSetup prints fixed completion instructions with no plugin-supplied lines.
        // Repeat the login warning in its last callback to keep it near those instructions.
        if (
          host === context.hosts.at(-1) &&
          vault.get('opencode')?.separateOpenCodeLogin
        )
          print(OPENCODE_VAULT_LOGIN_WARNING)
        return
      }
      const plan = hostPlan(local, host)
      await revalidateNativeLocalPlan(plan, localOptions(host))
      if (login) return
      if (plan.action === 'migration')
        await migrateLocal(host, {
          ...localOptions(host),
          preflight: plan.preflight,
        })
      else if (plan.action === 'empty-init')
        await publishNativeEmptyInit({
          paths: plan.paths.paths,
          routingDestinationPath: plan.paths.routingDestinationPath,
          env,
          processFence: nativeLocalProcessFence(host, localOptions(host)),
        })
      else if (plan.action === 'skip') {
        await installAbsentNativePlaceholder(plan, localOptions(host))
        if (plan.notice) print(SEPARATE_HOST_LOGIN_NOTICE)
      }
      plan.fingerprint = await fingerprintNativeLocalPlan(plan, env)
    },
  }
  try {
    await runSetup(plugin, args, { ...options, env, terminal, runner, fence })
    return 0
  } catch (error) {
    const message =
      setupRefusalMessage(error) ??
      (types.isNativeError(error) &&
      error instanceof NativeSetupSettingsWriteError
        ? new NativeSetupSettingsWriteError().message
        : knownFailureMessage(error))
    const text = message ?? (await reportThrownFailure(phase, error, env))
    if (text) print(text)
    // When it fails after vault enrollment began, runSetup has already printed
    // one status line per host (connected, not connected, or unknown) and
    // records the same outcomes for setupEnrollment. Only the undo and retry
    // steps for a host left connected are added here.
    for (const { host, outcome } of setupEnrollmentOutcomes(error) ?? []) {
      if (outcome !== 'enrolled') continue
      const name = host === 'opencode' ? 'OpenCode' : 'Pi'
      print(
        `${name} stays connected to the vault. In ${name}, run /claude → Accounts → Disconnect from the vault to undo it. Or run setup again to finish connecting.`,
      )
    }
    return 1
  } finally {
    for (const registration of holderRegistrations) registration.close()
    for (const plan of local.values())
      if (plan.preflight) releaseNativeMigrationPreflight(plan.preflight)
  }
}

/**
 * `setup --restore-legacy`: move OpenCode's account state from the state
 * folder back into its config folder, or finish a restore that stopped. It
 * runs only with every host stopped, behind setup's process fence. A refusal
 * prints the restore's own message, which names the files to deal with.
 */
async function runRestoreLegacy(
  argv: readonly string[],
  options: SetupCommandOptions,
  env: NodeJS.ProcessEnv,
  print: (text: string) => void,
): Promise<number> {
  if (argv.some((arg) => arg !== RESTORE_LEGACY)) {
    print(`${RESTORE_LEGACY} runs on its own; run it without other options.`)
    return 1
  }
  const runner = options.runner ?? defaultCommandRunner
  const fence =
    options.fence ?? createProcessFence(runner, { platform: options.platform })
  try {
    await assertHostsStopped(fence, env)
  } catch (error) {
    const message =
      setupProcessInspectionMessage(error) ?? knownFailureMessage(error)
    print(
      message ?? (await reportThrownFailure('setup-process-check', error, env)),
    )
    return 1
  }
  try {
    const outcome = await (options.restoreLegacy ?? restoreLegacyLayout)({
      env,
    })
    if (outcome.status === 'not-moved') {
      print(`Nothing to restore: ${outcome.reason}.`)
      return 0
    }
    print(`anthropic-auth's state is back in ${outcome.oldDir}.`)
    for (const path of outcome.kept)
      print(
        `${path} changed after it was copied back and was left in place; delete it once you have checked it.`,
      )
    return 0
  } catch (error) {
    if (error instanceof StateLayoutRefusalError) {
      print(error.message)
      return 1
    }
    print(
      knownFailureMessage(error) ??
        (await reportThrownFailure('cli-setup', error, env)),
    )
    return 1
  }
}
