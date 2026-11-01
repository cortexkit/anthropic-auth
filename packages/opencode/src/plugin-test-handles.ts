import type {
  AccountStorage,
  acquireNativeAccountRuntime,
  CacheKeepManager,
  CustodyStatusState,
  PrimeManager,
  ProviderAccountUuid,
  QuotaManager,
} from '@cortexkit/anthropic-auth-core'
import type { FableFallbackManager } from './fable-fallback.ts'

export interface PluginTestHandles {
  drainDispatchWork: () => Promise<void>
  primeManager: PrimeManager
  quotaManager: QuotaManager
  cacheKeepManager: CacheKeepManager
  fableFallbackManager: FableFallbackManager
  resolveMainQuotaIdentity: (
    accessToken: string,
    model?: string,
    credentialAccountUuid?: string,
    credentialRecordVersion?: number,
  ) => Promise<{
    quotaKey: string | undefined
    providerAccountUuid: ProviderAccountUuid | undefined
    generation: number
    routingLineage?: string
    stale: boolean
    state: CustodyStatusState
  }>
  resolveSidebarQuotaAccess: () => Promise<{
    storage: AccountStorage | null
    access: undefined
  }>
  refreshSidebarQuota: () => Promise<void>
  fallbackRefreshReady: Promise<void>
  readonly scopedRuntime: ReturnType<
    typeof acquireNativeAccountRuntime
  >['vault']
  notificationMessageIdBeforeAssistant: (
    latestAssistantMessageId: string,
    latestUserMessageId?: string,
  ) => string | undefined
  trackDesktopNoticeMessageId: (sessionId: string, messageId: string) => void
  isDesktopNoticeMessage: (sessionId: string, messageId?: string) => boolean
}

// Tests opt in before creating plugins. Normal plugin loads do not retain
// internal handles or expose them to the OpenCode loader.
export let pluginTestHandles: WeakMap<object, PluginTestHandles> | undefined

export function enablePluginTestHandles() {
  pluginTestHandles ??= new WeakMap<object, PluginTestHandles>()
  return pluginTestHandles
}
