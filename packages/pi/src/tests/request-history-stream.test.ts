import { afterEach, expect, mock, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  saveAccounts,
  TRAILING_ASSISTANT_HISTORY_MESSAGE,
} from '@cortexkit/anthropic-auth-core'
import type {
  Api,
  AssistantMessage,
  Context,
  Model,
} from '@earendil-works/pi-ai'
import { streamCortexKitAnthropic } from '../stream.ts'

const originalFetch = globalThis.fetch
const originalPath = process.env.PI_ANTHROPIC_AUTH_FILE
let directory: string | undefined

afterEach(async () => {
  globalThis.fetch = originalFetch
  if (originalPath === undefined) delete process.env.PI_ANTHROPIC_AUTH_FILE
  else process.env.PI_ANTHROPIC_AUTH_FILE = originalPath
  const finished = directory
  directory = undefined
  if (finished) await rm(finished, { recursive: true, force: true })
})

const model: Model<Api> = {
  id: 'claude-opus-5-5',
  name: 'Opus',
  provider: 'anthropic',
  api: 'anthropic-messages',
  baseUrl: 'https://api.anthropic.com',
  reasoning: true,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1_000_000,
  maxTokens: 128_000,
}
const assistant: AssistantMessage = {
  role: 'assistant',
  content: [{ type: 'text', text: 'Synthetic completed answer.' }],
  api: 'anthropic-messages',
  provider: 'anthropic',
  model: model.id,
  stopReason: 'stop',
  timestamp: 1,
  usage: {
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
}

for (const apiKey of ['sk-ant-oat-fixture-history', 'fixture-api-key']) {
  test.each([false, true])(
    `Pi refuses meaningful assistant history locally (${apiKey}, empty user=%s)`,
    async (emptyUser) => {
      directory = await mkdtemp(join(tmpdir(), 'pi-history-boundary-'))
      const storagePath = join(directory, 'anthropic-auth.json')
      process.env.PI_ANTHROPIC_AUTH_FILE = storagePath
      await saveAccounts(
        {
          version: 1,
          main: { type: 'opencode', provider: 'anthropic' },
          accounts: [],
          fallbackOn: [400, 429],
          quota: {
            enabled: false,
            checkIntervalMinutes: 5,
            minimumRemaining: {},
            failClosedOnUnknownQuota: false,
          },
        },
        storagePath,
      )

      let dispatches = 0
      globalThis.fetch = mock(async (input: string | URL | Request) => {
        const url = input instanceof Request ? input.url : String(input)
        if (url.includes('/api/claude_cli/bootstrap'))
          return Response.json({
            oauth_account: { account_uuid: 'pi-history-account' },
          })
        if (url.includes('/v1/messages')) {
          dispatches++
          return new Response(
            'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_fixture","model":"claude-opus-5-5","usage":{"input_tokens":1,"output_tokens":0}}}\n\n' +
              'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n' +
              'event: message_stop\ndata: {"type":"message_stop"}\n\n',
            { headers: { 'content-type': 'text/event-stream' } },
          )
        }
        throw new Error('Unexpected fixture network dispatch')
      }) as unknown as typeof fetch

      const context: Context = {
        messages: [
          {
            role: 'user',
            content: 'Synthetic original question.',
            timestamp: 0,
          },
          assistant,
          ...(emptyUser
            ? [{ role: 'user' as const, content: '', timestamp: 2 }]
            : []),
        ],
        tools: [],
      }
      const stream = streamCortexKitAnthropic(model, context, { apiKey })
      const events = []
      for await (const event of stream) events.push(event)
      const result = await stream.result()
      expect(result.stopReason).toBe('error')
      expect(result.errorMessage).toBe(TRAILING_ASSISTANT_HISTORY_MESSAGE)
      expect(events.filter((event) => event.type === 'error')).toHaveLength(1)
      expect(events.some((event) => event.type === 'done')).toBe(false)
      expect(dispatches).toBe(0)

      const control = streamCortexKitAnthropic(
        model,
        {
          ...context,
          messages: [
            ...context.messages,
            { role: 'user', content: 'New valid question.', timestamp: 3 },
          ],
        },
        { apiKey },
      )
      for await (const _event of control) {
        /* Drain the control stream. */
      }
      expect((await control.result()).stopReason).toBe('stop')
      expect(dispatches).toBe(1)
    },
  )
}
