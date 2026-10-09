import {
  confirm,
  intro,
  isCancel,
  log,
  multiselect,
  note,
  outro,
  spinner,
} from '@clack/prompts'
import { defaultCommandRunner } from './command-runner.ts'
import { detectAll } from './detect.ts'
import { activateNativeVaultForHost } from './native-activation.ts'
import {
  ensureOpenCodePluginConfig,
  ensureOpenCodeTuiConfig,
} from './opencode-config.ts'
import { getSetupPackageVersion } from './paths.ts'
import { installPiExtension } from './pi.ts'
import {
  assertHostsStopped,
  defaultProcessFence,
  ProcessFenceViolationError,
} from './process-fence.ts'
import type { CommandRunner, HarnessKind, ProcessFence } from './types.ts'

export interface SetupCommandOptions {
  runner?: CommandRunner
  fence?: ProcessFence
  env?: NodeJS.ProcessEnv
  isInteractive?: boolean
  /** Test seams for host detection and per-host vault activation. */
  detect?: typeof detectAll
  activate?: typeof activateNativeVaultForHost
}

export async function runSetupCommand(
  argv: string[] = [],
  options: SetupCommandOptions = {},
): Promise<number> {
  const env = options.env ?? process.env
  const runner = options.runner ?? defaultCommandRunner
  const fence = options.fence ?? defaultProcessFence
  const activate = options.activate ?? activateNativeVaultForHost

  const nonInteractive = argv.includes('--yes') || argv.includes('-y')
  const dryRun = argv.includes('--dry-run')
  const explicitNoClaustrum = argv.includes('--no-claustrum')
  const explicitClaustrum = argv.includes('--claustrum')
  const explicitRemovePiAuth = argv.includes('--remove-pi-auth')

  intro('CortexKit Anthropic Auth Setup')

  // 1. Detect environment
  const s = spinner()
  s.start('Detecting installed environments…')
  const detection = await (options.detect ?? detectAll)(env, runner)
  s.stop('Environment detection complete.')

  const opencodeStatus = detection.opencode.installed
    ? `detected (${detection.opencode.version ?? 'version unknown'}, ${detection.opencode.pluginInstalled ? 'plugin already configured' : 'plugin not configured'})`
    : 'not found'
  const piStatus = detection.pi.installed
    ? `detected (${detection.pi.version ?? 'version unknown'}, ${detection.pi.pluginInstalled ? 'extension already installed' : 'extension not installed'})`
    : 'not found'
  const claustrumStatus = detection.claustrum.daemonRunning
    ? `daemon running (${detection.claustrum.ckVersion ?? 'ck ready'})`
    : detection.claustrum.ckInstalled
      ? 'ck installed, daemon not running'
      : 'not installed'

  log.info(`OpenCode:   ${opencodeStatus}`)
  log.info(`Pi:         ${piStatus}`)
  log.info(`Claustrum:  ${claustrumStatus}`)

  if (!detection.opencode.installed && !detection.pi.installed) {
    log.error('Neither OpenCode nor Pi was detected on this system.')
    outro(
      'Install OpenCode (https://opencode.ai) or Pi (https://github.com/badlogic/pi-mono) first.',
    )
    return 1
  }

  // 2. Select harnesses
  let selectedHosts: HarnessKind[] = []
  if (nonInteractive) {
    if (detection.opencode.installed) selectedHosts.push('opencode')
    if (detection.pi.installed) selectedHosts.push('pi')
  } else {
    const choices: Array<{ value: HarnessKind; label: string; hint?: string }> =
      []
    if (detection.opencode.installed) {
      choices.push({
        value: 'opencode',
        label: 'OpenCode',
        hint: detection.opencode.pluginInstalled
          ? 'already configured'
          : 'configure plugin + TUI sidebar',
      })
    }
    if (detection.pi.installed) {
      choices.push({
        value: 'pi',
        label: 'Pi',
        hint: detection.pi.pluginInstalled
          ? 'already installed'
          : 'install provider extension',
      })
    }

    const selection = await multiselect({
      message: 'Select integrations to configure:',
      options: choices,
      initialValues: choices.map((c) => c.value),
      required: true,
    })

    if (isCancel(selection)) {
      outro('Setup cancelled.')
      return 0
    }

    selectedHosts = selection as HarnessKind[]
  }

  if (selectedHosts.length === 0) {
    outro('No integrations selected.')
    return 0
  }

  // 3. Claustrum selection
  let useClaustrum = false
  const claustrumAvailable =
    detection.claustrum.daemonRunning && detection.claustrum.ckInstalled

  // Vault custody is explicit only: --yes alone never switches custody.
  if (claustrumAvailable && !explicitNoClaustrum) {
    if (explicitClaustrum) {
      useClaustrum = true
    } else if (!nonInteractive) {
      const claustrumChoice = await confirm({
        message:
          'Claustrum daemon is running. Switch Anthropic accounts to Claustrum vault custody? Local OAuth logins are removed once their vault accounts are verified.',
        initialValue: false,
      })

      if (isCancel(claustrumChoice)) {
        outro('Setup cancelled.')
        return 0
      }

      useClaustrum = claustrumChoice
    }
  }

  // 4. If Pi selected and Claustrum chosen, handle local auth conflict
  let removePiLocalAuth = false
  if (
    selectedHosts.includes('pi') &&
    useClaustrum &&
    detection.pi.hasLocalAuth
  ) {
    if (nonInteractive) {
      // Deleting a stored login needs its own flag; --yes is not consent.
      if (!explicitRemovePiAuth) {
        log.error(
          'Pi has a stored Anthropic login. Rerun with --remove-pi-auth to remove it for vault custody.',
        )
        outro('Setup aborted.')
        return 1
      }
      removePiLocalAuth = true
    } else {
      log.warn(
        'Pi has a stored local Anthropic OAuth token. Claustrum custody replaces local credentials.',
      )
      const consent = await confirm({
        message:
          'Remove local Pi Anthropic OAuth credential so Claustrum custody can serve requests?',
        initialValue: false,
      })

      if (isCancel(consent) || !consent) {
        log.error(
          'Claustrum custody cannot be enabled for Pi while a local OAuth token takes precedence.',
        )
        outro('Setup aborted.')
        return 1
      }

      removePiLocalAuth = true
    }
  }

  // 5. Verify host quiescence before any changes
  try {
    await assertHostsStopped(fence)
  } catch (error) {
    if (error instanceof ProcessFenceViolationError) {
      log.error(error.message)
      outro('Setup aborted — quit active hosts and rerun setup.')
      return 1
    }
    throw error
  }

  if (dryRun) {
    log.info('[dry-run] Planned actions:')
    log.info(`  - Target integrations: ${selectedHosts.join(', ')}`)
    log.info(`  - Claustrum custody: ${useClaustrum ? 'enabled' : 'disabled'}`)
    if (removePiLocalAuth) log.info('  - Pi local OAuth token will be removed')
    outro('Dry run complete. No changes were made.')
    return 0
  }

  const version = await getSetupPackageVersion()

  // Each host is enrolled and activated on its own. A failure stops setup
  // before the next host; a host already switched stays switched.
  const activateHost = async (host: HarnessKind, label: string) => {
    s.start(`Switching ${label} to Claustrum vault custody…`)
    try {
      const outcome = await activate(host, {
        env,
        runner,
        fence,
        removePiAnthropicAuth: host === 'pi' && removePiLocalAuth,
      })
      s.stop(
        outcome === 'already-vault'
          ? `${label} already uses Claustrum vault custody.`
          : `${label} now uses Claustrum vault custody.`,
      )
      return true
    } catch (error: unknown) {
      s.stop(`${label} vault custody setup failed.`)
      log.error(error instanceof Error ? error.message : String(error))
      return false
    }
  }

  // 6. Execute OpenCode setup
  if (selectedHosts.includes('opencode')) {
    s.start('Configuring OpenCode plugin and TUI sidebar…')
    try {
      await ensureOpenCodePluginConfig(version, env)
      await ensureOpenCodeTuiConfig(version, env)
      s.stop('OpenCode configuration updated.')
    } catch (error: unknown) {
      s.stop('OpenCode setup failed.')
      log.error(error instanceof Error ? error.message : String(error))
      return 1
    }
    if (useClaustrum && !(await activateHost('opencode', 'OpenCode'))) return 1
  }

  // 7. Execute Pi setup
  if (selectedHosts.includes('pi')) {
    s.start('Installing Pi Anthropic extension…')
    try {
      const installRes = await installPiExtension(version, runner, env)
      if (!installRes.ok) {
        s.stop('Pi extension installation failed.')
        log.error(installRes.message)
        return 1
      }
      s.stop('Pi Anthropic extension installed.')
    } catch (error: unknown) {
      s.stop('Pi setup failed.')
      log.error(error instanceof Error ? error.message : String(error))
      return 1
    }
    if (useClaustrum && !(await activateHost('pi', 'Pi'))) return 1
  }

  // 8. Next steps note
  const nextSteps: string[] = []
  if (selectedHosts.includes('opencode')) {
    nextSteps.push('• Start OpenCode normally (opencode).')
  }
  if (selectedHosts.includes('pi')) {
    nextSteps.push('• Start Pi normally (pi).')
  }
  if (useClaustrum) {
    nextSteps.push(
      '• Manage accounts in Claustrum with: ck auth login --provider anthropic',
    )
    nextSteps.push(
      '  Newly added accounts will be discovered automatically without restarting.',
    )
  }

  note(nextSteps.join('\n'), 'Next Steps')
  outro('Setup complete!')
  return 0
}
