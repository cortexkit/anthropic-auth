import {
  type MoveOutcome,
  type MoveResult,
  moveSettingsOnce,
} from '@cortexkit/common-auth/settings'

import { logger } from './logger.ts'
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
} from './settings-move-fence.ts'
import { mapSettingsMoveSources } from './settings-move-map.ts'
import {
  prepareSettingsMoveSources,
  type SettingsMoveSourcesOptions,
} from './settings-move-sources.ts'
import { resolveSettingsPaths, type SettingsPaths } from './settings-paths.ts'

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
  /** Legacy mode still needs the user-file watch to detect another host's move. */
  mayOpenService: boolean
  outcome: MoveOutcome | 'marker-present' | 'source-unavailable'
  move?: MoveResult
}

const logged = new Set<string>()

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
    return result(
      'user-file',
      (await hasSettingsMoveMarker(paths.target, authority))
        ? 'marker-present'
        : 'done-already',
    )
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
      warn(`Settings move unavailable for ${options.host}: ${prepared.reason}.`)
    return result('legacy', 'source-unavailable')
  }
  const move = await (options.dependencies?.move ?? moveSettingsOnce)({
    definition: settingsDefinition,
    target: paths.target,
    separateInstall: false,
    sources: prepared.sources,
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
