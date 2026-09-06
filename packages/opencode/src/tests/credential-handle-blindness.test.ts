import { afterEach, describe, expect, mock, test } from 'bun:test'
import {
  chmod,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  __setLogTestSink,
  buildAccountList,
  dumpDirectRequest,
  dumpRelayRequest,
  dumpResponseArtifact,
  getLogLevel,
  resetDumpState,
  saveAccountState,
  saveAccounts,
  setDumpEnabled,
  setLogLevel,
} from '@cortexkit/anthropic-auth-core'

import { AnthropicAuthPlugin } from '../index'
import { startRpcServer } from '../rpc/rpc-server'
import {
  drainSidebarWrites,
  type SidebarState,
  setSidebarState,
} from '../sidebar-state'

const HANDLE_SENTINEL = 'claustrum-handle-sentinel-7f2d'
const TOKEN_SENTINEL = 'claustrum-token-sentinel-9a41'

const dumpInputContract: [
  'account' extends keyof Parameters<typeof dumpDirectRequest>[0]
    ? false
    : true,
  'account' extends keyof Parameters<typeof dumpRelayRequest>[0] ? false : true,
] = [true, true]

function countOccurrences(text: string, needle: string): number {
  return text.split(needle).length - 1
}

function accountWithHandle() {
  return {
    id: 'work-alt',
    type: 'oauth' as const,
    label: 'Work',
    refresh: 'refresh-token-not-for-use',
    access: TOKEN_SENTINEL,
    enabled: true,
    claustrumHandle: HANDLE_SENTINEL,
  }
}

const storageWithHandle = () =>
  ({ version: 1, accounts: [accountWithHandle()] }) as never

const sidebarStateWithAccount = (): SidebarState =>
  ({
    main: {
      quota: {
        five_hour: {
          usedPercent: 20,
          remainingPercent: 80,
          resetsAt: '2026-08-29T12:00:00.000Z',
        },
        seven_day: { usedPercent: 30, remainingPercent: 70 },
        scoped: [
          {
            id: 'scope-1',
            title: 'Scoped',
            modelId: 'claude-opus-5',
            modelName: 'Opus 5',
            usedPercent: 10,
            remainingPercent: 90,
          },
        ],
        extraUsage: {
          used: { amountMinor: 10, currency: 'USD', exponent: 2 },
          limit: { amountMinor: 100, currency: 'USD', exponent: 2 },
          utilizationPercent: 10,
          severity: 'ok',
          exhausted: false,
        },
        bindingWindow: 'five_hour',
        fallbackAdvised: true,
      },
      tierLabel: 'Max',
      quotaBackedOff: true,
      quotaBackoffUntil: 456,
      refreshBackedOff: true,
      refreshBackoffUntil: 789,
    },
    fallbacks: [
      {
        ...accountWithHandle(),
        quota: { five_hour: { usedPercent: 40, remainingPercent: 60 } },
        needsReauth: true,
        tierLabel: 'Pro',
      },
    ],
    activeId: 'work-alt',
    route: 'fallback-first',
    relay: { enabled: true, transport: 'websocket' },
    fastMode: true,
    cacheKeep: { enabled: true, window: 'always', trackedSessions: 3 },
    prime: {
      enabled: true,
      accounts: [
        {
          id: 'work-alt',
          label: 'Work',
          nextDueAt: 111,
          lastPrimedAt: 222,
          lastResult: 'ok',
          usage: { count: 3, inputTokens: 10, outputTokens: 2, since: 1 },
          estimatedCostUsd: 0.01,
        },
      ],
    },
    fableRecoveries: [
      {
        sessionId: 'ses-handle',
        mode: 'server',
        remaining: 0,
        changedAt: 333,
        requestedModelId: 'claude-fable-5',
        targetModelId: 'claude-opus-5',
      },
    ],
    lastUpdated: 123,
    account: accountWithHandle(),
  }) as unknown as SidebarState

async function readNonEmpty(path: string): Promise<string> {
  const bytes = await readFile(path, 'utf8')
  expect(bytes.length).toBeGreaterThan(0)
  return bytes
}

function seedCredentialForTest(cache: any, recordVersion: number) {
  cache.seedForTest(HANDLE_SENTINEL, {
    payload: JSON.stringify({ access_token: TOKEN_SENTINEL }),
    expiresAtMs: Date.now() + 5 * 60 * 60 * 1000,
    recordVersion,
  })
}

describe('credential-handle blindness', () => {
  const dumpDirs: string[] = []
  const sidebarDirs: string[] = []
  const accountDirs: string[] = []
  const originalFetch = globalThis.fetch
  const originalAccountFile = process.env.OPENCODE_ANTHROPIC_AUTH_FILE
  const originalSidebarFile =
    process.env.OPENCODE_ANTHROPIC_AUTH_SIDEBAR_STATE_FILE

  afterEach(async () => {
    resetDumpState()
    globalThis.fetch = originalFetch
    if (originalAccountFile === undefined) {
      delete process.env.OPENCODE_ANTHROPIC_AUTH_FILE
    } else {
      process.env.OPENCODE_ANTHROPIC_AUTH_FILE = originalAccountFile
    }
    if (originalSidebarFile === undefined) {
      delete process.env.OPENCODE_ANTHROPIC_AUTH_SIDEBAR_STATE_FILE
    } else {
      process.env.OPENCODE_ANTHROPIC_AUTH_SIDEBAR_STATE_FILE =
        originalSidebarFile
    }
    await Promise.all(
      dumpDirs
        .splice(0)
        .map((path) => rm(path, { recursive: true, force: true })),
    )
    await Promise.all(
      sidebarDirs
        .splice(0)
        .map((path) => rm(path, { recursive: true, force: true })),
    )
    await Promise.all(
      accountDirs
        .splice(0)
        .map((path) => rm(path, { recursive: true, force: true })),
    )
  })

  test('dump entry points exclude account-shaped inputs', () => {
    expect(dumpInputContract).toEqual([true, true])
  })

  test('production dump path stays blind to handle-bearing account storage', async () => {
    const accountDir = await mkdtemp(
      join(tmpdir(), 'opencode-handle-production-'),
    )
    accountDirs.push(accountDir)
    const accountPath = join(accountDir, 'anthropic-auth.json')
    const dumpDir = await mkdtemp(join(tmpdir(), 'opencode-handle-dump-'))
    dumpDirs.push(dumpDir)
    process.env.OPENCODE_ANTHROPIC_AUTH_FILE = accountPath
    process.env.OPENCODE_ANTHROPIC_AUTH_SIDEBAR_STATE_FILE = join(
      accountDir,
      'sidebar-state.json',
    )
    process.env.OPENCODE_ANTHROPIC_AUTH_DUMP_DIR = dumpDir
    setDumpEnabled(true)

    const fallbackAccount = {
      ...accountWithHandle(),
      access: 'fallback-access',
      expires: Date.now() + 5 * 60 * 60 * 1000,
      quota: {
        five_hour: {
          usedPercent: 50,
          remainingPercent: 50,
          checkedAt: Date.now(),
        },
        seven_day: {
          usedPercent: 20,
          remainingPercent: 80,
          checkedAt: Date.now(),
        },
      },
    }
    const storage = {
      version: 1,
      main: { type: 'opencode', provider: 'anthropic' },
      fallbackOn: [429],
      quota: { enabled: false },
      dump: { enabled: true },
      claustrum: { mode: 'claustrum' },
      accounts: [fallbackAccount],
    } as never
    await saveAccounts(storage, accountPath)
    await saveAccountState(storage, accountPath, { accounts: true })

    const authorizations: Array<string | null> = []
    const requestUrls: string[] = []
    globalThis.fetch = mock(
      (input: string | URL | Request, init?: RequestInit) => {
        const url =
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url
        requestUrls.push(url)
        if (!url.startsWith('https://api.anthropic.com/v1/messages')) {
          return Promise.resolve(new Response('{}', { status: 500 }))
        }
        authorizations.push(new Headers(init?.headers).get('authorization'))
        return Promise.resolve(
          new Response(
            '{"id":"msg_handle_production","type":"message","model":"claude-sonnet-4-5","content":[]}',
            {
              status: 200,
              headers: { 'content-type': 'application/json' },
            },
          ),
        )
      },
    ) as unknown as typeof fetch

    const plugin = await (
      AnthropicAuthPlugin as unknown as (ctx: {
        client: unknown
      }) => Promise<any>
    )({
      client: { auth: { set: mock(() => Promise.resolve()) } },
    })
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth' as const,
          access: 'main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 100_000,
          account: fallbackAccount,
        } as never),
      { models: {} },
    )
    const response = await result.fetch(
      'https://api.anthropic.com/v1/messages',
      {
        method: 'POST',
        body: JSON.stringify({
          model: 'claude-sonnet-4-5',
          messages: [{ role: 'user', content: 'production handle blind' }],
        }),
      },
    )
    await response.text()
    await plugin.dispose?.()

    expect(response.status).toBe(200)
    expect(
      requestUrls.some((url) =>
        url.startsWith('https://api.anthropic.com/v1/messages'),
      ),
    ).toBe(true)
    expect(authorizations).toContain('Bearer main-access')
    const files = await readdir(dumpDir)
    expect(files.length).toBeGreaterThan(0)
    const bytes = await Promise.all(
      files.map((file) => readFile(join(dumpDir, file), 'utf8')),
    )
    const artifacts = bytes.join('\n')
    expect(artifacts).toContain('production handle blind')
    expect(artifacts).toContain('msg_handle_production')
    expect(countOccurrences(artifacts, HANDLE_SENTINEL)).toBe(0)
  })

  test('report failure logs stay blind to the served credential handle', async () => {
    const accountDir = await mkdtemp(
      join(tmpdir(), 'opencode-handle-report-log-'),
    )
    accountDirs.push(accountDir)
    const accountPath = join(accountDir, 'anthropic-auth.json')
    process.env.OPENCODE_ANTHROPIC_AUTH_FILE = accountPath

    const storage = {
      version: 1,
      routing: { mode: 'fallback-first' },
      quota: { enabled: false, failClosedOnUnknownQuota: false },
      claustrum: { mode: 'claustrum' },
      accounts: [
        {
          ...accountWithHandle(),
          access: 'fallback-access',
          expires: Date.now() + 5 * 60 * 60 * 1000,
        },
      ],
    } as never
    await saveAccounts(storage, accountPath)

    const logs: Array<Record<string, unknown>> = []
    __setLogTestSink((record) => logs.push(record as Record<string, unknown>))
    try {
      const calls: string[] = []
      const reportParams: unknown[] = []
      const connector = async () =>
        ({
          call: async (_moduleId: string, method: string, params: unknown) => {
            calls.push(method)
            if (method === 'credential.get') {
              return {
                result: {
                  payload: Array.from(
                    new TextEncoder().encode(
                      JSON.stringify({ access_token: 'vault-access' }),
                    ),
                  ),
                  expires_at_ms: Date.now() + 60_000,
                  record_version: 17,
                },
              }
            }
            if (method === 'credential.report_auth_failure')
              reportParams.push(params)
            throw new Error('report failed')
          },
          close: () => {},
        }) as never
      globalThis.fetch = mock(() =>
        Promise.resolve(new Response('{}', { status: 401 })),
      ) as unknown as typeof fetch

      const plugin = await (
        AnthropicAuthPlugin as unknown as (
          ctx: { client: unknown },
          runtimeOverrides: { claustrumConnector: typeof connector },
        ) => Promise<any>
      )(
        { client: { auth: { set: mock(() => Promise.resolve()) } } },
        { claustrumConnector: connector },
      )
      const result = await plugin.auth.loader(
        () =>
          Promise.resolve({
            type: 'oauth' as const,
            access: 'main-access',
            refresh: 'main-refresh',
            expires: Date.now() + 100_000,
          }),
        { models: {} },
      )

      const response = await result.fetch(
        'https://api.anthropic.com/v1/messages',
        {
          method: 'POST',
          body: JSON.stringify({
            model: 'claude-sonnet-4-5',
            messages: [{ role: 'user', content: 'report failure log blind' }],
          }),
        },
      )
      await response.text()
      await plugin.dispose?.()

      expect(response.status).toBe(401)
      expect(calls).toContain('credential.get')
      expect(calls).toContain('credential.report_auth_failure')
      expect(reportParams).toEqual([
        {
          handle: HANDLE_SENTINEL,
          provider_status: 401,
          record_version: 17,
          reporter_source: 'direct',
        },
      ])
      expect(JSON.stringify(reportParams)).not.toContain('vault-access')
      expect(
        logs.some((record) => JSON.stringify(record).includes(HANDLE_SENTINEL)),
      ).toBe(false)
    } finally {
      __setLogTestSink(null)
    }
  })

  test('manifest-source vault-unusable logs stay blind to the custody handle', async () => {
    const manifestHandle = `ckh_${'M'.repeat(43)}`
    const accountDir = await mkdtemp(
      join(tmpdir(), 'opencode-handle-manifest-unusable-'),
    )
    accountDirs.push(accountDir)
    const accountPath = join(accountDir, 'anthropic-auth.json')
    const manifestPath = join(accountDir, 'handles.json')
    const previousManifestPath = process.env.CLAUSTRUM_OPENCODE_HANDLES
    const previousLogLevel = getLogLevel()
    process.env.OPENCODE_ANTHROPIC_AUTH_FILE = accountPath
    process.env.CLAUSTRUM_OPENCODE_HANDLES = manifestPath
    await writeFile(
      manifestPath,
      JSON.stringify({
        version: 1,
        providers: [
          {
            provider: 'anthropic',
            serve: 'anthropic-auth',
            accounts: [
              {
                label: 'work',
                handle: manifestHandle,
                credential_id: 'oauth:anthropic:work',
              },
            ],
          },
        ],
      }),
    )
    await chmod(manifestPath, 0o600)
    await saveAccounts(
      {
        version: 1,
        quota: { enabled: false, failClosedOnUnknownQuota: false },
        claustrum: { mode: 'claustrum' },
        accounts: [
          {
            id: 'work-alt',
            type: 'oauth',
            label: 'work',
            refresh: 'refresh-token-not-for-use',
            enabled: true,
            access: 'fallback-access',
            expires: Date.now() + 5 * 60 * 60 * 1000,
          },
        ],
      } as never,
      accountPath,
    )
    const logs: Array<Record<string, unknown>> = []
    setLogLevel('debug')
    __setLogTestSink((record) => logs.push(record as Record<string, unknown>))
    const intervalHandlers: Array<() => unknown> = []
    let credentialGets = 0
    const connector = async () =>
      ({
        call: async (_moduleId: string, method: string) => {
          if (method !== 'credential.get')
            throw new Error(`unexpected method: ${method}`)
          credentialGets += 1
          return {
            result: {
              payload: Array.from(new TextEncoder().encode(JSON.stringify({}))),
              expires_at_ms: Date.now() + 5 * 60 * 60 * 1000,
              record_version: 1,
            },
          }
        },
        close: () => {},
      }) as never
    try {
      const plugin = await (
        AnthropicAuthPlugin as unknown as (
          ctx: { client: unknown },
          runtimeOverrides: {
            claustrumConnector: typeof connector
            setInterval: typeof setInterval
          },
        ) => Promise<any>
      )(
        { client: { auth: { set: mock(() => Promise.resolve()) } } },
        {
          claustrumConnector: connector,
          setInterval: mock((handler: () => unknown) => {
            intervalHandlers.push(handler)
            return { unref() {} } as never
          }) as never,
        },
      )
      await plugin.__fallbackRefreshReady
      // Plugin boot reapplies the persisted logging level, so debug must be reset afterward.
      setLogLevel('debug')
      plugin.__claustrumCredentialCache.seedForTest(manifestHandle, {
        payload: JSON.stringify({}),
        expiresAtMs: Date.now() + 5 * 60 * 60 * 1000,
        recordVersion: 2,
      })
      expect(intervalHandlers.length).toBeGreaterThan(0)
      await Promise.all(intervalHandlers.map((handler) => handler()))
      await plugin.dispose?.()

      expect(credentialGets).toBeGreaterThan(0)
      expect(
        logs.some(
          (record) => record.message === 'vault fallback credential unusable',
        ),
      ).toBe(true)
      expect(JSON.stringify(logs)).not.toContain(manifestHandle)
    } finally {
      __setLogTestSink(null)
      setLogLevel(previousLogLevel)
      if (previousManifestPath === undefined)
        delete process.env.CLAUSTRUM_OPENCODE_HANDLES
      else process.env.CLAUSTRUM_OPENCODE_HANDLES = previousManifestPath
    }
  })

  test('deduplicates concurrent reports by served handle and record version', async () => {
    const accountDir = await mkdtemp(
      join(tmpdir(), 'opencode-handle-report-dedupe-'),
    )
    accountDirs.push(accountDir)
    const accountPath = join(accountDir, 'anthropic-auth.json')
    process.env.OPENCODE_ANTHROPIC_AUTH_FILE = accountPath

    const checkedAt = Date.now()
    const fallbackAccount = {
      ...accountWithHandle(),
      access: 'fallback-access',
      expires: Date.now() + 5 * 60 * 60 * 1000,
      quota: {
        five_hour: {
          usedPercent: 10,
          remainingPercent: 90,
          checkedAt,
        },
        seven_day: {
          usedPercent: 10,
          remainingPercent: 90,
          checkedAt,
        },
      },
    }
    await saveAccounts(
      {
        version: 1,
        routing: { mode: 'fallback-first' },
        quota: {
          enabled: true,
          checkIntervalMinutes: 5,
          failClosedOnUnknownQuota: false,
        },
        claustrum: { mode: 'claustrum' },
        accounts: [fallbackAccount],
      } as never,
      accountPath,
    )

    const reports: Array<Record<string, unknown>> = []
    const firstReportStarted = Promise.withResolvers<void>()
    const releaseFirstReport = Promise.withResolvers<void>()
    const connector = async () =>
      ({
        call: async (_moduleId: string, method: string, params: unknown) => {
          if (method === 'credential.get') {
            return {
              result: {
                payload: Array.from(
                  new TextEncoder().encode(
                    JSON.stringify({ access_token: 'vault-access' }),
                  ),
                ),
                expires_at_ms: Date.now() + 5 * 60 * 60 * 1000,
                record_version: 17,
              },
            }
          }
          if (method === 'credential.report_auth_failure') {
            reports.push(params as Record<string, unknown>)
            if (reports.length === 1) {
              firstReportStarted.resolve()
              await releaseFirstReport.promise
            }
            return { result: { ok: true } }
          }
          throw new Error(`unexpected method: ${method}`)
        },
        close: () => {},
      }) as never

    globalThis.fetch = mock(() =>
      Promise.resolve(new Response('{}', { status: 401 })),
    ) as unknown as typeof fetch

    const plugin = await (
      AnthropicAuthPlugin as unknown as (
        ctx: { client: unknown },
        runtimeOverrides: { claustrumConnector: typeof connector },
      ) => Promise<any>
    )(
      { client: { auth: { set: mock(() => Promise.resolve()) } } },
      { claustrumConnector: connector },
    )
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth' as const,
          access: 'main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 100_000,
        }),
      { models: {} },
    )
    const request = () =>
      result.fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        body: JSON.stringify({
          model: 'claude-sonnet-4-5',
          messages: [{ role: 'user', content: 'report dedupe' }],
        }),
      })

    const concurrentPromises = [request(), request()]
    await firstReportStarted.promise
    expect(reports).toHaveLength(1)
    releaseFirstReport.resolve()
    const concurrent = await Promise.all(concurrentPromises)
    await Promise.all(concurrent.map((response) => response.text()))

    await plugin.dispose?.()

    expect(reports).toHaveLength(1)
    expect(reports.map((report) => report.record_version)).toEqual([17])
  })

  test('does not re-report a credential version after cache re-population', async () => {
    const accountDir = await mkdtemp(
      join(tmpdir(), 'opencode-handle-report-version-fence-'),
    )
    accountDirs.push(accountDir)
    const accountPath = join(accountDir, 'anthropic-auth.json')
    process.env.OPENCODE_ANTHROPIC_AUTH_FILE = accountPath
    await saveAccounts(
      {
        version: 1,
        routing: { mode: 'fallback-first' },
        quota: { enabled: false, failClosedOnUnknownQuota: false },
        claustrum: { mode: 'claustrum' },
        accounts: [
          {
            ...accountWithHandle(),
            expires: Date.now() + 5 * 60 * 60 * 1000,
          },
        ],
      } as never,
      accountPath,
    )

    const reports: Array<Record<string, unknown>> = []
    const connector = async () =>
      ({
        call: async (_moduleId: string, method: string, params: unknown) => {
          if (method === 'credential.get') {
            return {
              result: {
                payload: Array.from(
                  new TextEncoder().encode(
                    JSON.stringify({ access_token: TOKEN_SENTINEL }),
                  ),
                ),
                expires_at_ms: Date.now() + 5 * 60 * 60 * 1000,
                record_version: 17,
              },
            }
          }
          if (method === 'credential.report_auth_failure') {
            reports.push(params as Record<string, unknown>)
            return { result: { ok: true } }
          }
          throw new Error(`unexpected method: ${method}`)
        },
        close: () => {},
      }) as never
    globalThis.fetch = mock(
      (input: string | URL | Request, init?: RequestInit) => {
        const url =
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url
        if (!url.includes('/v1/messages'))
          return Promise.resolve(new Response('{}', { status: 200 }))
        const authorization = new Headers(init?.headers).get('authorization')
        if (authorization === 'Bearer main-access') {
          return Promise.resolve(new Response('{}', { status: 200 }))
        }
        return Promise.resolve(new Response('{}', { status: 401 }))
      },
    ) as unknown as typeof fetch

    const plugin = await (
      AnthropicAuthPlugin as unknown as (
        ctx: { client: unknown },
        runtimeOverrides: { claustrumConnector: typeof connector },
      ) => Promise<any>
    )(
      { client: { auth: { set: mock(() => Promise.resolve()) } } },
      { claustrumConnector: connector },
    )
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth' as const,
          access: 'main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 100_000,
        }),
      { models: {} },
    )
    const request = () =>
      result.fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        body: JSON.stringify({
          model: 'claude-sonnet-4-5',
          messages: [{ role: 'user', content: 'version fence' }],
        }),
      })

    await (await request()).text()
    expect(reports.map((report) => report.record_version)).toEqual([17])

    seedCredentialForTest(plugin.__claustrumCredentialCache, 17)
    await result.__reportClaustrumAuthFailureForTest({
      accountId: 'work-alt',
      handle: HANDLE_SENTINEL,
      recordVersion: 17,
    })
    expect(reports.map((report) => report.record_version)).toEqual([17])

    seedCredentialForTest(plugin.__claustrumCredentialCache, 18)
    await result.__reportClaustrumAuthFailureForTest({
      accountId: 'work-alt',
      handle: HANDLE_SENTINEL,
      recordVersion: 18,
    })
    await plugin.dispose?.()

    expect(reports.map((report) => report.record_version)).toEqual([17, 18])
  })

  test('keeps the original response readable when the fenced fallback cannot send', async () => {
    const accountDir = await mkdtemp(
      join(tmpdir(), 'opencode-handle-original-response-'),
    )
    accountDirs.push(accountDir)
    const accountPath = join(accountDir, 'anthropic-auth.json')
    process.env.OPENCODE_ANTHROPIC_AUTH_FILE = accountPath
    await saveAccounts(
      {
        version: 1,
        routing: { mode: 'main-first' },
        fallbackOn: [429],
        quota: { enabled: false, failClosedOnUnknownQuota: false },
        claustrum: { mode: 'claustrum' },
        accounts: [
          {
            ...accountWithHandle(),
            expires: Date.now() + 5 * 60 * 60 * 1000,
          },
        ],
      } as never,
      accountPath,
    )

    let credentialGets = 0
    const reports: Array<Record<string, unknown>> = []
    const connector = async () =>
      ({
        call: async (_moduleId: string, method: string, params: unknown) => {
          if (method === 'credential.get') {
            credentialGets += 1
            if (credentialGets > 1) return new Promise<never>(() => {})
            return {
              result: {
                payload: Array.from(
                  new TextEncoder().encode(
                    JSON.stringify({ access_token: TOKEN_SENTINEL }),
                  ),
                ),
                expires_at_ms: Date.now() + 5 * 60 * 60 * 1000,
                record_version: 17,
              },
            }
          }
          if (method === 'credential.report_auth_failure') {
            reports.push(params as Record<string, unknown>)
            return { result: { ok: true } }
          }
          throw new Error(`unexpected method: ${method}`)
        },
        close: () => {},
      }) as never
    let mainRequests = 0
    let fallbackRequests = 0
    globalThis.fetch = mock(
      (input: string | URL | Request, init?: RequestInit) => {
        const url =
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url
        if (!url.includes('/v1/messages')) {
          return Promise.resolve(new Response('{}', { status: 200 }))
        }
        const authorization = new Headers(init?.headers).get('authorization')
        if (authorization === 'Bearer main-access') {
          mainRequests += 1
          return Promise.resolve(
            new Response(
              mainRequests === 1
                ? 'first main response'
                : 'original response body',
              {
                status: 429,
              },
            ),
          )
        }
        fallbackRequests += 1
        return Promise.resolve(new Response('{}', { status: 401 }))
      },
    ) as unknown as typeof fetch

    const plugin = await (
      AnthropicAuthPlugin as unknown as (
        ctx: { client: unknown },
        runtimeOverrides: { claustrumConnector: typeof connector },
      ) => Promise<any>
    )(
      { client: { auth: { set: mock(() => Promise.resolve()) } } },
      { claustrumConnector: connector },
    )
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth' as const,
          access: 'main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 100_000,
        }),
      { models: {} },
    )
    const request = () =>
      result.fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        body: JSON.stringify({
          model: 'claude-sonnet-4-5',
          messages: [{ role: 'user', content: 'original response' }],
        }),
      })

    await (await request()).text()
    expect(reports.map((report) => report.record_version)).toEqual([17])
    seedCredentialForTest(plugin.__claustrumCredentialCache, 17)

    const originalResponse = await request()
    expect(originalResponse.status).toBe(429)
    expect(await originalResponse.text()).toBe('original response body')
    expect(fallbackRequests).toBe(1)
    await plugin.dispose?.()
  })

  test('dump body, metadata, response, and transport capture stay blind to tokens', async () => {
    const dumpDir = await mkdtemp(join(tmpdir(), 'opencode-handle-dump-'))
    dumpDirs.push(dumpDir)
    process.env.OPENCODE_ANTHROPIC_AUTH_DUMP_DIR = dumpDir
    setDumpEnabled(true)

    const bodyText = '{"messages":[{"role":"user","content":"hello"}]}'
    const direct = await dumpDirectRequest({
      affinity: 'ses-handle-direct',
      route: 'oauth',
      status: 200,
      bodyText,
      url: 'https://api.anthropic.com/v1/messages',
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN_SENTINEL}` },
    })
    expect(direct).not.toBeNull()
    await dumpResponseArtifact(direct, {
      status: 200,
      message: {
        id: 'msg_handle_blind',
        model: 'claude-opus-5',
        usage: { input_tokens: 3, output_tokens: 2 },
        diagnostics: { request_id: 'req_handle_blind' },
      },
    })

    const relayBody = '{"messages":[{"role":"user","content":"relay"}]}'
    const relay = await dumpRelayRequest({
      affinity: 'ses-handle-relay',
      transport: 'websocket',
      protocol: 2,
      mode: 'full_sync',
      status: 200,
      bodyText: relayBody,
      payload: {
        protocol: 2,
        type: 'request',
        affinity: 'ses-handle-relay',
        upstream: {
          url: 'https://api.anthropic.com/v1/messages',
          method: 'POST',
          headers: {
            authorization: `Bearer ${TOKEN_SENTINEL}`,
            'content-type': 'application/json',
          },
        },
        next_hash: 'sha256:handle-blind',
        mode: 'full_sync',
        revision: 1,
        body: relayBody,
      },
      relayBytes: relayBody.length,
    })
    expect(relay).not.toBeNull()
    await dumpResponseArtifact(relay, {
      status: 200,
      message: {
        id: 'msg_handle_blind_relay',
        model: 'claude-opus-5',
        usage: { input_tokens: 4, output_tokens: 1 },
      },
    })

    const directPrefix = direct!.responsePath.replace('.response.json', '')
    const relayPrefix = relay!.responsePath.replace('.response.json', '')
    const artifacts = [
      {
        name: 'direct body',
        path: `${directPrefix}.body.json`,
        positive: bodyText,
      },
      {
        name: 'direct metadata',
        path: `${directPrefix}.meta.json`,
        positive: '"route": "oauth"',
      },
      {
        name: 'direct request',
        path: `${directPrefix}.request.json`,
        positive: 'api.anthropic.com/v1/messages',
      },
      {
        name: 'direct response',
        path: direct!.responsePath,
        positive: 'msg_handle_blind',
      },
      {
        name: 'relay body',
        path: `${relayPrefix}.body.json`,
        positive: relayBody,
      },
      {
        name: 'relay metadata',
        path: `${relayPrefix}.meta.json`,
        positive: '"transport": "websocket"',
      },
      {
        name: 'relay capture',
        path: `${relayPrefix}.relay.json`,
        positive: '"type": "request"',
      },
      {
        name: 'relay response',
        path: relay!.responsePath,
        positive: 'msg_handle_blind_relay',
      },
    ]

    for (const artifact of artifacts) {
      const bytes = await readNonEmpty(artifact.path)
      expect(bytes, artifact.name).toContain(artifact.positive)
      expect(countOccurrences(bytes, TOKEN_SENTINEL), artifact.name).toBe(0)
    }
    expect(await readdir(dumpDir)).toHaveLength(8)
  })

  test('sidebar state writes only the projected account fields', async () => {
    const sidebarDir = await mkdtemp(join(tmpdir(), 'opencode-handle-sidebar-'))
    sidebarDirs.push(sidebarDir)
    const stateFile = join(sidebarDir, 'sidebar-state.json')

    await setSidebarState(sidebarStateWithAccount(), stateFile)
    await drainSidebarWrites()
    const bytes = await readNonEmpty(stateFile)
    const written = JSON.parse(bytes) as Record<string, any>
    expect(bytes).toContain('"work-alt"')
    expect(bytes).toContain('"fallback-first"')
    expect(written.main).toMatchObject({
      tierLabel: 'Max',
      quotaBackedOff: true,
      quotaBackoffUntil: 456,
      refreshBackedOff: true,
      refreshBackoffUntil: 789,
    })
    expect(written.main.quota).toMatchObject({
      five_hour: { usedPercent: 20, remainingPercent: 80 },
      seven_day: { usedPercent: 30, remainingPercent: 70 },
      scoped: [{ id: 'scope-1', modelId: 'claude-opus-5' }],
      extraUsage: { exhausted: false, severity: 'ok' },
      bindingWindow: 'five_hour',
      fallbackAdvised: true,
    })
    expect(written.fallbacks).toEqual([
      {
        id: 'work-alt',
        label: 'Work',
        quota: { five_hour: { usedPercent: 40, remainingPercent: 60 } },
        enabled: true,
        needsReauth: true,
        tierLabel: 'Pro',
      },
    ])
    expect(written.relay).toEqual({ enabled: true, transport: 'websocket' })
    expect(written.fastMode).toBe(true)
    expect(written.cacheKeep).toEqual({
      enabled: true,
      window: 'always',
      trackedSessions: 3,
    })
    expect(written.prime).toMatchObject({
      enabled: true,
      accounts: [{ id: 'work-alt', usage: { count: 3 } }],
    })
    expect(written.fableRecoveries).toEqual([
      {
        sessionId: 'ses-handle',
        mode: 'server',
        remaining: 0,
        changedAt: 333,
        requestedModelId: 'claude-fable-5',
        targetModelId: 'claude-opus-5',
      },
    ])
    expect(countOccurrences(bytes, HANDLE_SENTINEL)).toBe(0)
    expect(countOccurrences(bytes, TOKEN_SENTINEL)).toBe(0)
  })

  test('account records are projected before the RPC response boundary', async () => {
    const rpcDir = await mkdtemp(join(tmpdir(), 'opencode-handle-rpc-'))
    sidebarDirs.push(rpcDir)
    const accounts = buildAccountList(storageWithHandle()).map((account) => ({
      ...account,
      claustrumGate:
        account.role === 'main' ? ('na' as const) : ('on' as const),
      vaultServed: account.role === 'fallback',
      vaultReauth: false,
      custodyState:
        account.role === 'main'
          ? ('na' as const)
          : ('on-vault-served' as const),
    }))
    const server = await startRpcServer({
      dir: rpcDir,
      drain: () => [],
      apply: async () => ({ text: 'accounts loaded', knobs: { accounts } }),
    })
    try {
      const response = await fetch(
        `http://127.0.0.1:${server.port}/rpc/apply`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${server.token}`,
          },
          body: JSON.stringify({ command: 'claude-account', arguments: '' }),
        },
      )
      expect(response.status).toBe(200)
      const bytes = await response.text()
      expect(bytes.length).toBeGreaterThan(0)
      expect(bytes).toContain('accounts loaded')
      expect(bytes).toContain('work-alt')
      expect(bytes).toContain('claustrumGate')
      expect(bytes).toContain('vaultServed')
      expect(countOccurrences(bytes, HANDLE_SENTINEL)).toBe(0)
      expect(countOccurrences(bytes, TOKEN_SENTINEL)).toBe(0)
    } finally {
      await server.stop()
    }
  })
})
