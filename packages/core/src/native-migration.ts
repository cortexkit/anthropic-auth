import { createHash } from 'node:crypto'
import { lstat, mkdir, unlink } from 'node:fs/promises'
import { dirname, isAbsolute } from 'node:path'
import {
  mutateVaultRoster,
  readVaultRoster,
} from '@cortexkit/common-auth/claustrum'
import { withLock, writeJsonAtomic } from '@cortexkit/common-auth/fs'
import { POOL_LOCK_DEFAULTS, type PoolRow } from '@cortexkit/common-auth/store'

import { custodyTombstoneOAuth } from './claustrum.ts'
import {
  NativeMigrationSourceError,
  type NativeMigrationSourceSnapshot,
  readNativeMigrationSource,
  requireUnchangedNativeMigrationSource,
} from './migration-source.ts'
import type { NativeCustodyInventory } from './native-custody.ts'
import {
  inspectNativeHostAuthEntry,
  requireNoSupervisedAuthContentSnapshot,
} from './native-host-auth.ts'
import {
  type NativeHostAuthWriteHooks,
  writeNativeHostAuth,
} from './native-host-auth-write.ts'
import {
  captureNativeMigrationPreparedProof,
  NativeMigrationProofError,
  nativeMigrationCanonicalJson,
  requireNativeMigrationPreparedProof,
} from './native-migration-proof.ts'
import {
  type NativeMigrationProjection,
  NativeMigrationProjectionError,
  projectNativeMigrationRuntime,
  projectNativeMigrationSource,
  requireNativeMigrationSourceRows,
} from './native-migration-source.ts'
import { nativeQuotaCodec } from './native-quota-codec.ts'
import {
  buildNativeVaultRosterSeed,
  type NativeRosterSeedInput,
  type NativeVaultRosterSeed,
  validateNativeVaultRosterSeed,
} from './native-roster-seed.ts'
import {
  type NativeRuntimeState,
  readNativeRuntime,
  updateNativeRuntime,
} from './native-runtime.ts'
import {
  advanceNativeMigration,
  beginNativeMigration,
  type NativeMigrationJournal,
  readNativeMigrationJournal,
  recordNativeMigrationExpectations,
} from './pool-authority.ts'
import {
  canonicalPath,
  type NativePoolPaths,
  resolveNativePoolPaths,
} from './pool-paths.ts'
import { createNativePoolStore, nativePoolStoreLocks } from './pool-store.ts'
import { migrateStickyRoutingState } from './sticky-routing.ts'

export class NativeMigrationError extends Error {
  constructor(
    public readonly code:
      | 'invalid-source'
      | 'unsafe-source'
      | 'consent-required'
      | 'primary-unverified'
      | 'migration-busy'
      | 'ownership-lost'
      | 'retirement-refused',
  ) {
    super(
      code === 'primary-unverified'
        ? 'Sign in again with the Claude pool login, then run setup. Existing credentials have not been changed.'
        : `Native migration: ${code}`,
    )
    this.name = 'NativeMigrationError'
  }
}

export interface NativeMigrationCustody {
  /** Use the host’s approved Claustrum token and account-list permission to discover accounts; never open the vault’s credential files. */
  discover: () => Promise<NativeCustodyInventory>
  /** Use publishNativeVaultRosterSeed to verify that this controller still owns the migration journal lock before replacing the account list. */
  publishSeed: (
    paths: NativePoolPaths,
    input: NativeRosterSeedInput,
    options: { assertOwned: () => Promise<void> },
  ) => Promise<NativeVaultRosterSeed>
  /** Use publishNativeVaultRuntimeSeed to match metadata to its vault account while holding the account-list and migration-journal locks. */
  publishRuntimeSeed: (
    paths: NativePoolPaths,
    state: NativeRuntimeState,
    options: { assertOwned: () => Promise<void> },
  ) => Promise<void>
}

export interface NativeMigrationOptions {
  paths: NativePoolPaths
  /** Keep the configured config and state paths so the reader rejects either file if it is a symbolic link. */
  legacyConfigPath?: string
  legacyStatePath?: string
  host: 'opencode' | 'pi'
  hostAuthPath: string
  routingSourcePath: string
  routingDestinationPath: string
  env: NodeJS.ProcessEnv
  processFence: () => Promise<void>
  removePiAnthropicAuth: boolean
  custody?: NativeMigrationCustody
  preflight?: NativeMigrationPreflight
  /**
   * Offline setup sets requestVaultActivation when the user explicitly chose vault custody. It
   * applies only when no journal exists yet; it keeps the pool unauthorized
   * after this migration commits until runNativeCustodyActivation commits.
   */
  requestVaultActivation?: boolean
}

/** Result of read-only checks for the selected storage and host. Contains no account data or credential digests. */
export interface NativeMigrationPreflight {
  readonly storageId: string
  readonly host: 'opencode' | 'pi'
}

export interface NativeMigrationHooks {
  /** Test hook for interruptions and lease loss. Receives step labels, never credentials or their digests. */
  onStep?: (step: string) => Promise<void>
  hostWrite?: NativeHostAuthWriteHooks
  store?: Pick<
    Parameters<typeof createNativePoolStore>[0],
    'onStep' | 'onLockStep'
  >
}

interface Captured {
  config: NativeMigrationSourceSnapshot
  state: NativeMigrationSourceSnapshot
  routing: NativeMigrationSourceSnapshot
  auth: NativeMigrationSourceSnapshot
  projection?: NativeMigrationProjection
  seedInput?: NativeRosterSeedInput
  journal?: NativeMigrationJournal
  hostAuthPath: string
  routingSourcePath: string
  routingDestinationPath: string
}

const preflights = new WeakMap<NativeMigrationPreflight, Captured>()

function refuse(
  code: ConstructorParameters<
    typeof NativeMigrationError
  >[0] = 'invalid-source',
): never {
  throw new NativeMigrationError(code)
}
function owned(snapshot: NativeMigrationSourceSnapshot): void {
  if (
    snapshot.metadata &&
    process.getuid &&
    snapshot.metadata.uid !== process.getuid()
  )
    refuse('unsafe-source')
}
async function absent(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return false
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return true
    return refuse('unsafe-source')
  }
}

/** Preflight is read-only so setup can validate all selected hosts before any begin. */
export async function prepareNativeMigration(
  input: NativeMigrationOptions,
): Promise<NativeMigrationPreflight> {
  const captured = await capture(input)
  const token = Object.freeze({
    storageId: input.paths.storageId,
    host: input.host,
  })
  preflights.set(token, captured)
  return token
}

export function releaseNativeMigrationPreflight(
  token: NativeMigrationPreflight,
): void {
  preflights.delete(token)
}

async function capture(input: NativeMigrationOptions): Promise<Captured> {
  requireNoSupervisedAuthContentSnapshot(input.env)
  await input.processFence()
  const resolved = await resolveNativePoolPaths(
    input.paths.legacyConfig,
    input.paths.legacyState,
  )
  for (const key of Object.keys(resolved) as Array<keyof NativePoolPaths>)
    if (input.paths[key] !== resolved[key]) refuse()
  for (const path of [
    input.hostAuthPath,
    input.routingSourcePath,
    input.routingDestinationPath,
  ])
    if (!isAbsolute(path) || /\p{Cc}/u.test(path)) refuse()
  const journal = await readNativeMigrationJournal(input.paths)
  const auth = await readNativeMigrationSource('hostAuth', input.hostAuthPath)
  owned(auth)
  const entry = inspectNativeHostAuthEntry(input.host, auth.data)
  if (
    input.host === 'pi' &&
    entry.kind !== 'absent' &&
    !input.removePiAnthropicAuth
  )
    refuse('consent-required')
  const hostAuthPath = await canonicalPath(input.hostAuthPath)
  const routingSourcePath = await canonicalPath(input.routingSourcePath)
  const routingDestinationPath = await canonicalPath(
    input.routingDestinationPath,
  )
  const all = [
    input.paths.legacyConfig,
    input.paths.legacyState,
    input.paths.config,
    input.paths.state,
    input.paths.runtime,
    input.paths.roster,
    input.paths.journal,
    hostAuthPath,
    routingSourcePath,
  ]
  if (
    new Set(all).size !== all.length ||
    (routingDestinationPath !== routingSourcePath &&
      all.includes(routingDestinationPath))
  )
    refuse()
  if (
    journal &&
    (journal.host !== input.host ||
      journal.hostAuthPath !== hostAuthPath ||
      journal.routingPaths.source !== routingSourcePath ||
      journal.routingPaths.destination !== routingDestinationPath)
  )
    refuse()
  // Once the pool becomes authoritative, requests can update it. Restoring
  // the host’s token-free activation marker must not import credentials from
  // a later host login or replace the pool’s current tokens.
  if (journal?.phase === 'committed' || journal?.phase === 'retired') {
    const missing = (
      role: 'config' | 'state' | 'routing',
      path: string,
    ): NativeMigrationSourceSnapshot => ({
      role,
      path,
      digest: null,
      data: undefined,
      metadata: undefined,
    })
    return {
      config: missing('config', input.paths.legacyConfig),
      state: missing('state', input.paths.legacyState),
      routing: missing('routing', input.routingSourcePath),
      auth,
      journal,
      hostAuthPath,
      routingSourcePath,
      routingDestinationPath,
    }
  }
  if (!journal) {
    for (const path of [
      input.paths.config,
      input.paths.state,
      input.paths.runtime,
      input.paths.roster,
    ])
      if (!(await absent(path))) refuse()
    if (
      routingSourcePath !== routingDestinationPath &&
      !(await absent(input.routingDestinationPath))
    )
      refuse()
  }
  const config = await readNativeMigrationSource(
    'config',
    input.legacyConfigPath ?? input.paths.legacyConfig,
  )
  const state = await readNativeMigrationSource(
    'state',
    input.legacyStatePath ?? input.paths.legacyState,
  )
  const routing = await readNativeMigrationSource(
    'routing',
    input.routingSourcePath,
  )
  for (const source of [config, state, routing]) owned(source)
  if (
    (await canonicalPath(config.path)) !== input.paths.legacyConfig ||
    (await canonicalPath(state.path)) !== input.paths.legacyState
  )
    refuse()
  if (
    journal &&
    (journal.sources.config !== config.digest ||
      journal.sources.state !== state.digest ||
      (journal.expectedRouting === 'unprepared' &&
        journal.sources.routing !== routing.digest))
  )
    refuse()
  if (
    journal &&
    entry.digest !== journal.sources.hostAuth &&
    entry.digest !== journal.expectedHostAuth
  )
    refuse()
  let projection: NativeMigrationProjection | undefined
  let seedInput: NativeRosterSeedInput | undefined
  // After replacing host auth, resume verifies credentials already imported
  // into the pool against recorded row and runtime hashes. It never restores
  // the old host secret.
  if (
    !journal ||
    journal.expectedHostAuth === 'unprepared' ||
    entry.digest === journal.sources.hostAuth
  ) {
    projection = projectNativeMigrationSource({
      host: input.host,
      storageId: input.paths.storageId,
      configDigest: config.digest,
      config: config.data,
      state: state.data,
      hostAuth: auth.data,
    })
    const mainRouteId = projection.mainRouteId
    const main = projection.accounts.find(
      (account) => account.id === mainRouteId,
    )
    // A requested custody switch blocks local serving. Prove the imported
    // main identity before creating that request or retiring working credentials.
    if (
      (input.requestVaultActivation ||
        journal?.activation?.kind === 'requested') &&
      main?.credential?.type === 'oauth' &&
      !main.identity
    )
      refuse('primary-unverified')
    if (projection.custodyPrimary) {
      if (!input.custody) refuse()
      seedInput = {
        inventory: await input.custody.discover(),
        primary: projection.custodyPrimary,
        primaryRouteId: projection.mainRouteId,
        legacyRows: projection.custodyRows,
        disabledAccountIdentities: projection.disabledAccountIdentities,
        reservedRouteIds: projection.accounts
          .filter((account) => account.credential?.type === 'api')
          .map((account) => account.id),
      }
      buildNativeVaultRosterSeed(seedInput)
    }
    // Validate imported quota, profile and error metadata before starting the
    // transaction, so malformed data cannot leave partly imported accounts.
    const syntheticRows: PoolRow[] = projection.accounts
      .filter((account) => account.credential)
      .map((account) => ({
        id: account.id,
        type: account.credential?.type ?? 'oauth',
        credential: account.credential,
        identity: account.identity,
        credentialEpoch: 1,
        enabled: account.enabled,
        stamp: 'bound',
        hasEntry: true,
        needsFirstReading: false,
        candidate: account.enabled,
      }))
    projectNativeMigrationRuntime(
      input.paths,
      projection,
      syntheticRows,
      seedInput ? buildNativeVaultRosterSeed(seedInput) : undefined,
    )
  }
  return {
    config,
    state,
    routing,
    auth,
    journal,
    projection,
    seedInput,
    hostAuthPath,
    routingSourcePath,
    routingDestinationPath,
  }
}

async function publicRows(
  store: ReturnType<typeof createNativePoolStore>,
): Promise<PoolRow[]> {
  const result = await store.read()
  if (result.status !== 'ready') refuse()
  return result.rows
}
async function runtimeState(
  paths: NativePoolPaths,
): Promise<NativeRuntimeState> {
  const result = await readNativeRuntime(paths.runtime, paths.storageId)
  if (result.status !== 'ready') refuse()
  return result.state
}

/**
 * The public, secret-free state recorded alongside account credential digests for recovery checks:
 * runtime metadata, settings, account flags and quota, and the vault roster.
 */
export async function importedRuntimeProjection(
  paths: NativePoolPaths,
  store: ReturnType<typeof createNativePoolStore>,
  rows: PoolRow[],
): Promise<unknown> {
  const settings = await store.readSettings()
  if (settings.status !== 'ready') refuse()
  const roster = await readNativeMigrationSource('state', paths.roster)
  owned(roster)
  const publicRoster = roster.data ? await readVaultRoster(paths.roster) : null
  if (roster.data && !publicRoster) refuse()
  return {
    runtime: await runtimeState(paths),
    settings: settings.settings,
    accounts: rows.map((row) => ({
      id: row.id,
      type: row.type,
      enabled: row.enabled,
      label: row.label ?? null,
      addedAt: row.addedAt ?? null,
      disabledReason: row.disabledReason ?? null,
      quota: row.quota ?? null,
    })),
    roster: publicRoster,
  }
}

async function heldPool<T>(
  paths: NativePoolPaths,
  outer: () => Promise<void>,
  body: (assertOwned: () => Promise<void>) => Promise<T>,
): Promise<T> {
  const locks = nativePoolStoreLocks(paths)
  async function enter(
    index: number,
    checks: Array<() => Promise<void>>,
  ): Promise<T> {
    const lock = locks[index]
    if (!lock)
      return mutateVaultRoster(paths.roster, async (_current, rosterLease) => {
        const result = await withLock(
          paths.runtime,
          { name: 'native-runtime', ...POOL_LOCK_DEFAULTS, renew: true },
          (runtimeLease) =>
            body(async () => {
              await outer()
              for (const check of checks) await check()
              await rosterLease.assertOwned()
              await runtimeLease.assertOwned()
            }),
        )
        // Returning only result keeps common-auth’s account-list lock held until
        // our work finishes. It does not replace or normalize that list.
        return { result }
      })
    return withLock(
      lock.path,
      { ...POOL_LOCK_DEFAULTS, ...lock, renew: true },
      (handle) => enter(index + 1, [...checks, () => handle.assertOwned()]),
    )
  }
  return enter(0, [])
}

function routingBytes(captured: Captured): string | undefined {
  if (!captured.routing.data) return undefined
  if (!captured.projection) refuse()
  const map = new Map(
    captured.projection.accounts.map((account) => [account.id, account.id]),
  )
  map.set('main', captured.projection.mainRouteId)
  return migrateStickyRoutingState(captured.routing.data, map)
}
function bytesDigest(bytes: string | undefined): string | null {
  return bytes === undefined
    ? null
    : createHash('sha256').update(bytes).digest('hex')
}
function expectedAuth(
  input: NativeMigrationOptions,
  snapshot: NativeMigrationSourceSnapshot,
): string {
  const entry = inspectNativeHostAuthEntry(input.host, snapshot.data)
  return input.host === 'pi'
    ? 'absent'
    : entry.kind === 'api'
      ? entry.digest
      : inspectNativeHostAuthEntry('opencode', {
          anthropic: custodyTombstoneOAuth('anthropic'),
        }).digest
}

async function checkLegacy(captured: Captured): Promise<void> {
  await requireUnchangedNativeMigrationSource(captured.config)
  await requireUnchangedNativeMigrationSource(captured.state)
}

async function checkPaths(
  input: NativeMigrationOptions,
  captured: Captured,
): Promise<void> {
  if (
    (await canonicalPath(input.hostAuthPath)) !== captured.hostAuthPath ||
    (await canonicalPath(input.routingSourcePath)) !==
      captured.routingSourcePath ||
    (await canonicalPath(input.routingDestinationPath)) !==
      captured.routingDestinationPath
  )
    refuse()
}

async function retire(
  input: NativeMigrationOptions,
  journal: NativeMigrationJournal,
  assertOwned: () => Promise<void>,
  hooks: NativeMigrationHooks,
): Promise<NativeMigrationJournal> {
  const sources = [
    {
      role: 'config' as const,
      path: input.legacyConfigPath ?? input.paths.legacyConfig,
      digest: journal.sources.config,
    },
    {
      role: 'state' as const,
      path: input.legacyStatePath ?? input.paths.legacyState,
      digest: journal.sources.state,
    },
    ...(journal.routingPaths.source === journal.routingPaths.destination
      ? []
      : [
          {
            role: 'routing' as const,
            path: input.routingSourcePath,
            digest: journal.sources.routing,
          },
        ]),
  ]
  // Validate every surviving source before the first unlink. A partial retirement
  // from an earlier crash is allowed, but a changed source is never deleted.
  const snapshots = await Promise.all(
    sources.map(async (source) => {
      const snapshot = await readNativeMigrationSource(source.role, source.path)
      owned(snapshot)
      if (snapshot.data && snapshot.digest !== source.digest)
        refuse('retirement-refused')
      return snapshot
    }),
  )
  for (const snapshot of snapshots) {
    if (!snapshot.data) continue
    await hooks.onStep?.(`before:retire:${snapshot.role}`)
    await requireUnchangedNativeMigrationSource(snapshot)
    await input.processFence()
    await assertOwned()
    await unlink(snapshot.path)
    await hooks.onStep?.(`after:retire:${snapshot.role}`)
  }
  return advanceNativeMigration(input.paths, 'committed', 'retired', {
    assertOwned: async () => {
      for (const source of sources)
        if (!(await absent(source.path))) refuse('retirement-refused')
      await input.processFence()
      await assertOwned()
    },
    onWriteStep: async (step) => hooks.onStep?.(`${step}:journal:retired`),
  })
}

async function repair(
  input: NativeMigrationOptions,
  assertOwned: () => Promise<void>,
  hooks: NativeMigrationHooks,
): Promise<void> {
  const auth = await readNativeMigrationSource('hostAuth', input.hostAuthPath)
  owned(auth)
  const entry = inspectNativeHostAuthEntry(input.host, auth.data)
  await writeNativeHostAuth(
    {
      host: input.host,
      authPath: input.hostAuthPath,
      sourceDigest: entry.digest,
      expectedDigest: expectedAuth(input, auth),
      env: input.env,
      removePiAnthropicAuth: input.removePiAnthropicAuth,
      processFence: async () => {
        await input.processFence()
        await assertOwned()
      },
    },
    hooks.hostWrite,
  )
}

/** Offline, crash-forward transaction. Native serving never calls this controller. */
export async function runNativeMigration(
  input: NativeMigrationOptions,
  hooks: NativeMigrationHooks = {},
): Promise<NativeMigrationJournal> {
  const paths = { ...input.paths }
  const operation = { ...input, paths, env: { ...input.env } }
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
        const assertMigration = async () => {
          try {
            await lease.assertOwned()
          } catch {
            refuse('ownership-lost')
          }
        }
        const captured = await capture(operation)
        if (operation.preflight) {
          const previous = preflights.get(operation.preflight)
          if (
            !previous ||
            operation.preflight.storageId !== paths.storageId ||
            operation.preflight.host !== operation.host ||
            previous.config.digest !== captured.config.digest ||
            previous.state.digest !== captured.state.digest ||
            previous.routing.digest !== captured.routing.digest ||
            inspectNativeHostAuthEntry(operation.host, previous.auth.data)
              .digest !==
              inspectNativeHostAuthEntry(operation.host, captured.auth.data)
                .digest ||
            previous.hostAuthPath !== captured.hostAuthPath ||
            previous.routingSourcePath !== captured.routingSourcePath ||
            previous.routingDestinationPath !== captured.routingDestinationPath
          )
            refuse()
        }
        let journal = captured.journal
        const step = async (label: string) => hooks.onStep?.(label)
        const journalHooks = {
          assertOwned: async () => {
            await checkPaths(operation, captured)
            await checkLegacy(captured)
            await operation.processFence()
            await assertMigration()
          },
          onWriteStep: async (
            write: 'before-write' | 'after-write',
            value: NativeMigrationJournal,
          ) => {
            await step(
              value.phase === 'verified' && value.preparedProof
                ? `${write}:proof`
                : `${write}:journal:${value.phase}`,
            )
          },
        }
        // Once a switch to vault custody is requested or prepared, the
        // activation controller owns the host auth file. Restoring the ordinary host activation marker
        // could delete a credential that controller must refuse to adopt.
        if (journal?.phase === 'retired') {
          if (journal.activation === null)
            await repair(operation, assertMigration, hooks)
          return journal
        }
        if (journal?.phase === 'committed') {
          journal = await retire(operation, journal, assertMigration, hooks)
          if (journal.activation === null)
            await repair(operation, assertMigration, hooks)
          return journal
        }
        if (!journal) {
          await assertMigration()
          journal = await beginNativeMigration(
            paths,
            {
              host: operation.host,
              sources: {
                config: captured.config.digest,
                state: captured.state.digest,
                hostAuth: inspectNativeHostAuthEntry(
                  operation.host,
                  captured.auth.data,
                ).digest,
                routing: captured.routing.digest,
              },
              hostAuthPath: captured.hostAuthPath,
              routingPaths: {
                source: captured.routingSourcePath,
                destination: captured.routingDestinationPath,
              },
              ...(operation.requestVaultActivation
                ? { activation: 'requested' as const }
                : {}),
            },
            journalHooks,
          )
        }
        const store = createNativePoolStore({
          paths,
          quota: nativeQuotaCodec,
          onLockStep: hooks.store?.onLockStep,
          onStep: async (write, info) => {
            await hooks.store?.onStep?.(write, info)
            await step(`${write}:store:${info.operation}`)
            if (write.startsWith('before-')) {
              await checkLegacy(captured)
              await operation.processFence()
              await assertMigration()
            }
          },
        })
        let bytes: string | undefined
        let seed: NativeVaultRosterSeed | undefined
        if (journal.phase === 'building') {
          const projection = captured.projection
          if (!projection) refuse()
          const beforeMutator = async () => {
            await checkPaths(operation, captured)
            await checkLegacy(captured)
            await operation.processFence()
            await assertMigration()
          }
          await beforeMutator()
          await store.initialize()
          // Disabled aliases go first and are disabled immediately, so a later
          // enabled alias does not inherit a transient duplicate-identity refusal.
          for (const account of [...projection.accounts]
            .filter((account) => account.credential)
            .sort((a, b) => Number(a.enabled) - Number(b.enabled))) {
            const current = (await publicRows(store)).find(
              (row) => row.id === account.id,
            )
            if (current)
              requireNativeMigrationSourceRows(
                {
                  ...projection,
                  accounts: [
                    {
                      ...account,
                      credential: account.credential,
                      enabled: current.enabled,
                    },
                  ],
                },
                [current],
                false,
              )
            else {
              await beforeMutator()
              if (!account.credential) refuse()
              const result = await store.add({
                id: account.id,
                credential: account.credential,
                ...(account.identity !== undefined
                  ? { identity: account.identity }
                  : {}),
                ...(account.label !== undefined
                  ? { label: account.label }
                  : {}),
              })
              if (result.id !== account.id) refuse()
              await step(`after:add:${account.id}`)
            }
            await beforeMutator()
            if (!account.enabled)
              await store.disable(account.id, 'user-disabled')
            else await store.enable(account.id)
            if (account.quota) {
              const row = (await publicRows(store)).find(
                (row) => row.id === account.id,
              )
              if (!row?.credentialEpoch) refuse()
              await beforeMutator()
              await store.recordQuota(
                account.id,
                {
                  credentialEpoch: row.credentialEpoch,
                  ...(row.identity !== undefined
                    ? { identity: row.identity }
                    : {}),
                },
                account.quota,
              )
            }
          }
          await beforeMutator()
          await store.reorder(
            projection.accounts
              .filter((account) => account.credential)
              .map((account) => account.id),
          )
          await beforeMutator()
          await store.updateSettings(() => projection.settings)
          if (captured.seedInput) {
            await beforeMutator()
            await step('before:roster')
            if (!operation.custody) refuse()
            seed = await operation.custody.publishSeed(
              paths,
              captured.seedInput,
              { assertOwned: beforeMutator },
            )
            await assertMigration()
            await step('after:roster')
          }
          const rows = await publicRows(store)
          requireNativeMigrationSourceRows(projection, rows)
          const projected = projectNativeMigrationRuntime(
            paths,
            projection,
            rows,
            seed,
          )
          await beforeMutator()
          await step('before:runtime')
          if (captured.seedInput) {
            if (!operation.custody) refuse()
            await operation.custody.publishRuntimeSeed(paths, projected, {
              assertOwned: beforeMutator,
            })
          } else
            await updateNativeRuntime(
              paths.runtime,
              paths.storageId,
              (current) => {
                if (
                  Object.keys(current.accounts).length > 0 &&
                  nativeMigrationCanonicalJson(current) !==
                    nativeMigrationCanonicalJson(projected)
                )
                  refuse()
                return projected
              },
              { beforeRename: beforeMutator },
            )
          await step('after:runtime')
          bytes = routingBytes(captured)
          await heldPool(paths, assertMigration, async (assertOwned) => {
            await checkLegacy(captured)
            requireNativeMigrationSourceRows(
              projection,
              await publicRows(store),
            )
            if (
              nativeMigrationCanonicalJson(await runtimeState(paths)) !==
              nativeMigrationCanonicalJson(projected)
            )
              refuse()
            journal = await advanceNativeMigration(
              paths,
              'building',
              'verified',
              {
                ...journalHooks,
                assertOwned: async () => {
                  await checkLegacy(captured)
                  requireNativeMigrationSourceRows(
                    projection,
                    await publicRows(store),
                  )
                  if (
                    nativeMigrationCanonicalJson(await runtimeState(paths)) !==
                    nativeMigrationCanonicalJson(projected)
                  )
                    refuse()
                  await operation.processFence()
                  await assertOwned()
                },
              },
            )
          })
        }
        // Releasing the pool leases above permits no host write. Re-acquire them,
        // re-read all public rows/runtime and retain them through durable commit.
        journal = await heldPool(
          paths,
          assertMigration,
          async (assertOwned) => {
            if (!journal) refuse()
            await checkLegacy(captured)
            let rows = await publicRows(store)
            let runtime = await importedRuntimeProjection(paths, store, rows)
            if (journal.expectedHostAuth === 'unprepared') {
              if (!captured.projection) refuse()
              requireNativeMigrationSourceRows(captured.projection, rows)
              const importedSettings = await store.readSettings()
              if (
                importedSettings.status !== 'ready' ||
                nativeMigrationCanonicalJson(importedSettings.settings) !==
                  nativeMigrationCanonicalJson(captured.projection.settings)
              )
                refuse()
              if (captured.seedInput && !seed) {
                // Publication adopts an existing verified seed without rewriting it.
                if (!operation.custody) refuse()
                // No roster mutator runs under the pool/runtime leases. On verified
                // resume, the retained seed is public JSON and was published already.
                const retained = await readNativeMigrationSource(
                  'state',
                  paths.roster,
                )
                if (!retained.data) refuse()
                const document = await readVaultRoster(paths.roster)
                if (!document) refuse()
                validateNativeVaultRosterSeed(document, captured.seedInput)
                seed = buildNativeVaultRosterSeed(captured.seedInput)
              }
              if (
                nativeMigrationCanonicalJson(await runtimeState(paths)) !==
                nativeMigrationCanonicalJson(
                  projectNativeMigrationRuntime(
                    paths,
                    captured.projection,
                    rows,
                    seed,
                  ),
                )
              )
                refuse()
              await requireUnchangedNativeMigrationSource(captured.routing)
              bytes ??= routingBytes(captured)
              const preparedProof = captureNativeMigrationPreparedProof(
                rows,
                runtime,
              )
              journal = await recordNativeMigrationExpectations(
                paths,
                {
                  expectedHostAuth: expectedAuth(operation, captured.auth),
                  expectedRouting: bytesDigest(bytes),
                  preparedProof,
                },
                {
                  ...journalHooks,
                  assertOwned: async () => {
                    await checkLegacy(captured)
                    await requireUnchangedNativeMigrationSource(
                      captured.routing,
                    )
                    const current = await publicRows(store)
                    requireNativeMigrationPreparedProof(
                      preparedProof,
                      current,
                      await importedRuntimeProjection(paths, store, current),
                    )
                    await operation.processFence()
                    await assertOwned()
                  },
                },
              )
            }
            requireNativeMigrationPreparedProof(
              journal.preparedProof,
              rows,
              runtime,
            )
            const authoritative = journal
            const recheck = async () => {
              await checkPaths(operation, captured)
              await checkLegacy(captured)
              rows = await publicRows(store)
              runtime = await importedRuntimeProjection(paths, store, rows)
              requireNativeMigrationPreparedProof(
                authoritative.preparedProof,
                rows,
                runtime,
              )
              await operation.processFence()
              await assertOwned()
            }
            await withLock(
              operation.routingDestinationPath,
              { name: 'write', ttlMs: 30_000, timeoutMs: 15_000, renew: true },
              async (routingLease) => {
                const destination = await readNativeMigrationSource(
                  'routing',
                  operation.routingDestinationPath,
                )
                owned(destination)
                if (destination.digest !== authoritative.expectedRouting) {
                  if (
                    authoritative.phase !== 'verified' ||
                    (captured.routingSourcePath !==
                    captured.routingDestinationPath
                      ? destination.digest !== null
                      : destination.digest !== authoritative.sources.routing)
                  )
                    refuse()
                  await requireUnchangedNativeMigrationSource(captured.routing)
                  bytes ??= routingBytes(captured)
                  if (
                    bytesDigest(bytes) !== authoritative.expectedRouting ||
                    !bytes
                  )
                    refuse()
                  await step('before:routing')
                  await writeJsonAtomic(
                    operation.routingDestinationPath,
                    JSON.parse(bytes),
                    {
                      beforeRename: async () => {
                        await requireUnchangedNativeMigrationSource(destination)
                        await recheck()
                        await routingLease.assertOwned()
                      },
                    },
                  )
                  // Both writers use the same pretty JSON/newline contract; resume
                  // recognizes the durable bytes without pruning or reserialization.
                  await step('after:routing')
                }
                const auth = await readNativeMigrationSource(
                  'hostAuth',
                  operation.hostAuthPath,
                )
                owned(auth)
                const entry = inspectNativeHostAuthEntry(
                  operation.host,
                  auth.data,
                )
                if (
                  entry.digest !== authoritative.sources.hostAuth &&
                  entry.digest !== authoritative.expectedHostAuth
                )
                  refuse()
                if (
                  authoritative.phase === 'activation-installed' &&
                  entry.digest !== authoritative.expectedHostAuth
                )
                  refuse()
                await step('before:host')
                await recheck()
                await mkdir(dirname(operation.hostAuthPath), {
                  recursive: true,
                  mode: 0o700,
                })
                if (entry.digest !== authoritative.expectedHostAuth)
                  await writeNativeHostAuth(
                    {
                      host: operation.host,
                      authPath: operation.hostAuthPath,
                      sourceDigest: authoritative.sources.hostAuth,
                      expectedDigest: authoritative.expectedHostAuth,
                      env: operation.env,
                      removePiAnthropicAuth: operation.removePiAnthropicAuth,
                      processFence: async () => {
                        await recheck()
                        await routingLease.assertOwned()
                      },
                    },
                    hooks.hostWrite,
                  )
                await step('after:host')
                await recheck()
                const effect = await readNativeMigrationSource(
                  'hostAuth',
                  operation.hostAuthPath,
                )
                if (
                  inspectNativeHostAuthEntry(operation.host, effect.data)
                    .digest !== authoritative.expectedHostAuth
                )
                  refuse()
                const routed = await readNativeMigrationSource(
                  'routing',
                  operation.routingDestinationPath,
                )
                if (routed.digest !== authoritative.expectedRouting) refuse()
                const fencedHooks = {
                  ...journalHooks,
                  assertOwned: async () => {
                    await recheck()
                    const currentHost = await readNativeMigrationSource(
                      'hostAuth',
                      operation.hostAuthPath,
                    )
                    const currentRouting = await readNativeMigrationSource(
                      'routing',
                      operation.routingDestinationPath,
                    )
                    if (
                      inspectNativeHostAuthEntry(
                        operation.host,
                        currentHost.data,
                      ).digest !== authoritative.expectedHostAuth ||
                      currentRouting.digest !== authoritative.expectedRouting
                    )
                      refuse()
                    await routingLease.assertOwned()
                  },
                }
                if (journal?.phase === 'verified')
                  journal = await advanceNativeMigration(
                    paths,
                    'verified',
                    'activation-installed',
                    fencedHooks,
                  )
                journal = await advanceNativeMigration(
                  paths,
                  'activation-installed',
                  'committed',
                  fencedHooks,
                )
              },
            )
            return journal
          },
        )
        return await retire(operation, journal, assertMigration, hooks)
      },
    )
  } catch (error) {
    if (error instanceof NativeMigrationSourceError)
      refuse(
        error.code === 'unsafe-source' ? 'unsafe-source' : 'invalid-source',
      )
    if (error instanceof NativeMigrationProjectionError) refuse()
    if (
      error instanceof NativeMigrationProofError ||
      error instanceof NativeMigrationError
    )
      throw error
    if (error instanceof Error && error.name === 'LockContentionError')
      refuse('migration-busy')
    throw error
  } finally {
    if (operation.preflight) preflights.delete(operation.preflight)
  }
}
