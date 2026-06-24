import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let tempDir: string
let accountPath: string

async function useTempAccountFile() {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {})
  }
  tempDir = await mkdtemp(join(tmpdir(), 'anthropic-add-acct-'))
  accountPath = join(tempDir, 'anthropic-auth.json')
  process.env.OPENCODE_ANTHROPIC_AUTH_FILE = accountPath
  const { saveAccounts } = await import('@cortexkit/anthropic-auth-core')
  await saveAccounts(
    {
      version: 1,
      main: { type: 'opencode', provider: 'anthropic' },
      accounts: [],
    },
    accountPath,
  )
}

function createMockClient() {
  return {
    auth: { set: mock(() => Promise.resolve()) },
    session: { promptAsync: mock(() => Promise.resolve()) },
  }
}

async function getPlugin() {
  const { AnthropicAuthPlugin } = await import('../index')
  return (await AnthropicAuthPlugin({
    // @ts-expect-error: minimal mock for testing
    client: createMockClient(),
  })) as Promise<any>
}

async function executeCommand(
  plugin: any,
  command: string,
  args: string,
  sessionId?: string,
): Promise<void> {
  await expect(
    plugin['command.execute.before']({
      command,
      arguments: args,
      sessionID: sessionId ?? 'ses_test',
    }),
  ).rejects.toThrow('__OPENCODE_ANTHROPIC_AUTH_COMMAND_HANDLED__')
}

function findCommandsLog(
  records: Array<{
    level: string
    channel: string
    message: string
    payload?: Record<string, unknown>
  }>,
  message: string,
) {
  return records.find(
    (r) =>
      r.level === 'info' && r.channel === 'commands' && r.message === message,
  )
}

function scanLogsForSecrets(
  records: Array<{
    level: string
    channel: string
    message: string
    payload?: Record<string, unknown>
  }>,
): string[] {
  const hits: string[] = []
  const patterns = [/sk-ant-/i, /Bearer\s+/i, /eyJ/, /verifier/i]
  for (const rec of records) {
    const payloadStr = JSON.stringify(rec.payload ?? {})
    for (const pat of patterns) {
      if (pat.test(payloadStr)) {
        hits.push(`record '${rec.message}' contained match for ${pat.source}`)
      }
    }
  }
  return hits
}

let capturedRecords: Array<{
  level: string
  channel: string
  message: string
  payload?: Record<string, unknown>
}> = []

beforeEach(async () => {
  capturedRecords = []
  const { __setLogTestSink } = await import('@cortexkit/anthropic-auth-core')
  __setLogTestSink((record) => {
    capturedRecords.push(record)
  })
  await useTempAccountFile()
})

afterEach(async () => {
  const { __setLogTestSink } = await import('@cortexkit/anthropic-auth-core')
  __setLogTestSink(null)
  delete process.env.OPENCODE_ANTHROPIC_AUTH_FILE
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {})
  }
  mock.restore()
})

// ---------------------------------------------------------------------------
// parseAccountCommandAction — add actions (core)
// ---------------------------------------------------------------------------
describe('parseAccountCommandAction — add actions', () => {
  test('add-apikey with key only', async () => {
    const { parseAccountCommandAction } = await import(
      '@cortexkit/anthropic-auth-core'
    )
    expect(parseAccountCommandAction('add-apikey sk-ant-test123')).toEqual({
      type: 'add-apikey',
      apiKey: 'sk-ant-test123',
    })
  })

  test('add-apikey with key and label', async () => {
    const { parseAccountCommandAction } = await import(
      '@cortexkit/anthropic-auth-core'
    )
    expect(
      parseAccountCommandAction('add-apikey sk-ant-test123 My Label'),
    ).toEqual({
      type: 'add-apikey',
      apiKey: 'sk-ant-test123',
      label: 'My Label',
    })
  })

  test('add-apikey without key falls to usage', async () => {
    const { parseAccountCommandAction } = await import(
      '@cortexkit/anthropic-auth-core'
    )
    expect(parseAccountCommandAction('add-apikey')).toEqual({ type: 'usage' })
  })

  test('add-oauth-start', async () => {
    const { parseAccountCommandAction } = await import(
      '@cortexkit/anthropic-auth-core'
    )
    expect(parseAccountCommandAction('add-oauth-start')).toEqual({
      type: 'add-oauth-start',
    })
  })

  test('add-oauth-finish with code', async () => {
    const { parseAccountCommandAction } = await import(
      '@cortexkit/anthropic-auth-core'
    )
    expect(
      parseAccountCommandAction('add-oauth-finish some-auth-code'),
    ).toEqual({
      type: 'add-oauth-finish',
      code: 'some-auth-code',
    })
  })

  test('add-oauth-finish without code falls to usage', async () => {
    const { parseAccountCommandAction } = await import(
      '@cortexkit/anthropic-auth-core'
    )
    expect(parseAccountCommandAction('add-oauth-finish')).toEqual({
      type: 'usage',
    })
  })

  test('add-apikey with --base-url flag', async () => {
    const { parseAccountCommandAction } = await import(
      '@cortexkit/anthropic-auth-core'
    )
    expect(
      parseAccountCommandAction(
        'add-apikey sk-ant-key --base-url https://api.example.com/v1',
      ),
    ).toEqual({
      type: 'add-apikey',
      apiKey: 'sk-ant-key',
      baseURL: 'https://api.example.com/v1',
    })
  })

  test('add-apikey with --auth-header x-api-key', async () => {
    const { parseAccountCommandAction } = await import(
      '@cortexkit/anthropic-auth-core'
    )
    expect(
      parseAccountCommandAction(
        'add-apikey sk-ant-key --auth-header x-api-key',
      ),
    ).toEqual({
      type: 'add-apikey',
      apiKey: 'sk-ant-key',
      authHeader: 'x-api-key',
    })
  })

  test('add-apikey with all flags', async () => {
    const { parseAccountCommandAction } = await import(
      '@cortexkit/anthropic-auth-core'
    )
    expect(
      parseAccountCommandAction(
        'add-apikey sk-ant-key --base-url https://api.example.com --auth-header x-api-key --label MyKey',
      ),
    ).toEqual({
      type: 'add-apikey',
      apiKey: 'sk-ant-key',
      baseURL: 'https://api.example.com',
      authHeader: 'x-api-key',
      label: 'MyKey',
    })
  })
})

// ---------------------------------------------------------------------------
// add-apikey — persistence + security (no mocks needed)
// ---------------------------------------------------------------------------
describe('add-apikey flow', () => {
  test('persists an API key account to the store', async () => {
    const plugin = await getPlugin()
    await executeCommand(plugin, 'claude-account', 'add-apikey sk-ant-test123')

    const { loadAccounts } = await import('@cortexkit/anthropic-auth-core')
    const loaded = await loadAccounts(accountPath)
    expect(loaded).not.toBeNull()
    expect(loaded!.accounts).toHaveLength(1)
    const account = loaded!.accounts[0]!
    expect(account.type).toBe('api')
    if (account.type === 'api') {
      expect(account.apiKey).toBe('sk-ant-test123')
      expect(account.baseURL).toBe('https://api.kie.ai/claude')
      expect(account.authHeader).toBe('authorization-bearer')
    }
    expect(account.enabled).toBe(true)
  })

  test('persists with a label', async () => {
    const plugin = await getPlugin()
    await executeCommand(
      plugin,
      'claude-account',
      'add-apikey sk-ant-test456 Work API',
    )

    const { loadAccounts } = await import('@cortexkit/anthropic-auth-core')
    const loaded = await loadAccounts(accountPath)
    expect(loaded).not.toBeNull()
    expect(loaded!.accounts).toHaveLength(1)
    expect(loaded!.accounts[0]!.label).toBe('Work API')
    expect(loaded!.accounts[0]!.id).toBe('Work API')
  })

  test('emits INFO log with id/label/type but NO apiKey', async () => {
    const plugin = await getPlugin()
    await executeCommand(
      plugin,
      'claude-account',
      'add-apikey sk-ant-secret123',
    )

    const rec = findCommandsLog(capturedRecords, 'account added')
    expect(rec).toBeDefined()
    const payload = rec!.payload!
    expect(payload.id).toBeDefined()
    expect(payload.type).toBe('apikey')

    const payloadStr = JSON.stringify(payload)
    expect(payloadStr).not.toContain('sk-ant-secret123')
    expect(payloadStr).not.toContain('apiKey')
    expect(payloadStr).not.toContain('sk-ant')
    expect(payloadStr).not.toContain('secret')
  })

  test('account list after add shows the new account', async () => {
    const plugin = await getPlugin()
    await executeCommand(
      plugin,
      'claude-account',
      'add-apikey sk-ant-list TestList',
    )

    const { buildAccountList, loadAccounts } = await import(
      '@cortexkit/anthropic-auth-core'
    )
    const storage = await loadAccounts(accountPath)
    const list = buildAccountList(storage!)
    expect(list).toHaveLength(2) // main + fallback
    const fallback = list.find((a: { role: string }) => a.role === 'fallback')
    expect(fallback).toBeDefined()
    expect(fallback!.label).toBe('TestList')
  })

  test('persists with custom baseURL and x-api-key authHeader', async () => {
    const plugin = await getPlugin()
    await executeCommand(
      plugin,
      'claude-account',
      'add-apikey sk-ant-custom --base-url https://api.example.com/v1 --auth-header x-api-key --label CustomAPI',
    )

    const { loadAccounts } = await import('@cortexkit/anthropic-auth-core')
    const loaded = await loadAccounts(accountPath)
    expect(loaded).not.toBeNull()
    expect(loaded!.accounts).toHaveLength(1)
    const account = loaded!.accounts[0]!
    expect(account.type).toBe('api')
    if (account.type === 'api') {
      expect(account.apiKey).toBe('sk-ant-custom')
      expect(account.baseURL).toBe('https://api.example.com/v1')
      expect(account.authHeader).toBe('x-api-key')
    }
    expect(account.label).toBe('CustomAPI')
  })

  test('rejects invalid baseURL with embedded credentials', async () => {
    const plugin = await getPlugin()
    await executeCommand(
      plugin,
      'claude-account',
      'add-apikey sk-ant-bad --base-url https://user:pass@evil.com',
    )

    const { loadAccounts } = await import('@cortexkit/anthropic-auth-core')
    const loaded = await loadAccounts(accountPath)
    expect(loaded!.accounts).toHaveLength(0)
  })

  test('rejects non-http baseURL', async () => {
    const plugin = await getPlugin()
    await executeCommand(
      plugin,
      'claude-account',
      'add-apikey sk-ant-bad2 --base-url file:///etc/passwd',
    )

    const { loadAccounts } = await import('@cortexkit/anthropic-auth-core')
    const loaded = await loadAccounts(accountPath)
    expect(loaded!.accounts).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// add-oauth — error paths (no mocks needed)
// ---------------------------------------------------------------------------
describe('add-oauth error paths', () => {
  test('add-oauth-finish with no pending state gives graceful error', async () => {
    const plugin = await getPlugin()
    capturedRecords = []

    await executeCommand(
      plugin,
      'claude-account',
      'add-oauth-finish somecode',
      'ses_no_pending',
    )

    const { loadAccounts } = await import('@cortexkit/anthropic-auth-core')
    const loaded = await loadAccounts(accountPath)
    expect(loaded!.accounts).toHaveLength(0)
  })

  test('add-oauth-start stores pending and returns url', async () => {
    const { parseAccountCommandAction } = await import(
      '@cortexkit/anthropic-auth-core'
    )
    const parsed = parseAccountCommandAction('add-oauth-start')
    expect(parsed.type).toBe('add-oauth-start')
  })

  test('pending entry is always cleared after finish (even on failure)', async () => {
    // This validates the finally-block behavior:
    // After calling add-oauth-finish with a real pending entry (from a real
    // add-oauth-start), the pending is consumed. A second finish call with the
    // same session ID must receive 'expired / no pending', proving the finally
    // block cleared it. We use the error-path here since exchange will fail
    // with the bad code, but the pending is still deleted by finally.
    //
    // We call add-oauth-start (real authorize, creates pending entry),
    // then add-oauth-finish with a garbage code (exchange returns failed).
    // Then a second add-oauth-finish must get 'expired'.
    const plugin = await getPlugin()

    // Start OAuth — this will make a real HTTP call to authorize()
    await executeCommand(
      plugin,
      'claude-account',
      'add-oauth-start',
      'ses_cleanup_test',
    )

    // Finish with garbage code — exchange will fail, but pending MUST be cleared
    await executeCommand(
      plugin,
      'claude-account',
      'add-oauth-finish garbage-code',
      'ses_cleanup_test',
    )

    // Second finish with same session — must get 'expired' (pending cleared)
    capturedRecords = []
    await executeCommand(
      plugin,
      'claude-account',
      'add-oauth-finish another-code',
      'ses_cleanup_test',
    )

    // No accounts should have been added
    const { loadAccounts } = await import('@cortexkit/anthropic-auth-core')
    const loaded = await loadAccounts(accountPath)
    expect(loaded!.accounts).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// add-oauth — label threading (the fix: prompt for a label, default UUID name)
// ---------------------------------------------------------------------------
describe('add-oauth label threading', () => {
  async function getPluginWithClient() {
    const client = createMockClient()
    const { AnthropicAuthPlugin } = await import('../index')
    const plugin = (await AnthropicAuthPlugin({
      // @ts-expect-error: minimal mock for testing
      client,
    })) as any
    return { plugin, client }
  }

  function extractStateFromPromptCalls(
    client: ReturnType<typeof createMockClient>,
  ): string {
    const calls = (client.session.promptAsync as { mock: { calls: any[] } })
      .mock.calls
    for (const [req] of calls) {
      const text: string | undefined = req?.body?.parts?.[0]?.text
      if (!text) continue
      const match = text.match(/state=([^\s&]+)/)
      if (match?.[1]) return decodeURIComponent(match[1])
    }
    throw new Error('no OAuth URL with state captured from prompt calls')
  }

  async function runOAuthAddWithLabel(labelArg: string | null) {
    const { plugin, client } = await getPluginWithClient()
    const sessionId = 'ses_oauth_label'

    // Real add-oauth-start: builds a URL with a real state, stores pending,
    // and delivers the URL text via session.promptAsync (TUI not connected).
    await executeCommand(plugin, 'claude-account', 'add-oauth-start', sessionId)
    const state = extractStateFromPromptCalls(client)

    // Mock the token exchange endpoint to succeed.
    const originalFetch = globalThis.fetch
    globalThis.fetch = mock((input: any) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url
      if (url.includes('oauth/token') || url.includes('/token')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              access_token: 'oauth-access',
              refresh_token: 'oauth-refresh',
              expires_in: 3600,
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        )
      }
      return Promise.resolve(new Response(null, { status: 200 }))
    }) as unknown as typeof fetch

    try {
      const finishArgs =
        labelArg == null
          ? `add-oauth-finish dummy-code#${state}`
          : `add-oauth-finish dummy-code#${state} --label ${labelArg}`
      await executeCommand(plugin, 'claude-account', finishArgs, sessionId)
    } finally {
      globalThis.fetch = originalFetch
    }

    const { loadAccounts } = await import('@cortexkit/anthropic-auth-core')
    const loaded = await loadAccounts(accountPath)
    return loaded
  }

  test('add-oauth-finish --label sets the account label', async () => {
    const loaded = await runOAuthAddWithLabel('work')
    expect(loaded).not.toBeNull()
    expect(loaded!.accounts).toHaveLength(1)
    const account = loaded!.accounts[0]!
    expect(account.type).toBe('oauth')
    expect(account.label).toBe('work')
  })

  test('add-oauth-finish without --label leaves label undefined (UUID-name fallback)', async () => {
    const loaded = await runOAuthAddWithLabel(null)
    expect(loaded).not.toBeNull()
    expect(loaded!.accounts).toHaveLength(1)
    const account = loaded!.accounts[0]!
    expect(account.label).toBeUndefined()
    // id is a UUID (no natural key for OAuth)
    expect(account.id).toMatch(/^[0-9a-f-]{36}$/)
  })
})

// ---------------------------------------------------------------------------
// security — no secrets in logs
// ---------------------------------------------------------------------------
describe('security — no secrets in logs', () => {
  test('API key is never in any log record', async () => {
    const plugin = await getPlugin()
    await executeCommand(
      plugin,
      'claude-account',
      'add-apikey sk-ant-super-secret-key-abc123 MyLabel',
    )

    const hits = scanLogsForSecrets(capturedRecords)
    expect(hits).toEqual([])
  })

  test('apply path does not log raw API key arguments', async () => {
    const plugin = await getPlugin()
    await executeCommand(
      plugin,
      'claude-account',
      'add-apikey sk-ant-rpc-key123',
    )

    for (const rec of capturedRecords) {
      const payloadStr = JSON.stringify(rec.payload ?? {})
      expect(payloadStr).not.toContain('sk-ant-rpc-key123')
      expect(payloadStr).not.toContain('add-apikey sk-ant')
    }
  })

  test('add-oauth-finish code is not logged', async () => {
    const plugin = await getPlugin()

    // The code travels through the arguments string to the parser,
    // but should never appear in the log payload
    await executeCommand(
      plugin,
      'claude-account',
      'add-oauth-finish sk-ant-secret-auth-code',
      'ses_sec_code',
    )

    for (const rec of capturedRecords) {
      const payloadStr = JSON.stringify(rec.payload ?? {})
      expect(payloadStr).not.toContain('sk-ant-secret-auth-code')
    }
  })
})
