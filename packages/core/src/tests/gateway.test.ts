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
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { openSettings } from '@cortexkit/common-auth/settings'
import { dumpDirectRequest, resetDumpState, setDumpEnabled } from '../dump.ts'
import {
  type ClaudeGateway,
  claudeGatewayModelUrl,
  gatewaySettingsFile,
  isGatewaySettingsFile,
  parseClaudeGateway,
  rememberClaudeGatewaySecrets,
} from '../gateway.ts'
import { __setLogTestSink, type LogTestRecord } from '../logger.ts'
import { createNativeRuntimeSettings } from '../native-runtime-settings.ts'
import {
  ANTHROPIC_OAUTH_ORIGIN_REFUSAL,
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
  ])
    expect(claudeGatewayModelUrl(url, g)?.href).toBe(
      'https://gateway.example.test/claude/v1/messages?beta=true',
    )
  for (const url of [
    'https://api.anthropic.com/x/../v1/messages',
    'https://api.anthropic.com/./v1/messages',
    'https://api.anthropic.com/x/%2e%2e/v1/messages',
    'https://api.anthropic.com/v1/messages/count_tokens',
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
) {
  const root = await mkdtemp(join(tmpdir(), 'gateway-settings-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const file = join(root, 'settings.jsonc')
  await writeFile(file, JSON.stringify({ schema_version: 1, ...values }))
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

test('the gateway settings file comes from the OS account, never from the environment', () => {
  const saved = { ...process.env }
  try {
    process.env.HOME = '/tmp/elsewhere-home'
    process.env.XDG_CONFIG_HOME = '/tmp/elsewhere-config'
    process.env.APPDATA = '/tmp/elsewhere-appdata'
    process.env.USERPROFILE = '/tmp/elsewhere-profile'
    process.env.ANTHROPIC_AUTH_SETTINGS_FILE = '/tmp/elsewhere/settings.jsonc'
    const home = userInfo().homedir
    expect(gatewaySettingsFile()).toBe(
      process.platform === 'win32'
        ? join(home, 'AppData', 'Roaming', 'cortexkit', 'anthropic-auth.jsonc')
        : join(home, '.config', 'cortexkit', 'anthropic-auth.jsonc'),
    )
  } finally {
    for (const key of Object.keys(process.env))
      if (!(key in saved)) delete process.env[key]
    Object.assign(process.env, saved)
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
