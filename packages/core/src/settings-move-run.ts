import { readFile } from 'node:fs/promises'
import {
  type MoveOutcome,
  type MoveResult,
  moveSettingsOnce,
} from '@cortexkit/common-auth/settings'

import { HOLDER_LOCK_NAME } from './holder-registry.ts'
import { logger } from './logger.ts'
import {
  differingLegacySettings,
  holdsMovedSettings,
  settingsNotImportedText,
} from './settings-authority.ts'
import { settingsDefinition } from './settings-definition.ts'
import {
  hasSettingsMoveMarker,
  resolveSettingsMode,
  type SettingsMode,
  type SettingsModeOptions,
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
  type SettingsMoveSourcesOptions,
} from './settings-move-sources.ts'
import { resolveSettingsPaths, type SettingsPaths } from './settings-paths.ts'
import { openSettingsService } from './settings-service.ts'

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
  outcome: MoveOutcome | 'marker-present' | 'source-unavailable'
  move?: MoveResult
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
    mayOpenService: mode !== 'separate',
    outcome,
    ...(move ? { move } : {}),
  })

  if (paths.separate) return result('separate', 'separate-install')
  if ((await resolveSettingsMode(paths, authority)) === 'user-file') {
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
    return result('user-file', marked ? 'marker-present' : 'done-already')
  }

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
    return result('user-file', move.outcome, move)
  }
  if (move.outcome === 'failed' || move.outcome === 'busy')
    warn(
      `Settings move ${move.outcome} for ${paths.target}; keeping legacy settings until the next start.`,
    )
  return result(await resolveSettingsMode(paths, authority), move.outcome, move)
}
