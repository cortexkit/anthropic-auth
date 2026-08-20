import { describe, expect, test } from 'bun:test'
import {
  applyCacheDiagnosticsOptIn,
  buildCacheDiagnosticsRecord,
  CACHE_DIAGNOSTICS_LOG_PREFIX,
  CACHE_DIAGNOSTICS_SOURCE_SYNTHETIC,
  CacheDiagnosticsBetaTracker,
  CacheDiagnosticsTracker,
  formatCacheDiagnosticsLogLine,
  summarizeCacheTtl,
  withStickyRetryAfter,
} from '../cache-diagnostics'

const usage = {
  input_tokens: 10,
  cache_read_input_tokens: 20,
  cache_creation_input_tokens: 30,
  cache_creation: {
    ephemeral_5m_input_tokens: 40,
    ephemeral_1h_input_tokens: 50,
  },
}

const message = (diagnostics?: unknown, model = 'claude-opus-4-7') => ({
  id: 'provider-response-id-with-no-msg-prefix',
  model,
  usage,
  ...(diagnostics === undefined ? {} : { diagnostics }),
})

const request = {
  sessionId: 'ses-a',
  previousMessageId: null,
  isSubagent: false,
  ttlSent: '1h' as const,
}

const input = (overrides: Record<string, unknown> = {}) => ({
  request,
  source: 'turn',
  accountId: 'oauth-account-a',
  synthetic: false,
  betasHash: '0123456789abcdef',
  message: message({ cache_miss_reason: { type: 'unavailable' } }),
  receivedAt: 100,
  ...overrides,
})

describe('CacheDiagnosticsTracker', () => {
  test('returns null before capture and preserves opaque provider ids', () => {
    const tracker = new CacheDiagnosticsTracker()
    expect(tracker.previousFor('ses-a')).toBeNull()
    tracker.capture('ses-a', 'provider-response-id-with-no-msg-prefix', 100)
    expect(tracker.previousFor('ses-a')).toEqual({
      messageId: 'provider-response-id-with-no-msg-prefix',
      receivedAt: 100,
    })
  })

  test('evicts only the oldest unique session at the bounded limit', () => {
    const tracker = new CacheDiagnosticsTracker()
    for (let index = 0; index < 1_000; index += 1)
      tracker.capture(`ses-${index}`, `provider-${index}`, index)
    tracker.capture('ses-0', 'provider-0-updated', 2_000)
    tracker.capture('ses-1000', 'provider-1000', 2_001)
    expect(tracker.previousFor('ses-0')).toBeNull()
    expect(tracker.previousFor('ses-1')?.messageId).toBe('provider-1')
  })

  test('copies response context across a sticky retry rewrap', async () => {
    const contexts = new WeakMap<Response, unknown>()
    const source = new Response('{}')
    contexts.set(source, { sessionId: 'ses-retry' })

    const destination = await withStickyRetryAfter(
      source,
      'ses-retry',
      60,
      false,
      contexts,
    )

    expect(contexts.get(destination)).toEqual({ sessionId: 'ses-retry' })
  })
})

describe('cache diagnostics v2 contract', () => {
  test('writes required v2 metadata and omits a matching requested model', () => {
    const result = buildCacheDiagnosticsRecord(
      input({ requestedModel: 'claude-opus-4-7' }),
    )

    expect(result.record).toMatchObject({
      v: 2,
      source: 'turn',
      account_id: 'oauth-account-a',
      synthetic: false,
      betas_hash: '0123456789abcdef',
      cache_read: 20,
      cache_creation: 30,
      input_tokens: 10,
    })
    expect(result.record).not.toHaveProperty('requested_model')
  })

  test('records requested_model only when the served response model differs', () => {
    const result = buildCacheDiagnosticsRecord(
      input({ requestedModel: 'claude-sonnet-4-7' }),
    )

    expect(result.record?.requested_model).toBe('claude-sonnet-4-7')
  })

  test.each([
    ['turn', false, 'account-turn'],
    ['prewarm_cachekeep', true, 'account-prewarm'],
  ] as const)('records account_id for %s observations', (source, synthetic, accountId) => {
    const result = buildCacheDiagnosticsRecord(
      input({ source, synthetic, accountId }),
    )

    expect(result.record).toMatchObject({
      source,
      synthetic,
      account_id: accountId,
    })
  })

  test('warns on a known source synthetic mismatch while preserving synthetic', () => {
    const warnings: string[] = []
    const result = buildCacheDiagnosticsRecord(
      input({
        synthetic: true,
        onWarning: (message: string) => warnings.push(message),
      }),
    )

    expect(result.record?.synthetic).toBe(true)
    expect(warnings).toEqual([
      'cache diagnostics source/synthetic mismatch: source=turn expected=false actual=true',
    ])
  })

  test('does not warn for an unknown source', () => {
    const warnings: string[] = []
    const result = buildCacheDiagnosticsRecord(
      input({
        source: 'future_machine',
        synthetic: true,
        onWarning: (message: string) => warnings.push(message),
      }),
    )

    expect(result.record?.source).toBe('future_machine')
    expect(warnings).toEqual([])
  })

  test('exports the known source synthetic mapping', () => {
    expect(CACHE_DIAGNOSTICS_SOURCE_SYNTHETIC).toEqual({
      turn: false,
      prewarm_cachekeep: true,
    })
  })

  test('emits beta side-channel once per hash and retains differing sets', () => {
    const tracker = new CacheDiagnosticsBetaTracker()

    expect(tracker.capture('0123456789abcdef', ['beta-b', 'beta-a'])).toBe(
      'MC-CACHE-DIAG-BETAS {"hash":"0123456789abcdef","betas":["beta-a","beta-b"]}',
    )
    expect(tracker.capture('0123456789abcdef', ['beta-a', 'beta-b'])).toBeNull()
    expect(tracker.capture('fedcba9876543210', ['beta-c'])).toBe(
      'MC-CACHE-DIAG-BETAS {"hash":"fedcba9876543210","betas":["beta-c"]}',
    )
  })

  test('formats a v2 record with the load-bearing record prefix', () => {
    const result = buildCacheDiagnosticsRecord(input())
    expect(result.record).toBeDefined()
    const line = formatCacheDiagnosticsLogLine(result.record!)
    expect(line.startsWith(CACHE_DIAGNOSTICS_LOG_PREFIX)).toBe(true)
    expect(
      JSON.parse(line.slice(CACHE_DIAGNOSTICS_LOG_PREFIX.length)),
    ).toMatchObject({
      v: 2,
      session_id: 'ses-a',
      message_id: 'provider-response-id-with-no-msg-prefix',
    })
  })

  test.each([
    [{}, 'absent'],
    [{ diagnostics: null }, 'server_null'],
    [{ diagnostics: { cache_miss_reason: null } }, 'pending'],
    [
      { diagnostics: { cache_miss_reason: { type: 'unavailable' } } },
      'populated',
    ],
  ] as const)('classifies diagnostics %j as %s', (extra, state) => {
    expect(
      buildCacheDiagnosticsRecord(
        input({ message: { ...message(undefined), ...extra } }),
      ).record?.diag_state,
    ).toBe(state)
  })

  test('rejects invalid required v2 metadata', () => {
    expect(buildCacheDiagnosticsRecord(input({ accountId: '' }))).toEqual({})
    expect(buildCacheDiagnosticsRecord(input({ betasHash: '' }))).toEqual({})
    expect(buildCacheDiagnosticsRecord(input({ source: '' }))).toEqual({})
  })

  test('copies usage values by property and keeps unavailable ordinary', () => {
    const result = buildCacheDiagnosticsRecord(input())

    expect(result.record).toMatchObject({
      cache_read: 20,
      cache_creation: 30,
      input_tokens: 10,
      ephemeral_5m_tokens: 40,
      ephemeral_1h_tokens: 50,
      miss_reason: 'unavailable',
    })
  })

  test('parses the captured populated API response', () => {
    const result = buildCacheDiagnosticsRecord(
      input({
        message: {
          id: 'msg_011SampleAnthropicId0000',
          model: 'claude-opus-5',
          usage: {
            input_tokens: 14,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 24837,
            cache_creation: {
              ephemeral_5m_input_tokens: 0,
              ephemeral_1h_input_tokens: 24837,
            },
          },
          diagnostics: {
            cache_miss_reason: {
              type: 'system_changed',
              cache_missed_input_tokens: 23963,
            },
          },
        },
      }),
    )

    expect(result.record).toMatchObject({
      diag_state: 'populated',
      miss_reason: 'system_changed',
      cache_missed_input_tokens: 23963,
    })
  })

  test('rejects malformed diagnostics without fabricating absent state', () => {
    expect(
      buildCacheDiagnosticsRecord(
        input({ message: message({ cache_miss_reason: 42 }) }),
      ),
    ).toEqual({})
  })

  test.each([
    { cache_miss_reason: 'system_changed' },
    { cache_miss_reason: {} },
    { cache_miss_reason: { type: 42 } },
  ])('rejects non-wire populated reason %j', (diagnostics) => {
    expect(
      buildCacheDiagnosticsRecord(input({ message: message(diagnostics) })),
    ).toEqual({})
  })

  test.each([
    { diagnostics: 'pending' },
    { diagnostics: [] },
    { diagnostics: 42 },
  ])('rejects malformed diagnostics shape %j', (extra) => {
    expect(
      buildCacheDiagnosticsRecord(
        input({ message: { ...message(), ...extra } }),
      ),
    ).toEqual({})
  })

  test('rejects non-finite and fractional receipt timestamps', () => {
    expect(buildCacheDiagnosticsRecord(input({ receivedAt: 100.5 }))).toEqual(
      {},
    )
    expect(
      buildCacheDiagnosticsRecord(
        input({ receivedAt: Number.POSITIVE_INFINITY }),
      ),
    ).toEqual({})
  })

  test.each([
    ['negative cache_read', { cache_read_input_tokens: -1 }],
    ['non-finite input_tokens', { input_tokens: Number.POSITIVE_INFINITY }],
  ])('rejects a record with %s', (_name, usageOverrides) => {
    expect(
      buildCacheDiagnosticsRecord(
        input({
          message: {
            ...message({ cache_miss_reason: { type: 'unavailable' } }),
            usage: { ...usage, ...usageOverrides },
          },
        }),
      ),
    ).toEqual({})
  })

  test('applies opt-in without replacing existing body fields', () => {
    const body: Record<string, unknown> = { model: 'x' }
    applyCacheDiagnosticsOptIn(body, null)
    expect(body).toEqual({
      model: 'x',
      diagnostics: { previous_message_id: null },
    })
  })

  test.each([
    [{ cache_control: { type: 'ephemeral', ttl: '1h' } }, '1h'],
    [{ cache_control: { type: 'ephemeral' } }, '5m'],
    [{}, null],
  ] as const)('summarizes TTL as %s', (body, expected) => {
    expect(summarizeCacheTtl(body)).toBe(expected)
  })

  test.each([
    [
      {
        system: [{ cache_control: { type: 'ephemeral' } }],
        messages: [
          { content: [{ cache_control: { type: 'ephemeral', ttl: '1h' } }] },
        ],
      },
      '1h',
    ],
    [
      {
        system: [{ cache_control: { type: 'ephemeral', ttl: '1h' } }],
        messages: [{ content: [{ cache_control: { type: 'ephemeral' } }] }],
      },
      '5m',
    ],
  ] as const)('uses the last cache breakpoint as TTL %s', (body, expected) => {
    expect(summarizeCacheTtl(body)).toBe(expected)
  })

  test('emits a short-gap canary only for previous_message_not_found', () => {
    const result = buildCacheDiagnosticsRecord(
      input({
        request: {
          ...request,
          previousMessageId: 'provider-previous',
          previousMessageReceivedAt: 1_000,
        },
        message: message({
          cache_miss_reason: { type: 'previous_message_not_found' },
        }),
        receivedAt: 1_000 + 5 * 60_000 - 1,
      }),
    )

    expect(result.canary).toEqual({
      messageId: 'provider-response-id-with-no-msg-prefix',
      previousMessageId: 'provider-previous',
    })
  })

  test.each([
    { reason: 'unavailable', previousMessageId: 'provider-previous', age: 1 },
    {
      reason: 'previous_message_not_found',
      previousMessageId: 'provider-previous',
      age: 5 * 60_000,
    },
    {
      reason: 'previous_message_not_found',
      previousMessageId: null,
      age: 1,
    },
  ])('does not emit a canary for %j', ({ reason, previousMessageId, age }) => {
    const previousMessageReceivedAt = 1_000
    const result = buildCacheDiagnosticsRecord(
      input({
        request: {
          ...request,
          previousMessageId,
          previousMessageReceivedAt,
        },
        message: message({ cache_miss_reason: { type: reason } }),
        receivedAt: previousMessageReceivedAt + age,
      }),
    )

    expect(result.canary).toBeUndefined()
  })
})
