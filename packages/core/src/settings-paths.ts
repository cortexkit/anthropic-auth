import {
  isAbsoluteForPlatform,
  settingsFilePath,
} from '@cortexkit/common-auth/settings'

import {
  ACCOUNT_FILE_NAME,
  ACCOUNT_STATE_FILE_NAME,
  getAccountStatePath,
  getAccountStoragePath,
  getOpenCodeConfigDir,
} from './accounts.ts'
import { logger } from './logger.ts'
import {
  type PathResolutionOptions,
  resolvePathOptions,
} from './path-options.ts'
import { canonicalPath } from './pool-paths.ts'

export type SettingsHost = 'opencode' | 'pi'

export interface SettingsPathOptions extends PathResolutionOptions {
  warn?: (message: string) => void
}

export interface SettingsStorePaths {
  account: string
  state: string
}

export interface SettingsPaths {
  /** The configured filename; retain it for watches and writes. */
  target: string
  marker: string
  separate: boolean
  sourceRule: 'default' | 'own'
  /** Only the acting process's stores, including its overrides. */
  own: SettingsStorePaths
  /** Naming default sources does not read files from the other settings host. */
  defaults: Record<SettingsHost, SettingsStorePaths>
}

const ignoredOverrides = new WeakMap<object, Set<string>>()

function settingsOverride(options: SettingsPathOptions): string | undefined {
  const { env, platform } = resolvePathOptions(options)
  const value = env.ANTHROPIC_AUTH_SETTINGS_FILE
  if (value === undefined) return undefined
  if (isAbsoluteForPlatform(value, platform)) return value
  let logged = ignoredOverrides.get(env)
  if (!logged) {
    logged = new Set()
    ignoredOverrides.set(env, logged)
  }
  if (!logged.has(value)) {
    logged.add(value)
    const message =
      'ANTHROPIC_AUTH_SETTINGS_FILE is empty or relative; ignoring it (an absolute path is required).'
    if (options.warn) options.warn(message)
    else logger.warn('settings', message)
  }
  return undefined
}

/** Match the shared settings API: a relative XDG config home is unset. */
function storeOptions(options: PathResolutionOptions) {
  const context = resolvePathOptions(options)
  const xdg = context.env.XDG_CONFIG_HOME
  const env: NodeJS.ProcessEnv = {
    ...context.env,
    XDG_CONFIG_HOME:
      xdg && isAbsoluteForPlatform(xdg, context.platform) ? xdg : undefined,
  }
  return {
    ...context,
    env,
  }
}

export function getSettingsFilePath(options: SettingsPathOptions = {}): string {
  const context = resolvePathOptions(options)
  return settingsFilePath({
    plugin: 'anthropic-auth',
    override: settingsOverride(options),
    env: context.env,
    homedir: context.home,
    platform: context.platform,
  })
}

/** Pi's extension directory precedence, independent of OpenCode's overrides. */
export function getPiAgentDir(options: PathResolutionOptions = {}): string {
  const { env, home, paths } = resolvePathOptions(options)
  return (
    env.PI_CODING_AGENT_DIR?.trim() ||
    env.PI_AGENT_DIR?.trim() ||
    paths.join(home, '.pi', 'agent')
  )
}

export function getSettingsStorePaths(
  host: SettingsHost,
  options: PathResolutionOptions = {},
): SettingsStorePaths {
  const context = storeOptions(options)
  if (host === 'opencode') {
    const account = getAccountStoragePath(context)
    return { account, state: getAccountStatePath(account, context) }
  }
  const account =
    context.env.PI_ANTHROPIC_AUTH_FILE?.trim() ||
    context.paths.join(getPiAgentDir(context), ACCOUNT_FILE_NAME)
  // Pi uses the sibling state path, never OpenCode's state override.
  return {
    account,
    state: getAccountStatePath(account, { ...context, env: {} }),
  }
}

export function getDefaultSettingsStorePaths(
  host: SettingsHost,
  options: PathResolutionOptions = {},
): SettingsStorePaths {
  const context = storeOptions(options)
  const directory =
    host === 'opencode'
      ? getOpenCodeConfigDir(
          { XDG_CONFIG_HOME: context.env.XDG_CONFIG_HOME },
          context.home,
          context,
        )
      : context.paths.join(context.home, '.pi', 'agent')
  return {
    account: context.paths.join(directory, ACCOUNT_FILE_NAME),
    state: context.paths.join(directory, ACCOUNT_STATE_FILE_NAME),
  }
}

export async function hasPrivateSettingsConfigHome(
  options: PathResolutionOptions = {},
): Promise<boolean> {
  const context = storeOptions(options)
  const xdg = context.env.XDG_CONFIG_HOME
  if (!xdg) return false
  return (
    (await canonicalPath(xdg, context)) !==
    (await canonicalPath(context.paths.join(context.home, '.config'), context))
  )
}

/** Compare this host's account and state paths against its XDG-aware defaults. */
export async function isSeparateSettingsInstall(
  host: SettingsHost,
  options: SettingsPathOptions = {},
): Promise<boolean> {
  if (settingsOverride(options)) return false
  const own = getSettingsStorePaths(host, options)
  const defaults = getDefaultSettingsStorePaths(host, options)
  for (const key of ['account', 'state'] as const) {
    if (
      (await canonicalPath(own[key], options)) !==
      (await canonicalPath(defaults[key], options))
    )
      return true
  }
  return false
}

/** Resolve once at startup; callers keep the result off the request path. */
export async function resolveSettingsPaths(
  host: SettingsHost,
  options: SettingsPathOptions = {},
): Promise<SettingsPaths> {
  const target = getSettingsFilePath(options)
  return {
    target,
    marker: `${target}.moved`,
    separate: await isSeparateSettingsInstall(host, options),
    sourceRule:
      settingsOverride(options) || (await hasPrivateSettingsConfigHome(options))
        ? 'own'
        : 'default',
    own: getSettingsStorePaths(host, options),
    defaults: {
      opencode: getDefaultSettingsStorePaths('opencode', options),
      pi: getDefaultSettingsStorePaths('pi', options),
    },
  }
}
