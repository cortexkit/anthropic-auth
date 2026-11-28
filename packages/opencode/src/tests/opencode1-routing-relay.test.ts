import { afterEach, describe, expect, mock, spyOn } from 'bun:test'
import { gunzipSync } from 'node:zlib'
import {
  sessionCacheActivity,
  tokenFingerprint,
} from '@cortexkit/anthropic-auth-core'
import { ROUTING_HOLD_LIMIT_MS } from '../routing-relay'
import {
  refusalThinkingReply,
  SOURCE_MODEL,
  TARGET_MODEL,
  TARGET_SIGNATURE,
} from './fixtures/refusal-thinking'
import { getPluginTestHandles } from './plugin-test-handles'
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
  getBodyLifetime,
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
  sessionCacheActivity.forget('ses_relay_oc1_warm_retry')
})

describe('OC1 shared routing relay', () => {
  installLoaderSetup(ctx)
  async function fixture(
    mode = 'normal',
    responseFor?: () => Response,
    modelId?: string,
    routingMode:
      | 'sticky-balanced'
      | 'main-first'
      | 'fallback-first' = 'sticky-balanced',
    relay = false,
    sessionId = 'ses_relay_oc1',
    orderedQuota?: {
      evidence: 'poll' | 'rounded headers' | 'past reset' | 'stale poll'
      second?: 'healthy' | 'blocked'
    },
  ) {
    const now = Date.now()
    const paidBackup = mode.startsWith('paid backup')
    const mainExhausted = paidBackup && mode !== 'paid backup'
    const mainKilled =
      mode === 'blocked' || mode === 'three accounts with killswitch'
    const providerWait =
      mode === 'provider wait' ||
      mode === 'three accounts with provider wait' ||
      mode === 'paid backup after OAuth with provider wait'
    const paidAccount = {
      id: 'paid',
      type: 'api' as const,
      apiKey: 'paid-key',
      baseURL: 'https://paid.example.test',
      authHeader: 'authorization-bearer' as const,
    }
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
    const orderedFallbackQuota = () => {
      const checkedAt =
        orderedQuota?.evidence === 'stale poll' ? now - 3600_000 : now
      return {
        ...quota(0),
        source:
          orderedQuota?.evidence === 'rounded headers'
            ? ('headers' as const)
            : ('poll' as const),
        checkedAt,
        five_hour: {
          ...quota(0).five_hour,
          checkedAt,
          resetsAt: new Date(
            now +
              (orderedQuota?.evidence === 'past reset' ? -60_000 : 3600_000),
          ).toISOString(),
        },
        seven_day: { ...quota(0).seven_day, checkedAt },
        scoped: [],
      }
    }
    await useTempAccountFile(
      ctx,
      bindPoolAccounts(
        createFallbackStorage({
          routing: { mode: routingMode },
          ...((mode === 'overloaded' ||
            mode.startsWith('three accounts with') ||
            mode === 'paid backup after OAuth with provider wait') && {
            fallbackOn: [429, 503],
          }),
          ...(relay && {
            relay: {
              enabled: true,
              url: 'https://relay.example.test',
              token: 'relay-token',
              fallbackToDirect: false,
              transport: 'http',
            },
          }),
          quota: {
            enabled: true,
            checkIntervalMinutes: 5,
            minimumRemaining: {
              five_hour: orderedQuota ? 0 : mode === 'refusal floor' ? 20 : 1,
              seven_day: 1,
            },
            failClosedOnUnknownQuota: true,
            mainQuota: {
              ...quota(
                mainExhausted ? 0 : mainKilled ? 10 : 100,
                mode === 'reserve' ? 0 : 100,
              ),
              ...((mode === 'paid backup without provider wait' ||
                mode === 'paid backup before OAuth') && {
                source: 'headers' as const,
                fieldSources: { five_hour: 'poll' as const },
              }),
            },
            mainQuotaCheckedAt: now,
            mainQuotaToken: tokenFingerprint('sk-ant-oat01-main-access'),
            ...(providerWait && {
              mainLastQuotaApiError: {
                message: 'usage wait',
                checkedAt: now,
                nextRetryAt: now + 60_000,
                accountIdentity: syntheticMainAccountUuid,
              },
            }),
            ...(mode === 'refresh cadence' && { refreshEveryNRequests: 1 }),
          },
          ...(mode === 'floor' || mainKilled
            ? {
                killswitch: {
                  enabled: true,
                  main: { five_hour: 20 },
                  ...(orderedQuota && {
                    accounts: {
                      'fallback-1': { five_hour: 0 },
                      'fallback-2': { five_hour: 0 },
                    },
                  }),
                },
              }
            : {}),
          accounts:
            paidBackup && !mode.includes('OAuth')
              ? [paidAccount]
              : [
                  ...(mode === 'paid backup before OAuth' ? [paidAccount] : []),
                  {
                    id: 'fallback-1',
                    type: 'oauth',
                    access: 'sk-ant-oat01-fallback-access',
                    refresh: 'fallback-refresh',
                    expires: now + 3600_000,
                    quota: orderedQuota
                      ? orderedFallbackQuota()
                      : mode === 'unknown quota'
                        ? undefined
                        : quota(
                            ['floor', 'blocked', 'refusal floor'].includes(mode)
                              ? 10
                              : 80,
                          ),
                    ...(mode === 'signed out'
                      ? {
                          lastRefreshError: {
                            message: 'sign in required',
                            checkedAt: now,
                            permanent: true,
                          },
                        }
                      : {}),
                  },
                  ...(mode.startsWith('three accounts') || orderedQuota?.second
                    ? [
                        {
                          id: 'fallback-2',
                          type: 'oauth' as const,
                          access: 'sk-ant-oat01-third-access',
                          refresh: 'third-refresh',
                          expires: now + 3600_000,
                          quota:
                            orderedQuota?.second === 'blocked'
                              ? orderedFallbackQuota()
                              : quota(
                                  mode === 'three accounts for warm retry'
                                    ? 50
                                    : 80,
                                ),
                        },
                      ]
                    : []),
                  ...(mode === 'paid backup after OAuth with provider wait'
                    ? [paidAccount]
                    : []),
                ],
        }),
      ),
    )
    const sends: string[] = []
    const bodies: string[] = []
    globalThis.fetch = mock(
      withNativeAdmission(ctx, (input: any, init: any) => {
        if (extractUrl(input).startsWith('https://relay.example.test')) {
          const envelope = JSON.parse(String(init.body))
          bodies.push(envelope.body)
          sends.push(
            new Headers(envelope.upstream.headers).get('authorization') ?? '',
          )
          if (responseFor) return Promise.resolve(responseFor())
        }
        if (
          orderedQuota &&
          extractUrl(input).includes('/api/oauth/usage') &&
          !new Headers(init?.headers).get('authorization')?.includes('main')
        )
          return Promise.resolve(new Response('{}', { status: 503 }))
        if (extractUrl(input).includes('/api/oauth/usage'))
          return Promise.resolve(
            new Response(
              JSON.stringify(
                mode === 'unknown quota' &&
                  new Headers(init?.headers)
                    .get('authorization')
                    ?.includes('fallback')
                  ? {}
                  : {
                      five_hour: {
                        utilization: paidBackup ? 100 : 0,
                      },
                      seven_day: { utilization: 0 },
                    },
              ),
            ),
          )
        if (extractUrl(input).includes('/v1/messages')) {
          sends.push(new Headers(init?.headers).get('authorization') ?? '')
          bodies.push(
            new Headers(init?.headers).get('content-encoding') === 'gzip'
              ? gunzipSync(init.body).toString()
              : String(init.body),
          )
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
    const send = (
      payload?: Record<string, unknown> | ReadableStream<Uint8Array>,
    ) =>
      loader.fetch(MESSAGES_URL, {
        method: 'POST',
        headers: { 'x-session-affinity': sessionId },
        body:
          payload instanceof ReadableStream
            ? payload
            : JSON.stringify(
                payload ?? {
                  model: mode.startsWith('fable')
                    ? 'claude-fable-5'
                    : mode === 'reserve'
                      ? 'claude-opus-4-8'
                      : 'claude-sonnet-5',
                  messages: [{ role: 'user', content: 'hello' }],
                  max_tokens: 10,
                },
              ),
      }) as Promise<Response>
    return {
      sends,
      send,
      bodies,
      ...getPluginTestHandles(plugin),
    }
  }

  const mainBearer = 'Bearer sk-ant-oat01-main-access'
  const fallbackBearer = 'Bearer sk-ant-oat01-fallback-access'
  const healthyFallbackBearer = 'Bearer sk-ant-oat01-third-access'

  for (const mode of ['main-first', 'fallback-first'] as const) {
    test.each(['poll', 'rounded headers', 'past reset', 'stale poll'] as const)(
      `OC1 ${mode} ordered fallback uses confirmed provider quota only (%s)`,
      async (evidence) => {
        let sends = 0
        const f = await fixture(
          'normal',
          () =>
            mode === 'main-first' && sends++ === 0
              ? new Response('main refused', { status: 403 })
              : new Response('served'),
          undefined,
          mode,
          false,
          `ses_oc1_ordered_${mode}_${evidence.replaceAll(' ', '-')}`,
          { evidence, second: 'healthy' },
        )
        expect(await (await f.send()).text()).toBe('served')
        expect(f.sends).toEqual([
          ...(mode === 'main-first' ? [mainBearer] : []),
          evidence === 'poll' ? healthyFallbackBearer : fallbackBearer,
        ])
      },
    )
  }

  test('OC1 ordered quota stop names the provider limit once without sending', async () => {
    const f = await fixture(
      'blocked',
      undefined,
      undefined,
      'main-first',
      false,
      undefined,
      { evidence: 'poll', second: 'blocked' },
    )
    const response = await f.send()
    expect(f.sends).toEqual([])
    const { error } = (await response.json()) as { error: { message: string } }
    expect(error.message).toContain('Killswitch')
    expect(error.message).toContain(
      'Provider limits on other accounts (quota settings cannot raise these): 5-hour.',
    )
  })

  test('OC1 ordered routing keeps the upstream main refusal when the fallbacks are provider-blocked', async () => {
    const f = await fixture(
      'normal',
      () =>
        new Response('upstream main refusal', {
          status: 429,
          headers: { 'retry-after': '17' },
        }),
      undefined,
      'main-first',
      false,
      undefined,
      { evidence: 'poll', second: 'blocked' },
    )
    const response = await f.send()
    expect(response.status).toBe(429)
    expect(response.headers.get('retry-after')).toBe('17')
    expect(await response.text()).toBe('upstream main refusal')
    expect(f.sends).toEqual([mainBearer])
  })

  test('OC1 ordered fallback uses raw quota refusal headers on a revisit', async () => {
    let sends = 0
    const f = await fixture(
      'normal',
      () =>
        sends++ === 0
          ? new Response('fallback refused', {
              status: 429,
              headers: {
                'anthropic-ratelimit-unified-5h-status': 'rejected',
                'anthropic-ratelimit-unified-5h-reset': String(
                  Math.ceil(Date.now() / 1000) + 3600,
                ),
              },
            })
          : new Response('upstream main refusal', { status: 403 }),
      undefined,
      'fallback-first',
      false,
      undefined,
      { evidence: 'rounded headers' },
    )
    expect(await (await f.send()).text()).toBe('upstream main refusal')
    expect(f.sends).toEqual([fallbackBearer, mainBearer])
  })

  test.each(['sticky-balanced', 'main-first'] as const)(
    'OC1 %s scoped Fable retry prefers the last accepted cache account',
    async (mode) => {
      let sends = 0
      const reply = {
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
      }
      const f = await fixture(
        'three accounts for warm retry',
        () =>
          ++sends === 2
            ? new Response('limited', {
                status: 429,
                headers: {
                  'anthropic-ratelimit-unified-7d-utilization': '0.64',
                  'anthropic-ratelimit-unified-7d_fable-utilization': '1',
                  'anthropic-ratelimit-unified-7d_fable-reset': String(
                    Math.floor(Date.now() / 1000) + 86_400,
                  ),
                },
              })
            : Response.json(reply),
        undefined,
        mode,
        false,
        'ses_relay_oc1_warm_retry',
      )
      let accountId = syntheticFallbackAccountUuid(1)
      globals[key] = () => ({
        accountFor: async () => ({
          account_id: accountId,
          credential_id: 'local',
        }),
      })
      const payload = {
        model: 'claude-fable-5-2',
        messages: [{ role: 'user', content: 'hello' }],
        max_tokens: 10,
      }
      expect(await (await f.send(payload)).json()).toEqual(reply)
      expect(f.sends).toEqual(['Bearer sk-ant-oat01-third-access'])
      accountId = syntheticMainAccountUuid
      if (mode === 'main-first') delete globals[key]
      expect(await (await f.send(payload)).json()).toEqual(reply)
      expect(f.sends).toEqual([
        'Bearer sk-ant-oat01-third-access',
        'Bearer sk-ant-oat01-main-access',
        'Bearer sk-ant-oat01-third-access',
      ])
    },
  )

  test('OC1 OAuth sends runner notes from its session handle in the final signed body', async () => {
    const f = await fixture()
    const reports: unknown[] = []
    globals[key] = (sessionId: string) => {
      expect(sessionId).toBe('ses_relay_oc1')
      return {
        turn_notes: () => [
          { after_tool_use_id: 'runner-call', text: 'Runner reminder' },
        ],
        report: (payload: unknown) => reports.push(payload),
      }
    }
    let sent: any
    let sentHeaders = new Headers()
    const fetchImpl = globalThis.fetch
    globalThis.fetch = mock(async (input: any, init: any) => {
      if (extractUrl(input).includes('/v1/messages')) {
        sentHeaders = new Headers(init.headers)
        const text =
          sentHeaders.get('content-encoding') === 'gzip'
            ? gunzipSync(init.body).toString()
            : typeof init.body === 'string'
              ? init.body
              : Buffer.from(init.body).toString()
        sent = JSON.parse(text)
      }
      return fetchImpl(input, init)
    }) as unknown as typeof fetch
    await (
      await f.send({
        model: 'claude-opus-5-5',
        max_tokens: 10,
        messages: [
          {
            role: 'assistant',
            content: [
              { type: 'tool_use', id: 'runner-call', name: 'board', input: {} },
            ],
          },
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'runner-call',
                content: 'Done',
              },
            ],
          },
        ],
      })
    ).text()
    expect(sent.messages.at(-1)).toEqual({
      role: 'system',
      clear_at: 'next_user_message',
      content: 'Runner reminder',
    })
    expect(sentHeaders.get('anthropic-beta')?.split(',')).toContain(
      'mid-conversation-system-clear-at-2026-08-21',
    )
    expect(reports).toContainEqual({
      kind: 'turn_notes_supported',
      model: 'claude-opus-5-5',
      supported: true,
    })
  })

  test('accepts advice installed after load, pins it and reports only safe headers', async () => {
    const f = await fixture()
    // Establish a different sticky assignment before the runner asks to move it.
    await (await f.send()).text()
    expect(f.sends.at(-1)).toBe('Bearer sk-ant-oat01-main-access')
    const reports: Record<string, unknown>[] = []
    let answer: unknown = {
      account_id: syntheticFallbackAccountUuid(0),
      credential_id: 'local',
    }
    globals[key] = () => ({
      accountFor: async () => answer,
      report: (value: Record<string, unknown>) => {
        reports.push(value)
        throw new Error('report failure cannot fail the request')
      },
    })
    await (await f.send()).text()
    expect(f.sends.at(-1)).toBe('Bearer sk-ant-oat01-fallback-access')
    const routingReports = () =>
      reports.filter((report) => report.kind !== 'billing')
    const touch = expect.objectContaining({
      kind: 'cache_touch',
      source: 'response',
    })
    const served = {
      account_id: syntheticFallbackAccountUuid(0),
      outcome: 'served',
      headers: { 'anthropic-ratelimit-future': 'all' },
    }
    expect(routingReports()).toEqual([touch, served])
    answer = null
    await (await f.send()).text()
    expect(f.sends.at(-1)).toBe('Bearer sk-ant-oat01-fallback-access')
    expect(routingReports()).toEqual([touch, served, touch, served])
  })

  for (const [mode, accountId, token] of [
    ['main-first', syntheticFallbackAccountUuid(0), 'fallback'],
    ['fallback-first', syntheticMainAccountUuid, 'main'],
  ] as const) {
    test(`${mode} honors the shared login choice ahead of local order`, async () => {
      const f = await fixture('normal', undefined, undefined, mode)
      const accountFor = mock(async () => ({
        account_id: accountId,
        credential_id: 'local',
      }))
      globals[key] = () => ({ accountFor })
      await (await f.send()).text()
      expect(accountFor).toHaveBeenCalledTimes(1)
      expect(f.sends).toEqual([`Bearer sk-ant-oat01-${token}-access`])
    })
  }

  test('ordered routing overrides main advice before acquiring its bearer during a provider wait', async () => {
    const f = await fixture(
      'provider wait',
      undefined,
      undefined,
      'fallback-first',
    )
    const authorizeLocal = spyOn(f.nativeAccounts, 'authorizeLocal')
    globals[key] = () => ({
      accountFor: async () => ({
        account_id: syntheticMainAccountUuid,
        credential_id: 'local',
      }),
    })
    try {
      expect(await (await f.send()).text()).toBe('ok')
      expect(f.sends).toEqual(['Bearer sk-ant-oat01-fallback-access'])
      expect(authorizeLocal.mock.calls.map(([id]) => id)).not.toContain('main')
    } finally {
      authorizeLocal.mockRestore()
    }
  })

  test('ordered routing tries a healthy login when the advised credential cannot refresh', async () => {
    const f = await fixture('normal', undefined, undefined, 'main-first')
    const authorize = f.nativeAccounts.authorizeLocal.bind(f.nativeAccounts)
    const authorizeLocal = spyOn(
      f.nativeAccounts,
      'authorizeLocal',
    ).mockImplementation(async (id, options) =>
      id === 'fallback-1'
        ? {
            status: 'failed',
            failure: {
              kind: 'provider',
              classification: 'invalid-grant',
              status: 400,
            },
            persisted: true,
            reconciliationFailed: false,
          }
        : authorize(id, options),
    )
    globals[key] = () => ({
      accountFor: async () => ({
        account_id: syntheticFallbackAccountUuid(0),
        credential_id: 'local',
      }),
    })
    try {
      expect(await (await f.send()).text()).toBe('ok')
      expect(authorizeLocal).toHaveBeenCalledWith(
        'fallback-1',
        expect.objectContaining({ intent: 'serve' }),
      )
      expect(f.sends).toEqual(['Bearer sk-ant-oat01-main-access'])
    } finally {
      authorizeLocal.mockRestore()
    }
  })

  for (const mode of ['sticky-balanced', 'main-first'] as const) {
    test(`${mode} tries another login when the advised account changes during authorization`, async () => {
      const f = await fixture('normal', undefined, undefined, mode)
      const read = f.nativeAccounts.read.bind(f.nativeAccounts)
      const authorize = f.nativeAccounts.authorizeLocal.bind(f.nativeAccounts)
      let advised = false
      let removeFromNextRead = false
      const readSpy = spyOn(f.nativeAccounts, 'read').mockImplementation(
        async (...args) => {
          const remove = removeFromNextRead
          removeFromNextRead = false
          const snapshot = await read(...args)
          return remove
            ? {
                ...snapshot,
                accounts: snapshot.accounts.filter(
                  (row) => row.id !== 'fallback-1',
                ),
              }
            : snapshot
        },
      )
      const authorizeSpy = spyOn(
        f.nativeAccounts,
        'authorizeLocal',
      ).mockImplementation(async (id, options) => {
        const authorization = await authorize(id, options)
        if (advised && id === 'fallback-1' && options?.intent === 'serve')
          removeFromNextRead = true
        return authorization
      })
      globals[key] = () => ({
        accountFor: async () => {
          advised = true
          return {
            account_id: syntheticFallbackAccountUuid(0),
            credential_id: 'local',
          }
        },
      })
      try {
        expect(await (await f.send()).text()).toBe('ok')
        expect(f.sends).toEqual(['Bearer sk-ant-oat01-main-access'])
      } finally {
        readSpy.mockRestore()
        authorizeSpy.mockRestore()
      }
    })
  }

  for (const [status, mode] of [
    [429, 'main-first'],
    [503, 'main-first'],
    [429, 'fallback-first'],
  ] as const) {
    test(`${mode} returns the fallback ${status} if the next advised credential fails`, async () => {
      const upstream = new Response('fallback refused', { status })
      const cancel = spyOn(upstream.body!, 'cancel')
      const f = await fixture('overloaded', () => upstream, undefined, mode)
      const authorize = f.nativeAccounts.authorizeLocal.bind(f.nativeAccounts)
      let asks = 0
      const authorizeSpy = spyOn(
        f.nativeAccounts,
        'authorizeLocal',
      ).mockImplementation(async (id, options) =>
        id === 'main' && asks >= 2
          ? { status: 'refused', reason: 'not-active', persisted: false }
          : authorize(id, options),
      )
      globals[key] = () => ({
        accountFor: async () => {
          const first = ++asks === 1
          if (first && mode === 'fallback-first') return null
          return {
            account_id: first
              ? syntheticFallbackAccountUuid(0)
              : syntheticMainAccountUuid,
            credential_id: 'local',
          }
        },
      })
      try {
        const response = await f.send()
        expect(response.status).toBe(status)
        expect(await response.text()).toBe('fallback refused')
        expect(cancel).not.toHaveBeenCalled()
        expect(asks).toBe(2)
        expect(f.sends).toEqual(['Bearer sk-ant-oat01-fallback-access'])
      } finally {
        authorizeSpy.mockRestore()
        cancel.mockRestore()
      }
    })
  }

  test.each(['provider wait', 'killswitch', 'fail closed', 'refresh throw'])(
    'ordered routing settles a kept fallback refusal on %s',
    async (terminal) => {
      const upstream = new Response('fallback refused', { status: 503 })
      const cancel = spyOn(upstream.body!, 'cancel')
      const f = await fixture(
        terminal === 'provider wait'
          ? 'three accounts with provider wait'
          : terminal === 'killswitch'
            ? 'three accounts with killswitch'
            : 'three accounts with overload',
        () => upstream,
        undefined,
        'main-first',
      )
      let asks = 0
      const authorize = f.nativeAccounts.authorizeLocal.bind(f.nativeAccounts)
      const authorizeSpy = spyOn(
        f.nativeAccounts,
        'authorizeLocal',
      ).mockImplementation(async (id, options) => {
        if (id === 'fallback-2')
          return { status: 'refused', reason: 'not-active', persisted: false }
        if (id === 'main' && asks >= 2 && terminal === 'refresh throw')
          throw new Error('primary refresh failed')
        return authorize(id, options)
      })
      globals[key] = () => ({
        accountFor: async () => ({
          account_id: syntheticFallbackAccountUuid(++asks === 1 ? 0 : 1),
          credential_id: 'local',
        }),
      })
      const getMain = f.quotaManager.getMain.bind(f.quotaManager)
      const mainQuota = spyOn(f.quotaManager, 'getMain').mockImplementation(
        (...args) =>
          terminal === 'fail closed' && asks >= 2 ? null : getMain(...args),
      )
      const backedOff = spyOn(f.quotaManager, 'isBackedOff').mockReturnValue(
        terminal === 'fail closed',
      )
      const quotaPoll = spyOn(f.quotaManager, 'refreshMain')
      if (terminal === 'fail closed') quotaPoll.mockResolvedValue({})
      try {
        if (terminal === 'refresh throw') {
          await expect(f.send()).rejects.toThrow('primary refresh failed')
          expect(cancel).toHaveBeenCalledTimes(1)
        } else {
          const response = await f.send()
          expect(response.status).toBe(503)
          expect(await response.text()).toBe('fallback refused')
          expect(cancel).not.toHaveBeenCalled()
        }
        expect(asks).toBe(2)
        expect(f.sends).toEqual(['Bearer sk-ant-oat01-fallback-access'])
      } finally {
        authorizeSpy.mockRestore()
        mainQuota.mockRestore()
        backedOff.mockRestore()
        quotaPoll.mockRestore()
        cancel.mockRestore()
      }
    },
  )

  test('ordered routing leaves the last refusal readable when later paid advice skips a key', async () => {
    const upstream = new Response('fallback refused', { status: 503 })
    const cancel = spyOn(upstream.body!, 'cancel')
    const f = await fixture(
      'paid backup after OAuth with provider wait',
      () => upstream,
      undefined,
      'main-first',
    )
    let asks = 0
    globals[key] = () => ({
      accountFor: async () =>
        ++asks === 1
          ? null
          : { account_id: syntheticMainAccountUuid, credential_id: 'local' },
    })
    try {
      const response = await f.send()
      expect(response.status).toBe(503)
      expect(await response.text()).toBe('fallback refused')
      expect(cancel).not.toHaveBeenCalled()
      expect(asks).toBe(2)
      expect(f.sends).toEqual(['Bearer sk-ant-oat01-fallback-access'])
    } finally {
      cancel.mockRestore()
    }
  })

  test('ordered routing can still return its primary refusal after the advised fallback refuses', async () => {
    const main = new Response('primary refused', { status: 403 })
    const fallback = new Response('fallback refused', { status: 403 })
    const cancelMain = spyOn(main.body!, 'cancel')
    const cancelFallback = spyOn(fallback.body!, 'cancel')
    const responses = [main, fallback]
    const f = await fixture(
      'normal',
      () => responses.shift()!,
      undefined,
      'main-first',
    )
    let asks = 0
    globals[key] = () => ({
      accountFor: async () =>
        ++asks === 2
          ? {
              account_id: syntheticFallbackAccountUuid(0),
              credential_id: 'local',
            }
          : null,
    })
    try {
      expect(await (await f.send()).text()).toBe('primary refused')
      expect(cancelMain).not.toHaveBeenCalled()
      expect(cancelFallback).toHaveBeenCalledTimes(1)
      expect(asks).toBe(3)
      expect(f.sends).toEqual([
        'Bearer sk-ant-oat01-main-access',
        'Bearer sk-ant-oat01-fallback-access',
      ])
    } finally {
      cancelMain.mockRestore()
      cancelFallback.mockRestore()
    }
  })

  test('sticky routing detaches refusal cancellation when the migrated send throws', async () => {
    const upstream = new Response('primary refused', { status: 403 })
    // If the request times out, teardown opens the gate so the test can drain.
    const pending = getBodyLifetime(ctx).gate()
    const cancel = spyOn(upstream.body!, 'cancel').mockReturnValue(pending.wait)
    let sends = 0
    const f = await fixture('normal', () => {
      if (++sends === 1) return upstream
      throw new Error('migration transport failed')
    })
    let asks = 0
    globals[key] = () => ({
      accountFor: async () => ({
        account_id:
          ++asks === 1
            ? syntheticMainAccountUuid
            : syntheticFallbackAccountUuid(0),
        credential_id: 'local',
      }),
    })
    const request = f.send()
    try {
      await expect(request).rejects.toThrow('migration transport failed')
      expect(cancel).toHaveBeenCalledTimes(1)
      expect(f.sends).toEqual([
        'Bearer sk-ant-oat01-main-access',
        'Bearer sk-ant-oat01-fallback-access',
      ])
    } finally {
      pending.open()
      await Promise.allSettled([request])
      cancel.mockRestore()
    }
  })

  test('sticky advice does not try a credential already rejected by local authorization', async () => {
    const f = await fixture()
    const authorize = f.nativeAccounts.authorizeLocal.bind(f.nativeAccounts)
    let asked = false
    const attemptedAfterAdvice: string[] = []
    const authorizeSpy = spyOn(
      f.nativeAccounts,
      'authorizeLocal',
    ).mockImplementation(async (id, options) => {
      if (asked) attemptedAfterAdvice.push(id)
      return id === 'fallback-1'
        ? { status: 'refused', reason: 'not-active', persisted: false }
        : authorize(id, options)
    })
    globals[key] = () => ({
      accountFor: async () => {
        asked = true
        return {
          account_id: syntheticFallbackAccountUuid(0),
          credential_id: 'local',
        }
      },
    })
    try {
      expect(await (await f.send()).text()).toBe('ok')
      expect(f.sends).toEqual(['Bearer sk-ant-oat01-main-access'])
      expect(authorizeSpy.mock.calls.some(([id]) => id === 'fallback-1')).toBe(
        true,
      )
      expect(attemptedAfterAdvice).not.toContain('fallback-1')
    } finally {
      authorizeSpy.mockRestore()
    }
  })

  test('ordered routing does not replace a failed advised transport attempt with another login', async () => {
    const transportError = new Error('network fixture')
    const f = await fixture(
      'normal',
      () => {
        throw transportError
      },
      undefined,
      'main-first',
    )
    const accountFor = mock(async () => ({
      account_id: syntheticFallbackAccountUuid(0),
      credential_id: 'local',
    }))
    globals[key] = () => ({ accountFor })
    await expect(f.send()).rejects.toThrow('network fixture')
    expect(accountFor).toHaveBeenCalledTimes(1)
    expect(f.sends).toEqual(['Bearer sk-ant-oat01-fallback-access'])
  })

  test('fallback-first does not retry a transport failure from the refusal consult', async () => {
    let sends = 0
    const f = await fixture(
      'normal',
      () => {
        switch (++sends) {
          case 1:
            return new Response('fallback refused', { status: 403 })
          case 2:
            throw new Error('advised transport failed')
          default:
            return new Response('unexpected retry')
        }
      },
      undefined,
      'fallback-first',
    )
    let asks = 0
    globals[key] = () => ({
      accountFor: async () =>
        ++asks === 1
          ? null
          : { account_id: syntheticMainAccountUuid, credential_id: 'local' },
    })
    await expect(f.send()).rejects.toThrow('advised transport failed')
    expect(asks).toBe(2)
    expect(f.sends).toEqual([
      'Bearer sk-ant-oat01-fallback-access',
      'Bearer sk-ant-oat01-main-access',
    ])
  })

  test.each(['recovered', 'exhausted', 'alternative'])(
    'ordered routing revisits an earlier refuser only when appropriate (%s)',
    async (scenario) => {
      let sends = 0
      const f = await fixture(
        scenario === 'alternative' ? 'three accounts' : 'normal',
        () => {
          sends++
          return scenario !== 'exhausted' && sends === 3
            ? new Response('recovered')
            : new Response(`refusal ${sends}`, { status: 403 })
        },
        undefined,
        'main-first',
      )
      let asks = 0
      globals[key] = () => ({
        accountFor: async () => ({
          account_id:
            asks++ % 2 === 0
              ? syntheticMainAccountUuid
              : syntheticFallbackAccountUuid(0),
          credential_id: 'local',
        }),
      })
      const response = await f.send()
      const main = 'Bearer sk-ant-oat01-main-access'
      const fallback = 'Bearer sk-ant-oat01-fallback-access'
      if (scenario === 'exhausted') {
        expect(response.status).toBe(403)
        expect(await response.text()).toBe('refusal 4')
        expect(f.sends).toEqual([main, fallback, main, fallback])
        expect(asks).toBe(5)
      } else {
        expect(response.status).toBe(200)
        expect(await response.text()).toBe('recovered')
        expect(f.sends).toEqual([
          main,
          fallback,
          scenario === 'alternative'
            ? 'Bearer sk-ant-oat01-third-access'
            : main,
        ])
      }
    },
  )

  test('ordered routing schedules the serving fallback quota refresh without waiting', async () => {
    const f = await fixture(
      'refresh cadence',
      undefined,
      undefined,
      'main-first',
    )
    const pending =
      Promise.withResolvers<
        Awaited<ReturnType<typeof f.quotaManager.refreshFallback>>
      >()
    const refreshFallback = spyOn(
      f.quotaManager,
      'refreshFallback',
    ).mockReturnValue(pending.promise)
    globals[key] = () => ({
      accountFor: async () => ({
        account_id: syntheticFallbackAccountUuid(0),
        credential_id: 'local',
      }),
    })
    try {
      expect(await (await f.send()).text()).toBe('ok')
      expect(f.sends).toEqual(['Bearer sk-ant-oat01-fallback-access'])
      expect(
        refreshFallback.mock.calls.map(([id, access]) => [id, access]),
      ).toEqual([['fallback-1', '']])
    } finally {
      pending.reject(new Error('fixture quota poll ended'))
      await pending.promise.catch(() => {})
      refreshFallback.mockRestore()
    }
  })

  for (const mode of ['sticky-balanced', 'main-first'] as const) {
    test(`${mode} returns routing refusal while abandoned body cancellation is pending`, async () => {
      const upstream = new Response('upstream refusal', { status: 403 })
      const cancel = getBodyLifetime(ctx).gate()
      const cancelBody = spyOn(upstream.body!, 'cancel').mockReturnValue(
        cancel.wait,
      )
      const f = await fixture('normal', () => upstream, undefined, mode)
      let asks = 0
      globals[key] = () => ({
        accountFor: async () =>
          ++asks === 1
            ? {
                account_id:
                  mode === 'sticky-balanced'
                    ? syntheticMainAccountUuid
                    : syntheticFallbackAccountUuid(0),
                credential_id: 'local',
              }
            : { refused: { code: 'account_selection_final' } },
      })
      const request = f.send()
      try {
        const response = await request
        expect(response.status).toBe(403)
        expect(await response.json()).toMatchObject({
          error: { code: 'account_selection_final' },
        })
        expect(cancelBody).toHaveBeenCalledTimes(1)
        expect(asks).toBe(2)
      } finally {
        cancel.open()
        await Promise.allSettled([request])
        cancelBody.mockRestore()
      }
    })
  }

  test('ordered routing asks before sending a non-replayable request', async () => {
    const f = await fixture('normal', undefined, undefined, 'main-first')
    const accountFor = mock(async () => ({
      refused: { code: 'account_selection_final' },
    }))
    globals[key] = () => ({ accountFor })
    const response = await f.send(
      new ReadableStream({ start: (controller) => controller.close() }),
    )
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({
      error: { code: 'account_selection_final' },
    })
    expect(accountFor).toHaveBeenCalledTimes(1)
    expect(f.sends).toEqual([])
  })

  test('fallback-first detaches main refusal cancellation when a later local fallback serves', async () => {
    const main = new Response('main refused', { status: 403 })
    const pending = getBodyLifetime(ctx).gate()
    const cancel = spyOn(main.body!, 'cancel').mockReturnValue(pending.wait)
    const responses = [
      new Response('first fallback refused', { status: 403 }),
      main,
      new Response('second fallback served'),
    ]
    const f = await fixture(
      'three accounts',
      () => responses.shift()!,
      undefined,
      'fallback-first',
    )
    let asks = 0
    globals[key] = () => ({
      accountFor: async () =>
        ++asks === 2
          ? { account_id: syntheticMainAccountUuid, credential_id: 'local' }
          : null,
    })
    const request = f.send()
    try {
      const response = await request
      expect(await response.text()).toBe('second fallback served')
      expect(asks).toBe(3)
      expect(f.sends).toEqual([
        'Bearer sk-ant-oat01-fallback-access',
        'Bearer sk-ant-oat01-main-access',
        'Bearer sk-ant-oat01-third-access',
      ])
      expect(cancel).toHaveBeenCalledTimes(1)
    } finally {
      pending.open()
      await Promise.allSettled([request])
      cancel.mockRestore()
    }
  })

  for (const streaming of [false, true]) {
    test(`sticky routing migrates while ${streaming ? 'stream inspection' : 'refused body'} cancellation is pending`, async () => {
      const pending = getBodyLifetime(ctx).gate()
      const cancel = mock(() => pending.wait)
      const refused = new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                streaming
                  ? 'event: error\ndata: {"type":"error","error":{"type":"rate_limit_error","message":"limited"}}\n\n'
                  : 'refused',
              ),
            )
          },
          cancel,
        }),
        {
          status: streaming ? 200 : 403,
          headers: streaming
            ? {
                'content-type': 'text/event-stream',
                'anthropic-ratelimit-unified-7d-utilization': '1.0',
              }
            : {},
        },
      )
      const responses = [
        refused,
        new Response(
          streaming
            ? 'event: message_start\ndata: {"type":"message_start","message":{"id":"migrated"}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n'
            : 'migrated',
        ),
      ]
      const f = await fixture('normal', () => responses.shift()!)
      let asks = 0
      globals[key] = () => ({
        accountFor: async () => ({
          account_id:
            ++asks === 1
              ? syntheticMainAccountUuid
              : syntheticFallbackAccountUuid(0),
          credential_id: 'local',
        }),
      })
      const request = f.send({
        model: 'claude-sonnet-5',
        stream: streaming,
        messages: [{ role: 'user', content: 'hello' }],
      })
      try {
        const response = await request
        expect(await response.text()).toContain('migrated')
        expect(cancel).toHaveBeenCalledTimes(1)
        expect(f.sends).toEqual([
          'Bearer sk-ant-oat01-main-access',
          'Bearer sk-ant-oat01-fallback-access',
        ])
      } finally {
        pending.open()
        await Promise.allSettled([request])
      }
    })
  }

  for (const mode of ['main-first', 'fallback-first'] as const) {
    test.each([true, false])(
      `${mode} allows confirmed paid fallback only after a null retry probe (%s)`,
      async (advised) => {
        let sends = 0
        const f = await fixture(
          'paid backup',
          () =>
            ++sends === 1
              ? new Response('usage limit reached', { status: 429 })
              : new Response('paid'),
          undefined,
          mode,
        )
        let asks = 0
        globals[key] = () => ({
          accountFor: async () =>
            ++asks === 1 || advised
              ? { account_id: syntheticMainAccountUuid, credential_id: 'local' }
              : null,
        })
        const response = await f.send()
        expect(asks).toBe(2)
        expect(response.status).toBe(advised ? 429 : 200)
        expect(await response.text()).toBe(
          advised ? 'usage limit reached' : 'paid',
        )
        expect(f.sends).toEqual(
          advised
            ? ['Bearer sk-ant-oat01-main-access']
            : ['Bearer sk-ant-oat01-main-access', 'Bearer paid-key'],
        )
      },
    )
  }

  for (const [mode, quotaMode] of [
    ['main-first', 'paid backup with provider wait'],
    ['main-first', 'paid backup without provider wait'],
    ['fallback-first', 'paid backup without provider wait'],
  ] as const) {
    test(`${mode} preselection skips paid fallback after overridden advice (${quotaMode})`, async () => {
      const f = await fixture(quotaMode, undefined, undefined, mode)
      const accountFor = mock(async () => ({
        account_id: syntheticMainAccountUuid,
        credential_id: 'local',
        // Ordered routing only honors holds for an account that just refused.
        ...(quotaMode === 'paid backup without provider wait' && {
          hold: { retry_after_ms: 100 },
        }),
      }))
      globals[key] = () => ({ accountFor })
      const response = await f.send()
      await response.text()
      expect(accountFor).toHaveBeenCalledTimes(1)
      if (quotaMode === 'paid backup with provider wait') {
        expect(response.status).toBe(429)
        expect(f.sends).toEqual([])
      } else {
        expect(f.sends).toEqual(['Bearer sk-ant-oat01-main-access'])
      }
    })
  }

  test.each([true, false])(
    'sticky retry advice blocks paid fallback only when given (%s)',
    async (advised) => {
      let sends = 0
      const f = await fixture('paid backup', () =>
        ++sends === 1
          ? new Response('usage limit reached', { status: 429 })
          : new Response('paid'),
      )
      let asks = 0
      globals[key] = () => ({
        accountFor: async () =>
          ++asks === 2 && advised
            ? { account_id: syntheticMainAccountUuid, credential_id: 'local' }
            : null,
      })
      const response = await f.send()
      expect(asks).toBe(2)
      expect(response.status).toBe(advised ? 429 : 200)
      await response.text()
      expect(f.sends).toEqual(
        advised
          ? ['Bearer sk-ant-oat01-main-access']
          : ['Bearer sk-ant-oat01-main-access', 'Bearer paid-key'],
      )
    },
  )

  test('ordered OAuth-only retry does not poll main to admit a paid route', async () => {
    const responses = [
      new Response('usage limit reached', { status: 429 }),
      new Response('fallback served'),
    ]
    const f = await fixture(
      'normal',
      () => responses.shift()!,
      undefined,
      'main-first',
    )
    let asks = 0
    globals[key] = () => ({
      accountFor: async () =>
        ++asks === 1
          ? { account_id: syntheticMainAccountUuid, credential_id: 'local' }
          : null,
    })
    const quotaPoll = spyOn(f.quotaManager, 'refreshMain')
    try {
      expect(await (await f.send()).text()).toBe('fallback served')
      expect(asks).toBe(2)
      expect(f.sends).toEqual([
        'Bearer sk-ant-oat01-main-access',
        'Bearer sk-ant-oat01-fallback-access',
      ])
      expect(quotaPoll).not.toHaveBeenCalled()
    } finally {
      quotaPoll.mockRestore()
    }
  })

  test('ordered routing tries an eligible OAuth fallback before an earlier paid key', async () => {
    const f = await fixture(
      'paid backup before OAuth',
      undefined,
      undefined,
      'main-first',
    )
    expect(await (await f.send()).text()).toBe('ok')
    expect(f.sends).toEqual(['Bearer sk-ant-oat01-fallback-access'])
  })

  test('fallback-first skips a paid key already tried in its prepass', async () => {
    let sends = 0
    const f = await fixture(
      'paid backup without provider wait',
      () => new Response(`refusal ${++sends}`, { status: 429 }),
      undefined,
      'fallback-first',
    )
    globals[key] = () => ({ accountFor: async () => null })
    const response = await f.send()
    expect(response.status).toBe(429)
    expect(await response.text()).toBe('refusal 2')
    expect(f.sends).toEqual([
      'Bearer paid-key',
      'Bearer sk-ant-oat01-main-access',
    ])
  })

  for (const mode of ['main-first', 'fallback-first'] as const) {
    test(`${mode} keeps the subscription refusal when the routing hook disappears`, async () => {
      const f = await fixture(
        'paid backup',
        () => {
          delete globals[key]
          return f.sends.length === 1
            ? new Response('usage limit reached', { status: 429 })
            : new Response('paid')
        },
        undefined,
        mode,
      )
      const accountFor = mock(async () => ({
        account_id: syntheticMainAccountUuid,
        credential_id: 'local',
      }))
      globals[key] = () => ({ accountFor })
      const quotaPoll = spyOn(f.quotaManager, 'refreshMain')
      try {
        const response = await f.send()
        expect(response.status).toBe(429)
        expect(await response.text()).toBe('usage limit reached')
        expect(accountFor).toHaveBeenCalledTimes(1)
        expect(f.sends).toEqual(['Bearer sk-ant-oat01-main-access'])
        expect(quotaPoll).not.toHaveBeenCalled()
      } finally {
        quotaPoll.mockRestore()
      }
    })
  }

  test.each([true, false])(
    'sticky paid fallback needs an actual null retry after initial advice was overridden (%s)',
    async (retryProbeRuns) => {
      const responses = [
        new Response('usage limit reached', { status: 429 }),
        new Response('paid'),
      ]
      const f = await fixture('paid backup', () => {
        if (!retryProbeRuns) delete globals[key]
        return responses.shift()!
      })
      const read = f.nativeAccounts.read.bind(f.nativeAccounts)
      let hideMainOnce = false
      const readSpy = spyOn(f.nativeAccounts, 'read').mockImplementation(
        async (...args) => {
          const hideMain = hideMainOnce
          hideMainOnce = false
          const snapshot = await read(...args)
          return hideMain
            ? {
                ...snapshot,
                accounts: snapshot.accounts.filter((row) => row.id !== 'main'),
              }
            : snapshot
        },
      )
      let asks = 0
      globals[key] = () => ({
        accountFor: async () => {
          if (++asks !== 1) return null
          // The advised account disappears from the recheck, then becomes available locally.
          hideMainOnce = true
          return {
            account_id: syntheticMainAccountUuid,
            credential_id: 'local',
          }
        },
      })
      try {
        const response = await f.send()
        if (retryProbeRuns) {
          expect(await response.text()).toBe('paid')
        } else {
          expect(response.status).toBe(429)
          expect(await response.json()).toMatchObject({
            error: { type: 'rate_limit_error' },
          })
        }
        expect(asks).toBe(retryProbeRuns ? 2 : 1)
        expect(f.sends).toEqual([
          'Bearer sk-ant-oat01-main-access',
          ...(retryProbeRuns ? ['Bearer paid-key'] : []),
        ])
      } finally {
        readSpy.mockRestore()
      }
    },
  )

  test('sticky reroute asks shared routing again and honors a final refusal', async () => {
    const f = await fixture('normal', () => new Response(null, { status: 403 }))
    let choices = 0
    globals[key] = () => ({
      accountFor: async () =>
        ++choices === 1
          ? { account_id: syntheticMainAccountUuid, credential_id: 'local' }
          : { refused: { code: 'account_selection_final' } },
    })
    const response = await f.send()
    expect(choices).toBe(2)
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({
      error: { code: 'account_selection_final' },
    })
    expect(f.sends).toEqual(['Bearer sk-ant-oat01-main-access'])
  })

  for (const [mode, token] of [
    ['main-first', 'main'],
    ['fallback-first', 'fallback'],
  ] as const) {
    test(`${mode} asks again before changing an account and honors a final refusal`, async () => {
      const f = await fixture(
        'normal',
        () => new Response(null, { status: 403 }),
        undefined,
        mode,
      )
      let choices = 0
      globals[key] = () => ({
        accountFor: async () =>
          ++choices === 1
            ? null
            : { refused: { code: 'account_selection_final' } },
      })
      const response = await f.send()
      expect(choices).toBe(2)
      expect(await response.json()).toMatchObject({
        error: { code: 'account_selection_final' },
      })
      expect(f.sends).toEqual([`Bearer sk-ant-oat01-${token}-access`])
    })
  }

  test('bills each physical OpenCode 1 send with its own payer and usage', async () => {
    let sends = 0
    const f = await fixture('normal', () =>
      ++sends === 1
        ? new Response(null, { status: 403 })
        : Response.json({
            id: 'msg_oc1',
            type: 'message',
            usage: { input_tokens: 120, output_tokens: 18 },
          }),
    )
    const reports: Record<string, unknown>[] = []
    globals[key] = () => ({
      report: (report: Record<string, unknown>) => {
        if (report.kind === 'billing') reports.push(report)
        return new Promise(() => {})
      },
    })
    const response = await f.send()
    expect(response.status).toBe(200)
    await response.text()
    await Bun.sleep(10)
    expect(reports).toHaveLength(2)
    expect(reports).toContainEqual(
      expect.objectContaining({
        account_id: syntheticMainAccountUuid,
        outcome: 'failed',
        status: 403,
      }),
    )
    expect(reports).toContainEqual(
      expect.objectContaining({
        account_id: syntheticFallbackAccountUuid(0),
        outcome: 'completed',
        provider_response_id: 'msg_oc1',
        usage: { input: 120, output: 18 },
      }),
    )
    expect(reports[0]?.attempt_id).toEqual(expect.any(String))
    expect(reports[1]?.attempt_id).toEqual(expect.any(String))
    expect(reports[0]?.attempt_id).not.toBe(reports[1]?.attempt_id)
  })

  test('bills the upstream response from an OpenCode 1 HTTP relay', async () => {
    const f = await fixture(
      'normal',
      () =>
        Response.json(
          {
            id: 'msg_relay',
            type: 'message',
            usage: { input_tokens: 80, output_tokens: 9 },
          },
          { headers: { 'request-id': 'req_relay' } },
        ),
      undefined,
      'sticky-balanced',
      true,
    )
    const reports: Record<string, unknown>[] = []
    globals[key] = () => ({
      report: (report: Record<string, unknown>) => {
        if (report.kind === 'billing') reports.push(report)
      },
    })
    await (await f.send()).text()
    await Bun.sleep(10)
    expect(f.sends).toHaveLength(1)
    expect(reports).toEqual([
      expect.objectContaining({
        account_id: syntheticMainAccountUuid,
        request_kind: 'primary',
        provider_request_id: 'req_relay',
        provider_response_id: 'msg_relay',
        outcome: 'completed',
        usage: { input: 80, output: 9 },
      }),
    ])
  })

  for (const mode of ['null', 'unknown']) {
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

  test.each([
    'account_limit_exhausted',
    'account_selection_refused',
    'account_selection_final',
  ])('routing refusal %s stops OC1 before any Anthropic send', async (code) => {
    const f = await fixture()
    let asks = 0
    globals[key] = () => ({
      accountFor: async () => {
        asks++
        return {
          refused: {
            code,
            retry_after_secs: 17,
            routing_code: 'private-router-text',
          },
        }
      },
    })
    const response = await f.send()
    expect(response.status).toBe(code === 'account_selection_final' ? 403 : 429)
    expect(response.headers.get('retry-after')).toBe(
      code === 'account_selection_final' ? null : '17',
    )
    expect(await response.json()).toEqual({
      type: 'error',
      error: {
        type:
          code === 'account_selection_final'
            ? 'permission_error'
            : 'rate_limit_error',
        code,
        message:
          code === 'account_selection_final'
            ? 'Shared routing refused an account for this request.'
            : 'Shared routing has no account for this request right now.',
      },
    })
    expect(asks).toBe(1)
    expect(f.sends).toEqual([])
  })

  test('long capacity waits return a retryable 429 and use a fresh id on host retry', async () => {
    const f = await fixture()
    const ids: unknown[] = []
    const reset = Date.now() + 30 * 60_000
    globals[key] = () => ({
      accountFor: async (request: Record<string, unknown>) => {
        ids.push(request.request_id)
        return request.waits_for_capacity
          ? { refused: { code: 'concurrency_full', resets_at_ms: reset } }
          : { refused: { code: 'account_selection_final' } }
      },
    })
    for (let i = 0; i < 2; i++) {
      const response = await f.send()
      expect(response.status).toBe(429)
      expect(response.headers.get('retry-after')).toBe('900')
      expect(await response.json()).toMatchObject({
        error: {
          code: 'concurrency_full',
          message:
            'Every Claude account is at its concurrent-request limit. Retrying when a slot frees.',
        },
      })
    }
    expect(f.sends).toEqual([])
    expect(ids).toEqual([expect.any(String), expect.any(String)])
    expect(ids[1]).not.toBe(ids[0])
  })

  // A retry ask comes after a failed attempt has used part of OpenCode 1's
  // 5-minute response budget, so a full pool must become a host retry at once
  // rather than a wait inside the request (a 2-minute wait here would also
  // outlast the test's timeout).
  for (const mode of ['sticky-balanced', 'main-first'] as const) {
    test(`${mode} retry ask hands a full pool to the host without waiting`, async () => {
      const f = await fixture(
        'normal',
        () => new Response(null, { status: 403 }),
        undefined,
        mode === 'sticky-balanced' ? undefined : mode,
      )
      const reset = Date.now() + 2 * 60_000
      let choices = 0
      globals[key] = () => ({
        accountFor: async () =>
          ++choices === 1
            ? mode === 'sticky-balanced'
              ? { account_id: syntheticMainAccountUuid, credential_id: 'local' }
              : null
            : { refused: { code: 'concurrency_full', resets_at_ms: reset } },
      })
      const started = Date.now()
      const response = await f.send()
      expect(Date.now() - started).toBeLessThan(4_000)
      expect(choices).toBe(2)
      expect(response.status).toBe(429)
      expect(await response.json()).toMatchObject({
        error: { code: 'concurrency_full' },
      })
      expect(f.sends).toHaveLength(1)
    })
  }

  test.each(['floor', 'reserve', 'unknown quota'])(
    'routing quota trust serves OC1 advice despite %s',
    async (mode) => {
      const f = await fixture(mode)
      globals[key] = () => ({
        accountFor: async () => ({
          account_id: syntheticFallbackAccountUuid(0),
          credential_id: 'local',
        }),
      })
      expect((await f.send()).status).toBe(200)
      expect(f.sends).toEqual(['Bearer sk-ant-oat01-fallback-access'])
    },
  )

  test('OC1 refusal retry uses the same routed account below its general quota floor', async () => {
    let sends = 0
    const f = await fixture('refusal floor', () => {
      const response = refusalThinkingReply(
        ++sends === 1 ? SOURCE_MODEL : TARGET_MODEL,
      )
      response.headers.delete('anthropic-ratelimit-unified-5h-utilization')
      response.headers.delete('anthropic-ratelimit-unified-7d-utilization')
      return response
    })
    globals[key] = () => ({
      accountFor: async () => ({
        account_id: syntheticFallbackAccountUuid(0),
        credential_id: 'local',
      }),
    })
    const response = await f.send({
      model: SOURCE_MODEL,
      stream: true,
      max_tokens: 100,
      messages: [{ role: 'user', content: 'hello' }],
    })
    expect(await response.text()).toContain(TARGET_SIGNATURE)
    expect(f.sends).toEqual(
      Array(2).fill('Bearer sk-ant-oat01-fallback-access'),
    )
    expect(f.bodies.map((body) => JSON.parse(body).model)).toEqual([
      SOURCE_MODEL,
      TARGET_MODEL,
    ])
  })

  test('a signed-out routing pick is replaced by our own OC1 subscription', async () => {
    const f = await fixture('signed out')
    const reports: any[] = []
    globals[key] = () => ({
      accountFor: async () => ({
        account_id: syntheticFallbackAccountUuid(0),
        credential_id: 'local',
      }),
      report: (value: unknown) => reports.push(value),
    })
    expect((await f.send()).status).toBe(200)
    expect(f.sends).toEqual(['Bearer sk-ant-oat01-main-access'])
    expect(
      reports.some((report) => report.outcome === 'credential_refused'),
    ).toBe(false)
  })

  test('no accessor and undefined advice leave OC1 request bytes and choice unchanged', async () => {
    const f = await fixture()
    expect((await f.send()).status).toBe(200)
    globals[key] = () => ({ accountFor: async () => undefined })
    expect((await f.send()).status).toBe(200)
    expect(f.sends).toEqual([
      'Bearer sk-ant-oat01-main-access',
      'Bearer sk-ant-oat01-main-access',
    ])
    expect(f.bodies[1]).toBe(f.bodies[0])
  })

  test('an eligible hold returns 429 and capped Retry-After without sending', async () => {
    const f = await fixture()
    const reports: Record<string, unknown>[] = []
    globals[key] = () => ({
      accountFor: async () => ({
        account_id: syntheticFallbackAccountUuid(0),
        credential_id: 'local',
        hold: { retry_after_ms: 9_000_000 },
      }),
      report: (report: Record<string, unknown>) => reports.push(report),
    })
    const response = await f.send()
    expect(response.status).toBe(429)
    expect(response.headers.get('retry-after')).toBe(
      String(ROUTING_HOLD_LIMIT_MS / 1000),
    )
    expect(f.sends).toEqual([])
    expect(reports.filter((report) => report.kind === 'wait')).toEqual([
      {
        kind: 'wait',
        phase: 'start',
        wait_id: expect.any(String),
        reason: 'routing_hold',
        next_ms: expect.any(Number),
        message: 'Waiting for shared routing to release the request.',
      },
    ])
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
      report: (report: { kind?: string }) => {
        if (report.kind !== 'billing') reports.push(report)
      },
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
      expect(reports).toContainEqual(
        expect.objectContaining({
          kind: 'wait',
          phase: 'start',
          reason: 'account_limit',
          next_ms: expect.any(Number),
        }),
      )
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
    { mode: 'fable', modelId: 'Fable Pool', pool: 'fable' },
    { mode: 'fable-without-poll', modelId: undefined, pool: 'fable' },
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
      ).toEqual([
        {
          account_id: syntheticMainAccountUuid,
          outcome: 'exhausted',
          window: '7d',
          pool,
        },
      ])
    })
  }

  test('Fable 5.2 429 with only a 7d_oi rejection reports its weekly pool on OpenCode 1', async () => {
    let calls = 0
    const f = await fixture('fable-without-poll', () =>
      ++calls === 1
        ? new Response('limited', {
            status: 429,
            headers: {
              'anthropic-ratelimit-unified-status': 'rejected',
              'anthropic-ratelimit-unified-7d-status': 'allowed',
              'anthropic-ratelimit-unified-7d-utilization': '0.55',
              'anthropic-ratelimit-unified-7d_oi-status': 'rejected',
              'anthropic-ratelimit-unified-7d_oi-utilization': '1.0',
              'anthropic-ratelimit-unified-7d_oi-reset': '1796184000',
            },
          })
        : new Response('ok'),
    )
    const reports: Array<{ outcome: string; [key: string]: unknown }> = []
    globals[key] = () => ({
      accountFor: async () => null,
      report: (report: (typeof reports)[number]) => reports.push(report),
    })
    const response = await f.send({
      model: 'claude-fable-5-2',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 10,
    })
    await response.body?.cancel()
    expect(reports.filter((report) => report.outcome === 'exhausted')).toEqual([
      {
        account_id: syntheticMainAccountUuid,
        outcome: 'exhausted',
        window: '7d',
        pool: 'fable',
        resets_at: 1_796_184_000_000,
      },
    ])
  })
})
