import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  CLAUDE_CODE_IDENTITY,
  CLAUDE_OPUS_5_5_ADAPTIVE_THINKING,
  CLAUDE_SONNET_5_ADAPTIVE_THINKING,
  type ClaudeCodeIdentity,
  FAST_MODE_BETA,
  type ProviderAccountUuid,
  signRequestBody,
  TRAILING_ASSISTANT_HISTORY_MESSAGE,
  USER_AGENT,
} from '@cortexkit/anthropic-auth-core'
import type {
  AccountHeadersResult,
  Attempt,
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
  NO_ACCOUNT_REFUSAL,
} from '../v2/adapter'

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

const scopeOf = (over: Partial<RequestScope> = {}): RequestScope => ({
  providerID: 'anthropic',
  modelID: 'claude-sonnet-5',
  sessionID: 'ses_alpha',
  agent: 'build',
  kind: 'primary',
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

/**
 * Drives one physical send in the order the common-auth installer does:
 * `chooseAccount`, `accountHeaders`, then in `http.request` the adapter's
 * `rewriteRequest` followed by the account header edits, which win on the
 * wire. Every request that would reach the network lands in `sent`.
 */
class Host {
  readonly sent: Request[] = []
  private seq = 0

  constructor(readonly adapter: OpenCode2AuthAdapter<Quota, Data>) {}

  async begin(scope: RequestScope) {
    const accountId = await this.adapter.chooseAccount(scope)
    if (accountId === undefined) throw new Error('installer: no-account')
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
  init: { headers?: Record<string, string>; signal?: AbortSignal } = {},
) {
  return new Request(UPSTREAM, {
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
      error: unknown
    }[] = [
      {
        name: 'no account chosen',
        answers: { choose: () => undefined, chooseAccount: () => undefined },
        error: 'installer: no-account',
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
      if (typeof error === 'string') {
        expect((failure as Error).message, name).toBe(error)
      } else {
        expect(failure, name).toBeInstanceOf(error as typeof Error)
        expect((failure as Error).message, name).toBe(NO_ACCOUNT_REFUSAL)
      }
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
})

describe('OpenCode 2 native Anthropic adapter: responses', () => {
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
    expect(text).toContain('"name": "bash"')
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
  const typed: OpenCode2AuthAdapter<Quota, Data> = createNativeAnthropicAdapter(
    { source: healthy },
  ).adapter
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
