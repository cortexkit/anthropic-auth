import { expect, spyOn } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  __setLogTestSink,
  captureNativeLocalPoolBinding,
  createNativeAccountRuntime,
  createNativePoolStore,
  getLogLevel,
  type LogTestRecord,
  type NativeAccountRuntime,
  type ProviderAccountUuid,
  resolveNativePoolPaths,
  runNativeMigration,
  setLogLevel,
} from '@cortexkit/anthropic-auth-core'
import {
  installOpenCode2Auth,
  type OpenCode2HookContext,
} from '@cortexkit/common-auth/opencode2'
import { fingerprintOf } from '@cortexkit/common-auth/store'
import type { SessionHooks } from '@opencode/plugin/promise/session'
import { nativeQuotaCodec } from '../../../core/src/native-quota-codec'
import { NativeRuntimeError } from '../../../core/src/native-runtime'
import { PROVIDER_ERROR_REDACTION } from '../../../core/src/provider-error.ts'
import {
  createTestLifetimeSuite,
  TestLifetime,
} from '../../../core/src/tests/test-lifetime.ts'
import { tokenFingerprint } from '../../../core/src/token-fingerprint'
import * as adapterModule from '../v2/adapter'
import { createNativePrime } from '../v2/prime'
import { createNativeAnthropicSource, type NativeSource } from '../v2/source'

// OpenCode 2 Prime sends one minimal request per quota window on its own
// sender, outside the host's request hooks. These tests drive that sender
// against a loopback HTTP server standing in for Anthropic, over the actual
// native account runtime and account source, and check what the provider's
// error responses can reach: the source's callbacks, the stored quota, and
// how long the send's credentials stay held.

const suite = createTestLifetimeSuite()
const { test, gate, deferCleanup } = suite

/**
 * The test lifetime a provider joins its work to: the running test's
 * (`suite`), or a private `TestLifetime` in the control test below. Both are
 * called only while the provider is being created, inside the test body.
 */
type Owner = Pick<TestLifetime, 'gate' | 'trackDetached'>

const IDENTITY = '11111111-2222-4333-8444-555555555555'
// Synthetic OAuth access tokens. The provider stand-in repeats whichever one
// it actually received, so every scrubbed value below was really sent.
const FIRST = 'sk-ant-oat01-primeBoundarySyntheticFirstAccess0123'
const ROTATED = 'sk-ant-oat01-primeBoundarySyntheticRotatedAccess456'
const DAY = 24 * 60 * 60_000
const CHUNK = new Uint8Array(64 * 1024).fill(0x20)
const encoder = new TextEncoder()

/** One provider response body whose end the test can observe and force. */
interface TrackedBody {
  readonly stream: ReadableStream<Uint8Array>
  /** How the body ended: cancelled by the client, or stopped by teardown. */
  readonly ended: Promise<'cancel' | 'stopped'>
  end(reason: 'cancel' | 'stopped'): void
}

/**
 * An error body that starts with `prefix` and never ends by itself. `flood`
 * sends 64 KiB of filler every 5 ms, so it passes the 1 MiB error-body bound
 * quickly without growing memory fast; `stall` sends nothing after the
 * prefix. Each pull's work is passed to `own`; ending the body makes a
 * pending pull return.
 */
function trackedBody(
  own: (work: Promise<void>) => void,
  prefix: string,
  mode: 'flood' | 'stall',
  log?: string[],
): TrackedBody {
  let finish!: (reason: 'cancel' | 'stopped') => void
  const ended = new Promise<'cancel' | 'stopped'>((resolve) => {
    finish = resolve
  })
  let done = false
  const end = (reason: 'cancel' | 'stopped') => {
    done = true
    finish(reason)
  }
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(prefix))
    },
    pull(controller) {
      if (done) return
      const work =
        mode === 'stall'
          ? ended.then(() => {
              log?.push('provider body pull settled')
            })
          : (async () => {
              await Bun.sleep(5)
              if (done) return
              try {
                controller.enqueue(CHUNK)
              } catch {
                // The client went away during the delay.
              }
            })()
      own(work)
      return work
    },
    cancel() {
      end('cancel')
    },
  })
  return { stream, ended, end }
}

type Reply = (token: string, index: number) => Response | Promise<Response>

/**
 * Loopback stand-in for api.anthropic.com. The provider keeps every request
 * handler, response body pull, transport pull and transport cancel it
 * starts. One shutdown is joined to `owner` when the provider is created,
 * behind a gate that only teardown opens: it ends every response body,
 * force-stops the server, waits for each of those separately, then waits
 * until no kept work is left, and fails if any of it failed.
 *
 * The sender's fetch gets each response with its body passed through a
 * stand-in transport. `transportCancels[index]` counts the cancels that reach
 * response `index` there. `onTransportCancel` runs when a cancel arrives; the
 * cancel settles after both it and the cancel of the real response body have
 * settled, and fails if either failed.
 */
function startProvider(
  owner: Owner,
  reply: Reply,
  onTransportCancel?: (index: number) => Promise<unknown> | undefined,
  log?: string[],
) {
  const sent: string[] = []
  const bodies: TrackedBody[] = []
  const transportCancels: number[] = []
  const shutdown = owner.gate()
  // Stream and server callbacks run outside the test body's async context,
  // so their work is kept here rather than registered with `owner` directly.
  const works = new Set<Promise<void>>()
  const failures: unknown[] = []
  let reported = 0
  /**
   * Waits until no kept work is left, then fails with any failures not
   * reported by an earlier call. Safe to call again for work started later.
   */
  const drain = async () => {
    while (works.size) await Promise.all([...works])
    if (failures.length > reported) {
      const fresh = failures.slice(reported)
      reported = failures.length
      throw new AggregateError(fresh, 'Loopback provider work failed')
    }
  }
  const own = <T>(work: Promise<T>) => {
    const settled = work.then(
      () => {},
      (error: unknown) => {
        failures.push(error)
      },
    )
    works.add(settled)
    void settled.then(() => works.delete(settled))
    return work
  }
  const handle = async (request: Request) => {
    if (new URL(request.url).pathname !== '/v1/messages')
      return new Response('unexpected provider path', { status: 404 })
    await request.arrayBuffer()
    const token = (request.headers.get('authorization') ?? '').replace(
      /^Bearer /,
      '',
    )
    sent.push(token)
    return reply(token, sent.length - 1)
  }
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (request) => own(handle(request)),
  })
  const origin = server.url.origin
  const stop = async () => {
    for (const body of bodies) body.end('stopped')
    const results = await Promise.allSettled([
      server.stop(true),
      ...bodies.map((body) => body.ended),
    ])
    for (const result of results)
      if (result.status === 'rejected') failures.push(result.reason)
    await drain()
  }
  owner.trackDetached(shutdown.wait.then(stop))
  const transport = (response: Response, index: number) => {
    transportCancels[index] = 0
    if (!response.body) return response
    const reader = response.body.getReader()
    return new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          return own(
            (async () => {
              let chunk: Awaited<ReturnType<typeof reader.read>>
              try {
                chunk = await reader.read()
              } catch (error) {
                try {
                  controller.error(error)
                } catch {
                  // Already cancelled by the sender.
                }
                return
              } finally {
                log?.push(`transport pull settled ${index}`)
              }
              try {
                if (chunk.done) controller.close()
                else controller.enqueue(chunk.value)
              } catch {
                // Cancelled by the sender while this read was pending.
              }
            })(),
          )
        },
        cancel(reason) {
          transportCancels[index] = (transportCancels[index] ?? 0) + 1
          let hook: Promise<unknown>
          try {
            hook = Promise.resolve(onTransportCancel?.(index))
          } catch (error) {
            hook = Promise.reject(error)
          }
          return own(
            (async () => {
              const results = await Promise.allSettled([
                reader.cancel(reason),
                hook,
              ])
              log?.push(`transport cancel settled ${index}`)
              const failures = results.flatMap((result) =>
                result.status === 'rejected' ? [result.reason] : [],
              )
              if (failures.length)
                throw new AggregateError(failures, 'Transport cancel failed')
            })(),
          )
        },
      }),
      {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      },
    )
  }
  let fetched = 0
  // Only Anthropic's API origin is accepted, and it is served by the loopback
  // server, so no request from these tests leaves the machine.
  const providerFetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const request =
        input instanceof Request
          ? new Request(input, init)
          : new Request(String(input), init)
      const url = new URL(request.url)
      if (url.origin !== 'https://api.anthropic.com')
        throw new Error(`Prime tests refused a request to ${url.origin}`)
      const index = fetched++
      return transport(
        await fetch(
          new Request(`${origin}${url.pathname}${url.search}`, request),
        ),
        index,
      )
    },
    {
      preconnect() {
        throw new Error('Prime tests never preconnect')
      },
    },
  )
  return {
    sent,
    drain,
    transportCancels,
    fetch: providerFetch,
    body(prefix: string, mode: 'flood' | 'stall') {
      const body = trackedBody(own, prefix, mode, log)
      bodies.push(body)
      return body
    },
  }
}
/** An Anthropic error that repeats the credential it was sent with. */
const echoError = (type: string, token: string) =>
  JSON.stringify({
    type: 'error',
    error: { type, message: `credential ${token} was refused` },
  })

/** Error headers that repeat the credential, next to genuine quota fields. */
const echoHeaders = (token: string, requestId: string) => ({
  'content-type': 'application/json',
  'request-id': requestId,
  'x-echoed-authorization': `Bearer ${token}`,
  'anthropic-ratelimit-unified-5h-utilization': '1',
  'anthropic-ratelimit-unified-representative-claim': token,
})

const usageReply = (requestId: string) =>
  Response.json(
    {
      id: 'msg_prime_boundary',
      type: 'message',
      role: 'assistant',
      model: 'claude-haiku-4-5',
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 11, output_tokens: 3 },
    },
    {
      headers: {
        'request-id': requestId,
        'anthropic-ratelimit-unified-5h-utilization': '0.25',
      },
    },
  )

const headerLines = (headers: Headers) =>
  [...headers].map(([name, value]) => `${name}: ${value}`).join('\n')

/**
 * A migrated local account pool holding one OAuth account with the FIRST
 * access token, served by the actual native account runtime and account
 * source, with Prime turned on. Refreshing that account (after a 401) yields
 * ROTATED without any network request. Every source callback Prime reaches
 * is recorded in `seen`; `readBody` makes the limit classifier read the error
 * body, as a classifier may.
 */
async function primeFixture(
  provider: ReturnType<typeof startProvider>,
  readBody: boolean,
) {
  const directory = await mkdtemp(join(tmpdir(), 'oc2-prime-boundary-'))
  // Undone newest first, each step even when an earlier one failed: Prime
  // stops before the source and runtime it uses close, and the directory is
  // removed last.
  const undo: Array<() => unknown> = []
  deferCleanup(async () => {
    const failures: unknown[] = []
    for (const step of undo.reverse()) {
      try {
        await step()
      } catch (error) {
        failures.push(error)
      }
    }
    if (failures.length)
      throw new AggregateError(failures, 'Prime fixture teardown failed')
  })
  undo.push(() => rm(directory, { recursive: true, force: true }))
  const paths = await resolveNativePoolPaths(
    join(directory, 'anthropic-auth.json'),
    join(directory, 'anthropic-auth-state.json'),
  )
  await writeFile(
    paths.legacyConfig,
    JSON.stringify({ version: 1, accounts: [] }),
    { mode: 0o600 },
  )
  await writeFile(
    paths.legacyState,
    JSON.stringify({ version: 1, accounts: {} }),
    { mode: 0o600 },
  )
  await runNativeMigration({
    paths,
    host: 'opencode',
    hostAuthPath: join(directory, 'auth.json'),
    routingSourcePath: join(directory, 'legacy-routing.json'),
    routingDestinationPath: join(directory, 'native-routing.json'),
    env: {},
    processFence: async () => {},
    removePiAnthropicAuth: false,
  })
  const store = createNativePoolStore({ paths, quota: nativeQuotaCodec })
  await store.add({
    id: 'primary-row',
    identity: IDENTITY,
    credential: {
      type: 'oauth',
      access: FIRST,
      refresh: 'primeBoundarySyntheticRefresh',
      expires: Date.now() + DAY,
    },
  })
  await store.updateSettings(() => ({
    mainAccountId: 'primary-row',
    quota: { enabled: false },
    routing: { mode: 'main-first' },
  }))
  const read = await store.read()
  const row = read.status === 'ready' ? read.rows[0] : undefined
  if (
    row?.credential?.type !== 'oauth' ||
    !row.credential.access ||
    row.credential.expires === undefined
  )
    throw new Error('The Prime fixture has no stored OAuth account')
  const binding = captureNativeLocalPoolBinding(paths, row)
  await writeFile(
    paths.runtime,
    JSON.stringify({
      version: 1,
      storageId: paths.storageId,
      accounts: {
        'primary-row': {
          binding,
          credentialValidation: {
            binding,
            credentialFingerprint: fingerprintOf(row.credential),
            version: {
              accessFingerprint: tokenFingerprint(row.credential.access),
              expires: row.credential.expires,
            },
          },
        },
      },
    }),
    { mode: 0o600 },
  )
  const refreshes: string[] = []
  const runtime: NativeAccountRuntime = createNativeAccountRuntime({
    paths,
    host: 'opencode',
    local: {
      resolveIdentity: async () => ({
        deviceId: 'synthetic-device',
        sessionId: 'synthetic-session',
        accountUuid: IDENTITY as ProviderAccountUuid,
      }),
      refreshToken: async (input) => {
        refreshes.push(input.refreshToken)
        return {
          access: ROTATED,
          refresh: 'primeBoundarySyntheticRefreshNext',
          expires: Date.now() + DAY,
          expiresIn: DAY / 1000,
        }
      },
    },
    vault: {
      env: {
        OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE: join(
          directory,
          'opencode-enrollment.json',
        ),
      },
    },
  })
  undo.push(() => runtime.close())
  await runtime.updateSettings((settings) => ({
    ...settings,
    prime: { enabled: true },
  }))
  const seen: string[] = []
  const classified: string[] = []
  const outcomes: Array<{ status?: number; reason?: string }> = []
  const source = createNativeAnthropicSource({
    runtime,
    paths,
    fetch: provider.fetch,
    requestOptions: () => ({}),
    onRequestId: (_scope, requestId) => seen.push(`request-id ${requestId}`),
  })
  undo.push(() => source.close())
  const observed: NativeSource = {
    ...source,
    quotaFromHeaders(headers, input) {
      seen.push(`quota ${input.status}\n${headerLines(headers)}`)
      return source.quotaFromHeaders?.(headers, input)
    },
    async limitFromResponse(input) {
      seen.push(`limit ${input.status}\n${headerLines(input.headers)}`)
      if (readBody) {
        const text = await input.body()
        classified.push(text)
        seen.push(`limit body\n${text}`)
      }
      return source.limitFromResponse?.(input)
    },
    async onAttemptEnd(input, outcome) {
      outcomes.push({
        ...(outcome.status !== undefined ? { status: outcome.status } : {}),
        ...(outcome.error ? { reason: outcome.error.reason } : {}),
      })
      seen.push(`end ${JSON.stringify(outcome)}`)
      return source.onAttemptEnd?.(input, outcome)
    },
  }
  // Each Prime send builds its own adapter; keeping a handle on it shows how
  // many sends' credentials it still holds for scrubbing errors.
  const adapters = spyOn(adapterModule, 'createNativeAnthropicAdapter')
  undo.push(() => adapters.mockRestore())
  const prime = createNativePrime({
    runtime,
    paths,
    source: observed,
    fetch: provider.fetch,
  })
  // Prime's disposal can start more provider work (an aborted request's body
  // reads, a late cancel), so that work is drained before the adapter spy,
  // source and runtime are restored.
  undo.push(async () => {
    try {
      await prime.dispose()
    } finally {
      await provider.drain()
    }
  })
  /** Sends whose credentials the current send's adapter still holds. */
  const held = (): unknown => {
    const native = adapters.mock.results.at(-1)?.value
    return native == null ? undefined : Reflect.get(native, 'heldRedactorCount')
  }
  return {
    runtime,
    store,
    source: observed,
    paths,
    own: (cleanup: () => unknown) => undo.push(cleanup),
    seen,
    classified,
    outcomes,
    refreshes,
    held,
    send: () => prime.manager.options.sendPrime('main'),
  }
}

/** True when no recorded callback input holds either synthetic credential. */
const expectNoCredential = (records: readonly string[]) => {
  const text = records.join('\n')
  expect(text).not.toContain(FIRST)
  expect(text).not.toContain(ROTATED)
}

const primeCounters = async (runtime: NativeAccountRuntime) =>
  (await runtime.read()).accounts.find((account) => account.id === 'main')

/** The quota saved in the pool file, without the runtime's overlay of readings whose save is still pending. */
const savedQuota = async (
  fixture: Awaited<ReturnType<typeof primeFixture>>,
) => {
  const read = await fixture.store.read()
  return read.status === 'ready' ? read.rows[0]?.quota : undefined
}

/** Hold one quota write without acquiring the credential-file locks needed by refresh. */
function holdQuota(fixture: Awaited<ReturnType<typeof primeFixture>>) {
  const entered = gate()
  const release = gate()
  const retired = gate()
  const ending = gate()
  const published = gate()
  const publish = fixture.runtime.publishLocal.bind(fixture.runtime)
  const classify = fixture.source.limitFromResponse?.bind(fixture.source)
  const end = fixture.source.onAttemptEnd?.bind(fixture.source)
  let held = false
  let refusal: Error | undefined
  const publication = spyOn(fixture.runtime, 'publishLocal').mockImplementation(
    async (subject, patch) => {
      if (patch.quota && !held) {
        held = true
        entered.open()
        await release.wait
        // Model a refused quota write after refresh has finished. Refreshing
        // the same account alone does not invalidate quota; a real final write
        // also checks lock ownership and whether the host still has authority.
        if (refusal) throw refusal
      }
      const kept = await publish(subject, patch)
      if (patch.quota) published.open()
      return kept
    },
  )
  const classification = spyOn(
    fixture.source,
    'limitFromResponse',
  ).mockImplementation(async (input) => {
    const result = await classify?.(input)
    if (input.status === 401) {
      const read = await fixture.store.read()
      const credential =
        read.status === 'ready' ? read.rows[0]?.credential : undefined
      expect(credential?.type === 'oauth' && credential.access).toBe(ROTATED)
      retired.open()
    }
    return result
  })
  const attemptEnd = spyOn(fixture.source, 'onAttemptEnd').mockImplementation(
    (input, outcome) => {
      ending.open()
      return end?.(input, outcome)
    },
  )
  fixture.own(() => publication.mockRestore())
  fixture.own(() => classification.mockRestore())
  fixture.own(() => attemptEnd.mockRestore())
  return {
    entered,
    retired,
    ending,
    release,
    published,
    refuse(error: Error) {
      refusal = error
    },
  }
}

function publicationRecords() {
  const records: LogTestRecord[] = []
  const previous = getLogLevel()
  setLogLevel('debug')
  __setLogTestSink((record) => records.push(record))
  deferCleanup(() => {
    __setLogTestSink(null)
    setLogLevel(previous)
  })
  return records
}

/** Drive the model/HTTP/retry hooks; the shared installer starts and ends attempts. */
async function modelSender(
  fixture: Awaited<ReturnType<typeof primeFixture>>,
  provider: ReturnType<typeof startProvider>,
) {
  type Handlers = {
    [K in keyof SessionHooks]?: (draft: SessionHooks[K]) => void | Promise<void>
  }
  const handlers: Handlers = {}
  const hook: OpenCode2HookContext['session']['hook'] = async (
    name,
    callback,
  ) => {
    handlers[name] = callback as Handlers[typeof name]
    return {
      dispose: async () => {
        delete handlers[name]
      },
    }
  }
  const native = adapterModule.createNativeAnthropicAdapter({
    source: fixture.source,
  })
  const warnings: string[] = []
  const installation = await installOpenCode2Auth(
    { session: { hook } },
    native.adapter,
    {
      logger: {
        warn: (message) => {
          warnings.push(message)
        },
      },
    },
  )
  fixture.own(async () => {
    await installation.dispose()
    native.dispose()
  })
  const run = async <K extends keyof SessionHooks>(
    name: K,
    draft: SessionHooks[K],
  ) => {
    const handler = handlers[name]
    if (!handler) throw new Error('The model hook was not installed')
    await handler(draft)
  }
  const identity = {
    sessionID: 'ses_held_model' as SessionHooks['model.request']['sessionID'],
    agent: 'build' as SessionHooks['model.request']['agent'],
    model: {
      providerID: 'anthropic',
      id: 'claude-haiku-4-5',
    } as SessionHooks['model.request']['model'],
    kind: 'primary' as const,
  }
  return {
    warnings,
    async send() {
      for (let index = 0; index < 2; index++) {
        const model = { ...identity, headers: {} }
        await run('model.request', model)
        const headers = new Headers(model.headers)
        headers.set('content-type', 'application/json')
        const http = {
          ...identity,
          request: new Request('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers,
            body: JSON.stringify({
              model: identity.model.id,
              max_tokens: 16,
              stream: false,
              messages: [{ role: 'user', content: 'Say ok' }],
            }),
          }),
        }
        await run('http.request', http)
        const reply = {
          ...identity,
          request: http.request,
          response: await provider.fetch(http.request),
        }
        await run('http.response', reply)
        if (reply.response.ok)
          return {
            status: reply.response.status,
            data: await reply.response.json(),
          }
        await reply.response.body?.cancel()
        const retry: SessionHooks['retry'] = {
          ...identity,
          attempt: index + 1,
          error: {
            type: 'api',
            message: 'Provider refused the request',
            status: reply.response.status,
          },
          // Same-account refreshes preserve the host's retry policy. Opt into
          // one retry here to test publication failures, not a host veto.
          decision: { retry: true, delay: 0 },
        }
        await run('retry', retry)
        if (!retry.decision.retry)
          throw new Error('The model request was not retried')
      }
      throw new Error('The model request retry budget was exhausted')
    },
  }
}

for (const [code, level] of [
  ['publication-refused', 'error'],
  ['runtime-io', 'warn'],
] as const) {
  test(`OC2 model request retries after a held ${code} quota publication with one ${level} diagnostic`, async () => {
    let fixture: Awaited<ReturnType<typeof primeFixture>>
    let quotaAtRetry: unknown = 'retry not reached'
    const provider = startProvider(suite, async (token, index) => {
      if (index === 0)
        return new Response(echoError('authentication_error', token), {
          status: 401,
          headers: echoHeaders(token, 'req_model_rejected'),
        })
      quotaAtRetry = (await primeCounters(fixture.runtime))?.quota
      return usageReply('req_model_retry')
    })
    const records = publicationRecords()
    fixture = await primeFixture(provider, false)
    const quota = holdQuota(fixture)
    quota.refuse(new NativeRuntimeError(code))
    const model = await modelSender(fixture, provider)
    const sending = model.send()
    suite.trackDetached(sending)
    await quota.entered.wait
    await quota.retired.wait
    await quota.ending.wait
    expect(provider.sent).toEqual([FIRST])
    quota.release.open()

    expect(await sending).toMatchObject({
      status: 200,
      data: { content: [{ type: 'text', text: 'ok' }] },
    })
    expect(provider.sent).toEqual([FIRST, ROTATED])
    expect(quotaAtRetry).toBeUndefined()
    await fixture.source.close()
    expect(model.warnings).toEqual([])
    expect(
      records.filter(
        (record) => record.message === 'Account usage publication unavailable',
      ),
    ).toEqual([
      {
        level,
        channel: 'native-auth',
        message: 'Account usage publication unavailable',
        payload: { name: 'NativeRuntimeError', code },
      },
    ])
  })
}

test('OC2 Prime retries after a held quota publication is refused after credential retirement', async () => {
  let fixture: Awaited<ReturnType<typeof primeFixture>>
  let quotaAtRetry: unknown = 'retry not reached'
  const provider = startProvider(suite, async (token, index) => {
    if (index === 0)
      return new Response(echoError('authentication_error', token), {
        status: 401,
        headers: echoHeaders(token, 'req_held_rejected'),
      })
    quotaAtRetry = await savedQuota(fixture)
    return usageReply('req_held_retry')
  })
  const records = publicationRecords()
  fixture = await primeFixture(provider, false)
  const quota = holdQuota(fixture)
  quota.refuse(new NativeRuntimeError('publication-refused'))
  const sending = fixture.send()
  suite.trackDetached(sending)
  await quota.entered.wait
  await quota.retired.wait
  await quota.ending.wait
  expect(provider.sent).toEqual([FIRST])
  // The held reading is not saved, though this process already routes by it
  // until the refused save drops it.
  expect(await savedQuota(fixture)).toBeUndefined()
  expect(
    (await primeCounters(fixture.runtime))?.quota?.five_hour?.remainingPercent,
  ).toBe(0)
  quota.release.open()

  expect(await sending).toMatchObject({ ok: true, status: 200 })
  expect(provider.sent).toEqual([FIRST, ROTATED])
  expect(quotaAtRetry).toBeUndefined()
  expect(
    (await primeCounters(fixture.runtime))?.quota?.five_hour?.remainingPercent,
  ).toBe(75)
  await fixture.source.close()
  expect(
    records.filter(
      (record) => record.message === 'Account usage publication unavailable',
    ),
  ).toEqual([
    {
      level: 'error',
      channel: 'native-auth',
      message: 'Account usage publication unavailable',
      payload: { name: 'NativeRuntimeError', code: 'publication-refused' },
    },
  ])
})

test('OC2 attempt end detaches quota persistence and a later choice routes by the new reading while the save is held', async () => {
  const provider = startProvider(suite, () => {
    const response = usageReply('req_saved_quota')
    response.headers.set('anthropic-ratelimit-unified-5h-utilization', '1')
    response.headers.set('anthropic-ratelimit-unified-7d-utilization', '1')
    return response
  })
  const records = publicationRecords()
  const fixture = await primeFixture(provider, false)
  await fixture.runtime.addApi({
    routeId: 'paid',
    apiKey: 'synthetic-paid-account',
    baseURL: 'https://api.anthropic.com',
    authHeader: 'x-api-key',
  })
  const quota = holdQuota(fixture)
  let completed = false
  const sending = fixture.send().then((result) => {
    completed = true
    return result
  })
  suite.trackDetached(sending)
  await quota.entered.wait
  await quota.ending.wait
  expect(await sending).toMatchObject({ ok: true, status: 200 })
  expect(completed).toBe(true)
  // The save is still held: the pool file has no quota yet, but the runtime
  // snapshot already carries the reading this process received.
  expect(await savedQuota(fixture)).toBeUndefined()
  expect(
    (await primeCounters(fixture.runtime))?.quota?.five_hour?.remainingPercent,
  ).toBe(0)
  const input = {
    providerID: 'anthropic',
    modelID: 'claude-haiku-4-5',
    sessionID: 'later-saved-quota-choice',
    agent: 'build',
    kind: 'primary' as const,
    phase: 'retry' as const,
    rerouteFrom: {
      accountId: 'main',
      limit: { reason: 'provider-503', status: 503 },
    },
  }
  expect(await fixture.source.chooseAccount(input)).toBe('paid')
  expect(await savedQuota(fixture)).toBeUndefined()
  quota.release.open()
  await quota.published.wait
  expect(
    (await primeCounters(fixture.runtime))?.quota?.five_hour?.remainingPercent,
  ).toBe(0)
  await fixture.source.close()
  expect(
    records.filter(
      (record) => record.message === 'Account usage publication unavailable',
    ),
  ).toEqual([])
})

test('OC2 Prime records one successful send usage and keeps no credential afterwards', async () => {
  const provider = startProvider(suite, () => usageReply('req_prime_success'))
  const fixture = await primeFixture(provider, true)

  const result = await fixture.send()

  expect(result).toMatchObject({
    ok: true,
    status: 200,
    usage: { inputTokens: 11, outputTokens: 3 },
  })
  expect(provider.sent).toEqual([FIRST])
  expect(fixture.outcomes).toEqual([{ status: 200 }])
  expect(fixture.seen).toContain('request-id req_prime_success')
  expect(fixture.held()).toBe(0)
  const account = await primeCounters(fixture.runtime)
  expect(account?.prime).toMatchObject({
    count: 1,
    inputTokens: 11,
    outputTokens: 3,
  })
  expect(account?.quota?.five_hour?.remainingPercent).toBe(75)
  expectNoCredential(fixture.seen)
})

for (const status of [200, 429]) {
  test(`OC2 Prime harvests quota without routing reports at status ${status}`, async () => {
    const reports: unknown[] = []
    const globals = globalThis as Record<symbol, unknown>
    const key = Symbol.for('cortexkit.routing')
    const original = globals[key]
    globals[key] = () => ({ report: (report: unknown) => reports.push(report) })
    deferCleanup(() => {
      if (original === undefined) delete globals[key]
      else globals[key] = original
    })
    const provider = startProvider(suite, () =>
      status === 200
        ? usageReply('req_prime_quota_only')
        : Response.json(
            {
              type: 'error',
              error: { type: 'rate_limit_error', message: 'limited' },
            },
            {
              status,
              headers: { 'anthropic-ratelimit-unified-5h-utilization': '1' },
            },
          ),
    )
    const fixture = await primeFixture(provider, true)
    expect(await fixture.send()).toMatchObject({ ok: status === 200, status })
    expect(provider.sent).toEqual([FIRST])
    expect(reports).toEqual([])
    expect(
      (await primeCounters(fixture.runtime))?.quota?.five_hour
        ?.remainingPercent,
    ).toBe(status === 200 ? 75 : 0)
  })
}

test('OC2 Prime 401 that repeats its credential reaches the source scrubbed, and the retry holds only its own credential', async () => {
  let heldAtRetry: unknown
  let fixture: Awaited<ReturnType<typeof primeFixture>> | undefined
  const provider = startProvider(suite, (token, index) => {
    if (index === 0)
      return new Response(echoError('authentication_error', token), {
        status: 401,
        headers: echoHeaders(token, 'req_prime_rejected'),
      })
    heldAtRetry = fixture?.held()
    return usageReply('req_prime_rotated')
  })
  fixture = await primeFixture(provider, true)

  const result = await fixture.send()

  expect(result).toMatchObject({
    ok: true,
    status: 200,
    usage: { inputTokens: 11, outputTokens: 3 },
  })
  // The provider really received both credentials, so each scrubbed echo
  // below repeated a credential that was sent.
  expect(provider.sent).toEqual([FIRST, ROTATED])
  expect(fixture.refreshes).toEqual(['primeBoundarySyntheticRefresh'])
  expectNoCredential(fixture.seen)
  expect(fixture.seen.join('\n')).toContain(
    `x-echoed-authorization: Bearer ${PROVIDER_ERROR_REDACTION}`,
  )
  // When the retry reached the provider, the rejected send's credentials
  // were already released.
  expect(heldAtRetry).toBe(1)
  expect(fixture.classified).toHaveLength(1)
  expect(fixture.outcomes).toEqual([
    { status: 401, reason: 'cancelled' },
    { status: 200 },
  ])
  expect((await primeCounters(fixture.runtime))?.prime).toMatchObject({
    count: 1,
    inputTokens: 11,
    outputTokens: 3,
  })
})

test('OC2 Prime 429 whose error body never ends classifies a bounded body, stores a scrubbed quota claim and cancels the body', async () => {
  const provider = startProvider(suite, (token) => {
    const body = provider.body(echoError('rate_limit_error', token), 'flood')
    return new Response(body.stream, {
      status: 429,
      headers: {
        ...echoHeaders(token, 'req_prime_limited'),
        'retry-after': '30',
      },
    })
  })
  const fixture = await primeFixture(provider, true)

  const result = await fixture.send()

  expect(result).toMatchObject({ ok: false, status: 429 })
  expect(provider.sent).toEqual([FIRST])
  // Reading stopped at the error-body bound and the body was cancelled at the
  // transport, although the provider never ended it.
  expect(provider.transportCancels).toEqual([1])
  expect(fixture.classified).toHaveLength(1)
  expect(fixture.classified[0]?.length).toBeLessThan(1024)
  expectNoCredential(fixture.seen)
  expect(fixture.outcomes).toEqual([{ status: 429, reason: 'cancelled' }])
  expect(fixture.held()).toBe(0)
  // The quota fields from the rate-limit headers are still stored, without
  // the credential the provider repeated in one of them.
  const account = await primeCounters(fixture.runtime)
  expect(account?.quota?.five_hour?.remainingPercent).toBe(0)
  expect(JSON.stringify(account?.quota)).not.toContain(FIRST)
  expect(account?.prime?.count ?? 0).toBe(0)
})

test('OC2 Prime 401 retry never waits on the discarded body and retires the first credential before retrying', async () => {
  let heldAtRetry: unknown
  let heldAtCancel: unknown
  let fixture: Awaited<ReturnType<typeof primeFixture>> | undefined
  // Opened by this body once checked, or by teardown if the body hangs.
  const cancelHold = gate()
  const provider = startProvider(
    suite,
    (token, index) => {
      if (index === 0) {
        const body = provider.body(
          echoError('authentication_error', token),
          'stall',
        )
        return new Response(body.stream, {
          status: 401,
          headers: echoHeaders(token, 'req_prime_rejected'),
        })
      }
      heldAtRetry = fixture?.held()
      return usageReply('req_prime_rotated')
    },
    (index) => {
      if (index !== 0) return
      // Read once the jobs already queued when the cancel arrived have run,
      // which includes the adapter releasing a send whose response settled.
      queueMicrotask(() => {
        heldAtCancel = fixture?.held()
      })
      // The first response's connection never finishes closing until this
      // body or teardown opens the hold.
      return cancelHold.wait
    },
  )
  fixture = await primeFixture(provider, false)

  const result = await fixture.send()

  expect(result).toMatchObject({
    ok: true,
    status: 200,
    usage: { inputTokens: 11, outputTokens: 3 },
  })
  expect(provider.sent).toEqual([FIRST, ROTATED])
  expect(provider.transportCancels).toEqual([1, 0])
  // The rejected send's credentials were gone as its cancel reached the
  // transport, and only the retry's were held when it reached the provider.
  expect(heldAtCancel).toBe(0)
  expect(heldAtRetry).toBe(1)
  cancelHold.open()
  expectNoCredential(fixture.seen)
  expect(fixture.seen.join('\n')).toContain(
    `x-echoed-authorization: Bearer ${PROVIDER_ERROR_REDACTION}`,
  )
  expect(fixture.outcomes).toEqual([
    { status: 401, reason: 'cancelled' },
    { status: 200 },
  ])
})

test('the loopback provider keeps a lifetime from finishing until its held HTTP body and transport cancel settle', async () => {
  // The test runs its fixtures under its own `TestLifetime`, so it can check
  // what has settled when that lifetime's `finish()` returns. No gate of that
  // lifetime opens before `finish()` runs. `finish()` is also started by this
  // test's own teardown, through a gate registered before any provider I/O,
  // so a stalled request or read below cannot outlive this test.
  const owner = new TestLifetime()
  let finishing: Promise<void> | undefined
  const finish = () => {
    finishing ??= owner.finish()
    return finishing
  }
  const closing = gate()
  suite.trackDetached(closing.wait.then(finish))
  const log: string[] = []
  let pendingRead: Promise<unknown> | undefined
  let cancelling: Promise<unknown> | undefined
  const body = owner.runBody(async () => {
    owner.deferCleanup(() => {
      log.push('cleanup')
    })
    // Holds the transport cancel of response 1. Created before any provider
    // I/O; only the private lifetime's `finish()` opens it.
    const hold = owner.gate()
    const provider = startProvider(
      owner,
      (token) =>
        new Response(provider.body(`held ${token.length}`, 'stall').stream, {
          status: 401,
        }),
      () =>
        hold.wait.then(() => {
          log.push('cancel hold opened')
        }),
      log,
    )
    const request = () =>
      provider.fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        body: '{}',
      })
    // Response 0: its prefix is read, then a read stays pending on a body the
    // provider never ends.
    const pending = (await request()).body?.getReader()
    if (!pending) throw new Error('The held response has no body')
    await pending.read()
    pendingRead = pending.read().then(
      () => log.push('pending read settled'),
      () => log.push('pending read settled'),
    )
    // Response 1: its cancellation waits for the private lifetime's hold gate.
    const cancelled = (await request()).body
    if (!cancelled) throw new Error('The cancelled response has no body')
    cancelling = cancelled.cancel()
    // The provider shutdown reports cancel failures. Attach a handler now
    // so a rejected cancel is not unhandled before that shutdown runs.
    cancelling.catch(() => {})
  })
  try {
    await body
    const before = log.length
    expect(log).not.toContain('transport cancel settled 1')

    await finish()

    // Check settlement before this test awaits the read and cancel promises.
    // The provider shutdown must have joined their work itself.
    const teardown = log.slice(before)
    const cleanup = teardown.indexOf('cleanup')
    expect(cleanup).toBe(teardown.length - 1)
    expect(teardown.slice(0, cleanup)).toEqual(
      expect.arrayContaining([
        'cancel hold opened',
        'transport cancel settled 1',
        'transport pull settled 0',
        'provider body pull settled',
        'pending read settled',
      ]),
    )
  } finally {
    // Join the body, lifetime finish, pending read and cancellation separately.
    // The outer test's closing gate also reports a rejected lifetime finish.
    await Promise.allSettled([body, finish(), pendingRead, cancelling])
  }
})
