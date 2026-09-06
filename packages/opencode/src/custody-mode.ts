import {
  getRefreshBeforeExpiryMs,
  isCustodyTombstoneOAuth,
} from '@cortexkit/anthropic-auth-core'

import {
  custodyPreflightDivergenceCheck,
  localAuthFingerprint,
} from './local-login.ts'

type ModeDimension = 'L' | 'C'
type MainDimension = 'R' | 'T' | 'X'
type FallbackDimension = 'R' | 'T' | 'M'
type EvidenceDimension = 'V' | 'N'

type Lock = { release: () => Promise<void> }

export type CustodyCacheCredential = {
  credentialId: string
  recordVersion: number
  access: string
  refresh: string
  expiresAt: number
  state: 'usable' | 'revoked' | 'reauth' | 'timeout'
}

export type ClaustrumTakeoverPlan = {
  accounts: Array<{
    id: string
    handle: string
    credentialId: string
    recordVersion: number
    localAuthFingerprint: string
    cacheCredential: CustodyCacheCredential
  }>
  toJSON: () => unknown
  toString: () => string
}

export class CustodyPreflightRefusedError extends Error {
  readonly code = 'custody_preflight_refused'

  constructor(
    readonly accountId: string,
    readonly reason: string,
  ) {
    super(`custody preflight refused for account ${accountId}: ${reason}`)
  }

  toJSON() {
    return { code: this.code, accountId: this.accountId, reason: this.reason }
  }
}

export class CustodyStateMismatchError extends Error {
  readonly code = 'custody_state_mismatch'

  constructor(
    readonly verdict: string,
    readonly dimensions: {
      mode: ModeDimension
      main: MainDimension
      fallbacks: FallbackDimension
      evidence: EvidenceDimension
    },
  ) {
    super(`custody state mismatch: ${verdict}`)
  }

  toJSON() {
    return {
      code: this.code,
      verdict: this.verdict,
      dimensions: this.dimensions,
    }
  }
}

export class CustodyLockBusyError extends Error {
  readonly code = 'lock_busy'

  constructor(readonly lockName: string) {
    super(`custody transition lock busy: ${lockName}`)
  }
}

type PreflightRoute = {
  id: string
  label?: string
  enabled?: boolean
  type: string
  local?: unknown
}

type PreflightBinding = {
  accountId: string
  label: string
  handle: string
  credentialId: string
}

export type PreflightClaustrumTakeoverInput = {
  now: number
  storage: {
    refresh?: { refreshBeforeExpiryMinutes?: number }
    claustrumDivergence?: Record<
      string,
      { minimumRecordVersion: number; observedAt?: number }
    >
  } | null
  main: Pick<PreflightRoute, 'id' | 'label' | 'enabled'>
  fallbacks: PreflightRoute[]
  hostAuth: { get: () => unknown | Promise<unknown> }
  bindings: PreflightBinding[]
  cache: {
    get: (
      handle: string,
      options: { minTtlMs: number },
    ) => Promise<CustodyCacheCredential | { state: string; expiresAt?: number }>
  }
}

function localOAuthMaterial(
  value: unknown,
): { access: string; refresh: string } | undefined {
  if (
    !value ||
    typeof value !== 'object' ||
    (value as { type?: unknown }).type !== 'oauth' ||
    isCustodyTombstoneOAuth(value, 'anthropic')
  )
    return undefined
  const { access, refresh } = value as { access?: unknown; refresh?: unknown }
  if (
    typeof access !== 'string' ||
    !access ||
    typeof refresh !== 'string' ||
    !refresh
  )
    return undefined
  return { access, refresh }
}

function enabledOAuthRoutes(
  input: PreflightClaustrumTakeoverInput,
  mainAuth: unknown,
) {
  return [
    { ...input.main, type: 'oauth', local: mainAuth },
    ...input.fallbacks,
  ].filter((route) => route.type === 'oauth' && route.enabled !== false)
}

function findStrictBinding(
  route: PreflightRoute,
  bindings: PreflightBinding[],
) {
  const matches = bindings.filter(
    (binding) =>
      binding.accountId === route.id && binding.label === route.label,
  )
  return matches.length === 1 ? matches[0] : undefined
}

function isUsableCredential(
  credential: CustodyCacheCredential | { state: string; expiresAt?: number },
): credential is CustodyCacheCredential {
  return credential.state === 'usable' && 'recordVersion' in credential
}

export async function preflightClaustrumTakeover(
  input: PreflightClaustrumTakeoverInput,
): Promise<ClaustrumTakeoverPlan> {
  const mainAuth = await input.hostAuth.get()
  if (!input.storage && !localOAuthMaterial(mainAuth))
    throw new CustodyPreflightRefusedError(
      input.main.id,
      'mode_not_committed_local_credential_unavailable',
    )

  const minTtlMs =
    getRefreshBeforeExpiryMs(input.storage as never) + 30 * 60_000
  const accounts: ClaustrumTakeoverPlan['accounts'] = []
  for (const route of enabledOAuthRoutes(input, mainAuth)) {
    const binding = findStrictBinding(route, input.bindings)
    if (!binding)
      throw new CustodyPreflightRefusedError(route.id, 'binding_missing')
    const credential = await input.cache.get(binding.handle, { minTtlMs })
    if (credential.state === 'revoked')
      throw new CustodyPreflightRefusedError(route.id, 'credential_revoked')
    if (credential.state === 'reauth')
      throw new CustodyPreflightRefusedError(route.id, 'credential_reauth')
    if (credential.state === 'timeout')
      throw new CustodyPreflightRefusedError(route.id, 'credential_timeout')
    if (
      !isUsableCredential(credential) ||
      credential.expiresAt < input.now + minTtlMs
    )
      throw new CustodyPreflightRefusedError(route.id, 'credential_unusable')
    if (
      !custodyPreflightDivergenceCheck(
        {
          credentialId: binding.credentialId,
          recordVersion: credential.recordVersion,
        },
        input.storage as Parameters<typeof custodyPreflightDivergenceCheck>[1],
      ).ok
    )
      throw new CustodyPreflightRefusedError(route.id, 'divergence_fenced')
    const local = localOAuthMaterial(route.local)
    if (!local)
      throw new CustodyPreflightRefusedError(
        route.id,
        'local_credential_unavailable',
      )
    accounts.push({
      id: route.id,
      handle: binding.handle,
      credentialId: binding.credentialId,
      recordVersion: credential.recordVersion,
      localAuthFingerprint: localAuthFingerprint(local.access, local.refresh),
      cacheCredential: credential,
    })
  }
  return {
    accounts,
    toJSON: () => ({
      accounts: accounts.map(
        ({ id, credentialId, recordVersion, localAuthFingerprint }) => ({
          id,
          credentialId,
          recordVersion,
          localAuthFingerprint,
        }),
      ),
    }),
    toString: () => 'ClaustrumTakeoverPlan',
  }
}

const startupVerdicts: Record<string, string> = {
  'L|R|R|V': 'LOCAL_SERVE',
  'L|R|R|N': 'LOCAL_SERVE',
  'L|R|T|V': 'REMAIN_DARK_PENDING_LOGIN',
  'L|R|T|N': 'REMAIN_DARK_PENDING_LOGIN',
  'L|R|M|V': 'REMAIN_DARK_PENDING_LOGIN',
  'L|R|M|N': 'REMAIN_DARK_PENDING_LOGIN',
  'L|T|R|V': 'REMAIN_DARK_PENDING_LOGIN',
  'L|T|R|N': 'REMAIN_DARK_PENDING_LOGIN',
  'L|T|T|V': 'REMAIN_DARK_PENDING_LOGIN',
  'L|T|T|N': 'REMAIN_DARK_PENDING_LOGIN',
  'L|T|M|V': 'REMAIN_DARK_PENDING_LOGIN',
  'L|T|M|N': 'REMAIN_DARK_PENDING_LOGIN',
  'L|X|R|V': 'FAIL_CLOSED',
  'L|X|R|N': 'FAIL_CLOSED',
  'L|X|T|V': 'FAIL_CLOSED',
  'L|X|T|N': 'FAIL_CLOSED',
  'L|X|M|V': 'FAIL_CLOSED',
  'L|X|M|N': 'FAIL_CLOSED',
  'C|R|R|V': 'TAKEOVER_INCOMPLETE_MAIN_REAL',
  'C|R|R|N': 'TAKEOVER_INCOMPLETE_VAULT_UNAVAILABLE',
  'C|R|T|V': 'TAKEOVER_INCOMPLETE_MAIN_REAL',
  'C|R|T|N': 'FAIL_CLOSED',
  'C|R|M|V': 'TAKEOVER_INCOMPLETE_MAIN_REAL',
  'C|R|M|N': 'FAIL_CLOSED',
  'C|T|R|V': 'RESUME_TAKEOVER',
  'C|T|R|N': 'FAIL_CLOSED',
  'C|T|T|V': 'CLAUSTRUM_SERVE',
  'C|T|T|N': 'FAIL_CLOSED',
  'C|T|M|V': 'RESUME_TAKEOVER',
  'C|T|M|N': 'FAIL_CLOSED',
  'C|X|R|V': 'TAKEOVER_INCOMPLETE_SLOT_ABSENT',
  'C|X|R|N': 'FAIL_CLOSED',
  'C|X|T|V': 'TAKEOVER_INCOMPLETE_SLOT_ABSENT',
  'C|X|T|N': 'FAIL_CLOSED',
  'C|X|M|V': 'TAKEOVER_INCOMPLETE_SLOT_ABSENT',
  'C|X|M|N': 'FAIL_CLOSED',
}

export function reconcileCustodyStartup(input: {
  mode: ModeDimension
  main: MainDimension
  fallbacks: FallbackDimension
  evidence: EvidenceDimension
}): { verdict: string } {
  const verdict =
    startupVerdicts[
      `${input.mode}|${input.main}|${input.fallbacks}|${input.evidence}`
    ]
  if (!verdict) throw new CustodyStateMismatchError('FAIL_CLOSED', input)
  if (verdict === 'LOCAL_SERVE' || verdict === 'CLAUSTRUM_SERVE')
    return { verdict }
  throw new CustodyStateMismatchError(verdict, input)
}

export async function acquireCustodyTransitionLocks(input: {
  storagePath: string
  manifestPath: string
  fallbackAccountIds: string[]
  acquireTransition: (input: {
    name: 'claustrum-mode-transition'
    path: string
  }) => Promise<Lock | null>
  acquireManifest: (input: { path: string }) => Promise<Lock | null>
  acquireRefresh: (input: {
    name: string
    path: string
  }) => Promise<Lock | null>
}): Promise<{ release: () => Promise<void> }> {
  const locks: Lock[] = []
  const acquire = async (name: string, getter: () => Promise<Lock | null>) => {
    const lock = await getter()
    if (!lock) throw new CustodyLockBusyError(name)
    locks.push(lock)
  }
  try {
    await acquire('claustrum-mode-transition', () =>
      input.acquireTransition({
        name: 'claustrum-mode-transition',
        path: input.storagePath,
      }),
    )
    await acquire('manifest', () =>
      input.acquireManifest({ path: input.manifestPath }),
    )
    await acquire('main-refresh', () =>
      input.acquireRefresh({ name: 'main-refresh', path: input.storagePath }),
    )
    for (const id of [...input.fallbackAccountIds].sort())
      await acquire(`${id}-refresh`, () =>
        input.acquireRefresh({
          name: `${id}-refresh`,
          path: input.storagePath,
        }),
      )
  } catch (error) {
    await Promise.all(locks.reverse().map((lock) => lock.release()))
    throw error
  }
  return {
    release: async () => {
      for (const lock of locks.reverse()) await lock.release()
    },
  }
}

export class CustodyTransitionError extends Error {
  readonly code = 'custody_transition_failed'

  constructor(
    readonly stage:
      | 'reverify_fingerprint'
      | 'write_sidecar'
      | 'readback'
      | 'mode_commit',
    readonly accountId?: string,
  ) {
    super(
      accountId
        ? `custody transition failed at ${stage} for account ${accountId}`
        : `custody transition failed at ${stage}`,
    )
  }

  toJSON() {
    return { code: this.code, stage: this.stage, accountId: this.accountId }
  }
}

export class CustodyTransitionRollbackError extends Error {
  readonly code = 'custody_transition_rollback_failed'

  constructor() {
    super('custody transition rollback failed')
  }

  toJSON() {
    return { code: this.code }
  }
}

export type CustodySidecarSnapshot = {
  config: Uint8Array
  state: Uint8Array
}

export type ExecuteClaustrumTakeoverDeps = {
  locks: Parameters<typeof acquireCustodyTransitionLocks>[0]
  getLocalAuth: (accountId: string) => Promise<unknown>
  isCommitted: (plan: ClaustrumTakeoverPlan) => Promise<boolean>
  snapshotSidecars: () => Promise<CustodySidecarSnapshot>
  writeSidecarAccount: (
    account: ClaustrumTakeoverPlan['accounts'][number],
  ) => Promise<void>
  verifyTarget: (plan: ClaustrumTakeoverPlan) => Promise<boolean>
  restoreSidecars: (snapshot: CustodySidecarSnapshot) => Promise<void>
  verifyRollback: (snapshot: CustodySidecarSnapshot) => Promise<boolean>
  setMode: (mode: 'claustrum') => Promise<'changed' | 'unchanged'>
}

export async function executeClaustrumTakeover(
  plan: ClaustrumTakeoverPlan,
  deps: ExecuteClaustrumTakeoverDeps,
): Promise<'changed' | 'unchanged'> {
  const locks = await acquireCustodyTransitionLocks(deps.locks)
  try {
    if (await deps.isCommitted(plan)) return 'unchanged'

    for (const account of plan.accounts) {
      const local = localOAuthMaterial(await deps.getLocalAuth(account.id))
      if (
        !local ||
        localAuthFingerprint(local.access, local.refresh) !==
          account.localAuthFingerprint
      ) {
        throw new CustodyTransitionError('reverify_fingerprint', account.id)
      }
    }

    const snapshot = await deps.snapshotSidecars()
    let accountId: string | undefined
    try {
      for (const account of plan.accounts) {
        accountId = account.id
        await deps.writeSidecarAccount(account)
      }
      if (!(await deps.verifyTarget(plan))) {
        throw new CustodyTransitionError('readback', accountId)
      }
      try {
        await deps.setMode('claustrum')
      } catch {
        throw new CustodyTransitionError('mode_commit')
      }
      return 'changed'
    } catch (error) {
      try {
        await deps.restoreSidecars(snapshot)
        if (!(await deps.verifyRollback(snapshot))) {
          throw new CustodyTransitionRollbackError()
        }
      } catch (rollbackError) {
        if (rollbackError instanceof CustodyTransitionRollbackError)
          throw rollbackError
        throw new CustodyTransitionRollbackError()
      }
      if (error instanceof CustodyTransitionError) throw error
      throw new CustodyTransitionError('write_sidecar', accountId)
    }
  } finally {
    await locks.release()
  }
}
