import {
  createNativeAccountRuntime,
  readNativeMigrationJournal,
  requireNoSupervisedAuthContentSnapshot,
  runNativeMigration,
} from '@cortexkit/anthropic-auth-core'
import { type NativeSetupPaths, resolveNativeSetupPaths } from './native-paths'
import { assertHostsStopped } from './process-fence'
import type { HarnessKind, ProcessFence } from './types'

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
}

/** Transfer local credentials while hosts are stopped, before telling the user to restart. */
export async function migrateNativeLocalForHost(
  host: HarnessKind,
  options: NativeLocalSetupOptions,
): Promise<void> {
  const env = { ...options.env }
  const processFence = async () => {
    requireNoSupervisedAuthContentSnapshot(env)
    await assertHostsStopped(options.fence)
  }
  await processFence()
  const plan = options.paths ?? (await resolveNativeSetupPaths(host, env))
  const journal = await readNativeMigrationJournal(plan.paths)
  if (
    options.login &&
    (journal?.phase === 'retired' || journal?.phase === 'committed')
  ) {
    const current = createNativeAccountRuntime({ paths: plan.paths, host })
    try {
      if ((await current.read()).mode !== 'local')
        throw new Error(
          'Exit vault custody with offline setup before local sign-in',
        )
    } finally {
      current.close()
    }
  }
  const login = await options.login?.(host)
  if (
    login &&
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
      login.accountIdentity,
    )
  )
    throw new Error('Claude sign-in did not establish an account UUID')
  await processFence()
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
  })
  if (login) {
    const runtime = createNativeAccountRuntime({
      paths: plan.paths,
      host,
      beforePoolWrite: processFence,
    })
    try {
      const snapshot = await runtime.read()
      if (snapshot.mode !== 'local')
        throw new Error(
          'Exit vault custody with offline setup before local sign-in',
        )
      await processFence()
      await runtime.loginOAuth({ routeId: 'main', replace: true, ...login })
    } finally {
      runtime.close()
    }
  }
}
