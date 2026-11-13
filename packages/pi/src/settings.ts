import {
  createNativeAccountRuntime,
  legacySettingsProtection,
  type NativeAccountRuntimeOptions,
  type NativeHolderRegistration,
  openSettingsService,
  readPeerLegacySettingsProtection,
  type SettingsMoveStartupOptions,
  type SettingsServiceOptions,
  startSettings,
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
  // Create a runtime only if migration must initialize the vault settings file.
  let legacy: ReturnType<typeof createNativeAccountRuntime> | undefined
  try {
    const initializeVaultSettings = () => {
      legacy ??= createNativeAccountRuntime(runtime)
      return legacy.vault.initializeSettings()
    }
    return await startSettings({
      ...options.startup,
      host: 'pi',
      env,
      home,
      ownPoolPaths: runtime.paths,
      initializeVaultSettings,
      fence: { registration, ...options.startup?.fence },
      lockTimeoutMs: options.service?.lockTimeoutMs,
      start: options.service && {
        open: (settings) =>
          openSettingsService({ ...options.service, ...settings }),
      },
      protection: {
        readLegacyProtection: async () => {
          // Reopening the settings service can outlive startup. Give each
          // recovery read its own runtime rather than using the closed one.
          const recovery = createNativeAccountRuntime(runtime)
          try {
            const snapshot = await recovery.read()
            return legacySettingsProtection(
              snapshot.policyStorage,
              'pi',
              snapshot.mode,
            )
          } catch {
            return undefined
          } finally {
            await recovery.close()
          }
        },
        // Recreating a missing settings file needs OpenCode's own protection.
        readPeerLegacyProtection: (host) =>
          readPeerLegacySettingsProtection({
            host,
            env,
            home,
            readMode: options.startup?.readMode,
          }),
      },
    })
  } finally {
    await legacy?.close()
  }
}
