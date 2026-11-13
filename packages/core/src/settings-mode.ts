import { lstat, mkdir } from 'node:fs/promises'

import { anthropicAuthRelease } from './holder-registry.ts'
import {
  ensureWindowsOwnerOnlyDirectory,
  type OwnerOnlyOptions,
} from './owner-only.ts'
import {
  type PathResolutionOptions,
  resolvePathOptions,
} from './path-options.ts'
import { canonicalPath } from './pool-paths.ts'
import type { SettingsHost, SettingsPaths } from './settings-paths.ts'
import { writeOwnerOnlyExclusive } from './state-layout-io.ts'

export type SettingsMode = 'separate' | 'user-file' | 'legacy'

/** Injectable filesystem operations for authority checks and marker publication. */
export interface SettingsModeFs {
  exists(path: string): Promise<boolean>
  mkdir(path: string): Promise<void>
  writeMarker(path: string, bytes: Uint8Array): Promise<void>
}

export interface SettingsModeOptions extends PathResolutionOptions {
  fs?: Partial<SettingsModeFs>
  ownership?: OwnerOnlyOptions
  now?: () => number
  moveCompleted?: boolean
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

/** Only existence confers authority; informational move notes are never read. */
export function hasSettingsMoveMarker(
  target: string,
  options: SettingsModeOptions = {},
): Promise<boolean> {
  return (options.fs?.exists ?? exists)(`${target}.moved`)
}

/** Publish once after a completed move or a usable hand-made file is found. */
export async function writeSettingsMoveMarker(
  target: string,
  options: SettingsModeOptions = {},
): Promise<void> {
  if (await hasSettingsMoveMarker(target, options)) return
  const context = resolvePathOptions(options)
  await writeSettingsRecord(
    target,
    `${target}.moved`,
    {
      version: 1,
      target: await canonicalPath(target, context),
      at: (options.now ?? Date.now)(),
    },
    options,
  )
}

/** Where `host` records that its legacy store's protection is in the file. */
export function settingsImportRecordPath(
  target: string,
  host: SettingsHost,
): string {
  return `${target}.moved.${host}`
}

/**
 * Whether `host`'s legacy store was imported into the file, or proved to
 * hold nothing the file lacks. It confers no authority: only the file or
 * its `.moved` marker decide which source is in charge.
 */
export function hasSettingsImportRecord(
  target: string,
  host: SettingsHost,
  options: SettingsModeOptions = {},
): Promise<boolean> {
  return (options.fs?.exists ?? exists)(settingsImportRecordPath(target, host))
}

/**
 * Record once that `host`'s store was imported. Write it only after the
 * import completed (or proved there was nothing to import), never before
 * the file is published. It holds no settings values.
 */
export async function writeSettingsImportRecord(
  target: string,
  host: SettingsHost,
  options: SettingsModeOptions = {},
): Promise<void> {
  if (await hasSettingsImportRecord(target, host, options)) return
  await writeSettingsRecord(
    target,
    settingsImportRecordPath(target, host),
    {
      version: 1,
      host,
      release: anthropicAuthRelease(),
      at: (options.now ?? Date.now)(),
    },
    options,
  )
}

/** Write a small owner-only record beside the settings file, exactly once. */
async function writeSettingsRecord(
  target: string,
  path: string,
  record: Record<string, unknown>,
  options: SettingsModeOptions,
): Promise<void> {
  const context = resolvePathOptions(options)
  const bytes = Buffer.from(`${JSON.stringify(record)}\n`)
  const parent = context.paths.dirname(target)
  if (options.fs?.mkdir) await options.fs.mkdir(parent)
  // An existing folder is left as it is: %APPDATA%\cortexkit is shared with
  // other CortexKit plugins and keeps its inherited access-control lists,
  // which the owner-only helper refuses. Only a missing folder is created
  // owner-only.
  else if (
    !(await exists(parent)) &&
    !(await ensureWindowsOwnerOnlyDirectory(parent, {
      ...options.ownership,
      platform: context.platform,
    }))
  )
    await mkdir(parent, { recursive: true, mode: 0o700 })
  try {
    if (options.fs?.writeMarker) await options.fs.writeMarker(path, bytes)
    else
      await writeOwnerOnlyExclusive(path, bytes, context.platform, {
        ownership: options.ownership,
      })
  } catch (error) {
    // A concurrent start may have published the same record first.
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
}

/** Startup/menu/watch/timer work only: request readers consume the cached mode. */
export async function resolveSettingsMode(
  paths: Pick<SettingsPaths, 'target' | 'separate'>,
  options: SettingsModeOptions = {},
): Promise<SettingsMode> {
  if (paths.separate) return 'separate'
  if (options.moveCompleted) return 'user-file'
  if (await (options.fs?.exists ?? exists)(paths.target)) return 'user-file'
  return (await hasSettingsMoveMarker(paths.target, options))
    ? 'user-file'
    : 'legacy'
}
