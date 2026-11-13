import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import {
  assertHostsStopped,
  canonicalPath,
  createNativeAccountRuntime,
  custodyTombstoneOAuth,
  inspectNativeHostAuthEntry,
  legacySettingsProtection,
  logger,
  NativeMigrationError,
  type NativeMigrationPreflight,
  nativeJournalMayAdoptLaterHostLogin,
  nativePoolHoldsAccountData,
  prepareNativeMigration,
  readNativeEnrollmentMode,
  readNativeMigrationJournal,
  readSettingsMoveSource,
  releaseNativeMigrationPreflight,
  requireNoSupervisedAuthContentSnapshot,
  runNativeMigration,
  writeNativeHostAuth,
  writeNativeSetupSettings,
} from '@cortexkit/anthropic-auth-core'
import { type NativeSetupPaths, resolveNativeSetupPaths } from './native-paths'
import {
  type HarnessKind,
  type ProcessFence,
  SetupRefusal,
  setupProcessInspectionMessage,
} from './types'

export interface NativeOfflineLogin {
  credential: {
    type: 'oauth'
    access: string
    refresh: string
    expires: number
  }
  accountIdentity: string
}

export interface NativeLocalSetupOptions {
  env: NodeJS.ProcessEnv
  fence: ProcessFence
  paths?: NativeSetupPaths
  removePiAnthropicAuth: boolean
  login?: (host: HarnessKind) => Promise<NativeOfflineLogin>
  preflight?: NativeMigrationPreflight
  skipMigration?: boolean
  beforeCommit?: () => Promise<void>
  reportSettings?: (message: string) => void
}

export const SEPARATE_HOST_LOGIN_NOTICE =
  "OpenCode's separate Anthropic login is not used. Add that account through /claude Accounts if needed, or remove the separate login from OpenCode."

function localVaultRecovery(host: HarnessKind): string {
  const name = host === 'opencode' ? 'OpenCode' : 'Pi'
  return `${name} is still connected to the vault. Old local settings do not disconnect it. In ${name}, run /claude → Accounts → Disconnect from the vault. Then run local setup again.`
}

export async function requireNativeLocalEnrollment(
  hosts: readonly HarnessKind[],
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const refusals: string[] = []
  for (const host of hosts)
    if ((await readNativeEnrollmentMode(host, env)) !== 'local')
      refusals.push(localVaultRecovery(host))
  if (refusals.length) throw new SetupRefusal(refusals.join('\n'))
}

export function nativeLocalProcessFence(
  host: HarnessKind,
  options: NativeLocalSetupOptions,
) {
  return async () => {
    requireNoSupervisedAuthContentSnapshot(options.env)
    try {
      await assertHostsStopped(options.fence, options.env)
    } catch (error) {
      const message = setupProcessInspectionMessage(error)
      if (message) throw new SetupRefusal(message)
      throw error
    }
    await requireNativeLocalEnrollment([host], options.env)
  }
}

export async function nativeSetupFileFingerprint(
  path: string,
): Promise<string> {
  try {
    return createHash('sha256')
      .update(await readFile(path))
      .digest('hex')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'absent'
    throw new NativeMigrationError('unsafe-source')
  }
}

export async function inspectSetupHostAuth(host: HarnessKind, path: string) {
  let data: unknown
  try {
    data = JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      throw new NativeMigrationError('unsafe-source')
  }
  const entry = inspectNativeHostAuthEntry(host, data)
  const auth = (
    data as { anthropic?: { access?: string; refresh?: string } } | undefined
  )?.anthropic
  return {
    ...entry,
    realLogin: entry.kind === 'oauth' && Boolean(auth?.access && auth.refresh),
  }
}

export interface NativeLocalPlan {
  paths: NativeSetupPaths
  generation2: boolean
  action: 'migration' | 'skip' | 'empty-init' | 'reuse'
  slot?: Awaited<ReturnType<typeof inspectSetupHostAuth>>
  notice: boolean
  preflight?: NativeMigrationPreflight
  fingerprint: string
  authorityPhase:
    | NonNullable<
        Awaited<ReturnType<typeof readNativeMigrationJournal>>
      >['phase']
    | 'absent'
  poolPopulation: boolean | 'not-evaluated'
}

/** Hash pool, journal and routing bytes and the host's Anthropic entry, so a credential replacement cannot hide behind an unchanged account count. */
export async function fingerprintNativeLocalPlan(
  plan: NativeLocalPlan,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  const { paths } = plan
  const entry = plan.generation2
    ? undefined
    : await inspectSetupHostAuth(paths.host, paths.hostAuthPath)
  const files = await Promise.all(
    [
      paths.paths.config,
      paths.paths.state,
      paths.paths.runtime,
      paths.paths.roster,
      paths.paths.journal,
      paths.routingDestinationPath,
    ].map(nativeSetupFileFingerprint),
  )
  return JSON.stringify([
    await readNativeEnrollmentMode(paths.host, env),
    entry?.digest,
    ...files,
  ])
}

/** Record journal status, the host's Anthropic entry and whether setup will import, skip import or initialize a new pool, without writing. */
export async function planNativeLocalSetup(
  host: HarnessKind,
  options: NativeLocalSetupOptions,
  generation2: boolean,
): Promise<NativeLocalPlan> {
  const paths =
    options.paths ?? (await resolveNativeSetupPaths(host, options.env))
  const processFence = nativeLocalProcessFence(host, options)
  await processFence()
  const journal = await readNativeMigrationJournal(paths.paths)
  if (journal && journal.host !== host)
    throw new NativeMigrationError('invalid-source')
  const completed =
    journal?.phase === 'committed' || journal?.phase === 'retired'
  if (
    journal &&
    journal.kind !== 'empty-init' &&
    (journal.hostAuthPath !== (await canonicalPath(paths.hostAuthPath)) ||
      journal.routingPaths.source !==
        (await canonicalPath(paths.routingSourcePath)) ||
      journal.routingPaths.destination !==
        (await canonicalPath(paths.routingDestinationPath)))
  )
    throw new NativeMigrationError('invalid-source')
  const plan: NativeLocalPlan = {
    paths,
    generation2,
    action: 'migration',
    notice: false,
    fingerprint: '',
    authorityPhase: journal?.phase ?? 'absent',
    poolPopulation: 'not-evaluated',
  }
  if (generation2) {
    if (journal && !completed) throw new NativeMigrationError('invalid-source')
    plan.action = journal ? 'reuse' : 'empty-init'
    if (!journal) {
      const destinations = [
        paths.paths.config,
        paths.paths.state,
        paths.paths.runtime,
        paths.paths.roster,
      ]
      if (!options.env.OPENCODE_ANTHROPIC_AUTH_ROUTING_STATE_FILE)
        destinations.push(paths.routingDestinationPath)
      for (const path of destinations) {
        try {
          await lstat(path)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
          throw new NativeMigrationError('unsafe-source')
        }
        throw new NativeMigrationError('invalid-source')
      }
    }
  } else {
    plan.slot = await inspectSetupHostAuth(host, paths.hostAuthPath)
    // A retired import with an OpenCode login is checked for account data
    // the same way as empty-init: with none, setup imports the login.
    const adoptsLogin =
      nativeJournalMayAdoptLaterHostLogin(journal, host) &&
      plan.slot.kind === 'oauth'
    plan.poolPopulation =
      journal?.kind === 'empty-init' || adoptsLogin
        ? await nativePoolHoldsAccountData({ paths: paths.paths })
        : 'not-evaluated'
    const populated = plan.poolPopulation === true
    if (
      host === 'opencode' &&
      (populated ||
        (completed &&
          journal?.kind !== 'empty-init' &&
          !adoptsLogin &&
          plan.slot.kind === 'oauth'))
    ) {
      plan.action = 'skip'
      plan.notice = plan.slot.realLogin
    } else {
      plan.preflight = await prepareNativeMigration({
        ...paths,
        env: options.env,
        processFence,
        removePiAnthropicAuth: options.removePiAnthropicAuth,
      })
    }
  }
  plan.fingerprint = await fingerprintNativeLocalPlan(plan, options.env)
  return plan
}

export async function revalidateNativeLocalPlan(
  plan: NativeLocalPlan,
  options: NativeLocalSetupOptions,
): Promise<void> {
  await nativeLocalProcessFence(plan.paths.host, options)()
  const current = await planNativeLocalSetup(
    plan.paths.host,
    { ...options, paths: plan.paths },
    plan.generation2,
  )
  try {
    if (
      current.fingerprint !== plan.fingerprint ||
      current.action !== plan.action
    )
      throw new SetupRefusal(
        'Setup inputs changed. Rerun setup with all hosts stopped.',
      )
  } finally {
    if (current.preflight) releaseNativeMigrationPreflight(current.preflight)
  }
}

export async function installAbsentNativePlaceholder(
  plan: Pick<NativeLocalPlan, 'paths' | 'slot'>,
  options: NativeLocalSetupOptions,
): Promise<void> {
  if (plan.paths.host !== 'opencode' || plan.slot?.kind !== 'absent') return
  const processFence = nativeLocalProcessFence('opencode', options)
  await processFence()
  await mkdir(dirname(plan.paths.hostAuthPath), {
    recursive: true,
    mode: 0o700,
  })
  await writeNativeHostAuth({
    host: 'opencode',
    authPath: plan.paths.hostAuthPath,
    sourceDigest: 'absent',
    expectedDigest: inspectNativeHostAuthEntry('opencode', {
      anthropic: custodyTombstoneOAuth('anthropic'),
    }).digest,
    env: options.env,
    removePiAnthropicAuth: false,
    processFence,
  })
}

/** Route raw, deferred settings after credential commit without starting the settings move. */
export async function writeNativeLocalSetupSettings(
  host: HarnessKind,
  plan: NativeSetupPaths,
  options: NativeLocalSetupOptions,
  settings: Readonly<Record<string, unknown>>,
) {
  const report =
    options.reportSettings ??
    ((message: string) => logger.warn('setup', message))
  // This runtime has no settings service: its store mutator receives only the
  // legacy record's booleans. Released versions cannot read the settings
  // service's "default"/"on"/"off" values from their stores.
  const legacy = createNativeAccountRuntime({
    paths: plan.paths,
    host,
    vault: { env: options.env },
    settingsMode: () => 'legacy',
    beforePoolWrite: nativeLocalProcessFence(host, options),
  })
  try {
    const result = await writeNativeSetupSettings({
      host,
      env: options.env,
      home: options.env.HOME,
      source: plan.legacyConfigPath,
      settings,
      log: { warn: report },
      writeLegacySettings: async (moved) => {
        await legacy.updateSettings((stored) => ({ ...stored, ...moved }))
      },
      protection: {
        readLegacyProtection: async () => {
          const snapshot = await legacy.read()
          return legacySettingsProtection(
            snapshot.settings,
            host,
            snapshot.mode,
          )
        },
      },
    })
    for (const difference of result.differing)
      report(
        `Setup kept the user setting "${difference.key}"${difference.account ? ` for account "${difference.account}"` : ''}; the legacy value ${JSON.stringify(difference.legacy)} was not imported.`,
      )
    if (result.outcome !== 'saved') {
      const keys = Object.keys(
        readSettingsMoveSource(JSON.stringify(settings), {
          host,
          path: plan.legacyConfigPath,
          quiet: true,
        }),
      )
      report(
        `${result.reason} Credential transfer is committed. Set these settings by hand: ${keys.join(', ') || '(none)'}.`,
      )
    }
    return result
  } finally {
    await legacy.close()
  }
}

/** Transfer local credentials while hosts are stopped, before telling the user to restart. */
export async function migrateNativeLocalForHost(
  host: HarnessKind,
  options: NativeLocalSetupOptions,
): Promise<void> {
  const env = { ...options.env }
  const processFence = nativeLocalProcessFence(host, { ...options, env })
  await processFence()
  const plan = options.paths ?? (await resolveNativeSetupPaths(host, env))
  const login = await options.login?.(host)
  if (
    login &&
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
      login.accountIdentity,
    )
  )
    throw new Error('Claude sign-in did not establish an account UUID')
  await processFence()
  await options.beforeCommit?.()
  if (!options.skipMigration)
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
      preflight: options.preflight,
      writeSetupSettings: (settings) =>
        writeNativeLocalSetupSettings(
          host,
          plan,
          { ...options, env },
          settings,
        ),
    })
  if (login) {
    const runtime = createNativeAccountRuntime({
      paths: plan.paths,
      host,
      vault: { env },
      beforePoolWrite: processFence,
    })
    try {
      const snapshot = await runtime.read()
      if (snapshot.mode !== 'local')
        throw new SetupRefusal(localVaultRecovery(host))
      await processFence()
      await runtime.loginOAuth({ routeId: 'main', replace: true, ...login })
    } finally {
      await runtime.close()
    }
  }
  if (options.skipMigration) {
    const slot = await inspectSetupHostAuth(host, plan.hostAuthPath)
    await installAbsentNativePlaceholder(
      {
        paths: plan,
        slot,
      },
      options,
    )
  }
}
