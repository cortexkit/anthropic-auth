import { readFile } from 'node:fs/promises'
import { isDeepStrictEqual } from 'node:util'
import {
  type MoveOutcome,
  type MoveResult,
  moveSettingsOnce,
  SettingsRefusal,
} from '@cortexkit/common-auth/settings'
import { parse } from 'jsonc-parser'

import { ensureHolderDirectory, HOLDER_LOCK_NAME } from './holder-registry.ts'
import { logger } from './logger.ts'
import { resolvePathOptions } from './path-options.ts'
import {
  differingLegacySettings,
  holdsMovedSettings,
  settingsNotImportedText,
} from './settings-authority.ts'
import { settingsDefinition } from './settings-definition.ts'
import { planSettingsHostImport } from './settings-host-import.ts'
import {
  hasSettingsImportRecord,
  hasSettingsMoveMarker,
  resolveSettingsMode,
  type SettingsMode,
  type SettingsModeOptions,
  writeSettingsImportRecord,
  writeSettingsMoveMarker,
} from './settings-mode.ts'
import {
  checkSettingsMoveFence,
  type SettingsMoveFenceOptions,
  settingsMoveHolderFiles,
} from './settings-move-fence.ts'
import { mapSettingsMoveSources } from './settings-move-map.ts'
import { readSettingsMoveSource } from './settings-move-source.ts'
import {
  prepareSettingsMoveSources,
  readOwnLegacySettingsProtection,
  type SettingsMoveSourcesOptions,
} from './settings-move-sources.ts'
import { resolveSettingsPaths, type SettingsPaths } from './settings-paths.ts'
import {
  openSettingsService,
  SETTINGS_PROTECTION_KEYS,
  type SettingsProtectionValues,
  type SettingsService,
} from './settings-service.ts'

export interface SettingsMoveStartupOptions extends SettingsMoveSourcesOptions {
  fence: Pick<
    SettingsMoveFenceOptions,
    'registration' | 'floor' | 'self' | 'liveness' | 'artifacts' | 'readHolders'
  >
  authority?: Pick<SettingsModeOptions, 'fs' | 'ownership' | 'now'>
  dependencies?: {
    prepareSources?: typeof prepareSettingsMoveSources
    move?: typeof moveSettingsOnce
  }
}

export interface SettingsMoveStartupResult {
  paths: SettingsPaths
  mode: SettingsMode
  /** Legacy mode still needs watch callbacks and timer checks for a peer's move. */
  mayOpenService: boolean
  outcome:
    | MoveOutcome
    | 'marker-present'
    | 'source-unavailable'
    /** The file is in charge, but this host's legacy store protects more. */
    | 'import-refused'
    /**
     * The file is in charge, but this host's legacy store could not be read
     * to check it. The host stays legacy, and its runtime checks again.
     */
    | 'import-unknown'
  move?: MoveResult
}

/** What a host's import check decided about using the settings file. */
export type SettingsHostImportOutcome =
  /** The file holds this host's legacy protection, or the check is not due yet. */
  | 'adopt'
  /** Writing the stricter legacy values failed or raced a protection change. */
  | 'refused'
  /** This host's legacy store could not be read, so its protection is unknown. */
  | 'unknown'

/**
 * The one check a host passes before it starts using a settings file it did
 * not move itself, at startup and when a running legacy host notices the
 * file later. A move under an explicit target imports only the mover's
 * store, and a hand-made file imports none, so the host's legacy store may
 * protect more than the file. For each protection key the file sets no value
 * for this host, a stricter legacy value is written at the host's level
 * first; then the host's import record is written.
 *
 * Never call it on the request path: it reads the legacy store and may write
 * the file. `retry` ends the warnings and says when the check runs again.
 */
export async function importSettingsHostStore(
  options: SettingsMoveSourcesOptions & {
    paths: SettingsPaths
    authority?: SettingsMoveStartupOptions['authority']
  },
  service: SettingsService,
  warn: (message: string) => void,
  retry: string,
): Promise<SettingsHostImportOutcome> {
  const { host, paths } = options
  const authority = { ...options, ...options.authority }
  const generation = service.snapshot()
  // A missing or unusable file already falls back to protection from this
  // host's applied copy or legacy store; the check runs again at a later start.
  if (generation.status !== 'ready' || !generation.protection[host].usable)
    return 'adopt'
  if (await hasSettingsImportRecord(paths.target, host, authority))
    return 'adopt'
  let legacy: SettingsProtectionValues | undefined
  try {
    legacy = await readOwnLegacySettingsProtection({ ...options, paths })
  } catch {
    // An unreadable store is not an empty one: its protection is unknown, so
    // the file must not replace it yet.
    warn(
      `Settings file ${paths.target} is not used by ${host} yet: its legacy settings could not be read to check them against the file. ${host} keeps its legacy settings and checks again ${retry}.`,
    )
    return 'unknown'
  }
  const resolved = service.resolve(host)
  const plan = legacy
    ? planSettingsHostImport({
        host,
        legacy,
        resolved: Object.fromEntries(
          SETTINGS_PROTECTION_KEYS.map((key) => [key, resolved[key]]),
        ) as SettingsProtectionValues,
        fileLevels: generation.fileLevels,
      })
    : { keys: [], edits: [] }
  // Only a failed write refuses adoption. Resolution belongs to common-auth,
  // so a changed protection field retries later instead of applying an
  // import computed from an older validated generation.
  if (plan.keys.length) {
    const expected = generation.source?.trim()
      ? parse(generation.source.replace(/^\uFEFF/, ''), [], {
          allowTrailingComma: true,
        })
      : {}
    try {
      await service.update((current) => {
        if (
          current.status !== 'ready' ||
          SETTINGS_PROTECTION_KEYS.some(
            (key) =>
              !isDeepStrictEqual(
                (current.document as Record<string, unknown>)[key],
                expected[key],
              ),
          )
        )
          throw new SettingsRefusal(
            'settings-busy',
            'Protection changed before import',
          )
        return plan.edits
      }, host)
    } catch {
      warn(
        `Settings file ${paths.target} is not used by ${host}: writing its legacy protection for ${plan.keys.join(', ')} failed. ${host} keeps its legacy settings and will retry the import ${retry}.`,
      )
      return 'refused'
    }
  }
  try {
    await writeSettingsImportRecord(paths.target, host, authority)
  } catch {
    // Without the record the same check simply runs again next time.
  }
  return 'adopt'
}

/**
 * Await once at host startup, before opening the settings service's first resolve.
 * Menu, watch and timer authority checks must not call the mover or retry a failed
 * attempt; a failed start keeps legacy settings until another host moves them or
 * this host restarts. The setup command, run while hosts are stopped, uses
 * authority checks only, never this entry point.
 */
export async function runSettingsMoveAtStartup(
  options: SettingsMoveStartupOptions,
): Promise<SettingsMoveStartupResult> {
  const paths =
    options.paths ?? (await resolveSettingsPaths(options.host, options))
  const authority = { ...options, ...options.authority }
  const logged = new Set<string>()
  const warn = (message: string) => {
    const key = `${paths.target}\0${message}`
    if (logged.has(key)) return
    logged.add(key)
    if (options.log) options.log.warn(message)
    else logger.warn('settings', message)
  }
  const result = (
    mode: SettingsMode,
    outcome: SettingsMoveStartupResult['outcome'],
    move?: MoveResult,
  ): SettingsMoveStartupResult => ({
    paths,
    mode,
    // A host that refused the file stays legacy until it restarts. An unknown
    // legacy store keeps the service open: the runtime's checks run the same
    // import check before adopting the file, and retry it.
    mayOpenService: mode !== 'separate' && outcome !== 'import-refused',
    outcome,
    ...(move ? { move } : {}),
  })

  /**
   * The file is in charge. Mark a usable hand-made file, check that this
   * host's legacy store was imported (or holds nothing the file lacks)
   * before adopting it, and report sources whose settings were not imported.
   */
  const startOnFile = async (
    outcome: SettingsMoveStartupResult['outcome'] | undefined,
    move?: MoveResult,
  ): Promise<SettingsMoveStartupResult> => {
    const marked = await hasSettingsMoveMarker(paths.target, authority)
    const service = await openSettingsService({ file: paths.target })
    if (!service) throw new Error('Settings service did not open')
    try {
      const generation = service.snapshot()
      // Schema-invalid protection entries do not make a hand-made file unparsed.
      if (!marked && generation.status === 'ready') {
        try {
          await writeSettingsMoveMarker(paths.target, authority)
        } catch {
          warn(`Could not write settings move marker ${paths.target}.moved.`)
        }
      }
      const imported = await importSettingsHostStore(
        { ...options, paths },
        service,
        warn,
        'at the next start',
      )
      if (imported === 'refused') return result('legacy', 'import-refused')
      // The runtime keeps its service in legacy mode and checks again off the
      // request path, so a store that becomes readable is imported then.
      if (imported === 'unknown') return result('legacy', 'import-unknown')
      if (generation.status !== 'missing') {
        const prepared = await prepareSettingsMoveSources({
          ...options,
          paths: marked ? { ...paths, sourceRule: 'own' } : paths,
          inspectOnly: true,
          log: { warn: () => {} },
        })
        for (const source of prepared.sources) {
          try {
            const text = await readFile(source.path, 'utf8')
            if (!holdsMovedSettings(JSON.parse(text))) continue
            const host = source.host as SettingsMoveStartupOptions['host']
            const values = readSettingsMoveSource(text, {
              host,
              path: source.path,
              quiet: true,
            })
            const differing = differingLegacySettings(
              values,
              service.resolve(host),
              host,
            )
            if (!marked || differing.length)
              warn(
                settingsNotImportedText(source.path, paths.target, differing),
              )
          } catch {
            // A diagnostic never restores legacy authority or prevents startup.
          }
        }
      }
    } finally {
      await service.dispose()
    }
    return result(
      'user-file',
      outcome ?? (marked ? 'marker-present' : 'done-already'),
      move,
    )
  }

  if (paths.separate) return result('separate', 'separate-install')
  if ((await resolveSettingsMode(paths, authority)) === 'user-file')
    return startOnFile(undefined)

  // Check before vault initialization, then again under the mover's source locks.
  // Store and account files share a folder, including overridden store paths.
  const stores = [paths.own.account]
  if (paths.sourceRule === 'default')
    stores.push(paths.defaults.opencode.account, paths.defaults.pi.account)
  const fence = async () =>
    (await checkSettingsMoveFence({ ...options, ...options.fence, stores }))
      .open
  if (!(await fence())) return result('legacy', 'fence-closed')

  const prepared = await (
    options.dependencies?.prepareSources ?? prepareSettingsMoveSources
  )({ ...options, paths })
  if (prepared.status !== 'ready') {
    if (prepared.status === 'unavailable')
      warn(
        `Settings move unavailable for ${prepared.host}: ${prepared.reason}; keeping legacy settings until the next start.`,
      )
    return result('legacy', 'source-unavailable')
  }
  // Hold every holder file's `holders` lock, in sorted path order, ahead of
  // the source locks and through publication, so no process can register
  // between the fence's last check (made by the mover under these locks)
  // and the published file. This cannot deadlock: a registrant holds one
  // `holders` lock at a time and takes no other lock while holding it, and
  // the state-layout mover takes `holders` locks in the same sorted order
  // before any data lock, as this move does.
  let holderFiles: string[]
  try {
    holderFiles = await settingsMoveHolderFiles({
      ...options,
      ...options.fence,
      stores,
    })
    // common-auth's mover skips a lock whose folder doesn't exist yet, and a
    // registrant could then create that folder and register while the move
    // publishes. Create each holder file's folder first (owner-only, as a
    // registrant would), so every `holders` lock is really taken.
    const context = resolvePathOptions(options)
    for (const file of holderFiles) {
      const folder = context.paths.dirname(file)
      if (options.authority?.fs?.mkdir) await options.authority.fs.mkdir(folder)
      else
        await ensureHolderDirectory(folder, {
          ...options.authority?.ownership,
          platform: context.platform,
        })
    }
  } catch {
    return result('legacy', 'fence-closed')
  }
  const [first, ...rest] = prepared.sources
  const sources = first
    ? [
        {
          ...first,
          locks: [
            ...holderFiles.map((path) => ({ path, name: HOLDER_LOCK_NAME })),
            ...first.locks,
          ],
        },
        ...rest,
      ]
    : []
  const move = await (options.dependencies?.move ?? moveSettingsOnce)({
    definition: settingsDefinition,
    target: paths.target,
    separateInstall: false,
    sources,
    map: mapSettingsMoveSources,
    fence: async () =>
      !(await hasSettingsMoveMarker(paths.target, authority)) &&
      (await fence()),
    log: { info: () => {}, warn },
  })
  if (move.outcome === 'moved') {
    // The mover has published the file and attempted all informational notes.
    // Failure to persist the marker cannot make the published file non-authoritative.
    try {
      await writeSettingsMoveMarker(paths.target, authority)
    } catch {
      warn(`Could not write settings move marker ${paths.target}.moved.`)
    }
    // Every host whose store this move read now has its settings in the
    // file, including protection it held only as an implicit default (see
    // mapSettingsMoveSources); a source with no store had none to import.
    for (const host of new Set(sources.map((source) => source.host))) {
      try {
        await writeSettingsImportRecord(
          paths.target,
          host as SettingsMoveStartupOptions['host'],
          authority,
        )
      } catch {
        // That host checks its store against the file at its next start.
      }
    }
    return result('user-file', move.outcome, move)
  }
  if (move.outcome === 'failed' || move.outcome === 'busy')
    warn(
      `Settings move ${move.outcome} for ${paths.target}; keeping legacy settings until the next start.`,
    )
  const mode = await resolveSettingsMode(paths, authority)
  // Another start published the file first: adopt it only after the same
  // import check as any later start.
  if (mode === 'user-file') return startOnFile(move.outcome, move)
  return result(mode, move.outcome, move)
}
