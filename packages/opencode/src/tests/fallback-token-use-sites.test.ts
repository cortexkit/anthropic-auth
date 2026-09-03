import { afterEach, describe, expect, mock, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type AccountStorage,
  resetCache1hState,
  resetClaudeCodeIdentityCachesForTest,
  saveAccountState,
  saveAccounts,
  tokenFingerprint,
} from '@cortexkit/anthropic-auth-core'
import { AnthropicAuthPlugin } from '../index'
import { LANE_START_REQUEST_HEADER } from '../lane-start'
import { extractUrl, MESSAGES_URL } from './test-fetch'

type Site = 'request' | 'quota' | 'prime' | 'cachekeep' | 'recovery' | 'profile'

type OutboundRecord = {
  url: string
  authorization: string
  bodyHasCanary: boolean
  headersHaveCanary: boolean
  body: string
}

type IntervalRecord = { callback: () => unknown; ms: number }

const originalFetch = globalThis.fetch
const originalNow = Date.now
const activePlugins = new Set<{ dispose?: () => Promise<void> | void }>()
const tempDirs = new Set<string>()

afterEach(async () => {
  for (const plugin of activePlugins) await plugin.dispose?.()
  activePlugins.clear()
  await Promise.all(
    [...tempDirs].map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  )
  tempDirs.clear()
  globalThis.fetch = originalFetch
  Date.now = originalNow
  delete process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION
  resetCache1hState()
  resetClaudeCodeIdentityCachesForTest()
})

function quota(now: number, fableRemaining = 90) {
  return {
    checkedAt: now,
    five_hour: {
      usedPercent: 10,
      remainingPercent: 90,
      checkedAt: now,
      resetsAt: new Date(now + 60 * 60_000).toISOString(),
    },
    seven_day: {
      usedPercent: 10,
      remainingPercent: 90,
      checkedAt: now,
      resetsAt: new Date(now + 24 * 60 * 60_000).toISOString(),
    },
    scoped: [
      {
        id: 'claude-weekly-scoped-fable',
        title: 'Fable only',
        modelName: 'Fable',
        usedPercent: 100 - fableRemaining,
        remainingPercent: fableRemaining,
        checkedAt: now,
        resetsAt: new Date(now + 24 * 60 * 60_000).toISOString(),
      },
    ],
  }
}

function vaultToken(site: Site) {
  return `sk-ant-oat01-vault-${site}`
}

function sidecarToken(site: Site) {
  return `sk-ant-oat01-sidecar-canary-${site}`
}

function expectOnlyVaultToken(records: OutboundRecord[], site: Site) {
  expect(records.length, `${site}: no outbound requests`).toBeGreaterThan(0)
  for (const record of records) {
    expect(record.authorization, `${site}: ${record.url}`).toBe(
      `Bearer ${vaultToken(site)}`,
    )
    expect(record.headersHaveCanary, `${site}: canary in headers`).toBe(false)
    expect(record.bodyHasCanary, `${site}: canary in body`).toBe(false)
  }
}

async function waitFor(
  predicate: () => boolean,
  message: string,
  attempts = 50,
) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (predicate()) return
    await Bun.sleep(10)
  }
  throw new Error(message)
}

async function createFixture(
  site: Site,
  options: {
    now?: number
    quotaEnabled?: boolean
    quotaSnapshot?: ReturnType<typeof quota>
    prime?: boolean
    cachekeep?: boolean
    recovery?: boolean
    profile?: boolean
    captureIntervals?: boolean
  } = {},
) {
  const now = options.now ?? Date.now()
  const canary = `sidecar-canary-${site}`
  const vault = vaultToken(site)
  const accountId = `fallback-${site}`
  const handle = `handle-${site}`
  const intervals: IntervalRecord[] = []
  const records: OutboundRecord[] = []
  let refusalPending = options.recovery === true

  if (options.now !== undefined) {
    let clock = now
    Date.now = mock(() => clock) as unknown as typeof Date.now
    Object.defineProperty(intervals, 'clock', {
      value: (next: number) => {
        clock = next
      },
    })
  }

  const storage: AccountStorage = {
    version: 1,
    main: {
      type: 'opencode',
      provider: 'anthropic',
      ...(options.profile
        ? {
            profile: {
              tier: 'default_claude_max_5x',
              orgType: 'claude_team',
              checkedAt: now,
            },
          }
        : {}),
    },
    fallbackOn: [401, 403, 429],
    routing: { mode: options.recovery ? 'sticky-balanced' : 'fallback-first' },
    refresh: {
      enabled: true,
      intervalMinutes: 10,
      refreshBeforeExpiryMinutes: 30,
    },
    quota: options.quotaEnabled
      ? {
          enabled: true,
          checkIntervalMinutes: 5,
          minimumRemaining: { five_hour: 1, seven_day: 1 },
          failClosedOnUnknownQuota: true,
          ...(options.recovery || options.prime
            ? {
                mainQuota: quota(now, options.recovery ? 0 : 90),
                mainQuotaCheckedAt: now,
                mainQuotaToken: tokenFingerprint('main-access'),
              }
            : {}),
        }
      : { enabled: false, failClosedOnUnknownQuota: false },
    claustrum: { accounts: { [accountId]: { enabled: true } } },
    ...(options.prime ? { prime: { enabled: true } } : {}),
    ...(options.cachekeep || options.recovery
      ? {
          claudeCache: { enabled: true, mode: 'hybrid' },
          cacheKeep: { enabled: true, always: true, subagents: true },
        }
      : {}),
    accounts: [
      {
        id: accountId,
        type: 'oauth',
        access: sidecarToken(site),
        refresh: `refresh-${site}`,
        expires: now + 8 * 60 * 60_000,
        claustrumHandle: handle,
        ...(options.quotaSnapshot ? { quota: options.quotaSnapshot } : {}),
      },
    ],
  }

  const directory = await mkdtemp(join(tmpdir(), `fallback-census-${site}-`))
  tempDirs.add(directory)
  const accountFile = join(directory, 'anthropic-auth.json')
  process.env.OPENCODE_ANTHROPIC_AUTH_FILE = accountFile
  process.env.OPENCODE_ANTHROPIC_AUTH_SIDEBAR_STATE_FILE = join(
    directory,
    'sidebar.json',
  )
  process.env.OPENCODE_ANTHROPIC_AUTH_CACHEKEEP_REGISTRY_DIR = join(
    directory,
    'cachekeep',
  )
  process.env.OPENCODE_ANTHROPIC_AUTH_QUOTA_FEED_DIR = join(directory, 'quota')
  if (!options.profile) {
    process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION = '1'
  }
  await saveAccounts(storage, accountFile)
  if (storage.main?.profile) {
    await saveAccountState(storage, accountFile, { mainProfile: true })
  }

  const connector = async () =>
    ({
      call: async (_moduleId: string, method: string) => {
        if (method !== 'credential.get') return { result: {} }
        return {
          result: {
            payload: Array.from(
              new TextEncoder().encode(JSON.stringify({ access_token: vault })),
            ),
            expires_at_ms: now + 12 * 60 * 60_000,
            record_version: 103,
          },
        }
      },
      close() {},
    }) as never

  const refusalSse = [
    'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_filtered"}}\n\n',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"refusal"},"usage":{"output_tokens":0}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ].join('')
  const successSse = [
    'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_ok","model":"claude-opus-4-8","usage":{}}}\n\n',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ].join('')

  globalThis.fetch = mock((input: unknown, init?: RequestInit) => {
    const url = extractUrl(input as string | URL | Request)
    const headers = new Headers(init?.headers)
    const body = typeof init?.body === 'string' ? init.body : ''
    records.push({
      url,
      authorization: headers.get('authorization') ?? '',
      body,
      bodyHasCanary: body.includes(canary),
      headersHaveCanary: [...headers.values()].some((value) =>
        value.includes(canary),
      ),
    })
    if (url.includes('/claude_cli/bootstrap')) {
      return Promise.resolve(
        Response.json({ oauth_account: { account_uuid: accountId } }),
      )
    }
    if (url.includes('/api/oauth/profile')) {
      return Promise.resolve(
        Response.json({
          organization: {
            organization_type: 'claude_team',
            rate_limit_tier: 'default_claude_max_5x',
          },
        }),
      )
    }
    if (url.includes('/api/oauth/usage')) {
      return Promise.resolve(
        Response.json({
          five_hour: {
            utilization: 10,
            resets_at: new Date(now - 1_000).toISOString(),
          },
          seven_day: { utilization: 10 },
          limits: [
            {
              kind: 'weekly_scoped',
              group: 'weekly',
              percent: 10,
              scope: { model: { display_name: 'Fable' } },
            },
          ],
        }),
      )
    }
    if (url.includes('/v1/messages')) {
      const parsed = body ? (JSON.parse(body) as { max_tokens?: number }) : {}
      if (parsed.max_tokens === 0) {
        return Promise.resolve(
          Response.json({ usage: { input_tokens: 1, output_tokens: 0 } }),
        )
      }
      if (refusalPending) {
        refusalPending = false
        return Promise.resolve(new Response(refusalSse, { status: 200 }))
      }
      if (options.prime) {
        return Promise.resolve(
          Response.json({ usage: { input_tokens: 20, output_tokens: 1 } }),
        )
      }
      return Promise.resolve(new Response(successSse, { status: 200 }))
    }
    return Promise.resolve(new Response('unexpected', { status: 599 }))
  }) as unknown as typeof fetch

  const setInterval = options.captureIntervals
    ? (mock((callback: () => unknown, ms: number) => {
        intervals.push({ callback, ms })
        return { unref() {} } as unknown as ReturnType<
          typeof globalThis.setInterval
        >
      }) as unknown as typeof globalThis.setInterval)
    : (mock(
        () =>
          ({ unref() {} }) as unknown as ReturnType<
            typeof globalThis.setInterval
          >,
      ) as unknown as typeof globalThis.setInterval)
  const clearInterval = mock(
    () => {},
  ) as unknown as typeof globalThis.clearInterval
  const plugin = (await (
    AnthropicAuthPlugin as unknown as (
      context: unknown,
      runtime: unknown,
    ) => Promise<any>
  )(
    {
      client: {
        auth: { set: mock(() => Promise.resolve()) },
        session: { promptAsync: mock(() => Promise.resolve()) },
      },
    },
    { claustrumConnector: connector, setInterval, clearInterval },
  )) as any
  activePlugins.add(plugin)
  const result = await plugin.auth.loader(
    () =>
      Promise.resolve({
        type: 'oauth' as const,
        access: 'main-access',
        refresh: 'main-refresh',
        expires: now + 8 * 60 * 60_000,
      }),
    { models: {} },
  )

  return { accountId, intervals, plugin, records, result }
}

describe('vault-served fallback outbound token census', () => {
  test.serial('request and lane-start sends', async () => {
    const fixture = await createFixture('request')
    fixture.records.length = 0
    const body = JSON.stringify({
      model: 'claude-opus-4-8',
      stream: true,
      messages: [{ role: 'user', content: 'hello' }],
    })
    await (
      await fixture.result.fetch(MESSAGES_URL, { method: 'POST', body })
    ).text()
    await (
      await fixture.result.fetch(MESSAGES_URL, {
        method: 'POST',
        headers: { [LANE_START_REQUEST_HEADER]: '1' },
        body,
      })
    ).text()

    expectOnlyVaultToken(fixture.records, 'request')
    const bootstrap = fixture.records.filter((record) =>
      record.url.includes('/claude_cli/bootstrap'),
    )
    expect(bootstrap.length).toBeGreaterThan(0)
    expect(
      fixture.records.filter((record) => record.url.includes('/v1/messages')),
    ).toHaveLength(2)
  })

  test.serial('fallback-manager quota poll', async () => {
    const fixture = await createFixture('quota', { quotaEnabled: true })
    await fixture.plugin.__fallbackRefreshReady
    const usage = fixture.records.filter((record) =>
      record.url.includes('/api/oauth/usage'),
    )

    expectOnlyVaultToken(usage, 'quota')
  })

  test.serial('prime tick', async () => {
    const now = Date.now() - 60_000
    const dueQuota = quota(now)
    dueQuota.five_hour.resetsAt = new Date(now - 120_000).toISOString()
    const fixture = await createFixture('prime', {
      now,
      quotaEnabled: true,
      quotaSnapshot: dueQuota,
      prime: true,
    })
    fixture.records.length = 0
    await fixture.plugin.__primeManager.tick()

    const fallbackRecords = fixture.records.filter(
      (record) => record.authorization !== 'Bearer main-access',
    )
    expectOnlyVaultToken(fallbackRecords, 'prime')
    expect(
      fallbackRecords.some((record) => record.url.includes('/v1/messages')),
    ).toBe(true)
  })

  test.serial('CacheKeep prewarm', async () => {
    const now = 1_000
    const fixture = await createFixture('cachekeep', {
      now,
      cachekeep: true,
      captureIntervals: true,
    })
    fixture.records.length = 0
    const body = JSON.stringify({
      model: 'claude-opus-4-8',
      stream: true,
      messages: [{ role: 'user', content: 'hello' }],
    })
    await (
      await fixture.result.fetch(MESSAGES_URL, {
        method: 'POST',
        headers: { 'x-session-affinity': 'cachekeep-census' },
        body,
      })
    ).text()
    resetClaudeCodeIdentityCachesForTest()
    fixture.records.length = 0
    ;(
      fixture.intervals as IntervalRecord[] & { clock: (now: number) => void }
    ).clock(now + 55 * 60_000)
    const cacheKeepTick = fixture.intervals.at(-1)
    if (!cacheKeepTick) throw new Error('missing CacheKeep interval')
    cacheKeepTick.callback()
    await waitFor(
      () =>
        fixture.records.some((record) => {
          if (!record.url.includes('/v1/messages')) return false
          return (
            (JSON.parse(record.body) as { max_tokens?: number }).max_tokens ===
            0
          )
        }),
      'CacheKeep prewarm did not run',
    )

    expectOnlyVaultToken(fixture.records, 'cachekeep')
    const bootstrap = fixture.records.filter((record) =>
      record.url.includes('/claude_cli/bootstrap'),
    )
    expect(bootstrap.length).toBeGreaterThan(0)
  })

  test.serial('recovery source-model prewarm', async () => {
    // Recovery and ordinary CacheKeep prewarms intentionally share prepareHeaders.
    const now = Date.now()
    const fixture = await createFixture('recovery', {
      now,
      quotaEnabled: true,
      quotaSnapshot: quota(now, 98),
      recovery: true,
    })
    fixture.records.length = 0
    const request = {
      method: 'POST',
      headers: { 'x-session-affinity': 'recovery-census' },
      body: JSON.stringify({
        model: 'claude-fable-5',
        max_tokens: 128_000,
        stream: true,
        system: [{ type: 'text', text: 'stable system' }],
        messages: [{ role: 'user', content: 'hello' }],
      }),
    }
    const refused = await fixture.result.fetch(MESSAGES_URL, request)
    await expect(refused.text()).rejects.toThrow()
    await (await fixture.result.fetch(MESSAGES_URL, request)).text()
    await waitFor(
      () =>
        fixture.records.some((record) => {
          if (!record.url.includes('/v1/messages')) return false
          return (
            (JSON.parse(record.body) as { max_tokens?: number }).max_tokens ===
            0
          )
        }),
      'recovery source-model prewarm did not run',
    )

    expectOnlyVaultToken(fixture.records, 'recovery')
  })

  test.serial('profile hydration', async () => {
    const fixture = await createFixture('profile', { profile: true })
    await waitFor(
      () =>
        fixture.records.some((record) =>
          record.url.includes('/api/oauth/profile'),
        ),
      'fallback profile hydration did not run',
    )
    const profiles = fixture.records.filter((record) =>
      record.url.includes('/api/oauth/profile'),
    )

    expectOnlyVaultToken(profiles, 'profile')
  })
})
