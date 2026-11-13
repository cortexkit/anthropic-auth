import {
  createNativeAccountRuntime,
  legacySettingsProtection,
  type NativeAccountRuntimeOptions,
  type NativeHolderRegistration,
  openSettingsService,
  resolveSettingsPaths,
  runSettingsMoveAtStartup,
  type SettingsMoveStartupOptions,
  type SettingsServiceOptions,
} from '@cortexkit/anthropic-auth-core'

export interface PiSettingsOptions {
  home?: string
  startup?: Pick<SettingsMoveStartupOptions, 'dependencies' | 'readMode'> & {
    fence?: SettingsMoveStartupOptions['fence']
  }
  service?: Pick<SettingsServiceOptions, 'dependencies' | 'lockTimeoutMs'>
  authority?: NativeAccountRuntimeOptions['settingsAuthority']
}

/** Complete the settings move and initialize the service before Pi serves requests. */
export async function openPiSettings(
  runtime: NativeAccountRuntimeOptions,
  env: NodeJS.ProcessEnv,
  home: string,
  registration: NativeHolderRegistration | undefined,
  options: PiSettingsOptions = {},
) {
  const paths = await resolveSettingsPaths('pi', { env, home })
  if (paths.separate) return { mode: 'separate' as const, file: paths.target }
  // A temporary legacy-only runtime initializes vault settings and recovers
  // legacy protection values. Recovery reads never write those values to a store.
  const legacy = createNativeAccountRuntime(runtime)
  try {
    const initializeVaultSettings = () => legacy.vault.initializeSettings()
    const started = await runSettingsMoveAtStartup({
      ...options.startup,
      host: 'pi',
      env,
      home,
      paths,
      ownPoolPaths: runtime.paths,
      initializeVaultSettings,
      fence: { registration, ...options.startup?.fence },
    })
    const service = await openSettingsService({
      ...options.service,
      file: paths.target,
      host: 'pi',
      protection: {
        readLegacyProtection: async () => {
          try {
            const snapshot = await legacy.read()
            return legacySettingsProtection(
              snapshot.policyStorage,
              'pi',
              snapshot.mode,
            )
          } catch {
            return undefined
          }
        },
      },
    })
    return { mode: started.mode, file: paths.target, service }
  } finally {
    await legacy.close()
  }
}
