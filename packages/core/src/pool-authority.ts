import { readFile } from 'node:fs/promises'
import { isAbsolute, normalize, parse, sep } from 'node:path'
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
  /** SHA-256 of the host's anthropic entry with sorted JSON object keys; other providers are excluded. */
  hostAuth: string
  routing: string | null
}

export interface NativeMigrationRoutingPaths {
  source: string
  destination: string
}

export interface NativeMigrationInput {
  host: 'opencode' | 'pi'
  sources: NativeMigrationSources
  routingPaths: NativeMigrationRoutingPaths
  hostAuthPath: string
}

export interface NativeMigrationExpectations {
  expectedHostAuth: string
  expectedRouting: string | null
}

export interface NativeMigrationJournal {
  version: 2
  storageId: string
  host: 'opencode' | 'pi'
  phase: NativeMigrationPhase
  sources: NativeMigrationSources
  routingPaths: NativeMigrationRoutingPaths
  hostAuthPath: string
  expectedHostAuth: string
  expectedRouting: string | null
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

function hasKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return (
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  )
}

function isDigest(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length === 64 &&
    /^[a-f0-9]{64}$/.test(value)
  )
}

function isFileDigest(value: unknown): value is string | null {
  return value === null || isDigest(value)
}

function isHostEntry(value: unknown): value is string {
  return value === 'absent' || isDigest(value)
}

/** Check path syntax only; callers resolve symlinks and path aliases and recheck the captured file paths before writing. */
function isCapturedPath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    isAbsolute(value) &&
    !/\p{Cc}/u.test(value) &&
    !value.endsWith(sep) &&
    normalize(value) === value &&
    // A Windows rooted path without a drive/share still depends on ambient state.
    (sep !== '\\' || parse(value).root !== sep) &&
    !value.split(sep).some((part) => part === '.' || part === '..')
  )
}

function isSources(value: unknown): value is NativeMigrationSources {
  return (
    isRecord(value) &&
    hasKeys(value, ['config', 'state', 'hostAuth', 'routing']) &&
    isFileDigest(value.config) &&
    isFileDigest(value.state) &&
    isHostEntry(value.hostAuth) &&
    isFileDigest(value.routing)
  )
}

function isRoutingPaths(value: unknown): value is NativeMigrationRoutingPaths {
  return (
    isRecord(value) &&
    hasKeys(value, ['source', 'destination']) &&
    isCapturedPath(value.source) &&
    isCapturedPath(value.destination)
  )
}

function decodeJournal(
  value: unknown,
  storageId: string,
): NativeMigrationJournal {
  if (
    !isRecord(value) ||
    !hasKeys(value, [
      'version',
      'storageId',
      'host',
      'phase',
      'sources',
      'routingPaths',
      'hostAuthPath',
      'expectedHostAuth',
      'expectedRouting',
    ]) ||
    value.version !== 2 ||
    value.storageId !== storageId ||
    (value.host !== 'opencode' && value.host !== 'pi') ||
    !isPhase(value.phase) ||
    !isSources(value.sources) ||
    !isRoutingPaths(value.routingPaths) ||
    !isCapturedPath(value.hostAuthPath) ||
    (value.expectedHostAuth !== 'unprepared' &&
      !isHostEntry(value.expectedHostAuth)) ||
    (value.expectedRouting !== 'unprepared' &&
      !isFileDigest(value.expectedRouting))
  ) {
    throw new NativeAuthorityError('invalid-journal')
  }
  const unprepared = value.expectedHostAuth === 'unprepared'
  if (
    unprepared !== (value.expectedRouting === 'unprepared') ||
    (value.phase === 'building' && !unprepared) ||
    (value.phase !== 'building' && value.phase !== 'verified' && unprepared) ||
    (!unprepared &&
      (value.sources.routing === null) !== (value.expectedRouting === null))
  ) {
    throw new NativeAuthorityError('invalid-journal')
  }
  return {
    version: 2,
    storageId,
    host: value.host,
    phase: value.phase,
    sources: {
      config: value.sources.config,
      state: value.sources.state,
      hostAuth: value.sources.hostAuth,
      routing: value.sources.routing,
    },
    routingPaths: {
      source: value.routingPaths.source,
      destination: value.routingPaths.destination,
    },
    hostAuthPath: value.hostAuthPath,
    expectedHostAuth: value.expectedHostAuth,
    expectedRouting: value.expectedRouting,
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

/** Migration resume retains the original digests and resolved paths so a retry cannot adopt changed inputs or redirect writes. */
export async function beginNativeMigration(
  paths: NativePoolPaths,
  input: NativeMigrationInput,
  hooks: JournalHooks = {},
): Promise<NativeMigrationJournal> {
  const initial = decodeJournal(
    {
      version: 2,
      storageId: paths.storageId,
      host: input.host,
      phase: 'building',
      sources: input.sources,
      routingPaths: input.routingPaths,
      hostAuthPath: input.hostAuthPath,
      expectedHostAuth: 'unprepared',
      expectedRouting: 'unprepared',
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
          current.sources.config !== initial.sources.config ||
          current.sources.state !== initial.sources.state ||
          current.sources.hostAuth !== initial.sources.hostAuth ||
          current.sources.routing !== initial.sources.routing ||
          current.routingPaths.source !== initial.routingPaths.source ||
          current.routingPaths.destination !==
            initial.routingPaths.destination ||
          current.hostAuthPath !== initial.hostAuthPath
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

/** Save the expected host-auth entry and routing digests together before changing files, so recovery can recognize completed writes. */
export async function recordNativeMigrationExpectations(
  paths: NativePoolPaths,
  expectations: NativeMigrationExpectations,
  hooks: JournalHooks = {},
): Promise<NativeMigrationJournal> {
  if (
    !isRecord(expectations) ||
    !hasKeys(expectations, ['expectedHostAuth', 'expectedRouting']) ||
    !isHostEntry(expectations.expectedHostAuth) ||
    !isFileDigest(expectations.expectedRouting)
  ) {
    throw new NativeAuthorityError('invalid-journal')
  }
  // Capture values before waiting for the lock; callers cannot change the pair
  // between validation and publication by mutating their input object.
  const { expectedHostAuth, expectedRouting } = expectations
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
      if (
        current.phase !== 'verified' ||
        (current.sources.routing === null) !== (expectedRouting === null)
      ) {
        throw new NativeAuthorityError('journal-conflict')
      }
      if (current.expectedHostAuth !== 'unprepared') {
        if (
          current.expectedHostAuth !== expectedHostAuth ||
          current.expectedRouting !== expectedRouting
        ) {
          throw new NativeAuthorityError('journal-conflict')
        }
        return current
      }
      const updated = { ...current, expectedHostAuth, expectedRouting }
      await writeJournal(paths, updated, () => lock.assertOwned(), hooks)
      return updated
    },
  )
}

/**
 * Advance one phase at a time. A retry of the same transition returns the journal.
 * Before recording activation, the caller must compare the host's Anthropic auth
 * entry and routing file with the saved expected values. This journal records the
 * migration stage; it does not read or verify those files.
 */
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
      if (
        next === 'activation-installed' &&
        current.expectedHostAuth === 'unprepared'
      )
        throw new NativeAuthorityError('journal-conflict')
      const updated = { ...current, phase: next }
      await writeJournal(paths, updated, () => lock.assertOwned(), hooks)
      return updated
    },
  )
}
