import { afterEach, describe, expect, mock } from 'bun:test'
import { tokenFingerprint } from '@cortexkit/anthropic-auth-core'
import { ROUTING_HOLD_LIMIT_MS } from '../routing-relay'
import { installLoaderSetup } from './support/opencode1-loader-setup'
import {
  bindPoolAccounts,
  createFallbackStorage,
  getPlugin,
  syntheticFallbackAccountUuid,
  syntheticMainAccountUuid,
  useTempAccountFile,
  withNativeAdmission,
} from './support/opencode1-pool-fixture'
import {
  createOpencode1Test,
  createOpencode1TestContext,
  installOpencode1TestHooks,
} from './support/opencode1-test-context'
import { extractUrl, MESSAGES_URL } from './test-fetch'

const ctx = createOpencode1TestContext()
installOpencode1TestHooks(ctx)
const test = createOpencode1Test(ctx)
const globals = globalThis as Record<symbol, unknown>
const key = Symbol.for('cortexkit.routing')
afterEach(() => {
  delete globals[key]
})

describe('OC1 shared routing relay', () => {
  installLoaderSetup(ctx)
  async function fixture(
    mode = 'normal',
    responseFor?: () => Response,
    modelId?: string,
  ) {
    const now = Date.now()
    const quota = (remaining: number, fable = 100) => ({
      checkedAt: now,
      five_hour: {
        usedPercent: 100 - remaining,
        remainingPercent: remaining,
        checkedAt: now,
      },
      seven_day: { usedPercent: 0, remainingPercent: 100, checkedAt: now },
      scoped:
        mode === 'fable-without-poll'
          ? []
          : [
              {
                id: `claude-weekly-scoped-${modelId ?? 'fable'}`,
                title: 'Fable only',
                modelName: 'Fable',
                ...(modelId ? { modelId } : {}),
                usedPercent: 100 - fable,
                remainingPercent: fable,
                checkedAt: now,
              },
            ],
    })
    await useTempAccountFile(
      ctx,
      bindPoolAccounts(
        createFallbackStorage({
          routing: { mode: 'sticky-balanced' },
          quota: {
            enabled: true,
            checkIntervalMinutes: 5,
            minimumRemaining: { five_hour: 1, seven_day: 1 },
            failClosedOnUnknownQuota: true,
            mainQuota: quota(
              mode === 'blocked' ? 10 : 100,
              mode === 'reserve' ? 0 : 100,
            ),
            mainQuotaCheckedAt: now,
            mainQuotaToken: tokenFingerprint('sk-ant-oat01-main-access'),
          },
          ...(mode === 'floor' || mode === 'blocked'
            ? { killswitch: { enabled: true, main: { five_hour: 20 } } }
            : {}),
          accounts: [
            {
              id: 'fallback-1',
              type: 'oauth',
              access: 'sk-ant-oat01-fallback-access',
              refresh: 'fallback-refresh',
              expires: now + 3600_000,
              quota: quota(mode === 'floor' || mode === 'blocked' ? 10 : 80),
            },
          ],
        }),
      ),
    )
    const sends: string[] = []
    globalThis.fetch = mock(
      withNativeAdmission(ctx, (input: any, init: any) => {
        if (extractUrl(input).includes('/api/oauth/usage'))
          return Promise.resolve(
            new Response(
              JSON.stringify({
                five_hour: { utilization: 0 },
                seven_day: { utilization: 0 },
              }),
            ),
          )
        if (extractUrl(input).includes('/v1/messages')) {
          sends.push(new Headers(init?.headers).get('authorization') ?? '')
          if (responseFor) return Promise.resolve(responseFor())
        }
        return Promise.resolve(
          new Response('ok', {
            headers: {
              'Anthropic-RateLimit-Future': 'all',
              'request-id': 'private',
            },
          }),
        )
      }),
    ) as unknown as typeof fetch
    const plugin = await getPlugin(ctx)
    const loader = (await plugin.auth!.loader!(
      async () => ({
        type: 'oauth',
        access: 'sk-ant-oat01-main-access',
        refresh: 'main-refresh',
        expires: now + 100_000,
      }),
      { models: {} } as any,
    )) as any
    const send = () =>
      loader.fetch(MESSAGES_URL, {
        method: 'POST',
        headers: { 'x-session-affinity': 'ses_relay_oc1' },
        body: JSON.stringify({
          model: mode.startsWith('fable')
            ? 'claude-fable-5'
            : mode === 'reserve'
              ? 'claude-opus-4-8'
              : 'claude-sonnet-5',
          messages: [{ role: 'user', content: 'hello' }],
          max_tokens: 10,
        }),
      }) as Promise<Response>
    return { sends, send }
  }

  test('accepts advice installed after load, pins it and reports only safe headers', async () => {
    const f = await fixture()
    // Establish a different sticky assignment before the runner asks to move it.
    await (await f.send()).text()
    expect(f.sends.at(-1)).toBe('Bearer sk-ant-oat01-main-access')
    const reports: unknown[] = []
    let answer: unknown = {
      account_id: syntheticFallbackAccountUuid(0),
      credential_id: 'local',
    }
    globals[key] = () => ({
      accountFor: async () => answer,
      report: (value: unknown) => {
        reports.push(value)
        throw new Error('report failure cannot fail the request')
      },
    })
    await (await f.send()).text()
    expect(f.sends.at(-1)).toBe('Bearer sk-ant-oat01-fallback-access')
    expect(reports).toEqual([
      {
        account_id: syntheticFallbackAccountUuid(0),
        outcome: 'served',
        headers: { 'anthropic-ratelimit-future': 'all' },
      },
    ])
    answer = null
    await (await f.send()).text()
    expect(f.sends.at(-1)).toBe('Bearer sk-ant-oat01-fallback-access')
    expect(reports).toHaveLength(2)
  })

  for (const mode of ['null', 'unknown', 'floor', 'reserve']) {
    test(`${mode} advice falls back to our own account choice`, async () => {
      const f = await fixture(mode)
      globals[key] = () => ({
        accountFor: async () =>
          mode === 'null'
            ? null
            : {
                account_id:
                  mode === 'unknown'
                    ? 'unknown'
                    : syntheticFallbackAccountUuid(0),
                credential_id: 'local',
                ...(mode === 'floor' ? { hold: { retry_after_ms: 100 } } : {}),
              },
      })
      await (await f.send()).text()
      expect(f.sends.at(-1)).toBe('Bearer sk-ant-oat01-main-access')
    })
  }

  test('an eligible hold returns 429 and capped Retry-After without sending', async () => {
    const f = await fixture()
    globals[key] = () => ({
      accountFor: async () => ({
        account_id: syntheticFallbackAccountUuid(0),
        credential_id: 'local',
        hold: { retry_after_ms: 9_000_000 },
      }),
    })
    const response = await f.send()
    expect(response.status).toBe(429)
    expect(response.headers.get('retry-after')).toBe(
      String(ROUTING_HOLD_LIMIT_MS / 1000),
    )
    expect(f.sends).toEqual([])
    delete globals[key]
    await (await f.send()).text()
    expect(f.sends.at(-1)).toBe('Bearer sk-ant-oat01-fallback-access')
  })

  test('an unknown held account cannot replace our no-route response', async () => {
    const f = await fixture('blocked')
    const baseline = await f.send()
    const baselineBody = await baseline.text()
    globals[key] = () => ({
      accountFor: async () => ({
        account_id: 'unknown',
        credential_id: 'unknown',
        hold: { retry_after_ms: 123_000 },
      }),
    })
    const response = await f.send()
    expect(response.status).toBe(baseline.status)
    expect(response.headers.get('retry-after')).toBe(
      baseline.headers.get('retry-after'),
    )
    expect(await response.text()).toBe(baselineBody)
    expect(f.sends).toEqual([])
  })

  test('a served 200 at 0.996 sends only served with the raw utilization', async () => {
    const f = await fixture(
      'normal',
      () =>
        new Response('ok', {
          headers: {
            'anthropic-ratelimit-unified-5h-utilization': '0.996',
          },
        }),
    )
    const reports: unknown[] = []
    globals[key] = () => ({
      accountFor: async () => null,
      report: (report: unknown) => reports.push(report),
    })
    await (await f.send()).text()
    expect(reports).toEqual([
      {
        account_id: syntheticMainAccountUuid,
        outcome: 'served',
        headers: {
          'anthropic-ratelimit-unified-5h-utilization': '0.996',
        },
      },
    ])
  })

  for (const streaming of [false, true]) {
    test(`${streaming ? 'stream rate limit' : '429'} reports upstream 7d exhaustion before a sticky hold rewrites Retry-After`, async () => {
      const reset = Math.floor(Date.now() / 1000) + 120
      const f = await fixture(
        'normal',
        () =>
          new Response(
            streaming
              ? 'event: error\ndata: {"type":"error","error":{"type":"rate_limit_error","message":"limited"}}\n\n'
              : 'limited',
            {
              status: streaming ? 200 : 429,
              headers: {
                'content-type': streaming ? 'text/event-stream' : 'text/plain',
                'retry-after': '999999',
                'anthropic-ratelimit-unified-7d-utilization': '1.0',
                'anthropic-ratelimit-unified-7d-reset': String(reset),
              },
            },
          ),
      )
      const reports: Array<{ outcome: string; [key: string]: unknown }> = []
      globals[key] = () => ({
        accountFor: async () => null,
        report: (report: { outcome: string; [key: string]: unknown }) =>
          reports.push(report),
      })
      const response = await f.send()
      expect(response.status).toBe(429)
      expect(Number(response.headers.get('retry-after'))).toBeLessThanOrEqual(
        140,
      )
      expect(f.sends).toHaveLength(1)
      expect(
        reports.filter((report) => report.outcome === 'exhausted'),
      ).toEqual([
        {
          account_id: syntheticMainAccountUuid,
          outcome: 'exhausted',
          window: '7d',
          resets_at: reset * 1000,
        },
      ])
      await response.body?.cancel()
    })
  }

  for (const { mode, modelId, pool } of [
    { mode: 'fable', modelId: undefined, pool: 'fable' },
    { mode: 'fable', modelId: 'Claude-Fable-Pool', pool: 'claude-fable-pool' },
    // Outside routing's pool alphabet even after lowercasing: no report at all.
    { mode: 'fable', modelId: 'Fable Pool', pool: undefined },
    { mode: 'fable-without-poll', modelId: undefined, pool: undefined },
  ]) {
    test(`Fable 429 (${mode}, model id ${modelId}) reports pool ${pool} on OpenCode 1`, async () => {
      let calls = 0
      const f = await fixture(
        mode,
        () =>
          ++calls === 1
            ? new Response('limited', {
                status: 429,
                headers: {
                  'anthropic-ratelimit-unified-7d_fable-status': 'rejected',
                },
              })
            : new Response('ok'),
        modelId,
      )
      const reports: Array<{ outcome: string; [key: string]: unknown }> = []
      globals[key] = () => ({
        accountFor: async () => null,
        report: (report: (typeof reports)[number]) => reports.push(report),
      })
      const response = await f.send()
      await response.body?.cancel()
      expect(
        reports.filter((report) => report.outcome === 'exhausted'),
      ).toEqual(
        pool
          ? [
              {
                account_id: syntheticMainAccountUuid,
                outcome: 'exhausted',
                window: '7d',
                pool,
              },
            ]
          : [],
      )
    })
  }
})
