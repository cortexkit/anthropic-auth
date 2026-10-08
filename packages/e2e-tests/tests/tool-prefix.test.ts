/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { E2EHarness } from '../src/harness.ts'

let harness: E2EHarness | null = null

afterEach(async () => {
  const finished = harness
  harness = null
  await finished?.dispose()
})

describe('OpenCode Anthropic auth e2e', () => {
  it('keeps sidebar state inside the isolated run directory', async () => {
    const fakeTmpDir = await mkdtemp(join(tmpdir(), 'anthropic-auth-global-'))
    const globalStateDir = join(fakeTmpDir, 'opencode-anthropic-auth')
    const globalStateFile = join(globalStateDir, 'sidebar-state.json')
    const sentinel = '{"sentinel":"operator-live-state"}\n'
    await mkdir(globalStateDir)
    await writeFile(globalStateFile, sentinel)

    try {
      // Only the child sees the fake TMPDIR; harness lifecycle paths stay in the real system tmpdir.
      harness = await E2EHarness.create({ childTmpDir: fakeTmpDir })
      expect(harness.opencode.env.tempDir.startsWith(fakeTmpDir)).toBe(false)
      harness.script([{ type: 'text', text: 'isolation checked' }])
      const sessionId = await harness.createSession()
      await harness.sendPrompt(sessionId, 'verify isolated sidebar state')
      const isolatedStateFile = join(
        harness.opencode.env.configDir,
        'sidebar-state.json',
      )
      for (let attempt = 0; attempt < 50; attempt += 1) {
        if (await Bun.file(isolatedStateFile).exists()) break
        await Bun.sleep(100)
      }

      expect(await Bun.file(globalStateFile).text()).toBe(sentinel)
      expect(await Bun.file(isolatedStateFile).exists()).toBe(true)
      const hostLog = await Bun.file(
        join(harness.opencode.env.dataDir, 'opencode', 'log', 'opencode.log'),
      ).text()
      expect(hostLog).not.toContain(`path=${join(homedir(), '.opencode')}`)
      expect(hostLog).not.toContain(join(homedir(), '.claude', 'skills'))
    } finally {
      const finished = harness
      harness = null
      await finished?.dispose()
      await rm(fakeTmpDir, { recursive: true, force: true })
    }
  }, 90_000)

  it('publishes adaptive Opus 5 effort variants to OpenCode', async () => {
    harness = await E2EHarness.create()
    const response = await fetch(`${harness.opencode.url}/provider`)
    expect(response.status).toBe(200)
    const providers = (await response.json()) as {
      all: Array<{
        id: string
        models: Record<
          string,
          { variants?: Record<string, Record<string, unknown>> }
        >
      }>
    }
    const opus5 = providers.all.find((provider) => provider.id === 'anthropic')
      ?.models['claude-opus-5']

    expect(Object.keys(opus5?.variants ?? {})).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ])
    expect(opus5?.variants?.max).toEqual({
      thinking: { type: 'adaptive', display: 'summarized' },
      effort: 'max',
    })
  }, 90_000)

  it('preserves Fable 5.1 effort history across OpenCode variant changes', async () => {
    harness = await E2EHarness.create()
    harness.script([
      {
        type: 'tool_use',
        name: 'mcp_Read',
        input: { filePath: harness.sampleFilePath() },
      },
      { type: 'text', text: 'first effort response after the tool loop' },
      { type: 'text', text: 'second effort response' },
    ])
    const sessionId = await harness.createSession()

    await harness.sendPrompt(
      sessionId,
      'start with low effort',
      60_000,
      'claude-fable-5-1',
      'low',
    )
    await harness.sendPrompt(
      sessionId,
      'switch to high effort',
      60_000,
      'claude-fable-5-1',
      'high',
    )

    const generationRequests = harness.anthropic.requests().filter((request) => {
      const serializedBody = JSON.stringify(request.body)
      return (
        request.body.model === 'claude-fable-5-1' &&
        !serializedBody.includes('Generate a title for this conversation')
      )
    })
    expect(generationRequests).toHaveLength(3)
    for (const request of generationRequests) {
      expect(request.body.output_config).toMatchObject({ effort: 'low' })
    }
    const switchedMessages = generationRequests[2]?.body.messages
    expect(Array.isArray(switchedMessages) ? switchedMessages : []).toContainEqual({
      role: 'system',
      content: [],
      output_config: { effort: 'high' },
    })
    expect(JSON.stringify(generationRequests[2]?.body)).toContain('tool_result')
    for (const request of generationRequests) {
      const serialized = JSON.stringify(request.body)
      expect(serialized).not.toContain('cortexkit-internal-effort')
      expect(request.headers['anthropic-beta']?.split(',')).toContain(
        'mid-conversation-output-config-2026-07-01',
      )
    }
  }, 90_000)

  it('replays a mid-output Anthropic safety fallback boundary through OpenCode', async () => {
    harness = await E2EHarness.create()
    harness.script([
      {
        type: 'server_fallback',
        fromModel: 'claude-fable-5',
        toModel: 'claude-opus-5',
        partialText: 'source prefix',
        thinkingText: 'target reasoning',
        text: 'fallback suffix',
      },
      { type: 'text', text: 'source restored' },
    ])

    const sessionId = await harness.createSession()
    const fallbackResult = await harness.sendPrompt(
      sessionId,
      'trigger a server-side safety fallback',
      60_000,
      'claude-fable-5',
    )
    expect(JSON.stringify(fallbackResult)).toContain('source prefix')
    expect(JSON.stringify(fallbackResult)).toContain('fallback suffix')
    await harness.waitForSessionText(sessionId, 'Anthropic safety fallback')

    const restoredResult = await harness.sendPrompt(
      sessionId,
      'continue after the fallback boundary',
      60_000,
      'claude-fable-5',
    )
    expect(JSON.stringify(restoredResult)).toContain('source restored')
    await harness.waitForSessionText(sessionId, 'Returning to Fable 5')

    const generationRequests = harness.anthropic.requests().filter((request) => {
      const serializedBody = JSON.stringify(request.body)
      return (
        request.body.max_tokens !== 0 &&
        !serializedBody.includes('Generate a title for this conversation')
      )
    })
    expect(generationRequests).toHaveLength(2)
    expect(generationRequests[0]?.body.fallbacks).toBe('default')
    expect(generationRequests[0]?.headers['anthropic-beta']?.split(',')).toContain(
      'server-side-fallback-2026-07-01',
    )
    expect(generationRequests[1]?.body.fallbacks).toBe('default')

    const replayMessages = Array.isArray(generationRequests[1]?.body.messages)
      ? generationRequests[1].body.messages
      : []
    const replayAssistant = replayMessages.findLast((message) => {
      if (!message || typeof message !== 'object') return false
      const candidate = message as { role?: unknown; content?: unknown }
      return (
        candidate.role === 'assistant' &&
        Array.isArray(candidate.content) &&
        candidate.content.some(
          (block) =>
            block != null &&
            typeof block === 'object' &&
            (block as { type?: unknown }).type === 'fallback',
        )
      )
    }) as { content: Array<Record<string, unknown>> } | undefined
    expect(replayAssistant).toBeDefined()
    const replayTypes = replayAssistant?.content.map((block) => block.type)
    expect(replayTypes).toEqual(['text', 'fallback', 'thinking', 'text'])
    expect(replayAssistant?.content[0]?.text).toBe('source prefix')
    expect(replayAssistant?.content[1]).toEqual({
      type: 'fallback',
      from: { model: 'claude-fable-5' },
      to: { model: 'claude-opus-5' },
    })
    expect(replayAssistant?.content[2]).toMatchObject({
      type: 'thinking',
      thinking: 'target reasoning',
      signature: 'mock-target-thinking-signature',
    })
    expect(replayAssistant?.content[3]?.text).toBe('fallback suffix')
    expect(JSON.stringify(generationRequests[1]?.body)).not.toContain(
      'cortexkit-server-fallback-v1',
    )
  }, 90_000)

  it('strips mcp_ tool names even when Anthropic SSE chunks split the name field', async () => {
    harness = await E2EHarness.create()
    harness.script([
      {
        type: 'tool_use',
        name: 'mcp_Read',
        input: { filePath: harness.sampleFilePath() },
        splitToolNameChunk: true,
      },
      { type: 'text', text: 'read complete' },
    ])

    const sessionId = await harness.createSession()
    const result = await harness.sendPrompt(sessionId, 'read sample.txt')

    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain('unavailable tool')
    expect(serialized).not.toContain('mcp_Read')
    await harness.waitFor(
      () => harness!.anthropic.requests().length >= 2,
      { label: 'tool call and follow-up request captured' },
    )
    expect(
      harness.anthropic.requests().some((request) =>
        JSON.stringify(request.body).includes('hello from sample file'),
      ),
    ).toBe(true)
  }, 90_000)

  it('continues a completed fallback tool call on Opus without replaying the side effect', async () => {
    harness = await E2EHarness.create({ hybridCache: true })

    const sideEffectPath = join(
      harness.opencode.env.tempDir,
      'fallback-tool-side-effect.txt',
    )
    const appendSideEffect = `printf x >> ${JSON.stringify(sideEffectPath)}`
    harness.anthropic.script([
      {
        type: 'server_fallback',
        fromModel: 'claude-fable-5',
        toModel: 'claude-opus-4-8',
        text: 'fallback established',
      },
      {
        type: 'server_fallback_tool_refusal',
        fromModel: 'claude-fable-5',
        toModel: 'claude-opus-4-8',
        name: 'mcp_Bash',
        input: { command: appendSideEffect },
        refusalDelayMs: 500,
      },
      { type: 'text', text: 'continued with the existing tool result' },
    ])

    const sessionId = await harness.createSession()
    const first = await harness.sendPrompt(
      sessionId,
      'establish the server fallback',
      60_000,
      'claude-fable-5',
    )
    expect(JSON.stringify(first)).toContain('fallback established')

    const recovered = await harness.sendPrompt(
      sessionId,
      'call the tool and then finish',
      60_000,
      'claude-fable-5',
    )
    expect(JSON.stringify(recovered)).toContain(
      'continued with the existing tool result',
    )
    await harness.waitForSessionText(sessionId, 'Switched to Opus 4.8')

    const anthropic = harness.anthropic
    await harness.waitFor(
      () =>
        anthropic.requests().some((request) => request.body.max_tokens === 0),
      { timeoutMs: 5_000, label: 'source-model prewarm request' },
    )

    expect(await Bun.file(sideEffectPath).text()).toBe('x')
    const generationRequests = harness.anthropic
      .requests()
      .filter(
        (request) =>
          request.body.max_tokens !== 0 &&
          !JSON.stringify(request.body).includes(
            'Generate a title for this conversation',
          ),
      )
    expect(generationRequests.map((request) => request.body.model)).toEqual([
      'claude-fable-5',
      'claude-fable-5',
      'claude-opus-4-8',
    ])
    expect(JSON.stringify(generationRequests[2]?.body)).toContain('tool_result')
    expect(generationRequests[2]?.body.fallbacks).toBeUndefined()
    expect(JSON.stringify(generationRequests[2]?.body)).not.toContain(
      'cortexkit-server-fallback-v1:',
    )

    const prewarmRequest = harness.anthropic
      .requests()
      .find((request) => request.body.max_tokens === 0)
    expect(prewarmRequest?.body.model).toBe('claude-fable-5')
    expect(prewarmRequest?.body.fallbacks).toBeUndefined()
    expect(JSON.stringify(prewarmRequest?.body)).not.toContain(
      'cortexkit-server-fallback-v1:',
    )
    expect(prewarmRequest?.headers['anthropic-beta']).not.toContain(
      'server-side-fallback-2026-07-01',
    )
  }, 60_000)

  it('retries a Fable refusal with Opus and immediately prewarms Fable', async () => {
    harness = await E2EHarness.create({
      hybridCache: true,
      fallbackMode: 'legacy',
    })
    harness.script([
      { type: 'refusal' },
      {
        type: 'text',
        text: 'recovered through opus',
        delayMs: 3_000,
      },
    ])

    const sessionId = await harness.createSession()
    const resultPromise = harness.sendPrompt(
      sessionId,
      'recover from the Fable content filter',
      60_000,
      'claude-fable-5',
    )

    await harness.waitFor(
      () =>
        harness!.anthropic
          .requests()
          .filter((request) => request.body.max_tokens !== 0).length >= 2,
      { label: 'delayed Opus recovery request captured' },
    )
    const result = await resultPromise
    const serialized = JSON.stringify(result)
    expect(serialized).toContain('recovered through opus')
    await harness.waitForSessionText(sessionId, 'Switched to Opus 4.8')
    expect(serialized).not.toContain('ContentFilterError')
    await harness.waitFor(
      () =>
        harness!.anthropic
          .requests()
          .some(
            (request) =>
              request.body.model === 'claude-fable-5' &&
              request.body.max_tokens === 0,
          ),
      { timeoutMs: 30_000, label: 'Fable cache prewarm captured' },
    )

    const sessionRequests = harness.anthropic.requests().filter((request) => {
      const serializedBody = JSON.stringify(request.body)
      return (
        request.body.max_tokens !== 0 &&
        !serializedBody.includes('Generate a title for this conversation')
      )
    })
    expect(sessionRequests.map((request) => request.body.model)).toEqual([
      'claude-fable-5',
      'claude-opus-4-8',
    ])
  }, 90_000)

  it('bridges back to a stale Opus cache after more than 20 Fable blocks', async () => {
    harness = await E2EHarness.create({
      hybridCache: true,
      fallbackMode: 'legacy',
    })
    harness.script([
      { type: 'refusal' },
      ...Array.from({ length: 10 }, (_, index) => ({
        type: 'text' as const,
        text: `opus recovery ${index}`,
      })),
      ...Array.from({ length: 11 }, (_, index) => ({
        type: 'text' as const,
        text: `healthy Fable response ${index}`,
      })),
      { type: 'refusal' },
      { type: 'text', text: 'second Opus recovery' },
    ])

    const sessionId = await harness.createSession()
    await harness.sendPrompt(
      sessionId,
      'start first Fable recovery cycle',
      60_000,
      'claude-fable-5',
    )
    for (let index = 0; index < 9; index++) {
      await harness.sendPrompt(
        sessionId,
        `continue Opus cycle ${index}`,
        60_000,
        'claude-fable-5',
      )
    }
    await harness.waitForSessionText(sessionId, 'Returning to Fable 5')
    for (let index = 0; index < 11; index++) {
      await harness.sendPrompt(
        sessionId,
        `healthy Fable turn ${index}`,
        60_000,
        'claude-fable-5',
      )
    }
    const recovered = await harness.sendPrompt(
      sessionId,
      'trigger second Fable recovery cycle',
      60_000,
      'claude-fable-5',
    )
    expect(JSON.stringify(recovered)).toContain('second Opus recovery')

    const generationRequests = harness.anthropic.requests().filter((request) => {
      const serializedBody = JSON.stringify(request.body)
      return (
        request.body.max_tokens !== 0 &&
        !serializedBody.includes('Generate a title for this conversation')
      )
    })
    expect(generationRequests).toHaveLength(24)
    expect(generationRequests.slice(0, 11).map((request) => request.body.model)).toEqual([
      'claude-fable-5',
      ...Array.from({ length: 10 }, () => 'claude-opus-4-8'),
    ])
    expect(
      generationRequests.slice(11, 23).map((request) => request.body.model),
    ).toEqual(Array.from({ length: 12 }, () => 'claude-fable-5'))
    const firstCycleOpus = generationRequests.at(10)
    const finalOpus = generationRequests.at(23)
    if (!firstCycleOpus || !finalOpus)
      throw new Error('expected two complete model recovery cycles')
    expect(finalOpus.body.model).toBe('claude-opus-4-8')

    const markedMessageIndexes = (body: Record<string, unknown>) => {
      const messages = Array.isArray(body.messages) ? body.messages : []
      return messages.flatMap((message, index) => {
        if (!message || typeof message !== 'object') return []
        const content = Array.isArray((message as { content?: unknown }).content)
          ? ((message as { content: unknown[] }).content ?? [])
          : []
        return content.some(
          (block) =>
            block != null &&
            typeof block === 'object' &&
            'cache_control' in block,
        )
          ? [index]
          : []
      })
    }
    const messageEndBlockPosition = (
      body: Record<string, unknown>,
      messageIndex: number,
    ) => {
      const messages = Array.isArray(body.messages) ? body.messages : []
      let blocks = 0
      for (let index = 0; index <= messageIndex; index++) {
        const message = messages[index]
        if (!message || typeof message !== 'object') continue
        const content = (message as { content?: unknown }).content
        blocks += Array.isArray(content) ? content.length : content == null ? 0 : 1
      }
      return blocks - 1
    }

    const lastFirstCycleOpus = firstCycleOpus.body
    const secondCycleOpus = finalOpus.body
    const oldOpusTail = markedMessageIndexes(lastFirstCycleOpus).at(-1)
    const secondCycleMarkers = markedMessageIndexes(secondCycleOpus)
    expect(oldOpusTail).toBeNumber()
    expect(secondCycleMarkers).toContain(oldOpusTail!)
    expect(secondCycleMarkers.at(-1)).toBe(
      (secondCycleOpus.messages as unknown[]).length - 1,
    )
    expect(
      messageEndBlockPosition(secondCycleOpus, secondCycleMarkers.at(-1)!) -
        messageEndBlockPosition(secondCycleOpus, oldOpusTail!) +
        1,
    ).toBeGreaterThan(20)
    expect(
      (secondCycleOpus.system as Array<{ cache_control?: unknown }>).some(
        (block) => block.cache_control,
      ),
    ).toBe(false)
  }, 180_000)

  it('preserves server-side fallback opt-in and response normalization through the websocket relay', async () => {
    harness = await E2EHarness.create({ relay: 'websocket' })
    harness.script([
      {
        type: 'server_fallback',
        fromModel: 'claude-fable-5',
        toModel: 'claude-opus-5',
        text: 'relay fallback ok',
      },
    ])

    const sessionId = await harness.createSession()
    const result = await harness.sendPrompt(
      sessionId,
      'trigger fallback through relay',
      60_000,
      'claude-fable-5',
    )
    expect(JSON.stringify(result)).toContain('relay fallback ok')
    await harness.waitForSessionText(sessionId, 'Anthropic safety fallback')
    const request = await harness.waitFor(
      () =>
        harness!.anthropic
          .requests()
          .find(
            (candidate) =>
              candidate.body.model === 'claude-fable-5' &&
              candidate.body.max_tokens !== 0,
          ),
      { label: 'server fallback upstream request captured' },
    )

    expect(request.body.fallbacks).toBe('default')
    expect(request.headers['anthropic-beta']?.split(',')).toContain(
      'server-side-fallback-2026-07-01',
    )
  }, 90_000)

  it('streams through websocket relay without closing before response', async () => {
    harness = await E2EHarness.create({ relay: 'websocket' })
    harness.script([{ type: 'text', text: 'relay ok' }])

    const sessionId = await harness.createSession()
    const result = await harness.sendPrompt(sessionId, 'hello via relay')

    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain('websocket closed')
    await harness.waitFor(() => (harness!.relay?.acceptedRequests() ?? 0) >= 1, {
      label: 'websocket relay accepted request',
    })
    await harness.waitFor(() => harness!.anthropic.requests().length >= 1, {
      label: 'upstream request captured',
    })
  }, 90_000)
})


describe('Fable 5.1 effort correlation through real OpenCode lowering', () => {
  it('keeps the current effort anchor across a tool-result continuation', async () => {
    harness = await E2EHarness.create()
    harness.script([
      { type: 'text', text: 'initial low response' },
      { type: 'tool_use', name: 'mcp_Read', input: { filePath: harness.sampleFilePath() } },
      { type: 'text', text: 'high effort tool continuation completed' },
    ])
    const sessionId = await harness.createSession()
    await harness.sendPrompt(sessionId, 'first low request', 60_000, 'claude-fable-5-1', 'low')
    const result = await harness.sendPrompt(sessionId, 'switch to high and read the sample file', 60_000, 'claude-fable-5-1', 'high')
    expect(JSON.stringify(result)).toContain('high effort tool continuation completed')

    const requests = harness.anthropic.requests().filter((request) =>
      request.body.model === 'claude-fable-5-1' &&
      !JSON.stringify(request.body).includes('Generate a title for this conversation'),
    )
    expect(requests).toHaveLength(3)
    const continuation = requests[2]?.body
    expect(JSON.stringify(continuation?.messages)).toContain('tool_result')
    expect(continuation?.output_config).toEqual({ effort: 'low' })
    expect(continuation?.messages).toContainEqual({
      role: 'system', content: [], output_config: { effort: 'high' },
    })
    for (const request of requests) expect(JSON.stringify(request.body)).not.toContain('cortexkit-internal-effort')
  }, 90_000)

  it('applies the last planned effort when OpenCode merges two host user records', async () => {
    harness = await E2EHarness.create({
      beforeSpawn: async (env) => {
        const configPath = join(env.configDir, 'opencode.json')
        const config = JSON.parse(await readFile(configPath, 'utf8')) as { plugin: string[] }
        const injector = join(env.configDir, 'inject-consecutive-users.mjs')
        await writeFile(injector, `export default async function () {
  return {
    'experimental.chat.messages.transform': async (_input, output) => {
      const messages = output.messages
      const current = messages.at(-1)
      if (current?.info?.role !== 'user' || current.info.model?.variant !== 'max') return
      const previous = current.parts?.find((part) => part.type === 'text')
      if (!previous) throw new Error('No lowerable user text to clone')
      const id = 'msg_e2e_injected_high'
      messages.splice(messages.length - 1, 0, {
        info: { ...current.info, id, model: { ...current.info.model, variant: 'high' } },
        parts: [{ ...previous, id: 'prt_e2e_injected_high', messageID: id, text: 'injected high effort boundary' }],
      })
    },
  }
}\n`)
        config.plugin.unshift(`file://${injector}`)
        await writeFile(configPath, JSON.stringify(config))
      },
    })
    harness.script([
      { type: 'text', text: 'low response before merged boundary' },
      { type: 'text', text: 'max response after merged boundary' },
    ])
    const sessionId = await harness.createSession()
    await harness.sendPrompt(sessionId, 'start at low', 60_000, 'claude-fable-5-1', 'low')
    const result = await harness.sendPrompt(sessionId, 'raise to max', 60_000, 'claude-fable-5-1', 'max')
    expect(JSON.stringify(result)).toContain('max response after merged boundary')

    const requests = harness.anthropic.requests().filter((request) =>
      request.body.model === 'claude-fable-5-1' &&
      !JSON.stringify(request.body).includes('Generate a title for this conversation'),
    )
    expect(requests).toHaveLength(2)
    const body = requests[1]?.body
    const merged = (Array.isArray(body?.messages) ? body.messages : []).filter((message) =>
      message.role === 'user' &&
      JSON.stringify(message.content).includes('injected high effort boundary') &&
      JSON.stringify(message.content).includes('raise to max'),
    )
    expect(merged).toHaveLength(1)
    expect(body?.output_config).toEqual({ effort: 'low' })
    expect(body?.messages).toContainEqual({
      role: 'system', content: [], output_config: { effort: 'max' },
    })
    expect(JSON.stringify(body)).not.toContain('cortexkit-internal-effort')
  }, 90_000)
})
