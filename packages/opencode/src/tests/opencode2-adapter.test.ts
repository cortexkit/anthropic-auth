import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { gunzipSync } from 'node:zlib'
import {
  ANTHROPIC_OAUTH_ORIGIN_REFUSAL,
  CLAUDE_CODE_IDENTITY,
  CLAUDE_OPUS_5_5_ADAPTIVE_THINKING,
  CLAUDE_SONNET_5_ADAPTIVE_THINKING,
  type ClaudeCodeIdentity,
  extractBillingHeaderCCH,
  FAST_MODE_BETA,
  type ProviderAccountUuid,
  RELOCATED_MESSAGE,
  RelocatedError,
  RequestGzipLatch,
  signRequestBody,
  TRAILING_ASSISTANT_HISTORY_MESSAGE,
  USER_AGENT,
} from '@cortexkit/anthropic-auth-core'
import type {
  AccountHeadersResult,
  Attempt,
  ChooseAccountResult,
  HeaderEdits,
  LimitSignal,
  OpenCode2AuthAdapter,
  RequestScope,
} from '@cortexkit/common-auth/opencode2'
import { BILLING_LINEAGE_REQUEST_HEADER } from '../billing-lineage'
import { EFFORT_PLAN_REQUEST_HEADER } from '../effort-history'
import { LANE_START_REQUEST_HEADER } from '../lane-start'
import {
  SERVER_FALLBACK_MARKER_TEXT,
  SERVER_FALLBACK_SIGNATURE_PREFIX,
  SERVER_SIDE_FALLBACK_BETA,
} from '../server-fallback'
import {
  hasPinnedFirstUserTextForTest,
  NON_STREAMING_DIAGNOSTICS_MAX_BYTES,
  resetPinnedFirstUserTextsForTest,
} from '../transform'
import {
  createNativeAnthropicAdapter,
  INTERNAL_REQUEST_HEADERS,
  type NativeAnthropicAdapter,
  type NativeAnthropicAttemptContext,
  type NativeAnthropicAttemptData,
  type NativeAnthropicAttemptOutcome,
  type NativeAnthropicAuthorization,
  type NativeAnthropicBodyOptions,
  NativeAnthropicLocalRefusal,
  NativeAnthropicNoAccountError,
  type NativeAnthropicRequestContext,
  type NativeAnthropicResponseContext,
  NativeAnthropicRevokedError,
  type NativeAnthropicSource,
  NativeAnthropicStateRefusal,
  NO_ACCOUNT_REFUSAL,
} from '../v2/adapter'
import { createNativeWirePolicy } from '../v2/wire'

// A synthetic Core source: every account, credential and policy answer comes
// from here, and every call the adapter makes into it is recorded.

type Provenance = {
  readonly custody: 'local' | 'vault' | 'api'
  readonly receipt: string
  readonly version?: number
}
type Quota = { readonly unified: string | null; readonly scoped: string | null }
type Data = NativeAnthropicAttemptData<Provenance>

const ENV_KEYS = [
  'ANTHROPIC_AUTH_TEST_OAUTH_LOOPBACK_ORIGIN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_CUSTOM_HEADERS',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_FABLE_MODEL',
]
const savedEnv = new Map<string, string | undefined>()
beforeEach(() => {
  for (const key of ENV_KEYS) {
    savedEnv.set(key, process.env[key])
    delete process.env[key]
  }
})
afterEach(() => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

const UPSTREAM = 'https://api.anthropic.com/v1/messages'
const ACCOUNT_UUID =
  '6f1d1c2e-0000-4000-8000-00000000a11c' as ProviderAccountUuid
const IDENTITY: ClaudeCodeIdentity = {
  deviceId: 'd'.repeat(64),
  accountUuid: ACCOUNT_UUID,
  sessionId: '11111111-2222-4333-8444-555555555555',
}

const scopeOf = (over: Partial<RequestScope> = {}) => ({
  phase: 'request' as const,
  providerID: 'anthropic',
  modelID: 'claude-sonnet-5',
  sessionID: 'ses_alpha',
  agent: 'build',
  kind: 'primary' as const,
  ...over,
})

function oauth(
  token: string,
  provenance: Provenance,
  extra: Partial<
    Extract<NativeAnthropicAuthorization<Provenance>, { route: 'oauth' }>
  > = {},
): NativeAnthropicAuthorization<Provenance> {
  return {
    route: 'oauth',
    accessToken: token,
    identity: IDENTITY,
    provenance,
    ...extra,
  }
}

function apiKey(
  key: string,
  provenance: Provenance,
  baseURL?: string,
): NativeAnthropicAuthorization<Provenance> {
  return {
    route: 'api',
    headers: { 'X-Api-Key': key },
    ...(baseURL ? { baseURL } : {}),
    provenance,
  }
}

interface Recorder {
  requestOptions: NativeAnthropicRequestContext<Provenance>[]
  hostErrors: NativeAnthropicAttemptContext<Provenance>[]
  ends: {
    context: NativeAnthropicAttemptContext<Provenance>
    outcome: NativeAnthropicAttemptOutcome
  }[]
  forgotten: string[]
}

function makeSource(
  answers: {
    choose?: (scope: RequestScope) => string | undefined
    authorize?: (
      scope: RequestScope,
      accountId: string,
    ) => NativeAnthropicAuthorization<Provenance> | undefined
    options?: NativeAnthropicBodyOptions
  } & Partial<NativeAnthropicSource<Quota, Provenance>> = {},
) {
  const seen: Recorder = {
    requestOptions: [],
    hostErrors: [],
    ends: [],
    forgotten: [],
  }
  const source: NativeAnthropicSource<Quota, Provenance> = {
    chooseAccount: (input) => answers.choose?.(input) ?? 'acct-local',
    authorizeAccount: (scope, accountId) =>
      answers.authorize
        ? answers.authorize(scope, accountId)
        : oauth('sk-ant-oat01-local-token', {
            custody: 'local',
            receipt: `local:${accountId}`,
          }),
    requestOptions: (input) => {
      seen.requestOptions.push(input)
      return answers.options ?? {}
    },
    limitFromHostError: (error, input) => {
      seen.hostErrors.push(input)
      return error.status === 429
        ? { reason: 'host-429', status: 429 }
        : undefined
    },
    onAttemptEnd: (context, outcome) => {
      seen.ends.push({ context, outcome })
    },
    forgetSession: (sessionID) => {
      seen.forgotten.push(sessionID)
    },
    ...answers,
  }
  return { source, seen }
}

test('adapter drops an unused choice through the source and tolerates sources without cleanup', async () => {
  const input = { ...scopeOf(), accountId: 'acct-local' }
  const dropped: unknown[] = []
  const { source } = makeSource({
    dropChoice: (choice) => {
      dropped.push(choice)
    },
  })
  const native = createNativeAnthropicAdapter({ source })
  const withoutCleanup = createNativeAnthropicAdapter({
    source: makeSource().source,
  })
  try {
    await native.adapter.dropChoice(input)
    expect(dropped).toEqual([input])
    await withoutCleanup.adapter.dropChoice(input)
  } finally {
    native.dispose()
    withoutCleanup.dispose()
  }
})

/**
 * Drives one physical send in the order the common-auth installer does:
 * `chooseAccount`, `accountHeaders`, then in `http.request` the adapter's
 * `rewriteRequest` followed by the account header edits, which win on the
 * wire. Every request that would reach the network lands in `sent`.
 */
class Host {
  readonly sent: Request[] = []
  private seq = 0

  constructor(
    readonly adapter: OpenCode2AuthAdapter<Quota, Data, ChooseAccountResult>,
  ) {}

  async begin(scope: RequestScope) {
    const input = { ...scope, phase: 'request' as const }
    const accountId = await this.adapter.chooseAccount(input)
    // A hold is honoured only by the retry hook; a request needs an account.
    if (typeof accountId !== 'string') throw new Error('installer: no-account')
    const result = (await this.adapter.accountHeaders({
      ...scope,
      accountId,
    })) as AccountHeadersResult<Data>
    const attempt: Attempt<Data> = {
      ...scope,
      accountId,
      attemptId: `attempt-${++this.seq}`,
      transport: 'http',
      data: result.attempt,
    }
    return { attempt, edits: result.headers }
  }

  async rewrite(
    started: { attempt: Attempt<Data>; edits: HeaderEdits },
    request: Request,
  ) {
    const { attempt, edits } = started
    const rewritten =
      (await this.adapter.rewriteRequest?.({ ...attempt, request, attempt })) ??
      request
    const headers = new Headers(rewritten.headers)
    for (const [name, value] of Object.entries(edits)) {
      if (value === null) headers.delete(name)
      else headers.set(name, value)
    }
    return new Request(rewritten, { headers })
  }

  async send(
    started: { attempt: Attempt<Data>; edits: HeaderEdits },
    request: Request,
  ) {
    const final = await this.rewrite(started, request)
    this.sent.push(final)
    return final
  }

  async run(scope: RequestScope, request: Request) {
    const started = await this.begin(scope)
    const final = await this.send(started, request)
    return { ...started, final }
  }
}

/** Waits a bounded number of turns for in-progress work to reach the source. */
async function until(predicate: () => boolean) {
  for (let turn = 0; turn < 100 && !predicate(); turn++) await Bun.sleep(1)
  expect(predicate()).toBe(true)
}

const sonnetPayload = () => ({
  model: 'claude-sonnet-5',
  max_tokens: 32000,
  stream: true,
  system: [
    {
      type: 'text',
      text: 'You are OpenCode, the best coding agent on the planet.\nWork carefully.',
    },
  ],
  tools: [
    {
      name: 'bash',
      description: 'Run a shell command',
      input_schema: {
        type: 'object',
        properties: { command: { type: 'string' } },
        required: ['command'],
      },
    },
    {
      name: 'read',
      description: 'Read a file',
      input_schema: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
    },
  ],
  tool_choice: { type: 'tool', name: 'bash' },
  thinking: { type: 'enabled', budget_tokens: 16000 },
  messages: [
    { role: 'user', content: [{ type: 'text', text: 'List the repo files.' }] },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Listing them.' },
        {
          type: 'tool_use',
          id: 'toolu_01',
          name: 'bash',
          input: { command: 'ls' },
        },
      ],
    },
    {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'toolu_01',
          content: 'README.md',
          cache_control: { type: 'ephemeral' },
        },
      ],
    },
  ],
})

const opus55Payload = () => ({
  ...sonnetPayload(),
  model: 'claude-opus-5-5',
  tool_choice: { type: 'tool', name: 'StructuredOutput' },
  thinking: { type: 'disabled' },
})

function hostRequest(
  payload: unknown,
  init: {
    headers?: Record<string, string>
    signal?: AbortSignal
    url?: string
  } = {},
) {
  return new Request(init.url ?? UPSTREAM, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': 'opencode-host-placeholder',
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'fine-grained-tool-streaming-2025-05-14',
      'user-agent': 'opencode/2.0.22 ai-sdk/anthropic',
      'x-host-trace': 'trace-7',
      ...init.headers,
    },
    body: JSON.stringify(payload),
    ...(init.signal ? { signal: init.signal } : {}),
  })
}

const sse = (event: string, data: unknown) =>
  `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`

const PREFIXED_STREAM = [
  sse('message_start', {
    type: 'message_start',
    message: {
      id: 'msg_01',
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-5',
      content: [],
      usage: {
        input_tokens: 120,
        cache_read_input_tokens: 64,
        output_tokens: 1,
      },
    },
  }),
  sse('ping', { type: 'ping' }),
  sse('content_block_start', {
    type: 'content_block_start',
    index: 0,
    content_block: {
      type: 'tool_use',
      id: 'toolu_02',
      name: 'mcp_Bash',
      input: {},
    },
  }),
  sse('content_block_delta', {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'input_json_delta', partial_json: '{"command":"ls"}' },
  }),
  sse('content_block_stop', { type: 'content_block_stop', index: 0 }),
  sse('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: 'tool_use' },
    usage: { output_tokens: 18 },
  }),
  sse('message_stop', { type: 'message_stop' }),
]

/** Splits a stream into deliberately awkward chunks, mid-name included. */
function streamOf(text: string, onCancel?: (reason: unknown) => void) {
  const bytes = new TextEncoder().encode(text)
  let offset = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close()
        return
      }
      const end = Math.min(bytes.length, offset + 37)
      controller.enqueue(bytes.slice(offset, end))
      offset = end
    },
    cancel(reason) {
      onCancel?.(reason)
    },
  })
}

function sseResponse(text: string, onCancel?: (reason: unknown) => void) {
  return new Response(streamOf(text, onCancel), {
    status: 200,
    headers: {
      'content-type': 'text/event-stream',
      'request-id': 'req_011CTestUpstream000000001',
      'anthropic-ratelimit-unified-status': 'allowed',
      'anthropic-ratelimit-unified-5h-utilization': '0.42',
    },
  })
}

type InspectedBody = Record<string, unknown> & {
  tools: Array<{ name: string }>
  messages: Array<{ content: Array<Record<string, unknown>> }>
  system: Array<{ text: string }>
  metadata?: { user_id: string }
}
const bodyOf = async (request: Request) =>
  JSON.parse(await request.clone().text()) as InspectedBody

describe('OpenCode 2 native Anthropic adapter: request shape', () => {
  test('qualifying reply histories on an API proxy are byte-identical despite OAuth note settings', async () => {
    const { source } = makeSource({
      options: { turnEndNoteEnabled: true },
      authorize: () =>
        apiKey(
          'synthetic-api-key',
          { custody: 'api', receipt: 'api' },
          'https://proxy.invalid',
        ),
    })
    const host = new Host(createNativeAnthropicAdapter({ source }).adapter)
    const payload = {
      model: 'claude-opus-5-5',
      messages: [
        { role: 'user', content: 'Question' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'A'.repeat(350) },
            { type: 'tool_use', name: 'board', id: 'a', input: {} },
          ],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'a', content: 'Done' }],
        },
      ],
    }
    const { final } = await host.run(
      scopeOf({ modelID: payload.model }),
      hostRequest(payload),
    )
    expect(await final.text()).toBe(JSON.stringify(payload))
  })

  test('turn-end note N N+1 N+2 retain signed history prefixes through the native wire policy', async () => {
    const wire = createNativeWirePolicy()
    const { source } = makeSource({
      requestOptions: (input) =>
        wire.requestOptions(
          input as any,
          {
            policyStorage: {
              turnEndNote: { tools: ['board'] },
              claudeCache: { enabled: true, mode: 'automatic' },
            },
          } as any,
        ),
    })
    const host = new Host(createNativeAnthropicAdapter({ source }).adapter)
    const note = {
      role: 'system',
      clear_at: 'next_user_message',
      content:
        'Your reply above has already reached the user. The tool call after it was housekeeping and changed nothing they need to know. Do not repeat, summarize or rewrite that reply. If no new work remains, end the turn without restating anything.',
    }
    const pair = (id: string) => [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'A'.repeat(350) },
          { type: 'tool_use', name: 'board', id, input: {} },
        ],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: id, content: 'Done' }],
      },
    ]
    const messages: unknown[] = [
      { role: 'user', content: 'Question' },
      ...pair('a'),
    ]
    const outputs: any[] = []
    for (const id of ['a', 'b', 'c']) {
      if (id !== 'a')
        messages.push(
          { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] },
          { role: 'user', content: `Next ${id}` },
          ...pair(id),
        )
      const payload = {
        model: 'claude-opus-5-5',
        stream: true,
        max_tokens: 16000,
        messages,
        tools:
          id === 'a'
            ? [{ name: 'board', input_schema: { type: 'object' } }]
            : [],
      }
      const { final } = await host.run(
        scopeOf({ modelID: payload.model }),
        hostRequest(payload),
      )
      const text = await final.clone().text()
      expect(await signRequestBody(text)).toBe(text)
      const body = JSON.parse(text)
      expect(body.messages.at(-1)).toEqual(note)
      expect(final.headers.get('anthropic-beta')?.split(',')).toContain(
        'mid-conversation-system-clear-at-2026-08-21',
      )
      for (const previous of outputs) {
        expect(
          JSON.stringify(body.messages.slice(0, previous.messages.length)),
        ).toBe(JSON.stringify(previous.messages))
        const { messages: _m, system: _s, tools: _t, ...fields } = body
        const { messages: _pm, system: _ps, tools: _pt, ...initial } = previous
        expect(fields).toEqual(initial)
        expect(body.system.slice(1)).toEqual(previous.system.slice(1))
        expect(
          body.system[0].text.replace(/cch=[0-9a-f]{5}/, 'cch=00000'),
        ).toBe(previous.system[0].text.replace(/cch=[0-9a-f]{5}/, 'cch=00000'))
      }
      outputs.push(body)
    }
    expect(
      outputs[2].messages.filter((message: any) => message.clear_at),
    ).toHaveLength(3)
  })

  test('OAuth send carries the Claude Code wire shape, signed body and betas', async () => {
    const { source } = makeSource()
    const native = createNativeAnthropicAdapter({ source })
    const host = new Host(native.adapter)

    const { final } = await host.run(scopeOf(), hostRequest(sonnetPayload()))

    expect(final.method).toBe('POST')
    expect(new URL(final.url).searchParams.get('beta')).toBe('true')
    expect(final.headers.get('authorization')).toBe(
      'Bearer sk-ant-oat01-local-token',
    )
    expect(final.headers.get('x-api-key')).toBeNull()
    expect(final.headers.get('user-agent')).toBe(USER_AGENT)
    expect(final.headers.get('x-app')).toBe('cli')
    expect(final.headers.get('x-claude-code-session-id')).toBe(
      IDENTITY.sessionId,
    )
    const betas = final.headers.get('anthropic-beta')?.split(',') ?? []
    expect(betas).toContain('oauth-2025-04-20')
    expect(betas).toContain('fine-grained-tool-streaming-2025-05-14')

    const text = await final.clone().text()
    const body = JSON.parse(text)
    expect(body.tools.map((tool: { name: string }) => tool.name)).toEqual([
      'mcp_Bash',
      'mcp_Read',
    ])
    expect(body.tool_choice).toEqual({ type: 'tool', name: 'mcp_Bash' })
    expect(body.messages[1].content[1].name).toBe('mcp_Bash')
    expect(body.thinking).toEqual({ ...CLAUDE_SONNET_5_ADAPTIVE_THINKING })
    expect(body.system[0]?.text).toMatch(
      /^x-anthropic-billing-header: .*cch=[0-9a-f]{5};/,
    )
    expect(body.system[1].text).toBe(CLAUDE_CODE_IDENTITY)
    if (!body.metadata) throw new Error('OAuth body has no billing metadata')
    expect(JSON.parse(body.metadata.user_id).account_uuid).toBe(ACCOUNT_UUID)
    // Re-signing a correctly signed body reproduces it exactly; the tampered
    // companion shows the comparison can fail.
    expect(await signRequestBody(text)).toBe(text)
    const tampered = text.replace('List the repo files.', 'List all files.')
    expect(await signRequestBody(tampered)).not.toBe(tampered)
  })

  test('Opus 5.5 drops the forced tool choice and keeps adaptive thinking', async () => {
    const { source } = makeSource()
    const host = new Host(createNativeAnthropicAdapter({ source }).adapter)

    const { final } = await host.run(
      scopeOf({ modelID: 'claude-opus-5-5' }),
      hostRequest(opus55Payload()),
    )
    const body = await bodyOf(final)

    expect(body.tool_choice).toBeUndefined()
    expect(body.thinking).toEqual({ ...CLAUDE_OPUS_5_5_ADAPTIVE_THINKING })
    expect(body.tools[0]?.name).toBe('mcp_Bash')
  })

  test('API route gains no OAuth persona, prefix, betas or signature', async () => {
    const { source, seen } = makeSource({
      authorize: () =>
        apiKey(
          'sk-ant-api03-row-key',
          { custody: 'api', receipt: 'api:row-2' },
          'https://gateway.example.com/anthropic',
        ),
    })
    const host = new Host(createNativeAnthropicAdapter({ source }).adapter)
    const payload = sonnetPayload()

    const { final } = await host.run(
      scopeOf(),
      hostRequest(payload, {
        headers: {
          'anthropic-beta':
            'fine-grained-tool-streaming-2025-05-14,fine-grained-tool-streaming-2025-05-14',
        },
      }),
    )

    expect(final.url).toBe(
      'https://gateway.example.com/anthropic/v1/messages?beta=true',
    )
    expect(final.headers.get('x-api-key')).toBe('sk-ant-api03-row-key')
    expect(final.headers.get('authorization')).toBeNull()
    expect(final.headers.get('user-agent')).toBe(
      'opencode/2.0.22 ai-sdk/anthropic',
    )
    expect(final.headers.get('x-app')).toBeNull()
    expect(final.headers.get('x-claude-code-session-id')).toBeNull()
    expect(final.headers.get('anthropic-beta')).toBe(
      'fine-grained-tool-streaming-2025-05-14',
    )
    expect(await final.clone().text()).toBe(JSON.stringify(payload))
    expect(seen.requestOptions).toHaveLength(0)
  })

  test('API route strips incoming OAuth-only betas, fallback opt-in and fallback markers', async () => {
    const { source } = makeSource({
      authorize: () =>
        apiKey(
          'sk-ant-api03-row-key',
          { custody: 'api', receipt: 'api:row-2' },
          'https://gateway.example.com/anthropic',
        ),
    })
    const host = new Host(createNativeAnthropicAdapter({ source }).adapter)
    const clean = sonnetPayload()
    // Replaying an OAuth-served conversation on an API route must remove
    // its safety-fallback opt-in and stored assistant fallback marker.
    const contaminated = {
      ...clean,
      fallbacks: 'default',
      messages: clean.messages.map((message, index) =>
        index === 1
          ? {
              ...message,
              content: [
                {
                  type: 'thinking',
                  thinking: SERVER_FALLBACK_MARKER_TEXT,
                  signature: `${SERVER_FALLBACK_SIGNATURE_PREFIX}claude-fable-5|claude-opus-5`,
                },
                ...message.content,
              ],
            }
          : message,
      ),
    }

    const { final } = await host.run(
      scopeOf(),
      hostRequest(contaminated, {
        headers: {
          'anthropic-beta': [
            SERVER_SIDE_FALLBACK_BETA,
            'oauth-2025-04-20',
            'claude-code-20250219',
            'fine-grained-tool-streaming-2025-05-14',
            'context-1m-2025-08-07',
          ].join(','),
        },
      }),
    )

    expect(final.headers.get('anthropic-beta')).toBe(
      'fine-grained-tool-streaming-2025-05-14,context-1m-2025-08-07',
    )
    expect(await bodyOf(final)).toEqual(clean)
    expect(final.headers.get('x-api-key')).toBe('sk-ant-api03-row-key')
    expect(final.headers.get('authorization')).toBeNull()
    expect(final.url).toBe(
      'https://gateway.example.com/anthropic/v1/messages?beta=true',
    )

    // If filtering leaves no beta values, omit the header rather than send it empty.
    const onlyOAuth = await host.run(
      scopeOf(),
      hostRequest(clean, {
        headers: {
          'anthropic-beta': `oauth-2025-04-20,${SERVER_SIDE_FALLBACK_BETA}`,
        },
      }),
    )
    expect(onlyOAuth.final.headers.get('anthropic-beta')).toBeNull()
  })

  test('caller-provided billing, effort, cache and fast options reach the body rewrite', async () => {
    const options: NativeAnthropicBodyOptions = {
      cache1hEnabled: true,
      cache1hMode: 'explicit',
      fastModeEnabled: true,
      billingLineage: {
        previousRequestId: 'req_011111111111111111111111',
        promptId: '00000000-0000-4000-8000-000000000001',
      },
    }
    const { source, seen } = makeSource({ options })
    const host = new Host(createNativeAnthropicAdapter({ source }).adapter)
    const payload = { ...sonnetPayload(), model: 'claude-opus-4-8' }

    const { final } = await host.run(
      scopeOf({ modelID: 'claude-opus-4-8' }),
      hostRequest(payload),
    )
    const body = await bodyOf(final)

    expect(body.speed).toBe('fast')
    expect(final.headers.get('anthropic-beta')?.split(',')).toContain(
      FAST_MODE_BETA,
    )
    expect(body.system[0]?.text).toContain(
      'cc_prev_req=req_011111111111111111111111',
    )
    expect(body.system[0]?.text).toContain(
      'cc_prompt_id=00000000-0000-4000-8000-000000000001',
    )
    expect(JSON.stringify(body)).toContain('"ttl":"1h"')
    expect(seen.requestOptions).toHaveLength(1)
    expect(seen.requestOptions[0]?.provenance).toEqual({
      custody: 'local',
      receipt: 'local:acct-local',
    })

    // Healthy companion: the same request through a source that returns no
    // options carries no `speed`, no fast-mode beta, no cc_prev_req or
    // cc_prompt_id lineage and no 1h cache TTL. Those values above therefore
    // came from the source's options, not from the wire request.
    const plain = new Host(
      createNativeAnthropicAdapter({ source: makeSource().source }).adapter,
    )
    const bare = await plain.run(
      scopeOf({ modelID: 'claude-opus-4-8' }),
      hostRequest(payload),
    )
    const bareBody = await bodyOf(bare.final)
    expect(bareBody.speed).toBeUndefined()
    expect(bare.final.headers.get('anthropic-beta')?.split(',')).not.toContain(
      FAST_MODE_BETA,
    )
    expect(bareBody.system[0]?.text).not.toContain('cc_prev_req=')
    expect(JSON.stringify(bareBody)).not.toContain('"ttl":"1h"')
  })

  test('strips internal correlation headers before upstream and hands them to the source', async () => {
    const internal = {
      'x-session-affinity': 'ses_alpha',
      'x-opencode-session': 'ses_alpha',
      'x-parent-session-id': 'ses_parent',
      [EFFORT_PLAN_REQUEST_HEADER]: 'plan-1',
      [BILLING_LINEAGE_REQUEST_HEADER]: 'lineage-1',
      [LANE_START_REQUEST_HEADER]: '1',
    }
    expect(Object.keys(internal).sort()).toEqual(
      INTERNAL_REQUEST_HEADERS.filter(
        (name) => name !== 'x-common-auth-attempt',
      ).sort(),
    )
    const oauthSource = makeSource()
    const apiSource = makeSource({
      authorize: () =>
        apiKey('sk-ant-api03-row-key', { custody: 'api', receipt: 'api:1' }),
    })
    for (const { source } of [oauthSource, apiSource]) {
      const host = new Host(createNativeAnthropicAdapter({ source }).adapter)
      const { final } = await host.run(
        scopeOf(),
        hostRequest(sonnetPayload(), { headers: internal }),
      )
      for (const name of INTERNAL_REQUEST_HEADERS) {
        expect(final.headers.get(name)).toBeNull()
      }
    }
    expect(oauthSource.seen.requestOptions[0]?.correlation).toEqual(internal)
  })

  test('preserves method, AbortSignal and unrelated headers', async () => {
    const { source } = makeSource()
    const host = new Host(createNativeAnthropicAdapter({ source }).adapter)
    const controller = new AbortController()

    const { final } = await host.run(
      scopeOf(),
      hostRequest(sonnetPayload(), { signal: controller.signal }),
    )

    expect(final.method).toBe('POST')
    expect(final.headers.get('x-host-trace')).toBe('trace-7')
    expect(final.signal.aborted).toBe(false)
    controller.abort(new Error('user stopped the turn'))
    expect(final.signal.aborted).toBe(true)
  })
})

describe('OpenCode 2 native Anthropic adapter: refusals', () => {
  test('a meaningful assistant tail is refused locally with zero sends and no reroute', async () => {
    const { source, seen } = makeSource()
    const native = createNativeAnthropicAdapter({ source })
    const host = new Host(native.adapter)
    const payload = sonnetPayload()
    payload.messages.push({
      role: 'assistant',
      content: [{ type: 'text', text: 'Here is the partial answer' }],
    })
    const started = await host.begin(scopeOf())

    const failure = await host
      .send(started, hostRequest(payload))
      .catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(NativeAnthropicLocalRefusal)
    expect((failure as NativeAnthropicLocalRefusal).message).toBe(
      TRAILING_ASSISTANT_HISTORY_MESSAGE,
    )
    expect((failure as NativeAnthropicLocalRefusal).check).toBe(
      'meaningful_trailing_assistant',
    )
    expect(host.sent).toHaveLength(0)
    const hostError = { type: 'api', message: 'refused', status: 429 }
    expect(
      native.adapter.limitFromError?.(hostError, started.attempt),
    ).toBeUndefined()
    expect(seen.hostErrors).toHaveLength(0)
    await native.adapter.onAttemptEnd?.(started.attempt, {
      outputStarted: false,
      error: { reason: 'failed', message: TRAILING_ASSISTANT_HISTORY_MESSAGE },
    })
    expect(seen.ends[0]?.outcome.localRefusal).toEqual({
      check: 'meaningful_trailing_assistant',
    })
    expect(seen.ends[0]?.outcome.status).toBeUndefined()

    // Healthy companion: an attempt that was sent leaves the host error to
    // the source's own policy, and an upstream 400 is no local refusal.
    const sent = await host.run(scopeOf(), hostRequest(sonnetPayload()))
    expect(native.adapter.limitFromError?.(hostError, sent.attempt)).toEqual({
      reason: 'host-429',
      status: 429,
    })
    await native.adapter.onAttemptEnd?.(sent.attempt, {
      status: 400,
      outputStarted: false,
    })
    expect(seen.ends[1]?.outcome.localRefusal).toBeUndefined()
    expect(seen.ends[1]?.outcome.status).toBe(400)
  })

  test('the API route refuses a meaningful assistant tail too', async () => {
    const { source } = makeSource({
      authorize: () =>
        apiKey('sk-ant-api03-row-key', { custody: 'api', receipt: 'api:1' }),
    })
    const host = new Host(createNativeAnthropicAdapter({ source }).adapter)
    const payload = sonnetPayload()
    payload.messages.push({
      role: 'assistant',
      content: [{ type: 'text', text: 'trailing' }],
    })

    const failure = await host
      .run(scopeOf(), hostRequest(payload))
      .catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(NativeAnthropicLocalRefusal)
    expect(host.sent).toHaveLength(0)
  })

  test('refuses with zero sends when the source has no account or credential', async () => {
    const cases: {
      name: string
      answers: Parameters<typeof makeSource>[0]
      error: typeof NativeAnthropicNoAccountError
    }[] = [
      {
        name: 'no account chosen',
        answers: { choose: () => undefined, chooseAccount: () => undefined },
        error: NativeAnthropicNoAccountError,
      },
      {
        name: 'authorization refused',
        answers: { authorize: () => undefined },
        error: NativeAnthropicNoAccountError,
      },
      {
        name: 'empty OAuth token',
        answers: {
          authorize: () => oauth('', { custody: 'local', receipt: 'x' }),
        },
        error: NativeAnthropicNoAccountError,
      },
      {
        name: 'API authorization without a credential header',
        answers: {
          authorize: () => ({
            route: 'api',
            headers: { 'x-api-key': null },
            provenance: { custody: 'api', receipt: 'api:1' },
          }),
        },
        error: NativeAnthropicNoAccountError,
      },
    ]
    for (const { name, answers, error } of cases) {
      const { source } = makeSource(answers)
      const host = new Host(createNativeAnthropicAdapter({ source }).adapter)
      const failure = await host
        .run(scopeOf(), hostRequest(sonnetPayload()))
        .catch((caught: unknown) => caught)
      expect(failure, name).toBeInstanceOf(error)
      if (!(failure instanceof Error))
        throw new Error('Expected a local refusal')
      expect(failure.message, name).toBe(NO_ACCOUNT_REFUSAL)
      expect(host.sent, name).toHaveLength(0)
    }
  })

  test('a source refusal raised while authorizing stops the request before dispatch', async () => {
    // A source that cannot serve the selected transport (a WebSocket relay on
    // OpenCode 2, say) refuses with its own error; the adapter neither
    // replaces it nor switches to another route.
    const unsupported = new Error(
      'websocket relay is not available on OpenCode 2',
    )
    const { source } = makeSource({
      authorizeAccount: () => {
        throw unsupported
      },
    })
    const native = createNativeAnthropicAdapter({ source })
    const host = new Host(native.adapter)

    const failure = await host
      .run(scopeOf(), hostRequest(sonnetPayload()))
      .catch((error: unknown) => error)

    expect(failure).toBe(unsupported)
    expect(host.sent).toHaveLength(0)
    expect(native.pendingSendCount).toBe(0)
  })

  test('moved account state refuses with a fixed message and zero sends', async () => {
    const relocated = new RelocatedError(
      '/config/opencode/anthropic-auth-native-state.json',
      {
        relocatedTo: '/state/cortexkit/anthropic-auth/opencode',
        stateRoot: '/state/cortexkit/anthropic-auth',
        identity: '/config/opencode',
        attempt: 'attempt-1',
        by: '2.4.0',
      },
    )
    const { source } = makeSource({
      authorizeAccount: () => {
        throw relocated
      },
    })
    const native = createNativeAnthropicAdapter({ source })
    const host = new Host(native.adapter)

    const failure = await host
      .run(scopeOf(), hostRequest(sonnetPayload()))
      .catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(NativeAnthropicStateRefusal)
    if (!(failure instanceof Error)) throw new Error('Expected a refusal')
    expect(failure.message).toBe(RELOCATED_MESSAGE)
    // The fixed text names no folder.
    expect(failure.message).not.toContain('/config')
    expect(failure.message).not.toContain('/state')
    expect(host.sent).toHaveLength(0)
    expect(native.pendingSendCount).toBe(0)

    // A pool operation wraps its hook's refusal and keeps it as the cause.
    const wrapped = makeSource({
      authorizeAccount: () => {
        throw new Error(relocated.message, { cause: relocated })
      },
    })
    const wrappedHost = new Host(
      createNativeAnthropicAdapter({ source: wrapped.source }).adapter,
    )
    expect(
      await wrappedHost
        .run(scopeOf(), hostRequest(sonnetPayload()))
        .catch((error: unknown) => error),
    ).toBeInstanceOf(NativeAnthropicStateRefusal)
    expect(wrappedHost.sent).toHaveLength(0)
  })
})

describe('OpenCode 2 native Anthropic adapter: responses', () => {
  for (const streaming of [false, true]) {
    for (const kind of ['ambiguous', 'overflow', 'parse']) {
      test(`${streaming ? 'SSE' : 'JSON'} ${kind} mapping refusal stays fixed and never becomes an account limit`, async () => {
        let classified = 0
        const { source } = makeSource({
          limitFromHostError: () => {
            classified++
            return undefined
          },
          limitFromResponse: () => {
            classified++
            return undefined
          },
          limitFromStreamError: () => {
            classified++
            return undefined
          },
        })
        const native = createNativeAnthropicAdapter({ source })
        const host = new Host(native.adapter)
        const payload = sonnetPayload()
        payload.tools = (
          kind === 'ambiguous'
            ? ['search', 'Search', 'mcp_Search']
            : ['search', 'mcp_Search']
        ).map((name) => ({
          ...payload.tools[0]!,
          name,
        }))
        payload.stream = streaming
        const { attempt, final } = await host.run(
          scopeOf(),
          hostRequest(payload),
        )
        const block = {
          type: 'tool_use',
          name: 'mcp_Search',
          input: {
            text: 'private provider prose',
            ...(kind === 'overflow'
              ? { query: 'x'.repeat(NON_STREAMING_DIAGNOSTICS_MAX_BYTES) }
              : {}),
          },
        }
        const text =
          kind === 'parse'
            ? streaming
              ? 'data: {"type":"content_block_start","content_block":{"type":"tool_use","name":"mcp_Search"}\n\n'
              : '{"type":"message","content":[{"type":"tool_use","name":"mcp_Search"}],'
            : streaming
              ? sse('content_block_start', {
                  type: 'content_block_start',
                  content_block: block,
                })
              : JSON.stringify({ type: 'message', content: [block] })
        const upstream = new Response(text, {
          headers: {
            'content-type': streaming
              ? 'text/event-stream'
              : 'application/json',
          },
        })
        const response = await native.adapter.rewriteResponse?.({
          ...attempt,
          request: final,
          response: upstream,
          attempt,
        })
        const failure: unknown = await (response as Response)
          .text()
          .catch((error: unknown) => error)
        expect(failure).toMatchObject({
          name: 'UnsafeToolNameResponseError',
          message: 'Response tool-name mapping could not be validated safely',
        })
        expect(failure).not.toHaveProperty('code')
        expect(failure).toMatchObject({ retryable: false, isRetryable: false })
        expect(failure).not.toHaveProperty('providerErrorType')
        expect(
          native.adapter.limitFromError?.(
            { type: 'provider_error', message: 'private host error prose' },
            attempt,
          ),
        ).toBeUndefined()
        let bodyReads = 0
        expect(
          await native.adapter.limitFromResponse?.({
            status: 200,
            headers: (response as Response).headers,
            body: async () => {
              bodyReads++
              return 'private provider prose'
            },
            attempt,
          }),
        ).toBeUndefined()
        expect(
          native.adapter.inspectEvent?.({
            ...attempt,
            transport: 'http',
            event: 'error',
            data: JSON.stringify({
              type: 'error',
              error: {
                type: 'rate_limit_error',
                message: 'private provider prose',
              },
            }),
            attempt,
          }),
        ).toBeUndefined()
        expect(bodyReads).toBe(0)
        expect(classified).toBe(0)
        expect(host.sent).toHaveLength(1)
        native.dispose()
      })
    }
  }

  test('never redirects declared host tools to AFT aliases', async () => {
    const { source } = makeSource()
    const native = createNativeAnthropicAdapter({ source })
    const host = new Host(native.adapter)
    const payload = sonnetPayload()
    const names = ['search', 'move', 'delete', 'import']
    payload.tools = names.flatMap((name) =>
      [name, `aft_${name}`].map((name) => ({ ...payload.tools[0]!, name })),
    )
    const { attempt } = await host.run(scopeOf(), hostRequest(payload))
    const wireNames = names.flatMap((name) => [
      `mcp_${name[0]!.toUpperCase()}${name.slice(1)}`,
      name,
    ])
    const upstream = wireNames
      .map((name, index) =>
        sse('content_block_start', {
          type: 'content_block_start',
          index,
          content_block: {
            type: 'tool_use',
            id: `toolu_${index}`,
            name,
            input: {},
          },
        }),
      )
      .join('')
    const response = await native.adapter.rewriteResponse?.({
      ...attempt,
      request: host.sent[0] as Request,
      response: sseResponse(upstream),
      attempt,
    })
    const text = await (response as Response).text()
    const restored = text
      .split('\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => JSON.parse(line.slice(6)).content_block.name)
    expect(restored).toEqual(names.flatMap((name) => [name, name]))
  })

  test('keeps concurrent OAuth response bindings separate within one session', async () => {
    const { source } = makeSource()
    const native = createNativeAnthropicAdapter({ source })
    const host = new Host(native.adapter)
    const sends = await Promise.all(
      ['aft_search', 'ctx_search', 'bash'].map(async (name) => {
        const payload = sonnetPayload()
        payload.tools = [{ ...payload.tools[0]!, name }]
        return host.run(scopeOf(), hostRequest(payload))
      }),
    )
    const names = await Promise.all(
      sends.map(async ({ attempt, final }) => {
        const response = await native.adapter.rewriteResponse?.({
          ...attempt,
          request: final,
          response: sseResponse(
            sse('content_block_start', {
              type: 'content_block_start',
              index: 0,
              content_block: {
                type: 'tool_use',
                id: 'toolu_isolated',
                name: 'mcp_Search',
                input: {},
              },
            }),
          ),
          attempt,
        })
        const text = await (response as Response).text()
        return JSON.parse(
          text
            .split('\n')
            .find((line) => line.startsWith('data: '))!
            .slice(6),
        ).content_block.name
      }),
    )
    expect(names).toEqual(['aft_search', 'ctx_search', 'mcp_Search'])
  })

  test('maps tool names back, keeps upstream headers and reports observations with provenance', async () => {
    const starts: {
      message: Record<string, unknown>
      provenance: Provenance
    }[] = []
    const completions: string[] = []
    const quotaReads: {
      quota: Quota
      context: NativeAnthropicResponseContext<Provenance>
    }[] = []
    const vault: Provenance = {
      custody: 'vault',
      receipt: 'rcpt-9',
      version: 7,
    }
    const { source } = makeSource({
      authorize: () => oauth('sk-ant-oat01-vault-token', vault),
      responseOptions: (context) => ({
        onMessageStart: (message) =>
          starts.push({ message, provenance: context.provenance }),
        onComplete: (reason) => completions.push(reason),
      }),
      quotaFromHeaders: (headers, context) => {
        const quota = {
          unified: headers.get('anthropic-ratelimit-unified-5h-utilization'),
          scoped: headers.get(
            'anthropic-ratelimit-unified-7d_opus-utilization',
          ),
        }
        quotaReads.push({ quota, context })
        return quota
      },
    })
    const native = createNativeAnthropicAdapter({ source })
    const host = new Host(native.adapter)
    const { attempt } = await host.run(scopeOf(), hostRequest(sonnetPayload()))
    const upstream = sseResponse(PREFIXED_STREAM.join(''))

    const quota = native.adapter.quotaFromHeaders?.(
      upstream.headers,
      200,
      attempt,
    )
    const response = await native.adapter.rewriteResponse?.({
      ...attempt,
      request: host.sent[0] as Request,
      response: upstream,
      attempt,
    })
    const text = await (response as Response).text()

    expect(quota).toEqual({ unified: '0.42', scoped: null })
    expect(quotaReads).toHaveLength(1)
    expect(quotaReads[0]?.context.provenance).toBe(vault)
    expect(quotaReads[0]?.context.status).toBe(200)
    expect(text).toContain('"name":"bash"')
    expect(text).not.toContain('mcp_Bash')
    expect((response as Response).headers.get('request-id')).toBe(
      'req_011CTestUpstream000000001',
    )
    expect(
      (response as Response).headers.get('anthropic-ratelimit-unified-status'),
    ).toBe('allowed')
    expect(starts).toHaveLength(1)
    expect(starts[0]?.provenance).toBe(vault)
    expect(starts[0]?.message.usage).toMatchObject({ input_tokens: 120 })
    expect(completions).toEqual(['tool_use'])
  })

  test('an API response reaches the host unchanged', async () => {
    const { source } = makeSource({
      authorize: () =>
        apiKey('sk-ant-api03-row-key', { custody: 'api', receipt: 'api:1' }),
    })
    const native = createNativeAnthropicAdapter({ source })
    const host = new Host(native.adapter)
    const { attempt } = await host.run(scopeOf(), hostRequest(sonnetPayload()))
    // An API request's tools were never renamed, so a tool genuinely called
    // `search` must come back as `search`.
    const stream = sse('content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: {
        type: 'tool_use',
        id: 'toolu_03',
        name: 'search',
        input: {},
      },
    })
    const upstream = sseResponse(stream)

    const response =
      (await native.adapter.rewriteResponse?.({
        ...attempt,
        request: host.sent[0] as Request,
        response: upstream,
        attempt,
      })) ?? upstream

    expect(await response.text()).toBe(stream)
  })

  test('forwards genuine error responses to the source policy with provenance', async () => {
    const vault: Provenance = {
      custody: 'vault',
      receipt: 'rcpt-3',
      version: 12,
    }
    const classified: {
      status: number
      retryAfter: string | null
      body: string
      provenance: Provenance
    }[] = []
    const { source } = makeSource({
      authorize: () => oauth('sk-ant-oat01-vault-token', vault),
      limitFromResponse: async ({ status, headers, body, provenance }) => {
        classified.push({
          status,
          retryAfter: headers.get('retry-after'),
          body: await body(),
          provenance,
        })
        return status === 429
          ? { reason: 'model-scoped:7d_opus', status, retryAfterMs: 30_000 }
          : undefined
      },
    })
    const native = createNativeAnthropicAdapter({ source })
    const host = new Host(native.adapter)
    const { attempt } = await host.run(scopeOf(), hostRequest(sonnetPayload()))
    const errorBody = JSON.stringify({
      type: 'error',
      error: { type: 'rate_limit_error', message: 'Opus weekly limit' },
    })
    const upstream = new Response(errorBody, {
      status: 429,
      headers: { 'retry-after': '30', 'content-type': 'application/json' },
    })

    const limit = await native.adapter.limitFromResponse?.({
      status: upstream.status,
      headers: upstream.headers,
      body: () => upstream.clone().text(),
      attempt,
    })

    expect(limit).toEqual({
      reason: 'model-scoped:7d_opus',
      status: 429,
      retryAfterMs: 30_000,
    })
    expect(classified).toEqual([
      { status: 429, retryAfter: '30', body: errorBody, provenance: vault },
    ])
    // The source read the body through a clone, so the host's own response
    // body is still unread and complete.
    expect(await upstream.text()).toBe(errorBody)
  })

  test('inspects deterministic SSE: output, end and stream errors', async () => {
    const streamErrors: { errorType?: string; provenance: Provenance }[] = []
    const { source } = makeSource({
      limitFromStreamError: ({ errorType, provenance }) => {
        streamErrors.push({ ...(errorType ? { errorType } : {}), provenance })
        return errorType === 'rate_limit_error'
          ? { reason: 'account:5h' }
          : undefined
      },
    })
    const native = createNativeAnthropicAdapter({ source })
    const host = new Host(native.adapter)
    const { attempt } = await host.run(scopeOf(), hostRequest(sonnetPayload()))
    const verdict = (text: string) => {
      const [eventLine, dataLine] = text.trim().split('\n')
      return native.adapter.inspectEvent?.({
        transport: 'http',
        event: eventLine?.slice('event: '.length),
        data: dataLine?.slice('data: '.length) ?? '',
        attempt,
      })
    }

    expect(PREFIXED_STREAM.map(verdict)).toEqual([
      undefined,
      undefined,
      { outputStarted: true },
      { outputStarted: true },
      undefined,
      undefined,
      { done: true },
    ])
    const limited = verdict(
      sse('error', {
        type: 'error',
        error: { type: 'rate_limit_error', message: 'Rate limited' },
      }),
    )
    expect(limited).toEqual({
      error: 'rate_limit_error: Rate limited',
      limit: { reason: 'account:5h' },
    })
    const overloaded = verdict(
      sse('error', {
        type: 'error',
        error: { type: 'overloaded_error', message: 'Overloaded' },
      }),
    )
    expect(overloaded).toEqual({ error: 'overloaded_error: Overloaded' })
    expect(streamErrors.map((entry) => entry.errorType)).toEqual([
      'rate_limit_error',
      'overloaded_error',
    ])
    expect(streamErrors[0]?.provenance).toEqual({
      custody: 'local',
      receipt: 'local:acct-local',
    })
  })

  test('cancelling the mapped response body cancels the upstream body', async () => {
    const { source } = makeSource()
    const native = createNativeAnthropicAdapter({ source })
    const host = new Host(native.adapter)
    const { attempt } = await host.run(scopeOf(), hostRequest(sonnetPayload()))
    const cancelled: unknown[] = []
    const upstream = sseResponse(PREFIXED_STREAM.join(''), (reason) =>
      cancelled.push(reason),
    )

    const response = (await native.adapter.rewriteResponse?.({
      ...attempt,
      request: host.sent[0] as Request,
      response: upstream,
      attempt,
    })) as Response
    const reader = (response.body as ReadableStream<Uint8Array>).getReader()
    await reader.read()
    await reader.cancel('user stopped the turn')

    expect(cancelled).toEqual(['user stopped the turn'])
  })
})

describe('OpenCode 2 native Anthropic adapter: attempts and lifecycle', () => {
  test('each send keeps its own credential and provenance', async () => {
    let issued = 0
    const tokens: string[] = []
    const { source, seen } = makeSource({
      authorize: (_scope, accountId) => {
        issued++
        const token = `sk-ant-oat01-${accountId}-${issued}`
        tokens.push(token)
        return oauth(token, {
          custody: 'vault',
          receipt: `rcpt-${issued}`,
          version: issued,
        })
      },
    })
    const native = createNativeAnthropicAdapter({ source })
    const host = new Host(native.adapter)

    // Two sends of one session and account, authorized before either is sent.
    const first = await host.begin(scopeOf())
    const second = await host.begin(scopeOf())
    const secondFinal = await host.send(second, hostRequest(sonnetPayload()))
    const firstFinal = await host.send(first, hostRequest(sonnetPayload()))

    expect(firstFinal.headers.get('authorization')).toBe(`Bearer ${tokens[0]}`)
    expect(secondFinal.headers.get('authorization')).toBe(`Bearer ${tokens[1]}`)
    expect(
      seen.requestOptions.map((entry) => entry.provenance.receipt),
    ).toEqual(['rcpt-2', 'rcpt-1'])
    await native.adapter.onAttemptEnd?.(first.attempt, {
      status: 401,
      outputStarted: false,
    })
    await native.adapter.onAttemptEnd?.(second.attempt, {
      status: 200,
      outputStarted: true,
    })
    expect(
      seen.ends.map((end) => [
        end.context.attemptId,
        end.context.provenance.version,
        end.outcome.status,
      ]),
    ).toEqual([
      [first.attempt.attemptId, 1, 401],
      [second.attempt.attemptId, 2, 200],
    ])
  })

  test('a credential is released once its send is rewritten, ended or forgotten', async () => {
    const { source, seen } = makeSource()
    const native = createNativeAnthropicAdapter({ source })
    const host = new Host(native.adapter)

    const rewritten = await host.begin(scopeOf())
    const ended = await host.begin(scopeOf({ kind: 'title' }))
    const forgotten = await host.begin(scopeOf({ sessionID: 'ses_beta' }))
    expect(native.heldCredentialCount).toBe(3)

    await host.send(rewritten, hostRequest(sonnetPayload()))
    expect(native.heldCredentialCount).toBe(2)
    // One authorization serves one send: sending it again is refused.
    const again = await host
      .send(rewritten, hostRequest(sonnetPayload()))
      .catch((error: unknown) => error)
    expect(again).toBeInstanceOf(NativeAnthropicNoAccountError)
    expect(host.sent).toHaveLength(1)

    await native.adapter.onAttemptEnd?.(ended.attempt, {
      outputStarted: false,
      error: { reason: 'abandoned' },
    })
    expect(native.heldCredentialCount).toBe(1)

    native.forgetSession('ses_beta')
    expect(native.heldCredentialCount).toBe(0)
    expect(native.pendingSendCount).toBe(0)
    expect(seen.forgotten).toEqual(['ses_beta'])
    const late = await host
      .send(forgotten, hostRequest(sonnetPayload()))
      .catch((error: unknown) => error)
    expect(late).toBeInstanceOf(NativeAnthropicNoAccountError)
    expect(host.sent).toHaveLength(1)
  })

  test('forgetting a session revokes an authorization still in progress', async () => {
    const gates = new Map<
      string,
      (auth: NativeAnthropicAuthorization<Provenance>) => void
    >()
    const { source } = makeSource({
      authorizeAccount: (scope) =>
        new Promise((resolve) => gates.set(scope.sessionID, resolve)),
    })
    const native = createNativeAnthropicAdapter({ source })
    const host = new Host(native.adapter)

    const forgotten = host.begin(scopeOf()).catch((error: unknown) => error)
    const fresh = host.begin(scopeOf({ sessionID: 'ses_fresh' }))
    await until(() => gates.size === 2)
    expect(native.operationsInProgress).toBe(2)
    native.forgetSession('ses_alpha')
    gates.get('ses_alpha')?.(
      oauth('sk-ant-oat01-forgotten', {
        custody: 'vault',
        receipt: 'rcpt-old',
      }),
    )
    gates.get('ses_fresh')?.(
      oauth('sk-ant-oat01-fresh', { custody: 'vault', receipt: 'rcpt-new' }),
    )

    expect(await forgotten).toBeInstanceOf(NativeAnthropicRevokedError)
    const healthy = await fresh
    expect(healthy.edits.authorization).toBe('Bearer sk-ant-oat01-fresh')
    expect(native.heldCredentialCount).toBe(1)
    expect(native.pendingSendCount).toBe(1)
    expect(native.operationsInProgress).toBe(0)
    await host.send(healthy, hostRequest(sonnetPayload()))
    expect(host.sent.map((sent) => sent.headers.get('authorization'))).toEqual([
      'Bearer sk-ant-oat01-fresh',
    ])
    expect(native.heldCredentialCount).toBe(0)

    // New work for the cleared session is served normally.
    gates.clear()
    const again = host.begin(scopeOf())
    await until(() => gates.has('ses_alpha'))
    gates.get('ses_alpha')?.(
      oauth('sk-ant-oat01-after-clear', { custody: 'local', receipt: 'r' }),
    )
    expect((await again).edits.authorization).toBe(
      'Bearer sk-ant-oat01-after-clear',
    )
  })

  test('forgetting a session revokes an account choice still in progress', async () => {
    const gates = new Map<string, (accountId: string) => void>()
    const { source } = makeSource({
      chooseAccount: (input) =>
        new Promise((resolve) => gates.set(input.sessionID, resolve)),
    })
    const native = createNativeAnthropicAdapter({ source })

    const forgotten = Promise.resolve(
      native.adapter.chooseAccount(scopeOf()),
    ).catch((error: unknown) => error)
    const fresh = Promise.resolve(
      native.adapter.chooseAccount(scopeOf({ sessionID: 'ses_fresh' })),
    )
    await until(() => gates.size === 2)
    native.forgetSession('ses_alpha')
    gates.get('ses_alpha')?.('acct-stale')
    gates.get('ses_fresh')?.('acct-fresh')

    expect(await forgotten).toBeInstanceOf(NativeAnthropicRevokedError)
    expect(await fresh).toBe('acct-fresh')
    expect(native.operationsInProgress).toBe(0)
  })

  test('forgetting a session revokes a request rewrite still in progress', async () => {
    resetPinnedFirstUserTextsForTest()
    const gates = new Map<string, () => void>()
    const { source } = makeSource({
      requestOptions: (input) =>
        new Promise<NativeAnthropicBodyOptions>((resolve) =>
          gates.set(input.sessionID, () => resolve({})),
        ),
    })
    const native = createNativeAnthropicAdapter({ source })
    const host = new Host(native.adapter)
    const forgottenSend = await host.begin(scopeOf())
    const freshSend = await host.begin(scopeOf({ sessionID: 'ses_fresh' }))

    const forgotten = host
      .send(forgottenSend, hostRequest(sonnetPayload()))
      .catch((error: unknown) => error)
    const fresh = host.send(freshSend, hostRequest(sonnetPayload()))
    await until(() => gates.size === 2)
    native.forgetSession('ses_alpha')
    gates.get('ses_alpha')?.()
    gates.get('ses_fresh')?.()

    expect(await forgotten).toBeInstanceOf(NativeAnthropicRevokedError)
    await fresh
    expect(host.sent).toHaveLength(1)
    expect(host.sent[0]?.headers.get('authorization')).toBe(
      'Bearer sk-ant-oat01-local-token',
    )
    expect(native.heldCredentialCount).toBe(0)
    expect(native.pendingSendCount).toBe(0)
    expect(native.operationsInProgress).toBe(0)
    // Body rewriting pins first-user text for billing. Session revocation
    // must prevent that side effect, while the fresh session still receives it.
    expect(hasPinnedFirstUserTextForTest('ses_alpha')).toBe(false)
    expect(hasPinnedFirstUserTextForTest('ses_fresh')).toBe(true)
  })

  test('a session forgotten while the request body is read never reaches the source options or the body rewrite', async () => {
    resetPinnedFirstUserTextsForTest()
    const { source, seen } = makeSource()
    const native = createNativeAnthropicAdapter({ source })
    const host = new Host(native.adapter)
    let releaseBody!: () => void
    const bodyGate = new Promise<void>((resolve) => {
      releaseBody = resolve
    })
    const text = JSON.stringify(sonnetPayload())
    const slowBody = new Request(UPSTREAM, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: new ReadableStream<Uint8Array>({
        async pull(controller) {
          await bodyGate
          controller.enqueue(new TextEncoder().encode(text))
          controller.close()
        },
      }),
      duplex: 'half',
    } as RequestInit)
    const started = await host.begin(scopeOf())

    const forgotten = host
      .send(started, slowBody)
      .catch((error: unknown) => error)
    await until(() => native.operationsInProgress === 1)
    native.forgetSession('ses_alpha')
    releaseBody()

    expect(await forgotten).toBeInstanceOf(NativeAnthropicRevokedError)
    expect(seen.requestOptions).toHaveLength(0)
    expect(hasPinnedFirstUserTextForTest('ses_alpha')).toBe(false)
    expect(host.sent).toHaveLength(0)
    expect(native.operationsInProgress).toBe(0)

    // Clearing ses_alpha must not prevent a fresh session's send.
    await host.run(
      scopeOf({ sessionID: 'ses_fresh' }),
      hostRequest(sonnetPayload()),
    )
    expect(seen.requestOptions).toHaveLength(1)
    expect(host.sent).toHaveLength(1)
  })

  test('work forgotten at its settlement boundary returns nothing', async () => {
    // Clear the session two microtasks after releasing the source reply.
    // Authorization's internal check has passed, but the outer tracked
    // operation has not yet returned its result to the caller.
    const replay = async (
      run: (
        native: NativeAnthropicAdapter<Quota, Provenance>,
        gate: Promise<void>,
      ) => Promise<unknown>,
      source: (
        waitOn: () => Promise<void>,
      ) => NativeAnthropicSource<Quota, Provenance>,
    ) => {
      let release!: () => void
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      let waiting = false
      const waitOn = () => {
        waiting = true
        return gate
      }
      const native = createNativeAnthropicAdapter({ source: source(waitOn) })
      const work = run(native, gate)
      await until(() => waiting)
      release()
      queueMicrotask(() =>
        queueMicrotask(() => native.forgetSession('ses_alpha')),
      )
      const outcome = await work.catch((error: unknown) => error)
      return { native, outcome }
    }
    const healthy = makeSource().source

    const authorized = await replay(
      (native) =>
        Promise.resolve(
          native.adapter.accountHeaders({ ...scopeOf(), accountId: 'acct' }),
        ),
      (waitOn) => ({
        ...healthy,
        authorizeAccount: async () => {
          await waitOn()
          return oauth('sk-ant-oat01-late', { custody: 'vault', receipt: 'r' })
        },
      }),
    )
    expect(authorized.outcome).toBeInstanceOf(NativeAnthropicRevokedError)
    expect(authorized.native.heldCredentialCount).toBe(0)
    expect(authorized.native.pendingSendCount).toBe(0)
    expect(authorized.native.operationsInProgress).toBe(0)

    const chosen = await replay(
      (native) => Promise.resolve(native.adapter.chooseAccount(scopeOf())),
      (waitOn) => ({
        ...healthy,
        chooseAccount: async () => {
          await waitOn()
          return 'acct-late'
        },
      }),
    )
    expect(chosen.outcome).toBeInstanceOf(NativeAnthropicRevokedError)
    expect(chosen.native.operationsInProgress).toBe(0)

    const sent: Request[] = []
    const rewritten = await replay(
      async (native) => {
        const host = new Host(native.adapter)
        const started = await host.begin(scopeOf())
        return host
          .send(started, hostRequest(sonnetPayload()))
          .finally(() => sent.push(...host.sent))
      },
      (waitOn) => ({
        ...healthy,
        requestOptions: async () => {
          await waitOn()
          return {}
        },
      }),
    )
    expect(rewritten.outcome).toBeInstanceOf(NativeAnthropicRevokedError)
    expect(sent).toHaveLength(0)
    expect(rewritten.native.heldCredentialCount).toBe(0)
    expect(rewritten.native.operationsInProgress).toBe(0)

    // New work for ses_alpha must succeed after forgetSession clears its old work.
    const native = createNativeAnthropicAdapter({ source: healthy })
    native.forgetSession('ses_alpha')
    const host = new Host(native.adapter)
    const after = await host.run(scopeOf(), hostRequest(sonnetPayload()))
    expect(after.final.headers.get('authorization')).toBe(
      'Bearer sk-ant-oat01-local-token',
    )
    expect(host.sent).toHaveLength(1)
  })

  test('pending sends stay bounded and an evicted send is never sent', async () => {
    const warnings: string[] = []
    const { source } = makeSource({
      authorize: () =>
        apiKey(
          'sk-ant-api03-row-key',
          { custody: 'api', receipt: 'api:1' },
          'https://gateway.example.com',
        ),
    })
    const native = createNativeAnthropicAdapter({
      source,
      maxPendingSends: 2,
      log: { warn: (message) => warnings.push(message) },
    })
    const host = new Host(native.adapter)

    const oldest = await host.begin(scopeOf())
    await host.begin(scopeOf())
    await host.begin(scopeOf())

    expect(native.pendingSendCount).toBe(2)
    expect(warnings).toHaveLength(1)
    const failure = await host
      .send(oldest, hostRequest(sonnetPayload()))
      .catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(NativeAnthropicNoAccountError)
    expect(host.sent).toHaveLength(0)
  })

  test('onAttemptEnd stops waiting for a source that never settles', async () => {
    const warnings: string[] = []
    const { source } = makeSource({
      onAttemptEnd: () => new Promise<void>(() => {}),
    })
    const native = createNativeAnthropicAdapter({
      source,
      attemptEndTimeoutMs: 20,
      log: { warn: (message) => warnings.push(message) },
    })
    const host = new Host(native.adapter)
    const { attempt } = await host.begin(scopeOf())

    const settled = await Promise.race([
      Promise.resolve(
        native.adapter.onAttemptEnd?.(attempt, {
          status: 200,
          outputStarted: true,
        }),
      ).then(() => 'settled'),
      new Promise((resolve) => setTimeout(() => resolve('stuck'), 1_000)),
    ])

    expect(settled).toBe('settled')
    expect(warnings).toEqual([
      'the account source did not finish recording a send',
    ])
  })
})

// These conditional types resolve to false for rejected inputs. Assigning
// false below fails compilation if a contract accidentally accepts one.
type ContractAccepts<Expected, Candidate> = Candidate extends Expected
  ? true
  : false

function contractChecks(_scope: RequestScope, limit: LimitSignal) {
  const healthy: NativeAnthropicSource<Quota, Provenance> = {
    chooseAccount: (input) => input.previousAccountId ?? 'acct',
    authorizeAccount: () => oauth('t', { custody: 'local', receipt: 'r' }),
    requestOptions: () => ({ cache1hEnabled: true }),
    limitFromStreamError: () => limit,
  }
  const typed: OpenCode2AuthAdapter<Quota, Data, ChooseAccountResult> =
    createNativeAnthropicAdapter({ source: healthy }).adapter
  type Source = NativeAnthropicSource<Quota, Provenance>
  const rejected: {
    narrowChoose: ContractAccepts<
      Source['chooseAccount'],
      (input: RequestScope & { variant: string }) => string
    >
    narrowAuthorize: ContractAccepts<
      Source['authorizeAccount'],
      (
        input: RequestScope & { kind: 'title' },
        accountId: string,
      ) => ReturnType<typeof oauth>
    >
    ownedIdentity: ContractAccepts<
      Source['requestOptions'],
      () => { identity: typeof IDENTITY }
    >
    ownedSession: ContractAccepts<
      Source['requestOptions'],
      () => { sessionId: string }
    >
    resend: ContractAccepts<
      Source['responseOptions'],
      () => { onContentFilter: () => true }
    >
    tokenless: ContractAccepts<
      NativeAnthropicAuthorization<Provenance>,
      { route: 'oauth'; provenance: Provenance }
    >
  } = {
    narrowChoose: false,
    narrowAuthorize: false,
    ownedIdentity: false,
    ownedSession: false,
    resend: false,
    tokenless: false,
  }
  void [typed, rejected]
}
void contractChecks

describe('OpenCode 2 native Anthropic adapter: request-body gzip', () => {
  // The host performs the physical fetch; these tests send the adapter's
  // final request to a loopback server so the exact wire bytes are checked.
  let upstream: ReturnType<typeof Bun.serve> | undefined
  const received: Array<{ headers: Headers; body: Uint8Array }> = []
  beforeEach(() => {
    received.length = 0
    upstream = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        received.push({
          headers: new Headers(request.headers),
          body: new Uint8Array(await request.arrayBuffer()),
        })
        return new Response('{}', { status: 200 })
      },
    })
  })
  afterEach(() => {
    upstream?.stop(true)
  })

  const largePayload = () => {
    const payload = sonnetPayload()
    payload.messages[0] = {
      role: 'user',
      content: [{ type: 'text', text: `Review: ${'x'.repeat(9000)}` }],
    }
    return payload
  }

  async function wire(final: Request) {
    const response = await fetch(
      `http://127.0.0.1:${upstream?.port}/v1/messages`,
      {
        method: 'POST',
        headers: final.headers,
        body: await final.clone().arrayBuffer(),
      },
    )
    await response.text()
    return received.at(-1)!
  }

  test('a large OAuth body goes out gzipped; a proxy rejection latches the next one off', async () => {
    const { source } = makeSource()
    const latch = new RequestGzipLatch()
    const native = createNativeAnthropicAdapter({
      source,
      requestGzipLatch: latch,
    })
    const host = new Host(native.adapter)

    const { final, attempt } = await host.run(
      scopeOf(),
      hostRequest(largePayload()),
    )
    const sent = await wire(final)
    expect(sent.headers.get('content-encoding')).toBe('gzip')
    expect(sent.headers.get('x-claude-code-request-class')).toBe('main')
    const plain = new TextDecoder().decode(gunzipSync(sent.body))
    const trimmed = plain.trimEnd()
    expect(plain.slice(trimmed.length)).toMatch(/^\n[ \t]{0,256}$/)
    expect(extractBillingHeaderCCH(trimmed)).toBe('00000')

    // No hook can resend here: the rejection is classified and latched, and
    // the host's next request goes out uncompressed and signed.
    await native.adapter.rewriteResponse?.({
      ...attempt,
      request: final,
      response: new Response('Bad Request', { status: 400 }),
      attempt,
    })
    await until(() => latch.latchedThisProcess)
    const next = await host.run(scopeOf(), hostRequest(largePayload()))
    const identity = await wire(next.final)
    expect(identity.headers.get('content-encoding')).toBeNull()
    const text = new TextDecoder().decode(identity.body)
    expect(extractBillingHeaderCCH(text)).not.toBe('00000')
    expect(await signRequestBody(text)).toBe(text)
  })

  test('an ordinary API 400 does not latch gzip off', async () => {
    const { source } = makeSource()
    const latch = new RequestGzipLatch()
    const native = createNativeAnthropicAdapter({
      source,
      requestGzipLatch: latch,
    })
    const host = new Host(native.adapter)
    const { final, attempt } = await host.run(
      scopeOf(),
      hostRequest(largePayload()),
    )
    expect(final.headers.get('content-encoding')).toBe('gzip')
    await native.adapter.rewriteResponse?.({
      ...attempt,
      request: final,
      response: Response.json(
        {
          type: 'error',
          error: { type: 'invalid_request_error', message: 'max_tokens' },
        },
        { status: 400, headers: { 'request-id': 'req_011CTestOrdinary0001' } },
      ),
      attempt,
    })
    await Bun.sleep(5)
    expect(latch.latchedThisProcess).toBe(false)
  })

  test('title requests are auxiliary; the HTTP relay envelope stays identity', async () => {
    const { source } = makeSource({
      authorize: () =>
        oauth(
          'sk-ant-oat01-local-token',
          { custody: 'local', receipt: 'local:relay' },
          {
            dispatch: {
              kind: 'http-relay',
              url: 'https://relay.invalid/send',
              token: 'relay-secret',
            },
          },
        ),
    })
    const native = createNativeAnthropicAdapter({
      source,
      requestGzipLatch: new RequestGzipLatch(),
    })
    const host = new Host(native.adapter)
    const { final } = await host.run(
      scopeOf({ agent: 'title' }),
      hostRequest(largePayload()),
    )
    expect(new URL(final.url).host).toBe('relay.invalid')
    expect(final.headers.get('content-encoding')).toBeNull()
    const envelope = JSON.parse(await final.clone().text())
    expect(envelope.upstream.headers['content-encoding']).toBeUndefined()
    expect(envelope.upstream.headers['x-claude-code-request-class']).toBe(
      'auxiliary',
    )
    expect(await signRequestBody(envelope.body)).toBe(envelope.body)
    expect(extractBillingHeaderCCH(envelope.body)).not.toBe('00000')
  })
})

/**
 * A stand-in for a host chosen by a repository's provider baseURL. Every
 * request that reaches it is recorded with its credential headers.
 */
function loopbackServer() {
  const received: Array<{
    url: string
    authorization: string | null
    apiKey: string | null
  }> = []
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      received.push({
        url: request.url,
        authorization: request.headers.get('authorization'),
        apiKey: request.headers.get('x-api-key'),
      })
      return new Response('{}', {
        headers: { 'content-type': 'application/json' },
      })
    },
  })
  return { origin: server.url.origin, received, stop: () => server.stop(true) }
}

describe('OpenCode 2 native Anthropic adapter: OAuth destination', () => {
  const OAUTH_TOKEN = 'sk-ant-oat01-destination-canary'

  /**
   * Runs one attempt the way the host does and, when the adapter returns a
   * request, sends it for real. Returns the started attempt and its failure,
   * which is undefined when the request was sent.
   */
  async function attempt(host: Host, request: Request) {
    const started = await host.begin(scopeOf())
    try {
      const final = await host.send(started, request)
      await (await fetch(final)).text()
      return { started, failure: undefined }
    } catch (failure) {
      return { started, failure }
    }
  }

  function expectDestinationRefusal(failure: unknown, origin: string) {
    expect(failure).toBeInstanceOf(NativeAnthropicLocalRefusal)
    const refusal = failure as NativeAnthropicLocalRefusal
    expect(refusal.check).toBe('oauth_destination')
    expect(refusal.message).toBe(ANTHROPIC_OAUTH_ORIGIN_REFUSAL)
    expect(refusal.message).not.toContain(new URL(origin).host)
    expect(refusal.message).not.toContain(OAUTH_TOKEN)
  }

  for (const dispatch of ['direct', 'http-relay'] as const) {
    test(`a provider baseURL on a loopback server receives no ${dispatch} OAuth request, including the host retry`, async () => {
      const upstream = loopbackServer()
      const relay = loopbackServer()
      try {
        const { source, seen } = makeSource({
          authorize: () =>
            oauth(
              OAUTH_TOKEN,
              { custody: 'vault', receipt: 'vault:1', version: 1 },
              dispatch === 'http-relay'
                ? {
                    dispatch: {
                      kind: 'http-relay',
                      url: `${relay.origin}/send`,
                      token: 'relay-secret',
                    },
                  }
                : {},
            ),
        })
        const native = createNativeAnthropicAdapter({ source })
        const host = new Host(native.adapter)
        // The first attempt and the host's retry of it both go through the
        // adapter again; neither may reach the configured server.
        for (const _ of [1, 2]) {
          const { started, failure } = await attempt(
            host,
            hostRequest(sonnetPayload(), {
              url: `${upstream.origin}/v1/messages`,
            }),
          )
          expectDestinationRefusal(failure, upstream.origin)
          // A refused destination is not an account limit: nothing reroutes.
          expect(
            native.adapter.limitFromError?.(
              { type: 'api', message: 'refused', status: 401 },
              started.attempt,
            ),
          ).toBeUndefined()
          await native.adapter.onAttemptEnd?.(started.attempt, {
            outputStarted: false,
            error: {
              reason: 'failed',
              message: ANTHROPIC_OAUTH_ORIGIN_REFUSAL,
            },
          })
        }
        expect(host.sent).toHaveLength(0)
        expect(upstream.received).toEqual([])
        expect(relay.received).toEqual([])
        expect(seen.hostErrors).toHaveLength(0)
        expect(seen.ends.map((end) => end.outcome.localRefusal)).toEqual([
          { check: 'oauth_destination' },
          { check: 'oauth_destination' },
        ])
        expect(seen.ends.map((end) => end.outcome.status)).toEqual([
          undefined,
          undefined,
        ])
      } finally {
        upstream.stop()
        relay.stop()
      }
    })
  }

  test('the official origin still sends OAuth, and refuses redirects', async () => {
    const { source } = makeSource({
      authorize: () =>
        oauth(OAUTH_TOKEN, { custody: 'local', receipt: 'local:1' }),
    })
    const host = new Host(createNativeAnthropicAdapter({ source }).adapter)
    const { final } = await host.run(scopeOf(), hostRequest(sonnetPayload()))
    expect(new URL(final.url).origin).toBe('https://api.anthropic.com')
    expect(final.headers.get('authorization')).toBe(`Bearer ${OAUTH_TOKEN}`)
    expect(final.redirect).toBe('error')
  })

  test('ANTHROPIC_BASE_URL on a foreign origin is refused for OAuth and honoured for API keys', async () => {
    const upstream = loopbackServer()
    try {
      process.env.ANTHROPIC_BASE_URL = upstream.origin
      const oauthHost = new Host(
        createNativeAnthropicAdapter({
          source: makeSource({
            authorize: () =>
              oauth(OAUTH_TOKEN, { custody: 'local', receipt: 'local:1' }),
          }).source,
        }).adapter,
      )
      const refused = await attempt(oauthHost, hostRequest(sonnetPayload()))
      expectDestinationRefusal(refused.failure, upstream.origin)
      expect(upstream.received).toEqual([])

      const apiHost = new Host(
        createNativeAnthropicAdapter({
          source: makeSource({
            authorize: () =>
              apiKey('sk-ant-api03-env-key', {
                custody: 'api',
                receipt: 'api:1',
              }),
          }).source,
        }).adapter,
      )
      const sent = await attempt(apiHost, hostRequest(sonnetPayload()))
      expect(sent.failure).toBeUndefined()
      expect(upstream.received).toHaveLength(1)
      expect(upstream.received[0]?.apiKey).toBe('sk-ant-api03-env-key')
      expect(upstream.received[0]?.authorization).toBeNull()
    } finally {
      upstream.stop()
    }
  })

  test('API-key routes still reach their configured baseURL', async () => {
    const proxy = loopbackServer()
    try {
      const { source } = makeSource({
        authorize: () =>
          apiKey(
            'sk-ant-api03-proxy-key',
            { custody: 'api', receipt: 'api:1' },
            `${proxy.origin}/anthropic`,
          ),
      })
      const host = new Host(createNativeAnthropicAdapter({ source }).adapter)
      const { failure } = await attempt(host, hostRequest(sonnetPayload()))
      expect(failure).toBeUndefined()
      expect(proxy.received).toHaveLength(1)
      expect(new URL(proxy.received[0]!.url).pathname).toBe(
        '/anthropic/v1/messages',
      )
      expect(proxy.received[0]?.apiKey).toBe('sk-ant-api03-proxy-key')
    } finally {
      proxy.stop()
    }
  })

  test('the test-only loopback origin admits exactly that server and leaves API routes alone', async () => {
    const upstream = loopbackServer()
    const other = loopbackServer()
    try {
      process.env.ANTHROPIC_AUTH_TEST_OAUTH_LOOPBACK_ORIGIN = upstream.origin
      const oauthHost = new Host(
        createNativeAnthropicAdapter({
          source: makeSource({
            authorize: () =>
              oauth(OAUTH_TOKEN, { custody: 'local', receipt: 'local:1' }),
          }).source,
        }).adapter,
      )
      const allowed = await attempt(
        oauthHost,
        hostRequest(sonnetPayload(), { url: `${upstream.origin}/v1/messages` }),
      )
      expect(allowed.failure).toBeUndefined()
      expect(upstream.received).toHaveLength(1)
      const refused = await attempt(
        oauthHost,
        hostRequest(sonnetPayload(), { url: `${other.origin}/v1/messages` }),
      )
      expectDestinationRefusal(refused.failure, other.origin)
      expect(other.received).toEqual([])

      // The variable never narrows or redirects an API route.
      const apiHost = new Host(
        createNativeAnthropicAdapter({
          source: makeSource({
            authorize: () =>
              apiKey(
                'sk-ant-api03-other-key',
                { custody: 'api', receipt: 'api:1' },
                other.origin,
              ),
          }).source,
        }).adapter,
      )
      expect(
        (await attempt(apiHost, hostRequest(sonnetPayload()))).failure,
      ).toBeUndefined()
      expect(other.received).toHaveLength(1)
    } finally {
      upstream.stop()
      other.stop()
    }
  })
})

describe.each(['direct', 'http'] as const)(
  'OpenCode 2 message threads over %s',
  (transport) => {
    const authorize = () =>
      oauth(
        'stable-thread-token',
        { custody: 'local', receipt: 'thread-receipt' },
        {
          dispatch:
            transport === 'http'
              ? {
                  kind: 'http-relay',
                  url: 'https://relay.example.test',
                  token: 'relay-token',
                }
              : { kind: 'direct' },
        },
      )
    const upstreamText = (text: string): string =>
      transport === 'http' ? JSON.parse(text).body : text
    const upstreamHeaders = (text: string, headers: Headers): Headers =>
      transport === 'http'
        ? new Headers(JSON.parse(text).upstream.headers)
        : headers
    test('create then continue sends only new messages and keeps the full keep-warm body', async () => {
      const warmBodies: string[] = []
      const { source } = makeSource({
        authorize,
        onRequestPrepared: ({ bodyText }) => {
          warmBodies.push(bodyText)
        },
      })
      const native = createNativeAnthropicAdapter({ source })
      const host = new Host(native.adapter)
      const payload = {
        ...sonnetPayload(),
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: 'First thread prompt' }],
          },
        ],
      }
      const first = await host.run(scopeOf(), hostRequest(payload))
      const complete = async (run: typeof first, id: string) => {
        const response = await native.adapter.rewriteResponse?.({
          ...run.attempt,
          request: run.final,
          attempt: run.attempt,
          response: new Response(
            sse('message_start', {
              type: 'message_start',
              message: { id, content: [{ type: 'text', text: 'Answer' }] },
            }) +
              sse('message_delta', {
                type: 'message_delta',
                delta: { stop_reason: 'end_turn' },
              }) +
              sse('message_stop', { type: 'message_stop' }),
            {
              headers: {
                'content-type': 'text/event-stream',
                'request-id': 'req_thread_success',
              },
            },
          ),
        } as never)
        await response?.text()
      }
      await complete(first, 'msg_thread_2')
      const second = await host.run(
        scopeOf(),
        hostRequest({
          ...payload,
          messages: [
            ...payload.messages,
            { role: 'assistant', content: [{ type: 'text', text: 'Answer' }] },
            { role: 'user', content: [{ type: 'text', text: 'Next prompt' }] },
          ],
        }),
      )
      const firstText = await first.final.text()
      const secondText = await second.final.text()
      const a = JSON.parse(upstreamText(firstText))
      const b = JSON.parse(upstreamText(secondText))
      expect(b.messages).toEqual([
        { role: 'user', content: [{ type: 'text', text: 'Next prompt' }] },
      ])
      expect(a.thread).toEqual({ type: 'create' })
      expect(b.thread).toEqual({
        type: 'continue',
        previous_message_id: 'msg_thread_2',
      })
      expect(b.messages).toEqual([
        { role: 'user', content: [{ type: 'text', text: 'Next prompt' }] },
      ])
      expect(b.system.slice(1)).toEqual(a.system.slice(1))
      expect(b.system[0].text.match(/cc_version=[^;]+/)?.[0]).toBe(
        a.system[0].text.match(/cc_version=[^;]+/)?.[0],
      )
      expect(b.tools).toEqual(a.tools)
      const firstHeaders = upstreamHeaders(firstText, first.final.headers)
      const secondHeaders = upstreamHeaders(secondText, second.final.headers)
      expect(secondHeaders.get('anthropic-beta')).toBe(
        firstHeaders.get('anthropic-beta'),
      )
      expect(secondHeaders.get('anthropic-beta')?.split(',').at(-1)).toBe(
        'message-threads-2026-08-12',
      )
      expect(await signRequestBody(upstreamText(secondText))).toBe(
        upstreamText(secondText),
      )
      expect(JSON.parse(warmBodies[1] ?? '{}').messages).toHaveLength(3)
      expect(JSON.parse(warmBodies[1] ?? '{}').thread).toBeUndefined()
      native.dispose()
    })

    test.each([
      'thread_not_found',
      'thread_fingerprint_mismatch',
      'thread_already_continued',
      'thread_continue_in_flight',
      'thread_unsupported_request',
      'unrelated',
    ])(
      '%s recovery sends at most one full create with the same request id',
      async (code) => {
        const { source } = makeSource({ authorize })
        const resent: Request[] = []
        const native = createNativeAnthropicAdapter({
          source,
          fetch: Object.assign(
            async (url: string | URL | Request, init?: RequestInit) => {
              resent.push(
                url instanceof Request
                  ? new Request(url, init)
                  : new Request(url.toString(), init),
              )
              return new Response('still rejected', { status: 400 })
            },
            { preconnect: globalThis.fetch.preconnect },
          ) as typeof fetch,
        })
        const host = new Host(native.adapter)
        const payload = {
          model: 'claude-sonnet-5',
          stream: true,
          messages: [{ role: 'user', content: 'first' }],
        }
        const first = await host.run(scopeOf(), hostRequest(payload))
        const success = new Response(
          sse('message_start', {
            type: 'message_start',
            message: {
              id: 'msg_recover',
              content: [{ type: 'text', text: 'answer' }],
            },
          }) +
            sse('message_delta', {
              type: 'message_delta',
              delta: { stop_reason: 'end_turn' },
            }) +
            sse('message_stop', { type: 'message_stop' }),
          {
            headers: {
              'content-type': 'text/event-stream',
              'request-id': 'req_thread_anchor',
            },
          },
        )
        await (
          await native.adapter.rewriteResponse?.({
            ...first.attempt,
            attempt: first.attempt,
            request: first.final,
            response: success,
          } as never)
        )?.text()
        const messages = [
          ...payload.messages,
          { role: 'assistant', content: 'answer' },
          { role: 'user', content: 'next' },
        ]
        const second = await host.run(
          scopeOf(),
          hostRequest(
            { ...payload, messages },
            { headers: { 'x-client-request-id': 'same-thread-request' } },
          ),
        )
        const response = await native.adapter.rewriteResponse?.({
          ...second.attempt,
          attempt: second.attempt,
          request: second.final,
          response: Response.json(
            {
              type: 'error',
              error: {
                type:
                  code === 'thread_not_found'
                    ? 'not_found_error'
                    : 'invalid_request_error',
                details: { error_code: code },
              },
            },
            {
              status: code === 'thread_not_found' ? 404 : 400,
              headers: { 'request-id': 'req_thread_rejected' },
            },
          ),
        } as never)
        await response?.text()
        expect(resent).toHaveLength(code === 'unrelated' ? 0 : 1)
        if (resent[0]) {
          const text = await resent[0].text()
          const secondText = await second.final.clone().text()
          expect(
            upstreamHeaders(text, resent[0].headers).get('x-client-request-id'),
          ).toBe(
            upstreamHeaders(secondText, second.final.headers).get(
              'x-client-request-id',
            ),
          )
          const body = JSON.parse(upstreamText(text))
          expect(body.thread).toEqual({ type: 'create' })
          expect(body.messages).toEqual(messages)
          expect(await signRequestBody(upstreamText(text))).toBe(
            upstreamText(text),
          )
        }
        const third = await host.run(
          scopeOf(),
          hostRequest({ ...payload, messages }),
        )
        expect(
          JSON.parse(upstreamText(await third.final.text())).thread,
        ).toEqual({
          type: 'create',
        })
        native.dispose()
      },
    )
  },
)

test('OpenCode 2 auxiliary, prewarm, lane-start and API-key requests stay stateless', async () => {
  const { source } = makeSource()
  const native = createNativeAnthropicAdapter({ source })
  const host = new Host(native.adapter)
  for (const agent of [
    'title',
    'summary',
    'prime',
    'cachekeep',
    'compaction',
  ]) {
    const run = await host.run(
      scopeOf({ agent }),
      hostRequest({
        model: 'claude-sonnet-5',
        stream: true,
        messages: [{ role: 'user', content: 'Auxiliary' }],
      }),
    )
    expect(JSON.parse(await run.final.text()).thread).toBeUndefined()
  }
  const lane = await host.run(
    scopeOf(),
    hostRequest(sonnetPayload(), {
      headers: { [LANE_START_REQUEST_HEADER]: '1' },
    }),
  )
  expect(JSON.parse(await lane.final.text()).thread).toBeUndefined()
  native.dispose()
  const apiSource = makeSource({
    authorize: () => apiKey('api-token', { custody: 'local', receipt: 'api' }),
  }).source
  const api = createNativeAnthropicAdapter({ source: apiSource })
  const run = await new Host(api.adapter).run(
    scopeOf(),
    hostRequest(sonnetPayload()),
  )
  expect(JSON.parse(await run.final.text()).thread).toBeUndefined()
  expect(run.final.headers.get('anthropic-beta')).not.toContain(
    'message-threads-',
  )
  api.dispose()
})

test.each(['changed identity', 'replacement scope', 'configured 400'])(
  'audit OC2 resend: %s is fenced',
  async (scenario) => {
    let authorizations = 0
    let physicalSends = 0
    let heldDuringResend = -1
    const { source } = makeSource({
      authorize: () => {
        authorizations++
        return oauth(
          authorizations >= 3 ? 'audit-new-secret' : 'audit-old-secret',
          { custody: 'local', receipt: `audit-${authorizations}` },
          {
            identity:
              scenario === 'changed identity' && authorizations >= 3
                ? {
                    ...IDENTITY,
                    accountUuid:
                      '6f1d1c2e-0000-4000-8000-00000000b22d' as ProviderAccountUuid,
                  }
                : IDENTITY,
          },
        )
      },
      limitFromResponse: ({ status }) =>
        scenario === 'configured 400' && status === 400
          ? { status: 400, reason: 'provider-400' }
          : undefined,
    })
    const native = createNativeAnthropicAdapter({
      source,
      fetch: Object.assign(
        async () => {
          physicalSends++
          await Promise.resolve()
          heldDuringResend = native.heldRedactorCount
          return Response.json(
            {
              type: 'error',
              error: {
                type: 'invalid_request_error',
                message: 'retained diagnostic detail audit-new-secret',
              },
            },
            { status: 400 },
          )
        },
        { preconnect: globalThis.fetch.preconnect },
      ) as typeof fetch,
    })
    try {
      const host = new Host(native.adapter)
      const payload = {
        model: 'claude-sonnet-5',
        stream: true,
        messages: [{ role: 'user', content: 'first' }],
      }
      const first = await host.run(scopeOf(), hostRequest(payload))
      const seed = new Response(
        sse('message_start', {
          type: 'message_start',
          message: {
            id: 'msg_fence',
            content: [{ type: 'text', text: 'answer' }],
          },
        }) +
          sse('message_delta', {
            type: 'message_delta',
            delta: { stop_reason: 'end_turn' },
          }) +
          sse('message_stop', { type: 'message_stop' }),
        { headers: { 'content-type': 'text/event-stream' } },
      )
      await (
        await native.adapter.rewriteResponse?.({
          ...first.attempt,
          attempt: first.attempt,
          request: first.final,
          response: seed,
        } as never)
      )?.text()
      const second = await host.run(
        scopeOf(),
        hostRequest({
          ...payload,
          messages: [
            ...payload.messages,
            { role: 'assistant', content: 'answer' },
            { role: 'user', content: 'next' },
          ],
        }),
      )
      expect(JSON.parse(await second.final.clone().text()).thread.type).toBe(
        'continue',
      )
      const original = Response.json(
        {
          type: 'error',
          error: {
            type: 'invalid_request_error',
            message: 'original rejection',
            details: { error_code: 'thread_fingerprint_mismatch' },
          },
        },
        { status: 400 },
      )
      if (scenario === 'configured 400') {
        const limit = await native.adapter.limitFromResponse?.({
          status: original.status,
          headers: original.headers,
          body: () => original.clone().text(),
          attempt: second.attempt,
        })
        expect(limit).toMatchObject({ status: 400, reason: 'provider-400' })
      }
      const response = await native.adapter.rewriteResponse?.({
        ...second.attempt,
        attempt: second.attempt,
        request: second.final,
        response: original,
      } as never)
      if (!response) throw new Error('Missing rewritten response')
      const text = await response.text()
      if (scenario === 'replacement scope') {
        expect(physicalSends).toBe(1)
        expect(heldDuringResend).toBe(1)
        expect(text).toContain('retained diagnostic detail')
        expect(text).not.toContain('audit-new-secret')
      } else {
        expect(physicalSends).toBe(0)
        expect(response.status).toBe(400)
        expect(text).toContain('original rejection')
        expect(text).toContain('thread_fingerprint_mismatch')
      }
    } finally {
      native.dispose()
    }
  },
)

test('audit primary gates: OC2 title kind cannot replace a primary reply', async () => {
  const { source } = makeSource()
  const native = createNativeAnthropicAdapter({ source })
  try {
    const host = new Host(native.adapter)
    const payload = {
      model: 'claude-sonnet-5',
      stream: true,
      messages: [{ role: 'user', content: 'first' }],
    }
    const first = await host.run(scopeOf(), hostRequest(payload))
    const response = new Response(
      sse('message_start', {
        type: 'message_start',
        message: {
          id: 'msg_primary',
          content: [{ type: 'text', text: 'answer' }],
        },
      }) +
        sse('message_delta', {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn' },
        }) +
        sse('message_stop', { type: 'message_stop' }),
      { headers: { 'content-type': 'text/event-stream' } },
    )
    await (
      await native.adapter.rewriteResponse?.({
        ...first.attempt,
        attempt: first.attempt,
        request: first.final,
        response,
      } as never)
    )?.text()
    const title = await host.run(
      scopeOf({ kind: 'title', agent: 'build' }),
      hostRequest({
        ...payload,
        messages: [{ role: 'user', content: 'Title request' }],
      }),
    )
    expect(JSON.parse(await title.final.text()).thread).toBeUndefined()
    expect(title.final.headers.get('anthropic-beta')).not.toContain(
      'message-threads-',
    )
    const next = await host.run(
      scopeOf(),
      hostRequest({
        ...payload,
        messages: [
          ...payload.messages,
          { role: 'assistant', content: 'answer' },
          { role: 'user', content: 'next' },
        ],
      }),
    )
    expect(JSON.parse(await next.final.text()).thread).toEqual({
      type: 'continue',
      previous_message_id: 'msg_primary',
    })
  } finally {
    native.dispose()
  }
})

test('audit downstream refusal: OC2 revokes an anchor after raw EOF validation fails', async () => {
  const { source } = makeSource()
  const native = createNativeAnthropicAdapter({ source })
  try {
    const host = new Host(native.adapter)
    const payload = {
      model: 'claude-sonnet-5',
      stream: true,
      tools: ['search', 'mcp_Search'].map((name) => ({
        name,
        input_schema: { type: 'object' },
      })),
      messages: [{ role: 'user', content: 'first' }],
    }
    const first = await host.run(scopeOf(), hostRequest(payload))
    const raw =
      sse('message_start', {
        type: 'message_start',
        message: { id: 'msg_refused', content: [] },
      }) +
      sse('content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: {
          type: 'tool_use',
          id: 'refused_call',
          name: 'mcp_Search',
          input: {},
        },
      }) +
      sse('content_block_stop', { type: 'content_block_stop', index: 0 }) +
      sse('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: 'tool_use' },
      }) +
      sse('message_stop', { type: 'message_stop' })
    const response = await native.adapter.rewriteResponse?.({
      ...first.attempt,
      attempt: first.attempt,
      request: first.final,
      response: new Response(raw, {
        headers: { 'content-type': 'application/json' },
      }),
    } as never)
    if (!response) throw new Error('Missing response')
    await expect(response.text()).rejects.toThrow(
      'Response tool-name mapping could not be validated safely',
    )
    const next = await host.run(
      scopeOf(),
      hostRequest({
        ...payload,
        messages: [
          ...payload.messages,
          {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'refused_call',
                name: 'search',
                input: {},
              },
            ],
          },
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'refused_call',
                content: 'result',
              },
            ],
          },
        ],
      }),
    )
    expect(JSON.parse(await next.final.text()).thread).toEqual({
      type: 'create',
    })
  } finally {
    native.dispose()
  }
})

test('audit hot path: OC2 retains an unsigned full template and signs only the sent shape', async () => {
  let template = ''
  const { source } = makeSource({
    onRequestPrepared: ({ bodyText }) => {
      template = bodyText
    },
  })
  const native = createNativeAnthropicAdapter({ source })
  try {
    const run = await new Host(native.adapter).run(
      scopeOf(),
      hostRequest({
        model: 'claude-sonnet-5',
        stream: true,
        messages: [{ role: 'user', content: 'Prepare one signed request' }],
      }),
    )
    expect(template).toContain('cch=00000;')
    expect(JSON.parse(template).thread).toBeUndefined()
    const wire = await run.final.text()
    expect(JSON.parse(wire).thread).toEqual({ type: 'create' })
    expect(await signRequestBody(wire)).toBe(wire)
  } finally {
    native.dispose()
  }
})

test.each(['kept input', 'edited input'])(
  'recheck reply semantics: OC2 request-bound name rewrite with %s',
  async (kind) => {
    const { source } = makeSource()
    const native = createNativeAnthropicAdapter({ source })
    try {
      const host = new Host(native.adapter)
      const payload = {
        model: 'claude-sonnet-5',
        stream: true,
        tools: [{ name: 'aft_search', input_schema: { type: 'object' } }],
        messages: [{ role: 'user', content: 'first' }],
      }
      const first = await host.run(scopeOf(), hostRequest(payload))
      const raw =
        sse('message_start', {
          type: 'message_start',
          message: { id: 'msg_args', content: [] },
        }) +
        sse('content_block_start', {
          type: 'content_block_start',
          index: 0,
          content_block: {
            type: 'tool_use',
            id: 'same_id',
            name: 'search',
            input: {},
          },
        }) +
        sse('content_block_delta', {
          type: 'content_block_delta',
          index: 0,
          delta: {
            type: 'input_json_delta',
            partial_json: '{"query":"original"}',
          },
        }) +
        sse('content_block_stop', { type: 'content_block_stop', index: 0 }) +
        sse('message_delta', {
          type: 'message_delta',
          delta: { stop_reason: 'tool_use' },
        }) +
        sse('message_stop', { type: 'message_stop' })
      await (
        await native.adapter.rewriteResponse?.({
          ...first.attempt,
          attempt: first.attempt,
          request: first.final,
          response: new Response(raw, {
            headers: { 'content-type': 'text/event-stream' },
          }),
        } as never)
      )?.text()
      const next = await host.run(
        scopeOf(),
        hostRequest({
          ...payload,
          messages: [
            ...payload.messages,
            {
              role: 'assistant',
              content: [
                {
                  type: 'tool_use',
                  id: 'same_id',
                  name: 'aft_search',
                  input: {
                    query: kind === 'edited input' ? 'edited' : 'original',
                  },
                },
              ],
            },
            {
              role: 'user',
              content: [
                {
                  type: 'tool_result',
                  tool_use_id: 'same_id',
                  content: 'result',
                },
              ],
            },
          ],
        }),
      )
      expect(JSON.parse(await next.final.text()).thread.type).toBe(
        kind === 'edited input' ? 'create' : 'continue',
      )
    } finally {
      native.dispose()
    }
  },
)
