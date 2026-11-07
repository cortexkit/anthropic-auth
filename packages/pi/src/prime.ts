import {
  logger,
  PrimeManager,
  type PrimeManagerOptions,
  type PrimeSendResult,
  primeStorageFingerprint,
  tokenFingerprint,
} from '@cortexkit/anthropic-auth-core'
import type { PiNativeAttempt, PiNativeRuntime } from './native.ts'

export type PiPrimeSendOptions = {
  native: PiNativeRuntime
  storagePath: string
  accountId: string
  signal: AbortSignal
  beforeSend: () => Promise<void>
  onServed: (attempt: PiNativeAttempt) => void
  fetch?: typeof fetch
}

type PiPrimeSender = (options: PiPrimeSendOptions) => Promise<Response>
let sendPrimeRequest: PiPrimeSender | undefined

/** Stream installs its normal sender without making native startup load the keep-warm manager. */
export function registerPiPrimeSender(sender: PiPrimeSender) {
  sendPrimeRequest = sender
}

export type PiPrimeOptions = Pick<
  PrimeManagerOptions,
  | 'markerDir'
  | 'now'
  | 'setIntervalImpl'
  | 'clearIntervalImpl'
  | 'setTimeoutImpl'
  | 'clearTimeoutImpl'
> & { fetch?: typeof fetch }

type Owner = { native: PiNativeRuntime; storagePath: string }
const primes = new Map<string, PiPrime>()

class PiPrime {
  readonly manager: PrimeManager
  readonly owners = new Set<Owner>()
  private abort = new AbortController()
  private readonly sends = new Set<Promise<PrimeSendResult>>()

  constructor(owner: Owner, options: PiPrimeOptions) {
    this.owners.add(owner)
    this.manager = new PrimeManager({
      ...options,
      setIntervalImpl: ((tick: () => void, ms: number) =>
        (options.setIntervalImpl ?? globalThis.setInterval)(
          () => this.tickIfEnabled(tick),
          ms,
        )) as typeof setInterval,
      // Keep the shared scheduler's default claim directory and OpenCode's
      // storage identity so the two hosts compete for the same atomic claim.
      storagePath: owner.storagePath,
      loadStorage: async () => (await this.owner().native.view()).policyStorage,
      getAccountFingerprint: async (accountId) => {
        if (!sendPrimeRequest) return undefined
        const runtime = await this.owner().native.service()
        const signal = this.abort.signal
        const account = (await runtime.read()).accounts.find(
          (row) => row.id === accountId,
        )
        if (account?.type !== 'oauth') return undefined
        const fence =
          account.source === 'vault'
            ? await runtime.authorizeVault(accountId, signal)
            : await runtime
                .authorizeLocal(accountId, { signal })
                .then((credential) =>
                  credential.status === 'usable'
                    ? credential.subject
                    : undefined,
                )
        if (!fence) return undefined
        const lineage = await runtime.getOrCreateAuthLineage(accountId, fence)
        return lineage ? tokenFingerprint(lineage) : undefined
      },
      refreshQuota: async (accountId) => ({
        quota: await (await this.owner().native.service()).fetchQuota(
          accountId,
          options.fetch,
          this.abort.signal,
        ),
        fresh: true,
      }),
      sendPrime: (accountId) => {
        const pending = this.send(accountId, options.fetch)
        this.sends.add(pending)
        void pending.finally(() => this.sends.delete(pending))
        return pending
      },
      recordSuccess: async (accountId) => {
        const account = (await this.owner().native.view()).accounts.find(
          (row) => row.id === accountId,
        )
        if (!account?.prime)
          throw new Error('Pi Prime counters are unavailable')
        return account.prime
      },
    })
    this.manager.start()
  }

  private owner() {
    const owner = [...this.owners].at(-1)
    if (!owner) throw new Error('Pi Prime has no active runtime')
    return owner
  }

  private async tickIfEnabled(tick: () => void) {
    const signal = this.abort.signal
    if (signal.aborted || this.manager.isStopped() || !sendPrimeRequest) return
    try {
      const snapshot = await this.owner().native.view(signal)
      // Keep the opt-in poll, but disabled Prime must not sweep claim markers,
      // authorize an account or refresh quota alongside keep-warm restoration.
      if (!signal.aborted && snapshot.policyStorage.prime?.enabled === true)
        tick()
    } catch {
      if (!signal.aborted) logger.warn('prime', 'Pi settings check failed')
    }
  }

  settingsChanged() {
    this.manager.stop()
    this.abort.abort()
    this.abort = new AbortController()
    // Leave a dormant tick while disabled: a settings edit in another process
    // must be noticed without a new Pi session. The scheduler reloads opt-in
    // every tick.
    this.manager.start()
  }

  stop() {
    this.manager.stop()
    this.abort.abort()
  }

  async drain() {
    await Promise.allSettled(this.sends)
  }

  private async send(
    accountId: string,
    fetchImpl?: typeof fetch,
  ): Promise<PrimeSendResult> {
    const { native, storagePath } = this.owner()
    const signal = this.abort.signal
    const started = performance.now()
    let response: Response | undefined
    try {
      const send = sendPrimeRequest
      if (!send) throw new Error('Pi Prime transport is unavailable')
      const runtime = await native.service()
      let served: PiNativeAttempt | undefined
      response = await send({
        native,
        storagePath,
        accountId,
        signal,
        fetch: fetchImpl,
        beforeSend: async () => {
          const snapshot = await native.view(signal)
          signal.throwIfAborted()
          if (snapshot.policyStorage.prime?.enabled !== true)
            throw new Error('Pi Prime is disabled')
        },
        onServed: (attempt) => {
          served = attempt
        },
      })
      if (!response.ok || !served)
        return {
          ok: false,
          status: response.status,
          error: 'Pi Prime upstream refused the request',
        }
      const data = (await response.json()) as {
        usage?: { input_tokens?: number; output_tokens?: number }
      }
      const usage = {
        inputTokens: data.usage?.input_tokens,
        outputTokens: data.usage?.output_tokens,
      }
      const fence =
        served.source === 'vault' ? served.receipt : served.admission.subject
      if (!(await runtime.incrementPrimeUsage(accountId, fence, usage)))
        throw new Error('Pi Prime counter attribution was superseded')
      return {
        ok: true,
        status: response.status,
        usage,
        ms: performance.now() - started,
      }
    } catch {
      return {
        ok: false,
        error: 'Pi Prime was not completed',
        ms: performance.now() - started,
      }
    } finally {
      void response?.body?.cancel().catch(() => {})
    }
  }
}

/** Runtime leases share one scheduler for each canonical account-storage path. */
export function acquirePiPrime(owner: Owner, options: PiPrimeOptions = {}) {
  const key = primeStorageFingerprint(owner.storagePath)
  const prime = primes.get(key) ?? new PiPrime(owner, options)
  primes.set(key, prime)
  prime.owners.add(owner)
  return {
    manager: prime.manager,
    settingsChanged: () => prime.settingsChanged(),
    stop: () => prime.stop(),
    async release() {
      prime.owners.delete(owner)
      if (prime.owners.size) {
        prime.settingsChanged()
        return
      }
      prime.stop()
      primes.delete(key)
      await prime.drain()
    },
  }
}

export type PiPrimeLease = ReturnType<typeof acquirePiPrime>
