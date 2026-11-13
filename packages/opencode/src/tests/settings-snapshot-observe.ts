import { spyOn } from 'bun:test'
import { rm } from 'node:fs/promises'
import * as core from '@cortexkit/anthropic-auth-core'
import {
  addFastModeBetaHeader,
  mergeHeaders,
  resetPinnedFirstUserTextsForTest,
  rewriteRequestBody,
  rewriteUrl,
  setOAuthHeaders,
} from '../transform'
import { startNativeAnthropicLifecycle } from '../v2/lifecycle'
import { createNativeAnthropicSource } from '../v2/source'
import { createNativeWirePolicy } from '../v2/wire'
import { predicate, settingsReaderOutputs } from './opencode2-settings-readers'
import {
  snapshotModel,
  snapshotQuota,
  snapshotTime,
} from './settings-snapshot-fixture'

// Evaluate the private reader's actual expression in both the release and the
// current source. An enum/boolean conversion copied into the test would hide drift.
function oc1Readers(storage: core.AccountStorage) {
  return {
    persistentCacheLatch: core.isCache1hPersistentlyEnabled(storage),
    mainProviderQuotaRestriction: !predicate(
      /function mainProviderQuotaRestriction\([\s\S]*?!storage \|\|\s*([^\n]+) \|\|/,
      storage,
    ),
    pollFallbackQuotas: !predicate(
      /async function pollFallbackQuotas\([\s\S]*?!requiredByPolicy &&\s*([^\n]+)/,
      storage,
    ),
    scheduleSidebarMainQuotaRefresh: !predicate(
      /function scheduleSidebarMainQuotaRefresh\([\s\S]*?if \(([^\n]+quota[^\n]+)\) return/,
      storage,
    ),
    mainQuotaRoutingEnabled: predicate(
      /function mainQuotaRoutingEnabled\([\s\S]*?return ([^\n]+)/,
      storage,
    ),
  }
}

/** Capture consumer results, including signed body bytes, not projected records. */
export async function observeSettings(
  storage: core.AccountStorage,
  host: 1 | 2,
) {
  const level = core.getLogLevel()
  const dump = core.isDumpEnabled()
  const dumpDirectory = process.env.OPENCODE_ANTHROPIC_AUTH_DUMP_DIR
  const fixedDumpDirectory = 'target/scratch/settings-snapshot-dumps'
  process.env.OPENCODE_ANTHROPIC_AUTH_DUMP_DIR = fixedDumpDirectory
  await rm(fixedDumpDirectory, { recursive: true, force: true })
  core.resetDumpState()
  core.setDumpEnabled(core.isDumpPersistentlyEnabled(storage))
  const logs: core.LogTestRecord[] = []
  const warms: { url: string; body: string; headers: [string, string][] }[] = []
  let now = snapshotTime
  const keep = new core.CacheKeepManager({
    loadStorage: async () => storage,
    now: () => now,
    setIntervalImpl: (() => ({ unref() {} })) as unknown as typeof setInterval,
    clearIntervalImpl: () => {},
    setTimeoutImpl: (() => ({ unref() {} })) as unknown as typeof setTimeout,
    clearTimeoutImpl: () => {},
    fetchImpl: (async (url, init) => {
      warms.push({
        url: String(url),
        body: String(init?.body),
        headers: [...new Headers(init?.headers).entries()],
      })
      return new Response('{}', { status: 200 })
    }) as typeof fetch,
  })
  core.setLogLevel('debug')
  core.__setLogTestSink((record) => logs.push(record))
  resetPinnedFirstUserTextsForTest()
  try {
    const readers = JSON.parse(settingsReaderOutputs(storage, false))
    const quota = { ...snapshotQuota(15), accountIdentity: 'snapshot-account' }
    const shared = {
      isCache1hPersistentlyEnabled: core.isCache1hPersistentlyEnabled(storage),
      isCacheKeepHybridActive: core.isCacheKeepHybridActive(storage),
      quotaEnabled: core.quotaEnabled(storage),
      quotaSnapshotPassesPolicy: core.quotaSnapshotPassesPolicy(quota, storage),
      quotaRefusalTiming: core.quotaRefusalTiming({
        readings: [{ quota, accountIdentity: quota.accountIdentity }],
        storage,
        now,
      }),
      getQuotaNextRefreshAt: core.getQuotaNextRefreshAt(quota, storage, now),
      failClosedOnUnknownQuota: core.failClosedOnUnknownQuota(storage),
    }
    const snapshot = {
      mode: 'local',
      settings: {},
      accounts: [],
      policyStorage: storage,
    } as core.NativeAccountSnapshot
    let polls = 0
    let tick: (() => Promise<void> | undefined) | undefined
    const runtime = {
      read: async () => snapshot,
      drainRoutingPublications: async () => {},
      fetchQuota: async () => {
        polls++
      },
      fetchProfile: async () => {},
      vault: {
        watch: (options: { onRefresh: typeof tick }) => {
          tick = options.onRefresh
          return { ready: Promise.resolve(), close() {} }
        },
      },
    } as unknown as core.NativeAccountRuntime
    const source = createNativeAnthropicSource({
      runtime,
      paths: {} as core.NativePoolPaths,
      requestOptions: () => ({}),
    })
    let chooseAccount: number
    try {
      await source.chooseAccount({
        phase: 'retry',
        providerID: 'anthropic',
        modelID: snapshotModel,
        sessionID: 'snapshot',
        agent: 'build',
        kind: 'primary',
        rerouteFrom: {
          accountId: 'main',
          limit: { reason: 'local-newer:credential', retryAfterMs: 0 },
        },
      })
      chooseAccount = polls
    } finally {
      await source.close()
    }
    polls = 0
    const lifecycle = startNativeAnthropicLifecycle(runtime)
    try {
      if (!tick) throw new Error('Lifecycle did not register a tick')
      await tick()
    } finally {
      await lifecycle.dispose()
    }
    const hostReaders = {
      oc1: oc1Readers(storage),
      oc2: { chooseAccount, lifecycle: polls },
    }
    const wire = createNativeWirePolicy().requestOptions(
      {
        attemptId: 'snapshot',
        sessionID: 'snapshot',
        agent: 'build',
        correlation: {},
      } as Parameters<
        ReturnType<typeof createNativeWirePolicy>['requestOptions']
      >[0],
      snapshot,
    )
    const options =
      host === 2
        ? wire
        : {
            ...wire,
            cache1hEnabled: core.isCache1hPersistentlyEnabled(storage),
            cache1hMode: core.getCache1hPersistentMode(storage),
            fastModeEnabled: core.isFastModePersistentlyEnabled(storage),
            midConversationEffortEnabled: true,
          }
    const identity = {
      deviceId: '0'.repeat(64),
      sessionId: '11111111-1111-4111-8111-111111111111',
      accountIdentity: '11111111-2222-4333-8444-555555555555',
      accountUuid:
        '11111111-2222-4333-8444-555555555555' as core.ProviderAccountUuid,
    }
    const url = 'https://api.anthropic.com/v1/messages'
    const body = await rewriteRequestBody(
      JSON.stringify({
        model: snapshotModel,
        max_tokens: 8,
        system: [
          {
            type: 'text',
            text: 'Snapshot system prompt.',
            cache_control: { type: 'ephemeral' },
          },
        ],
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: 'hello',
                cache_control: { type: 'ephemeral' },
              },
            ],
          },
        ],
      }),
      {
        ...options,
        identity,
        sessionId: 'snapshot',
        cacheDiagnosticsPreviousMessageId: null,
      },
    )
    const headers = mergeHeaders(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    })
    setOAuthHeaders(headers, 'synthetic-snapshot-access', {
      body: JSON.parse(body),
      identity,
    })
    if (options.fastModeEnabled) addFastModeBetaHeader(headers)
    headers.set('x-client-request-id', '22222222-2222-4222-8222-222222222222')
    const rewritten = rewriteUrl(url).url
    if (!rewritten) throw new Error('Request URL was not rewritten')
    const request = {
      url: rewritten.toString(),
      body,
      headers: [...headers.entries()],
    }
    const track = keep.track({
      sessionId: 'snapshot',
      url,
      headers,
      bodyText: body,
      storage,
      cacheMode: core.getCache1hPersistentMode(storage),
    })
    now += 55 * 60_000 + 30_000
    // Dump names contain wall time. Fix their input before capture instead of
    // scrubbing a log line, so dump diagnostics remain part of the byte oracle.
    const iso = spyOn(Date.prototype, 'toISOString').mockReturnValue(
      new Date(snapshotTime).toISOString(),
    )
    try {
      await keep.tick()
    } finally {
      iso.mockRestore()
    }
    return { readers, shared, hostReaders, request, track, warms, logs }
  } finally {
    keep.stop()
    core.__setLogTestSink(null)
    core.setLogLevel(level)
    core.setDumpEnabled(dump)
    if (dumpDirectory === undefined)
      delete process.env.OPENCODE_ANTHROPIC_AUTH_DUMP_DIR
    else process.env.OPENCODE_ANTHROPIC_AUTH_DUMP_DIR = dumpDirectory
    await rm(fixedDumpDirectory, { recursive: true, force: true })
  }
}
