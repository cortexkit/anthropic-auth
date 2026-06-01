import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

let tempDir: string

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'anthropic-cli-test-'))
})

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true })
})

describe('CLI login', () => {
  test('continues from label prompt to OAuth callback prompt and saves account', async () => {
    const accountPath = join(tempDir, 'anthropic-auth.json')
    const preloadPath = join(tempDir, 'preload.ts')

    await writeFile(
      preloadPath,
      `globalThis.fetch = async () => new Response(JSON.stringify({ access_token: 'cli-access', refresh_token: 'cli-refresh', expires_in: 3600 }), { status: 200 })\n`,
      'utf8',
    )

    const proc = Bun.spawn(
      ['bun', '--preload', preloadPath, 'src/cli.ts', 'login'],
      {
        cwd: packageRoot,
        env: {
          ...process.env,
          OPENCODE_ANTHROPIC_AUTH_FILE: accountPath,
        },
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )

    const reader = proc.stdout.getReader()
    const decoder = new TextDecoder()
    let stdout = ''
    let state: string | undefined

    proc.stdin.write('cli-label\n')

    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      stdout += decoder.decode(chunk.value, { stream: true })
      state = stdout.match(/[?&]state=([a-f0-9]+)/)?.[1]
      if (state) break
    }

    expect(state).toBeString()

    proc.stdin.write(
      `https://platform.claude.com/oauth/code/callback?code=cli-code&state=${state}\n`,
    )
    proc.stdin.end()

    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      stdout += decoder.decode(chunk.value, { stream: true })
    }

    const [exitCode, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stderr).text(),
    ])

    expect(stderr).toBe('')
    expect(exitCode).toBe(0)
    expect(stdout).toContain('Paste the full callback URL')
    expect(stdout).toContain('Saved fallback account "cli-label"')

    const storage = JSON.parse(await readFile(accountPath, 'utf8'))
    expect(storage.accounts).toHaveLength(1)
    expect(storage.accounts[0]).toMatchObject({
      id: 'cli-label',
      label: 'cli-label',
      access: 'cli-access',
      refresh: 'cli-refresh',
      enabled: true,
    })
  })

  test('re-login with same label clears stale errors and quota', async () => {
    const accountPath = join(tempDir, 'anthropic-auth.json')
    const preloadPath = join(tempDir, 'preload.ts')

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
    await writeFile(
      preloadPath,
      `globalThis.fetch = async () => new Response(JSON.stringify({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600 }), { status: 200 })\n`,
      'utf8',
    )

    const proc = Bun.spawn(
      ['bun', '--preload', preloadPath, 'src/cli.ts', 'login', 'cli-label'],
      {
        cwd: packageRoot,
        env: {
          ...process.env,
          OPENCODE_ANTHROPIC_AUTH_FILE: accountPath,
        },
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )

    const reader = proc.stdout.getReader()
    const decoder = new TextDecoder()
    let stdout = ''
    let state: string | undefined

    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      stdout += decoder.decode(chunk.value, { stream: true })
      state = stdout.match(/[?&]state=([a-f0-9]+)/)?.[1]
      if (state) break
    }

    expect(state).toBeString()

    proc.stdin.write(
      `https://platform.claude.com/oauth/code/callback?code=cli-code&state=${state}\n`,
    )
    proc.stdin.end()

    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      stdout += decoder.decode(chunk.value, { stream: true })
    }

    const [exitCode, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stderr).text(),
    ])

    expect(stderr).toBe('')
    expect(exitCode).toBe(0)

    const storage = JSON.parse(await readFile(accountPath, 'utf8'))
    expect(storage.accounts).toHaveLength(1)
    expect(storage.accounts[0]).toMatchObject({
      id: 'cli-label',
      label: 'cli-label',
      access: 'new-access',
      refresh: 'new-refresh',
      enabled: true,
      addedAt: 123,
    })
    expect(storage.accounts[0].quota).toBeUndefined()
    expect(storage.accounts[0].lastRefreshedAt).toBeUndefined()
    expect(storage.accounts[0].lastRefreshError).toBeUndefined()
    expect(storage.accounts[0].lastQuotaRefreshError).toBeUndefined()
  })
})

describe('CLI relay setup', () => {
  test('deploys worker resources and saves relay config', async () => {
    const accountPath = join(tempDir, 'anthropic-auth.json')
    const callsPath = join(tempDir, 'calls.jsonl')
    const preloadPath = join(tempDir, 'relay-preload.ts')

    await writeFile(
      preloadPath,
      `import { appendFileSync } from 'node:fs'
globalThis.fetch = async (input, init) => {
  const url = input.toString()
  appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify({ url, method: init?.method }) + '\\n')
  if (url.includes('/storage/kv/namespaces')) return Response.json({ success: true, result: { id: 'kv-id' } })
  if (url.includes('/workers/scripts/opencode-anthropic-relay/subdomain')) return Response.json({ success: true, result: { enabled: true } })
  if (url.includes('/workers/subdomain')) return Response.json({ success: true, result: { subdomain: 'user-subdomain' } })
  if (url.includes('/workers/scripts/opencode-anthropic-relay')) return Response.json({ success: true, result: {} })
  return Response.json({ success: false, errors: [{ message: 'unexpected ' + url }] }, { status: 500 })
}
`,
      'utf8',
    )

    const proc = Bun.spawn(
      ['bun', '--preload', preloadPath, 'src/cli.ts', 'relay', 'setup'],
      {
        cwd: packageRoot,
        env: {
          ...process.env,
          OPENCODE_ANTHROPIC_AUTH_FILE: accountPath,
          CLOUDFLARE_API_TOKEN: 'cf-token',
          CLOUDFLARE_ACCOUNT_ID: 'account-id',
        },
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )

    proc.stdin.write('\n')
    proc.stdin.end()

    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])

    expect(stderr).toBe('')
    expect(exitCode).toBe(0)
    expect(stdout).toContain('Relay enabled')

    const storage = JSON.parse(await readFile(accountPath, 'utf8'))
    expect(storage.relay).toMatchObject({
      enabled: true,
      url: 'https://opencode-anthropic-relay.user-subdomain.workers.dev',
      fallbackToDirect: true,
      transport: 'http',
    })
    expect(storage.relay.token).toBeString()

    const calls = (await readFile(callsPath, 'utf8')).trim().split('\n')
    expect(calls).toHaveLength(4)
  })
})
