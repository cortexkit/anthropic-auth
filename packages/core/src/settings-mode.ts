import { lstat, mkdir } from 'node:fs/promises'

import {
  ensureWindowsOwnerOnlyDirectory,
  type OwnerOnlyOptions,
} from './owner-only.ts'
import {
  type PathResolutionOptions,
  resolvePathOptions,
} from './path-options.ts'
import { canonicalPath } from './pool-paths.ts'
import type { SettingsPaths } from './settings-paths.ts'
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
  const bytes = Buffer.from(
    `${JSON.stringify({
      version: 1,
      target: await canonicalPath(target, context),
      at: (options.now ?? Date.now)(),
    })}\n`,
  )
  const parent = context.paths.dirname(target)
  if (options.fs?.mkdir) await options.fs.mkdir(parent)
  else if (
    !(await ensureWindowsOwnerOnlyDirectory(parent, {
      ...options.ownership,
      platform: context.platform,
    }))
  )
    await mkdir(parent, { recursive: true, mode: 0o700 })
  try {
    if (options.fs?.writeMarker)
      await options.fs.writeMarker(`${target}.moved`, bytes)
    else
      await writeOwnerOnlyExclusive(
        `${target}.moved`,
        bytes,
        context.platform,
        {
          ownership: options.ownership,
        },
      )
  } catch (error) {
    // A concurrent start may have published the same target's marker first.
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
