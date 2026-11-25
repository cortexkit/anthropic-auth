import type { AccountStorage } from './accounts.ts'
import type { CacheKeepManager } from './cachekeep.ts'
import { signRequestBody } from './cch.ts'
import type { ClaudeRefusalRecoveryFamily } from './model-capabilities.ts'
import type { RefusalFallbackBinding } from './refusal-fallback-dispatch.ts'
import {
  extendsRefusalFallbackPrefix,
  type RefusalFallbackPrefix,
  refusalBodyRecord,
  refusalFallbackPrefix,
} from './refusal-fallback-prefix.ts'
import { restoreRefusalFallbackReturnMarker } from './refusal-fallback-return-marker.ts'
import { requestCacheLifetimeMs } from './session-cache-policy.ts'
import type { RefusalFallbackMode } from './settings-definition.ts'

type Usage = NonNullable<
  Parameters<CacheKeepManager['track']>[0]['acceptedUsage']
>

export type RefusalFallbackCacheRoute = RefusalFallbackBinding & {
  requestedModel: string
  mode: RefusalFallbackMode
}

/** Captured with the final source headers and route, before thread preparation. */
export type RefusalFallbackSourceWarmInput = Pick<
  RefusalFallbackBinding,
  'url'
> & {
  headers: Headers
  currentRoute: () => RefusalFallbackCacheRoute | undefined
  loadStorage: () => Promise<AccountStorage | null>
  cacheMode: string
  accountStoragePath?: string
  hostMetadata?: Readonly<Record<string, unknown>>
  isSubagent?: boolean
}

type KeptSource = {
  id: string
  route: RefusalFallbackCacheRoute
  warm: RefusalFallbackSourceWarmInput
  bodyText: string
  prefix: RefusalFallbackPrefix
  acceptedAt: number
  usage: Usage
  registered: boolean
}

const MAX_KEPT_SESSIONS = 128

function sameRoute(
  left: RefusalFallbackCacheRoute,
  right: RefusalFallbackCacheRoute | undefined,
) {
  return (
    right?.accountId === left.accountId &&
    right.credentialId === left.credentialId &&
    right.url === left.url &&
    right.requestedModel === left.requestedModel &&
    right.mode === left.mode
  )
}

export class RefusalFallbackSourceWarm {
  readonly #kept = new Map<string, KeptSource>()

  constructor(
    private readonly cacheKeep: CacheKeepManager,
    private readonly now: () => number,
  ) {}

  forgetSession(sessionId: string) {
    const kept = this.#kept.get(sessionId)
    if (!kept) return
    this.#kept.delete(sessionId)
    this.cacheKeep.untrack(kept.id)
  }

  forgetAccount(accountId: string) {
    for (const [id, kept] of this.#kept) {
      if (kept.route.accountId === accountId) this.forgetSession(id)
    }
  }

  #stop(sessionId: string, kept: KeptSource) {
    if (this.#kept.get(sessionId) !== kept) return
    this.#kept.delete(sessionId)
  }

  #isCurrent(sessionId: string, kept: KeptSource) {
    if (this.#kept.get(sessionId) !== kept) return false
    try {
      if (sameRoute(kept.route, kept.warm.currentRoute())) return true
    } catch {
      // If the host cannot prove the original route still applies, do not send.
    }
    this.#stop(sessionId, kept)
    return false
  }

  checkPlan(sessionId: string, route: RefusalFallbackCacheRoute | undefined) {
    const kept = this.#kept.get(sessionId)
    if (kept && !sameRoute(kept.route, route)) this.forgetSession(sessionId)
  }

  checkSourceHistory(
    sessionId: string,
    body: Record<string, unknown> | undefined,
  ) {
    const kept = this.#kept.get(sessionId)
    if (kept && (!body || !extendsRefusalFallbackPrefix(body, kept.prefix))) {
      this.forgetSession(sessionId)
    }
  }

  restoreReturnMarker(sessionId: string, body: Record<string, unknown>) {
    const kept = this.#kept.get(sessionId)
    if (!kept) return false
    const source = refusalBodyRecord(JSON.parse(kept.bodyText))
    return Boolean(source && restoreRefusalFallbackReturnMarker(body, source))
  }

  completeSource(
    sessionId: string,
    family: ClaudeRefusalRecoveryFamily,
    route: RefusalFallbackCacheRoute | undefined,
    warm: RefusalFallbackSourceWarmInput | undefined,
    bodyText: string,
    body: Record<string, unknown> | undefined,
    usage: Usage | undefined,
  ) {
    // Even a source response with no cached input stops the earlier warm.
    const previous = this.#kept.get(sessionId)
    if (previous && this.cacheKeep.untrack(previous.id))
      previous.registered = false
    if (
      !route ||
      !warm ||
      !body ||
      !usage ||
      body.thread !== undefined ||
      body.fallback_credit_token !== undefined ||
      !requestCacheLifetimeMs(body) ||
      !(
        (usage.cache_read_input_tokens ?? 0) > 0 ||
        (usage.cache_creation_input_tokens ?? 0) > 0
      )
    )
      return
    try {
      if (!sameRoute(route, warm.currentRoute())) return
    } catch {
      return
    }
    const headers = new Headers(warm.headers)
    headers.delete('content-encoding')
    headers.delete('content-length')
    headers.delete('transfer-encoding')
    this.#kept.delete(sessionId)
    this.#kept.set(sessionId, {
      id: `source-warm:${sessionId}:${family}`,
      route,
      warm: { ...warm, headers },
      bodyText,
      prefix: refusalFallbackPrefix(body),
      acceptedAt: this.now(),
      usage,
      registered: false,
    })
    while (this.#kept.size > MAX_KEPT_SESSIONS) {
      const oldest = this.#kept.keys().next()
      if (oldest.done) break
      this.forgetSession(oldest.value)
    }
  }

  register(
    sessionId: string,
    refused: Record<string, unknown>,
    roundIsLive: () => boolean,
  ) {
    this.checkSourceHistory(sessionId, refused)
    const kept = this.#kept.get(sessionId)
    if (!kept) return
    this.#kept.delete(sessionId)
    this.#kept.set(sessionId, kept)
    if (!kept.registered)
      void this.#register(sessionId, kept, roundIsLive).catch(() => {})
  }

  async #register(
    sessionId: string,
    kept: KeptSource,
    roundIsLive: () => boolean,
  ) {
    const live = () =>
      roundIsLive() && !kept.registered && this.#isCurrent(sessionId, kept)
    if (!live()) return
    const bodyText = await signRequestBody(kept.bodyText)
    if (!live()) return
    const storage = await kept.warm.loadStorage()
    if (!live()) return
    kept.registered = true
    const { url, accountId, credentialId } = kept.route
    this.cacheKeep.track({
      ...kept.warm,
      sessionId: kept.id,
      ownerSessionId: sessionId,
      url,
      bodyText,
      storage,
      oauthAccountId: accountId,
      oauthAccountIdentity: credentialId,
      acceptedAt: kept.acceptedAt,
      acceptedUsage: kept.usage,
      sourceWarm: true,
      sourceWarmCurrent: (candidate) =>
        candidate === bodyText && this.#isCurrent(sessionId, kept),
    })
  }
}
