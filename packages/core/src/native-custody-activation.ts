import {
  mutateVaultRoster,
  readVaultRoster,
  type VaultRosterFile,
} from '@cortexkit/common-auth/claustrum'
import { withLock } from '@cortexkit/common-auth/fs'
import {
  POOL_LOCK_DEFAULTS,
  PoolOperationError,
  type PoolRow,
} from '@cortexkit/common-auth/store'

import { custodyTombstoneOAuth } from './claustrum.ts'
import { readNativeMigrationSource } from './migration-source.ts'
import { NATIVE_PRIMARY_CREDENTIAL_ID } from './native-account-view.ts'
import type { NativeCustodyInventory } from './native-custody.ts'
import {
  inspectNativeHostAuthEntry,
  requireNoSupervisedAuthContentSnapshot,
} from './native-host-auth.ts'
import {
  type NativeHostAuthWriteHooks,
  writeNativeHostAuth,
} from './native-host-auth-write.ts'
import { importedRuntimeProjection } from './native-migration.ts'
import {
  captureNativeMigrationPreparedProof,
  type NativeMigrationRowProof,
  nativeMigrationCanonicalJson,
  nativeMigrationCredentialDigest,
  nativeMigrationDigest,
  requireNativeMigrationPreparedProof,
} from './native-migration-proof.ts'
import { nativeQuotaCodec } from './native-quota-codec.ts'
import {
  buildNativeVaultRosterSeed,
  type NativeRosterSeedInput,
  validateNativeVaultRosterSeed,
} from './native-roster-seed.ts'
import {
  decodeNativeRuntime,
  type NativeRuntimeEntry,
  type NativeRuntimeState,
  readNativeRuntime,
} from './native-runtime.ts'
import { publishNativeVaultRuntimeSeed } from './native-vault-runtime.ts'
import {
  advanceNativeCustodyActivation,
  type NativeCustodyActivationPlan,
  type NativeCustodyActivationRoster,
  type NativeMigrationJournal,
  readNativeMigrationJournal,
  recordNativeCustodyActivation,
} from './pool-authority.ts'
import type { NativePoolPaths } from './pool-paths.ts'
import { createNativePoolStore, nativePoolStoreLocks } from './pool-store.ts'

export type NativeCustodyActivationErrorCode =
  | 'migration-required'
  | 'invalid-state'
  | 'primary-missing'
  | 'primary-mismatch'
  | 'primary-unverified'
  | 'primary-conflict'
  | 'row-unverified'
  | 'unenrolled-local-row'
  | 'vault-ambiguous'
  | 'roster-conflict'
  | 'runtime-conflict'
  | 'settings-conflict'
  | 'credential-changed'
  | 'host-auth-changed'
  | 'consent-required'
  | 'migration-busy'
  | 'ownership-lost'
  | 'auth-content-refused'
  | 'process-fence-refused'
  | 'migration-proof-changed'

export class NativeCustodyActivationError extends Error {
  constructor(public readonly code: NativeCustodyActivationErrorCode) {
    super(`Native vault activation: ${code}`)
    this.name = 'NativeCustodyActivationError'
  }
}

export interface NativeCustodyActivationOptions {
  paths: NativePoolPaths
  host: 'opencode' | 'pi'
  env: NodeJS.ProcessEnv
  /** Rejects unless every selected host is stopped and inspection succeeded. */
  processFence: () => Promise<void>
  /**
   * The user's explicit consent to delete a stored Pi Anthropic OAuth entry.
   * It never authorizes deleting a Pi API key, which always refuses.
   */
  removePiAnthropicAuth: boolean
  /**
   * Lists the vault accounts this host's enrollment token may read; called
   * only while preparing the activation.
   */
  discover: () => Promise<NativeCustodyInventory>
}

export interface NativeCustodyActivationHooks {
  /**
   * Test hook for simulated crashes and lease loss. Receives a label naming
   * the activation step about to run or just finished, never account data.
   */
  onStep?: (step: string) => Promise<void>
  hostWrite?: NativeHostAuthWriteHooks
  store?: Pick<
    Parameters<typeof createNativePoolStore>[0],
    'onStep' | 'onLockStep'
  >
}

export type NativeCustodyActivationResult =
  | { status: 'already-vault'; journal: NativeMigrationJournal }
  | { status: 'committed'; journal: NativeMigrationJournal }

type Lease = { assertOwned: () => Promise<void> }

function refuse(code: NativeCustodyActivationErrorCode): never {
  throw new NativeCustodyActivationError(code)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function sameJson(left: unknown, right: unknown): boolean {
  return (
    nativeMigrationCanonicalJson(left) === nativeMigrationCanonicalJson(right)
  )
}

/**
 * Proof rows of the current pool. Refuses a row caught between the two file
 * writes of another operation (torn), a row whose credential stamp does not
 * match its credential (unbound), and an invalid row.
 */
function proofRows(rows: readonly PoolRow[]): NativeMigrationRowProof[] {
  try {
    return captureNativeMigrationPreparedProof(rows, null).rows
  } catch {
    return refuse('credential-changed')
  }
}

/**
 * The closed, secret-free roster projection the activation compares. The
 * roster seed this activation (or a first migration) publishes never contains
 * aliases, email, quota, stale markers or rejected records, so any of them
 * means vault discovery or another writer changed the roster.
 */
function rosterProjection(
  file: VaultRosterFile | undefined,
): NativeCustodyActivationRoster | undefined {
  if (!file) return undefined
  if (
    file.version !== 1 ||
    file.complete !== true ||
    typeof file.view !== 'string' ||
    !file.view ||
    (file.rejected !== undefined && file.rejected.length > 0)
  )
    refuse('roster-conflict')
  const rows = file.rows.map((row) => {
    if (
      row.credentialType !== 'oauth' ||
      !row.accountIdentity ||
      row.aliases !== undefined ||
      row.email !== undefined ||
      row.orgName !== undefined ||
      row.quota !== undefined ||
      row.stale !== undefined ||
      row.unclaimed !== undefined
    )
      refuse('roster-conflict')
    return {
      routeId: row.routeId,
      credentialId: row.credentialId,
      credentialType: 'oauth' as const,
      accountIdentity: row.accountIdentity,
      state: row.state,
      label: row.label,
      enabled: row.enabled,
      addedAt: row.addedAt,
    }
  })
  return {
    version: 1,
    view: file.view,
    complete: true,
    rows,
    declined: file.declined.map((entry) =>
      entry.accountIdentity
        ? {
            credentialId: entry.credentialId,
            accountIdentity: entry.accountIdentity,
          }
        : { credentialId: entry.credentialId },
    ),
  }
}

async function readRoster(
  paths: NativePoolPaths,
): Promise<NativeCustodyActivationRoster | undefined> {
  // Reject a roster owned by another user or replaced by a symbolic link
  // before the public reader parses it.
  const source = await readNativeMigrationSource('state', paths.roster)
  if (
    source.metadata &&
    process.getuid &&
    source.metadata.uid !== process.getuid()
  )
    refuse('roster-conflict')
  if (!source.data) return undefined
  const file = await readVaultRoster(paths.roster)
  if (!file) refuse('roster-conflict')
  return rosterProjection(file)
}

async function readRuntime(
  paths: NativePoolPaths,
): Promise<NativeRuntimeState> {
  const read = await readNativeRuntime(paths.runtime, paths.storageId)
  if (read.status !== 'ready') refuse('runtime-conflict')
  return read.state
}

function hostEntry(
  host: 'opencode' | 'pi',
  data: unknown,
): ReturnType<typeof inspectNativeHostAuthEntry> {
  try {
    return inspectNativeHostAuthEntry(host, data)
  } catch {
    return refuse('host-auth-changed')
  }
}

async function readHostEntry(host: 'opencode' | 'pi', path: string) {
  const source = await readNativeMigrationSource('hostAuth', path)
  if (
    source.metadata &&
    process.getuid &&
    source.metadata.uid !== process.getuid()
  )
    refuse('host-auth-changed')
  return hostEntry(host, source.data)
}

const TOMBSTONE_DIGEST = inspectNativeHostAuthEntry('opencode', {
  anthropic: custodyTombstoneOAuth('anthropic'),
}).digest

/**
 * Runtime fields that describe the Claude account rather than one credential.
 * They follow the account to its vault route. A local re-login of the same
 * account, which starts a new credential epoch, keeps exactly this set too.
 */
const ACCOUNT_RUNTIME_FIELDS = [
  'prime',
  'profile',
  'lastUsed',
  'lastQuotaRefreshError',
  'quotaErrorClearedAt',
  'quotaErrorGeneration',
] as const

function vaultSettings(
  settings: Record<string, unknown>,
  primary: NativeCustodyActivationPlan['primary'],
): Record<string, unknown> {
  const custody = isRecord(settings.claustrum) ? settings.claustrum : {}
  return {
    ...settings,
    claustrum: {
      ...custody,
      mode: 'claustrum',
      primaryAccount: {
        credentialId: primary.credentialId,
        accountId: primary.accountIdentity,
      },
    },
  }
}

function sameCustodyBinding(
  entry: NativeRuntimeEntry,
  paths: NativePoolPaths,
  routeId: string,
  row: { credentialId: string; accountIdentity: string },
): boolean {
  const binding = entry.binding
  return (
    binding.kind === 'custody' &&
    binding.storageId === paths.storageId &&
    binding.routeId === routeId &&
    binding.credentialId === row.credentialId &&
    binding.accountIdentity === row.accountIdentity
  )
}

/**
 * Rebind runtime metadata from local pool rows to their vault routes. An entry
 * moves only from the exact local binding of the verified row (same row id,
 * credential epoch and account UUID) to the vault row for that same UUID;
 * anything else about that row is dropped, never attributed elsewhere.
 * Existing vault bindings must already match the prepared roster.
 */
function targetRuntime(
  paths: NativePoolPaths,
  source: NativeRuntimeState,
  rows: readonly PoolRow[],
  removeIds: readonly string[],
  roster: NativeCustodyActivationRoster,
  primary: NativeCustodyActivationPlan['primary'],
): NativeRuntimeState {
  const next: Record<string, NativeRuntimeEntry> = Object.create(null)
  const routes = new Set([...removeIds, primary.routeId])
  for (const [id, entry] of Object.entries(source.accounts)) {
    if (entry.binding.kind !== 'custody') {
      next[id] = entry
      continue
    }
    const row = roster.rows.find((item) => item.routeId === id)
    if (!row || !sameCustodyBinding(entry, paths, id, row))
      refuse('runtime-conflict')
    next[id] = entry
  }
  for (const id of routes) {
    const existing = source.accounts[id]
    const row = rows.find((item) => item.id === id)
    if (!row) {
      // Only a main route with no local row (fresh install, or a host-managed
      // API key) reaches here; it has no local metadata to move.
      if (id !== primary.routeId || removeIds.includes(id))
        refuse('runtime-conflict')
      if (existing && existing.binding.kind !== 'custody')
        refuse('runtime-conflict')
      continue
    }
    if (existing?.binding.kind === 'custody') continue
    const vault = roster.rows.find((item) => item.routeId === id)
    if (
      !vault ||
      row.credential?.type !== 'oauth' ||
      !row.identity ||
      vault.accountIdentity !== row.identity ||
      row.credentialEpoch === undefined
    )
      refuse('runtime-conflict')
    const binding = existing?.binding
    const exact =
      binding?.kind === 'local' &&
      binding.storageId === paths.storageId &&
      binding.rowId === row.id &&
      binding.credentialEpoch === row.credentialEpoch &&
      binding.identity === row.identity
    const entry: Record<string, unknown> = {
      binding: {
        kind: 'custody',
        storageId: paths.storageId,
        routeId: id,
        credentialId: vault.credentialId,
        accountIdentity: row.identity,
        // No vault token version produced this metadata; zero never
        // authorizes a request or names a rejected token.
        recordVersion: 0,
      },
    }
    if (exact && existing)
      for (const key of ACCOUNT_RUNTIME_FIELDS)
        if (existing[key] !== undefined) entry[key] = existing[key]
    if (row.quota !== undefined) entry.quota = row.quota
    next[id] = entry as unknown as NativeRuntimeEntry
  }
  try {
    return decodeNativeRuntime(
      {
        version: 1,
        storageId: paths.storageId,
        accounts: next,
        ...(source.relay ? { relay: source.relay } : {}),
      },
      paths.storageId,
    )
  } catch {
    return refuse('runtime-conflict')
  }
}

interface Captured {
  rows: PoolRow[]
  settings: Record<string, unknown>
  runtime: NativeRuntimeState
}

async function capturePool(
  paths: NativePoolPaths,
  store: ReturnType<typeof createNativePoolStore>,
): Promise<Captured> {
  const read = await store.read()
  const settings = await store.readSettings()
  if (read.status !== 'ready' || settings.status !== 'ready')
    refuse('invalid-state')
  return {
    rows: read.rows,
    settings: settings.settings,
    runtime: await readRuntime(paths),
  }
}

function expectedHostAuth(
  options: NativeCustodyActivationOptions,
  entry: ReturnType<typeof inspectNativeHostAuthEntry>,
): string {
  if (options.host === 'opencode') {
    // A stock OpenCode API key stays under host control; an inert marker is
    // kept. A real OAuth login would be a second credential authority.
    if (entry.kind === 'api' || entry.kind === 'activation') return entry.digest
    if (entry.kind === 'absent') return TOMBSTONE_DIGEST
    return refuse('host-auth-changed')
  }
  if (entry.kind === 'absent') return 'absent'
  // A Pi API key would take precedence over the vault primary; deleting it is
  // never implied by consent to remove a stored OAuth login.
  if (entry.kind === 'api_key') refuse('primary-conflict')
  if (!options.removePiAnthropicAuth) refuse('consent-required')
  return 'absent'
}

async function preparePlan(
  options: NativeCustodyActivationOptions,
  journal: NativeMigrationJournal,
  store: ReturnType<typeof createNativePoolStore>,
): Promise<NativeCustodyActivationPlan> {
  const { paths } = options
  const pool = await capturePool(paths, store)
  const main = pool.settings.mainAccountId
  if (typeof main !== 'string' || !main) refuse('invalid-state')
  const custody = isRecord(pool.settings.claustrum)
    ? pool.settings.claustrum
    : {}
  const host = await readHostEntry(options.host, journal.hostAuthPath)
  const hostAuth = {
    source: host.digest,
    expected: expectedHostAuth(options, host),
  }
  proofRows(pool.rows)
  const inventory = await options.discover()
  const designated = inventory.credentials.find(
    (item) => item.credentialId === NATIVE_PRIMARY_CREDENTIAL_ID,
  )
  if (designated?.credentialType !== 'oauth' || !designated.accountIdentity)
    refuse('primary-missing')
  const primary = {
    routeId: main,
    credentialId: designated.credentialId,
    accountIdentity: designated.accountIdentity,
  }
  const local = pool.rows.find((row) => row.id === main)
  if (local) {
    if (local.credential?.type !== 'oauth') refuse('primary-conflict')
    if (!local.identity) refuse('primary-unverified')
    // An already-bound main keeps its account; the vault cannot swap it.
    if (local.identity !== primary.accountIdentity) refuse('primary-mismatch')
  }
  const oauth = pool.rows.filter((row) => row.credential?.type === 'oauth')
  const removeIds = oauth.map((row) => row.id).sort()
  const existing = await readRoster(paths)
  let roster: NativeCustodyActivationRoster
  let targetSettings: Record<string, unknown>
  if (custody.mode === 'claustrum') {
    // A first migration of legacy vault custody already published the roster
    // and runtime bindings; the activation verifies and reuses them as-is.
    const pin = isRecord(custody.primaryAccount) ? custody.primaryAccount : {}
    if (
      oauth.length > 0 ||
      pin.credentialId !== primary.credentialId ||
      pin.accountId !== primary.accountIdentity
    )
      refuse('primary-mismatch')
    if (!existing) refuse('roster-conflict')
    roster = existing
    targetSettings = pool.settings
  } else {
    const legacyRows = oauth
      .filter((row) => row.id !== main)
      .map((row) => {
        if (!row.identity) refuse('row-unverified')
        const candidates = inventory.credentials.filter(
          (item) =>
            item.credentialType === 'oauth' &&
            item.accountIdentity === row.identity &&
            item.credentialId !== primary.credentialId,
        )
        if (row.identity === primary.accountIdentity) refuse('primary-conflict')
        if (candidates.length === 0) refuse('unenrolled-local-row')
        // No source rule designates one of several logins for a non-primary
        // account, so the activation refuses rather than guess.
        if (candidates.length > 1) refuse('vault-ambiguous')
        return {
          routeId: row.id,
          scopedCredentialId: candidates[0]?.credentialId,
          anthropicAccountUuid: row.identity,
          ...(row.label !== undefined ? { label: row.label } : {}),
          ...(row.addedAt !== undefined ? { addedAt: row.addedAt } : {}),
          enabled: row.enabled,
        }
      })
    const disabled = Array.isArray(custody.disabledAccountIdentities)
      ? custody.disabledAccountIdentities.filter(
          (item): item is string => typeof item === 'string',
        )
      : []
    const seedInput: NativeRosterSeedInput = {
      inventory,
      primary: {
        credentialId: primary.credentialId,
        accountIdentity: primary.accountIdentity,
      },
      primaryRouteId: main,
      legacyRows,
      disabledAccountIdentities:
        local && !local.enabled && !disabled.includes(primary.accountIdentity)
          ? [...disabled, primary.accountIdentity]
          : disabled,
      reservedRouteIds: pool.rows
        .filter((row) => row.credential?.type === 'api')
        .map((row) => row.id),
    }
    let seed: VaultRosterFile
    try {
      seed = buildNativeVaultRosterSeed(seedInput)
      if (existing) {
        const file = await readVaultRoster(paths.roster)
        if (!file) refuse('roster-conflict')
        validateNativeVaultRosterSeed(file, seedInput)
      }
    } catch (error) {
      if (error instanceof NativeCustodyActivationError) throw error
      return refuse(
        isRecord(error) && error.code === 'unenrolled-local-row'
          ? 'unenrolled-local-row'
          : 'roster-conflict',
      )
    }
    roster =
      existing ?? (rosterProjection(seed) as NativeCustodyActivationRoster)
    targetSettings = vaultSettings(pool.settings, primary)
  }
  const target = targetRuntime(
    paths,
    pool.runtime,
    pool.rows,
    removeIds,
    roster,
    primary,
  )
  let localProof: NativeCustodyActivationPlan['localProof']
  try {
    localProof = captureNativeMigrationPreparedProof(
      pool.rows,
      await importedRuntimeProjection(paths, store, pool.rows),
    )
  } catch {
    return refuse('credential-changed')
  }
  return {
    kind: 'activation',
    phase: 'prepared',
    primary,
    roster,
    localProof,
    removeIds,
    settings: {
      source: nativeMigrationDigest(pool.settings),
      target: nativeMigrationDigest(targetSettings),
    },
    runtime: {
      source: nativeMigrationDigest(pool.runtime),
      target: nativeMigrationDigest(target),
    },
    hostAuth,
  }
}

/**
 * Classify the whole pool against the prepared proof. Every row must be a
 * proof row with the exact same credential, epoch and identity; a kept row
 * (API key) must still be present. Returns the replaced OAuth rows that are
 * still present. An added, re-added or changed row refuses.
 */
function classifyRows(
  plan: NativeCustodyActivationPlan,
  rows: readonly PoolRow[],
): Set<string> {
  const expected = new Map(plan.localProof.rows.map((row) => [row.id, row]))
  const present = new Set<string>()
  for (const row of proofRows(rows)) {
    const proof = expected.get(row.id)
    if (!proof || !sameJson(proof, row)) refuse('credential-changed')
    present.add(row.id)
  }
  for (const proof of plan.localProof.rows)
    if (!plan.removeIds.includes(proof.id) && !present.has(proof.id))
      refuse('credential-changed')
  return new Set(plan.removeIds.filter((id) => present.has(id)))
}

function mapError(error: unknown): never {
  if (error instanceof NativeCustodyActivationError) throw error
  // The settings write failed and releasing its extra leases also failed:
  // report the write's failure, which is the one that decides the outcome.
  if (error instanceof AggregateError) return mapError(error.errors[0])
  if (error instanceof PoolOperationError) {
    if (error.cause instanceof NativeCustodyActivationError) throw error.cause
    if (error.kind === 'lock-ownership') refuse('ownership-lost')
    if (error.kind === 'lock-contention') refuse('migration-busy')
    if (
      error.kind === 'attribution' ||
      error.kind === 'row-protected' ||
      error.kind === 'unbound-credential'
    )
      refuse('credential-changed')
    refuse('invalid-state')
  }
  if (error instanceof Error) {
    if (error.name === 'LockContentionError') refuse('migration-busy')
    if (error.name === 'LockOwnershipError') refuse('ownership-lost')
    if (error.name === 'NativeHostAuthError')
      refuse(
        (error as { code?: unknown }).code === 'supervised-auth-snapshot'
          ? 'auth-content-refused'
          : 'host-auth-changed',
      )
    if (error.name === 'NativeHostAuthWriteError') {
      const code = (error as { code?: unknown }).code
      refuse(
        code === 'consent-required'
          ? 'consent-required'
          : code === 'process-fence-refused'
            ? 'process-fence-refused'
            : 'host-auth-changed',
      )
    }
    if (error.name === 'NativeRuntimeError') refuse('runtime-conflict')
    if (error.name === 'NativeAuthorityError') refuse('invalid-state')
    if (error.name === 'NativeMigrationSourceError') refuse('invalid-state')
  }
  // Never forward an unknown error: it may carry a caller's or vault's data.
  return refuse('invalid-state')
}

/**
 * Hold the pool-config, pool-state, vault-roster, native-runtime and routing
 * leases, in that order, through one body. The roster lease is held by a
 * read-only mutateVaultRoster scope that returns no new roster. No store
 * operation runs inside, so no pool lock is taken twice.
 */
async function holdAll<T>(
  paths: NativePoolPaths,
  routingPath: string,
  body: (leases: Lease[]) => Promise<T>,
): Promise<T> {
  const [config, state] = nativePoolStoreLocks(paths)
  return withLock(
    config.path,
    { ...POOL_LOCK_DEFAULTS, name: config.name, renew: true },
    (configLease) =>
      withLock(
        state.path,
        { ...POOL_LOCK_DEFAULTS, name: state.name, renew: true },
        (stateLease) =>
          mutateVaultRoster(paths.roster, async (_current, rosterLease) => {
            const result = await withLock(
              paths.runtime,
              { name: 'native-runtime', ...POOL_LOCK_DEFAULTS, renew: true },
              (runtimeLease) =>
                withLock(
                  routingPath,
                  {
                    name: 'write',
                    ttlMs: 30_000,
                    timeoutMs: 15_000,
                    renew: true,
                  },
                  (routingLease) =>
                    body([
                      configLease,
                      stateLease,
                      rosterLease,
                      runtimeLease,
                      routingLease,
                    ]),
                ),
            )
            return { result }
          }),
      ),
  )
}

/** Offline, crash-forward switch of a retired local pool to vault custody. */
export async function runNativeCustodyActivation(
  options: NativeCustodyActivationOptions,
  hooks: NativeCustodyActivationHooks = {},
): Promise<NativeCustodyActivationResult> {
  const paths = Object.freeze({ ...options.paths })
  const input: NativeCustodyActivationOptions = {
    ...options,
    paths,
    env: { ...options.env },
  }
  try {
    return await withLock(
      paths.journal,
      {
        name: 'native-migration',
        ttlMs: 30_000,
        timeoutMs: 15_000,
        renew: true,
      },
      async (lease) => {
        const step = async (label: string) => hooks.onStep?.(label)
        const fence = async () => {
          requireNoSupervisedAuthContentSnapshot(input.env)
          try {
            await input.processFence()
          } catch {
            refuse('process-fence-refused')
          }
          try {
            await lease.assertOwned()
          } catch {
            refuse('ownership-lost')
          }
        }
        await fence()
        let journal = await readNativeMigrationJournal(paths)
        if (!journal) return refuse('migration-required')
        if (journal.host !== input.host || journal.phase !== 'retired')
          refuse('invalid-state')
        const hostAuthPath = journal.hostAuthPath
        const routingPath = journal.routingPaths.destination
        // The check every store write runs before its rename. While the
        // prepared phase writes, it also requires the source settings.
        let writeFence = fence
        const store = createNativePoolStore({
          paths,
          quota: nativeQuotaCodec,
          onLockStep: hooks.store?.onLockStep,
          onStep: async (write, info) => {
            await hooks.store?.onStep?.(write, info)
            if (write.startsWith('before-')) await writeFence()
          },
        })
        if (journal.activation === null) {
          const settings = await store.readSettings()
          if (settings.status !== 'ready') refuse('invalid-state')
          const custody = settings.settings.claustrum
          if (isRecord(custody) && custody.mode === 'claustrum')
            return { status: 'already-vault', journal }
        }
        if (
          journal.activation?.kind === 'activation' &&
          journal.activation.phase === 'committed'
        )
          return { status: 'committed', journal }

        const requireHost = async (digest: string) => {
          const entry = await readHostEntry(input.host, hostAuthPath)
          if (entry.digest !== digest) refuse('host-auth-changed')
        }
        const requireRoster = async (
          plan: NativeCustodyActivationPlan,
          allowAbsent: boolean,
        ) => {
          const roster = await readRoster(paths)
          if (
            roster === undefined ? !allowAbsent : !sameJson(roster, plan.roster)
          )
            refuse('roster-conflict')
        }
        const runtimeDigest = async () =>
          nativeMigrationDigest(await readRuntime(paths))
        const settingsDigest = async () => {
          const read = await store.readSettings()
          if (read.status !== 'ready') refuse('invalid-state')
          return nativeMigrationDigest(read.settings)
        }

        if (journal.activation?.kind !== 'activation') {
          // When setup asked for vault custody before the first migration,
          // serving has been refused since that migration. The pool,
          // runtime, settings and roster must still be exactly what the
          // migration proved (its prepared proof covers the published vault
          // roster). This is checked before planning, again before the plan
          // is recorded and inside that journal write, so a change made while
          // the vault is being listed cannot become the plan's baseline.
          const migrationProof =
            journal.activation?.kind === 'requested'
              ? journal.preparedProof
              : undefined
          const requireMigrationProof = async () => {
            if (migrationProof === undefined) return
            const rows = (await capturePool(paths, store)).rows
            try {
              requireNativeMigrationPreparedProof(
                migrationProof,
                rows,
                await importedRuntimeProjection(paths, store, rows),
              )
            } catch {
              refuse('migration-proof-changed')
            }
          }
          await requireMigrationProof()
          const plan = await preparePlan(input, journal, store)
          // The plan's own proof must be the migration's proof itself.
          if (
            migrationProof !== undefined &&
            !sameJson(plan.localProof, migrationProof)
          )
            refuse('migration-proof-changed')
          // Record the plan only while the pool rows, settings, runtime,
          // roster and host auth it was computed from are still unchanged.
          const requirePrepared = async () => {
            await requireMigrationProof()
            const rows = (await capturePool(paths, store)).rows
            try {
              requireNativeMigrationPreparedProof(
                plan.localProof,
                rows,
                await importedRuntimeProjection(paths, store, rows),
              )
            } catch {
              refuse('credential-changed')
            }
            if ((await settingsDigest()) !== plan.settings.source)
              refuse('settings-conflict')
            if ((await runtimeDigest()) !== plan.runtime.source)
              refuse('runtime-conflict')
            await requireRoster(plan, true)
            await requireHost(plan.hostAuth.source)
          }
          await requirePrepared()
          await step('before:prepare')
          journal = await recordNativeCustodyActivation(paths, plan, {
            assertOwned: async () => {
              await requirePrepared()
              await fence()
            },
            onWriteStep: async (write) => step(`${write}:journal:prepared`),
          })
          await step('after:prepare')
        }
        const plan = journal.activation
        if (plan?.kind !== 'activation') return refuse('invalid-state')
        // Before any further write: the host's Anthropic entry must still be
        // the recorded one or the planned one. A changed login is never
        // adopted or deleted, whatever consent the original run had.
        const host = await readHostEntry(input.host, hostAuthPath)
        if (
          host.digest !== plan.hostAuth.source &&
          host.digest !== plan.hostAuth.expected
        )
          refuse('host-auth-changed')
        // While prepared, every write also requires the settings the plan
        // was computed from; a changed preference refuses before the write.
        const preparedFence = async () => {
          if ((await settingsDigest()) !== plan.settings.source)
            refuse('settings-conflict')
          await fence()
        }

        // The finished state: replaced rows gone, kept rows unchanged, runtime
        // rebound, roster and host auth as planned. Settings are the source
        // until the mode switch and the target after it, so callers pass one.
        const requirePublished = async (settings: string) => {
          if (classifyRows(plan, (await capturePool(paths, store)).rows).size)
            refuse('credential-changed')
          if ((await runtimeDigest()) !== plan.runtime.target)
            refuse('runtime-conflict')
          await requireRoster(plan, false)
          await requireHost(plan.hostAuth.expected)
          if ((await settingsDigest()) !== settings) refuse('settings-conflict')
        }

        if (plan.phase === 'prepared') {
          // Classify the whole prepared state before resuming any write:
          // source settings; runtime at source (then every replaced row is
          // still present) or already at target; only proof rows in the
          // pool; the roster absent or exactly the prepared one.
          if ((await settingsDigest()) !== plan.settings.source)
            refuse('settings-conflict')
          const remaining = classifyRows(
            plan,
            (await capturePool(paths, store)).rows,
          )
          const runtimeNow = await runtimeDigest()
          if (
            runtimeNow !== plan.runtime.target &&
            (runtimeNow !== plan.runtime.source ||
              remaining.size !== plan.removeIds.length)
          )
            refuse('runtime-conflict')
          await requireRoster(plan, true)
          writeFence = preparedFence

          // Publish the prepared secret-free roster, or accept an equal one.
          await step('before:roster')
          await mutateVaultRoster(
            paths.roster,
            async (current, rosterLease) => {
              const projected = rosterProjection(current)
              if (projected) {
                if (!sameJson(projected, plan.roster)) refuse('roster-conflict')
                return { result: undefined }
              }
              classifyRows(plan, (await capturePool(paths, store)).rows)
              await preparedFence()
              await rosterLease.assertOwned()
              return {
                next: structuredClone(plan.roster) as VaultRosterFile,
                result: undefined,
              }
            },
            { beforePublish: preparedFence },
          )
          await step('after:roster')

          // Rebind runtime metadata from local rows to vault routes before
          // any row is removed: the target is computed from those rows.
          const current = await runtimeDigest()
          if (current !== plan.runtime.target) {
            if (current !== plan.runtime.source) refuse('runtime-conflict')
            const pool = await capturePool(paths, store)
            if (classifyRows(plan, pool.rows).size !== plan.removeIds.length)
              refuse('runtime-conflict')
            const target = targetRuntime(
              paths,
              pool.runtime,
              pool.rows,
              plan.removeIds,
              plan.roster,
              plan.primary,
            )
            if (nativeMigrationDigest(target) !== plan.runtime.target)
              refuse('runtime-conflict')
            await step('before:runtime')
            await preparedFence()
            await publishNativeVaultRuntimeSeed(paths, target, {
              assertOwned: async () => {
                if ((await runtimeDigest()) !== plan.runtime.source)
                  refuse('runtime-conflict')
                const rows = (await capturePool(paths, store)).rows
                if (classifyRows(plan, rows).size !== plan.removeIds.length)
                  refuse('runtime-conflict')
                await requireRoster(plan, false)
                await preparedFence()
              },
            })
            await step('after:runtime')
          }

          // Remove each replaced local OAuth row with an attributed removal,
          // which refuses unless the row still holds the recorded credential
          // epoch and account identity.
          for (const [index, id] of plan.removeIds.entries()) {
            const proof = plan.localProof.rows.find((row) => row.id === id)
            if (!proof) refuse('invalid-state')
            const present = classifyRows(
              plan,
              (await capturePool(paths, store)).rows,
            ).has(id)
            await step(`before:remove:${index}`)
            await preparedFence()
            try {
              await store.remove(id, {
                attribution: {
                  credentialEpoch: proof.credentialEpoch,
                  ...(proof.identity !== null
                    ? { identity: proof.identity }
                    : {}),
                },
                // A credential replacement advances the row generation, but
                // ordinary token refresh keeps it. Require the recorded
                // credential digest as well to detect changed tokens. If an
                // interrupted removal leaves only credential state,
                // common-auth validates that state's binding record against
                // the attributed generation and account identity.
                protect: (_id, view) => {
                  if (!view.row) return undefined
                  try {
                    return view.row.credential &&
                      nativeMigrationCredentialDigest(view.row.credential) ===
                        proof.credentialDigest
                      ? undefined
                      : 'credential-changed'
                  } catch {
                    return 'credential-changed'
                  }
                },
              })
            } catch (error) {
              // Ignore unknown-row only when this row was already absent
              // before removal; an earlier run may have completed it.
              // Rethrow every other removal failure.
              if (
                present ||
                !(error instanceof PoolOperationError) ||
                error.kind !== 'unknown-row'
              )
                throw error
            }
            await step(`after:remove:${index}`)
          }

          // Update the host Anthropic entry to the recorded target: OpenCode
          // retains a non-secret OAuth value that activates this plugin, or
          // its existing stock API key. Pi removes only the consented OAuth
          // entry.
          const entry = await readHostEntry(input.host, hostAuthPath)
          if (entry.digest !== plan.hostAuth.expected) {
            if (entry.digest !== plan.hostAuth.source)
              refuse('host-auth-changed')
            await step('before:host')
            await preparedFence()
            await writeNativeHostAuth(
              {
                host: input.host,
                authPath: hostAuthPath,
                sourceDigest: plan.hostAuth.source,
                expectedDigest: plan.hostAuth.expected,
                env: input.env,
                removePiAnthropicAuth: input.removePiAnthropicAuth,
                processFence: preparedFence,
              },
              hooks.hostWrite,
            )
            await step('after:host')
          }

          await requirePublished(plan.settings.source)
          journal = await advanceNativeCustodyActivation(
            paths,
            'prepared',
            'published',
            {
              assertOwned: async () => {
                await requirePublished(plan.settings.source)
                await fence()
              },
              onWriteStep: async (write) => step(`${write}:journal:published`),
            },
          )
          writeFence = fence
        }

        if ((await settingsDigest()) !== plan.settings.target)
          await commitMode(paths, routingPath, plan, {
            step,
            fence,
            requirePublished,
            hooks,
          })

        // Allow outbound credential use only after the committed journal
        // replaces the pending one. Recheck the completed custody state while
        // all five locks remain held, before that final rename.
        journal = await holdAll(paths, routingPath, async (leases) => {
          await requirePublished(plan.settings.target)
          return advanceNativeCustodyActivation(
            paths,
            'published',
            'committed',
            {
              assertOwned: async () => {
                await step('before:authority-rename')
                await requirePublished(plan.settings.target)
                await fence()
                for (const held of leases) await held.assertOwned()
              },
              onWriteStep: async (write) => step(`${write}:journal:committed`),
            },
          )
        })
        return { status: 'committed', journal }
      },
    )
  } catch (error) {
    return mapError(error)
  }
}

interface ModeContext {
  step: (label: string) => Promise<void>
  fence: () => Promise<void>
  requirePublished: (settings: string) => Promise<void>
  hooks: NativeCustodyActivationHooks
}

/**
 * Switch the settings to vault mode in one settings write that holds all five
 * leases through its rename. The store takes pool-config and pool-state; the
 * mutator opens a read-only roster scope that then takes native-runtime and
 * routing and waits on a gate. The store's before-config-write step runs the
 * caller hook and every check first and asserts the three extra leases last,
 * immediately before the store's own lock assertion and the rename. The gate
 * opens and the scope is joined on every outcome.
 */
async function commitMode(
  paths: NativePoolPaths,
  routingPath: string,
  plan: NativeCustodyActivationPlan,
  context: ModeContext,
): Promise<void> {
  let openGate: () => void = () => {}
  const gate = new Promise<void>((resolve) => {
    openGate = resolve
  })
  let leases: Lease[] | undefined
  let scope: Promise<void> | undefined
  // A store instance used for this one settings write, so its step hook
  // runs only for this write.
  const writer = createNativePoolStore({
    paths,
    quota: nativeQuotaCodec,
    onLockStep: context.hooks.store?.onLockStep,
    onStep: async (write, info) => {
      await context.hooks.store?.onStep?.(write, info)
      if (info.operation !== 'updateSettings') return
      if (write !== 'before-config-write') return
      await context.step('before:mode-rename')
      // The settings on disk are still the source until this rename.
      await context.requirePublished(plan.settings.source)
      await context.fence()
      if (!leases) refuse('ownership-lost')
      for (const held of leases) await held.assertOwned()
    },
  })
  let failure: { error: unknown } | undefined
  try {
    await writer.updateSettings(async (settings) => {
      const digest = nativeMigrationDigest(settings)
      if (digest === plan.settings.target) return undefined
      if (digest !== plan.settings.source) refuse('settings-conflict')
      const next = vaultSettings(settings, plan.primary)
      if (nativeMigrationDigest(next) !== plan.settings.target)
        refuse('settings-conflict')
      leases = await new Promise<Lease[]>((ready, failed) => {
        scope = mutateVaultRoster(
          paths.roster,
          async (_current, rosterLease) => {
            const result = await withLock(
              paths.runtime,
              { name: 'native-runtime', ...POOL_LOCK_DEFAULTS, renew: true },
              (runtimeLease) =>
                withLock(
                  routingPath,
                  {
                    name: 'write',
                    ttlMs: 30_000,
                    timeoutMs: 15_000,
                    renew: true,
                  },
                  async (routingLease) => {
                    ready([rosterLease, runtimeLease, routingLease])
                    await gate
                  },
                ),
            )
            return { result }
          },
        )
        // A scope that ends before it is ready fails the settings write with
        // its own error; once ready, this rejection handler is a no-op.
        scope.catch(failed)
      })
      return next
    })
  } catch (error) {
    failure = { error }
  } finally {
    openGate()
  }
  const [drained] = await Promise.allSettled([scope ?? Promise.resolve()])
  if (failure) {
    if (drained.status === 'rejected' && leases)
      throw new AggregateError(
        [failure.error, drained.reason],
        'Native vault mode write failed',
      )
    throw failure.error
  }
  if (drained.status === 'rejected') throw drained.reason
  await context.step('after:mode-rename')
}
