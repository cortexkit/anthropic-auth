import {
  effectiveRelayTransport,
  getQuotaCheckIntervalMs,
  logger,
  type NativeAccountRuntime,
  nativeAccountCanServe,
  oauthProfileIsFresh,
  quotaPollCheckedAt,
  quotaSnapshotCheckedAt,
  readThreeWayBoolean,
} from '@cortexkit/anthropic-auth-core'

/**
 * Background quota and profile reads obtain their own account credentials.
 * They must not inherit the model policy of the latest user request.
 */
export function startNativeAnthropicLifecycle(
  runtime: NativeAccountRuntime,
  fetchImpl?: typeof fetch,
) {
  const abort = new AbortController()
  let inFlight: Promise<void> | undefined
  let stopped = false
  const run = async () => {
    const snapshot = await runtime.read()
    abort.signal.throwIfAborted()
    if (
      snapshot.policyStorage.relay?.enabled === true &&
      effectiveRelayTransport(
        snapshot.policyStorage.relay.transport,
        snapshot.policyStorage.relay.url,
      ) === 'websocket'
    )
      return
    const current = snapshot
    const interval = getQuotaCheckIntervalMs(current.policyStorage)
    for (const account of current.accounts) {
      if (abort.signal.aborted) return
      if (!nativeAccountCanServe(account) || account.type !== 'oauth') continue
      if (readThreeWayBoolean(current.policyStorage.quota?.enabled, true)) {
        const vault = current.mode === 'claustrum'
        const quota = account.quota
        const pollCheckedAt = quotaPollCheckedAt(quota)
        // Legacy readings without provenance or poll-only fields have no
        // separate poll clock. Their window times still date the reading.
        const legacyStandardOnly =
          quota?.source === undefined &&
          quota?.scoped === undefined &&
          quota?.extraUsage === undefined &&
          pollCheckedAt === 0
        const checkedAt =
          vault || legacyStandardOnly
            ? quotaSnapshotCheckedAt(quota)
            : Math.min(
                pollCheckedAt,
                ...(quota?.scoped ?? []).map((window) => window.checkedAt),
              )
        const due = Date.now() - checkedAt >= interval
        // Each quota reading or failure is bound to the credential version
        // used for its request, so a late result cannot affect a newer login.
        if (due || vault)
          await runtime
            .fetchQuota(
              account.id,
              fetchImpl,
              abort.signal,
              undefined,
              due ? 'background' : 'background-cache',
            )
            .catch(() => {})
      }
      if (!oauthProfileIsFresh(account.profile) && !abort.signal.aborted)
        await runtime
          .fetchProfile(account.id, fetchImpl, abort.signal)
          .catch(() => {})
    }
  }
  const tick = () => {
    if (stopped || inFlight) return inFlight
    inFlight = run()
      .catch(() => {
        if (!abort.signal.aborted)
          logger.debug(
            'opencode2',
            'native background readings did not complete',
          )
      })
      .finally(() => {
        inFlight = undefined
      })
    return inFlight
  }
  const watch = runtime.vault.watch({
    intervalMs: 60_000,
    onRefresh: tick,
    shouldRefresh: async () => {
      const snapshot = await runtime.read()
      return (
        snapshot.policyStorage.relay?.enabled !== true ||
        effectiveRelayTransport(
          snapshot.policyStorage.relay.transport,
          snapshot.policyStorage.relay.url,
        ) === 'http'
      )
    },
  })
  void watch.ready.catch(() => {})
  return {
    async dispose() {
      stopped = true
      watch.close()
      abort.abort()
      await inFlight
    },
  }
}
