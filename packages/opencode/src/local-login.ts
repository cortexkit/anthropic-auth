import { createHash } from 'node:crypto'
import {
  type CustodyHandleAccount,
  CustodyHandleManifestReader,
  type CustodyHandleManifestRemovalResult,
  isOAuthAccount,
  loadAccounts,
  removeCustodyHandleManifestEntry,
  resolveCustodyHandle,
} from '@cortexkit/anthropic-auth-core'

export type CompletedLocalLogin = {
  accountId: string
  credentialId: string
  authFingerprint: string
  completedAt: number
}

export class CustodyLoginObservationUnavailableError extends Error {
  readonly code = 'custody_login_observation_unavailable'

  constructor() {
    super(
      'Local login cannot be verified while OPENCODE_AUTH_CONTENT is set; unset it before signing in.',
    )
    this.name = 'CustodyLoginObservationUnavailableError'
  }
}

export function assertLocalLoginObservationAvailable(
  env: Record<string, string | undefined>,
): void {
  if (env.OPENCODE_AUTH_CONTENT !== undefined) {
    throw new CustodyLoginObservationUnavailableError()
  }
}

export type ObservedLocalAuth = {
  type: string
  access?: string
  refresh?: string
}

export function localAuthFingerprint(access: string, refresh: string): string {
  const lengthPrefix = (value: string) => `${value.length}:${value}`
  return createHash('sha256')
    .update(lengthPrefix(access) + lengthPrefix(refresh))
    .digest('hex')
}

export type AcknowledgeLocalOAuthLoginOptions = {
  manifestPath: string
  entry: CustodyHandleAccount
  remove?: (input: {
    path: string
    entry: CustodyHandleAccount
  }) => Promise<CustodyHandleManifestRemovalResult>
}

export type AcknowledgeLocalOAuthLoginFromStorageOptions = {
  accountStoragePath: string
  manifestPath: string
  remove?: AcknowledgeLocalOAuthLoginOptions['remove']
}

export async function acknowledgeLocalOAuthLogin(
  completion: CompletedLocalLogin | undefined,
  observedAuth: ObservedLocalAuth | undefined,
  options: AcknowledgeLocalOAuthLoginOptions,
): Promise<'cleared' | 'not-cleared' | 'refused'> {
  if (!completion || observedAuth?.type !== 'oauth') return 'not-cleared'
  if (!observedAuth.access || !observedAuth.refresh) return 'not-cleared'
  if (
    localAuthFingerprint(observedAuth.access, observedAuth.refresh) !==
    completion.authFingerprint
  ) {
    return 'not-cleared'
  }
  const result = await (options.remove ?? removeCustodyHandleManifestEntry)({
    path: options.manifestPath,
    entry: options.entry,
  })
  if (result === 'removed') return 'cleared'
  if (result === 'missing') return 'not-cleared'
  return 'refused'
}

export async function acknowledgeLocalOAuthLoginFromStorage(
  completion: CompletedLocalLogin | undefined,
  options: AcknowledgeLocalOAuthLoginFromStorageOptions,
): Promise<'cleared' | 'not-cleared' | 'refused'> {
  if (!completion) return 'not-cleared'
  const storage = await loadAccounts(options.accountStoragePath)
  const account = storage?.accounts.find(
    (candidate) =>
      candidate.id === completion.accountId && isOAuthAccount(candidate),
  )
  if (!account || !account.label) return 'not-cleared'

  const manifestResult = await new CustodyHandleManifestReader({
    path: options.manifestPath,
    provider: 'anthropic',
    serve: 'anthropic-auth',
  }).read()
  if (manifestResult.status !== 'ready') return 'not-cleared'
  const labelCounts = new Map<string, number>()
  for (const candidate of storage.accounts) {
    if (isOAuthAccount(candidate) && candidate.label) {
      labelCounts.set(
        candidate.label,
        (labelCounts.get(candidate.label) ?? 0) + 1,
      )
    }
  }
  const duplicateLabels = new Set(
    [...labelCounts].filter(([, count]) => count > 1).map(([label]) => label),
  )
  const resolution = resolveCustodyHandle({
    account,
    manifest: manifestResult.manifest,
    duplicateOAuthLabels:
      duplicateLabels.size === 0 ? undefined : duplicateLabels,
  })
  if (resolution.status !== 'resolved' || resolution.source !== 'manifest')
    return 'not-cleared'
  if (resolution.credentialId !== completion.credentialId) return 'not-cleared'
  return acknowledgeLocalOAuthLogin(
    completion,
    { type: 'oauth', access: account.access, refresh: account.refresh },
    {
      manifestPath: options.manifestPath,
      entry: {
        label: account.label,
        handle: resolution.handle,
        credentialId: resolution.credentialId,
      },
      remove: options.remove,
    },
  )
}
