import { afterEach, expect, spyOn, test } from 'bun:test'
import { logger, NativeCustodyError } from '@cortexkit/anthropic-auth-core'
import { placeholderSecret } from '@cortexkit/common-auth/opencode2'
import type { Plugin } from '@opencode/plugin'
import type { SessionHooks } from '@opencode/plugin/promise/session'
import type { NativeAnthropicSource } from '../v2/adapter'
import { installNativeAnthropic } from '../v2/install'
import { preparedAnthropicCredential } from '../v2/ownership'
import { createReloadableRequestHooks } from '../v2/reload'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function instance(
  key: string,
  label: string,
  end: () => Promise<void> = async () => {},
  compatibility: {
    version?: string
    before?: ReadonlyArray<keyof SessionHooks>
    after?: ReadonlyArray<keyof SessionHooks>
  } = {},
) {
  const callbacks = new Map<keyof SessionHooks, (draft: unknown) => unknown>()
  const hook: Plugin.Context['session']['hook'] = async (name, callback) => {
    callbacks.set(name, (draft) => callback(draft as SessionHooks[typeof name]))
    // Retain callbacks just as the host does for an already-running turn.
    return { dispose: async () => {} }
  }
  const bridge = createReloadableRequestHooks(
    { session: { hook } } as unknown as Plugin.Context,
    key,
    compatibility.version,
  )
  let closed = false
  const events: string[] = []
  const source: NativeAnthropicSource<never, string> = {
    chooseAccount() {
      events.push('choose')
      return 'main'
    },
    authorizeAccount() {
      events.push('authorize')
      return {
        route: 'oauth',
        accessToken: `sk-ant-oat01-${label}`,
        credentialId: 'synthetic-credential-row',
        provenance: label,
      }
    },
    requestOptions() {
      events.push('rewriteRequest')
      return {}
    },
    retrySameAccount() {
      events.push('retrySameAccount')
      return undefined
    },
    responseOptions(input) {
      events.push(`rewriteResponse:${input.provenance}`)
      if (closed) throw new NativeCustodyError('closed')
      return {}
    },
    async onAttemptEnd(input, outcome) {
      events.push(
        `end:${input.provenance}:${outcome.error?.reason ?? 'complete'}`,
      )
      await end()
    },
  }
  const extraHooks = async (names: ReadonlyArray<keyof SessionHooks> = []) => {
    for (const name of names)
      await bridge.context.session.hook(name, () => {
        events.push(`extra:${name}`)
      })
  }
  await extraHooks(compatibility.before)
  const installation = await installNativeAnthropic(
    bridge.context,
    { source },
    { credential: preparedAnthropicCredential },
  )
  await extraHooks(compatibility.after)
  bridge.activate()
  const dispose = async () => {
    bridge.retire()
    await installation.dispose()
    closed = true
  }
  cleanups.push(dispose)
  const run = async <Name extends keyof SessionHooks>(
    name: Name,
    draft: SessionHooks[Name],
  ) => {
    const callback = callbacks.get(name)
    if (!callback) throw new Error(`Missing hook ${name}`)
    await callback(draft)
  }
  const prepare = async () => {
    const draft = {
      sessionID: 'ses_reload',
      agent: 'build',
      model: { providerID: 'anthropic', id: 'claude-sonnet-4-6' },
      kind: 'primary',
      request: new Request('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${placeholderSecret('anthropic')}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 8,
          messages: [{ role: 'user', content: 'Hello' }],
        }),
      }),
    } as SessionHooks['http.request']
    await run('http.request', draft)
    return draft
  }
  const respond = async (
    draft: SessionHooks['http.request'],
    response = Response.json({ id: 'msg_reload', content: [] }),
  ) => {
    const answered = {
      ...draft,
      response,
    }
    await run('http.response', answered)
    return answered.response.text()
  }
  return { events, dispose, prepare, respond, run }
}

test('forwarded request response and attempt end use the successor source', async () => {
  const key = crypto.randomUUID()
  const a = await instance(key, 'A')
  const b = await instance(key, 'B')
  await a.dispose()
  const request = await a.prepare()
  expect(request.request.headers.get('authorization')).toBe(
    'Bearer sk-ant-oat01-B',
  )
  await a.respond(request)
  await a.run('retry', {
    sessionID: request.sessionID,
    agent: request.agent,
    model: request.model,
    error: { type: 'unknown', message: 'request failed' },
    attempt: 1,
    decision: { retry: false },
  })
  await b.dispose()
  expect(a.events).toEqual([])
  expect(b.events).toEqual([
    'choose',
    'authorize',
    'rewriteRequest',
    'rewriteResponse:B',
    'end:B:complete',
    'retrySameAccount',
  ])
})

test('dispose joins abandonment on A and a late response never reaches B', async () => {
  const key = crypto.randomUUID()
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const a = await instance(key, 'A', () => gate)
  const request = await a.prepare()
  const b = await instance(key, 'B')
  let disposed = false
  const cleanup = a.dispose().then(() => {
    disposed = true
  })
  // Abandonment starts synchronously in common-auth's dispose.
  expect(a.events).toContain('end:A:abandoned')
  await Promise.resolve()
  expect(disposed).toBe(false)
  release()
  await cleanup
  expect(disposed).toBe(true)
  await expect(a.respond(request)).rejects.toThrow(
    'Native custody refused: closed',
  )
  expect(a.events).toContain('rewriteResponse:A')
  expect(a.events.filter((event) => event.startsWith('end:'))).toEqual([
    'end:A:abandoned',
  ])
  expect(b.events).toEqual([])
})

test('forwarded provider errors are scrubbed by the successor redaction scope', async () => {
  const key = crypto.randomUUID()
  const a = await instance(key, 'A')
  const b = await instance(key, 'B')
  await a.dispose()
  const request = await a.prepare()
  const body = await a.respond(
    request,
    Response.json(
      {
        type: 'error',
        error: { type: 'api_error', message: 'sk-ant-oat01-B' },
      },
      { status: 500 },
    ),
  )
  expect(body).not.toContain('sk-ant-oat01-B')
  expect(b.events).toContain('rewriteResponse:B')
  expect(a.events).toEqual([])
})

test('a retry with ambiguous generation ownership keeps the host decision', async () => {
  const key = crypto.randomUUID()
  const a = await instance(key, 'A')
  await a.respond(await a.prepare())
  const b = await instance(key, 'B')
  await a.dispose()
  const request = await a.prepare()
  await a.respond(request)
  const retry: SessionHooks['retry'] = {
    sessionID: request.sessionID,
    agent: request.agent,
    model: request.model,
    error: { type: 'unknown', message: 'request failed' },
    attempt: 1,
    decision: { retry: false },
  }
  await a.run('retry', retry)
  expect(retry.decision).toEqual({ retry: false })
  expect(a.events).not.toContain('retrySameAccount')
  expect(b.events).not.toContain('retrySameAccount')
})

test('a retired hook never forwards to a different storage key', async () => {
  const a = await instance(crypto.randomUUID(), 'A')
  const b = await instance(crypto.randomUUID(), 'B')
  await a.dispose()
  await expect(a.prepare()).rejects.toThrow('Native custody refused: closed')
  expect(b.events).toEqual([])
})

test.each([
  {
    mismatch: 'different plugin versions',
    a: { version: '1.0.0' },
    b: { version: '2.0.0' },
  },
  {
    mismatch: 'different registration counts in the same version',
    a: { version: '1.0.0' },
    b: { version: '1.0.0', after: ['http.request' as const] },
  },
  {
    mismatch: 'different registration order in the same version',
    a: { version: '1.0.0', before: ['context' as const] },
    b: { version: '1.0.0', after: ['context' as const] },
  },
])('retired hooks refuse $mismatch and log once', async (compatibility) => {
  const key = crypto.randomUUID()
  const a = await instance(key, 'A', undefined, compatibility.a)
  const b = await instance(key, 'B', undefined, compatibility.b)
  const debug = spyOn(logger, 'debug').mockImplementation(() => {})
  cleanups.push(async () => {
    debug.mockRestore()
  })
  await a.dispose()
  await expect(a.prepare()).rejects.toThrow('Native custody refused: closed')
  await expect(a.prepare()).rejects.toThrow('Native custody refused: closed')
  expect(a.events).toEqual([])
  expect(b.events).toEqual([])
  expect(
    debug.mock.calls.filter(([, message]) =>
      message.includes('different plugin version'),
    ),
  ).toHaveLength(1)
})
