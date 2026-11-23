import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import {
  __setLogTestSink,
  type AccountStorage,
  getLogLevel,
  LANE_START_TEXT,
  PROMPT_CACHE_DEFAULT_TTL_MS,
  PrimeManager,
  primeAccountMarkerDir,
  primeMarkerPath,
  resolveNativePoolPaths,
  StickySessionRouter,
  sessionCacheActivity,
  setLogLevel,
  signRequestBody,
  stickyRouteFamilyForModel,
  tokenFingerprint,
} from '@cortexkit/anthropic-auth-core'
import {
  type ExtensionAPI,
  type ExtensionCommandContext,
  SessionManager,
} from '@earendil-works/pi-coding-agent'
import cortexKitPiAnthropicAuth from '../index.ts'
import { closePiNativeRuntime, getPiNativeRuntime } from '../native.ts'
import { createPiNativeCommands } from '../native-commands.ts'
import {
  beginPiPrimaryTurn,
  endPiPrimaryTurn,
  getPiTrackedCacheKeepSessions,
  sendPiPrimeRequest,
  streamCortexKitAnthropic,
} from '../stream.ts'
import { saveNativePiFixture } from './native-fixture.ts'

const originalFetch = globalThis.fetch
const envKeys = [
  'PI_CODING_AGENT_DIR',
  'PI_ANTHROPIC_AUTH_FILE',
  'OPENCODE_ANTHROPIC_AUTH_STATE_FILE',
]
let previousEnv: Array<string | undefined>
let directory: string
let storagePath: string
let markerDir: string
let now: number
let sends: Array<{ headers: Headers; text: string }>
let polls: number
let quotaResponse: () => Promise<Response>
const intervals = new Set<ReturnType<typeof setInterval>>()
const timeouts = new Map<
  ReturnType<typeof setTimeout>,
  { callback: () => void; ms?: number }
>()
const schedule = ((_callback: () => void) => {
  const timer = { unref() {} } as ReturnType<typeof setInterval>
  intervals.add(timer)
  return timer
}) as typeof setInterval
const cancel = ((timer: ReturnType<typeof setInterval>) => {
  intervals.delete(timer)
}) as typeof clearInterval
const later = ((callback: () => void, ms?: number) => {
  const timer = { unref() {} } as ReturnType<typeof setTimeout>
  timeouts.set(timer, { callback, ms })
  return timer
}) as typeof setTimeout
const cancelLater = ((timer: ReturnType<typeof setTimeout>) => {
  timeouts.delete(timer)
}) as typeof clearTimeout

function quota(remaining = 100) {
  return {
    five_hour: {
      utilization: 100 - remaining,
      resets_at: new Date(now - 120_000).toISOString(),
    },
    seven_day: {
      utilization: 0,
      resets_at: new Date(now + 604_800_000).toISOString(),
    },
  }
}

beforeEach(async () => {
  previousEnv = envKeys.map((key) => process.env[key])
  directory = await mkdtemp(join(tmpdir(), 'pi-prime-'))
  storagePath = join(directory, 'accounts.json')
  markerDir = join(directory, 'markers')
  await mkdir(markerDir)
  process.env.PI_ANTHROPIC_AUTH_FILE = storagePath
  now = Date.now()
  sends = []
  polls = 0
  quotaResponse = async () => Response.json(quota())
  globalThis.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const request =
        input instanceof Request
          ? new Request(input, init)
          : new Request(String(input), init)
      if (request.url.includes('/api/oauth/usage')) {
        polls++
        return quotaResponse()
      }
      expect(request.url).toBe(
        'https://api.anthropic.com/v1/messages?beta=true',
      )
      expect(request.redirect).toBe('error')
      const bytes = Buffer.from(await request.arrayBuffer())
      const text = (
        request.headers.get('content-encoding') === 'gzip'
          ? gunzipSync(bytes)
          : bytes
      ).toString()
      sends.push({ headers: request.headers, text })
      if (JSON.parse(text).stream) {
        return new Response(
          [
            {
              type: 'message_start',
              message: {
                id: `msg_pi_lane_${sends.length}`,
                model: JSON.parse(text).model,
                diagnostics: null,
                usage: {
                  input_tokens: 1,
                  cache_read_input_tokens: 0,
                  cache_creation_input_tokens: 0,
                  cache_creation: {
                    ephemeral_5m_input_tokens: 0,
                    ephemeral_1h_input_tokens: 0,
                  },
                },
              },
            },
            { type: 'message_stop' },
          ]
            .map((event) => `data: ${JSON.stringify(event)}\n\n`)
            .join(''),
          {
            headers: {
              'content-type': 'text/event-stream',
              'request-id': `req_lane_test_${sends.length}`,
            },
          },
        )
      }
      return Response.json({ usage: { input_tokens: 17, output_tokens: 1 } })
    },
    { preconnect: originalFetch.preconnect },
  )
})

afterEach(async () => {
  await closePiNativeRuntime(storagePath)
  globalThis.fetch = originalFetch
  envKeys.forEach((key, index) => {
    const value = previousEnv[index]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  })
  intervals.clear()
  timeouts.clear()
  await rm(directory, { recursive: true, force: true })
})

async function fixture(enabled = true, extra: Partial<AccountStorage> = {}) {
  await saveNativePiFixture(
    {
      version: 1,
      accounts: [],
      prime: { enabled },
      quota: {
        enabled: true,
        mainQuota: {
          source: 'poll',
          checkedAt: now,
          five_hour: {
            usedPercent: 100,
            remainingPercent: 0,
            checkedAt: now,
            resetsAt: new Date(now - 120_000).toISOString(),
          },
        },
      },
      ...extra,
    },
    storagePath,
  )
  const native = getPiNativeRuntime(storagePath, {
    vaultPoll: { intervalMs: 0 },
    prime: {
      markerDir,
      now: () => now,
      setIntervalImpl: schedule,
      clearIntervalImpl: cancel,
      setTimeoutImpl: later,
      clearTimeoutImpl: cancelLater,
    },
  })
  await native.service()
  return native
}

test('Pi Prime enabled with a due account fires once through the signed model transport', async () => {
  const native = await fixture()
  const identity = (await native.view()).accounts.find(
    (row) => row.id === 'main',
  )?.accountIdentity
  expect(identity).toBeString()
  expect(await native.prime?.manager.options.getAccountIdentity?.('main')).toBe(
    identity,
  )
  await native.prime?.manager.tick()
  await native.prime?.manager.tick()
  expect(sends).toHaveLength(1)
  expect(polls).toBe(1)
  const sent = sends[0]!
  const body = JSON.parse(sent.text)
  expect(body).toMatchObject({
    model: 'claude-haiku-4-5',
    max_tokens: 1,
    messages: [{ role: 'user', content: '0' }],
  })
  expect(body.system).toContainEqual({
    type: 'text',
    text: 'Reply with 1 when you receive 0.',
  })
  expect(body.system[0].text).toContain('x-anthropic-billing-header:')
  expect(body.system[0].text).not.toContain('cch=00000')
  expect(await signRequestBody(sent.text)).toBe(sent.text)
  expect(body.stream).toBeUndefined()
  expect(body.cache_control).toBeUndefined()
  expect(body.metadata.user_id).toBeString()
  expect(sent.headers.get('authorization')).toBe(
    'Bearer sk-ant-oat01-main-access',
  )
  expect(sent.headers.get('x-api-key')).toBeNull()
  expect(sent.headers.get('x-claude-code-request-class')).toBe('auxiliary')
  expect(await getPiTrackedCacheKeepSessions()).toEqual([])
  const status = await createPiNativeCommands(storagePath).readStatus(
    'prime',
    {},
  )
  expect(status).toContain('next prime')
  expect(status).toContain('primed')
  expect(status).toContain('1 prime')
  expect(
    (await native.view()).accounts.find((row) => row.id === 'main')?.prime,
  ).toMatchObject({ count: 1, inputTokens: 17, outputTokens: 1 })
  expect([...timeouts.values()].map((timer) => timer.ms)).toEqual([90_000])
})

test('Pi /claude queues lane start as a visible turn that warms the session cache', async () => {
  const native = await fixture(false, {
    routing: { mode: 'sticky-balanced' },
    accounts: [
      {
        id: 'fallback',
        type: 'oauth',
        access: 'sk-ant-oat01-fallback-access',
        refresh: 'fallback-refresh',
        expires: now + 3_600_000,
      },
    ],
  })
  const modelId = 'claude-sonnet-5-5'
  const transcript = SessionManager.create(
    directory,
    join(directory, 'transcripts'),
  )
  const sessionId = transcript.getSessionId()
  const router = new StickySessionRouter({ path: await native.routingPath() })
  expect(
    await router.resolve({
      sessionId,
      modelId,
      family: stickyRouteFamilyForModel(modelId),
      affinityModelId: modelId,
      candidates: [
        { accountId: 'fallback', order: 1, quota: { kind: 'unknown' } },
      ],
      retainAccountIds: new Set(['fallback']),
      inputBytes: 1,
      storage: (await native.view()).policyStorage,
    }),
  ).toMatchObject({ accountId: 'fallback' })
  await router.drain()

  const commands = new Map<
    string,
    Parameters<ExtensionAPI['registerCommand']>[1]
  >()
  const queued: Parameters<ExtensionAPI['sendUserMessage']>[] = []
  const handlers = new Map<
    string,
    (event: unknown, context: unknown) => Promise<void>
  >()
  await cortexKitPiAnthropicAuth({
    on: (
      name: string,
      handler: (event: unknown, context: unknown) => Promise<void>,
    ) => handlers.set(name, handler),
    registerProvider() {},
    registerCommand: (
      name: string,
      definition: Parameters<ExtensionAPI['registerCommand']>[1],
    ) => commands.set(name, definition),
    sendUserMessage: (...args: Parameters<ExtensionAPI['sendUserMessage']>) => {
      queued.push(args)
    },
  } as unknown as ExtensionAPI)
  async function invoke(model?: ExtensionCommandContext['model']) {
    const notices: string[] = []
    let picked = false
    await commands.get('claude')?.handler('', {
      model,
      hasUI: true,
      sessionManager: transcript,
      ui: {
        notify: (text: string) => notices.push(text),
        async select(title: string, choices: string[]) {
          if (picked) return undefined
          if (title === 'Claude')
            return choices.find((choice) => choice.startsWith('Extras'))
          picked = true
          return choices.find((choice) => choice === 'Fire lane start')
        },
      },
    } as unknown as ExtensionCommandContext)
    return notices.join('\n')
  }

  const refusal = await invoke()
  expect(refusal).toBeTruthy()
  expect(refusal).not.toContain('Claude lane start queued in this session.')
  expect(queued).toHaveLength(0)
  expect(sends).toHaveLength(0)

  const model: NonNullable<ExtensionCommandContext['model']> = {
    id: modelId,
    name: 'Claude Sonnet 5.5',
    api: 'anthropic-messages',
    provider: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    reasoning: true,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 64_000,
  }
  const notice = await invoke(model)
  const marker = LANE_START_TEXT
  expect(queued).toEqual([
    [
      expect.stringMatching(
        /^\[lane start\].*\n\[cortexkit lane start: [\da-f-]+\]$/,
      ),
      { deliverAs: 'followUp' },
    ],
  ])
  expect(sends).toHaveLength(0)
  expect(notice).toContain('Claude lane start queued in this session.')

  const first = {
    role: 'user',
    content: 'Earlier session prompt',
    timestamp: now,
  } as const
  const lane = {
    role: 'user',
    content: [{ type: 'text', text: queued[0]![0] as string }],
    timestamp: now + 2,
  } satisfies Parameters<typeof streamCortexKitAnthropic>[1]['messages'][number]
  const typed = { role: 'user', content: marker, timestamp: now + 1 } as const
  const next = {
    role: 'user',
    content: 'Now answer my question',
    timestamp: now + 3,
  } as const
  async function runTurn(
    messages: Parameters<typeof streamCortexKitAnthropic>[1]['messages'],
    newUser = messages.at(-1),
  ) {
    if (newUser?.role === 'user') {
      await handlers.get('message_start')?.(
        { message: newUser },
        { sessionManager: transcript },
      )
      transcript.appendMessage(newUser)
    }
    const result = await streamCortexKitAnthropic(
      model,
      { messages: structuredClone(messages) },
      { sessionId, maxTokens: 123 },
      undefined,
      undefined,
      'agent-loop',
    ).result()
    expect(result.stopReason).toBe('stop')
  }
  const records: string[] = []
  const level = getLogLevel()
  setLogLevel('debug')
  __setLogTestSink(({ message }) => records.push(message))
  beginPiPrimaryTurn(storagePath, sessionId)
  try {
    await runTurn([first, typed])
    const human = JSON.parse(sends[0]!.text)
    expect(human.max_tokens).toBe(123)
    expect(human.thinking).toBeDefined()
    expect(human.system[0].text).toContain('cc_prompt_index=2;')

    await runTurn([first, typed, lane])
    expect(sends).toHaveLength(2)
    const sent = sends[1]!
    expect(sent.headers.get('authorization')).toBe(
      'Bearer sk-ant-oat01-fallback-access',
    )
    const body = JSON.parse(sent.text)
    expect(body).toMatchObject({ model: modelId, max_tokens: 1 })
    expect(body.messages).toHaveLength(3)
    expect(body.messages[0]).toMatchObject({
      role: 'user',
      content: first.content,
    })
    expect(body.messages[1]).toMatchObject({
      role: 'user',
      content: marker,
    })
    expect(body.messages[2]).toMatchObject({
      role: 'user',
      content: [
        { type: 'text', text: marker, cache_control: { type: 'ephemeral' } },
      ],
    })
    // Pi appends the live message after message_start and clones it for the provider.
    const persisted = await readFile(transcript.getSessionFile()!, 'utf8')
    expect(persisted).not.toContain('cortexkit lane start:')
    expect(
      JSON.parse(persisted.trimEnd().split('\n').at(-1)!).message.content,
    ).toEqual([{ type: 'text', text: marker }])
    expect(sent.text).not.toContain('cortexkit lane start:')
    expect(body.system[0].text).not.toMatch(/cc_(?:prompt_id|prev_req)=/)
    expect(body.thinking).toBeUndefined()
    expect(await signRequestBody(sent.text)).toBe(sent.text)
    expect(sessionCacheActivity.ttlMs(sessionId)).toBe(
      PROMPT_CACHE_DEFAULT_TTL_MS,
    )

    await runTurn([
      first,
      typed,
      lane,
      {
        role: 'assistant',
        content: [
          { type: 'toolCall', id: 'tool_lane', name: 'read', arguments: {} },
        ],
      } as Parameters<typeof streamCortexKitAnthropic>[1]['messages'][number],
      {
        role: 'toolResult',
        toolCallId: 'tool_lane',
        toolName: 'read',
        content: [{ type: 'text', text: 'Tool reply' }],
        isError: false,
        timestamp: now + 3,
      },
    ])
    const toolStep = JSON.parse(sends[2]!.text)
    expect(toolStep.max_tokens).toBe(123)
    expect(toolStep.thinking).toBeDefined()
    expect(toolStep.system[0].text).not.toMatch(/cc_(?:prompt_id|prev_req)=/)

    await runTurn([first, typed, lane, next])
    expect(sends).toHaveLength(4)
    const following = JSON.parse(sends[3]!.text)
    expect(following.max_tokens).toBe(123)
    expect(following.thinking).toBeDefined()
    expect(following.messages[0]).toEqual(body.messages[0])
    expect(following.messages[2]).toMatchObject({
      role: 'user',
      content: marker,
    })
    expect(following.system[0].text).toContain('cc_prev_req=req_lane_test_1;')
    expect(following.system[0].text).toContain('cc_prompt_index=3;')
    expect(
      records
        .filter((message) => message.startsWith('MC-CACHE-DIAG '))
        .map((message) => JSON.parse(message.slice('MC-CACHE-DIAG '.length)))
        .find((record) => record.message_id === 'msg_pi_lane_2'),
    ).toMatchObject({ source: 'start', synthetic: true })
  } finally {
    endPiPrimaryTurn(storagePath, sessionId, true)
    __setLogTestSink(null)
    setLogLevel(level)
    sessionCacheActivity.forget(sessionId)
  }
  expect((await native.view()).policyStorage.prime?.enabled).toBe(false)
})

test('Pi Prime disabled never polls or sends, and the menu enables it live', async () => {
  const native = await fixture(false)
  await native.prime?.manager.tick()
  expect(sends).toHaveLength(0)
  expect(polls).toBe(0)
  expect(await readdir(markerDir, { recursive: true })).toEqual([])
  await createPiNativeCommands(storagePath).dispatch(
    { action: 'prime-on', values: {} },
    {},
  )
  await native.prime?.manager.tick()
  expect(sends).toHaveLength(1)
})

test('Pi Prime toggling off during the fresh quota check aborts before claim or send', async () => {
  const native = await fixture()
  let entered!: () => void
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  quotaResponse = async () => {
    entered()
    await gate
    return Response.json(quota())
  }
  const tick = native.prime!.manager.tick()
  try {
    await started
    await createPiNativeCommands(storagePath).dispatch(
      { action: 'prime-off', values: {} },
      {},
    )
  } finally {
    release()
    await tick
  }
  expect(sends).toHaveLength(0)
  expect(await readdir(markerDir, { recursive: true })).toEqual([])
})

test('Pi Prime toggling off during model authorization aborts before physical send', async () => {
  const native = await fixture()
  let entered!: () => void
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const authorize = native.authorize.bind(native)
  const spy = spyOn(native, 'authorize').mockImplementation(async (...args) => {
    const admitted = await authorize(...args)
    entered()
    await gate
    return admitted
  })
  const tick = native.prime!.manager.tick()
  try {
    await started
    await createPiNativeCommands(storagePath).dispatch(
      { action: 'prime-off', values: {} },
      {},
    )
  } finally {
    release()
    await tick
    spy.mockRestore()
  }
  expect(sends).toHaveLength(0)
})

test('Pi Prime fresh quota below the killswitch floor does not claim or fire', async () => {
  const native = await fixture(true, {
    killswitch: { enabled: true, main: { five_hour: 10 } },
  })
  quotaResponse = async () => Response.json(quota(5))
  await native.prime?.manager.tick()
  expect(polls).toBe(1)
  expect(sends).toHaveLength(0)
  expect(await readdir(markerDir, { recursive: true })).toEqual([])
})

test('Pi Prime and an OC2-style manager sharing account storage claim only one send', async () => {
  const native = await fixture()
  const runtime = await native.service()
  const paths = await resolveNativePoolPaths(storagePath)
  let oc2Sends = 0
  const fingerprint = async (accountId: string) => {
    const credential = await runtime.authorizeLocal(accountId)
    if (credential.status !== 'usable') return undefined
    const lineage = await runtime.getOrCreateAuthLineage(
      accountId,
      credential.subject,
    )
    return lineage ? tokenFingerprint(lineage) : undefined
  }
  const oc2 = new PrimeManager({
    storagePath: paths.legacyConfig,
    markerDir,
    now: () => now,
    loadStorage: async () => (await runtime.read()).policyStorage,
    getAccountFingerprint: fingerprint,
    refreshQuota: async () => ({
      quota: await runtime.fetchQuota('main'),
      fresh: true,
    }),
    sendPrime: async () => {
      oc2Sends++
      return {
        ok: true,
        status: 200,
        ms: 1,
        usage: { inputTokens: 17, outputTokens: 1 },
      }
    },
    recordSuccess: async () => ({
      count: 1,
      inputTokens: 17,
      outputTokens: 1,
      since: now,
    }),
  })
  try {
    await Promise.all([native.prime!.manager.tick(), oc2.tick()])
    expect(sends.length + oc2Sends).toBe(1)
    const accountDir = primeAccountMarkerDir(
      markerDir,
      paths.legacyConfig,
      (await fingerprint('main'))!,
    )
    const marker = primeMarkerPath(accountDir, 'main', now - 120_000)
    expect(await Bun.file(marker).exists()).toBe(true)
  } finally {
    oc2.stop()
  }
})

test('Pi Prime owns one interval per storage and runtime close stops its timers', async () => {
  const native = await fixture()
  expect(getPiNativeRuntime(storagePath)).toBe(native)
  expect(intervals.size).toBe(1)
  await native.prime?.manager.tick()
  expect(timeouts.size).toBe(1)
  await closePiNativeRuntime(storagePath)
  expect(intervals.size).toBe(0)
  expect(timeouts.size).toBe(0)
  expect(native.prime?.manager.isStopped()).toBe(true)
  await native.prime?.manager.tick()
  expect(sends).toHaveLength(1)
})

test('Pi Prime stops on the extension session_shutdown event', async () => {
  const native = await fixture()
  const handlers = new Map<string, unknown>()
  await cortexKitPiAnthropicAuth({
    on: (name: string, callback: unknown) => {
      handlers.set(name, callback)
    },
    registerCommand() {},
    registerProvider() {},
  } as unknown as ExtensionAPI)
  const shutdown = handlers.get('session_shutdown') as (
    event: unknown,
    context: unknown,
  ) => Promise<void>
  await shutdown(
    {},
    { sessionManager: { getSessionId: () => 'prime-shutdown' } },
  )
  expect(native.prime?.manager.isStopped()).toBe(true)
  expect(intervals.size).toBe(0)
  await native.prime?.manager.tick()
  expect(sends).toHaveLength(0)
})

test('Pi Prime refuses host authority drift before touching the native service', async () => {
  const native = await fixture()
  const service = spyOn(native, 'service')
  process.env.CORTEXKIT_VAULT_HOST = 'thalamus'
  try {
    await expect(
      sendPiPrimeRequest({
        native,
        storagePath,
        accountId: 'main',
        signal: new AbortController().signal,
        beforeSend: async () => {},
        onServed: () => {},
      }),
    ).rejects.toMatchObject({ code: 'route-unavailable' })
    expect(service).not.toHaveBeenCalled()
    expect(sends).toHaveLength(0)
  } finally {
    service.mockRestore()
    delete process.env.CORTEXKIT_VAULT_HOST
  }
})

for (const [boundary, target] of [
  ['direct preparation', 1],
  ['gzip preparation', 2],
] as const) {
  test(`Pi Prime refuses host authority drift during awaited ${boundary}`, async () => {
    const native = await fixture()
    const entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>()
    let admissions = 0
    const pending = sendPiPrimeRequest({
      native,
      storagePath,
      accountId: 'main',
      signal: new AbortController().signal,
      beforeSend: async () => {
        if (++admissions === target) {
          entered.resolve()
          await release.promise
        }
      },
      onServed: () => {},
    })
    const settled = Promise.allSettled([pending])
    try {
      await Promise.race([
        entered.promise,
        pending.then(() => {
          throw new Error('Prime completed before its physical-send barrier')
        }),
      ])
      process.env.CORTEXKIT_VAULT_HOST = 'thalamus'
      release.resolve()
      await expect(pending).rejects.toBeInstanceOf(Error)
      expect(sends).toHaveLength(0)
    } finally {
      release.resolve()
      await settled
      delete process.env.CORTEXKIT_VAULT_HOST
    }
  })
}
