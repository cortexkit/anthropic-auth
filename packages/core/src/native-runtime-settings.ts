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
  getSettingsAdoptionCheck,
  resolveSettingsMode,
  type SettingsMode,
  type SettingsModeOptions,
} from './settings-mode.ts'
import { readSettingsMoveSource } from './settings-move-source.ts'
import type { SettingsHost } from './settings-paths.ts'
import {
  overlaySettingsProtection,
  resolveSettingsRecord,
} from './settings-record.ts'
import type {
  SettingsFileStatus,
  SettingsService,
  SettingsUpdate,
  SettingsValues,
} from './settings-service.ts'
import type {
  SettingsProtectionFallback,
  SettingsReopen,
} from './settings-start.ts'

export interface NativeRuntimeSettingsOptions {
  settingsService?: SettingsService
  /** Return the cached settings mode; this callback must not read the filesystem. */
  settingsMode?: () => SettingsMode
  settingsAuthority?: {
    options?: SettingsModeOptions
    /** Schedule a background authority check and return its cancellation function. */
    schedule?: (callback: () => Promise<void>, delayMs: number) => () => void
  }
  /**
   * From `startSettings` when the file is in charge but its service could not
   * open: requests overlay the fallback's protection on the legacy record,
   * menu writes are refused, and the authority timer and menu actions try to
   * open the service again until it replaces the fallback.
   */
  settingsFallback?: SettingsProtectionFallback
  /**
   * From `startSettings` in legacy mode when the service could not open: the
   * authority timer and menu actions open it again off the request path, so a
   * move another host publishes later is still noticed.
   */
  settingsReopen?: SettingsReopen
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
  // Read before retaining: the check is attached to the handle startSettings returned.
  let adoption = getSettingsAdoptionCheck(options.settingsService)
  let service = options.settingsService?.retain()
  let fallback = service ? undefined : options.settingsFallback
  let reopenLegacy = service || fallback ? undefined : options.settingsReopen
  const quickRetries = [...(reopenLegacy?.retryDelaysMs ?? [])]
  // Set when a fallback started with unknown authority later learns the true
  // mode; it then replaces the host's cached mode for this runtime.
  let probedMode: SettingsMode | undefined
  const mode = () => probedMode ?? options.settingsMode?.() ?? 'user-file'
  let effects: NativeSettingsEffectFields | undefined
  let userAuthority = mode() === 'user-file'
  let closed = false
  let checking: Promise<void> | undefined
  let cancelCheck: (() => void) | undefined
  let loggedLateWrite = false
  let writes = 0
  const generation = () =>
    service &&
    (userAuthority || mode() === 'user-file') &&
    mode() !== 'separate'
      ? service.snapshot()
      : undefined

  function resolve(stored: AccountStorage, model?: string): AccountStorage
  function resolve(
    stored: Record<string, unknown>,
    model?: string,
  ): Record<string, unknown>
  function resolve(stored: Record<string, unknown>, model?: string) {
    if (fallback && mode() !== 'separate')
      return overlaySettingsProtection(stored, fallback.values, options.host)
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
    if (closed || !service || mode() === 'separate') return Promise.resolve()
    const current = service
    checking = (async () => {
      if (userAuthority) return
      if (
        (await resolveSettingsMode(
          { target: current.file, separate: false },
          options.settingsAuthority?.options,
        )) !== 'user-file'
      )
        return
      // Never await a re-entrant refresh from inside a service publication.
      if (refresh) await current.refresh()
      // The file this host did not move may lack protection its legacy store
      // holds: adopt it only once the import check passes. Until then the
      // host keeps legacy settings, and the timer, watches and menu actions
      // check again.
      if (adoption && !(await adoption(current))) return
      if (closed || service !== current) return
      userAuthority = true
      cancelCheck?.()
      cancelCheck = undefined
      if (!writes) applyEffects()
    })().finally(() => {
      checking = undefined
    })
    return checking
  }
  /**
   * Off the request path: open the service that failed to open at start,
   * replacing the protection fallback, or joining a legacy runtime so it can
   * notice a later move. A fallback whose authority was unknown first asks
   * again which source is in charge, and leaves the fallback once a check
   * proves no move happened.
   */
  async function reopen() {
    if (closed || service) return
    const current = fallback
    if (current?.resolveAuthority) {
      // A failing check throws and keeps the fallback until the next try.
      const found = await current.resolveAuthority()
      if (closed || service || fallback !== current) return
      if (found !== 'user-file') {
        probedMode = found
        userAuthority = false
        fallback = undefined
        if (found === 'legacy')
          reopenLegacy = current.reopenLegacy ?? current.reopen
      }
    }
    const before = fallback
    const open = before?.reopen ?? reopenLegacy
    if (!open) return
    const next = await open()
    if (!next) return
    if (closed || service || fallback !== before) {
      await next.dispose()
      return
    }
    service = next
    adoption = getSettingsAdoptionCheck(next)
    fallback = undefined
    reopenLegacy = undefined
    subscribe(next)
    if (!writes) applyEffects()
  }
  function scheduleCheck() {
    if (closed || mode() === 'separate') return
    if (!fallback && !reopenLegacy && (!service || userAuthority)) return
    const schedule =
      options.settingsAuthority?.schedule ??
      ((callback, delayMs) => {
        const timer = setTimeout(() => void callback(), delayMs)
        timer.unref?.()
        return () => clearTimeout(timer)
      })
    // A reopen may ask for quicker first retries (a repaired preflight), used
    // only while the service has not opened yet.
    const delayMs = (!service && quickRetries.shift()) || 60_000
    cancelCheck = schedule(async () => {
      cancelCheck = undefined
      try {
        if (!service) await reopen()
        // A legacy runtime that just opened its service checks for a move now.
        if (service) await recheck()
      } catch {
        // An unavailable authority probe is retried off-request on the next tick.
      } finally {
        scheduleCheck()
      }
    }, delayMs)
  }
  let unwatch: (() => void) | undefined
  let unonFileEvent: (() => void) | undefined
  function subscribe(next: SettingsService) {
    unwatch = next.watch(() => {
      void recheck(false).catch(() => {})
      if (!writes) applyEffects()
    })
    unonFileEvent = next.onFileEvent?.(() => {
      void recheck().catch(() => {})
    })
  }
  if (service) subscribe(service)
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
      await reopen().catch(() => {})
      await recheck()
    },
    /** The settings file while the protection fallback is in use, else undefined. */
    fallbackFile: () => fallback?.file,
    /**
     * Called under the legacy store's locks by a write that chose the legacy
     * store: true when the user file became authoritative meanwhile (a move
     * published while the write waited for those locks), so the write must
     * leave the legacy store alone and go to the user file instead. A watch,
     * the timer or another action may already have adopted the file while
     * the write waited; that counts as lost too.
     */
    async legacyAuthorityLost() {
      if (!service || mode() === 'separate') return false
      if (userAuthority) return true
      return (
        (await resolveSettingsMode(
          { target: service.file, separate: false },
          options.settingsAuthority?.options,
        )) === 'user-file'
      )
    },
    /** Recheck authority on the menu path before choosing a write target. */
    async prepareWrite() {
      if (mode() === 'separate') return undefined
      await reopen().catch(() => {})
      if (!service) return undefined
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
    async update(edits: SettingsUpdate, before: Record<string, unknown>) {
      if (!service) throw new Error('Settings service is not available')
      // Menu commits emit effects once, even when a service watch fires during the edit.
      writes++
      let changed = false
      try {
        changed =
          (
            await service.update(edits, options.host, {
              createMissing: true,
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
