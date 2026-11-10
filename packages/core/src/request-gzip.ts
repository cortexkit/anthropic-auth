/**
 * Request-body gzip as Claude Code 2.1.302 sends it.
 *
 * Claude Code gzips a request body of at least 4,096 characters when it talks
 * straight to api.anthropic.com. Before compressing it resets `cch`, the
 * body signature inside the `x-anthropic-billing-header` text of the first
 * system block, to `00000` (its signer only signs uncompressed bodies) and
 * appends a newline plus 0 to 256 random spaces and tabs. If something on the
 * way rejects the compressed body, it resends the uncompressed, signed body
 * once and stops compressing for the rest of the process; when a proxy (not
 * Anthropic) rejected it and Anthropic then accepted the uncompressed resend,
 * it also stops for seven days.
 *
 * Every direct send path calls `sendWithRequestGzip` with the final signed
 * body. Callers keep that uncompressed body for dumps, CacheKeep and relay
 * rescue; only the bytes on the wire change.
 */
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { gzip } from 'node:zlib'
import { resetBillingHeaderCCH } from './cch.ts'
import {
  CLAUDE_CODE_GZIP_MIN_BODY_CHARS,
  CLAUDE_CODE_GZIPS_REQUEST_BODIES,
} from './constants.ts'
import {
  LEGACY_STATE_LAYOUT,
  type StateLayout,
  stateHomeFilePaths,
} from './state-layout-paths.ts'

const gzipAsync = promisify(gzip)

/** Claude Code's own opt-out: `0`/`false` turns gzip off, `1`/`true` forces it. */
export const GZIP_REQUEST_BODIES_ENV = 'CLAUDE_CODE_GZIP_REQUEST_BODIES'
const GZIP_HOST = 'api.anthropic.com'
const GZIP_LEVEL = 6
const MAX_PADDING = 256
/** Claude Code reads at most this much of a 400 body to look for a JSON parse error. */
const REJECTION_BODY_BYTES = 8192
/** How long a persisted latch keeps gzip off. */
export const GZIP_LATCH_TTL_MS = 7 * 24 * 60 * 60 * 1000

const INVALID_JSON_MESSAGES = [
  'The request body is not valid JSON',
  'Failed to parse request: could not parse request body as JSON',
]
const BAD_JSON_TEXT =
  /^bad json: (?:invalid character |unexpected EOF$|unexpected end of JSON input$|EOF$)/

export type RequestGzipSkipReason =
  | 'version'
  | 'host'
  | 'env_off'
  | 'below_min_size'
  | 'proxy'
  | 'mtls'
  | 'custom_ca'
  | 'latched_off'

export type RequestGzipDecision =
  | { gzip: true; forced: boolean }
  | { gzip: false; reason: RequestGzipSkipReason }

export type GzipRejectionKind =
  | 'non_anthropic_rejection'
  | 'invalid_json_at_origin'

/**
 * What the caller's transport adds beyond the environment: a proxy, a custom
 * certificate authority or a client certificate the caller passes to fetch
 * itself. Claude Code sends uncompressed bodies through any of these.
 */
export interface RequestGzipTransport {
  proxy?: boolean
  customCa?: boolean
  mtls?: boolean
}

type Env = Record<string, string | undefined>

function parseTriBool(value: string | undefined): boolean | undefined {
  const normalized = value?.trim().toLowerCase()
  if (!normalized) return undefined
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false
  return undefined
}

function hostOf(url: string | URL): string | undefined {
  try {
    return new URL(url).host
  } catch {
    return undefined
  }
}

function noProxyList(env: Env): string | undefined {
  if (env.no_proxy === '*' || env.NO_PROXY === '*') return '*'
  const lower = env.no_proxy
  const upper = env.NO_PROXY
  if (lower && upper && lower !== upper) return `${lower},${upper}`
  return lower || upper
}

/**
 * Whether NO_PROXY exempts this URL: `*`, an exact host, `host:port`, or a
 * `.suffix` that matches the domain and its subdomains (Claude Code's rules).
 */
function bypassesProxy(url: string | URL, env: Env): boolean {
  const list = noProxyList(env)
  if (!list) return false
  if (list === '*') return true
  try {
    const parsed = new URL(url)
    const host = parsed.hostname.toLowerCase()
    const secure = parsed.protocol === 'https:' || parsed.protocol === 'wss:'
    const hostPort = `${host}:${parsed.port || (secure ? '443' : '80')}`
    return list
      .split(/[,\s]+/)
      .filter(Boolean)
      .some((raw) => {
        const entry = raw.toLowerCase().trim()
        if (entry.includes(':')) return hostPort === entry
        if (entry.startsWith('.'))
          return host === entry.slice(1) || host.endsWith(entry)
        return host === entry
      })
  } catch {
    return false
  }
}

function proxyConfigured(env: Env): boolean {
  return Boolean(
    env.HTTPS_PROXY?.trim() ||
      env.https_proxy?.trim() ||
      env.HTTP_PROXY?.trim() ||
      env.http_proxy?.trim(),
  )
}

function transportSkipReason(
  url: string | URL,
  env: Env,
  transport: RequestGzipTransport,
): RequestGzipSkipReason | undefined {
  if (transport.proxy || (proxyConfigured(env) && !bypassesProxy(url, env)))
    return 'proxy'
  if (
    transport.mtls ||
    env.CLAUDE_CODE_CLIENT_CERT?.trim() ||
    env.CLAUDE_CODE_CLIENT_KEY?.trim()
  )
    return 'mtls'
  if (transport.customCa || env.NODE_EXTRA_CA_CERTS?.trim()) return 'custom_ca'
  return undefined
}

/**
 * Remembers that a gzipped body was rejected. Any rejection turns gzip off
 * for this process; a proxy rejection followed by an accepted uncompressed
 * resend also writes `{latchedAt, status}` to `path`, which keeps gzip off
 * for seven days in later processes. The file belongs to this plugin, not to
 * the user's settings. An expired, future-dated or unreadable record is
 * removed when read.
 */
export class RequestGzipLatch {
  #processLatched = false
  #persistedChecked: Promise<boolean> | undefined

  constructor(
    readonly path?: string,
    readonly now: () => number = Date.now,
  ) {}

  get latchedThisProcess(): boolean {
    return this.#processLatched
  }

  latchProcess(): void {
    this.#processLatched = true
  }

  /** Whether the latch file holds a record younger than seven days (read once). */
  persistedInEffect(): Promise<boolean> {
    this.#persistedChecked ??= this.#readPersisted()
    return this.#persistedChecked
  }

  async #readPersisted(): Promise<boolean> {
    if (!this.path) return false
    let text: string
    try {
      text = await readFile(this.path, 'utf8')
    } catch {
      return false
    }
    let latchedAt: unknown
    try {
      latchedAt = (JSON.parse(text) as { latchedAt?: unknown }).latchedAt
    } catch {
      latchedAt = undefined
    }
    const age =
      typeof latchedAt === 'number' && Number.isFinite(latchedAt)
        ? this.now() - latchedAt
        : -1
    if (age >= 0 && age < GZIP_LATCH_TTL_MS) return true
    await rm(this.path, { force: true }).catch(() => {})
    return false
  }

  async persist(status: number): Promise<void> {
    this.#processLatched = true
    this.#persistedChecked = Promise.resolve(true)
    if (!this.path) return
    const temporary = `${this.path}.${process.pid}.tmp`
    try {
      await mkdir(dirname(this.path), { recursive: true })
      await writeFile(
        temporary,
        `${JSON.stringify({ latchedAt: this.now(), status })}\n`,
        { mode: 0o600 },
      )
      await rename(temporary, this.path)
    } catch {
      // `#processLatched` was set above, so this process still sends
      // uncompressed; only the record that later processes would read is lost.
      await rm(temporary, { force: true }).catch(() => {})
    }
  }
}

const sharedLatches = new Map<string, RequestGzipLatch>()

/** One latch per storage path, shared by every send path in this process. */
export function getRequestGzipLatch(path?: string): RequestGzipLatch {
  const key = path ?? ''
  let latch = sharedLatches.get(key)
  if (!latch) {
    latch = new RequestGzipLatch(path)
    sharedLatches.set(key, latch)
  }
  return latch
}

/** The advisory latch starts empty in state-home; legacy and Pi keep their account-file sibling. */
export function getRequestGzipLatchPath(
  accountStoragePath: string,
  layout: StateLayout = LEGACY_STATE_LAYOUT,
): string {
  if (layout.kind === 'state-home')
    return stateHomeFilePaths(layout.dir).requestGzip
  const name = basename(accountStoragePath)
  const stem = name.endsWith('.json') ? name.slice(0, -5) : name
  return join(dirname(accountStoragePath), `${stem}-request-gzip.json`)
}

/** Decide, in Claude Code's order, whether this request body goes out gzipped. */
export async function decideRequestGzip(options: {
  url: string | URL
  body: unknown
  latch: RequestGzipLatch
  env?: Env
  transport?: RequestGzipTransport
}): Promise<RequestGzipDecision> {
  if (!CLAUDE_CODE_GZIPS_REQUEST_BODIES)
    return { gzip: false, reason: 'version' }
  if (hostOf(options.url) !== GZIP_HOST) return { gzip: false, reason: 'host' }
  const env = options.env ?? process.env
  const setting = parseTriBool(env[GZIP_REQUEST_BODIES_ENV])
  if (setting === false) return { gzip: false, reason: 'env_off' }
  if (
    typeof options.body !== 'string' ||
    options.body.length < CLAUDE_CODE_GZIP_MIN_BODY_CHARS
  )
    return { gzip: false, reason: 'below_min_size' }
  // Forcing gzip on skips the transport checks and the persisted latch, but
  // not a rejection seen by this process.
  if (setting === true)
    return options.latch.latchedThisProcess
      ? { gzip: false, reason: 'latched_off' }
      : { gzip: true, forced: true }
  const transport = transportSkipReason(
    options.url,
    env,
    options.transport ?? {},
  )
  if (transport) return { gzip: false, reason: transport }
  if (
    options.latch.latchedThisProcess ||
    (await options.latch.persistedInEffect())
  )
    return { gzip: false, reason: 'latched_off' }
  return { gzip: true, forced: false }
}

/** A newline and 0 to 256 random spaces and tabs, as Claude Code appends. */
export function requestGzipPadding(random: () => number = Math.random): string {
  const length = Math.floor(random() * (MAX_PADDING + 1))
  let padding = '\n'
  for (let index = 0; index < length; index += 1)
    padding += random() < 0.5 ? ' ' : '\t'
  return padding
}

/**
 * The gzipped wire bytes for a signed identity body: `cch` reset to `00000`,
 * padding appended, one gzip member at level 6. Never sign the result.
 */
export async function encodeGzipRequestBody(
  identityBody: string,
  random: () => number = Math.random,
): Promise<Uint8Array> {
  const text = resetBillingHeaderCCH(identityBody) + requestGzipPadding(random)
  const compressed = new Uint8Array(
    await gzipAsync(Buffer.from(text, 'utf8'), { level: GZIP_LEVEL }),
  )
  // zlib writes OS byte 3 (Unix); Claude Code's runtime writes 255 (unknown)
  // for ordinary bodies. The OS byte is outside the CRC.
  compressed[9] = 0xff
  return compressed
}

function hasAnthropicEdgeHeader(headers: Headers): boolean {
  return (
    (headers.get('request-id')?.startsWith('req_') ?? false) ||
    headers.get('cf-ray') !== null
  )
}

async function readStart(response: Response): Promise<string> {
  const reader = response.clone().body?.getReader()
  if (!reader) return ''
  const decoder = new TextDecoder()
  let text = ''
  let remaining = REJECTION_BODY_BYTES
  try {
    while (remaining > 0) {
      const { done, value } = await reader.read()
      if (done) break
      const chunk = value.subarray(0, remaining)
      remaining -= chunk.byteLength
      text += decoder.decode(chunk, { stream: true })
    }
  } catch {
  } finally {
    reader.cancel().catch(() => {})
  }
  return text
}

function isInvalidJsonBody(text: string): boolean {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return BAD_JSON_TEXT.test(text.trimEnd())
  }
  if (!parsed || typeof parsed !== 'object') return false
  const record = parsed as Record<string, unknown>
  const error = record.error
  if (
    record.type === 'error' &&
    error &&
    typeof error === 'object' &&
    typeof (error as { type?: unknown }).type === 'string' &&
    typeof (error as { message?: unknown }).message === 'string'
  ) {
    const message = (error as { message: string }).message
    return INVALID_JSON_MESSAGES.some((prefix) => message.startsWith(prefix))
  }
  return (
    typeof record.error === 'string' &&
    record.reason === 'bad_json' &&
    BAD_JSON_TEXT.test(record.error)
  )
}

/**
 * Claude Code's test for a rejected gzipped body: a 400, 403 or 415 that
 * either did not come from Anthropic (no `req_` request id and no `cf-ray`)
 * or, for a 400, says the JSON could not be parsed. Any other response,
 * including an ordinary API 400, is not a gzip problem. Reads at most 8 KiB
 * from a clone, so the response itself stays unread.
 */
export async function classifyGzipRejection(
  response: Response,
): Promise<GzipRejectionKind | null> {
  const { status } = response
  if (status !== 400 && status !== 403 && status !== 415) return null
  if (!hasAnthropicEdgeHeader(response.headers))
    return 'non_anthropic_rejection'
  if (status === 400 && isInvalidJsonBody(await readStart(response)))
    return 'invalid_json_at_origin'
  return null
}

function withoutContentEncoding(headers: Headers): Headers {
  const copy = new Headers(headers)
  copy.delete('content-encoding')
  copy.delete('content-length')
  return copy
}

export interface RequestGzipEvent {
  decision: RequestGzipDecision
  rejection?: { kind: GzipRejectionKind; status: number }
  resendStatus?: number
  persisted?: boolean
}

/**
 * Send a signed identity body, gzipped when Claude Code would gzip it.
 *
 * `send` performs one physical request with the given body and headers; it is
 * called once, or twice when the gzipped body is rejected: the second call
 * gets the identity body and the same headers (same `x-client-request-id`,
 * same retry count) minus `content-encoding`. That resend is not a retry.
 */
export async function sendWithRequestGzip(options: {
  url: string | URL
  body: string
  headers: Headers
  send: (body: string | Uint8Array, headers: Headers) => Promise<Response>
  latch: RequestGzipLatch
  env?: Env
  transport?: RequestGzipTransport
  random?: () => number
  onEvent?: (event: RequestGzipEvent) => void
}): Promise<Response> {
  const decision = await decideRequestGzip(options)
  if (!decision.gzip) {
    options.onEvent?.({ decision })
    return options.send(options.body, withoutContentEncoding(options.headers))
  }
  const compressed = await encodeGzipRequestBody(options.body, options.random)
  const gzipHeaders = new Headers(options.headers)
  gzipHeaders.set('content-encoding', 'gzip')
  // The runtime frames the compressed bytes itself.
  gzipHeaders.delete('content-length')
  const first = await options.send(compressed, gzipHeaders)
  const kind = await classifyGzipRejection(first)
  if (!kind) {
    options.onEvent?.({ decision })
    return first
  }
  options.latch.latchProcess()
  await first.body?.cancel().catch(() => {})
  const resend = await options.send(
    options.body,
    withoutContentEncoding(options.headers),
  )
  // Persist only when the uncompressed resend reached Anthropic and was not
  // rejected the same way, which shows the compression was the problem.
  const persist =
    kind === 'non_anthropic_rejection' &&
    !decision.forced &&
    (resend.headers.get('request-id')?.startsWith('req_') ?? false) &&
    (await classifyGzipRejection(resend)) === null
  if (persist) await options.latch.persist(first.status)
  options.onEvent?.({
    decision,
    rejection: { kind, status: first.status },
    resendStatus: resend.status,
    persisted: persist,
  })
  return resend
}
