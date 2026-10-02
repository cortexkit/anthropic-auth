import { readFile } from 'node:fs/promises'
import { withLock, writeJsonAtomic } from '@cortexkit/common-auth/fs'

import { parseJsonRedacted } from './json.ts'
import type { NativePoolPaths } from './pool-paths.ts'

const PHASES = [
  'building',
  'verified',
  'activation-installed',
  'committed',
  'retired',
] as const
export type NativeMigrationPhase = (typeof PHASES)[number]

export interface NativeMigrationSources {
  config: string | null
  state: string | null
  hostAuth: string | null
}

export interface NativeMigrationJournal {
  version: 1
  storageId: string
  host: 'opencode' | 'pi'
  phase: NativeMigrationPhase
  sources: NativeMigrationSources
}

export class NativeAuthorityError extends Error {
  constructor(
    public readonly code:
      | 'migration-required'
      | 'migration-incomplete'
      | 'invalid-journal'
      | 'journal-conflict',
  ) {
    super(
      {
        'migration-required':
          'Anthropic account migration is required; run setup',
        'migration-incomplete':
          'Anthropic account migration is incomplete; resume setup',
        'invalid-journal': 'Anthropic account migration journal is invalid',
        'journal-conflict': 'Anthropic account migration journal changed',
      }[code],
    )
    this.name = 'NativeAuthorityError'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isPhase(value: unknown): value is NativeMigrationPhase {
  return PHASES.some((phase) => phase === value)
}

function isDigest(value: unknown): value is string | null {
  return (
    value === null ||
    (typeof value === 'string' && /^[a-f0-9]{64}$/.test(value))
  )
}

function isSources(value: unknown): value is NativeMigrationSources {
  return (
    isRecord(value) &&
    Object.keys(value).length === 3 &&
    isDigest(value.config) &&
    isDigest(value.state) &&
    isDigest(value.hostAuth)
  )
}

function decodeJournal(
  value: unknown,
  storageId: string,
): NativeMigrationJournal {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 5 ||
    value.version !== 1 ||
    value.storageId !== storageId ||
    (value.host !== 'opencode' && value.host !== 'pi') ||
    !isPhase(value.phase) ||
    !isSources(value.sources)
  ) {
    throw new NativeAuthorityError('invalid-journal')
  }
  return {
    version: 1,
    storageId,
    host: value.host,
    phase: value.phase,
    sources: {
      config: value.sources.config,
      state: value.sources.state,
      hostAuth: value.sources.hostAuth,
    },
  }
}

export async function readNativeMigrationJournal(
  paths: NativePoolPaths,
): Promise<NativeMigrationJournal | undefined> {
  let text: string
  try {
    text = await readFile(paths.journal, 'utf8')
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return undefined
    throw new NativeAuthorityError('invalid-journal')
  }
  try {
    return decodeJournal(parseJsonRedacted(text), paths.storageId)
  } catch {
    throw new NativeAuthorityError('invalid-journal')
  }
}

/** An empty or readable store is not proof that the offline authority flip completed. */
export async function requireNativePoolAuthority(
  paths: NativePoolPaths,
): Promise<void> {
  const journal = await readNativeMigrationJournal(paths)
  if (!journal) throw new NativeAuthorityError('migration-required')
  if (journal.phase !== 'committed' && journal.phase !== 'retired') {
    throw new NativeAuthorityError('migration-incomplete')
  }
}

interface JournalHooks {
  lockOptions?: { ttlMs: number; timeoutMs: number }
  onWriteStep?: (
    step: 'before-write' | 'after-write',
    journal: NativeMigrationJournal,
  ) => Promise<void>
}

async function writeJournal(
  paths: NativePoolPaths,
  journal: NativeMigrationJournal,
  assertOwned: () => Promise<void>,
  hooks: JournalHooks,
): Promise<void> {
  await writeJsonAtomic(paths.journal, journal, {
    beforeRename: async () => {
      await hooks.onWriteStep?.('before-write', journal)
      await assertOwned()
    },
  })
  await hooks.onWriteStep?.('after-write', journal)
}

/** Existing source baselines cannot be replaced by a new migration attempt. */
export async function beginNativeMigration(
  paths: NativePoolPaths,
  input: { host: 'opencode' | 'pi'; sources: NativeMigrationSources },
  hooks: JournalHooks = {},
): Promise<NativeMigrationJournal> {
  const initial = decodeJournal(
    {
      version: 1,
      storageId: paths.storageId,
      host: input.host,
      phase: 'building',
      sources: input.sources,
    },
    paths.storageId,
  )
  return withLock(
    paths.journal,
    {
      name: 'migration-journal',
      ttlMs: 30_000,
      timeoutMs: 15_000,
      ...hooks.lockOptions,
      renew: true,
    },
    async (lock) => {
      const current = await readNativeMigrationJournal(paths)
      if (current) {
        if (
          current.host !== initial.host ||
          JSON.stringify(current.sources) !== JSON.stringify(initial.sources)
        ) {
          throw new NativeAuthorityError('journal-conflict')
        }
        return current
      }
      await writeJournal(paths, initial, () => lock.assertOwned(), hooks)
      return initial
    },
  )
}

/** Only the immediately following phase may be committed; retries are idempotent. */
export async function advanceNativeMigration(
  paths: NativePoolPaths,
  expected: NativeMigrationPhase,
  next: NativeMigrationPhase,
  hooks: JournalHooks = {},
): Promise<NativeMigrationJournal> {
  if (
    !isPhase(expected) ||
    !isPhase(next) ||
    PHASES.indexOf(next) !== PHASES.indexOf(expected) + 1
  )
    throw new NativeAuthorityError('journal-conflict')
  return withLock(
    paths.journal,
    {
      name: 'migration-journal',
      ttlMs: 30_000,
      timeoutMs: 15_000,
      ...hooks.lockOptions,
      renew: true,
    },
    async (lock) => {
      const current = await readNativeMigrationJournal(paths)
      if (!current) throw new NativeAuthorityError('migration-required')
      if (current.phase === next) return current
      if (current.phase !== expected)
        throw new NativeAuthorityError('journal-conflict')
      const updated = { ...current, phase: next }
      await writeJournal(paths, updated, () => lock.assertOwned(), hooks)
      return updated
    },
  )
}
