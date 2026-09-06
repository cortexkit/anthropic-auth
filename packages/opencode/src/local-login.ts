import { createHash } from 'node:crypto'
import {
  type CustodyHandleAccount,
  type CustodyHandleManifestRemovalResult,
  removeCustodyHandleManifestEntry,
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
