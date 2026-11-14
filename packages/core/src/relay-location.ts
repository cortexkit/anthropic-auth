import { lstat } from 'node:fs/promises'
import { join } from 'node:path'

import { ACCOUNT_FILE_NAME, ACCOUNT_STATE_FILE_NAME } from './accounts.ts'
import { accountHome } from './gateway.ts'
import { logger } from './logger.ts'
import { nativeVaultPaths } from './native-vault-paths.ts'
import {
  canonicalPath,
  type NativePoolPaths,
  resolveNativePoolPaths,
} from './pool-paths.ts'
import { RELAY_PROXY_REFUSAL, relayProxyApplies } from './relay.ts'
import {
  LEGACY_STATE_LAYOUT,
  processStateLayout,
  type StateLayout,
} from './state-layout-paths.ts'

/**
 * Where the relay may come from.
 *
 * A relay's URL is read from the selected account store's settings file and
 * its token from that store's runtime file, and every model request is then
 * posted to that URL with the account's bearer inside. Environment variables
 * (OPENCODE_ANTHROPIC_AUTH_FILE, OPENCODE_CONFIG_DIR, XDG_CONFIG_HOME, HOME,
 * PI_ANTHROPIC_AUTH_FILE, PI_CODING_AGENT_DIR and others) can move that store,
 * and a repository's `.env` can set them. In vault and Thalamus-hosted mode
 * the bearer does not live in the store, so a moved store could name a relay
 * that receives the user's real bearer. The relay is therefore honoured only
 * when both files are the ones of the host's default store for the operating
 * system account, found from the account database and never from the
 * environment:
 *
 * - OpenCode: `<home>/.config/opencode/anthropic-auth.json`, with its files
 *   wherever this process's state-layout decision put them.
 * - Pi: `<home>/.pi/agent/anthropic-auth.json`.
 *
 * On Windows `<home>` is the user's profile folder (`%USERPROFILE%`).
 *
 * The store's own relay files must be regular files: a selected settings or
 * runtime file whose last path component is a symbolic link is treated as
 * not in the default place, because the link could be repointed after the
 * check. The selected files are resolved again on every check; only the
 * default store's resolved paths are cached.
 */

/** The Status line, and the reason, when a configured relay is not used. */
export const RELAY_IGNORED_NOTE =
  'Relay ignored: account settings are not in their default location'

/** Why saving a relay is refused when the account store is elsewhere. */
export const RELAY_SAVE_REFUSAL =
  'Relay not saved: account settings are not in their default location'

/**
 * The Status line, and the reason, when a configured relay is not used
 * because the operating system account's home folder could not be found, so
 * the default place is unknown.
 */
export const RELAY_HOME_UNKNOWN_NOTE =
  "Relay ignored: the operating system account's home folder could not be found"

/** Why saving a relay is refused when the account's home is unknown. */
export const RELAY_SAVE_HOME_UNKNOWN_REFUSAL =
  "Relay not saved: the operating system account's home folder could not be found"

/**
 * Where the selected store is: its default place, somewhere else, or unknown
 * because the operating system account's home folder could not be found.
 */
export type RelayLocation = 'default' | 'elsewhere' | 'home-unknown'

/**
 * Test-only escape hatch for the relay location check.
 *
 * Test suites keep their account stores in temporary folders chosen with
 * environment variables, so no test store is ever in the operating system
 * account's default place. Test preloads set this symbol on `globalThis` to
 * `'unchecked'`, which skips only the relay location check (never the
 * gateway's), or to a function returning the home folder to use in place of
 * the account lookup. It is deliberately not an environment variable: a
 * repository's `.env` could set one. Only code already running in the process
 * can set this symbol, and no shipped code does.
 */
export const TEST_RELAY_ACCOUNT_HOME_KEY = Symbol.for(
  'cortexkit.anthropic-auth.test-only.relay-account-home',
)

type TestAccountHome =
  | 'unchecked'
  | (() => string | undefined | Promise<string | undefined>)

function testAccountHome(): TestAccountHome | undefined {
  const value = (globalThis as Record<symbol, unknown>)[
    TEST_RELAY_ACCOUNT_HOME_KEY
  ]
  return value === 'unchecked' || typeof value === 'function'
    ? (value as TestAccountHome)
    : undefined
}

/** The two files a relay is read from: settings (URL) and runtime (token). */
export interface RelayStoreFiles {
  readonly config: string
  readonly runtime: string
}

export interface RelayStoreSelection {
  readonly local: RelayStoreFiles
  readonly vault: RelayStoreFiles
}

/** The folder of `host`'s default store under `home`. */
function defaultStoreDir(host: 'opencode' | 'pi', home: string): string {
  return host === 'opencode'
    ? join(home, '.config', 'opencode')
    : join(home, '.pi', 'agent')
}

/**
 * The default store's relay files for `host` under `home`, resolved exactly
 * as the host resolves a store with no environment override: the same file
 * names and, for OpenCode, `layout`, which defaults to the state layout this
 * process decided for that folder. Pi's files never move, so Pi always uses
 * the legacy layout.
 */
export async function defaultRelayStoreFiles(
  host: 'opencode' | 'pi',
  home: string,
  layout?: StateLayout,
): Promise<RelayStoreSelection> {
  const dir = defaultStoreDir(host, home)
  const local: NativePoolPaths = await resolveNativePoolPaths(
    join(dir, ACCOUNT_FILE_NAME),
    join(dir, ACCOUNT_STATE_FILE_NAME),
    host === 'pi' ? LEGACY_STATE_LAYOUT : layout,
  )
  const vault = nativeVaultPaths(local)
  return {
    local: { config: local.config, runtime: local.runtime },
    vault: { config: vault.config, runtime: vault.runtime },
  }
}

/**
 * Remembers a resolution that succeeded, keyed by text; a failed one is
 * forgotten, so the next check tries again.
 */
function remembered<T>(
  cache: Map<string, Promise<T>>,
  key: string,
  compute: () => Promise<T>,
): Promise<T> {
  let value = cache.get(key)
  if (!value) {
    value = compute()
    value.catch(() => cache.delete(key))
    cache.set(key, value)
  }
  return value
}

// The default account file's canonical path, per host and home folder. The
// state-layout decision for the default store is recorded under it.
const defaultAccountFiles = new Map<string, Promise<string>>()

// The default store's canonical files, per host, home folder and the layout
// decided for it. A layout decided later in the process is a new key, so a
// default resolved before that decision is never reused after it.
const defaultForms = new Map<string, Promise<RelayStoreSelection>>()

async function defaultCanonicalFiles(
  host: 'opencode' | 'pi',
  home: string,
): Promise<RelayStoreSelection> {
  let layout: StateLayout = LEGACY_STATE_LAYOUT
  if (host === 'opencode') {
    const accountFile = await remembered(
      defaultAccountFiles,
      JSON.stringify([host, home]),
      () => canonicalPath(join(defaultStoreDir(host, home), ACCOUNT_FILE_NAME)),
    )
    layout = processStateLayout(accountFile)
  }
  return remembered(
    defaultForms,
    JSON.stringify([
      host,
      home,
      layout.kind === 'state-home' ? layout.dir : layout.kind,
    ]),
    async () => {
      const { local, vault } = await defaultRelayStoreFiles(host, home, layout)
      return {
        local: await canonicalFiles(local),
        vault: await canonicalFiles(vault),
      }
    },
  )
}

async function canonicalFiles(
  files: RelayStoreFiles,
): Promise<RelayStoreFiles> {
  const [config, runtime] = await Promise.all([
    canonicalPath(files.config),
    canonicalPath(files.runtime),
  ])
  return { config, runtime }
}

/** True when the last component of `path` is a symbolic link. */
async function leafIsLink(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isSymbolicLink()
  } catch (error) {
    // A file not created yet is no link; any other failure counts as one, so
    // the check fails closed.
    return !(
      error instanceof Error &&
      'code' in error &&
      (error.code === 'ENOENT' || error.code === 'ENOTDIR')
    )
  }
}

/**
 * The selected files resolved now, never from a cache, or undefined when one
 * of them is a symbolic link.
 */
async function selectedCanonicalFiles(
  files: RelayStoreFiles,
): Promise<RelayStoreFiles | undefined> {
  const links = await Promise.all([
    leafIsLink(files.config),
    leafIsLink(files.runtime),
  ])
  if (links.some(Boolean)) return undefined
  return canonicalFiles(files)
}

const warnedStores = new Set<string>()

export interface RelayLocationCheck {
  /**
   * Where `mode`'s store is; its relay may be used only at 'default'. The
   * account lookup and the default store's paths are cached; the selected
   * store's two files are checked and resolved again on every call.
   */
  locate(mode: 'local' | 'claustrum'): Promise<RelayLocation>
  /**
   * Like `locate`, and at 'default' also the default store's canonical files
   * the selected ones matched. A relay is read through those files, not the
   * selected path text, so a folder swapped after the check cannot redirect
   * the read. `files` is absent only when tests skip the check.
   */
  resolve(
    mode: 'local' | 'claustrum',
  ): Promise<{ location: RelayLocation; files?: RelayStoreFiles }>
  /** Starts the lookups early, off the request path. */
  prepare(): void
  /** Records that a configured relay was ignored; logs once per store. */
  ignored(
    mode: 'local' | 'claustrum',
    location: Exclude<RelayLocation, 'default'>,
  ): void
  /**
   * Records that the last read found no ignored relay, and the URL of the
   * relay it found in use, if any.
   */
  clear(relayUrl?: string): void
  /**
   * The Status lines: why a configured relay is ignored, or that the relay
   * in use is refused because a proxy setting would carry it; or none.
   */
  statusNotes(env?: Readonly<Record<string, string | undefined>>): string[]
}

/** The relay location check for one runtime's local and vault stores. */
export function createRelayLocationCheck(
  host: 'opencode' | 'pi',
  selected: RelayStoreSelection,
): RelayLocationCheck {
  let ignoredNow: Exclude<RelayLocation, 'default'> | undefined
  let relayInUse: string | undefined
  async function resolve(
    mode: 'local' | 'claustrum',
  ): Promise<{ location: RelayLocation; files?: RelayStoreFiles }> {
    const hook = testAccountHome()
    if (hook === 'unchecked') return { location: 'default' }
    let home: string | undefined
    try {
      home = hook ? await hook() : await accountHome()
    } catch {
      home = undefined
    }
    if (!home) return { location: 'home-unknown' }
    try {
      const files = mode === 'claustrum' ? selected.vault : selected.local
      const [defaults, own] = await Promise.all([
        defaultCanonicalFiles(host, home),
        selectedCanonicalFiles(files),
      ])
      const expected = mode === 'claustrum' ? defaults.vault : defaults.local
      return own &&
        own.config === expected.config &&
        own.runtime === expected.runtime
        ? { location: 'default', files: expected }
        : { location: 'elsewhere' }
    } catch {
      return { location: 'elsewhere' }
    }
  }
  async function locate(mode: 'local' | 'claustrum'): Promise<RelayLocation> {
    return (await resolve(mode)).location
  }
  return {
    locate,
    resolve,
    prepare() {
      if (testAccountHome() === 'unchecked') return
      void locate('local').catch(() => {})
      void locate('claustrum').catch(() => {})
    },
    ignored(mode, location) {
      ignoredNow = location
      relayInUse = undefined
      const store =
        mode === 'claustrum' ? selected.vault.config : selected.local.config
      const key = JSON.stringify([store, location])
      if (warnedStores.has(key)) return
      warnedStores.add(key)
      logger.warn(
        'relay',
        location === 'home-unknown'
          ? "a relay is configured, but the operating system account's home folder could not be found, so it is ignored and requests go directly to Anthropic"
          : 'a relay is configured, but the account settings are not in their default location, so it is ignored and requests go directly to Anthropic',
      )
    },
    clear(relayUrl) {
      ignoredNow = undefined
      relayInUse = relayUrl
    },
    statusNotes(env = process.env) {
      if (ignoredNow === 'home-unknown') return [RELAY_HOME_UNKNOWN_NOTE]
      if (ignoredNow === 'elsewhere') return [RELAY_IGNORED_NOTE]
      return relayInUse && relayProxyApplies(relayInUse, env)
        ? [RELAY_PROXY_REFUSAL]
        : []
    },
  }
}
