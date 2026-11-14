import { logger } from './logger.ts'
import { readNativeEnrollmentMode } from './native-enrollment-authority.ts'
import { requireNativePoolAuthority } from './pool-authority.ts'
import { resolveNativePoolPaths } from './pool-paths.ts'
import {
  markSettingsImportPending,
  resolveSettingsMode,
  type SettingsAdoptionCheck,
  type SettingsMode,
  setSettingsAdoptionCheck,
} from './settings-mode.ts'
import {
  importSettingsHostStore,
  runSettingsMoveAtStartup,
  type SettingsMoveStartupOptions,
} from './settings-move-run.ts'
import {
  getSettingsFilePath,
  getSettingsStorePaths,
  resolveSettingsPaths,
  type SettingsPaths,
} from './settings-paths.ts'
import { writeSettingsProtectionCopy } from './settings-protection-copy.ts'
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
  /**
   * Off the request path: open the service again and run this host's import
   * check; undefined while either still fails.
   */
  reopen(): Promise<SettingsService | undefined>
  /**
   * True when the service the last `reopen` returned was adopted for a
   * missing file whose import is still owed: the runtime must pass the
   * import check again before it uses a file that appears.
   */
  importPending?(): boolean
  /**
   * Present with `resolveAuthority`: once it finds legacy mode, open the
   * service only to notice a later move, without adopting the file.
   */
  reopenLegacy?(): Promise<SettingsService | undefined>
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
  /**
   * The settings file; empty only when no path could be resolved, which the
   * shared-runtime key treats as "no settings file".
   */
  file: string
  /** Open in user-file mode, and in legacy mode to notice another host's move. */
  service?: SettingsService
  /** Set instead of `service` when the file is in charge but could not open. */
  fallback?: SettingsProtectionFallback
  /**
   * Set in legacy mode when the service could not open, or the enrollment or
   * migration preflight refused: open it again off the request path, so a
   * move another host publishes later is noticed.
   */
  reopen?: SettingsReopen
}

/**
 * Opens the settings service again off the request path; undefined while it
 * still cannot. `retryDelaysMs` asks the runtime to try sooner than its
 * normal interval, one delay per attempt, before falling back to it.
 */
export interface SettingsReopen {
  (): Promise<SettingsService | undefined>
  readonly retryDelaysMs?: readonly number[]
  /**
   * True once a reopen found that this host is a separate install: it never
   * opens the shared settings file, and the runtime treats it as separate.
   */
  readonly separate?: () => boolean
}

/** A repaired enrollment or migration is usually noticed within seconds. */
const PREFLIGHT_RETRY_DELAYS_MS = [2_000, 5_000, 15_000] as const

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
 * that proves no move happened (no file, no marker) returns legacy mode, or
 * a refused enrollment or migration preflight, while requests are refused.
 *
 * Every service it opens carries the import check (see
 * `setSettingsAdoptionCheck`): a runtime that starts in legacy mode adopts
 * a file that appears later only after that check passes. Until this host
 * has adopted the file, its applied protection copy is not written from the
 * file, so a file whose import is still owed never becomes the copy that
 * recovery trusts.
 */
export async function startSettings(
  options: StartSettingsOptions,
): Promise<StartedSettings> {
  // Refused native enrollment or unfinished credential migration must not start
  // settings I/O. The host's existing credential checks report the refusal on
  // requests. The runtime repeats this check off the request path and opens
  // the settings service once it passes.
  const preflight = async () => {
    const mode = await (options.readMode ?? readNativeEnrollmentMode)(
      options.host,
      options.env,
    )
    if (mode === 'local') {
      const stores =
        options.paths?.own ?? getSettingsStorePaths(options.host, options)
      const paths =
        options.ownPoolPaths ??
        (await resolveNativePoolPaths(stores.account, stores.state))
      await requireNativePoolAuthority(paths)
    }
  }
  let refused = false
  try {
    await preflight()
  } catch {
    refused = true
  }
  /** Throws while the preflight still refuses. */
  const passPreflight = async () => {
    if (!refused) return
    await preflight()
    refused = false
  }
  const move = options.start?.move ?? runSettingsMoveAtStartup
  const open = options.start?.open ?? openSettingsService

  // Applied copies wait until this host uses the file. The newest one held
  // back is written when it adopts the file.
  let adopted = false
  let held: Parameters<typeof writeSettingsProtectionCopy> | undefined
  const writeAppliedCopy: typeof writeSettingsProtectionCopy = (...args) => {
    if (adopted) return writeSettingsProtectionCopy(...args)
    held = args
    return Promise.resolve()
  }
  const serviceOptions = (file: string): SettingsServiceOptions => ({
    file,
    host: options.host,
    protection: options.protection,
    lockTimeoutMs: options.lockTimeoutMs,
    // Until this host adopts the file, a missing or unusable file recovers
    // its protection from the ladder, never from a set the file once held.
    adopted: () => adopted,
    // A host's own open seam (used by host tests) spreads its own service
    // dependencies over these options, so it keeps them and its copy writer.
    ...(options.start?.open ? {} : { dependencies: { writeAppliedCopy } }),
  })

  let paths: SettingsPaths | undefined
  const resolvePaths = async () => {
    paths ??=
      options.paths ?? (await resolveSettingsPaths(options.host, options))
    return paths
  }
  const logged = new Set<string>()
  const warnOnce = (message: string) => {
    if (logged.has(message)) return
    logged.add(message)
    if (options.log) options.log.warn(message)
    else logger.warn('settings', message)
  }
  const adopt: SettingsAdoptionCheck = async (service) => {
    const outcome = await importSettingsHostStore(
      { ...options, paths: await resolvePaths() },
      service,
      warnOnce,
      'at its next settings check',
    )
    // A missing file is used without an import: no applied copy comes from
    // it, and the check runs again once a file appears.
    if (outcome === 'pending') return 'pending'
    if (outcome !== 'adopt') return false
    adopted = true
    const copy = held
    held = undefined
    // A failure leaves the copy to the next generation this host applies.
    if (copy) await writeSettingsProtectionCopy(...copy).catch(() => {})
    return true
  }
  const track = (service: SettingsService | undefined) => {
    if (service) setSettingsAdoptionCheck(service, adopt)
    return service
  }

  let file = ''
  // A move this start completed keeps the file in charge even if a later
  // authority check could not confirm it: for example, when writing the
  // `<file>.moved` marker failed and the file was then deleted, the check
  // finds neither and would wrongly report that no move happened.
  let moved = false
  if (!refused) {
    try {
      const started = await move(options)
      file = started.paths.target
      paths = started.paths
      moved = started.mode === 'user-file'
      // The startup move already ran the import check before choosing the
      // file, unless the file is missing and this host's import is pending.
      adopted = moved && !started.importPending
      if (!started.mayOpenService) return { mode: started.mode, file }
      const service = track(await open(serviceOptions(file)))
      if (!service) return { mode: started.mode, file }
      if (started.importPending) markSettingsImportPending(service)
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
  }
  const openService = async () => {
    if (!file) return undefined
    try {
      return track(await open(serviceOptions(file)))
    } catch {
      return undefined
    }
  }
  const probe = async () => {
    const resolved = await resolvePaths()
    file = resolved.target
    return resolveSettingsMode(resolved, { ...options, ...options.authority })
  }
  /** Off the request path, for a runtime in legacy mode: watch for a move. */
  const reopenLegacy = async () => {
    try {
      await passPreflight()
    } catch {
      return undefined
    }
    return openService()
  }
  /**
   * Off the request path, replacing the fallback: open the service, and hand
   * it over only once this host's import check passes (or is pending on a
   * missing file, which `importPending` then reports).
   */
  let importPending = false
  const reopenOnFile = async () => {
    try {
      await passPreflight()
    } catch {
      return undefined
    }
    const service = await openService()
    if (!service) return undefined
    try {
      const adoption = await adopt(service)
      if (adoption) {
        importPending = adoption === 'pending'
        return service
      }
    } catch {
      // An unavailable check keeps the fallback until the next try.
    }
    await service.dispose()
    return undefined
  }
  if (refused) {
    // Injected paths say without any I/O that this is a separate install,
    // which never uses the shared settings file.
    if (options.paths?.separate)
      return { mode: 'separate', file: options.paths.target }
    // Requests are refused by the host's credential checks while the
    // preflight refuses, so plain legacy mode with no settings I/O is enough.
    // Once it passes, requests must be served at once: legacy values apply
    // until the runtime's check, off the request path, opens the service and
    // adopts a file in charge through the import check. A pure path keeps
    // the shared-runtime key real.
    try {
      file = options.paths?.target ?? getSettingsFilePath(options)
    } catch {
      // Without a path the runtime key uses an explicit "no settings file".
    }
    // Whether this is a separate install is known only once the paths can be
    // resolved, after the preflight passes. A separate install then never
    // opens the shared file: it resolves paths to the user's default file.
    let separate = false
    const reopenAfterPreflight: SettingsReopen = Object.assign(
      async () => {
        if (separate) return undefined
        try {
          await passPreflight()
          const resolved = await resolvePaths()
          file = resolved.target
          separate = resolved.separate
        } catch {
          return undefined
        }
        if (separate) return undefined
        return openService()
      },
      { retryDelaysMs: PREFLIGHT_RETRY_DELAYS_MS, separate: () => separate },
    )
    return { mode: 'legacy', file, reopen: reopenAfterPreflight }
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
  if (mode === 'legacy') return { mode, file, reopen: reopenLegacy }
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
      reopen: reopenOnFile,
      importPending: () => importPending,
      ...(unknown ? { reopenLegacy, resolveAuthority: probe } : {}),
    },
  }
}
