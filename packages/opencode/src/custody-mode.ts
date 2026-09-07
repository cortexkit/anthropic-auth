import {
  getRefreshBeforeExpiryMs,
  isCustodyTombstoneOAuth,
  setClaustrumModePersistent,
} from '@cortexkit/anthropic-auth-core'

import {
  custodyPreflightDivergenceCheck,
  localAuthFingerprint,
} from './local-login.ts'

type ModeDimension = 'L' | 'C'
type MainDimension = 'R' | 'T' | 'X'
type FallbackDimension = 'R' | 'T' | 'M'
type EvidenceDimension = 'V' | 'N' | 'unknown'

type Lock = { release: () => Promise<void> }

export const OPENCODE_MAIN_OAUTH_REFRESH_LOCK = 'opencode-main-oauth-refresh'

export type CustodyCacheCredential = {
  credentialId?: string
  recordVersion: number
  access: string
  refresh: string
  expiresAt: number | null
  state: 'usable' | 'revoked' | 'reauth' | 'timeout'
}

export type ClaustrumTakeoverPlan = {
  accounts: Array<{
    id: string
    label: string
    handle: string
    credentialId: string
    recordVersion: number
    bindingPersisted: boolean
    localAuthFingerprint: string
    cacheCredential: CustodyCacheCredential
  }>
  toJSON: () => unknown
  toString: () => string
}

export type CustodyPreflightRefusalReason =
  | 'TAKEOVER_INCOMPLETE_MAIN_REAL'
  | 'TAKEOVER_INCOMPLETE_MAIN_BINDING'
  | 'binding_missing'
  | 'credential_revoked'
  | 'credential_reauth'
  | 'credential_timeout'
  | 'credential_unusable'
  | 'credential_identity_mismatch'
  | 'divergence_fenced'
  | 'TAKEOVER_INCOMPLETE_MAIN_SLOT'
  | 'local_credential_unavailable'

export type CustodyPreflightRefusal = {
  label: string
  reason: CustodyPreflightRefusalReason
  guidance?: string
}

export type MainCustodyRefusal =
  | 'cold'
  | 'reauth'
  | 'takeover-incomplete'
  | 'identity-mismatch'

export class CustodyPreflightRefusedError extends Error {
  readonly code = 'custody_preflight_refused'

  constructor(
    readonly accountId: string,
    readonly reason: CustodyPreflightRefusalReason,
    readonly refusals: CustodyPreflightRefusal[] = [
      { label: accountId, reason },
    ],
  ) {
    super(`custody preflight refused for account ${accountId}: ${reason}`)
  }

  toJSON() {
    return {
      ok: false,
      code: this.code,
      accountId: this.accountId,
      reason: this.reason,
      refusals: this.refusals,
    }
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
  source?: 'manifest' | 'legacy'
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
  debug?: (message: string) => void
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

function oauthFingerprintMaterial(
  value: unknown,
): { access: string; refresh: string } | undefined {
  if (
    !value ||
    typeof value !== 'object' ||
    (value as { type?: unknown }).type !== 'oauth'
  )
    return undefined
  const { access, refresh } = value as { access?: unknown; refresh?: unknown }
  if (typeof access !== 'string' || typeof refresh !== 'string')
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
  credential:
    | CustodyCacheCredential
    | { state: string; expiresAt?: number | null },
): credential is CustodyCacheCredential {
  return credential.state === 'usable' && 'recordVersion' in credential
}

type CollectedPreflightRefusal = CustodyPreflightRefusal & {
  accountId: string
}

export async function preflightClaustrumTakeover(
  input: PreflightClaustrumTakeoverInput,
): Promise<ClaustrumTakeoverPlan> {
  const mainAuth = await input.hostAuth.get()
  const mainIsTombstoned = isCustodyTombstoneOAuth(mainAuth, 'anthropic')

  const minTtlMs =
    getRefreshBeforeExpiryMs(input.storage as never) + 30 * 60_000
  const accounts: ClaustrumTakeoverPlan['accounts'] = []
  const refusals: CollectedPreflightRefusal[] = []
  const refuse = (
    route: PreflightRoute,
    reason: CustodyPreflightRefusalReason,
  ) => {
    refusals.push({
      accountId: route.id,
      label: route.label ?? route.id,
      reason,
      ...(route.id === input.main.id &&
      reason === 'TAKEOVER_INCOMPLETE_MAIN_REAL'
        ? {
            guidance:
              'Run ck auth migrate-plugin --allow-main before retrying.',
          }
        : {}),
    })
  }
  if (!mainIsTombstoned)
    refuse({ ...input.main, type: 'oauth' }, 'TAKEOVER_INCOMPLETE_MAIN_REAL')

  for (const route of enabledOAuthRoutes(input, mainAuth)) {
    if (route.id === input.main.id && !mainIsTombstoned) continue
    const binding = findStrictBinding(route, input.bindings)
    if (!binding) {
      refuse(
        route,
        route.id === input.main.id
          ? 'TAKEOVER_INCOMPLETE_MAIN_BINDING'
          : 'binding_missing',
      )
      continue
    }
    const credential = await input.cache.get(binding.handle, { minTtlMs })
    if (credential.state === 'revoked') {
      refuse(route, 'credential_revoked')
      continue
    }
    if (credential.state === 'reauth') {
      refuse(route, 'credential_reauth')
      continue
    }
    if (credential.state === 'timeout') {
      refuse(route, 'credential_timeout')
      continue
    }
    if (
      !isUsableCredential(credential) ||
      (credential.expiresAt !== null &&
        credential.expiresAt < input.now + minTtlMs)
    ) {
      refuse(route, 'credential_unusable')
      continue
    }
    // Without a vault id, a same-account wrong-record response remains possible; the vault `account_id` vs persisted `anthropicAccountUuid` fence is the live protection.
    if (credential.credentialId === undefined)
      input.debug?.(
        'custody identity check skipped: vault supplied no credential id',
      )
    else if (credential.credentialId !== binding.credentialId) {
      refuse(route, 'credential_identity_mismatch')
      continue
    }
    if (
      !custodyPreflightDivergenceCheck(
        {
          credentialId: binding.credentialId,
          recordVersion: credential.recordVersion,
        },
        (input.storage ?? {}) as Parameters<
          typeof custodyPreflightDivergenceCheck
        >[1],
      ).ok
    ) {
      refuse(route, 'divergence_fenced')
      continue
    }
    const local =
      route.id === input.main.id
        ? oauthFingerprintMaterial(route.local)
        : localOAuthMaterial(route.local)
    if (!local) {
      refuse(
        route,
        route.id === input.main.id
          ? 'TAKEOVER_INCOMPLETE_MAIN_SLOT'
          : 'local_credential_unavailable',
      )
      continue
    }
    accounts.push({
      id: route.id,
      label: binding.label,
      handle: binding.handle,
      credentialId: binding.credentialId,
      recordVersion: credential.recordVersion,
      bindingPersisted: binding.source !== 'legacy',
      localAuthFingerprint: localAuthFingerprint(local.access, local.refresh),
      cacheCredential: credential,
    })
  }
  const first = refusals.at(0)
  if (first) {
    throw new CustodyPreflightRefusedError(
      first.accountId,
      first.reason,
      refusals.map(({ accountId: _, ...refusal }) => refusal),
    )
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

export function reconcileCustodyStartup(
  input:
    | {
        mode: ModeDimension
        main: MainDimension
        fallbacks: FallbackDimension
        evidence: EvidenceDimension
      }
    | {
        mode: ModeDimension
        mainSlot: 'unknown'
        fallbacks: FallbackDimension
        evidence: EvidenceDimension
      },
): { verdict: string; provisional?: boolean } {
  if ('mainSlot' in input) {
    const evidence = input.evidence === 'unknown' ? 'V' : input.evidence
    const verdicts = new Set(
      (['R', 'T', 'X'] as const).map(
        (main) =>
          startupVerdicts[
            `${input.mode}|${main}|${input.fallbacks}|${evidence}`
          ],
      ),
    )
    if (verdicts.size === 1) {
      const [verdict] = verdicts
      return { verdict: verdict ?? 'FAIL_CLOSED', provisional: true }
    }
    return { verdict: 'PENDING_MAIN_SLOT', provisional: true }
  }
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
    await acquire(OPENCODE_MAIN_OAUTH_REFRESH_LOCK, () =>
      input.acquireRefresh({
        name: OPENCODE_MAIN_OAUTH_REFRESH_LOCK,
        path: input.storagePath,
      }),
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
      | 'write_manifest'
      | 'write_sidecar'
      | 'readback'
      | 'mode_commit'
      | 'post_commit_readback',
    readonly accountId?: string,
    readonly guidance?: string,
  ) {
    super(
      `${
        accountId
          ? `custody transition failed at ${stage} for account ${accountId}`
          : `custody transition failed at ${stage}`
      }${guidance ? ` — ${guidance}` : ''}`,
    )
  }

  toJSON() {
    return {
      code: this.code,
      stage: this.stage,
      accountId: this.accountId,
      guidance: this.guidance,
    }
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
  config: Uint8Array | null
  state: Uint8Array | null
  manifest?: Uint8Array | null
}

export type ExecuteClaustrumTakeoverDeps = {
  locks: Parameters<typeof acquireCustodyTransitionLocks>[0]
  getLocalAuth: (accountId: string) => Promise<unknown>
  isCommitted: (plan: ClaustrumTakeoverPlan) => Promise<boolean>
  snapshotSidecars: () => Promise<CustodySidecarSnapshot>
  writeManifestBindings: (plan: ClaustrumTakeoverPlan) => Promise<void>
  writeSidecarAccount: (
    account: ClaustrumTakeoverPlan['accounts'][number],
  ) => Promise<void>
  verifyTarget: (plan: ClaustrumTakeoverPlan) => Promise<boolean>
  verifyCommitted: (plan: ClaustrumTakeoverPlan) => Promise<boolean>
  restoreSidecars: (snapshot: CustodySidecarSnapshot) => Promise<void>
  verifyRollback: (snapshot: CustodySidecarSnapshot) => Promise<boolean>
  setMode: (mode: 'claustrum' | 'local') => Promise<'changed' | 'unchanged'>
}

export async function executeClaustrumTakeover(
  plan: ClaustrumTakeoverPlan,
  deps: ExecuteClaustrumTakeoverDeps,
): Promise<'changed' | 'unchanged'> {
  const locks = await acquireCustodyTransitionLocks(deps.locks)
  try {
    if (await deps.isCommitted(plan)) return 'unchanged'

    for (const account of plan.accounts) {
      const current = await deps.getLocalAuth(account.id)
      const local =
        account.id === 'main'
          ? oauthFingerprintMaterial(current)
          : localOAuthMaterial(current)
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
    let modeCommitted = false
    try {
      try {
        await deps.writeManifestBindings(plan)
      } catch {
        throw new CustodyTransitionError('write_manifest')
      }
      for (const account of plan.accounts) {
        if (account.id === 'main') continue
        accountId = account.id
        await deps.writeSidecarAccount(account)
      }
      if (!(await deps.verifyTarget(plan))) {
        throw new CustodyTransitionError('readback', accountId)
      }
      try {
        await deps.setMode('claustrum')
        modeCommitted = true
      } catch {
        throw new CustodyTransitionError('mode_commit')
      }
      if (!(await deps.verifyCommitted(plan))) {
        throw new CustodyTransitionError('post_commit_readback')
      }
      return 'changed'
    } catch (error) {
      if (
        modeCommitted &&
        error instanceof CustodyTransitionError &&
        error.stage === 'post_commit_readback'
      ) {
        try {
          await deps.setMode('local')
        } catch {
          throw new CustodyTransitionError(
            'post_commit_readback',
            undefined,
            'mode is claustrum and unverified — run `/claude-account local`',
          )
        }
      }
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

export function executeLocalExit(deps: {
  path?: string
  setMode?: (mode: 'local') => Promise<'changed' | 'unchanged'>
}) {
  return deps.setMode
    ? deps.setMode('local')
    : setClaustrumModePersistent('local', deps.path)
}
