import { afterEach, expect, test } from 'bun:test'
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openSettings } from '@cortexkit/common-auth/settings'
import { dumpDirectRequest, resetDumpState, setDumpEnabled } from '../dump.ts'
import {
  CLAUDE_GATEWAY_PROXY_REFUSAL,
  type ClaudeGateway,
  claudeGatewayModelUrl,
  claudeGatewayProxyApplies,
  claudeGatewaySecretValues,
  claudeGatewayStatusNotes,
  isGatewaySettingsFile,
  lookupGatewaySettingsFile,
  parseClaudeGateway,
  rememberClaudeGatewaySecrets,
} from '../gateway.ts'
import { __setLogTestSink, type LogTestRecord } from '../logger.ts'
import { createNativeRuntimeSettings } from '../native-runtime-settings.ts'
import {
  ANTHROPIC_OAUTH_ORIGIN_REFUSAL,
  createAnthropicOAuthFetch,
  createClaudeModelFetch,
  requireAnthropicOAuthOrigin,
} from '../oauth-origin.ts'
import { settingsDefinition } from '../settings-definition.ts'
import { openSettingsService } from '../settings-service.ts'

const SECRET = 'gw-header-secret-canary'
const originalFetch = globalThis.fetch
const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => {
  globalThis.fetch = originalFetch
  __setLogTestSink(null)
  for (const close of cleanup.splice(0).reverse()) await close()
})

function gateway(
  origin = 'https://gateway.example.test',
  pathPrefix = '/claude',
): ClaudeGateway {
  return { origin, pathPrefix, headers: [['x-gateway-key', SECRET]] }
}

test.each([
  ['https://gateway.example.test', 'https://gateway.example.test', ''],
  ['https://gateway.example.test/', 'https://gateway.example.test', ''],
  [
    'https://gateway.example.test:8443/team/claude/',
    'https://gateway.example.test:8443',
    '/team/claude',
  ],
  ['http://127.0.0.1:43123/claude', 'http://127.0.0.1:43123', '/claude'],
  ['http://localhost:8080', 'http://localhost:8080', ''],
  ['http://[::1]:8080/p', 'http://[::1]:8080', '/p'],
])('accepts the gateway URL %s', (raw, origin, pathPrefix) => {
  const parsed = parseClaudeGateway(raw, { 'X-Team': 'platform' })
  expect(parsed).toEqual({
    ok: true,
    gateway: { origin, pathPrefix, headers: [['x-team', 'platform']] },
  })
})

test.each([
  'gateway.example.test',
  '/relative/path',
  'http://gateway.example.test',
  'http://10.0.0.5:8080',
  'ftp://gateway.example.test',
  'ws://gateway.example.test',
  'https://user:pass@gateway.example.test',
  'https://user@gateway.example.test',
  'https://gateway.example.test/?',
  'https://gateway.example.test/claude?team=1',
  'https://gateway.example.test/#',
  'https://gateway.example.test/claude#top',
])('refuses the gateway URL %s', (raw) => {
  expect(parseClaudeGateway(raw, {})).toEqual({
    ok: false,
    problem: 'gateway_url',
  })
})

test.each<Record<string, string>>([
  { authorization: 'Bearer x' },
  { 'X-Api-Key': 'x' },
  { 'anthropic-beta': 'x' },
  { 'anthropic-version': 'x' },
  { 'content-length': '1' },
  { 'content-encoding': 'gzip' },
  { host: 'x' },
  { 'x-cortexkit-billing-lineage': 'x' },
  { 'x-session-affinity': 'x' },
  { 'bad header': 'x' },
  { '': 'x' },
  { 'x-split': 'a\r\nx-injected: b' },
  { 'X-Dup': 'a', 'x-dup': 'b' },
])('refuses the gateway headers %o, even without a URL', (headers) => {
  for (const url of ['', 'https://gateway.example.test'])
    expect(parseClaudeGateway(url, headers)).toEqual({
      ok: false,
      problem: 'gateway_headers',
    })
})

test('an empty gateway URL means no gateway', () => {
  expect(parseClaudeGateway('', { 'x-team': 'a' })).toEqual({
    ok: true,
    gateway: undefined,
  })
})

test('the origin check admits the gateway only inside its path prefix', () => {
  const options = { gateway: gateway() }
  for (const url of [
    'https://gateway.example.test/claude',
    'https://gateway.example.test/claude/v1/messages?beta=true',
    'https://api.anthropic.com/v1/messages',
  ])
    expect(() => requireAnthropicOAuthOrigin(url, options)).not.toThrow()
  for (const url of [
    'https://gateway.example.test/v1/messages',
    'https://gateway.example.test/claudex/v1/messages',
    'http://gateway.example.test/claude/v1/messages',
    'https://gateway.example.test:8443/claude/v1/messages',
    `https://u:${SECRET}@gateway.example.test/claude/v1/messages`,
    'https://other.example.test/claude/v1/messages',
  ])
    expect(() => requireAnthropicOAuthOrigin(url, options)).toThrow(
      ANTHROPIC_OAUTH_ORIGIN_REFUSAL,
    )
  // Without the gateway option the gateway is just another origin.
  expect(() =>
    requireAnthropicOAuthOrigin(
      'https://gateway.example.test/claude/v1/messages',
    ),
  ).toThrow(ANTHROPIC_OAUTH_ORIGIN_REFUSAL)
})

test('only a model request URL maps to the gateway', () => {
  const g = gateway()
  expect(
    claudeGatewayModelUrl('https://api.anthropic.com/v1/messages?beta=true', g)
      ?.href,
  ).toBe('https://gateway.example.test/claude/v1/messages?beta=true')
  expect(
    claudeGatewayModelUrl(
      'https://gateway.example.test/claude/v1/messages?beta=true',
      g,
    )?.href,
  ).toBe('https://gateway.example.test/claude/v1/messages?beta=true')
  // A provider base URL can put a path in front of the model path, and
  // repeated slashes are collapsed; the gateway path is always the same.
  for (const url of [
    'https://api.anthropic.com/extra/v1/messages?beta=true',
    'https://api.anthropic.com//v1//messages?beta=true',
    'https://api.anthropic.com/a/b/v1/messages?beta=true',
    'https://gateway.example.test/claude/extra/v1/messages?beta=true',
    // A versioned base URL such as https://api.anthropic.com/v2 yields
    // /v2/messages; it still goes to the gateway, never straight past it.
    'https://api.anthropic.com/v2/messages?beta=true',
    'https://api.anthropic.com/messages?beta=true',
    'https://api.anthropic.com/v1/messages/?beta=true',
  ])
    expect(claudeGatewayModelUrl(url, g)?.href).toBe(
      'https://gateway.example.test/claude/v1/messages?beta=true',
    )
  for (const url of [
    'https://api.anthropic.com/x/../v1/messages',
    'https://api.anthropic.com/./v1/messages',
    'https://api.anthropic.com/x/%2e%2e/v1/messages',
    'https://api.anthropic.com/v1/messages/count_tokens',
    'https://api.anthropic.com/v2/messages/count_tokens',
    'https://api.anthropic.com/v1/messages/batches',
    'https://api.anthropic.com/v1/foo-messages',
    'https://api.anthropic.com/api/oauth/usage',
    'https://api.anthropic.com/api/oauth/profile',
    'https://api.anthropic.com/v1/oauth/token',
    'https://console.anthropic.com/v1/oauth/token',
    'https://proxy.example.test/v1/messages',
    'http://api.anthropic.com/v1/messages',
  ])
    expect(claudeGatewayModelUrl(url, g)).toBeUndefined()
})

function recordFetch() {
  const seen: {
    url: string
    method: string
    headers: Headers
    body: string
    redirect: string
  }[] = []
  globalThis.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const request =
        input instanceof Request
          ? new Request(input, init)
          : new Request(String(input), init)
      seen.push({
        url: request.url,
        method: request.method,
        headers: request.headers,
        body: await request.text(),
        redirect: init?.redirect ?? request.redirect,
      })
      return new Response('{}')
    },
    { preconnect: originalFetch.preconnect },
  ) as typeof fetch
  return seen
}

test('the model fetch sends a model request to the gateway with only the URL and headers changed', async () => {
  const seen = recordFetch()
  const send = createClaudeModelFetch({ gateway: gateway() })
  const headers = { authorization: 'Bearer tok', 'anthropic-beta': 'b1' }
  await send('https://api.anthropic.com/v1/messages?beta=true', {
    method: 'POST',
    headers,
    body: '{"model":"m"}',
  })
  await createClaudeModelFetch()(
    'https://api.anthropic.com/v1/messages?beta=true',
    { method: 'POST', headers, body: '{"model":"m"}' },
  )
  const [routed, direct] = seen
  expect(routed?.url).toBe(
    'https://gateway.example.test/claude/v1/messages?beta=true',
  )
  expect(direct?.url).toBe('https://api.anthropic.com/v1/messages?beta=true')
  expect(routed?.body).toBe(direct?.body)
  expect(routed?.redirect).toBe('error')
  expect(direct?.redirect).toBe('error')
  const routedHeaders = Object.fromEntries(routed?.headers ?? [])
  expect(routedHeaders['x-gateway-key']).toBe(SECRET)
  delete routedHeaders['x-gateway-key']
  expect(routedHeaders).toEqual(Object.fromEntries(direct?.headers ?? []))
})

test('the model fetch never sends sign-in, refresh, usage or profile requests to the gateway', async () => {
  const seen = recordFetch()
  const send = createClaudeModelFetch({ gateway: gateway() })
  for (const [url, method] of [
    ['https://api.anthropic.com/api/oauth/usage', 'GET'],
    ['https://api.anthropic.com/api/oauth/profile', 'GET'],
    ['https://api.anthropic.com/v1/oauth/token', 'POST'],
    ['https://api.anthropic.com/v1/messages', 'GET'],
  ] as const)
    await send(url, { method })
  expect(seen.map((entry) => new URL(entry.url).origin)).toEqual([
    'https://api.anthropic.com',
    'https://api.anthropic.com',
    'https://api.anthropic.com',
    'https://api.anthropic.com',
  ])
  expect(seen.some((entry) => entry.headers.has('x-gateway-key'))).toBe(false)
  // A non-model URL at the gateway is refused, not sent.
  await expect(
    send('https://gateway.example.test/claude/api/oauth/usage', {
      method: 'GET',
    }),
  ).rejects.toThrow(ANTHROPIC_OAUTH_ORIGIN_REFUSAL)
  expect(seen).toHaveLength(4)
})

async function settingsFixture(
  values: Record<string, unknown>,
  // The OS account's default settings file; tests use a temporary file.
  defaultFile: (root: string, file: string) => string | undefined = (
    _root,
    file,
  ) => file,
  // Runs after the file is written and before the service first reads it.
  prepare?: (root: string, file: string) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), 'gateway-settings-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const file = join(root, 'settings.jsonc')
  await writeFile(file, JSON.stringify({ schema_version: 1, ...values }))
  await prepare?.(root, file)
  const service = await openSettingsService({
    file,
    dependencies: {
      gatewaySettingsFile: () => defaultFile(root, file),
      open: (options) => {
        const handle = openSettings(settingsDefinition, options)
        return { ...handle, watch: () => () => {} }
      },
    },
  })
  if (!service) throw new Error('Settings service did not open')
  cleanup.push(() => service.dispose())
  const reader = (host: 'opencode' | 'pi') => {
    const settings = createNativeRuntimeSettings({
      host,
      settingsService: service,
      settingsMode: () => 'user-file',
      env: {},
    })
    cleanup.push(settings.close)
    return settings
  }
  return { file, service, reader }
}

function captureLogs() {
  const logs: LogTestRecord[] = []
  __setLogTestSink((record) => logs.push(record))
  return logs
}

test('a valid gateway serves both hosts from the user file, and Status shows header names only', async () => {
  const logs = captureLogs()
  const f = await settingsFixture({
    gateway_url: 'https://gateway.example.test/claude/',
    gateway_headers: { 'X-Gateway-Key': SECRET },
  })
  for (const host of ['opencode', 'pi'] as const) {
    const reader = f.reader(host)
    expect(reader.gateway()).toEqual({
      origin: 'https://gateway.example.test',
      pathPrefix: '/claude',
      headers: [['x-gateway-key', SECRET]],
    })
    const status = reader.status()
    expect(status?.file.invalidKeys).toEqual([])
    expect(status?.values.gateway).toEqual({
      origin: 'https://gateway.example.test',
      pathPrefix: '/claude',
      headerNames: ['x-gateway-key'],
    })
    expect('gateway_headers' in (status?.values ?? {})).toBe(false)
    expect(JSON.stringify(status)).not.toContain(SECRET)
  }
  expect(JSON.stringify(logs)).not.toContain(SECRET)
})

test('no gateway settings mean no gateway', async () => {
  const f = await settingsFixture({})
  const reader = f.reader('opencode')
  expect(reader.gateway()).toBeUndefined()
  expect(reader.status()?.values.gateway).toBeNull()
})

test.each([
  [
    'an http URL on a non-loopback host',
    { gateway_url: 'http://gateway.example.test' },
    'gateway_url',
  ],
  [
    'a URL with a query',
    { gateway_url: `https://gateway.example.test/?key=${SECRET}` },
    'gateway_url',
  ],
  [
    'a URL with userinfo',
    { gateway_url: `https://u:${SECRET}@gateway.example.test` },
    'gateway_url',
  ],
  [
    'a protected header',
    {
      gateway_url: 'https://gateway.example.test',
      gateway_headers: { authorization: `Bearer ${SECRET}` },
    },
    'gateway_headers',
  ],
  [
    'a non-string header value',
    {
      gateway_url: 'https://gateway.example.test',
      gateway_headers: { 'x-gateway-key': 7 },
    },
    'gateway_headers',
  ],
  [
    'a model override',
    {
      gateway_url: {
        default: 'https://gateway.example.test',
        'claude-opus-5-5': 'https://other.example.test',
      },
    },
    'gateway_url',
  ],
  [
    'a host override on the URL',
    {
      gateway_url: {
        default: 'https://gateway.example.test',
        pi: 'https://pi-gateway.example.test',
      },
      gateway_headers: { 'x-gateway-key': SECRET },
    },
    'gateway_url',
  ],
  [
    'an invalid URL together with invalid headers',
    {
      gateway_url: 'http://gateway.example.test',
      gateway_headers: { authorization: SECRET, 'x-ok': 7 },
    },
    'gateway_',
  ],
  [
    'host overrides on the header record',
    {
      gateway_url: 'https://gateway.example.test',
      gateway_headers: { default: { 'x-gateway-key': SECRET } },
    },
    'gateway_headers',
  ],
])(
  '%s means no gateway, with one warning and a Status entry',
  async (_name, values, key) => {
    const logs = captureLogs()
    const f = await settingsFixture(values)
    for (const host of ['opencode', 'pi'] as const) {
      const reader = f.reader(host)
      expect(reader.gateway()).toBeUndefined()
      const status = reader.status()
      expect(status?.values.gateway).toBeNull()
      expect(status?.values.gateway_url).toBe('')
      expect(
        status?.file.invalidKeys.some((entry) => entry.startsWith(key)),
      ).toBe(true)
      expect(JSON.stringify(status)).not.toContain(SECRET)
    }
    const warnings = logs.filter(
      (record) =>
        record.level === 'warn' && record.message.includes('Claude gateway'),
    )
    expect(warnings).toHaveLength(1)
    expect(warnings[0]?.message).toContain('https://api.anthropic.com')
    expect(JSON.stringify(logs)).not.toContain(SECRET)
  },
)

test('an invalid gateway edit drops the last good gateway instead of keeping it', async () => {
  const f = await settingsFixture({
    gateway_url: 'https://gateway.example.test',
  })
  const reader = f.reader('opencode')
  expect(reader.gateway()?.origin).toBe('https://gateway.example.test')
  await writeFile(
    f.file,
    JSON.stringify({
      schema_version: 1,
      gateway_url: 'https://gateway.example.test',
      gateway_headers: { 'x-api-key': SECRET },
    }),
  )
  await f.service.refresh()
  expect(reader.gateway()).toBeUndefined()
  // Type errors are dropped too, not replaced with the last good value.
  await writeFile(
    f.file,
    JSON.stringify({
      schema_version: 1,
      gateway_url: 'https://ok.example.test',
    }),
  )
  await f.service.refresh()
  expect(reader.gateway()?.origin).toBe('https://ok.example.test')
  await writeFile(
    f.file,
    JSON.stringify({ schema_version: 1, gateway_url: 42 }),
  )
  await f.service.refresh()
  expect(reader.gateway()).toBeUndefined()
})

test('a malformed or unreadable settings file stops the gateway, with one warning', async () => {
  const logs = captureLogs()
  const f = await settingsFixture({
    gateway_url: 'https://gateway.example.test',
    gateway_headers: { 'x-gateway-key': SECRET },
    dump_enabled: true,
  })
  const reader = f.reader('opencode')
  expect(reader.gateway()?.origin).toBe('https://gateway.example.test')
  await writeFile(f.file, '{ "schema_version": 1, "gateway_url": ')
  await f.service.refresh()
  // Other settings keep their last good values; the gateway does not.
  expect(f.service.resolve('opencode').dump_enabled).toBe(true)
  expect(reader.gateway()).toBeUndefined()
  expect(f.service.resolve('pi').gateway_url).toBe('')
  await f.service.refresh()
  expect(reader.gateway()).toBeUndefined()
  const warnings = logs.filter(
    (record) =>
      record.level === 'warn' &&
      record.message.includes('Claude gateway is not used until it reads'),
  )
  expect(warnings).toHaveLength(1)
  expect(JSON.stringify(logs)).not.toContain(SECRET)
  await writeFile(
    f.file,
    JSON.stringify({
      schema_version: 1,
      gateway_url: 'https://gateway.example.test',
    }),
  )
  await f.service.refresh()
  expect(reader.gateway()?.origin).toBe('https://gateway.example.test')
})

test('request dumps redact configured gateway header values', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gateway-dump-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const previous = process.env.OPENCODE_ANTHROPIC_AUTH_DUMP_DIR
  process.env.OPENCODE_ANTHROPIC_AUTH_DUMP_DIR = directory
  cleanup.push(() => {
    if (previous === undefined)
      delete process.env.OPENCODE_ANTHROPIC_AUTH_DUMP_DIR
    else process.env.OPENCODE_ANTHROPIC_AUTH_DUMP_DIR = previous
    resetDumpState()
  })
  rememberClaudeGatewaySecrets(gateway())
  setDumpEnabled(true)
  await dumpDirectRequest({
    affinity: 'ses_gateway',
    bodyText: '{"model":"m"}',
    url: 'https://gateway.example.test/claude/v1/messages?beta=true',
    method: 'POST',
    headers: { 'X-Gateway-Key': SECRET, 'x-other': 'visible' },
  })
  const files = await readdir(directory)
  const request = files.find((name) => name.endsWith('.request.json'))
  expect(request).toBeDefined()
  const text = await readFile(join(directory, request ?? ''), 'utf8')
  expect(text).toContain('[redacted]')
  expect(text).toContain('visible')
  for (const name of files)
    expect(await readFile(join(directory, name), 'utf8')).not.toContain(SECRET)
})

test('the gateway settings file comes from the OS account, never from HOME, USERPROFILE or APPDATA', async () => {
  // Under Bun, os.userInfo().homedir follows HOME, so this uses a real
  // settings service with no lookup seam: a fake home holding a gateway file
  // at every default location must not make that file the gateway's.
  const fake = await mkdtemp(join(tmpdir(), 'gateway-fake-home-'))
  cleanup.push(() => rm(fake, { recursive: true, force: true }))
  const contents = JSON.stringify({
    schema_version: 1,
    gateway_url: 'https://gateway.example.test',
    gateway_headers: { 'x-gateway-key': SECRET },
  })
  const posixFile = join(fake, '.config', 'cortexkit', 'anthropic-auth.jsonc')
  const appDataFile = join(fake, 'AppData', 'cortexkit', 'anthropic-auth.jsonc')
  const roamingFile = join(
    fake,
    'AppData',
    'Roaming',
    'cortexkit',
    'anthropic-auth.jsonc',
  )
  for (const file of [posixFile, appDataFile, roamingFile]) {
    await mkdir(join(file, '..'), { recursive: true })
    await writeFile(file, contents)
  }
  // The environment is chosen when the process starts, as a repository's
  // `.env` would be, so the check runs in a child process launched with it.
  const file = process.platform === 'win32' ? appDataFile : posixFile
  const modulePath = (name: string) =>
    JSON.stringify(join(import.meta.dir, '..', name))
  const child = Bun.spawn(
    [
      process.execPath,
      '-e',
      `
        const { gatewaySettingsFile } = await import(${modulePath('gateway.ts')})
        const { openSettingsService } = await import(${modulePath('settings-service.ts')})
        const { createNativeRuntimeSettings } = await import(${modulePath('native-runtime-settings.ts')})
        const file = process.env.ANTHROPIC_AUTH_SETTINGS_FILE
        const service = await openSettingsService({ file })
        const reader = createNativeRuntimeSettings({
          host: 'opencode',
          settingsService: service,
          settingsMode: () => 'user-file',
          env: {},
        })
        console.log(JSON.stringify({
          expected: (await gatewaySettingsFile()) ?? null,
          gateway: reader.gateway()?.origin ?? null,
          ignored: service.status().gatewayIgnored ?? null,
        }))
        process.exit(0)
      `,
    ],
    {
      env: {
        ...process.env,
        HOME: fake,
        USERPROFILE: fake,
        APPDATA: join(fake, 'AppData'),
        XDG_CONFIG_HOME: join(fake, '.config'),
        ANTHROPIC_AUTH_SETTINGS_FILE: file,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )
  const [output, errors, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  expect({ code, errors: code === 0 ? '' : errors }).toEqual({
    code: 0,
    errors: '',
  })
  const result = JSON.parse(output.trim().split('\n').at(-1) ?? '{}')
  expect(result.expected).not.toBe(file)
  expect(result.gateway).toBeNull()
  expect(result.ignored).not.toBeNull()
})

function lookupDependencies(
  platform: NodeJS.Platform,
  outputs: Record<string, string | Error>,
  passwd = '',
) {
  const calls: {
    file: string
    args: readonly string[]
    env: Readonly<Record<string, string>>
  }[] = []
  return {
    calls,
    dependencies: {
      platform,
      uid: 1000,
      run: async (
        file: string,
        args: readonly string[],
        env: Readonly<Record<string, string>>,
      ) => {
        calls.push({ file, args, env })
        const output = outputs[file]
        if (output === undefined || output instanceof Error)
          throw output ?? new Error('not found')
        return output
      },
      readFile: async () => passwd,
    },
  }
}

test('the account lookup runs fixed programs by absolute path with no inherited PATH', async () => {
  const linux = lookupDependencies('linux', {
    '/usr/bin/getent': 'me:x:1000:1000:Me:/home/me:/bin/sh\n',
  })
  expect(await lookupGatewaySettingsFile(linux.dependencies)).toBe(
    '/home/me/.config/cortexkit/anthropic-auth.jsonc',
  )
  expect(linux.calls).toEqual([
    { file: '/usr/bin/getent', args: ['passwd', '1000'], env: { LC_ALL: 'C' } },
  ])
  // Without getent, the local passwd file is read by user id.
  const fallback = lookupDependencies(
    'linux',
    {},
    'root:x:0:0::/root:/bin/sh\nme:x:1000:1000::/srv/me:/bin/sh\n',
  )
  expect(await lookupGatewaySettingsFile(fallback.dependencies)).toBe(
    '/srv/me/.config/cortexkit/anthropic-auth.jsonc',
  )
  // An entry for another id, or a relative home, is no answer.
  for (const passwd of [
    'me:x:1001:1000::/home/me:/bin/sh',
    'me:x:1000:1::home:',
  ])
    expect(
      await lookupGatewaySettingsFile(
        lookupDependencies('linux', {}, passwd).dependencies,
      ),
    ).toBeUndefined()

  const mac = lookupDependencies('darwin', {
    '/usr/bin/id': 'me\n',
    '/usr/bin/dscl': 'NFSHomeDirectory:\n /Users/Me Home\nUniqueID: 1000\n',
  })
  expect(await lookupGatewaySettingsFile(mac.dependencies)).toBe(
    '/Users/Me Home/.config/cortexkit/anthropic-auth.jsonc',
  )
  expect(mac.calls.map(({ file, env }) => [file, env])).toEqual([
    ['/usr/bin/id', { LC_ALL: 'C' }],
    ['/usr/bin/dscl', { LC_ALL: 'C' }],
  ])
  expect(mac.calls[1]?.args).toEqual([
    '.',
    '-read',
    '/Users/me',
    'UniqueID',
    'NFSHomeDirectory',
  ])
  // A record for another user id is refused.
  expect(
    await lookupGatewaySettingsFile(
      lookupDependencies('darwin', {
        '/usr/bin/id': 'me\n',
        '/usr/bin/dscl': 'NFSHomeDirectory: /Users/me\nUniqueID: 501\n',
      }).dependencies,
    ),
  ).toBeUndefined()

  const reg = 'C:\\Windows\\System32\\reg.exe'
  const windows = lookupDependencies('win32', {
    [reg]:
      '\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Shell Folders\r\n    AppData    REG_SZ    D:\\Profiles\\me\\Roaming\r\n\r\n',
  })
  expect(await lookupGatewaySettingsFile(windows.dependencies)).toBe(
    'D:\\Profiles\\me\\Roaming\\cortexkit\\anthropic-auth.jsonc',
  )
  expect(windows.calls).toEqual([
    {
      file: reg,
      args: [
        'query',
        'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Shell Folders',
        '/v',
        'AppData',
      ],
      env: { SystemRoot: 'C:\\Windows' },
    },
  ])
  // An unexpanded value is no answer; nor is a failed program.
  expect(
    await lookupGatewaySettingsFile(
      lookupDependencies('win32', {
        [reg]: '    AppData    REG_SZ    %USERPROFILE%\\AppData\\Roaming\r\n',
      }).dependencies,
    ),
  ).toBeUndefined()
  expect(
    await lookupGatewaySettingsFile(
      lookupDependencies('win32', { [reg]: new Error('denied') }).dependencies,
    ),
  ).toBeUndefined()
})

test('a failed account lookup ignores the gateway, with one warning and a Status note', async () => {
  const logs = captureLogs()
  const f = await settingsFixture(
    {
      gateway_url: 'https://gateway.example.test',
      gateway_headers: { 'x-gateway-key': SECRET },
    },
    () => undefined,
  )
  const reader = f.reader('pi')
  expect(reader.gateway()).toBeUndefined()
  expect(reader.status()?.file.gatewayIgnored).toBe('account-home-unknown')
  await f.service.refresh()
  expect(
    logs.filter(
      (record) =>
        record.level === 'warn' && record.message.includes('home folder'),
    ),
  ).toHaveLength(1)
  expect(JSON.stringify(logs)).not.toContain(SECRET)
})

test('the default location is checked again for every settings generation', async () => {
  const f = await settingsFixture(
    { gateway_url: 'https://gateway.example.test' },
    (root) => join(root, 'default', 'anthropic-auth.jsonc'),
    async (root, file) => {
      // The default path is a symlink to the file in use, so it qualifies.
      await mkdir(join(root, 'default'))
      await symlink(file, join(root, 'default', 'anthropic-auth.jsonc'))
    },
  )
  const root = join(f.file, '..')
  const defaultFile = join(root, 'default', 'anthropic-auth.jsonc')
  const other = join(root, 'other.jsonc')
  await writeFile(other, '{}')
  const reader = f.reader('opencode')
  expect(reader.gateway()?.origin).toBe('https://gateway.example.test')
  // The symlink now points elsewhere: the next generation fails closed.
  await rm(defaultFile)
  await symlink(other, defaultFile)
  await writeFile(
    f.file,
    JSON.stringify({
      schema_version: 1,
      gateway_url: 'https://attacker.example.test',
    }),
  )
  await f.service.refresh()
  expect(reader.gateway()).toBeUndefined()
  expect(reader.status()?.file.gatewayIgnored).toBe('not-default-location')
})

test('rotated gateway header values are redaction secrets as soon as the settings generation is published', async () => {
  const rotated = `rotated-gateway-canary-${crypto.randomUUID()}`
  const f = await settingsFixture({
    gateway_url: 'https://gateway.example.test',
    gateway_headers: { 'x-gateway-key': SECRET },
  })
  await writeFile(
    f.file,
    JSON.stringify({
      schema_version: 1,
      gateway_url: 'https://gateway.example.test',
      gateway_headers: { 'x-gateway-key': rotated },
    }),
  )
  await f.service.refresh()
  // No host has read the gateway yet (a keep-warm first reads it inside its
  // fetch, after its error scope is built), and the value is already known.
  expect(claudeGatewaySecretValues()).toContain(rotated)
})

test('an OAuth send drops any TLS option, so certificate checks always apply', async () => {
  const inits: (RequestInit & { tls?: unknown })[] = []
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    inits.push(init ?? {})
    return new Response('{}')
  }) as typeof fetch
  const insecure = {
    method: 'POST',
    body: '{}',
    tls: { rejectUnauthorized: false },
  } as RequestInit
  await createAnthropicOAuthFetch()(
    'https://api.anthropic.com/v1/messages',
    insecure,
  )
  await createClaudeModelFetch({ gateway: gateway() })(
    'https://api.anthropic.com/v1/messages',
    insecure,
  )
  expect(inits).toHaveLength(2)
  for (const init of inits) {
    expect('tls' in init).toBe(false)
    expect(init.redirect).toBe('error')
  }
})

test('a settings file outside its default location names a gateway that is ignored, with one warning and a Status note', async () => {
  const logs = captureLogs()
  const f = await settingsFixture(
    {
      gateway_url: 'https://gateway.example.test',
      gateway_headers: { 'x-gateway-key': SECRET },
    },
    (root) => join(root, 'default', 'anthropic-auth.jsonc'),
  )
  for (const host of ['opencode', 'pi'] as const) {
    const reader = f.reader(host)
    expect(reader.gateway()).toBeUndefined()
    const status = reader.status()
    expect(status?.file.gatewayIgnored).toBe('not-default-location')
    expect(status?.values.gateway).toBeNull()
    expect(status?.file.invalidKeys).toEqual([])
  }
  await f.service.refresh()
  expect(
    logs.filter(
      (record) =>
        record.level === 'warn' &&
        record.message.includes('not in its default location'),
    ),
  ).toHaveLength(1)
  expect(JSON.stringify(logs)).not.toContain(SECRET)
})

test('the default location is compared as a real path', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gateway-location-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const file = join(root, 'real', 'anthropic-auth.jsonc')
  const link = join(root, 'linked', 'anthropic-auth.jsonc')
  await mkdir(join(root, 'real'))
  await mkdir(join(root, 'linked'))
  await writeFile(file, '{}')
  await symlink(file, link)
  expect(await isGatewaySettingsFile(file, link)).toBe(true)
  expect(await isGatewaySettingsFile(link, file)).toBe(true)
  expect(await isGatewaySettingsFile(join(root, 'other.jsonc'), link)).toBe(
    false,
  )
  expect(await isGatewaySettingsFile(file, undefined)).toBe(false)
})

// Every case below was measured against Bun 1.3.14's own fetch (HTTP_PROXY
// pointing at a local listener): `proxied` is what Bun does, and the check
// must refuse at least those. Suffix forms Bun also exempts (`.0.0.1`) are
// refused here on purpose.
test.each<[string, Record<string, string>, boolean]>([
  ['no proxy variable', {}, false],
  ['HTTP_PROXY', { HTTP_PROXY: 'http://127.0.0.1:9' }, true],
  ['http_proxy', { http_proxy: 'http://127.0.0.1:9' }, true],
  ['a value that is not a URL', { HTTP_PROXY: 'not a url' }, true],
  ['an empty HTTP_PROXY', { HTTP_PROXY: '' }, false],
  [
    'an empty HTTP_PROXY beside http_proxy',
    { HTTP_PROXY: '', http_proxy: 'http://127.0.0.1:9' },
    true,
  ],
  ['ALL_PROXY, which Bun ignores for http', { ALL_PROXY: 'http://p:9' }, false],
  [
    'HTTPS_PROXY, which Bun ignores for http',
    { HTTPS_PROXY: 'http://p:9' },
    false,
  ],
  ['NO_PROXY=127.0.0.1', { HTTP_PROXY: 'x', NO_PROXY: '127.0.0.1' }, false],
  ['no_proxy=127.0.0.1', { HTTP_PROXY: 'x', no_proxy: '127.0.0.1' }, false],
  ['NO_PROXY=*', { HTTP_PROXY: 'x', NO_PROXY: ' * ' }, false],
  [
    'a trimmed comma list',
    { HTTP_PROXY: 'x', NO_PROXY: 'a.com, 127.0.0.1 ' },
    false,
  ],
  ['host:port', { HTTP_PROXY: 'x', NO_PROXY: '127.0.0.1:43123' }, false],
  [
    'host with another port',
    { HTTP_PROXY: 'x', NO_PROXY: '127.0.0.1:1' },
    true,
  ],
  ['a semicolon list', { HTTP_PROXY: 'x', NO_PROXY: 'a.com;127.0.0.1' }, true],
  ['a suffix', { HTTP_PROXY: 'x', NO_PROXY: '.0.0.1' }, true],
  ['a CIDR range', { HTTP_PROXY: 'x', NO_PROXY: '127.0.0.0/8' }, true],
  ['another loopback name', { HTTP_PROXY: 'x', NO_PROXY: 'localhost' }, true],
  [
    'no_proxy, which replaces NO_PROXY',
    { HTTP_PROXY: 'x', NO_PROXY: '127.0.0.1', no_proxy: 'a.com' },
    true,
  ],
  [
    'an empty no_proxy, which leaves NO_PROXY',
    { HTTP_PROXY: 'x', NO_PROXY: '127.0.0.1', no_proxy: '' },
    false,
  ],
])('a plain-http gateway with %s: proxied is %p', (_name, env, proxied) => {
  expect(claudeGatewayProxyApplies('http://127.0.0.1:43123', env)).toBe(proxied)
})

test('the proxy check knows the IPv6 and named loopback forms, and leaves https alone', () => {
  const env = { HTTP_PROXY: 'x' }
  expect(claudeGatewayProxyApplies('http://[::1]:8080', env)).toBe(true)
  expect(
    claudeGatewayProxyApplies('http://[::1]:8080', { ...env, NO_PROXY: '::1' }),
  ).toBe(true)
  expect(
    claudeGatewayProxyApplies('http://[::1]:8080', {
      ...env,
      NO_PROXY: '[::1]',
    }),
  ).toBe(false)
  expect(
    claudeGatewayProxyApplies('http://localhost:8080', {
      ...env,
      NO_PROXY: 'LOCALHOST',
    }),
  ).toBe(false)
  // A port-less URL is not exempted by host:port, a form measured only with
  // an explicit port.
  expect(
    claudeGatewayProxyApplies('http://localhost', {
      ...env,
      NO_PROXY: 'localhost:80',
    }),
  ).toBe(true)
  expect(
    claudeGatewayProxyApplies('https://gateway.example.test', {
      HTTP_PROXY: 'x',
      HTTPS_PROXY: 'x',
    }),
  ).toBe(false)
  const status = {
    origin: 'http://127.0.0.1:43123',
    pathPrefix: '',
    headerNames: [],
  }
  expect(claudeGatewayStatusNotes(undefined, status, env)).toEqual([
    CLAUDE_GATEWAY_PROXY_REFUSAL,
  ])
  expect(claudeGatewayStatusNotes(undefined, status, {})).toEqual([])
  expect(claudeGatewayStatusNotes(undefined, null, env)).toEqual([])
})

/**
 * Runs a model send to a plain-http loopback gateway in a child process
 * started with `env`, as a repository's `.env` would set it, with a proxy
 * listener and the gateway listening. Bun reads the proxy variables when the
 * process starts, so this cannot run in the test process.
 */
async function sendThroughProxyEnv(env: Record<string, string>) {
  const proxyHits: string[] = []
  const gatewayHits: string[] = []
  // A raw listener, so any connection counts, whatever the proxy request
  // looks like.
  const proxy = createServer((socket) => {
    socket.once('data', (chunk) => {
      proxyHits.push(chunk.toString('latin1').split('\r\n')[0] ?? '')
      socket.end(
        'HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}',
      )
    })
    socket.on('error', () => {})
  })
  await new Promise<void>((resolve) =>
    proxy.listen(0, '127.0.0.1', () => resolve()),
  )
  const proxyAddress = proxy.address()
  const proxyPort =
    typeof proxyAddress === 'object' && proxyAddress ? proxyAddress.port : 0
  const gatewayServer = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      gatewayHits.push(
        `${new URL(request.url).pathname} ${request.headers.get('x-gateway-key')}`,
      )
      return new Response('{}')
    },
  })
  cleanup.push(() => {
    proxy.close()
    gatewayServer.stop(true)
  })
  const origin = `http://127.0.0.1:${gatewayServer.port}`
  const proxyUrl = `http://127.0.0.1:${proxyPort}`
  const modulePath = (name: string) =>
    JSON.stringify(join(import.meta.dir, '..', name))
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !/^(?:http|https|all|no)_proxy$/i.test(name),
    ),
  )
  const child = Bun.spawn(
    [
      process.execPath,
      '-e',
      `
        const { createClaudeModelFetch } = await import(${modulePath('oauth-origin.ts')})
        const { claudeGatewayStatusNotes } = await import(${modulePath('gateway.ts')})
        const { __setLogTestSink } = await import(${modulePath('logger.ts')})
        const logs = []
        __setLogTestSink((record) => logs.push(record))
        const gateway = {
          origin: ${JSON.stringify(origin)},
          pathPrefix: '/claude',
          headers: [['x-gateway-key', ${JSON.stringify(SECRET)}]],
        }
        const send = createClaudeModelFetch({ gateway })
        const outcomes = []
        for (const _ of [1, 2]) {
          try {
            const response = await send('https://api.anthropic.com/v1/messages?beta=true', {
              method: 'POST',
              headers: { authorization: 'Bearer proxy-test-token' },
              body: '{"model":"m"}',
            })
            outcomes.push('sent ' + response.status)
          } catch (error) {
            outcomes.push('refused ' + error.message)
          }
        }
        console.log(JSON.stringify({
          outcomes,
          warnings: logs.filter((record) => record.level === 'warn').map((record) => record.message),
          notes: claudeGatewayStatusNotes(undefined, { origin: gateway.origin, pathPrefix: '/claude', headerNames: ['x-gateway-key'] }),
        }))
        process.exit(0)
      `,
    ],
    {
      env: {
        ...inherited,
        ...Object.fromEntries(
          Object.entries(env).map(([name, value]) => [
            name,
            value.replace('$PROXY', proxyUrl),
          ]),
        ),
      },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )
  const [output, errors, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  expect({ code, errors: code === 0 ? '' : errors }).toEqual({
    code: 0,
    errors: '',
  })
  const result = JSON.parse(output.trim().split('\n').at(-1) ?? '{}') as {
    outcomes: string[]
    warnings: string[]
    notes: string[]
  }
  return { ...result, proxyHits, gatewayHits, proxyUrl }
}

for (const name of ['HTTP_PROXY', 'http_proxy'])
  test(`a plain-http gateway send is refused when ${name} would carry it, and the proxy never receives it`, async () => {
    const result = await sendThroughProxyEnv({ [name]: '$PROXY' })
    expect(result.proxyHits).toEqual([])
    expect(result.gatewayHits).toEqual([])
    // Refused every time, with the fixed text; nothing goes to
    // api.anthropic.com instead.
    expect(result.outcomes).toEqual([
      `refused ${CLAUDE_GATEWAY_PROXY_REFUSAL}`,
      `refused ${CLAUDE_GATEWAY_PROXY_REFUSAL}`,
    ])
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toContain('proxy setting')
    expect(result.notes).toEqual([CLAUDE_GATEWAY_PROXY_REFUSAL])
    // Neither the proxy's address nor a header value is named anywhere.
    const text = JSON.stringify(result.outcomes.concat(result.warnings))
    expect(text).not.toContain(result.proxyUrl)
    expect(text).not.toContain(SECRET)
  })

test('a plain-http gateway the NO_PROXY list exempts is sent to the gateway, not the proxy', async () => {
  const result = await sendThroughProxyEnv({
    HTTP_PROXY: '$PROXY',
    NO_PROXY: 'example.test, 127.0.0.1',
  })
  expect(result.proxyHits).toEqual([])
  expect(result.gatewayHits).toEqual([
    `/claude/v1/messages ${SECRET}`,
    `/claude/v1/messages ${SECRET}`,
  ])
  expect(result.outcomes).toEqual(['sent 200', 'sent 200'])
  expect(result.warnings).toEqual([])
  expect(result.notes).toEqual([])
})

async function eventually(check: () => boolean, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition not reached')
    await Bun.sleep(25)
  }
}

test('removing or retargeting the default path stops the gateway at once, though the file in use is unchanged', async () => {
  const f = await settingsFixture(
    { gateway_url: 'https://gateway.example.test' },
    (root) => join(root, 'default', 'anthropic-auth.jsonc'),
    async (root, file) => {
      // The default path is a symlink to the file in use, so it qualifies.
      await mkdir(join(root, 'default'))
      await symlink(file, join(root, 'default', 'anthropic-auth.jsonc'))
    },
  )
  const root = join(f.file, '..')
  const defaultFile = join(root, 'default', 'anthropic-auth.jsonc')
  const reader = f.reader('opencode')
  expect(reader.gateway()?.origin).toBe('https://gateway.example.test')
  // The fixture's own file watch is off and the file in use is not touched:
  // only a watch on the default path can notice these changes.
  await rm(defaultFile)
  await eventually(() => reader.gateway() === undefined)
  expect(reader.status()?.file.gatewayIgnored).toBe('not-default-location')
  await symlink(f.file, defaultFile)
  await eventually(() => reader.gateway() !== undefined)
  const other = join(root, 'other.jsonc')
  await writeFile(other, '{}')
  await rm(defaultFile)
  await symlink(other, defaultFile)
  await eventually(() => reader.gateway() === undefined)
  expect(reader.status()?.file.gatewayIgnored).toBe('not-default-location')
})
