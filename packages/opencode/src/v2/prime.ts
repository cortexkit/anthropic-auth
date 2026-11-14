import {
  buildPrimeRequestBody,
  effectiveRelayTransport,
  type NativeAccountRuntime,
  type NativePoolPaths,
  nativeAccountCanServe,
  PrimeManager,
  type PrimeSendResult,
  tokenFingerprint,
} from '@cortexkit/anthropic-auth-core'
import type { Attempt, RequestScope } from '@cortexkit/common-auth/opencode2'
import {
  createNativeAnthropicAdapter,
  type NativeAnthropicAttemptData,
} from './adapter'
import type { NativeSource, NativeSourceProvenance } from './source'

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}

/** After the five-hour quota resets, send one minimal authenticated request to start its next window and record that request's token usage. */
export function createNativePrime(options: {
  runtime: NativeAccountRuntime
  paths: NativePoolPaths
  source: NativeSource
  fetch?: typeof fetch
}) {
  const { runtime, source } = options
  const abort = new AbortController()
  const sends = new Set<Promise<PrimeSendResult>>()
  const scopeFor = (accountId: string): RequestScope => ({
    providerID: 'anthropic',
    modelID: buildPrimeRequestBody().model,
    sessionID: `oc2-prime:${accountId}`,
    agent: 'prime',
    kind: 'generate',
  })
  const send = async (accountId: string): Promise<PrimeSendResult> => {
    const scope = scopeFor(accountId)
    const native = createNativeAnthropicAdapter({
      source: {
        ...source,
        quotaFromHeaders(headers, input) {
          return source.quotaFromHeaders?.(headers, {
            ...input,
            reportRouting: false,
          })
        },
      },
    })
    const started = performance.now()
    try {
      for (let index = 0; index < 3; index++) {
        abort.signal.throwIfAborted()
        const snapshot = await runtime.read()
        if (snapshot.policyStorage.prime?.enabled !== true)
          throw new Error('Native Prime is disabled')
        const authorized = await native.adapter.accountHeaders({
          ...scope,
          accountId,
        })
        if (
          !('headers' in authorized) ||
          typeof authorized.headers !== 'object' ||
          authorized.headers === null ||
          typeof authorized.attempt !== 'object' ||
          authorized.attempt === null
        )
          throw new Error('Native Prime authorization refused')
        const attempt: Attempt<
          NativeAnthropicAttemptData<NativeSourceProvenance>
        > = {
          ...scope,
          accountId,
          attemptId: crypto.randomUUID(),
          transport: 'http',
          data: authorized.attempt,
        }
        let status: number | undefined
        let delivered = false
        let discarded = false
        // Prime never reads an error body it does not classify. Cancelling the
        // adapter's response body retires this send's credentials before the
        // cancel reaches the connection, so Prime does not wait for the
        // connection to close.
        const discard = (response: Response) => {
          discarded = true
          void response.body?.cancel().catch(() => {})
        }
        try {
          const request = await native.adapter.rewriteRequest?.({
            ...scope,
            accountId,
            attempt,
            request: new Request('https://api.anthropic.com/v1/messages', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(buildPrimeRequestBody()),
              signal: abort.signal,
            }),
          })
          if (!request) throw new Error('Native Prime rewrite refused')
          const headers = new Headers(request.headers)
          for (const [name, value] of Object.entries(authorized.headers)) {
            if (value === null) headers.delete(name)
            else headers.set(name, value)
          }
          const final = new Request(request, { headers })
          const physical = await (options.fetch ?? fetch)(final)
          // Rewrite each physical response before Prime reads it. The native
          // adapter scrubs error metadata and bodies with the sent credentials
          // and applies Core's 1 MiB error-body limit. Quota classification and
          // usage handling consume only this rewritten response.
          const response =
            (await native.adapter.rewriteResponse?.({
              ...scope,
              accountId,
              request: final,
              response: physical,
              attempt,
            })) ?? physical
          status = response.status
          native.adapter.quotaFromHeaders?.(
            response.headers,
            response.status,
            attempt,
          )
          const limit = response.ok
            ? undefined
            : await native.adapter.limitFromResponse?.({
                status: response.status,
                headers: response.headers,
                body: () => response.clone().text(),
                attempt,
              })
          if (
            limit &&
            /^(vault-newer|local-newer|relay-direct):/.test(limit.reason) &&
            index < 2
          ) {
            discard(response)
            // A retry on the same account (with a newer vault or local
            // credential, or direct instead of through the relay) goes through
            // retrySameAccount, the same hook OpenCode 2 uses for model
            // requests; chooseAccount only picks a different account.
            const next = await source.retrySameAccount?.({
              ...scope,
              accountId,
              attempt: index + 1,
              limit,
              error: {
                type: 'api_error',
                message: 'Native Prime credential retry',
                status: response.status,
              },
            })
            if (next?.accountId !== accountId)
              throw new Error('Native Prime retry changed account')
            continue
          }
          if (!response.ok) {
            discard(response)
            return {
              ok: false,
              status,
              ms: performance.now() - started,
              error: 'Native Prime upstream refused the request',
            }
          }
          const data = record(await response.json())
          const usage = record(data.usage)
          const delta = {
            inputTokens:
              typeof usage.input_tokens === 'number'
                ? usage.input_tokens
                : undefined,
            outputTokens:
              typeof usage.output_tokens === 'number'
                ? usage.output_tokens
                : undefined,
          }
          // Require an Anthropic request ID before treating a relay response as a successful quota-start request.
          if (
            attempt.data?.dispatch === 'http-relay' &&
            !/^req_[A-Za-z0-9_-]+$/.test(
              response.headers.get('request-id') ?? '',
            )
          )
            throw new Error(
              'Native Prime relay response has no upstream provenance',
            )
          delivered = await source.recordPrime(
            authorized.attempt.provenance,
            delta,
          )
          if (!delivered)
            throw new Error('Native Prime counter attribution was superseded')
          return {
            ok: true,
            status,
            ms: performance.now() - started,
            usage: delta,
          }
        } finally {
          await native.adapter.onAttemptEnd?.(attempt, {
            status,
            outputStarted: false,
            // Prime will not read a discarded body. Mark its send cancelled
            // so the native adapter releases its credentials, even if the
            // connection's cancellation is still pending.
            ...(delivered
              ? {}
              : {
                  error: {
                    reason: discarded
                      ? ('cancelled' as const)
                      : ('failed' as const),
                  },
                }),
          })
        }
      }
      return { ok: false, error: 'Native Prime retry budget exhausted' }
    } catch {
      return {
        ok: false,
        error: 'Native Prime was not completed',
        ms: performance.now() - started,
      }
    } finally {
      native.dispose()
    }
  }
  const manager = new PrimeManager({
    storagePath: options.paths.legacyConfig,
    loadStorage: async () => (await runtime.read()).policyStorage,
    async getAccountFingerprint(accountId) {
      const snapshot = await runtime.read()
      const account = snapshot.accounts.find((row) => row.id === accountId)
      if (!nativeAccountCanServe(account) || account?.type !== 'oauth')
        return undefined
      if (
        snapshot.policyStorage.relay?.enabled === true &&
        effectiveRelayTransport(
          snapshot.policyStorage.relay.transport,
          snapshot.policyStorage.relay.url,
        ) === 'websocket'
      )
        return undefined
      if (account.source === 'vault') {
        const receipt = await runtime.authorizeVault(accountId, abort.signal)
        const lineage = await runtime.getOrCreateAuthLineage(accountId, receipt)
        return lineage ? tokenFingerprint(lineage) : undefined
      }
      const credential = await runtime.authorizeLocal(accountId, {
        signal: abort.signal,
      })
      if (credential.status !== 'usable') return undefined
      const lineage = await runtime.getOrCreateAuthLineage(
        accountId,
        credential.subject,
      )
      return lineage ? tokenFingerprint(lineage) : undefined
    },
    getAccountIdentity: async (accountId) =>
      (await runtime.read()).accounts.find(
        (account) => account.id === accountId,
      )?.accountIdentity,
    async refreshQuota(accountId) {
      const snapshot = await runtime.read()
      if (
        snapshot.policyStorage.relay?.enabled === true &&
        effectiveRelayTransport(
          snapshot.policyStorage.relay.transport,
          snapshot.policyStorage.relay.url,
        ) === 'websocket'
      )
        throw new Error('WebSocket relay is unsupported on OpenCode 2')
      return {
        quota: await runtime.fetchQuota(accountId, options.fetch, abort.signal),
        fresh: true,
      }
    },
    sendPrime(accountId) {
      const pending = send(accountId)
      sends.add(pending)
      void pending.finally(() => sends.delete(pending))
      return pending
    },
    async recordSuccess(accountId) {
      const account = (await runtime.read()).accounts.find(
        (row) => row.id === accountId,
      )
      if (!account?.prime)
        throw new Error('Native Prime counters are unavailable')
      return account.prime
    },
  })
  manager.start()
  return {
    manager,
    async dispose() {
      manager.stop()
      abort.abort()
      await Promise.allSettled(sends)
    },
  }
}
