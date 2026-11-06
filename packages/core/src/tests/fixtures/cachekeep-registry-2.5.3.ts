// Parser copied from v2.5.3's cachekeep-registry.ts. Keep it unchanged so the
// compatibility test exercises the released reader, not the current reader.
type CacheKeepTrackedSession = {
  id: string
  cacheExpiresAt: number
  nextPrewarmAt: number
}

type CacheKeepRegistryRecord = {
  version: 1
  updatedAt: number
  sessions: CacheKeepTrackedSession[]
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
  }
}

export function normalizeRecord(
  value: unknown,
): CacheKeepRegistryRecord | undefined {
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
