import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import {
  buildBillingHeaderValue,
  extractBillingHeaderCCH,
  resetBillingHeaderCCH,
  signRequestBody,
} from '../cch.ts'
import {
  CLAUDE_CODE_ENTRYPOINT,
  CLAUDE_CODE_GZIP_MIN_BODY_CHARS,
  CLAUDE_CODE_GZIPS_REQUEST_BODIES,
  CLAUDE_CODE_VERSION,
} from '../constants.ts'
import {
  classifyGzipRejection,
  GZIP_LATCH_TTL_MS,
  getRequestGzipLatchPath,
  RequestGzipLatch,
  sendWithRequestGzip,
} from '../request-gzip.ts'

const API_URL = 'https://api.anthropic.com/v1/messages?beta=true'

/** One request as the loopback server received it, body bytes untouched. */
type Captured = { headers: Headers; body: Uint8Array }

type Reply = { status: number; headers?: Record<string, string>; body: string }

const OK: Reply = {
  status: 200,
  headers: { 'request-id': 'req_011CTestOk000000000001' },
  body: '{"type":"message"}',
}

let server: ReturnType<typeof Bun.serve>
let captured: Captured[] = []
let replies: Reply[] = []

beforeAll(() => {
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      captured.push({
        headers: new Headers(request.headers),
        body: new Uint8Array(await request.arrayBuffer()),
      })
      const reply = replies.shift() ?? OK
      return new Response(reply.body, {
        status: reply.status,
        headers: reply.headers,
      })
    },
  })
})

afterAll(() => {
  server.stop(true)
})

function reset(next: Reply[] = []) {
  captured = []
  replies = next
}

/** A signed identity body: billing block first, then enough text to size it. */
async function signedBody(chars: number): Promise<string> {
  const messages = [{ role: 'user', content: 'Summarise the README.' }]
  const billing = buildBillingHeaderValue(
    messages,
    CLAUDE_CODE_VERSION,
    CLAUDE_CODE_ENTRYPOINT,
    undefined,
    { promptId: '33333333-3333-4333-8333-333333333333', promptIndex: 1 },
  )
  const base = {
    model: 'claude-sonnet-5-5',
    messages,
    system: [
      { type: 'text', text: billing },
      { type: 'text', text: '' },
    ],
    max_tokens: 32000,
    stream: true,
  }
  const fill = Math.max(0, chars - JSON.stringify(base).length)
  base.system[1] = { type: 'text', text: 'x'.repeat(fill) }
  const body = await signRequestBody(JSON.stringify(base))
  expect(extractBillingHeaderCCH(body)).not.toBe('00000')
  return body
}

function baseHeaders() {
  return new Headers({
    'content-type': 'application/json',
    'x-client-request-id': '22222222-2222-4222-8222-222222222222',
    'x-stainless-retry-count': '0',
  })
}

async function send(
  body: string,
  options: {
    latch?: RequestGzipLatch
    env?: Record<string, string | undefined>
    transport?: { proxy?: boolean; customCa?: boolean; mtls?: boolean }
    random?: () => number
  } = {},
) {
  const latch = options.latch ?? new RequestGzipLatch()
  const response = await sendWithRequestGzip({
    url: API_URL,
    body,
    headers: baseHeaders(),
    latch,
    env: options.env ?? {},
    ...(options.transport ? { transport: options.transport } : {}),
    ...(options.random ? { random: options.random } : {}),
    send: (wireBody, headers) =>
      fetch(`http://127.0.0.1:${server.port}/v1/messages?beta=true`, {
        method: 'POST',
        body: wireBody,
        headers,
      }),
  })
  return { response, latch }
}

function text(bytes: Uint8Array) {
  return new TextDecoder().decode(bytes)
}

/** The signed body sent unchanged, without a content-encoding header. */
function expectIdentity(request: Captured | undefined, body: string) {
  expect(request?.headers.get('content-encoding')).toBeNull()
  expect(text(request?.body ?? new Uint8Array())).toBe(body)
}

describe('request-body gzip as Claude Code 2.1.302 sends it', () => {
  test('the emulated version gzips request bodies', () => {
    expect(CLAUDE_CODE_VERSION).toBe('2.1.302')
    expect(CLAUDE_CODE_GZIPS_REQUEST_BODIES).toBe(true)
    expect(CLAUDE_CODE_GZIP_MIN_BODY_CHARS).toBe(4096)
  })

  test('a large OAuth body goes out gzipped with cch=00000 and valid padding', async () => {
    reset()
    const body = await signedBody(20_000)
    const { response } = await send(body)
    expect(response.status).toBe(200)
    expect(captured).toHaveLength(1)
    const request = captured[0]!
    expect(request.headers.get('content-encoding')).toBe('gzip')
    // content-length counts the compressed bytes, as fetch set it.
    expect(Number(request.headers.get('content-length'))).toBe(
      request.body.byteLength,
    )
    expect(request.body.byteLength).toBeLessThan(body.length / 4)
    expect([...request.body.subarray(0, 3)]).toEqual([0x1f, 0x8b, 0x08])
    expect(request.body[9]).toBe(0xff)

    const plain = text(gunzipSync(request.body))
    const unsigned = resetBillingHeaderCCH(body)
    expect(unsigned).not.toBe(body)
    expect(plain.startsWith(unsigned)).toBe(true)
    expect(extractBillingHeaderCCH(plain)).toBe('00000')
    const padding = plain.slice(unsigned.length)
    expect(padding).toMatch(/^\n[ \t]{0,256}$/)
    // Padding is plain JSON whitespace: the body still parses.
    expect(JSON.parse(plain)).toEqual(JSON.parse(unsigned))
  })

  test('padding length and characters come from the random source', async () => {
    reset()
    const body = await signedBody(6_000)
    // First draw sets the length (0.999… → 256), then alternate space/tab.
    let draw = 0
    const values = [0.9999, 0.1, 0.9]
    await send(body, { random: () => values[Math.min(draw++, 2)] ?? 0 })
    const plain = text(gunzipSync(captured[0]!.body))
    const padding = plain.slice(resetBillingHeaderCCH(body).length)
    expect(padding).toBe(`\n ${'\t'.repeat(255)}`)

    reset()
    await send(body, { random: () => 0 })
    const none = text(gunzipSync(captured[0]!.body))
    expect(none.slice(resetBillingHeaderCCH(body).length)).toBe('\n')
  })

  test('a body below 4,096 characters goes out identity and signed', async () => {
    reset()
    const body = await signedBody(CLAUDE_CODE_GZIP_MIN_BODY_CHARS - 1)
    expect(body.length).toBe(CLAUDE_CODE_GZIP_MIN_BODY_CHARS - 1)
    await send(body)
    expectIdentity(captured[0], body)

    reset()
    const atLimit = await signedBody(CLAUDE_CODE_GZIP_MIN_BODY_CHARS)
    expect(atLimit.length).toBe(CLAUDE_CODE_GZIP_MIN_BODY_CHARS)
    await send(atLimit)
    expect(captured[0]?.headers.get('content-encoding')).toBe('gzip')
  })

  test('a proxy, a custom CA, client certificates and the opt-out each send identity', async () => {
    const body = await signedBody(20_000)
    const cases: Array<{
      name: string
      env?: Record<string, string>
      transport?: { proxy?: boolean; customCa?: boolean; mtls?: boolean }
    }> = [
      { name: 'HTTPS_PROXY', env: { HTTPS_PROXY: 'http://proxy.test:3128' } },
      { name: 'http_proxy', env: { http_proxy: 'http://proxy.test:3128' } },
      { name: 'caller proxy', transport: { proxy: true } },
      { name: 'NODE_EXTRA_CA_CERTS', env: { NODE_EXTRA_CA_CERTS: '/ca.pem' } },
      { name: 'caller CA', transport: { customCa: true } },
      { name: 'client cert', env: { CLAUDE_CODE_CLIENT_CERT: '/c.pem' } },
      { name: 'client key', env: { CLAUDE_CODE_CLIENT_KEY: '/k.pem' } },
      { name: 'opt-out 0', env: { CLAUDE_CODE_GZIP_REQUEST_BODIES: '0' } },
      {
        name: 'opt-out false',
        env: { CLAUDE_CODE_GZIP_REQUEST_BODIES: 'false' },
      },
    ]
    for (const item of cases) {
      reset()
      await send(body, {
        ...(item.env ? { env: item.env } : {}),
        ...(item.transport ? { transport: item.transport } : {}),
      })
      expect(
        `${item.name}: ${captured[0]?.headers.get('content-encoding')}`,
      ).toBe(`${item.name}: null`)
      expectIdentity(captured[0], body)
    }
  })

  test('NO_PROXY covering api.anthropic.com keeps gzip; forcing it on skips the proxy check', async () => {
    const body = await signedBody(20_000)
    reset()
    await send(body, {
      env: {
        HTTPS_PROXY: 'http://proxy.test:3128',
        NO_PROXY: '.anthropic.com',
      },
    })
    expect(captured[0]?.headers.get('content-encoding')).toBe('gzip')
    reset()
    await send(body, {
      env: {
        HTTPS_PROXY: 'http://proxy.test:3128',
        CLAUDE_CODE_GZIP_REQUEST_BODIES: '1',
      },
    })
    expect(captured[0]?.headers.get('content-encoding')).toBe('gzip')
  })

  test('only api.anthropic.com is gzipped', async () => {
    reset()
    const body = await signedBody(20_000)
    const latch = new RequestGzipLatch()
    await sendWithRequestGzip({
      url: 'https://gateway.example.test/v1/messages',
      body,
      headers: baseHeaders(),
      latch,
      env: {},
      send: (wireBody, headers) =>
        fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
          method: 'POST',
          body: wireBody,
          headers,
        }),
    })
    expectIdentity(captured[0], body)
  })
})

describe('a rejected gzipped body', () => {
  const rejections: Array<{ name: string; reply: Reply; persists: boolean }> = [
    {
      name: '400 without request-id or cf-ray',
      reply: { status: 400, body: 'Bad Request' },
      persists: true,
    },
    {
      name: '403 without request-id or cf-ray',
      reply: { status: 403, body: 'Forbidden' },
      persists: true,
    },
    {
      name: '415 with a non-Anthropic request-id',
      reply: {
        status: 415,
        headers: { 'request-id': 'proxy-123' },
        body: 'Unsupported Media Type',
      },
      persists: true,
    },
    {
      name: '400 from Anthropic: request body is not valid JSON',
      reply: {
        status: 400,
        headers: { 'request-id': 'req_011CTestBadJson00000001' },
        body: JSON.stringify({
          type: 'error',
          error: {
            type: 'invalid_request_error',
            message: 'The request body is not valid JSON: expected value',
          },
        }),
      },
      persists: false,
    },
    {
      name: '400 behind Cloudflare: bad_json reason',
      reply: {
        status: 400,
        headers: { 'cf-ray': '8f00000000000000-LHR' },
        body: JSON.stringify({
          reason: 'bad_json',
          error: "bad json: invalid character '\\x1f' looking for value",
        }),
      },
      persists: false,
    },
    {
      name: '400 behind Cloudflare: plain bad json text',
      reply: {
        status: 400,
        headers: { 'cf-ray': '8f00000000000000-LHR' },
        body: 'bad json: unexpected EOF\n',
      },
      persists: false,
    },
  ]

  for (const rejection of rejections) {
    test(`${rejection.name}: one identity resend with the same request id, then latched`, async () => {
      const dir = await mkdtemp(join(tmpdir(), 'request-gzip-latch-'))
      try {
        const latchPath = join(dir, 'anthropic-auth-request-gzip.json')
        const latch = new RequestGzipLatch(latchPath)
        const body = await signedBody(20_000)
        reset([rejection.reply, OK])
        const { response } = await send(body, { latch })
        expect(response.status).toBe(200)
        expect(captured).toHaveLength(2)
        const [first, resend] = captured
        expect(first?.headers.get('content-encoding')).toBe('gzip')
        expectIdentity(resend, body)
        expect(resend?.headers.get('x-client-request-id')).toBe(
          first?.headers.get('x-client-request-id'),
        )
        expect(resend?.headers.get('x-stainless-retry-count')).toBe('0')
        expect(latch.latchedThisProcess).toBe(true)

        const persisted = await readFile(latchPath, 'utf8').then(
          (value) => JSON.parse(value) as { status: number },
          () => undefined,
        )
        if (rejection.persists)
          expect(persisted?.status).toBe(rejection.reply.status)
        else expect(persisted).toBeUndefined()

        // Latched: the next large body goes out identity on the first try.
        reset()
        await send(body, { latch })
        expect(captured).toHaveLength(1)
        expectIdentity(captured[0], body)
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    })
  }

  test('an ordinary API 400 is passed through without a resend or latch', async () => {
    const body = await signedBody(20_000)
    const reply: Reply = {
      status: 400,
      headers: { 'request-id': 'req_011CTestOrdinary0000001' },
      body: JSON.stringify({
        type: 'error',
        error: {
          type: 'invalid_request_error',
          message: 'max_tokens: must be at most 128000',
        },
      }),
    }
    reset([reply])
    const { response, latch } = await send(body)
    expect(captured).toHaveLength(1)
    expect(response.status).toBe(400)
    expect(await response.text()).toBe(reply.body)
    expect(latch.latchedThisProcess).toBe(false)
  })

  test('a Cloudflare 403 without a JSON parse error is not treated as a gzip rejection', async () => {
    const response = new Response('blocked', {
      status: 403,
      headers: { 'cf-ray': '8f00000000000000-LHR' },
    })
    expect(await classifyGzipRejection(response)).toBeNull()
    expect(await response.text()).toBe('blocked')
  })

  test('a proxy rejection followed by a rejected resend is not persisted', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'request-gzip-latch-'))
    try {
      const latchPath = join(dir, 'latch.json')
      const latch = new RequestGzipLatch(latchPath)
      const body = await signedBody(20_000)
      reset([
        { status: 400, body: 'Bad Request' },
        { status: 400, body: 'Bad Request' },
      ])
      const { response } = await send(body, { latch })
      expect(captured).toHaveLength(2)
      expect(response.status).toBe(400)
      expect(latch.latchedThisProcess).toBe(true)
      expect(await readFile(latchPath, 'utf8').catch(() => 'absent')).toBe(
        'absent',
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('the persisted latch', () => {
  for (const moved of [false, true]) {
    test(`a gzip rejection writes only to the ${moved ? 'state-home' : 'legacy config'} folder`, async () => {
      const root = await mkdtemp(join(tmpdir(), 'request-gzip-layout-'))
      const config = join(root, 'config')
      const stateHome = join(root, 'state')
      try {
        await mkdir(config)
        await mkdir(stateHome)
        const path = getRequestGzipLatchPath(
          join(config, 'anthropic-auth.json'),
          moved ? { kind: 'state-home', dir: stateHome } : { kind: 'legacy' },
        )
        const now = 1_800_000_000_000
        reset([{ status: 415, body: 'Unsupported Media Type' }, OK])
        await send(await signedBody(20_000), {
          latch: new RequestGzipLatch(path, () => now),
        })
        expect(captured).toHaveLength(2)
        expect(captured[0]?.headers.get('content-encoding')).toBe('gzip')
        expect(captured[1]?.headers.get('content-encoding')).toBeNull()
        const name = 'anthropic-auth-request-gzip.json'
        expect(
          JSON.parse(
            await readFile(join(moved ? stateHome : config, name), 'utf8'),
          ),
        ).toEqual({ latchedAt: now, status: 415 })
        expect(await readdir(moved ? config : stateHome)).toEqual([])
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    })
  }

  test('a moved gzip latch starts empty without copying or changing the old latch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'request-gzip-empty-'))
    try {
      const now = 1_800_000_000_000
      const old = join(root, 'anthropic-auth-request-gzip.json')
      const bytes = JSON.stringify({ latchedAt: now, status: 415 })
      await writeFile(old, bytes)
      const stateHome = join(root, 'state')
      await mkdir(stateHome)
      const path = getRequestGzipLatchPath(join(root, 'anthropic-auth.json'), {
        kind: 'state-home',
        dir: stateHome,
      })
      reset()
      await send(await signedBody(20_000), {
        latch: new RequestGzipLatch(path, () => now),
      })
      expect(captured[0]?.headers.get('content-encoding')).toBe('gzip')
      expect(await readFile(old, 'utf8')).toBe(bytes)
      expect(await readdir(stateHome)).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('keeps gzip off for seven days, then clears itself', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'request-gzip-latch-'))
    try {
      const path = join(dir, 'latch.json')
      const body = await signedBody(20_000)
      const now = 1_800_000_000_000
      await writeFile(
        path,
        JSON.stringify({ latchedAt: now - GZIP_LATCH_TTL_MS + 1, status: 400 }),
      )
      reset()
      await send(body, { latch: new RequestGzipLatch(path, () => now) })
      expectIdentity(captured[0], body)

      await writeFile(
        path,
        JSON.stringify({ latchedAt: now - GZIP_LATCH_TTL_MS, status: 400 }),
      )
      reset()
      await send(body, { latch: new RequestGzipLatch(path, () => now) })
      expect(captured[0]?.headers.get('content-encoding')).toBe('gzip')
      expect(await readFile(path, 'utf8').catch(() => 'cleared')).toBe(
        'cleared',
      )

      await writeFile(path, 'not json')
      reset()
      await send(body, { latch: new RequestGzipLatch(path, () => now) })
      expect(captured[0]?.headers.get('content-encoding')).toBe('gzip')
      expect(await readFile(path, 'utf8').catch(() => 'cleared')).toBe(
        'cleared',
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('lives next to the account storage file', () => {
    expect(
      getRequestGzipLatchPath('/config/anthropic-auth.json').replaceAll(
        '\\',
        '/',
      ),
    ).toBe('/config/anthropic-auth-request-gzip.json')
  })
})
