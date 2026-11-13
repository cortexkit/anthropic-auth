import type { SettingsEdit } from '@cortexkit/common-auth/settings'
import type { AccountStorage } from './accounts.ts'
import { setDumpEnabled } from './dump.ts'
import { logger, parseLogLevel, setLogLevel } from './logger.ts'
import {
  applyCommittedNativeSettingsEffects,
  captureNativeSettingsEffectFields,
  type NativeSettingsEffectFields,
} from './native-command-effects.ts'
import {
  differingLegacySettings,
  settingsNotImportedText,
} from './settings-authority.ts'
import { type SettingsKey, settingsDefinition } from './settings-definition.ts'
import {
  resolveSettingsMode,
  type SettingsMode,
  type SettingsModeOptions,
} from './settings-mode.ts'
import { readSettingsMoveSource } from './settings-move-source.ts'
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
  settingsAuthority?: {
    options?: SettingsModeOptions
    /** Schedule a background authority check and return its cancellation function. */
    schedule?: (callback: () => Promise<void>, delayMs: number) => () => void
  }
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
 * The host awaits prepareAction at instance start and before every menu action.
 * Watches and a background timer also check authority; requests use memory only.
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
  let userAuthority = (options.settingsMode?.() ?? 'user-file') === 'user-file'
  let closed = false
  let checking: Promise<void> | undefined
  let cancelCheck: (() => void) | undefined
  let loggedLateWrite = false
  let writes = 0
  const generation = () =>
    service &&
    (userAuthority ||
      (options.settingsMode?.() ?? 'user-file') === 'user-file') &&
    options.settingsMode?.() !== 'separate'
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

  function recheck(refresh = true): Promise<void> {
    if (checking) return checking
    if (closed || !service || options.settingsMode?.() === 'separate')
      return Promise.resolve()
    checking = (async () => {
      if (userAuthority) return
      if (
        (await resolveSettingsMode(
          { target: service.file, separate: false },
          options.settingsAuthority?.options,
        )) !== 'user-file'
      )
        return
      // Never await a re-entrant refresh from inside a service publication.
      if (refresh) await service.refresh()
      userAuthority = true
      cancelCheck?.()
      cancelCheck = undefined
      if (!writes) applyEffects()
    })().finally(() => {
      checking = undefined
    })
    return checking
  }
  function scheduleCheck() {
    if (
      closed ||
      !service ||
      userAuthority ||
      options.settingsMode?.() === 'separate'
    )
      return
    const schedule =
      options.settingsAuthority?.schedule ??
      ((callback, delayMs) => {
        const timer = setTimeout(() => void callback(), delayMs)
        timer.unref?.()
        return () => clearTimeout(timer)
      })
    cancelCheck = schedule(async () => {
      cancelCheck = undefined
      try {
        await recheck()
      } catch {
        // An unavailable authority probe is retried off-request on the next tick.
      } finally {
        scheduleCheck()
      }
    }, 60_000)
  }
  const unwatch = service?.watch(() => {
    void recheck(false).catch(() => {})
    if (!writes) applyEffects()
  })
  const unonFileEvent = service?.onFileEvent?.(() => {
    void recheck().catch(() => {})
  })
  scheduleCheck()
  let ready = recheck()
  // A failed startup probe must not fail every later menu action: replace it
  // so the next action probes again (its own recheck reports a new failure).
  void ready.catch(() => {
    ready = Promise.resolve()
  })
  return {
    resolve,
    status,
    applyEffects,
    file: () => generation()?.file,
    async prepareAction() {
      await ready
      await recheck()
    },
    /**
     * Called under the legacy store's locks by a write that chose the legacy
     * store: true when the user file became authoritative meanwhile (a move
     * published while the write waited for those locks), so the write must
     * leave the legacy store alone and go to the user file instead.
     */
    async legacyAuthorityLost() {
      if (!service || userAuthority || options.settingsMode?.() === 'separate')
        return false
      return (
        (await resolveSettingsMode(
          { target: service.file, separate: false },
          options.settingsAuthority?.options,
        )) === 'user-file'
      )
    },
    /** Recheck authority on the menu path before choosing a write target. */
    async prepareWrite() {
      if (!service || options.settingsMode?.() === 'separate') return undefined
      await ready
      await recheck()
      return generation() ? service : undefined
    },
    async legacyWriteCommitted(
      source: string,
      stored: Record<string, unknown>,
    ) {
      if (loggedLateWrite || !service) return
      await recheck()
      const current = generation()
      if (!current) return
      const legacy = readSettingsMoveSource(JSON.stringify(stored), {
        host: options.host,
        path: source,
        quiet: true,
      })
      const differing = differingLegacySettings(
        legacy,
        {
          ...current.contexts[options.host].noModel,
          ...current.protection[options.host].values,
        },
        options.host,
      )
      if (!differing.length) return
      loggedLateWrite = true
      logger.warn(
        'settings',
        settingsNotImportedText(source, service.file, differing),
      )
    },
    async update(
      edits: readonly SettingsEdit[],
      before: Record<string, unknown>,
      /** The file text a floor list was planned from; see SettingsUpdateOptions. */
      expectedSource?: string,
    ) {
      if (!service) throw new Error('Settings service is not available')
      // Menu commits emit effects once, even when a service watch fires during the edit.
      writes++
      let changed = false
      try {
        changed =
          (
            await service.update(edits, options.host, {
              createMissing: true,
              ...(expectedSource === undefined ? {} : { expectedSource }),
            })
          ).outcome === 'updated'
      } finally {
        writes--
      }
      const next = resolve(before)
      const withLevel = (settings: Record<string, unknown>) => ({
        ...settings,
        logging: {
          level:
            parseLogLevel(sectionLevel(settings)) ??
            parseLogLevel(env.OPENCODE_ANTHROPIC_AUTH_LOG_LEVEL) ??
            'info',
        },
      })
      const committed = withLevel(next)
      if (changed)
        applyCommittedNativeSettingsEffects(
          captureNativeSettingsEffectFields(withLevel(before)),
          committed,
        )
      effects = captureNativeSettingsEffectFields(committed)
      setDumpEnabled(
        (next.dump as { enabled?: boolean } | undefined)?.enabled === true,
      )
    },
    close: async () => {
      closed = true
      cancelCheck?.()
      unwatch?.()
      unonFileEvent?.()
      await checking?.catch(() => {})
      await service?.dispose()
    },
  }
}

function sectionLevel(settings: Record<string, unknown>) {
  const level = (settings.logging as { level?: unknown } | undefined)?.level
  return typeof level === 'string' ? level : undefined
}
