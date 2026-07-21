import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  addAccountPersistent,
  getAccountStatePath,
} from '@cortexkit/anthropic-auth-core'

import { addApiRoute, login, relaySetup } from '../cli'

let tempDir: string

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'anthropic-cli-test-'))
})

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true })
})

// addApiRoute / login are exercised IN-PROCESS with injected deps rather than
// via `bun [--preload] src/cli.ts ...`. The subprocess form (Bun.spawn +
// optional --preload fetch stub + stdin pipe) hung indefinitely in CI
// (proc.exited never resolving, 5000ms timeout) while passing locally — the
// failure lived in that harness, not in the command logic, and was
// unreproducible locally. Calling the commands directly with injected prompt
// (and, for login, authorize/exchange) removes the entire fragile surface
// (no spawn, no preload, no readline/stdin race, no real network) while still
// exercising the real logic and asserting the same persisted outcomes.

// Run a command body against a temp account file, restoring any env we touch.
async function withAccountEnv<T>(
  accountPath: string,
  env: Record<string, string | undefined>,
  fn: () => Promise<T>,
): Promise<T> {
  const keys = ['OPENCODE_ANTHROPIC_AUTH_FILE', ...Object.keys(env)]
  const prev = new Map(keys.map((k) => [k, process.env[k]]))
  process.env.OPENCODE_ANTHROPIC_AUTH_FILE = accountPath
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  try {
    return await fn()
  } finally {
    for (const [k, v] of prev) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

describe('CLI api add', () => {
  test('saves API route config and stores API key in runtime state', async () => {
    const accountPath = join(tempDir, 'anthropic-auth.json')

    await withAccountEnv(
      accountPath,
      {
        OPENCODE_ANTHROPIC_AUTH_API_BASE_URL: 'https://api.kie.ai/claude',
        OPENCODE_ANTHROPIC_AUTH_API_KEY: 'kie-key',
        OPENCODE_ANTHROPIC_AUTH_API_AUTH_HEADER: 'authorization-bearer',
      },
      () =>
        addApiRoute('kie-opus', {
          prompt: async () => {
            throw new Error('prompt should not be called: all inputs from env')
          },
        }),
    )

    const storage = JSON.parse(await readFile(accountPath, 'utf8'))
    expect(storage.accounts[0]).toMatchObject({
      id: 'kie-opus',
      label: 'kie-opus',
      type: 'api',
      enabled: true,
      baseURL: 'https://api.kie.ai/claude',
      authHeader: 'authorization-bearer',
    })
    expect(storage.accounts[0].apiKey).toBeUndefined()

    const runtimeState = JSON.parse(
      await readFile(getAccountStatePath(accountPath), 'utf8'),
    )
    expect(runtimeState.accounts['kie-opus'].apiKey).toBe('kie-key')
  })

  test('rejects invalid API base URL before saving route state', async () => {
    const accountPath = join(tempDir, 'anthropic-auth.json')

    const promise = withAccountEnv(
      accountPath,
      {
        OPENCODE_ANTHROPIC_AUTH_API_BASE_URL: 'https://secret@example.com/v1',
        OPENCODE_ANTHROPIC_AUTH_API_KEY: 'kie-key',
        OPENCODE_ANTHROPIC_AUTH_API_AUTH_HEADER: 'authorization-bearer',
      },
      () =>
        addApiRoute('bad-api', {
          prompt: async () => '',
        }),
    )

    await expect(promise).rejects.toThrow(
      'API fallback base URL must be an http(s) URL',
    )

    // Nothing should have been persisted for the rejected route.
    await expect(readFile(accountPath, 'utf8')).rejects.toThrow()
  })
})

describe('CLI login', () => {
  test('continues from label prompt to OAuth callback prompt and saves account', async () => {
    const accountPath = join(tempDir, 'anthropic-auth.json')

    // Real authorize() (exercises PKCE + state + the printed URL); exchange()
    // is the network boundary, stubbed to return canned tokens. The prompt
    // returns the label first, then the pasted callback code.
    const asked: string[] = []
    const promptAnswers = [
      'cli-label',
      'https://platform.claude.com/oauth/code/callback?code=cli-code&state=stub',
    ]
    let askIndex = 0
    const prompt = async (message: string) => {
      asked.push(message)
      return promptAnswers[askIndex++] ?? ''
    }

    let exchangeArgs: { input: string; verifier: string } | undefined
    const exchange = async (
      input: string,
      verifier: string,
    ): Promise<{
      type: 'success'
      access: string
      refresh: string
      expires: number
    }> => {
      exchangeArgs = { input, verifier }
      return {
        type: 'success',
        access: 'cli-access',
        refresh: 'cli-refresh',
        expires: Date.now() + 3600 * 1000,
      }
    }

    const logs: string[] = []
    const origLog = console.log
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(' '))
    }
    try {
      await withAccountEnv(accountPath, {}, () =>
        login(undefined, { prompt, exchange }),
      )
    } finally {
      console.log = origLog
    }

    const stdout = logs.join('\n')
    // The real authorize() URL was printed and carries a generated state.
    expect(stdout).toMatch(/[?&]state=[a-f0-9]+/)
    // The callback-code prompt and label prompt both fired, in order.
    expect(asked).toEqual([
      'Fallback account label (optional): ',
      'Paste the full callback URL or authorization code here: ',
    ])
    // exchange received the real authorize() verifier and the pasted code.
    expect(exchangeArgs?.input).toBe(
      'https://platform.claude.com/oauth/code/callback?code=cli-code&state=stub',
    )
    expect(exchangeArgs?.verifier).toBeString()
    expect(stdout).toContain('Saved fallback account "cli-label"')

    const storage = JSON.parse(await readFile(accountPath, 'utf8'))
    expect(storage.accounts).toHaveLength(1)
    expect(storage.accounts[0]).toMatchObject({
      id: 'cli-label',
      label: 'cli-label',
      enabled: true,
    })
    expect(storage.accounts[0].access).toBeUndefined()
    expect(storage.accounts[0].refresh).toBeUndefined()

    const runtimeState = JSON.parse(
      await readFile(getAccountStatePath(accountPath), 'utf8'),
    )
    expect(runtimeState.accounts['cli-label']).toMatchObject({
      access: 'cli-access',
      refresh: 'cli-refresh',
    })
    expect(runtimeState.accounts['cli-label'].authLineageId).toMatch(
      /^[0-9a-f-]{36}$/,
    )
  })

  test('preserves an account committed while the interactive OAuth flow is open', async () => {
    const accountPath = join(tempDir, 'anthropic-auth.json')
    const now = Date.now()
    const exchange = async (): Promise<{
      type: 'success'
      access: string
      refresh: string
      expires: number
    }> => {
      await addAccountPersistent(
        {
          id: 'umut',
          label: 'umut',
          type: 'oauth',
          access: 'umut-access',
          refresh: 'umut-refresh',
          expires: now + 3600 * 1000,
          enabled: true,
          addedAt: now,
        },
        accountPath,
      )
      return {
        type: 'success',
        access: 'yiyi-access',
        refresh: 'yiyi-refresh',
        expires: now + 3600 * 1000,
      }
    }

    await withAccountEnv(accountPath, {}, () =>
      login('yiyi', {
        prompt: async () =>
          'https://platform.claude.com/oauth/code/callback?code=cli-code&state=stub',
        exchange,
      }),
    )

    const config = JSON.parse(await readFile(accountPath, 'utf8'))
    expect(
      config.accounts.map((account: { id: string }) => account.id),
    ).toEqual(['umut', 'yiyi'])
    const runtimeState = JSON.parse(
      await readFile(getAccountStatePath(accountPath), 'utf8'),
    )
    expect(Object.keys(runtimeState.accounts)).toEqual(['umut', 'yiyi'])
    expect(runtimeState.accounts.umut.refresh).toBe('umut-refresh')
    expect(runtimeState.accounts.yiyi.refresh).toBe('yiyi-refresh')
  })

  test('re-login with same label clears stale errors and quota', async () => {
    const accountPath = join(tempDir, 'anthropic-auth.json')

    await writeFile(
      accountPath,
      JSON.stringify({
        version: 1,
        main: { type: 'opencode', provider: 'anthropic' },
        accounts: [
          {
            id: 'cli-label',
            label: 'cli-label',
            type: 'oauth',
            access: 'old-access',
            refresh: 'old-refresh',
            expires: 1,
            enabled: true,
            addedAt: 123,
            quota: {
              five_hour: {
                usedPercent: 99,
                remainingPercent: 1,
                checkedAt: 123,
              },
            },
            lastRefreshedAt: 123,
            lastRefreshError: { message: 'old refresh failed', checkedAt: 123 },
            lastQuotaRefreshError: {
              message: 'old quota failed',
              checkedAt: 123,
            },
          },
        ],
      }),
      'utf8',
    )

    // Label is passed as the arg, so the only prompt is the callback code.
    const asked: string[] = []
    const prompt = async (message: string) => {
      asked.push(message)
      return 'https://platform.claude.com/oauth/code/callback?code=cli-code&state=stub'
    }
    const exchange = async (): Promise<{
      type: 'success'
      access: string
      refresh: string
      expires: number
    }> => ({
      type: 'success',
      access: 'new-access',
      refresh: 'new-refresh',
      expires: Date.now() + 3600 * 1000,
    })

    await withAccountEnv(accountPath, {}, () =>
      login('cli-label', { prompt, exchange }),
    )

    expect(asked).toEqual([
      'Paste the full callback URL or authorization code here: ',
    ])

    const storage = JSON.parse(await readFile(accountPath, 'utf8'))
    expect(storage.accounts).toHaveLength(1)
    expect(storage.accounts[0]).toMatchObject({
      id: 'cli-label',
      label: 'cli-label',
      enabled: true,
      addedAt: 123,
    })
    expect(storage.accounts[0].access).toBeUndefined()
    expect(storage.accounts[0].refresh).toBeUndefined()
    expect(storage.accounts[0].quota).toBeUndefined()
    expect(storage.accounts[0].lastRefreshedAt).toBeUndefined()
    expect(storage.accounts[0].lastRefreshError).toBeUndefined()
    expect(storage.accounts[0].lastQuotaRefreshError).toBeUndefined()

    const runtimeState = JSON.parse(
      await readFile(getAccountStatePath(accountPath), 'utf8'),
    )
    expect(runtimeState.accounts['cli-label']).toMatchObject({
      access: 'new-access',
      refresh: 'new-refresh',
    })
    expect(runtimeState.accounts['cli-label'].quota).toBeUndefined()
    expect(runtimeState.accounts['cli-label'].lastRefreshedAt).toBeNumber()
    expect(runtimeState.accounts['cli-label'].lastRefreshError).toBeUndefined()
    expect(
      runtimeState.accounts['cli-label'].lastQuotaRefreshError,
    ).toBeUndefined()
  })

  test('re-login with same label replaces split runtime state and clears stale reauth', async () => {
    const accountPath = join(tempDir, 'anthropic-auth.json')
    const statePath = getAccountStatePath(accountPath)
    const oldRefreshedAt = Date.now() - 60_000

    await writeFile(
      accountPath,
      JSON.stringify(
        {
          version: 1,
          main: { type: 'opencode', provider: 'anthropic' },
          accounts: [
            {
              id: 'cli-label',
              label: 'cli-label',
              type: 'oauth',
              enabled: true,
              addedAt: 123,
            },
          ],
        },
        null,
        2,
      ),
      'utf8',
    )
    await writeFile(
      statePath,
      JSON.stringify(
        {
          version: 1,
          accounts: {
            'cli-label': {
              access: 'old-access',
              refresh: 'old-refresh',
              expires: 1,
              lastRefreshedAt: oldRefreshedAt,
              quota: {
                five_hour: {
                  usedPercent: 99,
                  remainingPercent: 1,
                  checkedAt: Date.now(),
                },
              },
              lastRefreshError: {
                message: 'old invalid_grant',
                checkedAt: oldRefreshedAt,
                nextRetryAt: Date.now() + 3_600_000,
                permanent: true,
              },
              lastQuotaRefreshError: {
                message: 'old quota error',
                checkedAt: oldRefreshedAt,
              },
            },
          },
        },
        null,
        2,
      ),
      'utf8',
    )

    const prompt = async () =>
      'https://platform.claude.com/oauth/code/callback?code=cli-code&state=stub'
    const exchange = async (): Promise<{
      type: 'success'
      access: string
      refresh: string
      expires: number
    }> => ({
      type: 'success',
      access: 'new-access',
      refresh: 'new-refresh',
      expires: Date.now() + 3600 * 1000,
    })

    await withAccountEnv(accountPath, {}, () =>
      login('cli-label', { prompt, exchange }),
    )

    const runtimeState = JSON.parse(await readFile(statePath, 'utf8'))
    expect(runtimeState.accounts['cli-label']).toMatchObject({
      access: 'new-access',
      refresh: 'new-refresh',
    })
    expect(runtimeState.accounts['cli-label'].lastRefreshedAt).toBeGreaterThan(
      oldRefreshedAt,
    )
    expect(runtimeState.accounts['cli-label'].quota).toBeUndefined()
    expect(runtimeState.accounts['cli-label'].lastRefreshError).toBeUndefined()
    expect(
      runtimeState.accounts['cli-label'].lastQuotaRefreshError,
    ).toBeUndefined()
  })
})

describe('CLI relay setup', () => {
  // relaySetup is exercised IN-PROCESS with an injected fetch + prompt rather
  // than via `bun --preload ... src/cli.ts relay setup`. The old subprocess
  // form hung indefinitely in CI (timed out at 5000ms with proc.exited never
  // resolving) — the failure lived in the subprocess+--preload+readline/stdin
  // harness, not in relaySetup's logic, and was unreproducible locally. Calling
  // relaySetup directly with injected deps removes that entire fragile surface
  // (no spawn, no preload-stub-application risk, no real network, no stdin/pipe
  // race) while still exercising the real setup logic: KV create, worker
  // upload, enable workers.dev, subdomain lookup, token generation, and config
  // save — the same four Cloudflare calls and the same persisted relay config.
  test('deploys worker resources and saves relay config', async () => {
    const accountPath = join(tempDir, 'anthropic-auth.json')
    const calls: Array<{ url: string; method?: string }> = []
    let accountAddedDuringProvisioning = false

    const fetchImpl = async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const url = input.toString()
      calls.push({ url, method: init?.method })
      if (!accountAddedDuringProvisioning) {
        accountAddedDuringProvisioning = true
        await addAccountPersistent(
          {
            id: 'added-during-relay',
            label: 'added-during-relay',
            type: 'oauth',
            refresh: 'relay-race-refresh',
          },
          accountPath,
        )
      }
      if (url.includes('/storage/kv/namespaces'))
        return Response.json({ success: true, result: { id: 'kv-id' } })
      if (url.includes('/workers/scripts/opencode-anthropic-relay/subdomain'))
        return Response.json({ success: true, result: { enabled: true } })
      if (url.includes('/workers/subdomain'))
        return Response.json({
          success: true,
          result: { subdomain: 'user-subdomain' },
        })
      if (url.includes('/workers/scripts/opencode-anthropic-relay'))
        return Response.json({ success: true, result: {} })
      return Response.json(
        { success: false, errors: [{ message: `unexpected ${url}` }] },
        { status: 500 },
      )
    }

    // The worker-name prompt returns '' (→ default name); no other prompt fires
    // because the injected fetch returns a workers.dev subdomain.
    const promptAnswers: Record<string, string> = {
      'Worker name [opencode-anthropic-relay]: ': '',
    }
    const askedPrompts: string[] = []
    const prompt = async (message: string) => {
      askedPrompts.push(message)
      return promptAnswers[message] ?? ''
    }

    const prevFile = process.env.OPENCODE_ANTHROPIC_AUTH_FILE
    const prevToken = process.env.CLOUDFLARE_API_TOKEN
    const prevAccount = process.env.CLOUDFLARE_ACCOUNT_ID
    process.env.OPENCODE_ANTHROPIC_AUTH_FILE = accountPath
    process.env.CLOUDFLARE_API_TOKEN = 'cf-token'
    process.env.CLOUDFLARE_ACCOUNT_ID = 'account-id'
    try {
      await relaySetup({ fetchImpl, prompt })
    } finally {
      if (prevFile === undefined)
        delete process.env.OPENCODE_ANTHROPIC_AUTH_FILE
      else process.env.OPENCODE_ANTHROPIC_AUTH_FILE = prevFile
      if (prevToken === undefined) delete process.env.CLOUDFLARE_API_TOKEN
      else process.env.CLOUDFLARE_API_TOKEN = prevToken
      if (prevAccount === undefined) delete process.env.CLOUDFLARE_ACCOUNT_ID
      else process.env.CLOUDFLARE_ACCOUNT_ID = prevAccount
    }

    // Token + account come from env, so the only prompt is the worker name.
    expect(askedPrompts).toEqual(['Worker name [opencode-anthropic-relay]: '])

    const storage = JSON.parse(await readFile(accountPath, 'utf8'))
    expect(storage.relay).toMatchObject({
      enabled: true,
      url: 'https://opencode-anthropic-relay.user-subdomain.workers.dev',
      fallbackToDirect: true,
      transport: 'http',
    })
    expect(storage.relay.token).toBeString()
    expect(
      storage.accounts.map((account: { id: string }) => account.id),
    ).toEqual(['added-during-relay'])

    expect(calls).toHaveLength(4)
    expect(calls.map((c) => `${c.method ?? 'GET'} ${c.url}`)).toEqual([
      'POST https://api.cloudflare.com/client/v4/accounts/account-id/storage/kv/namespaces',
      'PUT https://api.cloudflare.com/client/v4/accounts/account-id/workers/scripts/opencode-anthropic-relay',
      'POST https://api.cloudflare.com/client/v4/accounts/account-id/workers/scripts/opencode-anthropic-relay/subdomain',
      'GET https://api.cloudflare.com/client/v4/accounts/account-id/workers/subdomain',
    ])
  })
})
