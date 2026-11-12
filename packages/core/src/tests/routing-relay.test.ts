import { afterEach, expect, test } from 'bun:test'
import { createRoutingRelay, RoutingRefusalError } from '../routing-relay.ts'

const key = Symbol.for('cortexkit.routing')
const globals = globalThis as Record<symbol, unknown>
afterEach(() => {
  delete globals[key]
})

test('routing refusal uses fixed text and explicit retry seconds before reset time', async () => {
  globals[key] = () => ({
    accountFor: async () => ({
      refused: {
        code: 'account_limit_exhausted',
        routing_code: 'not user text',
        retry_after_secs: 17,
        resets_at_ms: Date.now() + 900_000,
      },
    }),
  })
  await expect(
    createRoutingRelay().accountFor('session', 'model', []),
  ).rejects.toMatchObject({
    code: 'account_limit_exhausted',
    retryAfterSecs: 17,
    message: 'Shared routing has no account for this request right now.',
  })
})

test('routing refusal reset time is rounded up and final selection has no retry hint', () => {
  expect(
    new RoutingRefusalError(
      { code: 'account_selection_refused', resetsAtMs: 4501 },
      1000,
    )
      .response()
      .headers.get('retry-after'),
  ).toBe('4')
  expect(
    new RoutingRefusalError({
      code: 'account_selection_final',
      retryAfterSecs: 5,
    })
      .response()
      .headers.get('retry-after'),
  ).toBeNull()
})

test('rejected routing admission sends no served or exhausted report', async () => {
  const reports: unknown[] = []
  globals[key] = () => ({
    accountFor: async () => ({
      account_id: 'account',
      credential_id: 'credential',
    }),
    report: (report: unknown) => reports.push(report),
  })
  const relay = createRoutingRelay()
  const account = { accountIdentity: 'account', credentialId: 'credential' }
  await relay.accountFor('session', 'model', [account])
  expect(relay.admitted('session', account)).toBe(true)
  relay.override('session', 'credential unavailable')
  expect(relay.admitted('session', account)).toBe(false)
  relay.report('session', { accountIdentity: 'other' }, new Headers(), 200)
  relay.report(
    'session',
    account,
    new Headers({ 'anthropic-ratelimit-unified-5h-status': 'rejected' }),
    429,
  )
  await Promise.resolve()
  expect(reports).toEqual([])
})

test('host retry cap bounds routing refusals and hosted holds to fifteen minutes', async () => {
  for (const refusal of [
    { code: 'account_limit_exhausted' as const, retryAfterSecs: 93_151 },
    {
      code: 'account_limit_exhausted' as const,
      resetsAtMs: Date.now() + 26 * 3_600_000,
    },
  ]) {
    const error = new RoutingRefusalError(refusal)
    expect(error.retryAfterSecs).toBe(900)
    expect(error.response().headers.get('retry-after')).toBe('900')
  }
  globals[key] = () => ({
    accountFor: async () => ({
      account_id: 'account',
      credential_id: 'credential',
      hold: { retry_after_ms: 93_151_000 },
    }),
  })
  expect(
    await createRoutingRelay().accountFor('session', 'model', [
      { accountIdentity: 'account', credentialId: 'credential' },
    ]),
  ).toMatchObject({ hold: { retry_after_ms: 900_000 } })
})
