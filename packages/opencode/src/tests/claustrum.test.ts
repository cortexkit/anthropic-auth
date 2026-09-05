import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type AccountStorage,
  detectClaustrumConnection,
  executeAccountCommand,
  getDefaultClaustrumConnectionPath,
  isClaustrumEnabledForAccount,
  loadAccounts,
  type OAuthAccount,
  readCustodyHandles,
  resolveCustodyHandle,
  resolveCustodyHandlesPath,
  saveAccounts,
  setClaustrumAccountGatePersistent,
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

describe('per-account Claustrum gate', () => {
  test('preserves a path-only handlesFile configuration through normalization', async () => {
    await writeFile(
      accountPath,
      JSON.stringify({
        ...baseStorage(),
        claustrum: { handlesFile: '  /tmp/custody-handles.json  ' },
      }),
    )

    const storage = await loadAccounts(accountPath)

    expect(storage?.claustrum).toEqual({
      handlesFile: '/tmp/custody-handles.json',
    })
    await saveAccounts(storage!, accountPath)
    expect(JSON.parse(await readFile(accountPath, 'utf8')).claustrum).toEqual({
      handlesFile: '/tmp/custody-handles.json',
    })
  })

  test('defaults off when config is absent', async () => {
    await saveAccounts(baseStorage(), accountPath)

    const storage = await loadAccounts(accountPath)

    expect(isClaustrumEnabledForAccount(storage!, 'account-a')).toBe(false)
  })

  test('defaults off when the gate config is malformed', async () => {
    await writeFile(
      accountPath,
      JSON.stringify({ ...baseStorage(), claustrum: 'on' }),
    )

    const storage = await loadAccounts(accountPath)

    expect(isClaustrumEnabledForAccount(storage!, 'account-a')).toBe(false)
  })

  test('keeps gate state independent for each account', async () => {
    await saveAccounts(
      {
        ...baseStorage(),
        claustrum: {
          accounts: {
            'account-a': { enabled: true },
            'account-b': { enabled: false },
          },
        },
      },
      accountPath,
    )

    const storage = await loadAccounts(accountPath)

    expect(isClaustrumEnabledForAccount(storage!, 'account-a')).toBe(true)
    expect(isClaustrumEnabledForAccount(storage!, 'account-b')).toBe(false)
  })

  test('loads the current storage before enabling an account gate', async () => {
    await saveAccounts(baseStorage(), accountPath)

    const result = await setClaustrumAccountGatePersistent({
      id: 'account-a',
      enabled: true,
      path: accountPath,
    })
    const storage = await loadAccounts(accountPath)

    expect(result).toBe('updated')
    expect(isClaustrumEnabledForAccount(storage!, 'account-a')).toBe(true)
  })

  test('disables an enabled account gate', async () => {
    await saveAccounts(
      {
        ...baseStorage(),
        claustrum: { accounts: { 'account-a': { enabled: true } } },
      },
      accountPath,
    )

    const result = await setClaustrumAccountGatePersistent({
      id: 'account-a',
      enabled: false,
      path: accountPath,
    })
    const storage = await loadAccounts(accountPath)

    expect(result).toBe('updated')
    expect(isClaustrumEnabledForAccount(storage!, 'account-a')).toBe(false)
  })

  test('preserves another account gate while changing the target', async () => {
    await saveAccounts(
      {
        ...baseStorage(),
        claustrum: {
          accounts: {
            'account-a': { enabled: true },
            'account-b': { enabled: true },
          },
        },
      },
      accountPath,
    )

    await setClaustrumAccountGatePersistent({
      id: 'account-a',
      enabled: false,
      path: accountPath,
    })
    const storage = await loadAccounts(accountPath)

    expect(isClaustrumEnabledForAccount(storage!, 'account-a')).toBe(false)
    expect(isClaustrumEnabledForAccount(storage!, 'account-b')).toBe(true)
  })

  test('preserves concurrent gate mutations for different accounts', async () => {
    await saveAccounts(baseStorage(), accountPath)
    const coreModule = new URL('../../../core/dist/index.js', import.meta.url)
    const runMutation = (id: string) =>
      Bun.spawn([
        process.execPath,
        '--eval',
        `import { setClaustrumAccountGatePersistent } from ${JSON.stringify(coreModule.href)}; const result = await setClaustrumAccountGatePersistent({ id: ${JSON.stringify(id)}, enabled: true, path: ${JSON.stringify(accountPath)} }); if (result !== 'updated') process.exit(1);`,
      ])

    const first = runMutation('account-a')
    const second = runMutation('account-b')
    expect(await first.exited).toBe(0)
    expect(await second.exited).toBe(0)

    const storage = await loadAccounts(accountPath)
    expect(isClaustrumEnabledForAccount(storage!, 'account-a')).toBe(true)
    expect(isClaustrumEnabledForAccount(storage!, 'account-b')).toBe(true)
  })

  test('preserves unrelated top-level configuration', async () => {
    await writeFile(
      accountPath,
      JSON.stringify({ ...baseStorage(), custom: { retain: true } }),
    )

    await setClaustrumAccountGatePersistent({
      id: 'account-a',
      enabled: true,
      path: accountPath,
    })
    const config = JSON.parse(await readFile(accountPath, 'utf8'))

    expect(config.custom).toEqual({ retain: true })
  })

  test('does not write a missing account gate', async () => {
    await saveAccounts(baseStorage(), accountPath)
    const before = await readFile(accountPath, 'utf8')
    const beforeStat = await stat(accountPath)

    const result = await setClaustrumAccountGatePersistent({
      id: 'missing',
      enabled: true,
      path: accountPath,
    })
    const after = await readFile(accountPath, 'utf8')
    const afterStat = await stat(accountPath)

    expect(result).toBe('missing')
    expect(after).toBe(before)
    expect(afterStat.mtimeMs).toBe(beforeStat.mtimeMs)
  })

  test('does not write or create an entry when disabling an already-off gate', async () => {
    await saveAccounts(baseStorage(), accountPath)
    const before = await readFile(accountPath, 'utf8')
    const beforeStat = await stat(accountPath)

    const result = await setClaustrumAccountGatePersistent({
      id: 'account-a',
      enabled: false,
      path: accountPath,
    })
    const after = await readFile(accountPath, 'utf8')
    const afterStat = await stat(accountPath)

    expect(result).toBe('unchanged')
    expect(after).toBe(before)
    expect(afterStat.mtimeMs).toBe(beforeStat.mtimeMs)
    expect(JSON.parse(after).claustrum).toBeUndefined()
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
  test('reports detection and each account gate without changing account behavior', async () => {
    const result = await executeAccountCommand({
      argumentsText: '',
      storage: {
        ...baseStorage(),
        claustrum: {
          accounts: { 'account-a': { enabled: true } },
        },
      },
      claustrum: {
        status: 'available',
        schema: 1,
        wireVersion: 2,
        endpoints: [{ host: '127.0.0.1', port: 8757 }],
      },
    })

    expect(result.text).toContain('Claustrum: available')
    expect(result.text).toContain('account-a')
    expect(result.text).toContain('custody on · cold')
    expect(result.text).toContain('account-b')
    expect(result.text).toContain('custody off')
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
