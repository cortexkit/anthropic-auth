import { describe, expect, mock } from 'bun:test'
import {
  __setLogTestSink,
  type AccountStorage,
  CACHE_KEEP_EXTENDED_TTL_BETA,
  sessionCacheActivity,
  setCache1hState,
} from '@cortexkit/anthropic-auth-core'
import {
  parseSourceWarmTargetId,
  sourceWarmRecoveryKey,
  sourceWarmTargetId,
} from '../fable-fallback'
import { SERVER_SIDE_FALLBACK_BETA } from '../server-fallback'
import { getPluginTestHandles } from './plugin-test-handles'
import type {
  createMockClient,
  TestPlugin,
} from './support/opencode1-client.ts'
import { installLoaderSetup } from './support/opencode1-loader-setup.ts'
import {
  createFallbackStorage,
  getPlugin as getPluginWithCtx,
  syntheticMainHostAuth,
  useTempAccountFile as useTempAccountFileWithCtx,
  withNativeAdmission as withNativeAdmissionWithCtx,
} from './support/opencode1-pool-fixture.ts'
import {
  createOpencode1Test,
  createOpencode1TestContext,
  installOpencode1TestHooks,
} from './support/opencode1-test-context.ts'
import { extractUrl, MESSAGES_URL } from './test-fetch'

const testContext = createOpencode1TestContext()
installOpencode1TestHooks(testContext)
const test = createOpencode1Test(testContext)

function useTempAccountFile(
  storage: AccountStorage,
  mainHostAuth: {
    access: string
    refresh: string
    expires: number
  } = syntheticMainHostAuth(),
) {
  return useTempAccountFileWithCtx(testContext, storage, mainHostAuth)
}
function withNativeAdmission<Input, Init>(
  handler: (input: Input, init: Init) => unknown,
) {
  return withNativeAdmissionWithCtx(testContext, handler)
}
function getPlugin(
  client?: ReturnType<typeof createMockClient>,
  directory?: string,
): any {
  return getPluginWithCtx(testContext, client, directory)
}

const SOURCE_MODEL = 'claude-opus-5-5'

type SentRequest = {
  model: string
  maxTokens?: number
  fallbacks?: unknown
  betas: string
  auth: string
  parsed: Record<string, unknown>
}

function requestBody(model = SOURCE_MODEL, messages?: unknown) {
  return JSON.stringify({
    model,
    max_tokens: 128_000,
    stream: true,
    system: [{ type: 'text', text: 'stable system' }],
    messages: messages ?? [{ role: 'user', content: 'same session input' }],
  })
}

function sse(events: Array<[string, unknown]>) {
  const frames = events
    .map(
      ([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
    )
    .join('')
  return `${frames}event: message_stop\ndata: {"type":"message_stop"}\n\n`
}

const refusalSse = () =>
  sse([
    [
      'message_start',
      { type: 'message_start', message: { id: 'msg_refused' } },
    ],
    [
      'message_delta',
      {
        type: 'message_delta',
        delta: { stop_reason: 'refusal' },
        usage: { output_tokens: 0 },
      },
    ],
  ])

const successSse = () =>
  sse([
    ['message_start', { type: 'message_start', message: { id: 'msg_ok' } }],
    [
      'message_delta',
      {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: { output_tokens: 1 },
      },
    ],
  ])

function hybridStorage(): AccountStorage {
  return createFallbackStorage({
    accounts: [],
    quota: { enabled: false } as AccountStorage['quota'],
    claudeCache: { enabled: true, mode: 'hybrid' },
    cacheKeep: { enabled: true, always: true },
  })
}

async function setupRound(
  mainExpiresInMs = 8 * 60 * 60_000,
  storage: AccountStorage = hybridStorage(),
) {
  await useTempAccountFile(storage, {
    ...syntheticMainHostAuth(),
    expires: Date.now() + mainExpiresInMs,
  })
  const sent: SentRequest[] = []
  const warms: SentRequest[] = []
  let refusalsLeft = 1
  globalThis.fetch = mock(
    withNativeAdmission((input: any, init: any) => {
      const url = extractUrl(input)
      if (!url.includes('/v1/messages')) {
        return Promise.resolve(new Response('{}', { status: 200 }))
      }
      const parsed = JSON.parse(String(init?.body)) as Record<string, unknown>
      const headers = new Headers(init?.headers)
      const record: SentRequest = {
        model: String(parsed.model),
        maxTokens:
          typeof parsed.max_tokens === 'number' ? parsed.max_tokens : undefined,
        fallbacks: parsed.fallbacks,
        betas: headers.get('anthropic-beta') ?? '',
        auth: headers.get('authorization') ?? '',
        parsed,
      }
      if (record.maxTokens === 0) {
        warms.push(record)
        return Promise.resolve(new Response('{}', { status: 200 }))
      }
      sent.push(record)
      if (record.model === SOURCE_MODEL && refusalsLeft > 0) {
        refusalsLeft--
        return Promise.resolve(new Response(refusalSse(), { status: 200 }))
      }
      return Promise.resolve(new Response(successSse(), { status: 200 }))
    }),
  ) as unknown as typeof fetch

  const plugin = (await getPlugin()) as TestPlugin
  const result = await plugin.auth.loader(
    () =>
      Promise.resolve({
        type: 'oauth',
        access: 'sk-ant-oat01-main-access',
        refresh: 'main-refresh',
        expires: Date.now() + 100000,
      }),
    { models: {} },
  )
  return { plugin, result, sent, warms }
}

function targetId(sessionId: string) {
  return sourceWarmTargetId(sessionId, 'opus-5-5')
}

function recoveryKey(sessionId: string) {
  return sourceWarmRecoveryKey(sessionId, 'opus-5-5')
}

async function waitForSourceWarmTarget(plugin: TestPlugin, sessionId: string) {
  const manager = getPluginTestHandles(plugin).cacheKeepManager
  for (let attempt = 0; attempt < 200; attempt++) {
    if (
      manager
        .trackedSessions()
        .some((session) => session.id === targetId(sessionId))
    )
      return
    await Bun.sleep(5)
  }
  throw new Error('source warm target was never tracked')
}

/** Drive a refusal, then one successful Opus turn so the live target is 4.8. */
async function startRound(
  sessionId: string,
  round: Awaited<ReturnType<typeof setupRound>>,
  extraHeaders: Record<string, string> = {},
  expectWarmTarget = true,
) {
  const request = {
    method: 'POST',
    headers: { 'x-session-affinity': sessionId, ...extraHeaders },
    body: requestBody(),
  }
  const filtered = await round.result.fetch(MESSAGES_URL, request)
  await expect(filtered.text()).rejects.toThrow()
  if (expectWarmTarget) await waitForSourceWarmTarget(round.plugin, sessionId)
  const firstOpus = await round.result.fetch(MESSAGES_URL, request)
  await firstOpus.text()
}

function sourceWarms(round: Awaited<ReturnType<typeof setupRound>>) {
  return round.warms.filter((warm) => warm.model === SOURCE_MODEL)
}

/** Simulate a new user turn through the same hooks OpenCode calls. */
async function userTurnHeaders(
  plugin: TestPlugin,
  sessionId: string,
  messageId: string,
) {
  await plugin['experimental.chat.messages.transform'](
    {},
    {
      messages: [
        { info: { id: messageId, sessionID: sessionId, role: 'user' } },
      ],
    },
  )
  const headers: Record<string, string> = {}
  await plugin['chat.headers'](
    { sessionID: sessionId, message: { id: messageId } },
    { headers },
  )
  return headers
}

describe('source-warm', () => {
  installLoaderSetup(testContext)

  test('a round longer than the source cache lifetime sends exactly one source warm near expiry', async () => {
    const realDateNow = Date.now
    try {
      const round = await setupRound()
      const sessionId = 'ses_warm_long'
      await startRound(sessionId, round)
      const firstSend = round.sent[0]
      if (!firstSend) throw new Error('refused source request was not sent')
      const sourceAuth = firstSend.auth
      expect(sourceAuth).toContain('Bearer ')
      const refusedMessages = firstSend.parsed.messages as unknown[] | undefined
      expect(refusedMessages?.length).toBeGreaterThan(0)

      const baseNow = realDateNow()
      Date.now = () => baseNow + 30 * 60_000
      await getPluginTestHandles(round.plugin).cacheKeepManager.tick()
      expect(sourceWarms(round)).toHaveLength(0)

      Date.now = () => baseNow + 56 * 60_000
      await getPluginTestHandles(round.plugin).cacheKeepManager.tick()
      expect(sourceWarms(round)).toHaveLength(1)
      expect(
        sessionCacheActivity.holdUntil(targetId(sessionId), 'main'),
      ).toBeUndefined()
      const warm = sourceWarms(round)[0]!
      expect(warm.maxTokens).toBe(0)
      expect(warm.fallbacks).toBeUndefined()
      expect(warm.betas.split(',').map((beta) => beta.trim())).not.toContain(
        SERVER_SIDE_FALLBACK_BETA,
      )
      expect(warm.betas).toContain(CACHE_KEEP_EXTENDED_TTL_BETA)
      // The warm goes to the same account that sent the source request.
      expect(warm.auth).toBe(sourceAuth)
      // The warm carries the source's exact prefix, not a 4.8 rebuild.
      expect(warm.parsed.messages).toEqual(refusedMessages)
      expect(
        (warm.parsed.system as Array<{ text?: string }>).some((block) =>
          block.text?.includes('x-anthropic-billing-header:'),
        ),
      ).toBe(true)

      // A second tick without time passing sends nothing more.
      await getPluginTestHandles(round.plugin).cacheKeepManager.tick()
      expect(sourceWarms(round)).toHaveLength(1)

      // The next lifetime is not due yet either.
      Date.now = () => baseNow + 106 * 60_000
      await getPluginTestHandles(round.plugin).cacheKeepManager.tick()
      expect(sourceWarms(round)).toHaveLength(1)

      // One cache lifetime later the round is still alive, so it warms again.
      Date.now = () => baseNow + 111 * 60_000
      await getPluginTestHandles(round.plugin).cacheKeepManager.tick()
      expect(sourceWarms(round)).toHaveLength(2)
    } finally {
      Date.now = realDateNow
    }
  })

  test('a round that ends before expiry sends no source warm', async () => {
    const realDateNow = Date.now
    try {
      const round = await setupRound()
      const sessionId = 'ses_warm_short'
      await startRound(sessionId, round)
      const manager = getPluginTestHandles(round.plugin).cacheKeepManager
      expect(
        manager.trackedSessions().some((s) => s.id === targetId(sessionId)),
      ).toBe(true)

      const request = {
        method: 'POST',
        headers: { 'x-session-affinity': sessionId },
        body: requestBody(),
      }
      for (let turn = 0; turn < 9; turn++) {
        await (await round.result.fetch(MESSAGES_URL, request)).text()
      }
      await (await round.result.fetch(MESSAGES_URL, request)).text()

      expect(
        manager.trackedSessions().some((s) => s.id === targetId(sessionId)),
      ).toBe(false)
      // Past expiry only ordinary CacheKeep fires: the last live send was
      // the source probe, so one source-model warm goes out under the live
      // session target, and none from the removed round warm.
      const baseNow = realDateNow()
      Date.now = () => baseNow + 56 * 60_000
      await manager.tick()
      expect(round.warms).toHaveLength(1)
      expect(round.warms[0]?.model).toBe(SOURCE_MODEL)
    } finally {
      Date.now = realDateNow
    }
  })

  test('a user model change removes the source warm target', async () => {
    const round = await setupRound()
    const sessionId = 'ses_warm_model'
    await startRound(sessionId, round)
    const manager = getPluginTestHandles(round.plugin).cacheKeepManager
    expect(
      manager.trackedSessions().some((s) => s.id === targetId(sessionId)),
    ).toBe(true)

    const switched = await round.result.fetch(MESSAGES_URL, {
      method: 'POST',
      headers: { 'x-session-affinity': sessionId },
      body: requestBody('claude-opus-4-8'),
    })
    await switched.text()
    expect(
      manager.trackedSessions().some((s) => s.id === targetId(sessionId)),
    ).toBe(false)
    expect(
      getPluginTestHandles(
        round.plugin,
      ).fableFallbackManager.hasSourceWarmForSession(sessionId),
    ).toBe(false)
  })

  test('a deleted session removes the source warm target', async () => {
    const round = await setupRound()
    const sessionId = 'ses_warm_deleted'
    await startRound(sessionId, round)
    await round.plugin.event?.({
      event: {
        type: 'session.deleted',
        properties: { sessionID: sessionId },
      },
    })
    const manager = getPluginTestHandles(round.plugin).cacheKeepManager
    expect(
      manager.trackedSessions().some((s) => s.id === targetId(sessionId)),
    ).toBe(false)
  })

  test('turning hybrid mode off removes the source warm target', async () => {
    const round = await setupRound()
    const sessionId = 'ses_warm_hybrid_off'
    await startRound(sessionId, round)
    const manager = getPluginTestHandles(round.plugin).cacheKeepManager
    expect(
      manager.trackedSessions().some((s) => s.id === targetId(sessionId)),
    ).toBe(true)

    setCache1hState({ enabled: true, mode: 'explicit' })
    try {
      const response = await round.result.fetch(MESSAGES_URL, {
        method: 'POST',
        headers: { 'x-session-affinity': sessionId },
        body: requestBody(),
      })
      await response.text()
    } finally {
      setCache1hState({ enabled: true, mode: 'hybrid' })
    }
    expect(
      manager.trackedSessions().some((s) => s.id === targetId(sessionId)),
    ).toBe(false)
  })

  test('a history edit drops the warm before it can send', async () => {
    const realDateNow = Date.now
    const warnings: Array<{ message: string; payload?: unknown }> = []
    __setLogTestSink((record) => {
      if (record.level === 'warn') warnings.push(record)
    })
    try {
      const round = await setupRound()
      const sessionId = 'ses_warm_edited'
      await startRound(sessionId, round)
      // A compaction rewrites the early history the keep was built on.
      const edited = await round.result.fetch(MESSAGES_URL, {
        method: 'POST',
        headers: { 'x-session-affinity': sessionId },
        body: requestBody(SOURCE_MODEL, [
          { role: 'user', content: 'compacted summary instead' },
        ]),
      })
      await edited.text()

      const manager = getPluginTestHandles(round.plugin).cacheKeepManager
      expect(
        manager.trackedSessions().some((s) => s.id === targetId(sessionId)),
      ).toBe(false)
      const baseNow = realDateNow()
      Date.now = () => baseNow + 56 * 60_000
      await manager.tick()
      expect(sourceWarms(round)).toHaveLength(0)
      expect(
        warnings.filter(
          (warning) =>
            warning.message ===
            'source warm stopped: history no longer starts with the kept prefix',
        ),
      ).toHaveLength(1)
    } finally {
      __setLogTestSink(null)
      Date.now = realDateNow
    }
  })

  test('the idle cap stops warms at the derived count and a user turn resets it', async () => {
    const realDateNow = Date.now
    try {
      // The idle stretch runs about forty hours; keep the credential valid.
      const round = await setupRound(200 * 60 * 60_000)
      const sessionId = 'ses_warm_idle'
      const firstTurn = await userTurnHeaders(round.plugin, sessionId, 'msg_u1')
      await startRound(sessionId, round, firstTurn)
      const fallbackManager = getPluginTestHandles(
        round.plugin,
      ).fableFallbackManager
      const cacheKeep = getPluginTestHandles(round.plugin).cacheKeepManager
      const baseNow = realDateNow()
      let elapsed = 56 * 60_000
      Date.now = () => baseNow + elapsed
      await cacheKeep.tick()
      // The refusal turn counts as the first observed turn; no reset yet.
      expect(
        fallbackManager.sourceWarmFor(recoveryKey(sessionId)),
      ).toMatchObject({ warmsSinceUserTurn: 1 })

      // A new user turn resets the idle count.
      const secondTurn = await userTurnHeaders(
        round.plugin,
        sessionId,
        'msg_u2',
      )
      const followUp = await round.result.fetch(MESSAGES_URL, {
        method: 'POST',
        headers: { 'x-session-affinity': sessionId, ...secondTurn },
        body: requestBody(),
      })
      await followUp.text()
      expect(
        fallbackManager.sourceWarmFor(recoveryKey(sessionId)),
      ).toMatchObject({ warmsSinceUserTurn: 0 })

      // Only the kept source prefix has an idle cap. Stop warming the live
      // Opus 4.8 prefix so the long idle stretch sends no unrelated prewarms.
      expect(cacheKeep.untrack(sessionId)).toBe(true)

      // Opus 5.5 pricing derives a cap of 39 warms per idle stretch. Step
      // just under a lifetime so every tick finds a due (not expired) warm.
      for (let index = 0; index < 39; index++) {
        elapsed += 55 * 60_000
        await cacheKeep.tick()
      }
      expect(sourceWarms(round)).toHaveLength(1 + 39)
      expect(
        fallbackManager.sourceWarmFor(recoveryKey(sessionId)),
      ).toMatchObject({ warmsSinceUserTurn: 39 })
      expect(
        cacheKeep.trackedSessions().some((s) => s.id === targetId(sessionId)),
      ).toBe(true)

      // The next tick hits the cap: the warm is refused and the target goes.
      // Step under a lifetime so the validator (not expiry pruning) decides.
      elapsed += 55 * 60_000
      await cacheKeep.tick()
      expect(sourceWarms(round)).toHaveLength(1 + 39)
      expect(
        cacheKeep.trackedSessions().some((s) => s.id === targetId(sessionId)),
      ).toBe(false)
      expect(
        fallbackManager.sourceWarmFor(recoveryKey(sessionId)),
      ).toBeUndefined()

      // Past the cap nothing more is sent.
      elapsed += 60 * 60_000
      await cacheKeep.tick()
      expect(sourceWarms(round)).toHaveLength(1 + 39)
    } finally {
      Date.now = realDateNow
    }
  })

  test('without CacheKeep nothing is kept or warmed', async () => {
    const realDateNow = Date.now
    try {
      const round = await setupRound(
        8 * 60 * 60_000,
        createFallbackStorage({
          accounts: [],
          quota: { enabled: false } as AccountStorage['quota'],
          claudeCache: { enabled: true, mode: 'hybrid' },
          cacheKeep: { enabled: false },
        }),
      )
      const sessionId = 'ses_warm_disabled'
      await startRound(sessionId, round, {}, false)
      const manager = getPluginTestHandles(round.plugin).cacheKeepManager
      expect(
        manager.trackedSessions().some((s) => s.id === targetId(sessionId)),
      ).toBe(false)
      expect(
        getPluginTestHandles(
          round.plugin,
        ).fableFallbackManager.hasSourceWarmForSession(sessionId),
      ).toBe(false)
      const baseNow = realDateNow()
      Date.now = () => baseNow + 56 * 60_000
      await manager.tick()
      expect(round.warms).toHaveLength(0)
    } finally {
      Date.now = realDateNow
    }
  })

  test('a tampered kept body is refused and nothing is sent', async () => {
    const realDateNow = Date.now
    const warnings: Array<{ message: string; payload?: unknown }> = []
    __setLogTestSink((record) => {
      if (record.level === 'warn') warnings.push(record)
    })
    try {
      const round = await setupRound()
      const sessionId = 'ses_warm_tampered'
      await startRound(sessionId, round)
      const fallbackManager = getPluginTestHandles(
        round.plugin,
      ).fableFallbackManager
      const state = (
        fallbackManager as unknown as {
          recoveries: Map<string, { sourceWarm?: { bodyText: string } }>
        }
      ).recoveries.get(recoveryKey(sessionId))
      expect(state?.sourceWarm?.bodyText).toContain('same session input')
      state!.sourceWarm!.bodyText = state!.sourceWarm!.bodyText.replace(
        'same session input',
        'tampered history',
      )

      const baseNow = realDateNow()
      Date.now = () => baseNow + 56 * 60_000
      await getPluginTestHandles(round.plugin).cacheKeepManager.tick()
      expect(sourceWarms(round)).toHaveLength(0)
      expect(
        getPluginTestHandles(round.plugin)
          .cacheKeepManager.trackedSessions()
          .some((s) => s.id === targetId(sessionId)),
      ).toBe(false)
      const refusals = warnings.filter(
        (warning) => warning.message === 'stopped warming session',
      )
      expect(refusals).toHaveLength(1)
      expect(refusals[0]?.payload).toMatchObject({
        session: targetId(sessionId),
        reason: 'source-prefix-mismatch',
      })
      expect(parseSourceWarmTargetId(targetId(sessionId))).toEqual({
        sessionId,
        family: 'opus-5-5',
      })
    } finally {
      __setLogTestSink(null)
      Date.now = realDateNow
    }
  })

  test('a rotated credential stops the warm instead of warming another account', async () => {
    const realDateNow = Date.now
    try {
      const round = await setupRound()
      const sessionId = 'ses_warm_rotated'
      await startRound(sessionId, round)
      const fallbackManager = getPluginTestHandles(
        round.plugin,
      ).fableFallbackManager
      const state = (
        fallbackManager as unknown as {
          recoveries: Map<string, { sourceWarm?: { accountIdentity?: string } }>
        }
      ).recoveries.get(recoveryKey(sessionId))
      expect(state?.sourceWarm?.accountIdentity).toBeDefined()
      state!.sourceWarm!.accountIdentity = 'replaced-account-uuid'

      const baseNow = realDateNow()
      Date.now = () => baseNow + 56 * 60_000
      await getPluginTestHandles(round.plugin).cacheKeepManager.tick()
      expect(sourceWarms(round)).toHaveLength(0)
      expect(
        getPluginTestHandles(round.plugin)
          .cacheKeepManager.trackedSessions()
          .some((s) => s.id === targetId(sessionId)),
      ).toBe(false)
    } finally {
      Date.now = realDateNow
    }
  })
})
