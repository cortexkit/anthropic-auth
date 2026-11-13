import type { AccountStorage } from './accounts.ts'
import { setDumpEnabled } from './dump.ts'
import { parseLogLevel, setLogLevel } from './logger.ts'
import {
  applyCommittedNativeSettingsEffects,
  captureNativeSettingsEffectFields,
  type NativeSettingsEffectFields,
} from './native-command-effects.ts'
import { type SettingsKey, settingsDefinition } from './settings-definition.ts'
import type { SettingsMode } from './settings-mode.ts'
import type { SettingsHost } from './settings-paths.ts'
import { resolveSettingsRecord } from './settings-record.ts'
import type {
  SettingsFileStatus,
  SettingsService,
  SettingsValues,
} from './settings-service.ts'

export interface NativeRuntimeSettingsOptions {
  settingsService?: SettingsService
  /** Return the cached settings mode; this callback must not read the filesystem. */
  settingsMode?: () => SettingsMode
}

export interface NativeRuntimeSettingsStatus {
  file: SettingsFileStatus
  values: SettingsValues
  modelOverrides: Partial<
    Record<SettingsKey, { model: string; value: SettingsValues[SettingsKey] }[]>
  >
}

/**
 * Project policy settings from memory, retaining a service reference until close.
 * The host releases its own reference and checks off the request path whether
 * the user file exists or a marker records a completed settings migration, then
 * updates the cached legacy/user-file mode.
 */
export function createNativeRuntimeSettings(
  options: NativeRuntimeSettingsOptions & {
    host: SettingsHost
    env?: NodeJS.ProcessEnv
  },
) {
  const env = options.env ?? process.env
  const service = options.settingsService?.retain()
  let effects: NativeSettingsEffectFields | undefined
  const generation = () =>
    service && (options.settingsMode?.() ?? 'user-file') === 'user-file'
      ? service.snapshot()
      : undefined

  function resolve(stored: AccountStorage, model?: string): AccountStorage
  function resolve(
    stored: Record<string, unknown>,
    model?: string,
  ): Record<string, unknown>
  function resolve(stored: Record<string, unknown>, model?: string) {
    return resolveSettingsRecord(stored, generation(), options.host, model)
  }

  function applyEffects() {
    if (!generation()) return
    const settings = resolve({ version: 1, accounts: [] } as AccountStorage)
    const next = captureNativeSettingsEffectFields(settings)
    const level =
      parseLogLevel(next.logLevel) ??
      parseLogLevel(env.OPENCODE_ANTHROPIC_AUTH_LOG_LEVEL) ??
      'info'
    // Compare inferred levels too, so removing a stored level restores the environment default.
    const committed = { ...settings, logging: { level } }
    if (effects) applyCommittedNativeSettingsEffects(effects, committed)
    else if (!env.OPENCODE_ANTHROPIC_AUTH_LOG_LEVEL) setLogLevel(level)
    effects = captureNativeSettingsEffectFields(committed)
    setDumpEnabled(settings.dump?.enabled === true)
  }

  function status(): NativeRuntimeSettingsStatus | undefined {
    const current = generation()
    if (!current) return undefined
    const context = current.contexts[options.host]
    const modelOverrides: NativeRuntimeSettingsStatus['modelOverrides'] = {}
    for (const key of Object.keys(
      settingsDefinition.settings,
    ) as SettingsKey[]) {
      const definition = settingsDefinition.settings[key]
      if (!('overrides' in definition) || !('model' in definition.overrides))
        continue
      const rows = Object.entries(context.models)
        .filter(([model]) => current.fileLevels[key]?.includes(model))
        .map(([model, values]) => ({ model, value: values[key] }))
      modelOverrides[key] = rows
    }
    return {
      file: current.fileStatus,
      values: {
        ...context.noModel,
        ...current.protection[options.host].values,
      },
      modelOverrides,
    }
  }

  const unwatch = service?.watch(() => applyEffects())
  return {
    resolve,
    status,
    applyEffects,
    file: () => generation()?.file,
    close: () => {
      unwatch?.()
      return service?.dispose()
    },
  }
}
