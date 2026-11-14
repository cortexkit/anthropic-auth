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
import { LEGACY_STATE_LAYOUT } from './state-layout-paths.ts'

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
 */

/** The Status line, and the reason, when a configured relay is not used. */
export const RELAY_IGNORED_NOTE =
  'Relay ignored: account settings are not in their default location'

/** Why saving a relay is refused when the account store is elsewhere. */
export const RELAY_SAVE_REFUSAL =
  'Relay not saved: account settings are not in their default location'

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

/**
 * The default store's relay files for `host` under `home`, resolved exactly
 * as the host resolves a store with no environment override: the same file
 * names and, for OpenCode, the state layout this process decided for that
 * folder. Pi's files never move, so Pi always uses the legacy layout.
 */
export async function defaultRelayStoreFiles(
  host: 'opencode' | 'pi',
  home: string,
): Promise<RelayStoreSelection> {
  const dir =
    host === 'opencode'
      ? join(home, '.config', 'opencode')
      : join(home, '.pi', 'agent')
  const local: NativePoolPaths = await resolveNativePoolPaths(
    join(dir, ACCOUNT_FILE_NAME),
    join(dir, ACCOUNT_STATE_FILE_NAME),
    host === 'pi' ? LEGACY_STATE_LAYOUT : undefined,
  )
  const vault = nativeVaultPaths(local)
  return {
    local: { config: local.config, runtime: local.runtime },
    vault: { config: vault.config, runtime: vault.runtime },
  }
}

// Canonical forms, cached per process by path text. A different path is a
// different key, so changing paths never reuses a stale entry.
const canonicalForms = new Map<string, Promise<string>>()

function canonicalForm(path: string): Promise<string> {
  let form = canonicalForms.get(path)
  if (!form) {
    form = canonicalPath(path)
    // A failed resolution is not cached, so a later check retries it.
    form.catch(() => canonicalForms.delete(path))
    canonicalForms.set(path, form)
  }
  return form
}

// The default store's canonical files, per host and home folder.
const defaultForms = new Map<string, Promise<RelayStoreSelection>>()

function defaultCanonicalFiles(
  host: 'opencode' | 'pi',
  home: string,
): Promise<RelayStoreSelection> {
  const key = JSON.stringify([host, home])
  let files = defaultForms.get(key)
  if (!files) {
    files = defaultRelayStoreFiles(host, home).then(
      async ({ local, vault }) => ({
        local: await canonicalFiles(local),
        vault: await canonicalFiles(vault),
      }),
    )
    files.catch(() => defaultForms.delete(key))
    defaultForms.set(key, files)
  }
  return files
}

async function canonicalFiles(
  files: RelayStoreFiles,
): Promise<RelayStoreFiles> {
  const [config, runtime] = await Promise.all([
    canonicalForm(files.config),
    canonicalForm(files.runtime),
  ])
  return { config, runtime }
}

const warnedStores = new Set<string>()

export interface RelayLocationCheck {
  /**
   * True when `mode`'s store is the default store, so its relay may be used.
   * False when it is elsewhere or the account lookup failed. Every lookup and
   * path resolution behind it is cached, so after the first call this does
   * no file or process I/O.
   */
  atDefault(mode: 'local' | 'claustrum'): Promise<boolean>
  /** Starts the lookups early, off the request path. */
  prepare(): void
  /** Records that a configured relay was ignored; logs once per store. */
  ignored(mode: 'local' | 'claustrum'): void
  /** Records that the last read found no ignored relay. */
  clear(): void
  /** The Status lines: the ignored-relay note, or none. */
  statusNotes(): string[]
}

/** The relay location check for one runtime's local and vault stores. */
export function createRelayLocationCheck(
  host: 'opencode' | 'pi',
  selected: RelayStoreSelection,
): RelayLocationCheck {
  let ignoredNow = false
  async function atDefault(mode: 'local' | 'claustrum'): Promise<boolean> {
    const hook = testAccountHome()
    if (hook === 'unchecked') return true
    try {
      const home = hook ? await hook() : await accountHome()
      if (!home) return false
      const files = mode === 'claustrum' ? selected.vault : selected.local
      const [defaults, own] = await Promise.all([
        defaultCanonicalFiles(host, home),
        canonicalFiles(files),
      ])
      const expected = mode === 'claustrum' ? defaults.vault : defaults.local
      return own.config === expected.config && own.runtime === expected.runtime
    } catch {
      return false
    }
  }
  return {
    atDefault,
    prepare() {
      if (testAccountHome() === 'unchecked') return
      void atDefault('local').catch(() => {})
      void atDefault('claustrum').catch(() => {})
    },
    ignored(mode) {
      ignoredNow = true
      const key =
        mode === 'claustrum' ? selected.vault.config : selected.local.config
      if (warnedStores.has(key)) return
      warnedStores.add(key)
      logger.warn(
        'relay',
        'a relay is configured, but the account settings are not in their default location, so it is ignored and requests go directly to Anthropic',
      )
    },
    clear() {
      ignoredNow = false
    },
    statusNotes() {
      return ignoredNow ? [RELAY_IGNORED_NOTE] : []
    },
  }
}
