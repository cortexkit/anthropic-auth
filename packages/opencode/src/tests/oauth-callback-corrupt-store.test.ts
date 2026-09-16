import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { AnthropicAuthPlugin } from '../index'
import { extractUrl, TOKEN_URL } from './test-fetch'

// House pattern: stub `globalThis.fetch` to answer `TOKEN_URL` with the
// exchange result the callback under test consumes. A previous revision of
// this test replaced the core module wholesale; Bun's runtime cannot undo
// that replacement from `afterAll`, so the stub leaked into later files in
// the same process and answered another suite's exchange. The repo records
// the same lesson at `accounts.test.ts:6396` (Bun's `mock.restore()` does
// not undo a module-level replacement registered with the runtime's module
// mocking API). Stubbing `fetch` avoids the leak entirely — the real
// `exchange()` reads its result from the global fetch.
//
// Captured at module load (after `setup.ts` has installed the guarded fetch);
// restored after every test so the global `afterEach` in `setup.ts` never sees
// a leaked fetch mock and throws.
const originalFetch = globalThis.fetch

describe('OAuth exchange callback — corrupt account store between authorize() and callback()', () => {
  let tempDir: string
  let accountPath: string
  const previousEnv: Record<string, string | undefined> = {}

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'oauth-callback-corrupt-'))
    accountPath = join(tempDir, 'anthropic-auth.json')
    previousEnv.OPENCODE_ANTHROPIC_AUTH_FILE =
      process.env.OPENCODE_ANTHROPIC_AUTH_FILE
    process.env.OPENCODE_ANTHROPIC_AUTH_FILE = accountPath
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
    if (previousEnv.OPENCODE_ANTHROPIC_AUTH_FILE === undefined) {
      delete process.env.OPENCODE_ANTHROPIC_AUTH_FILE
    } else {
      process.env.OPENCODE_ANTHROPIC_AUTH_FILE =
        previousEnv.OPENCODE_ANTHROPIC_AUTH_FILE
    }
    globalThis.fetch = originalFetch
  })

  test('returns the exchanged credentials even when the account file is unreadable/malformed at callback time', async () => {
    // No file present yet — plugin init must succeed and authorize() must
    // pass its own loadAccounts-based claustrum-mode check (line ~8751).
    globalThis.fetch = mock((input: unknown) => {
      const url = extractUrl(input as string | URL | Request)
      if (url === TOKEN_URL) {
        return Promise.resolve(
          Response.json({
            access_token: 'exchanged-access',
            refresh_token: 'exchanged-refresh',
            expires_in: 3600,
          }),
        )
      }
      return Promise.resolve(new Response('{}', { status: 200 }))
    }) as unknown as typeof fetch

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
      {
        authorize: async () => ({
          url: 'https://example.com/oauth/authorize',
          verifier: 'test-verifier',
          redirectUri: 'https://example.com/callback',
          state: 'test-state',
        }),
        setInterval: mock(
          () => ({ unref() {} }) as unknown as ReturnType<typeof setInterval>,
        ) as unknown as typeof setInterval,
        clearInterval: mock(() => {}) as unknown as typeof clearInterval,
      },
    )) as any

    const method = plugin.auth.methods.find(
      (m: { label?: string }) => m.label === 'Claude Pro/Max',
    )
    expect(method).toBeDefined()
    const flow = await method.authorize()
    expect(flow.callback).toBeDefined()

    // Corrupt the account store AFTER authorize() returned its flow, but
    // BEFORE the user pastes their code. This is the re-login recovery
    // scenario the original bug describes: a partially-written or corrupt
    // file at the moment the callback reads it.
    await writeFile(accountPath, '{not valid json', 'utf8')

    // Discriminate the failure mode: the bug rejects the callback with the
    // loadAccounts error, which loses the exchanged credentials. The fix
    // must return the exchange result to the caller.
    const result = await flow.callback('code=user-code&state=test-state')

    expect(result).toBeDefined()
    expect(result.type).toBe('success')
    if (result.type === 'success') {
      expect(result.access).toBe('exchanged-access')
      expect(result.refresh).toBe('exchanged-refresh')
    }
  })
})
