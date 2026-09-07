import { createHash } from 'node:crypto'
import { readFile, rename, writeFile } from 'node:fs/promises'
import {
  type CustodyHandleAccount,
  CustodyHandleManifestReader,
  type CustodyHandleManifestRemovalResult,
  isOAuthAccount,
  loadAccounts,
  type OAuthAccount,
  removeCustodyHandleManifestEntry,
  resolveCustodyHandle,
} from '@cortexkit/anthropic-auth-core'

export type CompletedLocalLogin = {
  accountId: string
  credentialId: string
  authFingerprint: string
  completedAt: number
}

export type CustodyDivergence = {
  minimumRecordVersion: number
  observedAt: number
}

export type CustodyDivergenceState = {
  claustrumDivergence?: Record<string, CustodyDivergence>
}

export function lastVaultServedRecordVersion(input: {
  accountId: string
  servedVersion?: number
  cacheVersion?: number
  warn?: (accountId: string) => void
}): number {
  if (input.servedVersion !== undefined) return input.servedVersion
  if (input.cacheVersion !== undefined) return input.cacheVersion
  input.warn?.(input.accountId)
  return 0
}

export function custodyDivergenceMarker(
  lastVaultServedRecordVersion: number,
  observedAt: number,
): CustodyDivergence {
  return {
    minimumRecordVersion: lastVaultServedRecordVersion + 1,
    observedAt,
  }
}

export function custodyPreflightDivergenceCheck(
  binding: { credentialId: string; recordVersion: number },
  state: CustodyDivergenceState,
): { ok: true } | { ok: false; message: 'missing fresh vault import' } {
  const fence = state.claustrumDivergence?.[binding.credentialId]
  return !fence || binding.recordVersion >= fence.minimumRecordVersion
    ? { ok: true }
    : { ok: false, message: 'missing fresh vault import' }
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
  beforeRemove?: () => Promise<void>
  divergence?: {
    statePath: string
    lastVaultServedRecordVersion: number
  }
}

export type AcknowledgeLocalOAuthLoginFromStorageOptions = {
  accountStoragePath: string
  manifestPath: string
  remove?: AcknowledgeLocalOAuthLoginOptions['remove']
  divergence?: AcknowledgeLocalOAuthLoginOptions['divergence']
}

export type AcknowledgeLocalOAuthLoginResult =
  | 'cleared'
  | 'not-cleared'
  | 'refused'
  | 'refused-transient'

export async function acknowledgeLocalOAuthLogin(
  completion: CompletedLocalLogin | undefined,
  observedAuth: ObservedLocalAuth | undefined,
  options: AcknowledgeLocalOAuthLoginOptions,
): Promise<AcknowledgeLocalOAuthLoginResult> {
  if (!completion || observedAuth?.type !== 'oauth') return 'not-cleared'
  if (!observedAuth.access || !observedAuth.refresh) return 'not-cleared'
  if (
    localAuthFingerprint(observedAuth.access, observedAuth.refresh) !==
    completion.authFingerprint
  ) {
    return 'not-cleared'
  }
  await options.beforeRemove?.()
  if (options.divergence) {
    await persistCustodyDivergenceState(
      options.divergence.statePath,
      completion.credentialId,
      options.divergence.lastVaultServedRecordVersion,
      Date.now(),
    )
  }
  const result = await (options.remove ?? removeCustodyHandleManifestEntry)({
    path: options.manifestPath,
    entry: options.entry,
  })
  if (result === 'removed') return 'cleared'
  if (result === 'missing') return 'not-cleared'
  return result.code === undefined ? 'refused' : 'refused-transient'
}

export async function persistCustodyDivergenceState(
  statePath: string,
  credentialId: string,
  lastVaultServedRecordVersion: number,
  observedAt: number,
): Promise<void> {
  let state: Record<string, unknown> = { version: 1 }
  try {
    const parsed = JSON.parse(await readFile(statePath, 'utf8'))
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      state = parsed as Record<string, unknown>
    }
  } catch {}
  const divergence =
    state.claustrumDivergence &&
    typeof state.claustrumDivergence === 'object' &&
    !Array.isArray(state.claustrumDivergence)
      ? (state.claustrumDivergence as Record<string, unknown>)
      : {}
  divergence[credentialId] = custodyDivergenceMarker(
    lastVaultServedRecordVersion,
    observedAt,
  )
  state.claustrumDivergence = divergence
  const temporaryPath = `${statePath}.${process.pid}.tmp`
  await writeFile(temporaryPath, JSON.stringify(state, null, 2), {
    mode: 0o600,
  })
  await rename(temporaryPath, statePath)
}

export async function acknowledgeLocalOAuthLoginFromStorage(
  completion: CompletedLocalLogin | undefined,
  options: AcknowledgeLocalOAuthLoginFromStorageOptions,
): Promise<AcknowledgeLocalOAuthLoginResult> {
  if (!completion) return 'not-cleared'
  const storage = await loadAccounts(options.accountStoragePath)
  const account = storage?.accounts.find(
    (candidate): candidate is OAuthAccount =>
      candidate.id === completion.accountId && isOAuthAccount(candidate),
  )
  if (!storage || !account?.label) return 'not-cleared'

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
      divergence: options.divergence,
    },
  )
}
