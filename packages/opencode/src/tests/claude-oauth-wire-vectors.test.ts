// Checks this plugin's OpenCode 1 OAuth send path against the shared Claude
// OAuth wire vectors vendored from cortexkit/commons (see
// fixtures/claude-oauth-wire/SOURCE). Other clients of the same Claude
// persona check the same file, so a change to the send path that alters a
// header, header order, a body byte or the cch signature fails this suite
// instead of silently drifting away from those clients.
//
// Every expected value comes from the vendored vectors.json. The request is
// rebuilt from each case's `input` by calling the real functions in the order
// index.ts sendWithAccessToken uses them, then sent with Bun's fetch to a local
// raw socket so the headers are compared in the order Bun writes them.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as core from '@cortexkit/anthropic-auth-core'
import {
  CCH_POSITIONS,
  computeCCH,
  computeCcVersionSuffix,
  extractBillingHeaderCCH,
  extractFirstUserMessageText,
  isFastModeSupportedModel,
  type ProviderAccountUuid,
  resetBillingHeaderCCH,
  signRequestBody,
} from '@cortexkit/anthropic-auth-core'
import {
  EFFORT_PLAN_REQUEST_HEADER,
  encodeOpenCodeEffortPlan,
  markOpenCodeEffortTransitions,
  OpenCodeEffortPlanTracker,
} from '../effort-history'
import {
  addFastModeBetaHeader,
  mergeHeaders,
  resetPinnedFirstUserTextsForTest,
  rewriteRequestBody,
  rewriteUrl,
  setOAuthHeaders,
} from '../transform'

const FIXTURE_DIR = join(import.meta.dir, 'fixtures', 'claude-oauth-wire')
const API_URL = 'https://api.anthropic.com/v1/messages'

type VectorOptions = {
  cache1hEnabled: boolean
  cache1hMode: 'explicit' | 'automatic' | 'hybrid'
  fastModeEnabled?: boolean
  thinkingPrefixMismatchBehavior?: 'account-default' | 'error' | 'drop_block'
  billingLineage?: { promptId?: string; previousRequestId?: string }
  cacheDiagnosticsPreviousMessageId: string | null
  serverSideFallbackEnabled: boolean
  midConversationEffortEnabled: boolean
}

type VectorOutput = {
  method: string
  url: string
  request_line: string
  headers_wire_order: [string, string][]
  body: string
  body_sha256: string
  body_bytes: number
  billing_header: string
  cc_version_suffix: {
    first_user_text: string
    sampled_chars: string
    suffix: string
  }
  cch: string
  cch_canonical_body: string
}

type VectorCase = {
  id: string
  input: {
    host: string
    route: string
    model: string
    session_id: string
    subagent: boolean
    host_headers: Record<string, string>
    host_body: string
    lowered_host_body?: string
    effort_markers?: {
      plan_header: string
      transition_tokens: string[]
      anchor_token: string | null
    }
    options: VectorOptions
  }
  output: VectorOutput
}

type VectorFile = {
  schema: string
  fixed: {
    accessToken: string
    accountUuid: string
    deviceId: string
    claudeCodeSessionId: string
    clientRequestId: string
    platform: string
    arch: string
  }
  primitives: {
    computeCCH_utf8_hello_world_test_message: string
    computeCcVersionSuffix_short_2_1_258: string
  }
  cases: VectorCase[]
}

type OpenCodeTurn = {
  id: string
  role: 'user' | 'assistant'
  variant?: string
}

// OpenCode 1 decides effort markers from its own message records (message id
// and selected variant), which the host lowers away before the plugin's fetch
// wrapper sees the body; the shared vectors therefore carry only the result
// (`effort_markers`, `lowered_host_body`). These are the records the vectors
// were generated from. The test runs the real marker pass on them and checks
// its result against the vector before sending, so a wrong table fails loudly.
const OPENCODE_TURNS: Record<string, OpenCodeTurn[]> = {
  'fable51-first-turn': [{ id: 'msg_0001', role: 'user', variant: 'high' }],
  'opus55-continuation-replayed-thinking': [
    { id: 'msg_0001', role: 'user', variant: 'high' },
    { id: 'msg_0002', role: 'assistant' },
    { id: 'msg_0003', role: 'user', variant: 'high' },
  ],
  'opus55-effort-change': [
    { id: 'msg_0001', role: 'user', variant: 'high' },
    { id: 'msg_0002', role: 'assistant' },
    { id: 'msg_0003', role: 'user', variant: 'low' },
  ],
  'sonnet55-between-tools': [
    { id: 'msg_0001', role: 'user', variant: 'xhigh' },
  ],
  'sonnet55-full-agent-subagent': [
    { id: 'msg_0001', role: 'user', variant: 'high' },
  ],
}

// Headers that index.ts reads for routing and then removes before sending.
const INTERNAL_REQUEST_HEADERS = [
  'x-parent-session-id',
  'x-session-affinity',
  'x-opencode-session',
  'x-opencode-session-id',
  'x-opencode-parent-session-id',
  EFFORT_PLAN_REQUEST_HEADER,
  'x-cortexkit-billing-lineage',
]

const vectors = JSON.parse(
  readFileSync(join(FIXTURE_DIR, 'vectors.json'), 'utf8'),
) as VectorFile

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function show(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  const quoted = JSON.stringify(text ?? String(value))
  return quoted.length > 200 ? `${quoted.slice(0, 200)}…` : quoted
}

/** JSON path of the first place two parsed values differ, key order included. */
function firstJsonDifference(
  expected: unknown,
  actual: unknown,
  path: string,
): string | null {
  if (Array.isArray(expected) && Array.isArray(actual)) {
    for (let i = 0; i < Math.max(expected.length, actual.length); i++) {
      if (i >= expected.length) return `${path}[${i}] (unexpected element)`
      if (i >= actual.length) return `${path}[${i}] (missing element)`
      const inner = firstJsonDifference(expected[i], actual[i], `${path}[${i}]`)
      if (inner) return inner
    }
    return null
  }
  if (isRecord(expected) && isRecord(actual)) {
    const expectedKeys = Object.keys(expected)
    const actualKeys = Object.keys(actual)
    for (let i = 0; i < Math.max(expectedKeys.length, actualKeys.length); i++) {
      if (expectedKeys[i] !== actualKeys[i]) {
        return `${path} (key #${i}: expected ${show(expectedKeys[i])}, got ${show(actualKeys[i])})`
      }
    }
    for (const key of expectedKeys) {
      const inner = firstJsonDifference(
        expected[key],
        actual[key],
        `${path}.${key}`,
      )
      if (inner) return inner
    }
    return null
  }
  if (JSON.stringify(expected) === JSON.stringify(actual)) return null
  return `${path} (expected ${show(expected)}, got ${show(actual)})`
}

/** Describes where two JSON texts first differ, by JSON path and byte offset. */
function describeTextDifference(expected: string, actual: string): string {
  let offset = 0
  while (
    offset < expected.length &&
    offset < actual.length &&
    expected[offset] === actual[offset]
  ) {
    offset++
  }
  let where = ''
  try {
    where =
      firstJsonDifference(JSON.parse(expected), JSON.parse(actual), '$') ??
      '(same JSON value, different bytes)'
  } catch {
    where = '(not valid JSON)'
  }
  const near = (text: string) =>
    show(text.slice(Math.max(0, offset - 30), offset + 30))
  return `${where}; first differing character at offset ${offset}: expected …${near(expected)}…, got …${near(actual)}…`
}

/**
 * Name the first output field where the rebuilt request differs from the
 * vector, or return null when every compared field matches exactly.
 */
function firstOutputDifference(
  caseId: string,
  expected: VectorOutput,
  actual: VectorOutput,
): string | null {
  for (const field of ['method', 'url', 'request_line'] as const) {
    if (expected[field] !== actual[field]) {
      return `${caseId}: ${field} differs: expected ${show(expected[field])}, got ${show(actual[field])}`
    }
  }
  const expectedHeaders = expected.headers_wire_order
  const actualHeaders = actual.headers_wire_order
  for (
    let i = 0;
    i < Math.max(expectedHeaders.length, actualHeaders.length);
    i++
  ) {
    const want = expectedHeaders[i]
    const got = actualHeaders[i]
    if (want?.[0] !== got?.[0] || want?.[1] !== got?.[1]) {
      return `${caseId}: headers_wire_order[${i}] differs: expected ${show(want ?? '(no header)')}, got ${show(got ?? '(no header)')}`
    }
  }
  if (expected.body !== actual.body) {
    return `${caseId}: body differs at ${describeTextDifference(expected.body, actual.body)}`
  }
  for (const field of [
    'body_sha256',
    'body_bytes',
    'billing_header',
    'cc_version_suffix',
    'cch',
    'cch_canonical_body',
  ] as const) {
    if (JSON.stringify(expected[field]) !== JSON.stringify(actual[field])) {
      return `${caseId}: ${field} differs: expected ${show(expected[field])}, got ${show(actual[field])}`
    }
  }
  return null
}

/**
 * Run the real OpenCode 1 effort marker pass on the case's message records
 * and lower the marker parts it adds onto the matching Anthropic user
 * messages, as the AI SDK does with extra text parts.
 */
function lowerOpenCodeMarkers(
  hostBodyText: string,
  turns: OpenCodeTurn[],
  sessionId: string,
) {
  const body = JSON.parse(hostBodyText) as Record<string, unknown>
  const messages = body.messages as Array<Record<string, unknown>>
  const records = turns.map((turn, index) => ({
    info: {
      id: turn.id,
      sessionID: sessionId,
      role: turn.role,
      model: {
        providerID: 'anthropic',
        modelID: body.model as string,
        ...(turn.variant ? { variant: turn.variant } : {}),
      },
    },
    parts: [{ type: 'text', text: `turn ${index}` }] as Array<
      Record<string, unknown> & { type: string }
    >,
  }))
  const plan = markOpenCodeEffortTransitions(records)
  if (!plan) return undefined
  records.forEach((record, index) => {
    const added = record.parts.slice(1)
    const message = messages[index]
    if (!added.length || !message) return
    const content =
      typeof message.content === 'string'
        ? [{ type: 'text', text: message.content }]
        : (message.content as unknown[])
    message.content = [...content, ...added.map((part) => ({ ...part }))]
  })
  return {
    plan,
    header: encodeOpenCodeEffortPlan(plan),
    loweredBodyText: JSON.stringify(body),
  }
}

/**
 * Bun writes the request to a raw socket; read it back byte for byte so the
 * header list is the real wire order, including headers Bun adds itself.
 */
async function captureWire(path: string, init: RequestInit) {
  let resolveCapture!: (value: { head: string; body: Buffer }) => void
  const captured = new Promise<{ head: string; body: Buffer }>((resolve) => {
    resolveCapture = resolve
  })
  let buffer = Buffer.alloc(0)
  const server = Bun.listen({
    hostname: '127.0.0.1',
    port: 0,
    socket: {
      data(socket, chunk) {
        buffer = Buffer.concat([buffer, Buffer.from(chunk)])
        const end = buffer.indexOf('\r\n\r\n')
        if (end < 0) return
        const head = buffer.subarray(0, end).toString('latin1')
        const length = Number(
          /\r\ncontent-length:\s*(\d+)/i.exec(head)?.[1] ?? 0,
        )
        if (buffer.length < end + 4 + length) return
        socket.write(
          'HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 2\r\nconnection: close\r\n\r\n{}',
        )
        socket.end()
        resolveCapture({
          head,
          body: buffer.subarray(end + 4, end + 4 + length),
        })
      },
    },
  })
  try {
    // Bun.fetch is the runtime's own fetch, as production calls it. The test
    // preload wraps globalThis.fetch in a loopback guard that re-creates the
    // Request, which is not the object production hands to the runtime; the
    // target here is a loopback listener, so the guard has nothing to block.
    const response = await Bun.fetch(
      `http://127.0.0.1:${server.port}${path}`,
      init,
    )
    await response.text()
    const { head, body } = await captured
    const [requestLine = '', ...lines] = head.split('\r\n')
    const headers = lines.map((line): [string, string] => {
      const index = line.indexOf(':')
      return [line.slice(0, index), line.slice(index + 1).trim()]
    })
    return { requestLine, headers, body: body.toString('utf8') }
  } finally {
    server.stop(true)
  }
}

/**
 * Before sending, check that the real marker pass reproduces the case's
 * effort inputs: the plan header the host forwards and the lowered body that
 * reaches the fetch wrapper.
 */
function effortInputDifference(
  testCase: VectorCase,
  markers: ReturnType<typeof lowerOpenCodeMarkers>,
): string | null {
  const { id, input } = testCase
  const expected = input.effort_markers
  if (!expected && !markers) return null
  if (expected && !OPENCODE_TURNS[id]) {
    return `${id}: input.effort_markers is set but this test has no OpenCode message records for the case; add them to OPENCODE_TURNS`
  }
  if (!expected || !markers) {
    return `${id}: input.effort_markers differs: expected ${expected ? 'markers' : 'none'}, the marker pass produced ${markers ? 'markers' : 'none'}`
  }
  const derived = {
    plan_header: markers.header,
    transition_tokens: [...markers.plan.transitionTokens],
    anchor_token: markers.plan.anchorToken ?? null,
  }
  // The vector's effort_markers also has a prose `note`; compare only data.
  const field = firstJsonDifference(
    {
      plan_header: expected.plan_header,
      transition_tokens: expected.transition_tokens,
      anchor_token: expected.anchor_token,
    },
    derived,
    'input.effort_markers',
  )
  if (field) return `${id}: ${field}`
  if (input.host_headers[EFFORT_PLAN_REQUEST_HEADER] !== markers.header) {
    return `${id}: input.host_headers.${EFFORT_PLAN_REQUEST_HEADER} differs: expected ${show(input.host_headers[EFFORT_PLAN_REQUEST_HEADER])}, got ${show(markers.header)}`
  }
  if (input.lowered_host_body !== markers.loweredBodyText) {
    return `${id}: input.lowered_host_body differs at ${describeTextDifference(input.lowered_host_body ?? '', markers.loweredBodyText)}`
  }
  return null
}

/**
 * Rebuild the case's request from its `input` through the OpenCode 1 OAuth
 * direct send path (index.ts sendWithAccessToken): merge host headers, resolve
 * the effort plan and drop internal headers, rewrite and sign the body, set
 * the OAuth headers, rewrite the URL and send.
 */
async function rebuildRequest(testCase: VectorCase): Promise<VectorOutput> {
  const { id, input } = testCase
  const { fixed } = vectors
  const identity = {
    deviceId: fixed.deviceId,
    accountIdentity: fixed.accountUuid,
    accountUuid: fixed.accountUuid as ProviderAccountUuid,
    sessionId: fixed.claudeCodeSessionId,
  }
  resetPinnedFirstUserTextsForTest()

  const turns = OPENCODE_TURNS[id]
  const markers = turns
    ? lowerOpenCodeMarkers(input.host_body, turns, input.session_id)
    : undefined
  const effortMismatch = effortInputDifference(testCase, markers)
  if (effortMismatch) throw new Error(effortMismatch)
  // index.ts records the plan in its messages-transform hook and resolves it
  // from the forwarded header at send time.
  const tracker = new OpenCodeEffortPlanTracker()
  if (markers) tracker.record(markers.plan)
  const hostBodyText = input.lowered_host_body ?? input.host_body

  const headers = mergeHeaders(API_URL, {
    method: 'POST',
    headers: input.host_headers,
  })
  const effortPlanHeader = headers.get(EFFORT_PLAN_REQUEST_HEADER) ?? undefined
  const resolvedEffortPlan = tracker.resolveHeader(effortPlanHeader)
  for (const name of INTERNAL_REQUEST_HEADERS) headers.delete(name)

  const { options } = input
  const fastModeRequested =
    options.fastModeEnabled === true &&
    isFastModeSupportedModel(JSON.parse(hostBodyText).model)
  const body = await rewriteRequestBody(hostBodyText, {
    cache1hEnabled: options.cache1hEnabled && !input.subagent,
    cache1hMode: options.cache1hMode,
    fastModeEnabled: fastModeRequested,
    identity,
    sessionId: input.session_id,
    thinkingPrefixMismatchBehavior:
      options.thinkingPrefixMismatchBehavior ?? 'account-default',
    midConversationEffortEnabled: options.midConversationEffortEnabled,
    midConversationEffortPlan: effortPlanHeader,
    midConversationEffortResolvedPlan: resolvedEffortPlan,
    serverSideFallbackEnabled: options.serverSideFallbackEnabled,
    laneStart: false,
    // A subagent request carries no billing lineage.
    billingLineage: input.subagent ? undefined : options.billingLineage,
    cacheDiagnosticsPreviousMessageId:
      options.cacheDiagnosticsPreviousMessageId,
  })
  // rewriteRequestBody returns its input unchanged when the rewrite fails.
  if (body === hostBodyText) {
    throw new Error(`${id}: rewriteRequestBody left the body unchanged`)
  }
  setOAuthHeaders(headers, fixed.accessToken, {
    body: JSON.parse(body),
    identity,
  })
  if (fastModeRequested) addFastModeBetaHeader(headers)
  // Production sets a fresh crypto.randomUUID() per request; the vectors hold
  // it fixed.
  headers.set('x-client-request-id', fixed.clientRequestId)

  const url = rewriteUrl(API_URL).url
  if (!url) throw new Error(`${id}: rewriteUrl returned no URL`)
  const wire = await captureWire(`${url.pathname}${url.search}`, {
    method: 'POST',
    body,
    headers,
  })
  if (wire.body !== body) {
    throw new Error(`${id}: the bytes Bun sent differ from the signed body`)
  }
  // The capture targets a local socket; the vectors carry the production host.
  const wireHeaders = wire.headers.map(([name, value]): [string, string] =>
    name.toLowerCase() === 'host' ? [name, url.host] : [name, value],
  )

  const cch = extractBillingHeaderCCH(body) ?? ''
  const canonical = JSON.parse(resetBillingHeaderCCH(body))
  if ('model' in canonical) canonical.model = ''
  delete canonical.max_tokens
  const canonicalText = JSON.stringify(canonical)
  if ((await computeCCH(new TextEncoder().encode(canonicalText))) !== cch) {
    throw new Error(`${id}: cch does not hash from its canonical body`)
  }
  if ((await signRequestBody(resetBillingHeaderCCH(body))) !== body) {
    throw new Error(`${id}: re-signing the body does not reproduce it`)
  }

  const firstUserText = extractFirstUserMessageText(
    JSON.parse(hostBodyText).messages,
  )
  return {
    method: 'POST',
    url: url.toString(),
    request_line: wire.requestLine,
    headers_wire_order: wireHeaders,
    body,
    body_sha256: createHash('sha256').update(body).digest('hex'),
    body_bytes: Buffer.byteLength(body),
    billing_header: JSON.parse(body).system[0].text,
    cc_version_suffix: {
      first_user_text: firstUserText,
      sampled_chars: CCH_POSITIONS.map(
        (position) => firstUserText[position] ?? '0',
      ).join(''),
      suffix: computeCcVersionSuffix(firstUserText),
    },
    cch,
    cch_canonical_body: canonicalText,
  }
}

describe('shared Claude OAuth wire vectors', () => {
  test('every vendored file matches the vendored SHA256SUMS', () => {
    const lines = readFileSync(join(FIXTURE_DIR, 'SHA256SUMS'), 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '')
    const listed = lines.map((line) => {
      const match = /^([0-9a-f]{64}) [ *](.+)$/.exec(line)
      if (!match) throw new Error(`SHA256SUMS: malformed line ${show(line)}`)
      const [, sum, name] = match as unknown as [string, string, string]
      const actual = createHash('sha256')
        .update(readFileSync(join(FIXTURE_DIR, name)))
        .digest('hex')
      if (actual !== sum) {
        throw new Error(
          `SHA256SUMS: ${name} has sha256 ${actual}, expected ${sum}`,
        )
      }
      return name
    })
    // SHA256SUMS cannot list itself; SOURCE is ours, not vendored.
    expect(listed.sort()).toEqual(['README.md', 'vectors.json'])
  })

  test('SOURCE pins a full commons commit and path', () => {
    const source = readFileSync(join(FIXTURE_DIR, 'SOURCE'), 'utf8')
    expect(source).toMatch(/^commit=[0-9a-f]{40}$/m)
    expect(source).toMatch(
      /^path=crates\/cortexkit-anthropic-policy\/test-vectors\/claude-oauth-wire$/m,
    )
    expect(source).toMatch(
      /^repository=https:\/\/github\.com\/cortexkit\/commons\.git$/m,
    )
  })

  test('hash primitives match', async () => {
    expect(vectors.schema).toBe('claude-oauth-wire-vectors/v1')
    expect(
      await computeCCH(new TextEncoder().encode('hello world test message')),
    ).toBe(vectors.primitives.computeCCH_utf8_hello_world_test_message)
    expect(computeCcVersionSuffix('short', '2.1.258')).toBe(
      vectors.primitives.computeCcVersionSuffix_short_2_1_258,
    )
  })

  test('the vectors hold OpenCode 1 OAuth cases', () => {
    expect(vectors.cases.length).toBeGreaterThan(0)
    for (const testCase of vectors.cases) {
      expect(
        `${testCase.id}:${testCase.input.host}/${testCase.input.route}`,
      ).toBe(`${testCase.id}:opencode-1/oauth`)
    }
  })

  describe('rebuilt request equals the vector', () => {
    // x-stainless-os and x-stainless-arch read process.platform and
    // process.arch on every call; the vectors pin them. Environment overrides
    // of the base URL, model or fallback mode would change the request.
    const originalPlatform = process.platform
    const originalArch = process.arch
    const ENV_OVERRIDES = [
      'ANTHROPIC_BASE_URL',
      'ANTHROPIC_MODEL',
      'ANTHROPIC_DEFAULT_SONNET_MODEL',
      'ANTHROPIC_DEFAULT_OPUS_MODEL',
      'ANTHROPIC_DEFAULT_HAIKU_MODEL',
      'ANTHROPIC_DEFAULT_FABLE_MODEL',
      'ANTHROPIC_CUSTOM_HEADERS',
      'OPENCODE_ANTHROPIC_AUTH_FALLBACK_MODE',
    ]
    const savedEnv = new Map<string, string | undefined>()

    beforeAll(() => {
      Object.defineProperty(process, 'platform', {
        value: vectors.fixed.platform,
      })
      Object.defineProperty(process, 'arch', { value: vectors.fixed.arch })
      for (const name of ENV_OVERRIDES) {
        savedEnv.set(name, process.env[name])
        delete process.env[name]
      }
    })

    afterAll(() => {
      Object.defineProperty(process, 'platform', { value: originalPlatform })
      Object.defineProperty(process, 'arch', { value: originalArch })
      for (const [name, value] of savedEnv) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
    })

    for (const testCase of vectors.cases) {
      test(testCase.id, async () => {
        const actual = await rebuildRequest(testCase)
        expect(
          actual.headers_wire_order.find(
            ([name]) => name.toLowerCase() === 'accept-encoding',
          )?.[1],
        ).toBe(core.CLAUDE_CODE_ACCEPT_ENCODING)
        const mismatch = firstOutputDifference(
          testCase.id,
          testCase.output,
          actual,
        )
        if (mismatch) throw new Error(mismatch)
      })
    }
  })
})
