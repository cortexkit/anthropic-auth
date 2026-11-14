import { lstat, readFile } from 'node:fs/promises'
import type { MoveSource } from '@cortexkit/common-auth/settings'

import { logger } from './logger.ts'
import { readNativeEnrollmentMode } from './native-enrollment-authority.ts'
import { nativeVaultPaths } from './native-vault-paths.ts'
import { resolvePathOptions } from './path-options.ts'
import {
  canonicalPath,
  type NativePoolPaths,
  resolveNativePoolPaths,
} from './pool-paths.ts'
import { nativePoolStoreLocks } from './pool-store.ts'
import { createSettingsMoveSource } from './settings-move-source.ts'
import {
  hasPrivateSettingsConfigHome,
  resolveSettingsPaths,
  type SettingsHost,
  type SettingsPathOptions,
  type SettingsPaths,
} from './settings-paths.ts'
import { legacySettingsProtection } from './settings-protection-legacy.ts'
import type { SettingsProtectionValues } from './settings-service.ts'
import {
  LEGACY_STATE_LAYOUT,
  readStateLayoutMarker,
  resolveStateHomeTarget,
  type StateLayout,
} from './state-layout-paths.ts'

export interface SettingsMoveSourcesOptions extends SettingsPathOptions {
  host: SettingsHost
  paths?: SettingsPaths
  /** The running host's already resolved paths retain its startup layout decision. */
  ownPoolPaths?: NativePoolPaths
  /** Initialize only this runtime's vault settings, including first-read seeding. */
  initializeVaultSettings: () => Promise<void>
  readMode?: typeof readNativeEnrollmentMode
  log?: { warn: (message: string) => void }
  /** Inspect existing sources without seeding a vault or changing legacy state. */
  inspectOnly?: boolean
}

export type SettingsMoveSourcesResult =
  | { status: 'ready'; sources: MoveSource[] }
  | { status: 'separate'; sources: [] }
  | {
      status: 'unavailable'
      sources: []
      host: SettingsHost
      reason:
        | 'custody-unreadable'
        | 'seeding-failed'
        | 'paths-unreadable'
        | 'vault-unseeded'
      cause: unknown
    }

const loggedSkips = new Set<string>()

/**
 * True only when neither the peer's default pool config nor its vault config
 * exists, so skipping it loses nothing. An unreadable layout or file is not
 * absence.
 */
async function peerStoreAbsent(
  host: SettingsHost,
  store: { account: string; state: string },
  options: SettingsPathOptions,
): Promise<boolean> {
  try {
    const pool = await resolveNativePoolPaths(
      store.account,
      store.state,
      await peerLayout(host, options),
    )
    for (const config of [pool.config, nativeVaultPaths(pool).config]) {
      try {
        await lstat(config)
        return false
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false
      }
    }
    return true
  } catch {
    return false
  }
}

/** Observe a peer's layout without moving files or registering a process for that host. */
async function peerLayout(
  host: SettingsHost,
  options: SettingsPathOptions,
): Promise<StateLayout> {
  // Pi never relocates its dataset; only OpenCode has a state-home layout.
  if (host === 'pi') return LEGACY_STATE_LAYOUT
  const context = resolvePathOptions(options)
  const xdg = context.env.XDG_CONFIG_HOME
  const target = resolveStateHomeTarget({
    home: context.home,
    env: {
      XDG_CONFIG_HOME: xdg && context.paths.isAbsolute(xdg) ? xdg : undefined,
      XDG_STATE_HOME: context.env.XDG_STATE_HOME,
    },
  })
  if (!target) return LEGACY_STATE_LAYOUT
  const marker = await readStateLayoutMarker(target.dir)
  if (!marker) return LEGACY_STATE_LAYOUT
  if (
    marker.identity !== target.identity ||
    marker.sub !== (await canonicalPath(target.dir, context))
  )
    throw new Error('The peer state layout belongs to another dataset')
  if (marker.phase === 'committed')
    return { kind: 'state-home', dir: marker.sub }
  if (
    marker.phase === 'rolled-back' ||
    (marker.phase === 'restored' && marker.restore?.cleanup === 'done')
  )
    return LEGACY_STATE_LAYOUT
  throw new Error('The peer state layout transition is unfinished')
}

/**
 * Read the other host's legacy protection for recreating a missing settings
 * file, from the store a default-target move would read for it: its default
 * store, through its current custody and state layout, without seeding a
 * vault, taking locks or writing anything. Under the default target, a local
 * store that doesn't exist returns undefined: that host never ran here and
 * has no set to keep.
 *
 * Anything else that can't name or read the peer's set throws, so the
 * caller treats it as unknown and never as "no set":
 * - a store that exists but can't be read, including an unreadable custody
 *   or layout, and vault settings that were never seeded;
 * - a private XDG_CONFIG_HOME, for which a move reads only its own store;
 * - the peer's own path overrides set in this process, since the peer may
 *   run with them or without them;
 * - under an explicit target, a default store that doesn't exist: a peer
 *   sharing that file may keep a private store this process can't see.
 */
export async function readPeerLegacySettingsProtection(
  options: SettingsPathOptions & {
    host: SettingsHost
    readMode?: typeof readNativeEnrollmentMode
  },
): Promise<SettingsProtectionValues | undefined> {
  if (await hasPrivateSettingsConfigHome(options))
    throw new Error(
      'A move under a private config home reads only its own store, so the peer store is unknown',
    )
  const paths = await resolveSettingsPaths(options.host, options)
  // For the peer host, `own` is where this environment puts its store.
  for (const key of ['account', 'state'] as const)
    if (
      (await canonicalPath(paths.own[key], options)) !==
      (await canonicalPath(paths.defaults[options.host][key], options))
    )
      throw new Error(
        'The peer path overrides set here leave its store unknown',
      )
  const explicitTarget = paths.sourceRule === 'own'
  const store = paths.defaults[options.host]
  const mode = await (options.readMode ?? readNativeEnrollmentMode)(
    options.host,
    enrollmentEnv(options),
  )
  const pool = await resolveNativePoolPaths(
    store.account,
    store.state,
    await peerLayout(options.host, options),
  )
  const selected = mode === 'claustrum' ? nativeVaultPaths(pool) : pool
  let text: string
  try {
    text = await readFile(selected.config, 'utf8')
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code === 'ENOENT' &&
      mode === 'local' &&
      !explicitTarget
    )
      return undefined
    throw error
  }
  const stored: unknown = JSON.parse(text)
  if (!stored || typeof stored !== 'object' || Array.isArray(stored))
    throw new Error('The legacy settings store is not a settings map')
  return legacySettingsProtection(
    stored as Record<string, unknown>,
    options.host,
    mode,
  )
}

/**
 * Read this host's own legacy protection, through its current custody, to
 * check whether a settings file it did not move holds it. Vault settings
 * that were never seeded are read from the local store they would be seeded
 * from. A store that doesn't exist returns undefined; anything that exists
 * but can't be read throws. Takes no locks and writes nothing.
 */
export async function readOwnLegacySettingsProtection(
  options: SettingsMoveSourcesOptions,
): Promise<SettingsProtectionValues | undefined> {
  const paths =
    options.paths ?? (await resolveSettingsPaths(options.host, options))
  const mode = await (options.readMode ?? readNativeEnrollmentMode)(
    options.host,
    enrollmentEnv(options),
  )
  const pool =
    options.ownPoolPaths ??
    (await resolveNativePoolPaths(paths.own.account, paths.own.state))
  const read = async (config: string) => {
    try {
      return await readFile(config, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }
  const text =
    (mode === 'claustrum'
      ? await read(nativeVaultPaths(pool).config)
      : undefined) ?? (await read(pool.config))
  if (text === undefined) return undefined
  const stored: unknown = JSON.parse(text)
  if (!stored || typeof stored !== 'object' || Array.isArray(stored))
    throw new Error('The legacy settings store is not a settings map')
  return legacySettingsProtection(
    stored as Record<string, unknown>,
    options.host,
    mode,
  )
}

function enrollmentEnv(options: SettingsPathOptions) {
  const context = resolvePathOptions(options)
  return {
    ...context.env,
    // Enrollment's legacy resolver uses os.homedir(); carry the supplied home
    // through its state-root input instead, so sandboxed callers stay isolated.
    XDG_STATE_HOME:
      context.env.XDG_STATE_HOME ||
      context.paths.join(context.home, '.local', 'state'),
  }
}

/**
 * Prepare the common-auth mover's sources, not a startup or authority decision.
 * An unavailable own source must keep this start in legacy mode; the caller logs
 * that result once and must not call the mover or publish a marker.
 */
export async function prepareSettingsMoveSources(
  options: SettingsMoveSourcesOptions,
): Promise<SettingsMoveSourcesResult> {
  const paths =
    options.paths ?? (await resolveSettingsPaths(options.host, options))
  if (paths.separate) return { status: 'separate', sources: [] }
  const env = enrollmentEnv(options)
  const warn = (message: string) =>
    options.log ? options.log.warn(message) : logger.warn('settings', message)
  const skip = (host: SettingsHost, path: string, reason: string) => {
    const message = `Settings move skipped ${host} source ${path}: ${reason}.`
    const key = `${paths.target}\0${message}`
    if (loggedSkips.has(key)) return
    loggedSkips.add(key)
    warn(message)
  }
  const readMode = options.readMode ?? readNativeEnrollmentMode
  let ownMode: 'local' | 'claustrum'
  try {
    ownMode = await readMode(options.host, env)
  } catch (cause) {
    return {
      status: 'unavailable',
      sources: [],
      host: options.host,
      reason: 'custody-unreadable',
      cause,
    }
  }
  if (ownMode === 'claustrum' && !options.inspectOnly) {
    try {
      // This must finish before common-auth reads the source under its locks.
      await options.initializeVaultSettings()
    } catch (cause) {
      return {
        status: 'unavailable',
        sources: [],
        host: options.host,
        reason: 'seeding-failed',
        cause,
      }
    }
  }
  const sources: MoveSource[] = []
  // A default-target move must carry both hosts' settings. When an existing
  // peer store can't be read safely, preparation returns unavailable: the
  // start publishes nothing and the peer's settings move at a later start
  // instead of being lost. Inspection for diagnostics keeps skipping it.
  const peerUnavailable = (
    host: SettingsHost,
    reason: Extract<
      SettingsMoveSourcesResult,
      { status: 'unavailable' }
    >['reason'],
    cause: unknown,
  ): SettingsMoveSourcesResult | undefined =>
    options.inspectOnly
      ? undefined
      : { status: 'unavailable', sources: [], host, reason, cause }
  // common-auth uses source order to choose the default for host disagreements.
  for (const host of ['opencode', 'pi'] as const) {
    const own = host === options.host
    if (!own && paths.sourceRule === 'own') continue
    const store = own ? paths.own : paths.defaults[host]
    let mode: 'local' | 'claustrum'
    try {
      mode = own ? ownMode : await readMode(host, env)
    } catch (cause) {
      if (!(await peerStoreAbsent(host, store, options))) {
        const refused = peerUnavailable(host, 'custody-unreadable', cause)
        if (refused) return refused
      }
      skip(host, store.account, 'custody mode is unreadable')
      continue
    }
    try {
      const pool =
        own && options.ownPoolPaths
          ? options.ownPoolPaths
          : await resolveNativePoolPaths(
              store.account,
              store.state,
              own ? undefined : await peerLayout(host, options),
            )
      const selected = mode === 'claustrum' ? nativeVaultPaths(pool) : pool
      try {
        await lstat(selected.config)
      } catch (error) {
        // Leave unreadable files to the mover: unlike absence, a read failure
        // aborts the whole publication rather than silently losing settings.
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          skip(
            host,
            selected.config,
            mode === 'claustrum'
              ? 'vault settings have not been seeded'
              : 'file is missing',
          )
          if (!own && mode === 'claustrum') {
            // A peer enrolled in the vault that never ran has neither vault
            // settings nor a local store to seed them from: nothing to lose.
            if (await peerStoreAbsent(host, store, options)) continue
            const refused = peerUnavailable(host, 'vault-unseeded', error)
            if (refused) return refused
            continue
          }
        }
      }
      sources.push(
        createSettingsMoveSource({
          host,
          path: selected.config,
          locks: [...nativePoolStoreLocks(selected)],
          log: { warn },
        }),
      )
    } catch (cause) {
      if (own)
        return {
          status: 'unavailable',
          sources: [],
          host,
          reason: 'paths-unreadable',
          cause,
        }
      // A peer layout that is not safely observable cannot name writer locks.
      const refused = peerUnavailable(host, 'paths-unreadable', cause)
      if (refused) return refused
      skip(host, store.account, 'store paths or state layout are unreadable')
    }
  }
  return { status: 'ready', sources }
}
