import { logger } from './logger.ts'
import { resolveSettingsMode, type SettingsMode } from './settings-mode.ts'
import {
  runSettingsMoveAtStartup,
  type SettingsMoveStartupOptions,
} from './settings-move-run.ts'
import { getSettingsFilePath, resolveSettingsPaths } from './settings-paths.ts'
import {
  openSettingsService,
  recoverSettingsProtection,
  type SettingsProtectionRecovery,
  type SettingsProtectionValues,
  type SettingsService,
  type SettingsServiceOptions,
} from './settings-service.ts'

export interface StartSettingsOptions extends SettingsMoveStartupOptions {
  /** This host's recovery sources, shared by the service and the fallback. */
  protection?: SettingsProtectionRecovery
  lockTimeoutMs?: number
  /** Test seams for the move and the service open. */
  start?: {
    move?: typeof runSettingsMoveAtStartup
    open?: (
      options: SettingsServiceOptions,
    ) => Promise<SettingsService | undefined>
  }
}

/**
 * The settings file is in charge, but its service could not open. Protection
 * comes from the ladder without an open handle (this host's applied copy,
 * then its legacy store, then the strictest set); every other setting stays
 * as the legacy store holds it.
 */
export interface SettingsProtectionFallback {
  readonly file: string
  readonly rung: 1 | 2 | 3
  readonly values: SettingsProtectionValues
  /** Off the request path: open the service again; undefined while it still fails. */
  reopen(): Promise<SettingsService | undefined>
  /**
   * Present only when startup could not tell which source is in charge and
   * fell back to the file as a precaution. Off the request path, asks again;
   * throws while the check still fails. A result other than 'user-file'
   * means no move happened and the fallback should be dropped.
   */
  resolveAuthority?(): Promise<SettingsMode>
}

export interface StartedSettings {
  mode: SettingsMode
  /** The settings file; empty only when even its path could not be resolved. */
  file: string
  /** Open in user-file mode, and in legacy mode to notice another host's move. */
  service?: SettingsService
  /** Set instead of `service` when the file is in charge but could not open. */
  fallback?: SettingsProtectionFallback
  /**
   * Set in legacy mode when the service could not open: open it again off
   * the request path, so a move another host publishes later is noticed.
   */
  reopen?: () => Promise<SettingsService | undefined>
}

let warned = false

/** Tests only: let the next failed start log its one warning again. */
export function __resetSettingsStartWarningForTest(): void {
  warned = false
}

/**
 * The one settings startup every host calls; it never throws. It runs the
 * move, then opens the service. When either fails, a file that is (or may
 * be) in charge gets the protection fallback, never plain legacy values,
 * which may predate protection the user tightened in the file. Only a check
 * that proves no move happened (no file, no marker) returns legacy mode.
 */
export async function startSettings(
  options: StartSettingsOptions,
): Promise<StartedSettings> {
  const move = options.start?.move ?? runSettingsMoveAtStartup
  const open = options.start?.open ?? openSettingsService
  const serviceOptions = (file: string): SettingsServiceOptions => ({
    file,
    host: options.host,
    protection: options.protection,
    lockTimeoutMs: options.lockTimeoutMs,
  })
  let file = ''
  // A move this start completed keeps the file in charge even if a later
  // authority check could not confirm it: for example, when writing the
  // `<file>.moved` marker failed and the file was then deleted, the check
  // finds neither and would wrongly report that no move happened.
  let moved = false
  try {
    const started = await move(options)
    file = started.paths.target
    moved = started.mode === 'user-file'
    if (!started.mayOpenService) return { mode: started.mode, file }
    const service = await open(serviceOptions(file))
    if (!service) return { mode: started.mode, file }
    return { mode: started.mode, file, service }
  } catch {
    if (!warned) {
      warned = true
      logger.warn(
        'settings',
        'Settings startup failed; protection settings use their last applied values until the settings file can be opened.',
      )
    }
  }
  const reopen = async () => {
    if (!file) return undefined
    try {
      return await open(serviceOptions(file))
    } catch {
      return undefined
    }
  }
  const probe = async () => {
    const paths =
      options.paths ?? (await resolveSettingsPaths(options.host, options))
    file = paths.target
    return resolveSettingsMode(paths, { ...options, ...options.authority })
  }
  let mode: SettingsMode = 'user-file'
  let unknown = false
  if (!moved) {
    try {
      mode = await probe()
    } catch {
      // An unknown authority is treated as the file being in charge until a
      // later check off the request path can tell.
      mode = 'user-file'
      unknown = true
      if (!file) {
        try {
          file = getSettingsFilePath(options)
        } catch {
          // Without a path only the legacy store and the strictest set remain.
        }
      }
    }
  }
  if (mode === 'legacy') return { mode, file, reopen }
  if (mode !== 'user-file') return { mode, file }
  const recovered = await recoverSettingsProtection(
    file,
    options.host,
    options.protection,
    // Without a file path there is no applied copy to read.
    file ? options.host : undefined,
  )
  return {
    mode,
    file,
    fallback: {
      get file() {
        return file
      },
      rung: recovered.rung,
      values: recovered.values,
      reopen,
      ...(unknown ? { resolveAuthority: probe } : {}),
    },
  }
}
