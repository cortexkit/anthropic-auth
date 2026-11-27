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
import {
  mirrorSettingsRecord,
  type SettingsHost,
  type SettingsPaths,
  type SettingsRecordPaths,
} from './settings-paths.ts'
import type { SettingsService } from './settings-service.ts'
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
  /** A usable settings file still uses beside records if the mirror folder is unusable. */
  useBesideIfStateFolderUnavailable?: boolean
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
  { records }: Pick<SettingsPaths, 'records'>,
  options: SettingsModeOptions = {},
): Promise<boolean> {
  return hasSettingsRecord(
    records,
    records.beside.moved,
    records.state?.moved,
    options,
  )
}

async function hasSettingsRecord(
  records: SettingsRecordPaths,
  beside: string,
  state: string | undefined,
  options: SettingsModeOptions,
): Promise<boolean> {
  const check = options.fs?.exists ?? exists
  if (await check(beside)) return true
  if (records.stateUnavailable && !options.useBesideIfStateFolderUnavailable)
    throw records.stateUnavailable
  return state ? check(state) : false
}

/** Publish once after a completed move or a usable hand-made file is found. */
export async function writeSettingsMoveMarker(
  { target, records }: Pick<SettingsPaths, 'target' | 'records'>,
  options: SettingsModeOptions = {},
): Promise<void> {
  await writeSettingsRecordCopies(
    records,
    records.beside.moved,
    records.state?.moved,
    async () => ({
      version: 1,
      target: await canonicalPath(target, options),
      at: (options.now ?? Date.now)(),
    }),
    options,
  )
}

/**
 * Whether `host`'s legacy store was imported into the file, or proved to
 * hold nothing the file lacks. It confers no authority: only the file or
 * its `.moved` marker decide which source is in charge.
 */
export function hasSettingsImportRecord(
  { records }: Pick<SettingsPaths, 'records'>,
  host: SettingsHost,
  options: SettingsModeOptions = {},
): Promise<boolean> {
  return hasSettingsRecord(
    records,
    records.beside.imports[host],
    records.state?.imports[host],
    options,
  )
}

/**
 * Record once that `host`'s store was imported. Write it only after the
 * import completed (or proved there was nothing to import), never before
 * the file is published. It holds no settings values.
 */
export async function writeSettingsImportRecord(
  { records }: Pick<SettingsPaths, 'records'>,
  host: SettingsHost,
  options: SettingsModeOptions = {},
): Promise<void> {
  await writeSettingsRecordCopies(
    records,
    records.beside.imports[host],
    records.state?.imports[host],
    async () => ({
      version: 1,
      host,
      release: anthropicAuthRelease(),
      at: (options.now ?? Date.now)(),
    }),
    options,
  )
}

async function writeSettingsRecordCopies(
  records: SettingsRecordPaths,
  beside: string,
  state: string | undefined,
  record: () => Promise<Record<string, unknown>>,
  options: SettingsModeOptions,
): Promise<void> {
  const check = options.fs?.exists ?? exists
  let bytes: Uint8Array | undefined
  const encode = async () => Buffer.from(`${JSON.stringify(await record())}\n`)
  if (!(await check(beside))) {
    bytes = await encode()
    await writeSettingsRecord(beside, bytes, options)
  }
  if (state)
    mirrorSettingsRecord(records, state, async () => {
      if (!(await check(state)))
        await writeSettingsRecord(state, bytes ?? (await encode()), options)
    })
}

/** Write a small owner-only record, exactly once. */
async function writeSettingsRecord(
  path: string,
  bytes: Uint8Array,
  options: SettingsModeOptions,
): Promise<void> {
  const context = resolvePathOptions(options)
  const parent = context.paths.dirname(path)
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
  paths: Pick<SettingsPaths, 'target' | 'separate' | 'records'>,
  options: SettingsModeOptions = {},
): Promise<SettingsMode> {
  if (paths.separate) return 'separate'
  if (options.moveCompleted) return 'user-file'
  if (await (options.fs?.exists ?? exists)(paths.target)) return 'user-file'
  return (await hasSettingsMoveMarker(paths, options)) ? 'user-file' : 'legacy'
}

/**
 * Decides, off the request path, whether a running host may start using the
 * settings file through `service` (its own handle on that file). It runs the
 * host's import check, and returns false to keep the host's current
 * authority and ask again at the next check. 'pending' lets the host use a
 * missing file, whose protection comes from the host's own recovery, but
 * the host must pass the check again before it uses a file that appears.
 */
export type SettingsAdoptionCheck = (
  service: SettingsService,
) => Promise<boolean | 'pending'>

// Keyed by the service handle `startSettings` returned, so hosts pass the
// check to their runtime without carrying another option.
const adoptionChecks = new WeakMap<object, SettingsAdoptionCheck>()

/** Attach the check a runtime must pass before adopting the file `service` reads. */
export function setSettingsAdoptionCheck(
  service: object,
  check: SettingsAdoptionCheck,
): void {
  adoptionChecks.set(service, check)
}

/** The check attached to `service`, if any; read it before retaining the handle. */
export function getSettingsAdoptionCheck(
  service: object | undefined,
): SettingsAdoptionCheck | undefined {
  return service ? adoptionChecks.get(service) : undefined
}

// Handles whose host started on a missing file it never imported, keyed like
// the adoption checks.
const pendingImports = new WeakSet<object>()

/**
 * Record that the host uses `service`'s missing file without having imported
 * its legacy store, so its runtime runs the import check before it uses a
 * file that appears.
 */
export function markSettingsImportPending(service: object): void {
  pendingImports.add(service)
}

/** Whether `service` was marked; read it before retaining the handle. */
export function isSettingsImportPending(service: object | undefined): boolean {
  return service ? pendingImports.has(service) : false
}
