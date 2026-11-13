import { describe, expect, mock } from 'bun:test'
import { isCache1hEnabled } from '@cortexkit/anthropic-auth-core'
import { installLoaderSetup } from './support/opencode1-loader-setup.ts'
import {
  bindPoolAccounts,
  createFallbackStorage,
  getPlugin,
  syntheticMainAccountUuid,
  syntheticMainHostAuth,
  updatePoolSettings,
  useTempAccountFile,
  withNativeAdmission,
} from './support/opencode1-pool-fixture.ts'
import {
  createOpencode1Test,
  createOpencode1TestContext,
  EMPTY_POST,
  installOpencode1TestHooks,
} from './support/opencode1-test-context.ts'
import { extractUrl, MESSAGES_URL } from './test-fetch'

const ctx = createOpencode1TestContext()
installOpencode1TestHooks(ctx)
const test = createOpencode1Test(ctx)
const cases = [
  { value: true, on: true },
  { value: false, on: false },
  { value: undefined, on: false },
  { value: 'on', on: true },
  { value: 'off', on: false },
  { value: 'default', on: false },
] as const

function quota(remaining: number) {
  const checkedAt = Date.now()
  return {
    checkedAt,
    five_hour: {
      usedPercent: 100 - remaining,
      remainingPercent: remaining,
      checkedAt,
    },
    seven_day: {
      usedPercent: 100 - remaining,
      remainingPercent: remaining,
      checkedAt,
    },
  }
}

async function setQuotaField(
  field: 'enabled' | 'failClosedOnUnknownQuota',
  value: (typeof cases)[number]['value'],
) {
  await updatePoolSettings(ctx, (settings) => {
    const quota = { ...(settings.quota as Record<string, unknown>) }
    if (value === undefined) delete quota[field]
    else quota[field] = value
    return { ...settings, quota }
  })
}

async function request() {
  const plugin = await getPlugin(ctx)
  if (!plugin.auth?.loader) throw new Error('Missing auth loader')
  const loader = await plugin.auth.loader(
    async () => ({ type: 'oauth', ...syntheticMainHostAuth() }),
    { models: {} },
  )
  if (!loader.fetch) throw new Error('Missing plugin fetch')
  const response = await loader.fetch(MESSAGES_URL, EMPTY_POST)
  await response.text()
  return response.status
}

describe('OpenCode 1 three-way request readers', () => {
  installLoaderSetup(ctx)

  for (const { value, on } of cases) {
    test(`persistent cache latch preserves its off absence default: ${String(value)}`, async () => {
      await useTempAccountFile(
        ctx,
        bindPoolAccounts(
          createFallbackStorage({
            accounts: [],
            quota: { enabled: false },
          }),
        ),
      )
      await updatePoolSettings(ctx, (settings) => ({
        ...settings,
        claudeCache: value === undefined ? {} : { enabled: value },
      }))
      globalThis.fetch = mock(
        withNativeAdmission(ctx, () => Response.json({})),
      ) as unknown as typeof fetch
      await getPlugin(ctx)
      expect(isCache1hEnabled()).toBe(on)
    })

    test(`mainQuotaRoutingEnabled routes an exhausted main only when quota is on: ${String(value)}`, async () => {
      await useTempAccountFile(
        ctx,
        bindPoolAccounts(
          createFallbackStorage({
            quota: {
              enabled: false,
              failClosedOnUnknownQuota: false,
              minimumRemaining: { five_hour: 10, seven_day: 20 },
            },
          }),
        ),
      )
      await setQuotaField('enabled', value)
      const bearers: string[] = []
      globalThis.fetch = mock(
        withNativeAdmission(
          ctx,
          (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
            if (extractUrl(input).includes('/api/oauth/usage'))
              return Response.json({
                five_hour: {
                  utilization: new Headers(init?.headers)
                    .get('authorization')
                    ?.includes('main-access')
                    ? 100
                    : 0,
                },
                seven_day: {
                  utilization: new Headers(init?.headers)
                    .get('authorization')
                    ?.includes('main-access')
                    ? 100
                    : 0,
                },
              })
            bearers.push(new Headers(init?.headers).get('authorization') ?? '')
            return new Response('served', { status: 200 })
          },
        ),
      ) as unknown as typeof fetch
      expect(await request()).toBe(200)
      expect(bearers).toEqual([
        on
          ? 'Bearer sk-ant-oat01-fallback-access'
          : 'Bearer sk-ant-oat01-main-access',
      ])
    })

    test(`main quota backoff refuses only when failClosed is on: ${String(value)}`, async () => {
      const now = Date.now()
      await useTempAccountFile(
        ctx,
        bindPoolAccounts(
          createFallbackStorage({
            accounts: [],
            // Disable quota polling and the earlier provider restriction so the
            // request reaches the transport's independent fail-closed check.
            quota: {
              enabled: false,
              failClosedOnUnknownQuota: false,
              mainLastQuotaApiError: {
                accountIdentity: syntheticMainAccountUuid,
                message: 'quota source unavailable',
                checkedAt: now,
                nextRetryAt: now + 60_000,
                retryCount: 1,
              },
            },
          }),
        ),
      )
      await setQuotaField('failClosedOnUnknownQuota', value)
      let sends = 0
      globalThis.fetch = mock(
        withNativeAdmission(ctx, (input: Parameters<typeof fetch>[0]) => {
          if (extractUrl(input).includes('/api/oauth/usage'))
            throw new Error('quota source unavailable')
          sends++
          return new Response('served', { status: 200 })
        }),
      ) as unknown as typeof fetch
      expect(await request()).toBe(on ? 429 : 200)
      expect(sends).toBe(on ? 0 : 1)
    })

    test(`unknown fallback quota preserves legacy failClosed routability: ${String(value)}`, async () => {
      await useTempAccountFile(
        ctx,
        bindPoolAccounts(
          createFallbackStorage({
            routing: { mode: 'fallback-first' },
            quota: {
              enabled: true,
              failClosedOnUnknownQuota: false,
              mainQuota: quota(100),
            },
            accounts: [
              {
                id: 'unknown-fallback',
                type: 'oauth',
                access: 'sk-ant-oat01-unknown-fallback-access',
                refresh: 'unknown-fallback-refresh',
                expires: Date.now() + 5 * 60 * 60_000,
              },
            ],
          }),
        ),
      )
      await setQuotaField('failClosedOnUnknownQuota', value)
      const bearers: string[] = []
      globalThis.fetch = mock(
        withNativeAdmission(
          ctx,
          (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
            if (extractUrl(input).includes('/api/oauth/usage'))
              throw new Error('quota source unavailable')
            bearers.push(new Headers(init?.headers).get('authorization') ?? '')
            return new Response('served', { status: 200 })
          },
        ),
      ) as unknown as typeof fetch
      expect(await request()).toBe(200)
      // Core admission still treats absent/default as fail-closed, even
      // though OpenCode 1's extra fallback eligibility check treats them as off.
      const admitted = value === false || value === 'off'
      expect(bearers).toEqual([
        admitted
          ? 'Bearer sk-ant-oat01-unknown-fallback-access'
          : 'Bearer sk-ant-oat01-main-access',
      ])
    })
  }
})
