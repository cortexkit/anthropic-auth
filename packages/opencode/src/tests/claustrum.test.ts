import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type AccountStorage,
  detectClaustrumConnection,
  executeAccountCommand,
  getDefaultClaustrumConnectionPath,
  type OAuthAccount,
  readCustodyHandles,
  resolveCustodyHandle,
  resolveCustodyHandlesPath,
  saveAccounts,
} from '@cortexkit/anthropic-auth-core'
import { loadGoldenCustodyManifest } from './custody-handle-manifest.fixture.ts'

let tempDir: string
let accountPath: string

const baseStorage = (): AccountStorage => ({
  version: 1,
  main: { type: 'opencode', provider: 'anthropic' },
  accounts: [
    {
      id: 'account-a',
      type: 'oauth',
      refresh: 'refresh-a',
      enabled: true,
    },
    {
      id: 'account-b',
      type: 'oauth',
      refresh: 'refresh-b',
      enabled: true,
    },
  ],
})

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'anthropic-auth-claustrum-'))
  accountPath = join(tempDir, 'anthropic-auth.json')
})

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true })
})

describe('Claustrum connection detection', () => {
  test('reports an available connection without projecting its bearer key', async () => {
    const path = join(tempDir, 'subc-connection.json')
    await writeFile(
      path,
      JSON.stringify({
        schema: 1,
        wire_version: 2,
        key: 'bearer-secret',
        endpoints: [
          { host: '127.0.0.1', port: 8757 },
          { host: '[::1]', port: 8757 },
        ],
      }),
    )

    const result = await detectClaustrumConnection(path)

    expect(result).toEqual({
      status: 'available',
      schema: 1,
      wireVersion: 2,
      endpoints: [
        { host: '127.0.0.1', port: 8757 },
        { host: '[::1]', port: 8757 },
      ],
    })
    expect(JSON.stringify(result)).not.toContain('bearer-secret')
    expect('key' in result).toBe(false)
  })

  test('reports an absent connection file distinctly', async () => {
    const result = await detectClaustrumConnection(
      join(tempDir, 'missing.json'),
    )

    expect(result.status).toBe('absent')
  })

  test('reports an unreadable connection file without parser text', async () => {
    const path = join(tempDir, 'unreadable.json')
    await writeFile(path, '{}')
    await chmod(path, 0o000)

    const result = await detectClaustrumConnection(path)

    expect(result.status).toBe('malformed')
    expect(result).toMatchObject({ reason: 'unreadable (EACCES)' })
    expect(JSON.stringify(result)).not.toContain('invalid JSON')
  })

  test('reports malformed JSON and invalid shape distinctly from absence', async () => {
    const path = join(tempDir, 'malformed.json')
    await writeFile(path, '{"schema":1,"wire_version":"2"}')

    const result = await detectClaustrumConnection(path)

    expect(result.status).toBe('malformed')
  })

  test('does not expose parser text from malformed secret-bearing JSON', async () => {
    const path = join(tempDir, 'secret-bearing-malformed.json')
    const canary = 'CANARYSECRET'
    await writeFile(path, `{"schema":1,"key":ckh_${canary}}`)

    const result = await detectClaustrumConnection(path)

    expect(result.status).toBe('malformed')
    expect(JSON.stringify(result)).not.toContain(canary)
  })

  test('rejects an empty endpoint list as malformed', async () => {
    const path = join(tempDir, 'empty-endpoints.json')
    await writeFile(
      path,
      JSON.stringify({ schema: 1, wire_version: 2, endpoints: [] }),
    )

    const result = await detectClaustrumConnection(path)

    expect(result.status).toBe('malformed')
  })

  test('rejects an endpoint with an invalid port as malformed', async () => {
    const path = join(tempDir, 'invalid-endpoint.json')
    await writeFile(
      path,
      JSON.stringify({
        schema: 1,
        wire_version: 2,
        endpoints: [{ host: '127.0.0.1', port: '8757' }],
      }),
    )

    const result = await detectClaustrumConnection(path)

    expect(result.status).toBe('malformed')
  })

  test('reads the explicitly configured connection path', async () => {
    const configuredPath = join(tempDir, 'configured.json')
    await writeFile(
      configuredPath,
      JSON.stringify({
        schema: 7,
        wire_version: 9,
        endpoints: [{ host: 'vault.test', port: 1234 }],
      }),
    )

    const result = await detectClaustrumConnection(configuredPath)

    expect(result).toEqual({
      status: 'available',
      schema: 7,
      wireVersion: 9,
      endpoints: [{ host: 'vault.test', port: 1234 }],
    })
  })

  test('derives the default connection path from the current uid', async () => {
    const originalGetuid = process.getuid
    Object.defineProperty(process, 'getuid', { value: () => 4242 })
    try {
      expect(getDefaultClaustrumConnectionPath()).toBe(
        '/run/user/4242/subc-connection.json',
      )
    } finally {
      Object.defineProperty(process, 'getuid', { value: originalGetuid })
    }
  })
})

describe('custody handle resolution', () => {
  const account = (input: Partial<OAuthAccount> = {}): OAuthAccount => ({
    id: 'uuid-not-a-label',
    type: 'oauth',
    refresh: 'refresh-token',
    ...input,
  })

  test('resolves configured, environment, and XDG custody handle paths in order', () => {
    expect(
      resolveCustodyHandlesPath(
        { handlesFile: '  /configured/handles.json  ' },
        {
          CLAUSTRUM_OPENCODE_HANDLES: '/environment/handles.json',
          XDG_CONFIG_HOME: '/xdg',
          HOME: '/home/tester',
        },
      ),
    ).toBe('/configured/handles.json')
    expect(
      resolveCustodyHandlesPath(undefined, {
        CLAUSTRUM_OPENCODE_HANDLES: '/environment/handles.json',
        XDG_CONFIG_HOME: '/xdg',
        HOME: '/home/tester',
      }),
    ).toBe('/environment/handles.json')
    expect(
      resolveCustodyHandlesPath(undefined, {
        CLAUSTRUM_OPENCODE_HANDLES: 'relative/handles.json',
        XDG_CONFIG_HOME: '/xdg',
        HOME: '/home/tester',
      }),
    ).toBe('/xdg/cortexkit/opencode-handles.json')
    expect(resolveCustodyHandlesPath(undefined, { HOME: '/home/tester' })).toBe(
      '/home/tester/.config/cortexkit/opencode-handles.json',
    )
  })

  test('matches the golden manifest by account label rather than UUID', async () => {
    const { manifest: golden } = await loadGoldenCustodyManifest()
    const parsed = readCustodyHandles(golden, 'anthropic', 'anthropic-auth')
    const manifest = {
      version: 1 as const,
      provider: 'anthropic' as const,
      serve: 'anthropic-auth' as const,
      accounts: parsed.accounts,
      superseded: parsed.superseded,
    }
    const entry = manifest.accounts[0]
    if (!entry) throw new Error('golden manifest has no anthropic account')

    const result = resolveCustodyHandle({
      account: account({ label: entry.label }),
      manifest,
    })

    expect(result.status).toBe('resolved')
    if (result.status !== 'resolved')
      throw new Error('expected resolved handle')
    expect(result.source).toBe('manifest')
  })
})

describe('account status Claustrum surface', () => {
  test('reports the global mode and projected vault binding', async () => {
    const result = await executeAccountCommand({
      argumentsText: '',
      storage: {
        ...baseStorage(),
        claustrum: { mode: 'claustrum' },
      },
      claustrum: {
        status: 'available',
        schema: 1,
        wireVersion: 2,
        endpoints: [{ host: '127.0.0.1', port: 8757 }],
      },
      statusProjection: {
        claustrumDetection: 'available',
        accounts: [
          {
            id: 'main',
            label: 'OpenCode anthropic',
            role: 'main',
            enabled: true,
            quotaPercent: null,
            claustrumGate: 'na',
            vaultServed: false,
            vaultReauth: false,
            custodyState: 'na',
          },
          {
            id: 'account-a',
            label: 'account-a',
            role: 'fallback',
            enabled: true,
            quotaPercent: null,
            claustrumGate: 'on',
            vaultServed: false,
            vaultReauth: false,
            custodyState: 'on-cold',
          },
          {
            id: 'account-b',
            label: 'account-b',
            role: 'fallback',
            enabled: true,
            quotaPercent: null,
            claustrumGate: 'off',
            vaultServed: false,
            vaultReauth: false,
            custodyState: 'off',
          },
        ],
      },
    })

    expect(result.text).toContain('Custody mode: claustrum')
    expect(result.text).toContain('Claustrum: available')
    expect(result.text).toContain('account-a')
    expect(result.text).toContain('vault-bound')
    expect(result.text).toContain('account-b')
    expect(result.text).toContain('local')
  })
})

test('saving the gate persists only configuration and never introduces bearer material', async () => {
  await saveAccounts(
    {
      ...baseStorage(),
      claustrum: { accounts: { 'account-a': { enabled: true } } },
    },
    accountPath,
  )

  const config = await readFile(accountPath, 'utf8')

  expect(JSON.parse(config).claustrum).toEqual({
    accounts: { 'account-a': { enabled: true } },
  })
  expect(config).not.toContain('key')
})
