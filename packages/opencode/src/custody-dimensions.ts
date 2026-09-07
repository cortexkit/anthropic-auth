import {
  type AccountStorage,
  type ClaustrumCredential,
  type CustodyHandleManifest,
  type CustodyHandleResolution,
  type CustodyStatusState,
  getClaustrumMode,
  isCustodyTombstoneOAuth,
  isOAuthAccount,
  isOAuthAccountVaultOwned,
  type OAuthAccount,
  type ProviderAccountUuid,
} from '@cortexkit/anthropic-auth-core'

type CustodyDimensionsDeps = {
  getCache: () =>
    | { peek: (handle: string) => ClaustrumCredential | undefined }
    | null
    | undefined
  now: () => number
  resolveAccountCustodyHandle: (
    account: OAuthAccount,
    storage: AccountStorage,
  ) => CustodyHandleResolution
  usableAccessToken: (
    credential: ClaustrumCredential | undefined,
    now: number,
  ) => string | undefined
  hasIdentityMismatch: (
    account: OAuthAccount,
    credential: ClaustrumCredential | undefined,
  ) => boolean
  isBlocked: (accountId: string) => boolean
  isReauth: (accountId: string) => boolean
  getManifest: () => CustodyHandleManifest | undefined
}

export function fallbackCustodyDimensions(
  storage: AccountStorage | null,
  deps: Pick<
    CustodyDimensionsDeps,
    'getCache' | 'now' | 'resolveAccountCustodyHandle' | 'usableAccessToken'
  > & { construction?: boolean },
) {
  const constructionEvidence = deps.construction
    ? ('unknown' as const)
    : undefined
  if (!storage)
    return {
      fallbacks: 'T' as const,
      evidence: constructionEvidence ?? ('V' as const),
    }
  const accounts = storage.accounts.filter(
    (account): account is OAuthAccount =>
      account.enabled !== false && isOAuthAccount(account),
  )
  if (!accounts.length)
    return {
      fallbacks:
        getClaustrumMode(storage) === 'claustrum'
          ? ('T' as const)
          : ('R' as const),
      evidence: constructionEvidence ?? ('V' as const),
    }
  const fallbacks = accounts.every((account) =>
    isCustodyTombstoneOAuth(
      { type: 'oauth', access: account.access, refresh: account.refresh },
      'anthropic',
    ),
  )
    ? ('T' as const)
    : ('R' as const)
  if (getClaustrumMode(storage) !== 'claustrum')
    return { fallbacks, evidence: constructionEvidence ?? ('V' as const) }
  const bindings = accounts.map((account) =>
    deps.resolveAccountCustodyHandle(account, storage),
  )
  if (bindings.some((binding) => binding.status !== 'resolved'))
    return {
      fallbacks: 'M' as const,
      evidence: constructionEvidence ?? ('N' as const),
    }
  const custodyFallbacks = accounts.every(
    (account, index) =>
      isCustodyTombstoneOAuth(
        { type: 'oauth', access: account.access, refresh: account.refresh },
        'anthropic',
      ) ||
      (!account.access &&
        !account.refresh &&
        isOAuthAccountVaultOwned(storage, account, bindings[index])),
  )
    ? ('T' as const)
    : ('R' as const)
  if (deps.construction)
    return { fallbacks: custodyFallbacks, evidence: 'unknown' as const }
  const evidence = bindings.every((binding) => {
    if (binding.status !== 'resolved') return false
    return Boolean(
      deps.usableAccessToken(deps.getCache()?.peek(binding.handle), deps.now()),
    )
  })
    ? ('V' as const)
    : ('N' as const)
  return { fallbacks: custodyFallbacks, evidence }
}

export function mainCustodyDimension(auth: {
  type: string
  access?: string
  refresh?: string
}) {
  if (isCustodyTombstoneOAuth(auth, 'anthropic')) return 'T' as const
  if (auth.type === 'oauth' && auth.access && auth.refresh) return 'R' as const
  return 'X' as const
}

export function isFallbackAccountVaultServed(
  accountId: string,
  storage: AccountStorage | null,
  deps: Pick<
    CustodyDimensionsDeps,
    | 'getCache'
    | 'now'
    | 'resolveAccountCustodyHandle'
    | 'usableAccessToken'
    | 'hasIdentityMismatch'
    | 'isBlocked'
  >,
): boolean {
  if (!storage || deps.isBlocked(accountId)) return false
  const account = storage.accounts.find(
    (candidate): candidate is OAuthAccount =>
      candidate.id === accountId && isOAuthAccount(candidate),
  )
  if (!account) return false
  const resolved = deps.resolveAccountCustodyHandle(account, storage)
  if (!isOAuthAccountVaultOwned(storage, account, resolved)) return false
  if (resolved.status !== 'resolved') return false
  const cached = deps.getCache()?.peek(resolved.handle)
  if (deps.hasIdentityMismatch(account, cached)) return false
  return Boolean(cached && deps.usableAccessToken(cached, deps.now()))
}

export function custodyStateFor(
  account: { id: string; role: 'main' | 'fallback' },
  storage: AccountStorage | null,
  deps: CustodyDimensionsDeps,
  vaultServed = isFallbackAccountVaultServed(account.id, storage, deps),
): CustodyStatusState {
  if (account.role === 'main') {
    if (!storage || getClaustrumMode(storage) !== 'claustrum') return 'na'
    const mainHandle = deps
      .getManifest()
      ?.accounts.find((entry) => entry.label === 'main')?.handle
    const cached = mainHandle ? deps.getCache()?.peek(mainHandle) : undefined
    const persistedIdentity =
      storage.main?.profile?.providerAccountUuid ??
      (storage.main?.profile?.accountIdentity as
        | ProviderAccountUuid
        | undefined)
    const credentialIdentity = cached?.accountId
    if (
      (persistedIdentity === undefined) !==
      (credentialIdentity === undefined)
    )
      return 'unknown-identity'
    if (
      persistedIdentity !== undefined &&
      credentialIdentity !== undefined &&
      persistedIdentity !== credentialIdentity
    )
      return 'on-identity-mismatch'
    if (deps.isReauth('main')) return 'on-vault-reauth'
    if (cached && deps.usableAccessToken(cached, deps.now()))
      return 'on-vault-served'
    return 'on-cold'
  }
  if (!storage) return 'off'
  const stored = storage.accounts.find(
    (candidate): candidate is OAuthAccount =>
      candidate.id === account.id && isOAuthAccount(candidate),
  )
  if (!stored) return 'off'
  const resolution = deps.resolveAccountCustodyHandle(stored, storage)
  if (
    resolution.status === 'unresolved' &&
    resolution.reason === 'corrupt-binding'
  )
    return 'on-corrupt-binding'
  if (
    resolution.status === 'unresolved' &&
    resolution.reason === 'unknown-identity'
  )
    return 'on-identity-mismatch'
  if (!isOAuthAccountVaultOwned(storage, stored, resolution)) return 'off'
  const handle =
    resolution.status === 'resolved' ? resolution.handle : undefined
  if (handle && deps.hasIdentityMismatch(stored, deps.getCache()?.peek(handle)))
    return 'on-identity-mismatch'
  if (deps.isReauth(account.id)) return 'on-vault-reauth'
  if (vaultServed) return 'on-vault-served'
  return 'on-cold'
}
