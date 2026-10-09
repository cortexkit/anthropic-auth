import { isAbsolute, normalize, parse, sep } from 'node:path'
import { withLock, writeJsonAtomic } from '@cortexkit/common-auth/fs'

import { readNativeMigrationSource } from './migration-source.ts'
import {
  captureNativeMigrationJson,
  decodeNativeMigrationPreparedProof,
  type NativeMigrationPreparedProof,
  nativeMigrationCanonicalJson,
  requireNativeMigrationDataObject,
} from './native-migration-proof.ts'
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
  /**
   * Request vault custody during the first credential migration. The journal
   * keeps native serving blocked until the separate vault activation commits.
   */
  activation?: 'requested'
}

export interface NativeMigrationExpectations {
  expectedHostAuth: string
  expectedRouting: string | null
  preparedProof: NativeMigrationPreparedProof
}

/** Public account metadata recorded for the planned switch to vault custody. */
export interface NativeCustodyActivationRosterRow {
  routeId: string
  credentialId: string
  credentialType: 'oauth'
  accountIdentity: string
  state: string
  label: string
  enabled: boolean
  addedAt: number
}

/** The validated vault account list that activation publishes or reuses unchanged. */
export interface NativeCustodyActivationRoster {
  version: 1
  view: string
  complete: true
  rows: NativeCustodyActivationRosterRow[]
  declined: { credentialId: string; accountIdentity?: string }[]
}

export type NativeCustodyActivationPhase =
  | 'prepared'
  | 'published'
  | 'committed'

/**
 * The offline switch of a migrated pool from local to vault custody. Every
 * field is fixed when the activation is prepared, so a resumed run checks the
 * files against these values and never against what it finds on disk later.
 * Holds no credential: only public descriptor digests and vault ids.
 */
export interface NativeCustodyActivationPlan {
  kind: 'activation'
  phase: NativeCustodyActivationPhase
  /** The vault's designated primary login, bound to the pool's main route. */
  primary: { routeId: string; credentialId: string; accountIdentity: string }
  roster: NativeCustodyActivationRoster
  /**
   * Every credential row captured before this custody switch, including local
   * OAuth and API-key accounts, with a digest of the imported runtime state.
   */
  localProof: NativeMigrationPreparedProof
  /**
   * IDs of local OAuth credential rows to remove. Keep every other row
   * recorded in localProof.
   */
  removeIds: string[]
  /** Digests of the canonical pool settings before and after the mode switch. */
  settings: { source: string; target: string }
  /** Digests of the canonical native runtime state before and after rebinding. */
  runtime: { source: string; target: string }
  /** Anthropic host-auth entry digests (or 'absent') before and after activation. */
  hostAuth: { source: string; expected: string }
}

export type NativeCustodyActivation =
  | { kind: 'requested' }
  | NativeCustodyActivationPlan

export interface NativeMigrationJournal {
  version: 4
  storageId: string
  host: 'opencode' | 'pi'
  phase: NativeMigrationPhase
  sources: NativeMigrationSources
  routingPaths: NativeMigrationRoutingPaths
  hostAuthPath: string
  expectedHostAuth: string
  expectedRouting: string | null
  preparedProof: NativeMigrationPreparedProof | null
  /**
   * Null unless the offline setup command requested or began switching
   * credential authority to Claustrum.
   */
  activation: NativeCustodyActivation | null
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

function captureJournalJson(value: unknown): unknown {
  try {
    return captureNativeMigrationJson(value)
  } catch {
    throw new NativeAuthorityError('invalid-journal')
  }
}

function decodePreparedProof(value: unknown): NativeMigrationPreparedProof {
  try {
    return decodeNativeMigrationPreparedProof(value)
  } catch {
    throw new NativeAuthorityError('invalid-journal')
  }
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

function isText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function decodeRoster(value: unknown): NativeCustodyActivationRoster {
  if (
    !isRecord(value) ||
    !hasKeys(value, ['version', 'view', 'complete', 'rows', 'declined']) ||
    value.version !== 1 ||
    !isText(value.view) ||
    value.complete !== true ||
    !Array.isArray(value.rows) ||
    !Array.isArray(value.declined)
  )
    throw new NativeAuthorityError('invalid-journal')
  const rows = value.rows.map((row): NativeCustodyActivationRosterRow => {
    if (
      !isRecord(row) ||
      !hasKeys(row, [
        'routeId',
        'credentialId',
        'credentialType',
        'accountIdentity',
        'state',
        'label',
        'enabled',
        'addedAt',
      ]) ||
      !isText(row.routeId) ||
      !isText(row.credentialId) ||
      row.credentialType !== 'oauth' ||
      !isText(row.accountIdentity) ||
      !isText(row.state) ||
      typeof row.label !== 'string' ||
      typeof row.enabled !== 'boolean' ||
      typeof row.addedAt !== 'number' ||
      !Number.isFinite(row.addedAt)
    )
      throw new NativeAuthorityError('invalid-journal')
    return {
      routeId: row.routeId,
      credentialId: row.credentialId,
      credentialType: 'oauth',
      accountIdentity: row.accountIdentity,
      state: row.state,
      label: row.label,
      enabled: row.enabled,
      addedAt: row.addedAt,
    }
  })
  const declined = value.declined.map((entry) => {
    if (
      !isRecord(entry) ||
      !isText(entry.credentialId) ||
      !(
        hasKeys(entry, ['credentialId']) ||
        (hasKeys(entry, ['credentialId', 'accountIdentity']) &&
          isText(entry.accountIdentity))
      )
    )
      throw new NativeAuthorityError('invalid-journal')
    return isText(entry.accountIdentity)
      ? {
          credentialId: entry.credentialId,
          accountIdentity: entry.accountIdentity,
        }
      : { credentialId: entry.credentialId }
  })
  if (new Set(rows.map((row) => row.routeId)).size !== rows.length)
    throw new NativeAuthorityError('invalid-journal')
  return { version: 1, view: value.view, complete: true, rows, declined }
}

function decodeDigestPair<K extends string>(
  value: unknown,
  keys: readonly [K, K],
  valid: (item: unknown) => boolean,
): Record<K, string> {
  if (
    !isRecord(value) ||
    !hasKeys(value, [...keys]) ||
    !keys.every((key) => valid(value[key]))
  )
    throw new NativeAuthorityError('invalid-journal')
  return Object.fromEntries(keys.map((key) => [key, value[key]])) as Record<
    K,
    string
  >
}

const ACTIVATION_PHASES = ['prepared', 'published', 'committed'] as const

function decodeActivation(
  value: unknown,
  phase: NativeMigrationPhase,
): NativeCustodyActivation | null {
  if (value === null) return null
  if (!isRecord(value)) throw new NativeAuthorityError('invalid-journal')
  if (value.kind === 'requested' && hasKeys(value, ['kind']))
    return { kind: 'requested' }
  if (
    value.kind !== 'activation' ||
    // A switch is prepared only on a migration that already finished.
    phase !== 'retired' ||
    !hasKeys(value, [
      'kind',
      'phase',
      'primary',
      'roster',
      'localProof',
      'removeIds',
      'settings',
      'runtime',
      'hostAuth',
    ]) ||
    !ACTIVATION_PHASES.some((item) => item === value.phase) ||
    !isRecord(value.primary) ||
    !hasKeys(value.primary, ['routeId', 'credentialId', 'accountIdentity']) ||
    !isText(value.primary.routeId) ||
    !isText(value.primary.credentialId) ||
    !isText(value.primary.accountIdentity) ||
    !Array.isArray(value.removeIds) ||
    !value.removeIds.every(isText)
  )
    throw new NativeAuthorityError('invalid-journal')
  const primary = {
    routeId: value.primary.routeId,
    credentialId: value.primary.credentialId,
    accountIdentity: value.primary.accountIdentity,
  }
  const roster = decodeRoster(value.roster)
  const localProof = decodePreparedProof(value.localProof)
  const removeIds = [...value.removeIds] as string[]
  const proofIds = new Set(localProof.rows.map((row) => row.id))
  if (
    removeIds.some(
      (id, index) =>
        !proofIds.has(id) || (index > 0 && (removeIds[index - 1] ?? '') >= id),
    ) ||
    !roster.rows.some(
      (row) =>
        row.routeId === primary.routeId &&
        row.credentialId === primary.credentialId &&
        row.accountIdentity === primary.accountIdentity,
    )
  )
    throw new NativeAuthorityError('invalid-journal')
  return {
    kind: 'activation',
    phase: value.phase as NativeCustodyActivationPhase,
    primary,
    roster,
    localProof,
    removeIds,
    settings: decodeDigestPair(value.settings, ['source', 'target'], isDigest),
    runtime: decodeDigestPair(value.runtime, ['source', 'target'], isDigest),
    hostAuth: decodeDigestPair(
      value.hostAuth,
      ['source', 'expected'],
      isHostEntry,
    ),
  }
}

function decodeJournal(
  input: unknown,
  storageId: string,
): NativeMigrationJournal {
  const value = captureJournalJson(input)
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
      'preparedProof',
      'activation',
    ]) ||
    value.version !== 4 ||
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
  const preparedProof =
    value.preparedProof === null
      ? null
      : decodePreparedProof(value.preparedProof)
  if (
    unprepared !== (value.expectedRouting === 'unprepared') ||
    unprepared !== (preparedProof === null) ||
    (value.phase === 'building' && !unprepared) ||
    (value.phase !== 'building' && value.phase !== 'verified' && unprepared) ||
    (!unprepared &&
      (value.sources.routing === null) !== (value.expectedRouting === null))
  ) {
    throw new NativeAuthorityError('invalid-journal')
  }
  return {
    version: 4,
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
    preparedProof,
    activation: decodeActivation(value.activation, value.phase),
  }
}

export async function readNativeMigrationJournal(
  paths: NativePoolPaths,
): Promise<NativeMigrationJournal | undefined> {
  try {
    const snapshot = await readNativeMigrationSource('journal', paths.journal)
    if (!snapshot.data) return undefined
    if (
      !snapshot.metadata ||
      (snapshot.metadata.mode & 0o777) !== 0o600 ||
      (process.getuid && snapshot.metadata.uid !== process.getuid())
    )
      throw new NativeAuthorityError('invalid-journal')
    return decodeJournal(snapshot.data, paths.storageId)
  } catch {
    throw new NativeAuthorityError('invalid-journal')
  }
}

/**
 * The migration phase that authorizes serving, or undefined while the
 * migration or a requested switch to vault custody is unfinished. Every reader
 * that admits requests from the journal uses this one predicate.
 */
export function nativeMigrationAuthorityPhase(
  journal: NativeMigrationJournal | undefined,
): 'committed' | 'retired' | undefined {
  if (!journal) return undefined
  if (journal.phase !== 'committed' && journal.phase !== 'retired')
    return undefined
  if (
    journal.activation !== null &&
    (journal.activation.kind !== 'activation' ||
      journal.activation.phase !== 'committed')
  )
    return undefined
  return journal.phase
}

/** An empty or readable store is not proof that the offline authority flip completed. */
export async function requireNativePoolAuthority(
  paths: NativePoolPaths,
): Promise<void> {
  const journal = await readNativeMigrationJournal(paths)
  if (!journal) throw new NativeAuthorityError('migration-required')
  if (!nativeMigrationAuthorityPhase(journal)) {
    throw new NativeAuthorityError('migration-incomplete')
  }
}

interface JournalHooks {
  /** Outer controller and pool leases remain held through the atomic journal rename. */
  assertOwned?: () => Promise<void>
  lockOptions?: { ttlMs: number; timeoutMs: number }
  onWriteStep?: (
    step: 'before-write' | 'after-write',
    journal: NativeMigrationJournal,
  ) => Promise<void>
}

function deepFreeze(value: unknown): void {
  if (value === null || typeof value !== 'object') return
  for (const item of Object.values(value)) deepFreeze(item)
  Object.freeze(value)
}

async function writeJournal(
  paths: NativePoolPaths,
  journal: NativeMigrationJournal,
  assertOwned: () => Promise<void>,
  hooks: JournalHooks,
): Promise<void> {
  // Hooks observe a detached immutable value, not the object the controller will
  // use for its next phase. A hook cannot alter the proof being published.
  const snapshot = decodeJournal(journal, paths.storageId)
  if (snapshot.preparedProof) {
    for (const row of snapshot.preparedProof.rows) Object.freeze(row)
    Object.freeze(snapshot.preparedProof.rows)
    Object.freeze(snapshot.preparedProof)
  }
  Object.freeze(snapshot.sources)
  Object.freeze(snapshot.routingPaths)
  deepFreeze(snapshot.activation)
  Object.freeze(snapshot)
  await writeJsonAtomic(paths.journal, snapshot, {
    beforeRename: async () => {
      await hooks.onWriteStep?.('before-write', snapshot)
      await hooks.assertOwned?.()
      await assertOwned()
    },
  })
  await hooks.onWriteStep?.('after-write', snapshot)
}

/** Migration resume retains the original digests and resolved paths so a retry cannot adopt changed inputs or redirect writes. */
export async function beginNativeMigration(
  paths: NativePoolPaths,
  input: NativeMigrationInput,
  hooks: JournalHooks = {},
): Promise<NativeMigrationJournal> {
  try {
    requireNativeMigrationDataObject(input)
  } catch {
    throw new NativeAuthorityError('invalid-journal')
  }
  const initial = decodeJournal(
    {
      version: 4,
      storageId: paths.storageId,
      host: input.host,
      phase: 'building',
      sources: input.sources,
      routingPaths: input.routingPaths,
      hostAuthPath: input.hostAuthPath,
      expectedHostAuth: 'unprepared',
      expectedRouting: 'unprepared',
      preparedProof: null,
      activation:
        input.activation === undefined
          ? null
          : input.activation === 'requested'
            ? { kind: 'requested' }
            : 'invalid',
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
          current.hostAuthPath !== initial.hostAuthPath ||
          (current.activation === null) !== (initial.activation === null)
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
  const captured = captureJournalJson(expectations)
  if (
    !isRecord(captured) ||
    !hasKeys(captured, [
      'expectedHostAuth',
      'expectedRouting',
      'preparedProof',
    ]) ||
    !isHostEntry(captured.expectedHostAuth) ||
    !isFileDigest(captured.expectedRouting)
  ) {
    throw new NativeAuthorityError('invalid-journal')
  }
  // Capture values before waiting for the lock; callers cannot change the pair
  // between validation and publication by mutating their input object.
  const { expectedHostAuth, expectedRouting } = captured
  const preparedProof = decodePreparedProof(captured.preparedProof)
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
          current.expectedRouting !== expectedRouting ||
          nativeMigrationCanonicalJson(current.preparedProof) !==
            nativeMigrationCanonicalJson(preparedProof)
        ) {
          throw new NativeAuthorityError('journal-conflict')
        }
        return current
      }
      const updated = {
        ...current,
        expectedHostAuth,
        expectedRouting,
        preparedProof,
      }
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

function journalLock(hooks: JournalHooks) {
  return {
    name: 'migration-journal',
    ttlMs: 30_000,
    timeoutMs: 15_000,
    ...hooks.lockOptions,
    renew: true,
  }
}

/**
 * Record the prepared switch to vault custody on a retired migration. From
 * this write until the activation commits, the pool authorizes no serving.
 * Retrying with the identical plan returns the journal; any other plan is a
 * conflict, so a resumed setup can never replace what it recorded.
 */
export async function recordNativeCustodyActivation(
  paths: NativePoolPaths,
  plan: NativeCustodyActivationPlan,
  hooks: JournalHooks = {},
): Promise<NativeMigrationJournal> {
  const captured = captureJournalJson(plan)
  if (!isRecord(captured) || captured.phase !== 'prepared')
    throw new NativeAuthorityError('journal-conflict')
  const decoded = decodeActivation(captured, 'retired')
  if (decoded?.kind !== 'activation')
    throw new NativeAuthorityError('invalid-journal')
  return withLock(paths.journal, journalLock(hooks), async (lock) => {
    const current = await readNativeMigrationJournal(paths)
    if (!current) throw new NativeAuthorityError('migration-required')
    if (current.phase !== 'retired')
      throw new NativeAuthorityError('journal-conflict')
    if (current.activation?.kind === 'activation') {
      if (
        nativeMigrationCanonicalJson({ ...current.activation, phase: '' }) !==
        nativeMigrationCanonicalJson({ ...decoded, phase: '' })
      )
        throw new NativeAuthorityError('journal-conflict')
      return current
    }
    const updated = { ...current, activation: decoded }
    await writeJournal(paths, updated, () => lock.assertOwned(), hooks)
    return updated
  })
}

/** Advance a recorded activation one phase; never backwards or across a phase. */
export async function advanceNativeCustodyActivation(
  paths: NativePoolPaths,
  expected: NativeCustodyActivationPhase,
  next: NativeCustodyActivationPhase,
  hooks: JournalHooks = {},
): Promise<NativeMigrationJournal> {
  if (
    ACTIVATION_PHASES.indexOf(next) !==
      ACTIVATION_PHASES.indexOf(expected) + 1 ||
    ACTIVATION_PHASES.indexOf(expected) < 0
  )
    throw new NativeAuthorityError('journal-conflict')
  return withLock(paths.journal, journalLock(hooks), async (lock) => {
    const current = await readNativeMigrationJournal(paths)
    if (!current) throw new NativeAuthorityError('migration-required')
    const activation = current.activation
    if (activation?.kind !== 'activation')
      throw new NativeAuthorityError('journal-conflict')
    if (activation.phase === next) return current
    if (activation.phase !== expected)
      throw new NativeAuthorityError('journal-conflict')
    const updated = { ...current, activation: { ...activation, phase: next } }
    await writeJournal(paths, updated, () => lock.assertOwned(), hooks)
    return updated
  })
}
