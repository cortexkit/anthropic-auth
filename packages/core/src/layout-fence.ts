import { constants } from 'node:fs'
import { lstat, open, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'

import {
  getDefaultCacheKeepRegistryDirectory,
  getLegacyCacheKeepRegistryDirectory,
} from './cachekeep-registry.ts'
import {
  HOLDER_FILE_NAME,
  type HolderLiveness,
  holderEntryIsLive,
  holderEntryLiveness,
  processIncarnation,
  processStartedAtMs,
  readHolderFile,
  recordPredatesBoot,
} from './holder-registry.ts'
import { anthropicAuthStateRoot } from './state-layout-paths.ts'

/**
 * Environment variables that name anthropic-auth files. A process with any of
 * them set never moves a dataset or writes `layout.json`.
 */
export const STATE_PATH_OVERRIDE_VARIABLES = [
  'OPENCODE_ANTHROPIC_AUTH_FILE',
  'OPENCODE_ANTHROPIC_AUTH_STATE_FILE',
  'OPENCODE_ANTHROPIC_AUTH_ROUTING_STATE_FILE',
  'OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE',
  'OPENCODE_TUI_PREFERENCES_FILE',
] as const

/** The path overrides set in `env`. */
export function statePathOverrides(env: NodeJS.ProcessEnv): string[] {
  return STATE_PATH_OVERRIDE_VARIABLES.filter((name) => env[name]?.trim())
}

/** Something that keeps a dataset where it is. */
export type FenceBlocker =
  | {
      readonly kind: 'holder'
      readonly holderFile: string
      readonly pid: number | null
      readonly role: string | null
      readonly file: string | null
    }
  | {
      readonly kind: 'holder-file'
      readonly holderFile: string
      readonly reason: string
    }
  | {
      readonly kind: 'pre-n-artifact'
      readonly artifact: string
      readonly pid: number
    }
  | {
      readonly kind: 'artifact-scan'
      readonly path: string
      readonly reason: string
    }
  | { readonly kind: 'override'; readonly variable: string }

function errorCode(error: unknown): unknown {
  return error instanceof Error && 'code' in error ? error.code : undefined
}

function reasonOf(error: unknown): string {
  const code = errorCode(error)
  if (typeof code === 'string') return code
  return error instanceof Error ? error.name : 'unknown'
}

const defaultLiveness: HolderLiveness = {
  pidAlive(pid) {
    try {
      process.kill(pid, 0)
      return true
    } catch (error) {
      return errorCode(error) === 'EPERM'
    }
  },
  incarnation: processIncarnation,
}

/**
 * The fence's holder check: every live entry, in the holder file of each
 * directory, that lists one of `files` blocks; so does a holder file that
 * can't be read or parsed (an absent one is fine). An entry this version
 * can't read blocks too, because it may belong to a live process. Nothing is
 * excused by pid, not even this process's own: the mover registers nothing
 * before it has decided, so any entry of its pid belongs to another copy of
 * the code.
 */
export async function holderFenceBlockers(input: {
  directories: readonly string[]
  files: readonly string[]
  liveness?: HolderLiveness
}): Promise<FenceBlocker[]> {
  const liveness = input.liveness ?? defaultLiveness
  const files = new Set(input.files)
  const blockers: FenceBlocker[] = []
  for (const dir of [...new Set(input.directories)].sort()) {
    const holderFile = join(dir, HOLDER_FILE_NAME)
    let contents: Awaited<ReturnType<typeof readHolderFile>>
    try {
      contents = await readHolderFile(holderFile)
    } catch (error) {
      blockers.push({
        kind: 'holder-file',
        holderFile,
        reason: reasonOf(error),
      })
      continue
    }
    for (const value of contents?.entries ?? []) {
      const life = holderEntryLiveness(value)
      const record = value as { files?: unknown; role?: unknown }
      const listed = Array.isArray(record?.files)
        ? record.files.filter(
            (file): file is string => typeof file === 'string',
          )
        : undefined
      if (!life || !listed) {
        blockers.push({
          kind: 'holder',
          holderFile,
          pid: life?.pid ?? null,
          role: null,
          file: null,
        })
        continue
      }
      const overlap = listed.find((file) => files.has(file))
      if (overlap === undefined) continue
      if (!(await holderEntryIsLive(life, liveness))) continue
      blockers.push({
        kind: 'holder',
        holderFile,
        pid: life.pid,
        role: typeof record.role === 'string' ? record.role : null,
        file: overlap,
      })
    }
  }
  return blockers
}

/** Where pid artifacts of older versions may be found. */
export interface PreNArtifactLocations {
  /** Folders whose every subfolder holds RPC port files (`<root>/rpc`). */
  readonly rpcRoots: readonly string[]
  /** Folders that hold RPC port files directly (an overridden RPC folder). */
  readonly rpcDirs: readonly string[]
  /** CacheKeep registry folders (`<pid>-<uuid>.json` records). */
  readonly cacheKeepDirs: readonly string[]
}

/** The artifact folders this process can find for `env`. */
export function defaultPreNArtifactLocations(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): PreNArtifactLocations {
  const root = anthropicAuthStateRoot({
    xdgStateHome: env.XDG_STATE_HOME,
    home,
    acceptRelative: true,
  })
  const rpcOverride = env.OPENCODE_ANTHROPIC_AUTH_RPC_DIR?.trim()
  return {
    rpcRoots: [join(root, 'rpc')],
    rpcDirs: rpcOverride ? [resolve(rpcOverride)] : [],
    cacheKeepDirs: [
      ...new Set(
        [
          getDefaultCacheKeepRegistryDirectory('opencode', env),
          getDefaultCacheKeepRegistryDirectory('pi', env),
          // Remove in the release after the next one: fence older temp records too.
          getLegacyCacheKeepRegistryDirectory('opencode'),
          getLegacyCacheKeepRegistryDirectory('pi'),
          env.OPENCODE_ANTHROPIC_AUTH_CACHEKEEP_REGISTRY_DIR?.trim(),
          env.PI_ANTHROPIC_AUTH_CACHEKEEP_REGISTRY_DIR?.trim(),
        ].filter((dir): dir is string => Boolean(dir)),
      ),
    ],
  }
}

/** Entries of a folder; an absent folder has none, any other error blocks. */
async function listDir(
  dir: string,
  blockers: FenceBlocker[],
): Promise<string[]> {
  try {
    return await readdir(dir)
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return []
    blockers.push({ kind: 'artifact-scan', path: dir, reason: reasonOf(error) })
    return []
  }
}

/** A stamped artifact was written by a version that registers as a holder. */
function stamped(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false
  const writer = (value as { writer?: unknown }).writer
  return (
    typeof writer === 'object' &&
    writer !== null &&
    (writer as { protocol?: unknown }).protocol === 1
  )
}

/** Only these production names identify a file's writer independently of its bytes. */
function publisherPid(
  kind: 'rpc' | 'cachekeep',
  name: string,
): number | undefined {
  const match =
    kind === 'rpc'
      ? /^port-(\d+)\.json$/.exec(name)
      : /^(\d+)-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/.exec(
          name,
        )
  const pid = Number(match?.[1])
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined
}

const MAX_PUBLISHER_BYTES = 64 * 1024

async function readArtifact(
  path: string,
  blockers: FenceBlocker[],
  malformedIsStale: (startedAt?: unknown) => Promise<boolean>,
): Promise<{ value: unknown; startedAt: unknown } | undefined> {
  let text: string | undefined
  let mtimeMs: number
  const nonRegular = () =>
    blockers.push({ kind: 'artifact-scan', path, reason: 'not a regular file' })
  try {
    const noFollow = constants.O_NOFOLLOW ?? 0
    const nonBlock = constants.O_NONBLOCK ?? 0
    if ((!noFollow || !nonBlock) && !(await lstat(path)).isFile()) {
      nonRegular()
      return undefined
    }
    // Keep the bytes and mtime from the same file if its writer replaces the path.
    const file = await open(path, constants.O_RDONLY | nonBlock | noFollow)
    try {
      const stat = await file.stat()
      if (!stat.isFile()) {
        nonRegular()
        return undefined
      }
      mtimeMs = stat.mtimeMs
      if (stat.size <= MAX_PUBLISHER_BYTES) {
        // A concurrent writer can grow the file after stat. Read at most one
        // extra byte to distinguish a complete record from a truncated one.
        const bytes = Buffer.alloc(MAX_PUBLISHER_BYTES + 1)
        let offset = 0
        while (offset < bytes.length) {
          const { bytesRead } = await file.read(
            bytes,
            offset,
            bytes.length - offset,
            offset,
          )
          if (bytesRead === 0) break
          offset += bytesRead
        }
        if (offset <= MAX_PUBLISHER_BYTES)
          text = bytes.toString('utf8', 0, offset)
      }
    } finally {
      await file.close()
    }
  } catch (error) {
    // Removed between the listing and the read: its writer released it.
    if (errorCode(error) === 'ENOENT') return undefined
    if (errorCode(error) === 'ELOOP') {
      nonRegular()
      return undefined
    }
    if (!(await malformedIsStale()))
      blockers.push({ kind: 'artifact-scan', path, reason: reasonOf(error) })
    return undefined
  }
  try {
    if (text === undefined) throw new Error('Publisher record is too large')
    const value: unknown = JSON.parse(text)
    // A recorded but unusable time must not fall back to an older mtime.
    const startedAt =
      typeof value === 'object' && value !== null
        ? 'startedAt' in value
          ? value.startedAt
          : 'registeredAt' in value
            ? value.registeredAt
            : mtimeMs
        : mtimeMs
    return { value, startedAt }
  } catch {
    if (!(await malformedIsStale(mtimeMs)))
      blockers.push({ kind: 'artifact-scan', path, reason: 'invalid' })
    return undefined
  }
}

/**
 * The fence's check for older versions: an RPC port file or CacheKeep record without the
 * `writer` stamp, whose pid is alive, belongs to a version that registers
 * nothing and blocks. Unreadable or malformed publisher-owned files need a
 * proven dead or reused filename pid, or a readable regular file's pre-boot mtime.
 * Other scan failures block. A record from before this boot is stale even
 * if its pid has been reused; missing or untrustworthy times keep blocking.
 */
export async function preNArtifactBlockers(
  locations: PreNArtifactLocations,
  pidAlive: (pid: number) => boolean = defaultLiveness.pidAlive,
  clock: Pick<HolderLiveness, 'now' | 'uptime' | 'processStartedAtMs'> = {},
  /**
   * When set, a stamped artifact counts as older too unless this accepts its
   * `writer.release`: its writer may be a release below a later fence's
   * floor whose holder registration is still pending.
   */
  acceptsRelease?: (release: unknown) => boolean,
): Promise<FenceBlocker[]> {
  const exempt = (value: unknown) =>
    stamped(value) &&
    (!acceptsRelease ||
      acceptsRelease(
        (value as { writer: { release?: unknown } }).writer.release,
      ))
  const malformedIsStale = async (
    pid: number | undefined,
    startedAt?: unknown,
  ) => {
    if (pid === undefined) return false
    if (recordPredatesBoot(startedAt, clock)) return true
    try {
      if (!pidAlive(pid)) return true
      if (
        typeof startedAt !== 'number' ||
        !Number.isFinite(startedAt) ||
        startedAt < 0 ||
        startedAt > (clock.now ?? Date.now)()
      )
        return false
      const start = await (clock.processStartedAtMs ?? processStartedAtMs)(pid)
      // ps reports whole seconds; tolerate clock and timestamp rounding.
      return (
        start !== null && Number.isFinite(start) && start > startedAt + 2_000
      )
    } catch {
      return false
    }
  }
  const blockers: FenceBlocker[] = []
  const portDirs = [...locations.rpcDirs]
  for (const root of locations.rpcRoots)
    for (const name of await listDir(root, blockers))
      portDirs.push(join(root, name))
  for (const dir of [...new Set(portDirs)]) {
    for (const name of await listDir(dir, blockers)) {
      if (!/^port-\d+\.json$/.test(name)) continue
      const path = join(dir, name)
      const filenamePid = publisherPid('rpc', name)
      const isStale = (startedAt?: unknown) =>
        malformedIsStale(filenamePid, startedAt)
      const record = await readArtifact(path, blockers, isStale)
      if (record === undefined || exempt(record.value)) continue
      const { value, startedAt } = record
      const pid = (value as { pid?: unknown } | null)?.pid
      if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) {
        if (!(await isStale(startedAt)))
          blockers.push({ kind: 'artifact-scan', path, reason: 'invalid' })
        continue
      }
      if (!(await malformedIsStale(pid, startedAt)))
        blockers.push({ kind: 'pre-n-artifact', artifact: path, pid })
    }
  }
  for (const dir of locations.cacheKeepDirs) {
    for (const name of await listDir(dir, blockers)) {
      const match = /^(\d+)-.+\.json$/.exec(name)
      if (!match) continue
      const path = join(dir, name)
      const filenamePid = publisherPid('cachekeep', name)
      const record = await readArtifact(path, blockers, (startedAt) =>
        malformedIsStale(filenamePid, startedAt),
      )
      if (record === undefined || exempt(record.value)) continue
      const pid = Number(match[1])
      if (!(await malformedIsStale(pid, record.startedAt)))
        blockers.push({ kind: 'pre-n-artifact', artifact: path, pid })
    }
  }
  return blockers
}

/** One line naming a blocker, for the log. */
export function describeFenceBlocker(blocker: FenceBlocker): string {
  switch (blocker.kind) {
    case 'holder':
      return `pid ${blocker.pid ?? 'unknown'} (${blocker.role ?? 'unknown role'}) in ${basename(blocker.holderFile)} uses ${blocker.file ?? 'an unreadable file list'}`
    case 'holder-file':
      return `${blocker.holderFile} can't be read (${blocker.reason})`
    case 'pre-n-artifact':
      return `pid ${blocker.pid} of an older anthropic-auth (${blocker.artifact})`
    case 'artifact-scan':
      return `${blocker.path} can't be read (${blocker.reason})`
    case 'override':
      return `${blocker.variable} is set`
  }
}
