import { afterEach, beforeEach, describe, expect, mock, spyOn } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import * as core from '@cortexkit/anthropic-auth-core'
import {
  __setLogTestSink,
  type AccountStorage,
  CACHE_KEEP_MAX_BODY_BYTES,
  CacheKeepManager,
  CacheKeepStore,
  type CacheKeepTarget,
  type CommandApplyRequest,
  type CommandApplyResult,
  cacheKeepStoreDirectory,
  getDumpDirectory,
  isDumpEnabled,
  type LogTestRecord,
  type MessageThreadTracker,
  messageThreadBetas,
  prepareMessageThreadRequest,
  resetBillingHeaderCCH,
  resetCache1hState,
  resetDumpState,
  setLogLevel,
  signRequestBody,
  tokenFingerprint,
} from '@cortexkit/anthropic-auth-core'
import { MessageThreadTailStore } from '../../../core/src/message-thread-tail-store.ts'
import { drainSidebarWrites } from '../sidebar-state'
import { getPluginTestHandles } from './plugin-test-handles'
import {
  applyMenuAction as applyMenuActionWithCtx,
  createMockClient,
  expectHandledCommandResponse,
} from './support/opencode1-client.ts'
import { installLoaderSetup } from './support/opencode1-loader-setup.ts'
import {
  bindPoolAccounts,
  createFallbackStorage,
  getPlugin as getPluginWithCtx,
  syntheticMainAccountUuid,
  syntheticMainHostAuth,
  updatePoolSettings,
  useTempAccountFile as useTempAccountFileWithCtx,
  withNativeAdmission as withNativeAdmissionWithCtx,
} from './support/opencode1-pool-fixture.ts'
import {
  readAccountStorage as readAccountStorageWithCtx,
  restoreProcessTestFiles,
} from './support/opencode1-state-observers.ts'
import type { PluginRuntimeOverrides } from './support/opencode1-test-context.ts'
import {
  createOpencode1Test,
  createOpencode1TestContext,
  installOpencode1TestHooks,
  lifetimeSignal,
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
  runtimeOverrides: PluginRuntimeOverrides = {},
): any {
  return getPluginWithCtx(testContext, client, directory, runtimeOverrides)
}
function readAccountStorage(): Promise<AccountStorage | null> {
  return readAccountStorageWithCtx(testContext)
}
function applyMenuAction(
  plugin: any,
  sessionId: string,
  request: Omit<CommandApplyRequest, 'command' | 'sessionId'>,
): Promise<CommandApplyResult> {
  return applyMenuActionWithCtx(testContext, plugin, sessionId, request)
}

describe('auth.loader', () => {
  installLoaderSetup(testContext)

  async function warmFixture() {
    await useTempAccountFile(
      bindPoolAccounts(
        createFallbackStorage({
          routing: { mode: 'fallback-first' },
          refresh: { enabled: false },
          quota: { enabled: false },
          claudeCache: { enabled: true, mode: 'hybrid' },
          cacheKeep: { enabled: true, always: true },
        }),
      ),
    )
  }

  async function acceptRequest(
    plugin: any,
    sessionId: string,
    text: string,
    model = 'claude-opus-4-8',
  ) {
    const result = await plugin.auth.loader(
      () => Promise.resolve({ ...syntheticMainHostAuth(), type: 'oauth' }),
      { models: {} },
    )
    const response = await result.fetch(MESSAGES_URL, {
      method: 'POST',
      headers: { 'x-session-affinity': sessionId },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: text }],
      }),
    })
    expect(response.status).toBe(200)
    await response.text()
  }

  test('OC1 records prefix usage for auto keep-warm pricing without a restart', async () => {
    await warmFixture()
    globalThis.fetch = mock(
      withNativeAdmission(() =>
        Response.json({
          usage: { cache_read_input_tokens: 1500, input_tokens: 12 },
        }),
      ),
    ) as unknown as typeof fetch
    const plugin = await getPlugin()
    const sessionId = 'oc1-warm-prefix-usage'
    await acceptRequest(plugin, sessionId, 'a priced prefix')
    const handles = getPluginTestHandles(plugin)
    await handles.drainDispatchWork()
    expect(
      handles.cacheKeepManager.trackedPolicyState(sessionId),
    ).toMatchObject({
      prefixTokens: 1500,
      inputTokens: 1512,
    })
  })

  test('OC1 restores an idle warm once per server and keeps its durable budget', async () => {
    let now = Date.now()
    Date.now = mock(() => now)
    await warmFixture()
    const warmBodies: string[] = []
    const directory = cacheKeepStoreDirectory(
      process.env.OPENCODE_ANTHROPIC_AUTH_FILE!,
      undefined,
      'opencode1',
    )
    const readRecord = async () => {
      const files = (await readdir(directory)).filter((name) =>
        name.endsWith('.json.gz'),
      )
      expect(files).toHaveLength(1)
      const path = join(directory, files[0]!)
      if (process.platform !== 'win32')
        expect((await stat(path)).mode & 0o777).toBe(0o600)
      return JSON.parse(gunzipSync(await readFile(path)).toString())
    }
    const reservations: unknown[] = []
    globalThis.fetch = mock(
      withNativeAdmission(async (_input: unknown, init: RequestInit) => {
        const body = String(init.body)
        if (JSON.parse(body).max_tokens === 0) {
          warmBodies.push(body)
          reservations.push((await readRecord()).policyState)
        }
        return Response.json({ usage: { cache_read_input_tokens: 1500 } })
      }),
    ) as unknown as typeof fetch

    const original = await getPlugin(undefined, '/original-project')
    const sessionId = 'oc1-restart-warm'
    await acceptRequest(
      original,
      sessionId,
      'a restartable prefix',
      'claude-opus-5-5',
    )
    await getPluginTestHandles(original).drainDispatchWork()
    await original.dispose()
    testContext.livePlugins.delete(original)
    const saved = await readRecord()
    expect(saved).toMatchObject({ v: 1, id: sessionId })
    expect(saved.bodyText).toContain('a restartable prefix')
    expect(saved.headers).toBeUndefined()
    expect(saved.policyState.prefixTokens).toBe(1500)

    const plugins = await Promise.all([
      getPlugin(undefined, '/first-project'),
      getPlugin(undefined, '/second-project'),
    ])
    const managers = plugins.map(
      (plugin) => getPluginTestHandles(plugin).cacheKeepManager,
    )
    await Promise.all(
      plugins.map((p) => getPluginTestHandles(p).drainDispatchWork()),
    )
    expect(
      managers
        .flatMap((manager) => manager.trackedSessions())
        .map(({ id }) => id),
    ).toEqual([sessionId])
    now = saved.nextPrewarmAt + 1
    await Promise.all(managers.map((manager) => manager.tick()))
    expect(warmBodies).toHaveLength(1)
    expect(warmBodies[0]).toContain('a restartable prefix')
    expect(reservations).toEqual([
      expect.objectContaining({
        warmsSinceLastRealRequest: 1,
        pendingWarmCost: expect.any(Number),
      }),
    ])
    const owner = managers.findIndex((manager) =>
      manager.trackedRequest(sessionId),
    )
    const close = async (plugin: any) => {
      await plugin.dispose()
      testContext.livePlugins.delete(plugin)
    }
    await close(plugins[owner])
    expect(managers[1 - owner]?.trackedRequest(sessionId)).toBeDefined()
    await close(plugins[1 - owner])
    const updated = await readRecord()
    expect(updated.policyState).toMatchObject({ warmsSinceLastRealRequest: 1 })
    expect(updated.policyState.warmCostSoFar).toBeGreaterThan(0)
    expect(updated.cacheExpiresAt).toBeGreaterThan(saved.cacheExpiresAt)
    const restarted = await getPlugin(undefined, '/third-project')
    await getPluginTestHandles(restarted).drainDispatchWork()
    const restored =
      getPluginTestHandles(restarted).cacheKeepManager.trackedPolicyState(
        sessionId,
      )
    expect(restored).toMatchObject({
      warmsSinceLastRealRequest: 1,
      warmCostSoFar: updated.policyState.warmCostSoFar,
    })
  })

  test('OC1 dispatches the first request without waiting for restart restoration', async () => {
    await warmFixture()
    globalThis.fetch = mock(
      withNativeAdmission(() =>
        Response.json({ usage: { cache_read_input_tokens: 1500 } }),
      ),
    ) as unknown as typeof fetch
    const sessionId = 'oc1-late-restore'
    const original = await getPlugin()
    await acceptRequest(original, sessionId, 'saved prefix')
    await original.dispose()
    testContext.livePlugins.delete(original)

    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const load = CacheKeepStore.prototype.load
    const scan = spyOn(CacheKeepStore.prototype, 'load').mockImplementation(
      async function (this: CacheKeepStore, ...args) {
        entered.resolve()
        await release.promise
        return load.apply(this, args)
      },
    )
    const firstRequest = (async () => {
      const plugin = await getPlugin(undefined, '/late-restore')
      await acceptRequest(plugin, sessionId, 'first live prefix')
      return getPluginTestHandles(plugin)
    })()
    let cancelDeadline = () => {}
    let finished: Awaited<typeof firstRequest> | undefined
    try {
      await entered.promise
      finished = await Promise.race([
        firstRequest,
        new Promise<undefined>((resolve) => {
          const deadline = setTimeout(resolve, 1500)
          cancelDeadline = () => clearTimeout(deadline)
        }),
      ])
    } finally {
      cancelDeadline()
      release.resolve()
      scan.mockRestore()
      await (await firstRequest).drainDispatchWork()
    }
    expect(finished).toBeDefined()
    expect(
      finished?.cacheKeepManager.trackedRequest(sessionId)?.bodyText,
    ).toContain('first live prefix')
  })

  test.each([{ shift: -500 }, { shift: 500 }])(
    'OC1 failed tracking during a restore scan respects freshness ($shift ms clock step)',
    async ({ shift }) => {
      const savedAt = Date.now()
      let now = savedAt
      const clock = { now: () => now }
      await warmFixture()
      globalThis.fetch = mock(
        withNativeAdmission(() =>
          Response.json({ usage: { cache_read_input_tokens: 1500 } }),
        ),
      ) as unknown as typeof fetch

      const id = 'oc1-restart-budget'
      const original = await getPlugin(undefined, '/original-project', clock)
      await acceptRequest(original, id, 'saved prefix')
      await original.dispose()
      testContext.livePlugins.delete(original)
      const directory = cacheKeepStoreDirectory(
        process.env.OPENCODE_ANTHROPIC_AUTH_FILE!,
        undefined,
        'opencode1',
      )
      const key = createHash('sha256').update(id).digest('hex')
      const record = join(directory, `${key}.json.gz`)
      const claim = join(`${directory}.claims`, `${key}.claim.json`)
      const saved = await readFile(record)
      expect(
        JSON.parse(gunzipSync(saved).toString()).policyState,
      ).toMatchObject({
        lastRealRequestAt: savedAt,
      })

      const owner = await getPlugin(undefined, '/owner-project', clock)
      const handles = getPluginTestHandles(owner)
      await handles.drainDispatchWork()
      const manager = handles.cacheKeepManager
      const targets = Reflect.get(manager, 'targets') as Map<
        string,
        CacheKeepTarget
      >
      const restored = targets.get(id)!
      expect(restored.bodyText).toContain('saved prefix')
      expect(JSON.parse(await readFile(claim, 'utf8')).restoreOnly).toBe(true)

      const imminentId = 'oc1-imminent'
      await acceptRequest(owner, imminentId, 'a different session')
      const imminent = targets.get(imminentId)!
      // Leave just enough room for the saved body without sending a 64 MiB
      // prompt. The near-due session wins eviction priority over the replacement.
      imminent.bodyBytes = CACHE_KEEP_MAX_BODY_BYTES - restored.bodyBytes
      imminent.nextPrewarmAt = savedAt + 30_000

      const entered = Promise.withResolvers<CacheKeepStore>()
      const resume = lifetimeSignal(testContext)
      const load = CacheKeepStore.prototype.load
      const scan = spyOn(CacheKeepStore.prototype, 'load').mockImplementation(
        async function (this: CacheKeepStore, ...args) {
          entered.resolve(this)
          await resume.raised
          return load.apply(this, args)
        },
      )
      const track = spyOn(manager, 'track')
      let other: Awaited<ReturnType<typeof getPlugin>>
      try {
        other = await getPlugin(undefined, '/other-project', clock)
        const store = await entered.promise
        now = savedAt + shift
        // The accepted request must finish while the other project's scan is
        // still paused. The replacement exceeds the remaining body budget.
        await acceptRequest(owner, id, 'larger replacement prefix '.repeat(200))
        expect(track.mock.lastCall?.[0]).toMatchObject({
          sessionId: id,
          oauthAccountId: restored.oauthAccountId,
          oauthAccountIdentity: restored.oauthAccountIdentity,
        })
        expect(track.mock.results.at(-1)?.value).toEqual({
          tracked: false,
          reason: 'evicted by cachekeep limits',
        })
        expect(manager.trackedSessions().map(({ id }) => id)).toEqual([
          imminentId,
        ])

        await store.drain()
        await expect(readFile(claim)).rejects.toMatchObject({ code: 'ENOENT' })
        if (shift < 0) expect(await readFile(record)).toEqual(saved)
        else
          await expect(readFile(record)).rejects.toMatchObject({
            code: 'ENOENT',
          })
      } finally {
        track.mockRestore()
        scan.mockRestore()
        resume.raise()
        if (other) await getPluginTestHandles(other).drainDispatchWork()
      }
    },
  )

  test('OC1 reuses the previous full cache boundary after a thread restart', async () => {
    await warmFixture()
    const original = await getPlugin(undefined, '/original-thread-project')
    const tracker = getPluginTestHandles(original).messageThreads
    const session = `oc1-thread-${crypto.randomUUID()}`
    const mark = { type: 'ephemeral', ttl: '1h' }
    const text = (text: string, cache = false) => ({
      type: 'text',
      text,
      ...(cache && { cache_control: mark }),
    })
    const body = {
      model: 'claude-opus-4-8',
      system: [text('system', true)],
      messages: [{ role: 'user', content: [text('cached first turn', true)] }],
    }
    const input = {
      session,
      account: 'account',
      credential: 'credential',
      betas: messageThreadBetas(new Headers()),
    }
    const reply = { role: 'assistant', content: [text('answer')] }
    const complete = (prepared: ReturnType<MessageThreadTracker['prepare']>) =>
      prepared.complete({
        messageId: 'msg_accepted',
        reply,
        stopped: true,
        stopReason: 'end_turn',
      })
    complete(tracker.prepare({ ...input, body }))
    const second = { role: 'user', content: [text('next turn', true)] }
    const continued = tracker.prepare({
      ...input,
      body: { ...body, messages: [...body.messages, reply, second] },
    })
    expect(continued.decision.type).toBe('continue')
    complete(continued)

    const store = new MessageThreadTailStore('opencode1')
    try {
      for (let attempt = 0; attempt < 20; attempt++) {
        if ((await store.load(session))?.continued) break
        await Bun.sleep(10)
      }
      expect(await store.load(session)).toMatchObject({ continued: true })
      expect(
        await new MessageThreadTailStore('opencode2').load(session),
      ).toBeUndefined()
      await original.dispose()
      testContext.livePlugins.delete(original)
      const restarted = await getPlugin(undefined, '/restarted-thread-project')
      const prepared = await prepareMessageThreadRequest(
        getPluginTestHandles(restarted).messageThreads,
        {
          ...input,
          headers: new Headers(),
          bodyText: JSON.stringify({
            ...body,
            messages: [
              { role: 'user', content: [text('cached first turn')] },
              reply,
              { role: 'user', content: [text('next turn')] },
              reply,
              { role: 'user', content: [text('new turn', true)] },
            ],
          }),
          cacheSlot: (outgoing) =>
            (outgoing.system as Record<string, unknown>[])[0],
        },
      )
      const outgoing = JSON.parse(prepared.bodyText)
      expect(outgoing.thread).toEqual({ type: 'create' })
      expect(outgoing.messages[0].content[0].cache_control).toEqual(mark)
      expect(outgoing.system[0].cache_control).toBeUndefined()
    } finally {
      store.changed(session, undefined, false)
      await store.drain()
    }
  })

  test('OC1 gzips eligible prewarms and rescues them with the same signed body', async () => {
    let now = Date.now()
    Date.now = mock(() => now)
    await warmFixture()
    const sends: Array<{ body: string; encoding: string | null }> = []
    globalThis.fetch = mock(
      withNativeAdmission((_input: unknown, init: RequestInit) => {
        const encoding = new Headers(init.headers).get('content-encoding')
        const body =
          encoding === 'gzip'
            ? gunzipSync(init.body as Uint8Array).toString()
            : String(init.body)
        if (JSON.parse(body).max_tokens === 0) {
          sends.push({ body, encoding })
          if (encoding === 'gzip')
            return new Response('Unsupported content-encoding: gzip', {
              status: 415,
            })
        }
        return Response.json({ usage: { cache_read_input_tokens: 1 } })
      }),
    ) as unknown as typeof fetch
    const plugin = await getPlugin()
    await acceptRequest(plugin, 'oc1-gzip-warm', 'large prefix '.repeat(500))
    now += 55 * 60_000
    await getPluginTestHandles(plugin).cacheKeepManager.tick()
    expect(sends.map(({ encoding }) => encoding)).toEqual(['gzip', null])
    const identityBody = sends[1]!.body
    expect(await signRequestBody(identityBody)).toBe(identityBody)
    expect(sends[0]?.body.trimEnd()).toBe(resetBillingHeaderCCH(identityBody))
  })

  test('OC1 routing-moved stops an old-account warm before the next real turn', async () => {
    let now = Date.now()
    Date.now = mock(() => now)
    const intervals: Array<() => unknown> = []
    testContext.pluginRuntimeOverrides = {
      setInterval: ((callback: () => unknown) => {
        intervals.push(callback)
        return { unref() {} } as ReturnType<typeof setInterval>
      }) as typeof setInterval,
      clearInterval: (() => {}) as typeof clearInterval,
    }
    const window = { remainingPercent: 80, usedPercent: 20, checkedAt: now }
    await useTempAccountFile(
      bindPoolAccounts(
        createFallbackStorage({
          routing: { mode: 'fallback-first' },
          refresh: { enabled: false },
          quota: {
            enabled: false,
            mainQuota: { five_hour: window, seven_day: window },
          },
          claudeCache: { enabled: true, mode: 'hybrid' },
          cacheKeep: { enabled: true, always: true },
        }),
      ),
    )
    const requests: Headers[] = []
    const records: LogTestRecord[] = []
    globalThis.fetch = mock(
      withNativeAdmission((_input: any, init: RequestInit) => {
        requests.push(new Headers(init.headers))
        return Promise.resolve(
          new Response(
            JSON.stringify({ usage: { cache_read_input_tokens: 1 } }),
            { status: 200 },
          ),
        )
      }),
    ) as unknown as typeof fetch
    __setLogTestSink((record) => records.push(record))
    const ticking = spyOn(CacheKeepManager.prototype, 'tick')
    try {
      const plugin = await getPlugin()
      const result = await plugin.auth.loader(
        () => Promise.resolve({ ...syntheticMainHostAuth(), type: 'oauth' }),
        { models: {} },
      )
      await (
        await result.fetch(MESSAGES_URL, {
          method: 'POST',
          headers: { 'x-session-affinity': 'ses-routing-moved' },
          body: JSON.stringify({
            model: 'claude-opus-4-8',
            messages: [{ role: 'user', content: 'hello' }],
          }),
        })
      ).text()
      expect(requests[0]?.get('authorization')).toBe(
        'Bearer sk-ant-oat01-fallback-access',
      )
      await updatePoolSettings(testContext, (settings) => ({
        ...settings,
        routing: { mode: 'main-first' },
      }))
      now += 55 * 60_000
      intervals.at(-1)?.()
      await ticking.mock.results.at(-1)?.value
      expect(requests).toHaveLength(1)
      const stopped = records.filter(
        (record) => record.message === 'stopped warming session',
      )
      expect(stopped).toHaveLength(1)
      expect(stopped[0]?.payload).toMatchObject({ reason: 'routing-moved' })
    } finally {
      ticking.mockRestore()
    }
  })

  test('cachekeep lists tracked sessions across OpenCode plugin instances', async () => {
    const nowHour = new Date().getHours()
    const startHour = (nowHour + 23) % 24
    const endHour = (nowHour + 1) % 24
    await useTempAccountFile(
      createFallbackStorage({
        routing: { mode: 'fallback-first' },
        claudeCache: { enabled: true, mode: 'hybrid' },
        cacheKeep: { enabled: true, startHour, endHour },
      }),
    )

    globalThis.fetch = mock(
      withNativeAdmission((input: any) => {
        const url = extractUrl(input)
        if (url.includes('/api/oauth/usage')) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                five_hour: { utilization: 0.25 },
                seven_day: { utilization: 0.3 },
              }),
              { status: 200 },
            ),
          )
        }
        return Promise.resolve(new Response(null, { status: 200 }))
      }),
    ) as unknown as typeof fetch

    const mockClient = createMockClient()
    const plugin = await getPlugin(mockClient)
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

    await result.fetch(MESSAGES_URL, {
      method: 'POST',
      headers: { 'x-session-affinity': 'session-1' },
      body: JSON.stringify({
        model: 'claude-opus-4-8',
        messages: [{ role: 'user', content: 'hello' }],
      }),
    })

    const secondPlugin = await getPlugin(createMockClient())
    const secondResult = await secondPlugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )
    await secondResult.fetch(MESSAGES_URL, {
      method: 'POST',
      headers: { 'x-session-affinity': 'session-2' },
      body: JSON.stringify({
        model: 'claude-opus-4-8',
        messages: [{ role: 'user', content: 'hello' }],
      }),
    })

    const registryDirectory =
      process.env.OPENCODE_ANTHROPIC_AUTH_CACHEKEEP_REGISTRY_DIR
    if (!registryDirectory)
      throw new Error('missing cachekeep registry directory')
    for (let attempt = 0; attempt < 50; attempt++) {
      const entries = await readdir(registryDirectory).catch(() => [])
      if (entries.filter((entry) => entry.endsWith('.json')).length >= 2) break
      await Bun.sleep(10)
    }
    await expectHandledCommandResponse(
      plugin['command.execute.before']({
        command: 'claude',
        arguments: '',
        sessionID: 'session-1',
      }),
    )
    const promptCalls = (
      mockClient.session.promptAsync as unknown as {
        mock: { calls: Array<[{ body: { parts: Array<{ text: string }> } }]> }
      }
    ).mock.calls
    const latestCall = promptCalls.at(-1)?.[0]
    expect(latestCall?.body.parts[0]?.text).toContain('Tracked sessions: 2')
    expect(latestCall?.body.parts[0]?.text).toContain(
      'Sessions:\n- session-1\n- session-2',
    )
  })

  test('persistent claudeFast setting makes fetch wrapper request fast mode', async () => {
    await useTempAccountFile(
      createFallbackStorage({
        accounts: [],
        claudeFast: { enabled: true },
      }),
      {
        access: 'sk-ant-oat01-token',
        refresh: 'refresh',
        expires: Date.now() + 100000,
      },
    )

    let capturedHeaders: Headers | undefined
    let capturedBody: string | undefined
    globalThis.fetch = mock(
      withNativeAdmission((input: any, init: any) => {
        const url = extractUrl(input)
        if (url.includes('/api/oauth/usage')) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                five_hour: { utilization: 0 },
                seven_day: { utilization: 0 },
              }),
              { status: 200 },
            ),
          )
        }
        capturedHeaders = init?.headers
        capturedBody = init?.body
        return Promise.resolve(new Response(null, { status: 200 }))
      }),
    ) as unknown as typeof fetch

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-token',
          refresh: 'refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )

    await result.fetch(MESSAGES_URL, {
      method: 'POST',
      body: JSON.stringify({
        model: 'claude-opus-4-8',
        messages: [{ role: 'user', content: 'hello' }],
      }),
    })

    expect(capturedHeaders?.get('anthropic-beta')).toContain(
      'fast-mode-2026-02-01',
    )
    expect(JSON.parse(capturedBody!).speed).toBe('fast')
  })

  test.each(['claude-opus-4-6', 'claude-opus-4-7', 'claude-sonnet-4-5'])(
    'persistent claudeFast setting skips unsupported %s',
    async (model) => {
      await useTempAccountFile(
        createFallbackStorage({
          accounts: [],
          claudeFast: { enabled: true },
        }),
        {
          access: 'sk-ant-oat01-token',
          refresh: 'refresh',
          expires: Date.now() + 100000,
        },
      )

      let capturedHeaders: Headers | undefined
      let capturedBody: string | undefined
      globalThis.fetch = mock(
        withNativeAdmission((input: any, init: any) => {
          const url = extractUrl(input)
          if (url.includes('/api/oauth/usage')) {
            return Promise.resolve(
              new Response(
                JSON.stringify({
                  five_hour: { utilization: 0 },
                  seven_day: { utilization: 0 },
                }),
                { status: 200 },
              ),
            )
          }
          capturedHeaders = init?.headers
          capturedBody = init?.body
          return Promise.resolve(new Response(null, { status: 200 }))
        }),
      ) as unknown as typeof fetch

      const plugin = await getPlugin()
      const result = await plugin.auth.loader(
        () =>
          Promise.resolve({
            type: 'oauth',
            access: 'sk-ant-oat01-token',
            refresh: 'refresh',
            expires: Date.now() + 100000,
          }),
        { models: {} },
      )

      await result.fetch(MESSAGES_URL, {
        method: 'POST',
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: 'hello' }],
        }),
      })

      expect(capturedHeaders?.get('anthropic-beta')).not.toContain(
        'fast-mode-2026-02-01',
      )
      expect(JSON.parse(capturedBody!).speed).toBeUndefined()
    },
  )

  test('/claude-cache on makes fetch wrapper set ttl on existing cache controls', async () => {
    await useTempAccountFile(createFallbackStorage({ accounts: [] }), {
      access: 'sk-ant-oat01-my-access-token',
      refresh: 'refresh',
      expires: Date.now() + 100000,
    })
    let capturedBody: string | undefined
    const mockClient = createMockClient()

    globalThis.fetch = mock(
      withNativeAdmission((input: any, init: any) => {
        const url = extractUrl(input)
        if (url.includes('/api/oauth/usage')) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                five_hour: { utilization: 0 },
                seven_day: { utilization: 0 },
              }),
              { status: 200 },
            ),
          )
        }
        capturedBody = init?.body
        return Promise.resolve(new Response(null, { status: 200 }))
      }),
    ) as unknown as typeof fetch

    const plugin = await getPlugin(mockClient, testContext.tempConfigDir)
    expect(
      (
        await applyMenuAction(plugin, 'session-1', {
          sectionId: 'Cache',
          actionId: 'cache-on',
        })
      ).ok,
    ).toBe(true)

    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-my-access-token',
          refresh: 'refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )

    await result.fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      body: JSON.stringify({
        system: [
          {
            type: 'text',
            text: 'Cached block',
            cache_control: { type: 'ephemeral' },
          },
        ],
        messages: [{ role: 'user', content: 'hello world test message' }],
      }),
    })

    const parsedBody = JSON.parse(capturedBody!)
    expect(parsedBody.system[2].cache_control).toEqual({
      type: 'ephemeral',
      ttl: '1h',
    })
  })

  test('persistent claudeCache setting does not apply to subagent requests with parent session header', async () => {
    await useTempAccountFile(
      createFallbackStorage({ accounts: [], claudeCache: { enabled: true } }),
      {
        access: 'sk-ant-oat01-my-access-token',
        refresh: 'refresh',
        expires: Date.now() + 100000,
      },
    )
    let capturedBody: string | undefined
    let capturedHeaders: Headers | undefined
    const mockClient = createMockClient()

    globalThis.fetch = mock(
      withNativeAdmission(
        (input: string | URL | Request, init?: RequestInit) => {
          const url = extractUrl(input)
          if (url.includes('/api/oauth/usage')) {
            return Promise.resolve(
              new Response(
                JSON.stringify({
                  five_hour: { utilization: 0 },
                  seven_day: { utilization: 0 },
                }),
                { status: 200 },
              ),
            )
          }
          capturedBody = String(init?.body)
          capturedHeaders = new Headers(init?.headers)
          return Promise.resolve(new Response(null, { status: 200 }))
        },
      ),
    ) as unknown as typeof fetch

    const plugin = await getPlugin(mockClient)
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-my-access-token',
          refresh: 'refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )

    await result.fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-parent-session-id': 'parent-session' },
      body: JSON.stringify({
        system: [
          {
            type: 'text',
            text: 'Cached block',
            cache_control: { type: 'ephemeral' },
          },
        ],
        messages: [{ role: 'user', content: 'hello world test message' }],
      }),
    })

    const parsedBody = JSON.parse(capturedBody!)
    expect(parsedBody.system[2].cache_control).toEqual({ type: 'ephemeral' })
    expect(capturedHeaders?.has('x-parent-session-id')).toBe(false)
  })

  test('persistent hybrid claudeCache mode rewrites cache controls for main session requests', async () => {
    await useTempAccountFile(
      createFallbackStorage({
        accounts: [],
        claudeCache: { enabled: true, mode: 'hybrid' },
      }),
      {
        access: 'sk-ant-oat01-my-access-token',
        refresh: 'refresh',
        expires: Date.now() + 100000,
      },
    )
    let capturedBody: string | undefined
    const mockClient = createMockClient()

    globalThis.fetch = mock(
      withNativeAdmission(
        (input: string | URL | Request, init?: RequestInit) => {
          const url = extractUrl(input)
          if (url.includes('/api/oauth/usage')) {
            return Promise.resolve(
              new Response(
                JSON.stringify({
                  five_hour: { utilization: 0 },
                  seven_day: { utilization: 0 },
                }),
                { status: 200 },
              ),
            )
          }
          capturedBody = String(init?.body)
          return Promise.resolve(new Response(null, { status: 200 }))
        },
      ),
    ) as unknown as typeof fetch

    const plugin = await getPlugin(mockClient)
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-my-access-token',
          refresh: 'refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )

    await result.fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      body: JSON.stringify({
        system: [
          {
            type: 'text',
            text: 'Cached block',
            cache_control: { type: 'ephemeral' },
          },
        ],
        messages: [
          { role: 'user', content: 'Magic Context history' },
          {
            role: 'assistant',
            content: [
              {
                type: 'text',
                text: 'recent',
                cache_control: { type: 'ephemeral' },
              },
            ],
          },
          { role: 'user', content: 'follow up' },
        ],
      }),
    })

    const parsedBody = JSON.parse(capturedBody!)
    expect(parsedBody.cache_control).toBeUndefined()
    expect(parsedBody.system[2].cache_control).toEqual({
      type: 'ephemeral',
      ttl: '1h',
    })
    expect(parsedBody.messages[0].content[0].cache_control).toEqual({
      type: 'ephemeral',
      ttl: '1h',
    })
    expect(parsedBody.messages[1].content[0].cache_control).toEqual({
      type: 'ephemeral',
      ttl: '1h',
    })
  })
})

describe('cache diagnostics', () => {
  const originalFetch = globalThis.fetch
  const originalDateNow = Date.now
  const globals = globalThis as Record<symbol, unknown>
  const routingKey = Symbol.for('cortexkit.routing')

  const message = (
    id: string,
    diagnostics: unknown = { cache_miss_reason: null },
  ) => ({
    id,
    model: 'claude-opus-4-8',
    usage: {
      input_tokens: 101,
      cache_read_input_tokens: 75,
      cache_creation_input_tokens: 26,
      cache_creation: {
        ephemeral_5m_input_tokens: 20,
        ephemeral_1h_input_tokens: 6,
      },
    },
    diagnostics,
  })

  const sseResponse = (data: Record<string, unknown>, status = 200) =>
    new Response(
      `event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: data })}\n\n` +
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      { status },
    )

  const oauthLoader = () =>
    Promise.resolve({
      type: 'oauth' as const,
      access: 'sk-ant-oat01-main-access',
      refresh: 'main-refresh',
      expires: Date.now() + 100_000,
    })

  beforeEach(async () => {
    globalThis.fetch = originalFetch
    Date.now = originalDateNow
    testContext.pluginRuntimeOverrides = {
      setInterval: mock(
        () => ({ unref() {} }) as unknown as ReturnType<typeof setInterval>,
      ) as unknown as typeof setInterval,
      clearInterval: mock(() => {}) as unknown as typeof clearInterval,
    }
    resetCache1hState()
    resetDumpState()
    setLogLevel('info')
    process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION = '1'
    await useTempAccountFile(
      createFallbackStorage({ accounts: [], quota: { enabled: false } }),
    )
  })

  afterEach(async () => {
    delete globals[routingKey]
    __setLogTestSink(null)
    globalThis.fetch = originalFetch
    Date.now = originalDateNow
    testContext.pluginRuntimeOverrides = {}
    resetDumpState()
    delete process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION
    await drainSidebarWrites()
    restoreProcessTestFiles()
    // Clear testContext.tempConfigDir without deleting the account files used by plugins.
    // TestLifetime disposes those plugins and joins their work before removal.
    testContext.tempConfigDir = undefined
  })

  for (const sparse of [false, true]) {
    test(`cache diagnostics delivers the reply and links its ID ${sparse ? 'without detailed usage' : 'while the beta hash is pending'}`, async () => {
      const sentBodies: Record<string, unknown>[] = []
      const records: LogTestRecord[] = []
      const pending = Promise.withResolvers<void>()
      const hash = core.getCacheDiagnosticsBetas
      const hashSpy = sparse
        ? undefined
        : spyOn(core, 'getCacheDiagnosticsBetas').mockImplementation(
            async (headers) => {
              await pending.promise
              return hash(headers)
            },
          )
      const reply = message('provider-first')
      const { cache_creation: _omitted, ...sparseUsage } = reply.usage
      globalThis.fetch = mock(
        withNativeAdmission((_input: unknown, init: RequestInit) => {
          sentBodies.push(JSON.parse(String(init.body)))
          return Promise.resolve(
            sseResponse(sparse ? { ...reply, usage: sparseUsage } : reply),
          )
        }),
      ) as unknown as typeof fetch
      __setLogTestSink((record) => records.push(record))
      const plugin = await getPlugin()
      const result = await plugin.auth.loader(oauthLoader, { models: {} })
      setLogLevel('debug')
      const send = async () =>
        (
          await result.fetch(MESSAGES_URL, {
            method: 'POST',
            headers: { 'x-session-affinity': 'ses-diag-sparse' },
            body: JSON.stringify({
              model: 'claude-opus-4-8',
              stream: true,
              messages: [{ role: 'user', content: 'hello' }],
            }),
          })
        ).text()
      const delivered = (async () => {
        expect(await send()).toContain('provider-first')
        await send()
        return true
      })()
      const logged = () =>
        records.some((record) => record.message.startsWith('MC-CACHE-DIAG '))
      try {
        expect(
          await Promise.race([delivered, Bun.sleep(1_000).then(() => false)]),
        ).toBe(true)
        expect(sentBodies.map((body) => body.diagnostics)).toEqual([
          { previous_message_id: null },
          { previous_message_id: 'provider-first' },
        ])
        expect(logged()).toBe(false)
        if (hashSpy) {
          expect(hashSpy).toHaveBeenCalledTimes(2)
          pending.resolve()
          for (let tries = 0; tries < 100 && !logged(); tries++)
            await Bun.sleep(5)
          expect(logged()).toBe(true)
        }
      } finally {
        pending.resolve()
        await Promise.allSettled([delivered])
        hashSpy?.mockRestore()
      }
    })
  }

  test('cache diagnostics binds the provider predecessor at request time', async () => {
    const sentBodies: Record<string, unknown>[] = []
    const records: LogTestRecord[] = []
    const delayedReleases = new Map<string, () => void>()
    const delayedResponse = (providerId: string) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          return new Promise<void>((resolve) => {
            delayedReleases.set(providerId, () => {
              const payload = message(providerId)
              controller.enqueue(
                new TextEncoder().encode(
                  `event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: payload })}\n\n` +
                    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
                ),
              )
              controller.close()
              resolve()
            })
          })
        },
      })
      return new Response(body, { status: 200 })
    }
    globalThis.fetch = mock(
      withNativeAdmission((_input: any, init: RequestInit) => {
        sentBodies.push(JSON.parse(String(init.body)))
        const responsePlan = [
          ['ses-diag-A', 'provider-A'],
          ['ses-diag-B', 'provider-B'],
          ['ses-diag-A', 'provider-A-after'],
          ['ses-diag-B', 'provider-B-after'],
        ] as const
        const response = responsePlan[sentBodies.length - 1]
        if (!response) throw new Error('unexpected request')
        return Promise.resolve(
          sentBodies.length <= 2
            ? sseResponse(message(response[1]))
            : delayedResponse(response[1]),
        )
      }),
    ) as unknown as typeof fetch
    __setLogTestSink((record) => records.push(record))

    const plugin = await getPlugin(
      createMockClient([
        { info: { id: 'msg_opencode_decoy', role: 'assistant' } },
      ]),
    )
    const result = await plugin.auth.loader(oauthLoader, { models: {} })
    setLogLevel('debug')
    const request = (sessionId: string) => ({
      method: 'POST',
      headers: { 'x-session-affinity': sessionId },
      body: JSON.stringify({
        model: 'claude-opus-4-8',
        stream: true,
        messages: [{ role: 'user', content: 'hello' }],
      }),
    })

    await (await result.fetch(MESSAGES_URL, request('ses-diag-A'))).text()
    await (await result.fetch(MESSAGES_URL, request('ses-diag-B'))).text()
    const delayedA = await result.fetch(MESSAGES_URL, request('ses-diag-A'))
    const delayedB = await result.fetch(MESSAGES_URL, request('ses-diag-B'))
    delayedReleases.get('provider-A-after')?.()
    await delayedA.text()
    delayedReleases.get('provider-B-after')?.()
    await delayedB.text()

    expect(sentBodies.map((body) => body.diagnostics)).toEqual([
      { previous_message_id: null },
      { previous_message_id: null },
      { previous_message_id: 'provider-A' },
      { previous_message_id: 'provider-B' },
    ])
    const lines = records
      .filter(
        (record) =>
          record.channel === 'cache-diagnostics' &&
          record.message.startsWith('MC-CACHE-DIAG '),
      )
      .map((record) => JSON.parse(record.message.replace('MC-CACHE-DIAG ', '')))
    expect(lines).toHaveLength(4)
    expect(
      lines.find((line) => line.message_id === 'provider-A-after'),
    ).toMatchObject({
      previous_message_id: 'provider-A',
      ttl_sent: null,
      cache_read: 75,
      cache_creation: 26,
      input_tokens: 101,
      ephemeral_5m_tokens: 20,
      ephemeral_1h_tokens: 6,
      session_id: 'ses-diag-A',
      is_subagent: false,
      v: 2,
      source: 'turn',
      synthetic: false,
      account_id: 'main',
      betas_hash: expect.stringMatching(/^[0-9a-f]{16}$/),
    })
    expect(
      lines.find((line) => line.message_id === 'provider-B-after'),
    ).toMatchObject({
      previous_message_id: 'provider-B',
      session_id: 'ses-diag-B',
    })
    setLogLevel('info')
  })

  test('cache diagnostics isolates missing affinity and strips the parent header', async () => {
    const sentBodies: Record<string, unknown>[] = []
    const sentHeaders: Headers[] = []
    const records: LogTestRecord[] = []
    let requestNumber = 0
    globalThis.fetch = mock(
      withNativeAdmission((_input: any, init: RequestInit) => {
        sentBodies.push(JSON.parse(String(init.body)))
        sentHeaders.push(new Headers(init.headers))
        requestNumber++
        return Promise.resolve(
          sseResponse(message(`provider-${requestNumber}`)),
        )
      }),
    ) as unknown as typeof fetch
    __setLogTestSink((record) => records.push(record))

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(oauthLoader, { models: {} })
    setLogLevel('debug')
    const body = JSON.stringify({
      model: 'claude-opus-4-8',
      stream: true,
      messages: [{ role: 'user', content: 'hello' }],
    })
    await (
      await result.fetch(MESSAGES_URL, {
        method: 'POST',
        headers: { 'x-parent-session-id': 'parent-1' },
        body,
      })
    ).text()
    await (await result.fetch(MESSAGES_URL, { method: 'POST', body })).text()

    expect(sentBodies.map((entry) => entry.diagnostics)).toEqual([
      { previous_message_id: null },
      { previous_message_id: null },
    ])
    expect(sentHeaders[0]?.has('x-parent-session-id')).toBe(false)
    const lines = records
      .filter(
        (record) =>
          record.channel === 'cache-diagnostics' &&
          record.message.startsWith('MC-CACHE-DIAG '),
      )
      .map((record) => JSON.parse(record.message.replace('MC-CACHE-DIAG ', '')))
    expect(lines).toHaveLength(2)
    expect(lines[0]).toMatchObject({
      session_id: 'session-unknown',
      is_subagent: true,
    })
    expect(lines[1]).toMatchObject({
      session_id: 'session-unknown',
      is_subagent: false,
    })
    setLogLevel('info')
  })

  test('cache diagnostics emits the opt-in beta for normal and structured OAuth requests', async () => {
    const sentBodies: Record<string, unknown>[] = []
    const betaHeaders: string[] = []
    const records: LogTestRecord[] = []
    globalThis.fetch = mock(
      withNativeAdmission((_input: any, init: RequestInit) => {
        sentBodies.push(JSON.parse(String(init.body)))
        betaHeaders.push(new Headers(init.headers).get('anthropic-beta') ?? '')
        return Promise.resolve(
          sseResponse(message(`provider-${sentBodies.length}`)),
        )
      }),
    ) as unknown as typeof fetch
    __setLogTestSink((record) => records.push(record))

    const mockClient = createMockClient()
    const plugin = await getPlugin(mockClient, testContext.tempConfigDir)
    const result = await plugin.auth.loader(oauthLoader, { models: {} })
    expect(
      (
        await applyMenuAction(plugin, 'session-cache-diagnostics', {
          sectionId: 'Diagnostics',
          actionId: 'logging-level',
          values: { level: 'debug' },
        })
      ).ok,
    ).toBe(true)
    for (const output_config of [
      undefined,
      { format: { type: 'json_schema' } },
    ]) {
      await (
        await result.fetch(MESSAGES_URL, {
          method: 'POST',
          body: JSON.stringify({
            model: 'claude-opus-4-8',
            stream: true,
            messages: [{ role: 'user', content: 'hello' }],
            ...(output_config ? { output_config } : {}),
          }),
        })
      ).text()
    }

    expect(sentBodies.map((body) => body.diagnostics)).toEqual([
      { previous_message_id: null },
      { previous_message_id: null },
    ])
    expect(
      betaHeaders.every((beta) => beta.includes('cache-diagnosis-2026-04-07')),
    ).toBe(true)
    const betaLines = records
      .filter(
        (record) =>
          record.channel === 'cache-diagnostics' &&
          record.message.startsWith('MC-CACHE-DIAG-BETAS '),
      )
      .map((record) =>
        JSON.parse(record.message.replace('MC-CACHE-DIAG-BETAS ', '')),
      )
    expect(betaLines).toHaveLength(2)
    expect(new Set(betaLines.map((line) => line.hash)).size).toBe(2)
    expect(
      records
        .filter(
          (record) =>
            record.channel === 'cache-diagnostics' &&
            record.message.startsWith('MC-CACHE-DIAG'),
        )
        .map((record) => record.level),
    ).toEqual(['debug', 'debug', 'debug', 'debug'])
    setLogLevel('info')
  })

  test('cache diagnostics observes non-streaming envelopes and carries their provider id forward', async () => {
    const sentBodies: Record<string, unknown>[] = []
    const records: LogTestRecord[] = []
    globalThis.fetch = mock(
      withNativeAdmission((_input: any, init: RequestInit) => {
        sentBodies.push(JSON.parse(String(init.body)))
        const id =
          sentBodies.length === 1 ? 'provider-json-A' : 'provider-json-B'
        return Promise.resolve(
          new Response(JSON.stringify(message(id)), { status: 200 }),
        )
      }),
    ) as unknown as typeof fetch
    __setLogTestSink((record) => records.push(record))

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(oauthLoader, { models: {} })
    setLogLevel('debug')
    const request = {
      method: 'POST',
      headers: { 'x-session-affinity': 'ses-json' },
      body: JSON.stringify({
        model: 'claude-opus-4-8',
        stream: false,
        messages: [{ role: 'user', content: 'hello' }],
      }),
    }
    await (await result.fetch(MESSAGES_URL, request)).text()
    await (await result.fetch(MESSAGES_URL, request)).text()

    expect(sentBodies[1]?.diagnostics).toEqual({
      previous_message_id: 'provider-json-A',
    })
    expect(
      records.filter(
        (record) =>
          record.channel === 'cache-diagnostics' &&
          record.message.startsWith('MC-CACHE-DIAG '),
      ),
    ).toHaveLength(2)
    setLogLevel('info')
  })

  test('an OpenCode 1 prewarm preserves thinking block binding and carries its beta', async () => {
    const reports: Record<string, unknown>[] = []
    globals[routingKey] = () => ({
      report: (report: Record<string, unknown>) => {
        if (report.kind === 'billing') reports.push(report)
      },
    })
    let now = 1_000
    Date.now = mock(() => now) as unknown as typeof Date.now
    await useTempAccountFile(
      createFallbackStorage({
        accounts: [],
        quota: { enabled: false },
        claudeCache: { enabled: true, mode: 'hybrid' },
        cacheKeep: { enabled: true, always: true },
        thinkingBinding: { prefixMismatchBehavior: 'drop_block' },
      }),
    )
    const sent: Array<{ headers: Headers; body: Record<string, any> }> = []
    globalThis.fetch = mock(
      withNativeAdmission((_input: any, init: RequestInit) => {
        const body = JSON.parse(String(init.body))
        sent.push({ headers: new Headers(init.headers), body })
        return Promise.resolve(
          body.max_tokens === 0
            ? Response.json(message('provider-thinking-warm'))
            : new Response(
                `event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: message('provider-thinking-live') })}\n\n` +
                  'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":2}}\n\n' +
                  'event: message_stop\ndata: {"type":"message_stop"}\n\n',
                { headers: { 'content-type': 'text/event-stream' } },
              ),
        )
      }),
    ) as unknown as typeof fetch
    const plugin = await getPlugin()
    const result = await plugin.auth.loader(oauthLoader, { models: {} })
    await (
      await result.fetch(MESSAGES_URL, {
        method: 'POST',
        headers: { 'x-session-affinity': 'ses-thinking-binding-warm' },
        body: JSON.stringify({
          model: 'claude-fable-5-2',
          stream: true,
          thinking: { type: 'adaptive', display: 'summarized' },
          messages: [
            { role: 'user', content: 'first' },
            {
              role: 'assistant',
              content: [
                {
                  type: 'thinking',
                  thinking: 'reasoning',
                  signature: 'signature',
                },
                { type: 'text', text: 'answer' },
              ],
            },
            { role: 'user', content: 'continue' },
          ],
        }),
      })
    ).text()
    expect(sent).toHaveLength(1)
    const live = sent[0]!
    expect(live.body.thinking.block_binding).toEqual({
      prefix_mismatch_behavior: 'drop_block',
    })
    now += 55 * 60_000
    await getPluginTestHandles(plugin).cacheKeepManager.tick()
    expect(sent).toHaveLength(2)
    const warm = sent[1]!
    expect(warm.body.max_tokens).toBe(0)
    expect(warm.body.thinking).toEqual(live.body.thinking)
    expect(warm.body.messages).toEqual(live.body.messages)
    for (const request of [live, warm]) {
      expect(request.body).not.toHaveProperty('fallbacks')
      expect(request.headers.get('anthropic-beta')?.split(',')).toContain(
        core.SERVER_SIDE_FALLBACK_BETA,
      )
    }
    expect(warm.headers.get('anthropic-beta')?.split(',')).toContain(
      'thinking-binding-controls-2026-08-01',
    )
    await Bun.sleep(10)
    expect(reports).toHaveLength(2)
    expect(reports).toContainEqual(
      expect.objectContaining({
        account_id: syntheticMainAccountUuid,
        request_kind: 'keep_warm',
        provider_response_id: 'provider-thinking-warm',
        outcome: 'completed',
        usage: expect.objectContaining({ input: 101, cache_read: 75 }),
        cache: expect.objectContaining({ warming: { on: true } }),
      }),
    )
    expect(reports).toContainEqual(
      expect.objectContaining({
        account_id: syntheticMainAccountUuid,
        request_kind: 'primary',
        provider_response_id: 'provider-thinking-live',
        cache: expect.objectContaining({ warming: { on: true } }),
      }),
    )
  })

  test('OC1 CacheKeep prewarms stay out of the cache diagnostics chain', async () => {
    let now = 1_000
    const sent: Array<{ body: Record<string, unknown>; betas: string[] }> = []
    const records: LogTestRecord[] = []
    Date.now = mock(() => now) as unknown as typeof Date.now
    await useTempAccountFile(
      createFallbackStorage({
        accounts: [],
        quota: { enabled: false },
        claudeCache: { enabled: true, mode: 'hybrid' },
        cacheKeep: { enabled: true, always: true, subagents: true },
      }),
    )
    let normalRequests = 0
    globalThis.fetch = mock(
      withNativeAdmission((_input: any, init: RequestInit) => {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>
        const betas = (new Headers(init.headers).get('anthropic-beta') ?? '')
          .split(',')
          .map((beta) => beta.trim())
        sent.push({ body, betas })
        if (body.max_tokens === 0) {
          return Promise.resolve(
            new Response(JSON.stringify(message('provider-warm-B')), {
              status: 200,
            }),
          )
        }
        normalRequests++
        return Promise.resolve(
          sseResponse(
            message(
              normalRequests === 1 ? 'provider-real-A' : 'provider-real-C',
            ),
          ),
        )
      }),
    ) as unknown as typeof fetch
    __setLogTestSink((record) => records.push(record))

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(oauthLoader, { models: {} })
    setLogLevel('debug')
    const request = {
      method: 'POST',
      headers: { 'x-session-affinity': 'ses-cachekeep' },
      body: JSON.stringify({
        model: 'claude-opus-4-8',
        stream: true,
        messages: [{ role: 'user', content: 'hello' }],
      }),
    }
    await (await result.fetch(MESSAGES_URL, request)).text()
    now += 55 * 60_000
    await getPluginTestHandles(plugin).cacheKeepManager.tick()
    await (await result.fetch(MESSAGES_URL, request)).text()

    const warms = sent.filter(({ body }) => body.max_tokens === 0)
    expect(warms).toHaveLength(1)
    const diagnosticBeta = 'cache-diagnosis-2026-04-07'
    expect(sent[0]?.betas).toContain(diagnosticBeta)
    expect(sent[0]?.body.diagnostics).toEqual({ previous_message_id: null })
    expect(sent.at(-1)?.betas).toContain(diagnosticBeta)
    const logged = records
      .filter((record) => record.message.startsWith('MC-CACHE-DIAG '))
      .map((record) => record.message)
    expect(logged.some((record) => record.includes('provider-real-A'))).toBe(
      true,
    )
    expect({
      warmDiagnostics: warms[0]?.body.diagnostics,
      warmOptIn: warms[0]?.betas.includes(diagnosticBeta),
      nextDiagnostics: sent.at(-1)?.body.diagnostics,
      warmRecords: logged.filter((record) =>
        record.includes('prewarm_cachekeep'),
      ),
    }).toEqual({
      warmDiagnostics: undefined,
      warmOptIn: false,
      nextDiagnostics: { previous_message_id: 'provider-real-A' },
      warmRecords: [],
    })
    setLogLevel('info')
  })

  test('cache diagnostics logs a short-gap previous-message canary but not unavailable', async () => {
    const records: LogTestRecord[] = []
    let now = 1_000
    Date.now = mock(() => now) as unknown as typeof Date.now
    const responses = [
      message('provider-canary-A'),
      message('provider-canary-B', {
        cache_miss_reason: { type: 'previous_message_not_found' },
      }),
      message('provider-canary-C', {
        cache_miss_reason: { type: 'unavailable' },
      }),
      message('provider-canary-D', {
        cache_miss_reason: { type: 'previous_message_not_found' },
      }),
    ]
    globalThis.fetch = mock(
      withNativeAdmission(() => {
        const response = responses.shift()
        if (!response) throw new Error('unexpected request')
        return Promise.resolve(sseResponse(response))
      }),
    ) as unknown as typeof fetch
    __setLogTestSink((record) => records.push(record))

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(oauthLoader, { models: {} })
    const request = {
      method: 'POST',
      headers: { 'x-session-affinity': 'ses-canary' },
      body: JSON.stringify({
        model: 'claude-opus-4-8',
        stream: true,
        messages: [{ role: 'user', content: 'hello' }],
      }),
    }
    await (await result.fetch(MESSAGES_URL, request)).text()
    now += 299_999
    await (await result.fetch(MESSAGES_URL, request)).text()
    now += 300_000
    await (await result.fetch(MESSAGES_URL, request)).text()
    now += 300_000
    await (await result.fetch(MESSAGES_URL, request)).text()

    const warnings = records.filter(
      (record) =>
        record.level === 'warn' && record.channel === 'cache-diagnostics',
    )
    expect(warnings).toHaveLength(1)
    expect(warnings[0]?.payload).toMatchObject({
      message_id: 'provider-canary-B',
      previous_message_id: 'provider-canary-A',
    })
  })

  test('cache diagnostics stays disabled on API-key fallback while preserving its response artifact', async () => {
    const originalDumpDir = process.env.OPENCODE_ANTHROPIC_AUTH_DUMP_DIR
    const dumpDir = await mkdtemp(join(tmpdir(), 'cache-diagnostics-api-dump-'))
    process.env.OPENCODE_ANTHROPIC_AUTH_DUMP_DIR = dumpDir
    try {
      await useTempAccountFile(
        bindPoolAccounts(
          createFallbackStorage({
            dump: { enabled: true },
            quota: {
              enabled: true,
              checkIntervalMinutes: 5,
              minimumRemaining: { five_hour: 10, seven_day: 20 },
              failClosedOnUnknownQuota: true,
              mainQuota: {
                checkedAt: Date.now(),
                five_hour: {
                  usedPercent: 100,
                  remainingPercent: 0,
                  checkedAt: Date.now(),
                },
                seven_day: {
                  usedPercent: 50,
                  remainingPercent: 50,
                  checkedAt: Date.now(),
                },
              },
              mainQuotaCheckedAt: Date.now(),
              mainQuotaToken: tokenFingerprint('sk-ant-oat01-main-access'),
            } as AccountStorage['quota'],
            accounts: [
              {
                id: 'kie-opus',
                type: 'api',
                apiKey: 'kie-key',
                baseURL: 'https://api.kie.ai/claude',
                authHeader: 'authorization-bearer',
              },
            ],
          }),
        ),
      )
      const records: LogTestRecord[] = []
      let sentBody: Record<string, unknown> | undefined
      let sentBeta = ''
      globalThis.fetch = mock(
        withNativeAdmission(
          (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
            expect(extractUrl(input)).toBe(
              'https://api.kie.ai/claude/v1/messages?beta=true',
            )
            expect(new Headers(init?.headers).get('authorization')).toBe(
              'Bearer kie-key',
            )
            sentBody = JSON.parse(String(init?.body))
            sentBeta = new Headers(init?.headers).get('anthropic-beta') ?? ''
            return Promise.resolve(sseResponse(message('provider-api')))
          },
        ),
      ) as unknown as typeof fetch
      __setLogTestSink((record) => records.push(record))

      expect((await readAccountStorage())?.dump?.enabled).toBe(true)
      const plugin = await getPlugin()
      expect(isDumpEnabled()).toBe(true)
      const result = await plugin.auth.loader(oauthLoader, { models: {} })
      const response = await result.fetch(MESSAGES_URL, {
        method: 'POST',
        headers: { 'x-session-affinity': 'ses-api' },
        body: JSON.stringify({
          model: 'claude-opus-4-8',
          stream: true,
          messages: [{ role: 'user', content: 'hello' }],
        }),
      })
      expect(response.status).toBe(200)
      await response.text()

      expect(sentBody).toBeDefined()
      expect(isDumpEnabled()).toBe(true)
      expect(getDumpDirectory()).toBe(dumpDir)
      expect(sentBody?.diagnostics).toBeUndefined()
      expect(sentBeta).not.toContain('cache-diagnosis-2026-04-07')
      expect(
        records.filter((record) => record.channel === 'cache-diagnostics'),
      ).toHaveLength(0)
      for (let attempt = 0; attempt < 50; attempt++) {
        if (
          (await readdir(dumpDir)).some((file) =>
            file.endsWith('.response.json'),
          )
        )
          break
        await Bun.sleep(10)
      }
      const responseFile = (await readdir(dumpDir)).find((file) =>
        file.endsWith('.response.json'),
      )
      expect(responseFile).toBeString()
      expect(
        JSON.parse(await readFile(join(dumpDir, responseFile!), 'utf8')),
      ).toMatchObject({
        status: 200,
        message_id: 'provider-api',
      })
    } finally {
      if (originalDumpDir === undefined) {
        delete process.env.OPENCODE_ANTHROPIC_AUTH_DUMP_DIR
      } else {
        process.env.OPENCODE_ANTHROPIC_AUTH_DUMP_DIR = originalDumpDir
      }
      await rm(dumpDir, { recursive: true, force: true })
    }
  })

  test('cache diagnostics writes sanitized response artifacts for valid and malformed direct responses', async () => {
    const originalDumpDir = process.env.OPENCODE_ANTHROPIC_AUTH_DUMP_DIR
    const dumpDir = await mkdtemp(
      join(tmpdir(), 'cache-diagnostics-dump-test-'),
    )
    process.env.OPENCODE_ANTHROPIC_AUTH_DUMP_DIR = dumpDir
    try {
      await useTempAccountFile(
        createFallbackStorage({
          accounts: [],
          quota: { enabled: false },
          dump: { enabled: true },
        }),
      )
      const responses = [
        sseResponse({
          ...message('provider-dump'),
          content: [{ text: 'secret' }],
        }),
        new Response('not an envelope', { status: 503 }),
      ]
      globalThis.fetch = mock(
        withNativeAdmission(() => {
          const response = responses.shift()
          if (!response) throw new Error('unexpected request')
          return Promise.resolve(response)
        }),
      ) as unknown as typeof fetch

      const plugin = await getPlugin()
      const result = await plugin.auth.loader(oauthLoader, { models: {} })
      const request = {
        method: 'POST',
        headers: { 'x-session-affinity': 'ses-dump' },
        body: JSON.stringify({
          model: 'claude-opus-4-8',
          stream: true,
          messages: [{ role: 'user', content: 'hello' }],
        }),
      }
      await (await result.fetch(MESSAGES_URL, request)).text()
      await (await result.fetch(MESSAGES_URL, request)).text()

      let responseFiles: string[] = []
      for (let attempt = 0; attempt < 50; attempt++) {
        responseFiles = (await readdir(dumpDir)).filter((file) =>
          file.endsWith('.response.json'),
        )
        if (responseFiles.length === 2) break
        await Bun.sleep(10)
      }
      expect(responseFiles).toHaveLength(2)
      const artifacts = await Promise.all(
        responseFiles.map(async (file) =>
          JSON.parse(await readFile(join(dumpDir, file), 'utf8')),
        ),
      )
      expect(artifacts).toContainEqual(
        expect.objectContaining({
          status: 200,
          message_id: 'provider-dump',
          stream_complete: false,
        }),
      )
      expect(artifacts).toContainEqual({ status: 503, stream_complete: false })
      expect(JSON.stringify(artifacts)).not.toContain('secret')
    } finally {
      if (originalDumpDir === undefined) {
        delete process.env.OPENCODE_ANTHROPIC_AUTH_DUMP_DIR
      } else {
        process.env.OPENCODE_ANTHROPIC_AUTH_DUMP_DIR = originalDumpDir
      }
      await rm(dumpDir, { recursive: true, force: true })
    }
  })
})
