import { randomUUID } from 'node:crypto'
import {
  link,
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as nodePath from 'node:path'
import { dirname, join } from 'node:path'

import {
  type HolderLiveness,
  holderEntryIsLive,
  type WriterStamp,
  writerStamp,
} from './holder-registry.ts'
import { getHostDataHome } from './host-paths.ts'
import {
  createWindowsOwnerOnly,
  ensureWindowsOwnerOnlyDirectory,
  isOwnerOnly,
  type OwnerOnlyOptions,
} from './owner-only.ts'
import { renameWithWindowsSharingRetry } from './publication-rename.ts'

export const CACHE_KEEP_REGISTRY_LEASE_MS = 3 * 60_000

export const CACHE_KEEP_STOP_REASONS = [
  'cost-cap',
  'schedule',
  'evicted',
  'policy-refused',
  'retries-exhausted',
  'session-forgotten',
  'disabled',
] as const
export type CacheKeepStopReason = (typeof CACHE_KEEP_STOP_REASONS)[number]

export type CacheKeepTrackedSession = {
  id: string
  cacheExpiresAt: number
  nextPrewarmAt: number
  ttlMs?: number
  lastTouchAt?: number
  lastTouchKind?: 'response' | 'warm'
  warmStopped?: { at: number; reason: CacheKeepStopReason }
}

type CacheKeepRegistryRecord = {
  version: 1
  updatedAt: number
  sessions: CacheKeepTrackedSession[]
  /**
   * Written by 2.3.0 and later beside `version`, which must stay 1 because
   * older readers require it. Readers here and in older versions ignore it;
   * a later version uses it to tell these records from older ones.
   */
  writer?: WriterStamp
}

function normalizeSession(value: unknown): CacheKeepTrackedSession | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return
  const record = value as Record<string, unknown>
  if (
    typeof record.id !== 'string' ||
    record.id.length === 0 ||
    typeof record.cacheExpiresAt !== 'number' ||
    !Number.isFinite(record.cacheExpiresAt) ||
    typeof record.nextPrewarmAt !== 'number' ||
    !Number.isFinite(record.nextPrewarmAt)
  ) {
    return
  }
  return {
    id: record.id,
    cacheExpiresAt: record.cacheExpiresAt,
    nextPrewarmAt: record.nextPrewarmAt,
    ...(typeof record.ttlMs === 'number' &&
      Number.isFinite(record.ttlMs) &&
      record.ttlMs > 0 && { ttlMs: record.ttlMs }),
    ...(typeof record.lastTouchAt === 'number' &&
      Number.isFinite(record.lastTouchAt) && {
        lastTouchAt: record.lastTouchAt,
      }),
    ...((record.lastTouchKind === 'response' ||
      record.lastTouchKind === 'warm') && {
      lastTouchKind: record.lastTouchKind,
    }),
    ...normalizeStopped(record.warmStopped),
  }
}

function normalizeStopped(
  value: unknown,
): Pick<CacheKeepTrackedSession, 'warmStopped'> {
  if (!value || typeof value !== 'object') return {}
  const stopped = value as { at?: unknown; reason?: unknown }
  if (
    typeof stopped.at !== 'number' ||
    !Number.isFinite(stopped.at) ||
    !CACHE_KEEP_STOP_REASONS.includes(stopped.reason as CacheKeepStopReason)
  )
    return {}
  return {
    warmStopped: {
      at: stopped.at,
      reason: stopped.reason as CacheKeepStopReason,
    },
  }
}

function normalizeRecord(value: unknown): CacheKeepRegistryRecord | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return
  const record = value as Record<string, unknown>
  if (
    record.version !== 1 ||
    typeof record.updatedAt !== 'number' ||
    !Number.isFinite(record.updatedAt) ||
    !Array.isArray(record.sessions)
  ) {
    return
  }
  return {
    version: 1,
    updatedAt: record.updatedAt,
    sessions: record.sessions.flatMap((session) => {
      const normalized = normalizeSession(session)
      return normalized ? [normalized] : []
    }),
  }
}

function isExpiredRecord(
  record: CacheKeepRegistryRecord,
  now: number,
  leaseMs: number,
): boolean {
  return record.updatedAt <= now && now - record.updatedAt > leaseMs
}

export function getLegacyCacheKeepRegistryDirectory(scope: 'opencode' | 'pi') {
  // Remove in the release after the next one: 2.5.3 reads only the temp registry.
  return join(tmpdir(), 'opencode-anthropic-auth', 'cachekeep-sessions', scope)
}

export function getDefaultCacheKeepRegistryDirectory(
  scope: 'opencode' | 'pi',
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  pathApi: Pick<typeof nodePath, 'join' | 'resolve'> = nodePath,
) {
  return pathApi.join(
    getHostDataHome(env, platform, pathApi),
    'cortexkit',
    'anthropic-auth',
    'cachekeep-sessions',
    scope,
  )
}

export function getCacheKeepRegistryDirectories(
  scope: 'opencode' | 'pi',
  override?: string,
  env: NodeJS.ProcessEnv = process.env,
) {
  const directory =
    override ||
    env[
      scope === 'pi'
        ? 'PI_ANTHROPIC_AUTH_CACHEKEEP_REGISTRY_DIR'
        : 'OPENCODE_ANTHROPIC_AUTH_CACHEKEEP_REGISTRY_DIR'
    ]
  return {
    directory: directory || getDefaultCacheKeepRegistryDirectory(scope, env),
    // Remove in the release after the next one: overrides must not leak into
    // default folders, but default writers also serve 2.5.3 temp-folder readers.
    legacyDirectory: directory
      ? undefined
      : getLegacyCacheKeepRegistryDirectory(scope),
  }
}

export class CacheKeepSessionRegistry {
  private readonly directories: string[]
  private readonly filePaths: string[]
  private writeChain: Promise<void> = Promise.resolve()
  private lastSweepAt?: number

  constructor(
    private readonly options: {
      directory: string
      legacyDirectory?: string
      ownerOnly?: OwnerOnlyOptions
      liveness?: HolderLiveness
      now?: () => number
      leaseMs?: number
      instanceId?: string
    },
  ) {
    const instanceId = options.instanceId ?? `${process.pid}-${randomUUID()}`
    // Remove in the release after the next one: dual publication and merged reads.
    this.directories = [
      ...new Set(
        [options.directory, options.legacyDirectory].filter(
          (dir): dir is string => !!dir,
        ),
      ),
    ]
    this.filePaths = this.directories.map((dir) =>
      join(dir, `${instanceId}.json`),
    )
  }

  publish(sessions: readonly CacheKeepTrackedSession[]): Promise<void> {
    const snapshot = sessions.map((session) => ({ ...session }))
    this.writeChain = this.writeChain
      .catch(() => {})
      .then(async () => {
        const now = this.options.now?.() ?? Date.now()
        const leaseMs = this.options.leaseMs ?? CACHE_KEEP_REGISTRY_LEASE_MS
        const record: CacheKeepRegistryRecord = {
          version: 1,
          updatedAt: now,
          sessions: snapshot,
          writer: writerStamp(),
        }
        for (const filePath of this.filePaths) {
          if (snapshot.length === 0) {
            await rm(filePath, { force: true })
            continue
          }
          const directory = dirname(filePath)
          if (
            !(await ensureWindowsOwnerOnlyDirectory(
              directory,
              this.options.ownerOnly,
            ))
          ) {
            await mkdir(directory, { recursive: true, mode: 0o700 })
          }
          const stat = await lstat(directory)
          if (
            !stat.isDirectory() ||
            stat.isSymbolicLink() ||
            !(await isOwnerOnly(
              directory,
              () =>
                stat.uid === process.getuid?.() &&
                (stat.mode & 0o777) === 0o700,
              this.options.ownerOnly,
            ))
          )
            throw new Error('Unsafe CacheKeep registry directory')
          const tempPath = `${filePath}.${randomUUID()}.tmp`
          try {
            const bytes = `${JSON.stringify(record)}\n`
            if (
              !(await createWindowsOwnerOnly(
                tempPath,
                bytes,
                this.options.ownerOnly,
              ))
            )
              await writeFile(tempPath, bytes, { flag: 'wx', mode: 0o600 })
            await renameWithWindowsSharingRetry(tempPath, filePath, {
              platform: this.options.ownerOnly?.platform,
            })
          } finally {
            await rm(tempPath, { force: true })
          }
        }
        await this.sweepExpiredRecords(now, leaseMs)
      })
    return this.writeChain
  }

  async list(
    localSessions: readonly CacheKeepTrackedSession[] = [],
  ): Promise<CacheKeepTrackedSession[]> {
    await this.writeChain.catch(() => {})
    const now = this.options.now?.() ?? Date.now()
    const leaseMs = this.options.leaseMs ?? CACHE_KEEP_REGISTRY_LEASE_MS
    await this.sweepExpiredRecords(now, leaseMs)
    const records = await Promise.all(
      (await this.recordPaths()).map(async (path) => {
        try {
          const raw = await readFile(path, 'utf8')
          return normalizeRecord(JSON.parse(raw))
        } catch {
          return undefined
        }
      }),
    )
    const sessions = new Map<string, CacheKeepTrackedSession>()
    for (const record of records) {
      if (
        !record ||
        now - record.updatedAt > leaseMs ||
        record.updatedAt > now
      ) {
        continue
      }
      for (const session of record.sessions) {
        const existing = sessions.get(session.id)
        if (!existing || session.cacheExpiresAt > existing.cacheExpiresAt) {
          sessions.set(session.id, session)
        }
      }
    }
    for (const session of localSessions) {
      const existing = sessions.get(session.id)
      if (!existing || session.cacheExpiresAt > existing.cacheExpiresAt) {
        sessions.set(session.id, { ...session })
      }
    }
    return [...sessions.values()].sort((left, right) =>
      left.id.localeCompare(right.id),
    )
  }

  async dispose(): Promise<void> {
    await this.writeChain.catch(() => {})
    await Promise.all(this.filePaths.map((path) => rm(path, { force: true })))
  }

  private async recordPaths(): Promise<string[]> {
    return (
      await Promise.all(
        this.directories.map(async (directory) => {
          try {
            return (await readdir(directory))
              .filter((name) => name.endsWith('.json'))
              .map((name) => join(directory, name))
          } catch {
            return []
          }
        }),
      )
    ).flat()
  }

  private async mayRemove(
    recordPath: string,
    record: CacheKeepRegistryRecord,
    now: number,
    leaseMs: number,
  ) {
    if (!isExpiredRecord(record, now, leaseMs)) return false
    const pid = Number(
      /(?:^|[/\\])(\d+)-[^/\\]+\.json(?:\..+\.sweep)?$/.exec(recordPath)?.[1],
    )
    if (!Number.isSafeInteger(pid) || pid <= 0) return false
    return !(await holderEntryIsLive(
      { pid, incarnation: null, registeredAt: record.updatedAt },
      this.options.liveness,
    ))
  }

  private async sweepExpiredRecords(
    now: number,
    leaseMs: number,
  ): Promise<void> {
    if (this.lastSweepAt !== undefined && now - this.lastSweepAt < leaseMs) {
      return
    }
    this.lastSweepAt = now

    await Promise.all(
      (await this.recordPaths()).map(async (recordPath) => {
        if (this.filePaths.includes(recordPath)) return

        let initialRecord: CacheKeepRegistryRecord | undefined
        try {
          initialRecord = normalizeRecord(
            JSON.parse(await readFile(recordPath, 'utf8')),
          )
        } catch {
          return
        }
        if (
          !initialRecord ||
          !(await this.mayRemove(recordPath, initialRecord, now, leaseMs))
        ) {
          return
        }

        const sweptPath = `${recordPath}.${randomUUID()}.sweep`
        try {
          await rename(recordPath, sweptPath)
        } catch {
          // Another publisher or sweeper may have moved the record first.
          return
        }

        let raw: string | undefined
        let record: CacheKeepRegistryRecord | undefined
        try {
          raw = await readFile(sweptPath, 'utf8')
          record = normalizeRecord(JSON.parse(raw))
        } catch {
          // Unreadable records are not safe to classify as expired.
        }

        if (
          record &&
          (await this.mayRemove(recordPath, record, now, leaseMs))
        ) {
          try {
            await rm(sweptPath, { force: true })
          } catch {
            // Cleanup is best-effort and must not change CacheKeep behavior.
          }
          return
        }

        await this.restoreSweptRecord(recordPath, sweptPath, raw)
      }),
    )
  }

  private async restoreSweptRecord(
    recordPath: string,
    sweptPath: string,
    raw: string | undefined,
  ): Promise<void> {
    try {
      await link(sweptPath, recordPath)
    } catch (error) {
      const code =
        error && typeof error === 'object' && 'code' in error
          ? error.code
          : undefined
      if (code === 'EEXIST') {
        // A newer atomic publication already occupies the original path.
        try {
          await rm(sweptPath, { force: true })
        } catch {
          // Cleanup is best-effort and must not change CacheKeep behavior.
        }
        return
      }
      if (raw === undefined) return

      try {
        if (
          !(await createWindowsOwnerOnly(
            recordPath,
            raw,
            this.options.ownerOnly,
          ))
        )
          await writeFile(recordPath, raw, {
            encoding: 'utf8',
            flag: 'wx',
            mode: 0o600,
          })
      } catch (writeError) {
        const writeCode =
          writeError && typeof writeError === 'object' && 'code' in writeError
            ? writeError.code
            : undefined
        if (writeCode !== 'EEXIST') return
      }
    }

    try {
      await rm(sweptPath, { force: true })
    } catch {
      // Cleanup is best-effort and must not change CacheKeep behavior.
    }
  }
}
