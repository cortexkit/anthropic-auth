import { createHash } from 'node:crypto'
import { lstat, mkdir } from 'node:fs/promises'
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
  ensureWindowsOwnerOnlyDirectory,
  type OwnerOnlyOptions,
} from './owner-only.ts'
import {
  type PathResolutionOptions,
  resolvePathOptions,
} from './path-options.ts'
import { canonicalPath } from './pool-paths.ts'
import { anthropicAuthStateRoot } from './state-layout-paths.ts'

export type SettingsHost = 'opencode' | 'pi'

export interface SettingsPathOptions extends PathResolutionOptions {
  warn?: (message: string) => void
}

export interface SettingsStorePaths {
  account: string
  state: string
}

interface SettingsRecordFiles {
  directory: string
  moved: string
  imports: Record<SettingsHost, string>
  applied: string
}

export interface SettingsRecordPaths {
  beside: SettingsRecordFiles
  state?: SettingsRecordFiles
  /** No usable mirror, but its absence was not proved. */
  stateUnavailable?: Error
}

export interface SettingsPaths {
  /** The configured filename; retain it for watches and writes. */
  target: string
  records: SettingsRecordPaths
  separate: boolean
  sourceRule: 'default' | 'own'
  /** Only the acting process's stores, including its overrides. */
  own: SettingsStorePaths
  /** Naming default sources does not read files from the other settings host. */
  defaults: Record<SettingsHost, SettingsStorePaths>
}

/** The configured target is known, but whether it is a separate install is not. */
export class SettingsPathResolutionError extends Error {
  readonly records: SettingsRecordPaths

  constructor(
    readonly target: string,
    beside: SettingsRecordFiles,
    cause: unknown,
  ) {
    super('Could not resolve settings paths', { cause })
    this.records = { beside }
  }
}

function recordFiles(directory: string, prefix: string): SettingsRecordFiles {
  return {
    directory,
    moved: `${prefix}moved`,
    imports: {
      opencode: `${prefix}moved.opencode`,
      pi: `${prefix}moved.pi`,
    },
    applied: `${prefix}applied.json`,
  }
}

const preparedRecords = new WeakMap<SettingsPaths, Promise<SettingsPaths>>()
const warnedMirrors = new Set<string>()
type MirrorOptions = SettingsPathOptions & { ownership?: OwnerOnlyOptions }
const mirrorOptions = new WeakMap<SettingsRecordPaths, MirrorOptions>()

function warnMirrorOnce(key: string, message: string, options?: MirrorOptions) {
  if (warnedMirrors.has(key)) return
  warnedMirrors.add(key)
  if (options?.warn) options.warn(message)
  else logger.warn('settings', message)
}

function warnRefusedFolder(directory: string, options?: MirrorOptions) {
  warnMirrorOnce(
    directory,
    `Cannot use settings record folder "${directory}"; keeping records beside the settings file.`,
    options,
  )
}

async function checkStateFolder(
  directory: string,
  options: MirrorOptions,
  create: boolean,
) {
  const { platform } = resolvePathOptions(options)
  if (
    await ensureWindowsOwnerOnlyDirectory(
      directory,
      { ...options.ownership, platform },
      create,
    )
  )
    return
  if (create) await mkdir(directory, { recursive: true, mode: 0o700 })
  const stat = await lstat(directory).catch((error: NodeJS.ErrnoException) => {
    if (!create && error.code === 'ENOENT') return undefined
    throw error
  })
  if (
    stat &&
    (!stat.isDirectory() ||
      (stat.mode & 0o777) !== 0o700 ||
      (process.getuid && stat.uid !== process.getuid()))
  )
    throw new Error('Settings record directory is not owner-only')
}

/** Check an existing state directory without writing to the optional layout. */
export function prepareSettingsRecordPaths(
  resolved: SettingsPaths,
  options: MirrorOptions,
): Promise<SettingsPaths> {
  const directory = resolved.records.state?.directory
  if (!directory) return Promise.resolve(resolved)
  let prepared = preparedRecords.get(resolved)
  if (!prepared) {
    mirrorOptions.set(resolved.records, options)
    prepared = (async () => {
      try {
        await checkStateFolder(directory, options, false)
        return resolved
      } catch (cause) {
        warnRefusedFolder(directory, options)
        return {
          ...resolved,
          records: {
            beside: resolved.records.beside,
            stateUnavailable: new Error(
              'Settings record folder is unavailable',
              { cause },
            ),
          },
        }
      }
    })()
    preparedRecords.set(resolved, prepared)
  }
  return prepared
}

type MirrorWrite = { path: string; write: () => Promise<void> }
const mirrorBatches = new WeakMap<SettingsRecordPaths, MirrorWrite[]>()
const pendingMirrors = new Set<Promise<void>>()

/** Hold mirror writes until the operation has finished its beside writes. */
export async function withSettingsRecordMirrors<T>(
  records: SettingsRecordPaths,
  operation: (scoped: SettingsRecordPaths) => Promise<T>,
): Promise<T> {
  if (!records.state) return operation(records)
  const scoped = { ...records }
  const options = mirrorOptions.get(records)
  if (options) mirrorOptions.set(scoped, options)
  const writes: MirrorWrite[] = []
  mirrorBatches.set(scoped, writes)
  try {
    return await operation(scoped)
  } finally {
    mirrorBatches.delete(scoped)
    if (writes.length) startSettingsRecordMirrors(scoped, writes)
  }
}

export function mirrorSettingsRecord(
  records: SettingsRecordPaths,
  path: string,
  write: () => Promise<void>,
) {
  const batch = mirrorBatches.get(records)
  if (batch) batch.push({ path, write })
  else startSettingsRecordMirrors(records, [{ path, write }])
}

function startSettingsRecordMirrors(
  records: SettingsRecordPaths,
  writes: MirrorWrite[],
) {
  const directory = records.state?.directory
  if (!directory) return
  const options = mirrorOptions.get(records)
  const task = Promise.resolve()
    .then(async () => {
      try {
        await checkStateFolder(directory, options ?? {}, true)
      } catch {
        warnRefusedFolder(directory, options)
        return
      }
      for (const { path, write } of writes) {
        try {
          await write()
        } catch {
          warnMirrorOnce(
            path,
            `Could not mirror settings record "${path}".`,
            options,
          )
        }
      }
    })
    .catch(() => {
      // An optional warning hook must not surface a detached rejection.
    })
    .finally(() => pendingMirrors.delete(task))
  pendingMirrors.add(task)
}

export async function __waitForSettingsRecordMirrorsForTest() {
  while (pendingMirrors.size) await Promise.all(pendingMirrors)
}

export function settingsRecordLocations(records: SettingsRecordPaths): string {
  const beside = `beside the settings file in "${records.beside.directory}"`
  return records.state
    ? `${beside} and in "${records.state.directory}"`
    : beside
}

const ignoredOverrides = new WeakMap<object, Set<string>>()

export function getSettingsFileOverride(
  options: SettingsPathOptions,
): string | undefined {
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
    override: getSettingsFileOverride(options),
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
  if (getSettingsFileOverride(options)) return false
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

async function canonicalSettingsParent(
  folder: string,
  {
    paths,
    realpath,
  }: Pick<ReturnType<typeof resolvePathOptions>, 'paths' | 'realpath'>,
): Promise<string> {
  try {
    return await realpath(folder)
  } catch (error) {
    const parent = paths.dirname(folder)
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || parent === folder)
      throw error
    const canonical = await canonicalSettingsParent(parent, { paths, realpath })
    return paths.join(canonical, paths.basename(folder))
  }
}

/** Resolve once at startup; callers keep the result off the request path. */
export async function resolveSettingsPaths(
  host: SettingsHost,
  options: SettingsPathOptions = {},
): Promise<SettingsPaths> {
  const target = getSettingsFilePath(options)
  const context = resolvePathOptions(options)
  const { paths, env, home, platform } = context
  const parent = paths.dirname(target)
  const beside = recordFiles(parent, `${target}.`)
  try {
    const separate = await isSeparateSettingsInstall(host, options)
    const records: SettingsRecordPaths = { beside }
    if (!separate) {
      try {
        // Resolve parent aliases but keep the configured filename, even if it is a
        // symlink. Removing the file or symlink must not change the record key.
        const identity = paths.join(
          await canonicalSettingsParent(parent, context),
          paths.basename(target),
        )
        const key = createHash('sha256')
          .update(identity)
          .digest('hex')
          .slice(0, 16)
        const root = anthropicAuthStateRoot(
          { xdgStateHome: env.XDG_STATE_HOME, home },
          paths,
        )
        // A drive-rooted Windows path without a drive depends on the caller's cwd.
        if (
          !paths.isAbsolute(root) ||
          (platform === 'win32' &&
            !/^(?:[A-Za-z]:\\|\\\\[^\\]+\\[^\\]+\\)/.test(root))
        )
          throw new Error('Settings state root is not fully qualified')
        const directory = paths.join(root, 'settings', key)
        records.state = recordFiles(directory, `${directory}${paths.sep}`)
        mirrorOptions.set(records, options)
      } catch {
        warnMirrorOnce(
          `key:${target}`,
          `Cannot resolve the settings record mirror for "${target}"; keeping records beside the settings file.`,
          options,
        )
      }
    }
    return {
      target,
      records,
      separate,
      sourceRule:
        getSettingsFileOverride(options) ||
        (await hasPrivateSettingsConfigHome(options))
          ? 'own'
          : 'default',
      own: getSettingsStorePaths(host, options),
      defaults: {
        opencode: getDefaultSettingsStorePaths('opencode', options),
        pi: getDefaultSettingsStorePaths('pi', options),
      },
    }
  } catch (error) {
    throw new SettingsPathResolutionError(target, beside, error)
  }
}
