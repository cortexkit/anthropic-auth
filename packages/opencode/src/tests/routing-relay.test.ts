import { afterEach, describe, expect, test } from 'bun:test'
import { fetchOAuthQuotaSnapshot } from '@cortexkit/anthropic-auth-core'
import { createRoutingRelay, ROUTING_HOLD_LIMIT_MS } from '../routing-relay'

const key = Symbol.for('cortexkit.routing')
const globals = globalThis as Record<symbol, unknown>
const candidates = [{ accountIdentity: 'account', credentialId: 'credential' }]
afterEach(() => {
  delete globals[key]
})

describe('shared routing relay', () => {
  test('discovers a bridge installed after module and client load', async () => {
    const relay = createRoutingRelay()
    expect(await relay.accountFor('session', 'model', candidates)).toBeNull()
    globals[key] = (session: string) => ({
      accountFor: async (input: unknown, options: unknown) => {
        expect(session).toBe('session')
        expect(input).toEqual({ provider: 'anthropic', modelId: 'model' })
        expect(options).toEqual({ deadlineMs: 2000 })
        return { account_id: 'account', credential_id: 'credential' }
      },
    })
    expect(await relay.accountFor('session', 'model', candidates)).toEqual({
      account_id: 'account',
      credential_id: 'credential',
    })
  })

  test.each(['null', 'throw', 'reject', 'malformed'])(
    '%s advice fails open',
    async (mode) => {
      globals[key] = () => ({
        accountFor: () => {
          if (mode === 'throw') throw new Error('bridge failed')
          if (mode === 'reject')
            return Promise.reject(new Error('bridge failed'))
          return mode === 'null' ? null : { account_id: 5 }
        },
      })
      expect(
        await createRoutingRelay().accountFor('session', 'model', candidates),
      ).toBeNull()
    },
  )

  test('a reply resolved after two seconds is ignored', async () => {
    let resolve!: (value: unknown) => void
    globals[key] = () => ({
      accountFor: () =>
        new Promise((done) => {
          resolve = done
        }),
    })
    const start = performance.now()
    const result = await createRoutingRelay().accountFor(
      'session',
      'model',
      candidates,
    )
    expect(result).toBeNull()
    expect(performance.now() - start).toBeGreaterThanOrEqual(1900)
    resolve({ account_id: 'late', credential_id: 'late' })
  })

  test('caps a hold at fifteen minutes plus twenty seconds', async () => {
    globals[key] = () => ({
      accountFor: async () => ({
        account_id: 'account',
        credential_id: 'credential',
        hold: { retry_after_ms: 9_000_000 },
      }),
    })
    expect(
      (await createRoutingRelay().accountFor('session', 'model', candidates))
        ?.hold?.retry_after_ms,
    ).toBe(ROUTING_HOLD_LIMIT_MS)
  })

  test('a served response reports only all lowercased rate-limit headers, even at full utilization', async () => {
    const reports: unknown[] = []
    globals[key] = () => ({ report: (report: unknown) => reports.push(report) })
    const relay = createRoutingRelay()
    const subject = { accountIdentity: 'account', credentialId: 'credential' }
    relay.report(
      'session',
      subject,
      new Headers({
        'Anthropic-RateLimit-Unified-5h-Utilization': '1',
        'Anthropic-RateLimit-Future-Field': 'unfiltered',
        authorization: 'never sent',
        'request-id': 'never sent',
      }),
      200,
    )
    await Promise.resolve()
    expect(reports).toEqual([
      {
        account_id: 'account',
        credential_id: 'credential',
        outcome: 'served',
        headers: {
          'anthropic-ratelimit-unified-5h-utilization': '1',
          'anthropic-ratelimit-future-field': 'unfiltered',
        },
      },
    ])
    relay.report('session', subject, new Headers(), 429)
    relay.report('session', subject, new Headers(), 401)
    await Promise.resolve()
    expect(reports.slice(1)).toEqual([
      {
        account_id: 'account',
        credential_id: 'credential',
        outcome: 'exhausted',
        window: '7d',
      },
    ])
  })

  test.each(['throw', 'reject', 'pending'])(
    'a %s report is detached and harmless',
    async (mode) => {
      globals[key] = () => ({
        report: () => {
          if (mode === 'throw') throw new Error('report failed')
          if (mode === 'reject')
            return Promise.reject(new Error('report failed'))
          return new Promise(() => {})
        },
      })
      expect(
        createRoutingRelay().report(
          'session',
          { accountIdentity: 'account' },
          new Headers(),
          200,
        ),
      ).toBeUndefined()
      await Promise.resolve()
      await Promise.resolve()
    },
  )

  test.each([
    ['5h', '5h'],
    ['7d', '7d'],
  ])(
    'attributes a raw rejected 429 window %s as %s',
    async (suffix, window) => {
      const reports: unknown[] = []
      globals[key] = () => ({
        report: (report: unknown) => reports.push(report),
      })
      createRoutingRelay().report(
        'session',
        { accountIdentity: 'account' },
        new Headers({
          [`anthropic-ratelimit-unified-${suffix}-status`]: 'rejected',
          [`anthropic-ratelimit-unified-${suffix}-utilization`]: '0.996',
          [`anthropic-ratelimit-unified-${suffix}-reset`]: '2000000000',
        }),
        429,
        'claude-fable-5',
      )
      await Promise.resolve()
      expect(reports).toEqual([
        {
          account_id: 'account',
          outcome: 'exhausted',
          window,
          resets_at: 2_000_000_000_000,
        },
      ])
    },
  )

  test.each([undefined, 'Claude-Fable-5-Pool'])(
    'scoped exhaustion uses the stored poll pool identity %s',
    async (modelId) => {
      const stored = await fetchOAuthQuotaSnapshot({
        accessToken: 'token',
        fetchImpl: Object.assign(
          async () =>
            new Response(
              JSON.stringify({
                limits: [
                  {
                    kind: 'weekly_scoped',
                    group: 'weekly',
                    percent: 20,
                    scope: {
                      model: {
                        display_name: ' Fable ',
                        ...(modelId ? { id: modelId } : {}),
                      },
                    },
                  },
                ],
              }),
            ),
          { preconnect: fetch.preconnect },
        ),
      })
      const reports: unknown[] = []
      globals[key] = () => ({
        report: (report: unknown) => reports.push(report),
      })
      createRoutingRelay(async (subject) => {
        expect(subject.accountIdentity).toBe('account')
        return stored
      }).report(
        'session',
        { accountIdentity: 'account' },
        new Headers({
          'anthropic-ratelimit-unified-7d_fable-status': 'rejected',
          'anthropic-ratelimit-unified-7d_fable-reset': '2000000000',
        }),
        429,
        'claude-fable-5',
      )
      await Promise.resolve()
      await Promise.resolve()
      expect(reports).toEqual([
        {
          account_id: 'account',
          outcome: 'exhausted',
          window: '7d',
          pool: (modelId ?? 'Fable').toLowerCase(),
          resets_at: 2_000_000_000_000,
        },
      ])
    },
  )

  test.each(['missing', 'headers', 'other-model', 'read-failed'])(
    'scoped exhaustion with %s poll reading never blocks the whole account',
    async (mode) => {
      const reports: unknown[] = []
      globals[key] = () => ({
        report: (report: unknown) => reports.push(report),
      })
      createRoutingRelay(async () => {
        if (mode === 'read-failed') throw new Error('storage unavailable')
        if (mode === 'missing') return undefined
        return {
          scoped: [
            {
              id:
                mode === 'headers' ? '7d_fable' : 'claude-weekly-scoped-mythos',
              title: mode === 'headers' ? 'fable' : 'Mythos only',
              modelName: mode === 'headers' ? 'fable' : 'Mythos',
              usedPercent: 20,
              remainingPercent: 80,
              checkedAt: Date.now(),
            },
          ],
        }
      }).report(
        'session',
        { accountIdentity: 'account' },
        new Headers({
          'anthropic-ratelimit-unified-7d_fable-status': 'rejected',
        }),
        429,
        'claude-fable-5',
      )
      await Promise.resolve()
      await Promise.resolve()
      expect(reports).toEqual([])
    },
  )

  test('an unconfirmed 429 ignores rounded utilization and binding claims and falls back to 7d', async () => {
    const reports: unknown[] = []
    globals[key] = () => ({ report: (report: unknown) => reports.push(report) })
    createRoutingRelay().report(
      'session',
      { accountIdentity: 'account' },
      new Headers({
        'anthropic-ratelimit-unified-5h-utilization': '0.996',
        'anthropic-ratelimit-unified-representative-claim': 'five_hour',
      }),
      429,
    )
    await Promise.resolve()
    expect(reports).toEqual([
      { account_id: 'account', outcome: 'exhausted', window: '7d' },
    ])
  })

  test('reports each exhausted window from the same 429 once', async () => {
    const reports: unknown[] = []
    globals[key] = () => ({ report: (report: unknown) => reports.push(report) })
    createRoutingRelay(async () => ({
      scoped: [
        {
          id: 'claude-weekly-scoped-fable',
          title: 'Fable only',
          modelName: 'Fable',
          usedPercent: 20,
          remainingPercent: 80,
          checkedAt: Date.now(),
        },
      ],
    })).report(
      'session',
      { accountIdentity: 'account' },
      new Headers({
        'anthropic-ratelimit-unified-5h-utilization': '1',
        'anthropic-ratelimit-unified-7d-status': 'rejected',
        'anthropic-ratelimit-unified-7d_fable-utilization': '1.01',
        'anthropic-ratelimit-unified-7d_fable-status': 'rejected',
      }),
      429,
      'claude-fable-5',
    )
    await Promise.resolve()
    await Promise.resolve()
    expect(reports).toEqual([
      ...['5h', '7d'].map((window) => ({
        account_id: 'account',
        outcome: 'exhausted',
        window,
      })),
      {
        account_id: 'account',
        outcome: 'exhausted',
        window: '7d',
        pool: 'fable',
      },
    ])
  })
})
