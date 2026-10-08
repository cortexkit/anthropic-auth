import { afterEach, expect, test } from 'bun:test'
import { E2EHarness } from '../src/harness.ts'

let harness: E2EHarness | null = null

// Background title calls can use Haiku too; their arrival order does not
// identify the user request whose effort and usage this suite checks.
function isHaikuModelRequest(body: Record<string, unknown>) {
  return body.model === 'claude-haiku-5-5' &&
    body.max_tokens !== 0 &&
    !JSON.stringify(body).includes('Generate a title for this conversation')
}

afterEach(async () => {
  const finished = harness
  harness = null
  await finished?.dispose()
})

test.each(['low', 'max'])(
  'Haiku 5.5 %s keeps native adaptive effort through the OpenCode host',
  async (effort) => {
    harness = await E2EHarness.create()
    harness.script([{ type: 'text', text: 'yes' }])
    const session = await harness.createSession()
    await harness.sendPrompt(session, 'Reply yes', 45_000, 'claude-haiku-5-5', effort)
    const request = harness.anthropic.requests().find(
      (entry) => isHaikuModelRequest(entry.body),
    )
    expect(request).toBeDefined()
    expect(request?.body.thinking).toMatchObject({
      type: 'adaptive',
      display: 'summarized',
    })
    expect(request?.body.thinking).not.toHaveProperty('budget_tokens')
    expect(request?.body.output_config).toMatchObject({ effort })
    expect(request?.body.temperature).toBeUndefined()
    expect(request?.body.top_p).toBeUndefined()
    expect(request?.body.top_k).toBeUndefined()
    expect(request?.body.speed).toBeUndefined()
    expect(request?.body.fallbacks).toBeUndefined()
  },
  90_000,
)

test('Haiku 5.5 structured output preserves forced choice and reaches its tool', async () => {
  harness = await E2EHarness.create()
  harness.script([
    { type: 'tool_use', name: 'mcp_StructuredOutput', input: { answer: 'ok' } },
  ])
  const session = await harness.createSession()
  const format = {
    type: 'json_schema' as const,
    schema: {
      type: 'object',
      properties: { answer: { type: 'string' } },
      required: ['answer'],
      additionalProperties: false,
    },
  }
  const result = await harness.sendPrompt(
    session,
    'Return a JSON object with answer ok',
    45_000,
    'claude-haiku-5-5',
    undefined,
    format,
  )
  const info = (result.data as { info?: { structured?: unknown; error?: unknown } } | undefined)?.info
  expect(info?.structured).toEqual({ answer: 'ok' })
  expect(info?.error).toBeUndefined()
  const request = harness.anthropic.requests().find(
    (entry) => isHaikuModelRequest(entry.body) &&
      Array.isArray(entry.body.tools) &&
      entry.body.tools.some((tool: { name?: string }) => tool.name === 'mcp_StructuredOutput'),
  )
  expect(request).toBeDefined()
  expect(request?.body.tool_choice).toEqual({ type: 'any' })
  expect(request?.body.thinking).toMatchObject({ type: 'adaptive' })
}, 90_000)

test('OpenCode real accounting changes the Haiku 5.5 rate only above 100K cache-inclusive input', async () => {
  harness = await E2EHarness.create({
    childEnv: { OPENCODE_AUTH_CONTENT: JSON.stringify({ anthropic: { type: 'api', key: 'synthetic-api-key' } }) },
  })
  for (const total of [100_000, 100_001]) {
    harness.script([{ type: 'text', text: 'ok', usage: { input_tokens: total - 10_000, output_tokens: 20, cache_creation_input_tokens: 5000, cache_read_input_tokens: 5000 } }])
    const session = await harness.createSession()
    const result = await harness.sendPrompt(session, 'Reply ok', 45_000, 'claude-haiku-5-5', 'low')
    const info = (result.data as { info?: { cost?: number; tokens?: { input?: number; cache?: { read?: number; write?: number } } } } | undefined)?.info
    const request = harness.anthropic.requests().filter((entry) => isHaikuModelRequest(entry.body)).at(-1)
    expect(request).toBeDefined()
    expect(request?.body.thinking).toMatchObject({ type: 'adaptive' })
    expect(request?.body).not.toHaveProperty('temperature')
    expect(request?.body).not.toHaveProperty('top_p')
    expect(request?.body).not.toHaveProperty('top_k')
    expect(info?.tokens).toMatchObject({ input: total - 10_000, cache: { read: 5000, write: 5000 } })
    expect(info?.cost).toBeCloseTo(total === 100_000 ? 0.009685 : 0.0484255, 10)
  }
}, 90_000)
