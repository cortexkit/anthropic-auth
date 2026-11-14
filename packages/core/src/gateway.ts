import { execFile } from 'node:child_process'
import { readFile, realpath } from 'node:fs/promises'
import { posix, resolve, win32 } from 'node:path'
import { customHeadersFromEntries } from './custom-headers.ts'
import { logger } from './logger.ts'

/**
 * The user's own gateway for Claude sign-in (OAuth) model requests.
 *
 * Claude OAuth tokens normally go only to https://api.anthropic.com (see
 * oauth-origin.ts). A user can name one gateway in their own settings file
 * (`gateway_url`, `gateway_headers`); model requests (`POST …/v1/messages`)
 * then go there instead. The value is read only from the user settings file:
 * never from a project file, a provider `baseURL` or an environment
 * variable, because those can come from a repository the user opened.
 *
 * Header values are secrets the user gave to their gateway. They are kept
 * only in memory, added to gateway requests, and never logged, dumped or
 * shown: Status shows header names only.
 */
export interface ClaudeGateway {
  /** Scheme, host and port, for example `https://gw.example.com`. */
  readonly origin: string
  /** Path prefix without a trailing slash, or `''` for none. */
  readonly pathPrefix: string
  /** Header names and values to add to every gateway request. */
  readonly headers: readonly (readonly [string, string])[]
}

/** What Status may show about a gateway: no header values. */
export interface ClaudeGatewayStatus {
  readonly origin: string
  readonly pathPrefix: string
  readonly headerNames: readonly string[]
}

export type ClaudeGatewayParse =
  | { readonly ok: true; readonly gateway: ClaudeGateway | undefined }
  | { readonly ok: false; readonly problem: 'gateway_url' | 'gateway_headers' }

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '[::1]', 'localhost'])

function parseGatewayUrl(
  raw: string,
): { origin: string; pathPrefix: string } | undefined {
  // A query or fragment marker is refused even when empty: `new URL` drops
  // an empty `?` or `#`, so check the text before parsing it.
  if (raw.includes('?') || raw.includes('#')) return undefined
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return undefined
  }
  if (url.username || url.password) return undefined
  if (url.protocol === 'http:') {
    if (!LOOPBACK_HOSTS.has(url.hostname)) return undefined
  } else if (url.protocol !== 'https:') return undefined
  if (!url.hostname) return undefined
  const pathPrefix = url.pathname.replace(/\/+$/, '')
  return { origin: url.origin, pathPrefix }
}

/**
 * Validates the two gateway settings together. An empty `gateway_url` means
 * no gateway; headers without a URL are still validated so a mistake shows
 * up before the URL is added. Any problem makes the whole gateway invalid.
 */
export function parseClaudeGateway(
  url: string,
  headers: Readonly<Record<string, string>>,
): ClaudeGatewayParse {
  let parsedHeaders: Headers
  try {
    parsedHeaders = customHeadersFromEntries(Object.entries(headers))
  } catch {
    return { ok: false, problem: 'gateway_headers' }
  }
  if (!url) return { ok: true, gateway: undefined }
  const destination = parseGatewayUrl(url)
  if (!destination) return { ok: false, problem: 'gateway_url' }
  return {
    ok: true,
    gateway: {
      ...destination,
      headers: [...parsedHeaders.entries()],
    },
  }
}

/** Status view of a gateway: origin, path prefix and header names only. */
export function claudeGatewayStatus(
  gateway: ClaudeGateway | undefined,
): ClaudeGatewayStatus | undefined {
  if (!gateway) return undefined
  return {
    origin: gateway.origin,
    pathPrefix: gateway.pathPrefix,
    headerNames: gateway.headers.map(([name]) => name),
  }
}

/**
 * True when `url` is inside the gateway: same scheme, host and port, and a
 * path equal to the prefix or below it.
 */
export function isClaudeGatewayUrl(url: URL, gateway: ClaudeGateway): boolean {
  let origin: URL
  try {
    origin = new URL(gateway.origin)
  } catch {
    return false
  }
  if (url.protocol !== origin.protocol || url.origin !== origin.origin)
    return false
  if (url.username || url.password) return false
  if (!gateway.pathPrefix) return true
  return (
    url.pathname === gateway.pathPrefix ||
    url.pathname.startsWith(`${gateway.pathPrefix}/`)
  )
}

const MODEL_REQUEST_PATH = '/v1/messages'
const MODEL_REQUEST_SUFFIX = '/messages'
const ANTHROPIC_API_ORIGIN = 'https://api.anthropic.com'

function hasDotSegment(raw: string): boolean {
  // `new URL` resolves `.` and `..` (also written `%2e`) silently, so the
  // original text is checked before parsing.
  const path = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*([^?#]*)/i.exec(raw)?.[1] ?? ''
  return path.split('/').some((segment) => /^(?:\.|%2e){1,2}$/i.test(segment))
}

/**
 * Where a model request goes through the gateway, or undefined when `url` is
 * not a model request the gateway takes. A model request URL is a URL on
 * `https://api.anthropic.com`, or inside the gateway, whose path ends in
 * `/messages` once repeated and trailing slashes are collapsed; a provider
 * base URL can add a path or another version segment in front of it. It
 * always goes to `<gateway prefix>/v1/messages` with its query
 * (`?beta=true`) kept. A path with `.` or `..` segments, other Anthropic
 * endpoints and other hosts are left alone, so the OAuth destination check
 * still decides them without the gateway.
 */
export function claudeGatewayModelUrl(
  url: string | URL,
  gateway: ClaudeGateway,
): URL | undefined {
  if (typeof url === 'string' && hasDotSegment(url)) return undefined
  let source: URL
  try {
    source = new URL(String(url))
  } catch {
    return undefined
  }
  if (source.username || source.password) return undefined
  // Repeated and trailing slashes are collapsed. A model request path ends
  // in `/messages` (`/v1/messages`, or `/v2/messages` from a versioned base
  // URL); `/messages/count_tokens` and other sub-resources do not.
  const path = source.pathname.replace(/\/{2,}/g, '/').replace(/\/+$/, '')
  if (!path.endsWith(MODEL_REQUEST_SUFFIX)) return undefined
  const direct =
    source.protocol === 'https:' && source.origin === ANTHROPIC_API_ORIGIN
  if (!direct && !isClaudeGatewayUrl(source, gateway)) return undefined
  const target = new URL(gateway.origin)
  target.pathname = `${gateway.pathPrefix}${MODEL_REQUEST_PATH}`
  target.search = source.search
  return target
}

/** Adds the gateway headers to a request's headers. */
export function applyClaudeGatewayHeaders(
  headers: Headers,
  gateway: ClaudeGateway,
): Headers {
  for (const [name, value] of gateway.headers) headers.set(name, value)
  return headers
}

// Every gateway header name and value ever configured in this process. The
// sets never shrink, so a dump or error read just after a settings change
// still hides an earlier header's value. Request dumps redact the names;
// provider-error redaction replaces the values wherever they appear.
const secretHeaderNames = new Set<string>()
const secretHeaderValues = new Set<string>()

/** Records a gateway's header names and values as secrets. */
export function rememberClaudeGatewaySecrets(
  gateway: ClaudeGateway | undefined,
): void {
  for (const [name, value] of gateway?.headers ?? []) {
    secretHeaderNames.add(name.toLowerCase())
    if (value) secretHeaderValues.add(value)
  }
}

/** True for a configured gateway header name; its value must not be dumped. */
export function isClaudeGatewaySecretHeader(name: string): boolean {
  return secretHeaderNames.has(name.toLowerCase())
}

/**
 * Every gateway header value configured in this process, for provider-error
 * redaction of sends that cannot tell which gateway they used.
 */
export function claudeGatewaySecretValues(): string[] {
  return [...secretHeaderValues]
}

/** The header values one gateway send carries, for provider-error redaction. */
export function claudeGatewayHeaderValues(
  gateway: ClaudeGateway | undefined,
): string[] {
  return (gateway?.headers ?? []).map(([, value]) => value).filter(Boolean)
}

const warnedRelayIgnored = new Set<string>()

/**
 * Logs once per gateway destination that the configured relay is not used: the
 * gateway takes model requests, and nothing falls back to the relay or to
 * api.anthropic.com.
 */
export function warnClaudeGatewayRelayIgnored(gateway: ClaudeGateway): void {
  const key = `${gateway.origin}${gateway.pathPrefix}`
  if (warnedRelayIgnored.has(key)) return
  warnedRelayIgnored.add(key)
  logger.warn(
    'gateway',
    'a relay is configured, but Claude OAuth model requests use the gateway from the settings file; the relay is not used for them',
  )
}

type ProxyEnvironment = Readonly<Record<string, string | undefined>>

/**
 * Fixed text for refusing a plain-http gateway send that a proxy setting
 * would carry. It names no value: the variables may hold credentials.
 */
export const CLAUDE_GATEWAY_PROXY_REFUSAL =
  'Gateway refused: a proxy setting would carry plain-http requests'

/**
 * True when a plain-http request to `origin` would go through a proxy.
 *
 * Bun's fetch sends a plain-http request through `HTTP_PROXY` or
 * `http_proxy`, and fetch has no per-request way to turn that off. A
 * repository's `.env` can set those variables, so a proxy it names would
 * receive the OAuth bearer, the gateway headers and the conversation in
 * clear text. (An https gateway is only tunnelled through a proxy, and TLS
 * still checks the gateway's certificate, so it is not affected.)
 *
 * Measured on Bun 1.3.14: `HTTP_PROXY` and `http_proxy` apply to http URLs,
 * and any non-empty value counts, even one that is not a URL. `ALL_PROXY`,
 * `all_proxy`, `HTTPS_PROXY` and `https_proxy` do not apply to http URLs.
 * `no_proxy`, when non-empty, is used in place of `NO_PROXY`; it is a comma
 * list whose entries are trimmed, and `*`, the exact host (`[::1]` for IPv6,
 * any letter case) and `host:port` with the URL's own explicit port exempt the
 * host. Bun also exempts some host suffixes; those are not accepted here, so
 * this check can only refuse more than Bun would proxy, never less.
 */
export function claudeGatewayProxyApplies(
  origin: string,
  env: ProxyEnvironment = process.env,
): boolean {
  let url: URL
  try {
    url = new URL(origin)
  } catch {
    return true
  }
  if (url.protocol !== 'http:') return false
  if (!env.HTTP_PROXY && !env.http_proxy) return false
  const list = env.no_proxy ? env.no_proxy : (env.NO_PROXY ?? '')
  const host = url.hostname.toLowerCase()
  // `host:port` was measured only with a port written in the URL.
  const withPort = url.port ? `${host}:${url.port}` : undefined
  for (const raw of list.split(',')) {
    const entry = raw.trim().toLowerCase()
    if (!entry) continue
    if (entry === '*' || entry === host || entry === withPort) return false
  }
  return true
}

const warnedProxyRefused = new Set<string>()

/**
 * Logs once per gateway destination that its plain-http sends are refused
 * because a proxy setting would carry them. Names no variable value.
 */
export function warnClaudeGatewayProxyRefused(gateway: ClaudeGateway): void {
  const key = `${gateway.origin}${gateway.pathPrefix}`
  if (warnedProxyRefused.has(key)) return
  warnedProxyRefused.add(key)
  logger.warn(
    'gateway',
    'Claude OAuth model requests to the http gateway are refused: a proxy setting (HTTP_PROXY or http_proxy) would carry them in plain text. Exempt the gateway host with NO_PROXY, or use an https gateway.',
  )
}

/** Why a gateway named in the settings file is not used. */
export type ClaudeGatewayIgnored =
  | 'not-default-location'
  | 'account-home-unknown'

/** The Status line for an ignored gateway; it names no value. */
export function claudeGatewayIgnoredNote(reason: ClaudeGatewayIgnored): string {
  return reason === 'account-home-unknown'
    ? "Gateway ignored: the operating system account's home folder could not be found"
    : 'Gateway ignored: settings file is not in its default location'
}

/**
 * The Status lines about the gateway: why a configured gateway is ignored,
 * or that its plain-http sends are refused because of a proxy setting.
 * They name no header or environment value.
 */
export function claudeGatewayStatusNotes(
  ignored: ClaudeGatewayIgnored | undefined,
  gateway: ClaudeGatewayStatus | null | undefined,
  env: ProxyEnvironment = process.env,
): string[] {
  if (ignored) return [claudeGatewayIgnoredNote(ignored)]
  return gateway && claudeGatewayProxyApplies(gateway.origin, env)
    ? [CLAUDE_GATEWAY_PROXY_REFUSAL]
    : []
}

/** Runs one program and returns its standard output. */
export type AccountLookupRun = (
  file: string,
  args: readonly string[],
  env: Readonly<Record<string, string>>,
) => Promise<string>

export interface AccountSettingsFileDependencies {
  readonly platform: NodeJS.Platform
  readonly uid: number | undefined
  readonly run: AccountLookupRun
  readonly readFile: (path: string) => Promise<string>
}

// Windows keeps reg.exe here on every supported install. The SystemRoot
// environment variable is not used to find it, because the environment is
// exactly what this lookup must not depend on.
const WINDOWS_ROOT = 'C:\\Windows'
const WINDOWS_SHELL_FOLDERS =
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Shell Folders'

const runProgram: AccountLookupRun = (file, args, env) =>
  new Promise((resolvePromise, reject) => {
    execFile(
      file,
      [...args],
      {
        // A fixed environment with no inherited PATH, so a project's `.env`
        // cannot change which program runs or how it looks the account up.
        env: { ...env },
        encoding: 'utf8',
        maxBuffer: 64 * 1024,
        timeout: 5_000,
        windowsHide: true,
      },
      (error, stdout) => (error ? reject(error) : resolvePromise(stdout)),
    )
  })

function passwdHome(text: string, uid: number): string | undefined {
  for (const line of text.split('\n')) {
    const fields = line.trim().split(':')
    if (fields.length >= 7 && fields[2] === String(uid)) return fields[5]
  }
  return undefined
}

/** One attribute of `dscl -read` output, which wraps a value with spaces. */
function dsclAttribute(text: string, name: string): string | undefined {
  const lines = text.split('\n')
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? ''
    if (!line.startsWith(`${name}:`)) continue
    const value = line.slice(name.length + 1).trim()
    return value || lines[index + 1]?.trim() || undefined
  }
  return undefined
}

async function posixAccountHome(
  dependencies: AccountSettingsFileDependencies,
): Promise<string | undefined> {
  const { uid, run } = dependencies
  if (uid === undefined || !Number.isInteger(uid) || uid < 0) return undefined
  const env = { LC_ALL: 'C' }
  if (dependencies.platform === 'darwin') {
    // `id -un` names the account of the process's user id, not $USER.
    const name = (await run('/usr/bin/id', ['-un'], env)).trim()
    if (!name || /[/:\s]/.test(name)) return undefined
    const record = await run(
      '/usr/bin/dscl',
      ['.', '-read', `/Users/${name}`, 'UniqueID', 'NFSHomeDirectory'],
      env,
    )
    if (dsclAttribute(record, 'UniqueID') !== String(uid)) return undefined
    return dsclAttribute(record, 'NFSHomeDirectory')
  }
  // getent also covers accounts from directory services such as LDAP; a system
  // without it still has the local passwd file.
  const entry = await run('/usr/bin/getent', ['passwd', String(uid)], env)
    .then((text) => passwdHome(text, uid))
    .catch(() => undefined)
  if (entry !== undefined) return entry
  return passwdHome(await dependencies.readFile('/etc/passwd'), uid)
}

async function windowsAppData(
  dependencies: AccountSettingsFileDependencies,
): Promise<string | undefined> {
  // `Shell Folders` holds the already expanded path of the signed-in user's
  // roaming AppData folder, including a redirected one.
  const output = await dependencies.run(
    win32.join(WINDOWS_ROOT, 'System32', 'reg.exe'),
    ['query', WINDOWS_SHELL_FOLDERS, '/v', 'AppData'],
    { SystemRoot: WINDOWS_ROOT },
  )
  const value = /^\s*AppData\s+REG_SZ\s+(.+?)\s*$/im.exec(output)?.[1]
  return value && !value.includes('%') ? value : undefined
}

/**
 * Looks up the settings file the gateway is honoured from, without reading
 * the environment: the default location under the operating system
 * account's own home (POSIX, from the account database for the process's
 * user id) or its roaming AppData folder (Windows, from the user's registry).
 * Undefined when the lookup fails.
 */
export async function lookupGatewaySettingsFile(
  dependencies: AccountSettingsFileDependencies,
): Promise<string | undefined> {
  try {
    if (dependencies.platform === 'win32') {
      const appData = await windowsAppData(dependencies)
      return appData && win32.isAbsolute(appData)
        ? win32.join(appData, 'cortexkit', 'anthropic-auth.jsonc')
        : undefined
    }
    const home = await posixAccountHome(dependencies)
    return home && posix.isAbsolute(home)
      ? posix.join(home, '.config', 'cortexkit', 'anthropic-auth.jsonc')
      : undefined
  } catch {
    return undefined
  }
}

let accountSettingsFile: Promise<string | undefined> | undefined

/**
 * The settings file the gateway is honoured from (see
 * lookupGatewaySettingsFile). Environment variables (HOME, USERPROFILE,
 * APPDATA, XDG_CONFIG_HOME, ANTHROPIC_AUTH_SETTINGS_FILE) never choose it, so
 * an environment a project can influence cannot point the gateway at another
 * file. `os.userInfo()` is not used: under Bun its home follows HOME. The
 * lookup runs once per process, when settings are first read, never on a
 * request. Undefined when the account's home cannot be found.
 */
export function gatewaySettingsFile(): Promise<string | undefined> {
  accountSettingsFile ??= lookupGatewaySettingsFile({
    platform: process.platform,
    uid: process.getuid?.(),
    run: runProgram,
    readFile: (path) => readFile(path, 'utf8'),
  })
  return accountSettingsFile
}

async function canonical(path: string): Promise<string> {
  const real = await realpath(path).catch(() => resolve(path))
  return process.platform === 'win32' ? real.toLowerCase() : real
}

/** True when `file` is the gateway settings file, compared as real paths. */
export async function isGatewaySettingsFile(
  file: string,
  expected: string | undefined,
): Promise<boolean> {
  if (!expected) return false
  return (await canonical(file)) === (await canonical(expected))
}
