import { expect, mock } from 'bun:test'
import type {
  AccountStorage,
  LogTestRecord,
} from '@cortexkit/anthropic-auth-core'
import { createNativeAccountRuntime } from '@cortexkit/anthropic-auth-core'
import {
  extractUrl,
  MESSAGES_URL,
  PROFILE_URL,
  QUOTA_URL,
  TOKEN_URL,
} from '../test-fetch'
import {
  createFallbackStorage,
  getPlugin,
  STATE_READ_PAUSE_MS,
  syntheticMainAccountUuid,
  useTempAccountFile,
  withNativeAdmission,
  withNativeTokenExchange,
} from './opencode1-pool-fixture.ts'
import { readAccountStorage } from './opencode1-state-observers.ts'
import {
  EMPTY_POST,
  type Opencode1TestContext,
  untilStateOrTestEnd,
} from './opencode1-test-context.ts'

/**
 * Wait for a log record matching `predicate`, re-checking the test's sink
 * until one arrives or the test ends rather than to a fixed wall-clock
 * deadline.
 */
export async function waitForLogRecord(
  ctx: Opencode1TestContext,
  records: LogTestRecord[],
  predicate: (record: LogTestRecord) => boolean,
  description: string,
) {
  const changes = untilStateOrTestEnd(ctx, STATE_READ_PAUSE_MS)
  try {
    while (!changes.ended) {
      await changes.next()
      if (records.some(predicate)) return
    }
  } finally {
    changes.close()
  }
  if (!records.some(predicate)) {
    throw new Error(
      `Expected log record ${description}: ${JSON.stringify(records)}`,
    )
  }
}

export {
  extractUrl,
  MESSAGES_URL,
  PROFILE_URL,
  QUOTA_URL,
  TOKEN_URL,
  withNativeTokenExchange,
}
/**
 * Records without Anthropic's sk-ant-oat access-token prefix must refuse
 * before sending a model request, even if bootstrap supplies an account UUID.
 * The error directs API-key users to OpenCode's stock Anthropic authentication.
 */
export async function expectNonOatMainRefused(
  ctx: Opencode1TestContext,
  access: string,
) {
  await useTempAccountFile(ctx, createFallbackStorage({ accounts: [] }), {
    access,
    refresh: `refresh-${access}`,
    expires: Date.now() + 100_000,
  })
  const modelRequests: string[] = []
  globalThis.fetch = mock(
    withNativeTokenExchange(ctx, (input: Parameters<typeof fetch>[0]) => {
      const url = extractUrl(input)
      if (url.includes('/claude_cli/bootstrap'))
        return Promise.resolve(
          Response.json({
            oauth_account: { account_uuid: syntheticMainAccountUuid },
          }),
        )
      if (url.includes('/v1/messages')) modelRequests.push(url)
      return Promise.resolve(new Response('{}', { status: 200 }))
    }),
  ) as unknown as typeof fetch
  const plugin = await getPlugin(ctx)
  const result = await plugin.auth.loader(
    () =>
      Promise.resolve({
        type: 'oauth' as const,
        access,
        refresh: `refresh-${access}`,
        expires: Date.now() + 100_000,
      }),
    { models: {} },
  )
  await expect(
    result.fetch(MESSAGES_URL, {
      method: 'POST',
      body: JSON.stringify({ model: 'claude-sonnet-4-5', messages: [] }),
    }),
  ).rejects.toThrow(/API key/i)
  expect(modelRequests).toEqual([])
  const pool = ctx.migratedPool
  if (!pool) throw new Error('Expected migrated pool for non-OAT refusal check')
  const runtime = createNativeAccountRuntime({
    paths: pool.paths,
    host: 'opencode',
  })
  try {
    expect(await runtime.authorizeLocal('main')).toEqual({
      status: 'refused',
      reason: 'unsupported-access',
      persisted: false,
    })
    expect(
      (await readAccountStorage(ctx))?.refresh?.mainLastRefreshError,
    ).toBeUndefined()
  } finally {
    runtime.close()
  }
}

/**
 * Record a recent usage-API failure for the main account, load the plugin
 * with a usage endpoint that keeps failing, and require the main request to
 * be refused with 429. Callers pass storage whose quota policy is fail-closed.
 */
export async function expectUnknownQuotaAdmissionBlocked(
  ctx: Opencode1TestContext,
  storage: AccountStorage,
) {
  const now = Date.now()
  storage.quota = {
    ...storage.quota,
    mainLastQuotaApiError: {
      message: 'quota source unavailable',
      checkedAt: now,
      nextRetryAt: now + 60_000,
      retryCount: 1,
    },
  }
  // Import the configured usage-API failure into shared account storage.
  // Migration retires the old state file; later writes use shared storage.
  await useTempAccountFile(ctx, storage)
  globalThis.fetch = mock(
    withNativeAdmission(ctx, (input: Parameters<typeof fetch>[0]) => {
      const url = extractUrl(input)
      if (url.includes('/api/oauth/usage'))
        return Promise.reject(new Error('quota source unavailable'))
      return Promise.resolve(new Response('{}', { status: 200 }))
    }),
  ) as unknown as typeof fetch
  const plugin = await getPlugin(ctx)
  const result = await plugin.auth.loader(
    () =>
      Promise.resolve({
        type: 'oauth' as const,
        access: 'sk-ant-oat01-main-access',
        refresh: 'main-refresh',
        expires: Date.now() + 100000,
      }),
    { models: {} },
  )
  const response = await result.fetch(MESSAGES_URL, EMPTY_POST)
  expect(response.status).toBe(429)
}
