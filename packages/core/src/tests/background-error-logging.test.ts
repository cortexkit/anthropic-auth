import { expect } from 'bun:test'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { AccountStorage } from '../accounts.ts'
import { CacheKeepManager } from '../cachekeep.ts'
import {
  __setLogTestSink,
  getLogLevel,
  type LogTestRecord,
  setLogLevel,
} from '../logger.ts'
import {
  PrimeManager,
  type PrimeRefreshResult,
  type PrimeSendResult,
} from '../prime.ts'
import { createTestLifetimeSuite, TestLifetime } from './test-lifetime.ts'

const { test, deferCleanup, gate, trackDetached } = createTestLifetimeSuite()

// Opaque markers standing in for text that a provider body, a relay peer or a
// caught exception could carry. They deliberately match none of the logger's
// value-redaction patterns, so only the logging call sites can keep them out.
const RELAY_ECHO = 'opaque-relay-echo-7f3a91c2'
const TOKEN_ECHO = 'opaque-token-echo-5be04d18'
const ECHOES = [RELAY_ECHO, TOKEN_ECHO]

function expectNoEcho(text: string) {
  for (const echo of ECHOES) expect(text).not.toContain(echo)
}

const echoError = () => new Error(`relay said ${RELAY_ECHO} for ${TOKEN_ECHO}`)
const echoBody = JSON.stringify({
  type: 'error',
  error: { type: 'api_error', message: `${RELAY_ECHO} ${TOKEN_ECHO}` },
})
const rejectWithEcho = async (): Promise<never> => {
  throw echoError()
}

async function tempRoot(prefix: string) {
  const root = await mkdtemp(join(tmpdir(), prefix))
  deferCleanup(() => rm(root, { recursive: true, force: true }))
  return root
}

/**
 * Keeps a promise that a manager starts without awaiting (a scheduled tick or
 * a host callback) inside this test's lifetime. This settle handler is attached
 * before the manager attaches its own catch-and-log handler; reactions on one
 * promise run in attachment order, and teardown resumes only after further
 * promise turns, so the manager's log record is emitted before teardown
 * stops managers and restores the log sink.
 */
function observeDetached<T>(work: Promise<T>): Promise<T> {
  trackDetached(
    work.then(
      () => {},
      () => {},
    ),
  )
  return work
}

type FetchInput = Parameters<typeof fetch>[0]

/** A typed fetch stand-in; nothing here reaches the network. */
function fakeFetch(
  respond: (input: FetchInput) => Promise<Response>,
): typeof fetch {
  const preconnect: typeof fetch.preconnect = () => {}
  return Object.assign(
    (input: FetchInput, _init?: RequestInit) => respond(input),
    { preconnect },
  )
}

/**
 * Per-instance interval implementation that hands the manager a real timer
 * handle (which it can unref and clear) but parks the manager's callback so
 * the test decides when the scheduled work runs.
 */
function capturingSetInterval(parked: Array<() => void>): typeof setInterval {
  return (
    handler: Bun.TimerHandler,
    delay?: number,
    ...args: Parameters<Bun.TimerHandler>
  ) => {
    const handle = setInterval(() => {}, delay)
    parked.push(() => handler(...args))
    return handle
  }
}

/** Timeout counterpart of `capturingSetInterval`; running it clears its handle. */
function capturingSetTimeout(parked: Array<() => void>): typeof setTimeout {
  return Object.assign(
    (
      handler: Bun.TimerHandler,
      delay?: number,
      ...args: Parameters<Bun.TimerHandler>
    ) => {
      const handle = setTimeout(() => {}, delay)
      parked.push(() => {
        clearTimeout(handle)
        handler(...args)
      })
      return handle
    },
    { __promisify__: setTimeout.__promisify__ },
  )
}

/**
 * Captures logger records at trace level for one test. Managers the test
 * creates are registered with `own`; the single cleanup registered here stops
 * them (newest first) and only then restores the previous sink and level.
 * The lifetime drains detached work tracked during the body before any
 * cleanup runs, so neither stop-time records nor late callback records can
 * reach the sink of a later test.
 */
function captureLogs() {
  const records: LogTestRecord[] = []
  const waiters: Array<{
    match: (record: LogTestRecord) => boolean
    open: () => void
  }> = []
  const owned: Array<() => void> = []
  const previousLevel = getLogLevel()
  setLogLevel('trace')
  __setLogTestSink((record) => {
    records.push(record)
    for (const waiter of [...waiters]) {
      if (!waiter.match(record)) continue
      waiters.splice(waiters.indexOf(waiter), 1)
      waiter.open()
    }
  })
  deferCleanup(() => {
    for (const stop of owned.splice(0).reverse()) stop()
    __setLogTestSink(null)
    setLogLevel(previousLevel)
  })
  const matches = (channel: string, message: string) => (r: LogTestRecord) =>
    r.channel === channel && r.message === message
  return {
    records,
    own(stop: () => void) {
      owned.push(stop)
    },
    find(channel: string, message: string) {
      return records.filter(matches(channel, message))
    },
    /**
     * A lifetime gate that opens when a matching record arrives (or when
     * teardown starts). It is tracked, so teardown waits for it too.
     */
    waitFor(channel: string, message: string) {
      const opened = gate()
      if (records.some(matches(channel, message))) opened.open()
      else waiters.push({ match: matches(channel, message), open: opened.open })
      trackDetached(opened.wait)
      return opened.wait
    },
  }
}

type LogCapture = ReturnType<typeof captureLogs>

// -- CacheKeep ---------------------------------------------------------------

type CacheKeepOptions = ConstructorParameters<typeof CacheKeepManager>[0]

/** Tracks every tick, including one started by the parked interval callback. */
class ObservedCacheKeepManager extends CacheKeepManager {
  override tick(): Promise<void> {
    return observeDetached(super.tick())
  }
}

const cacheKeepStorage: AccountStorage = {
  version: 1,
  accounts: [],
  cacheKeep: { enabled: true, always: true },
  claudeCache: { enabled: true, mode: 'hybrid' },
}

const cacheKeepBody = JSON.stringify({
  model: 'claude-haiku-4-5',
  max_tokens: 64,
  system: [
    {
      type: 'text',
      text: 'stable prompt',
      cache_control: { type: 'ephemeral' },
    },
  ],
  messages: [{ role: 'user', content: 'warm' }],
})

/**
 * Builds a manager with one tracked session whose prewarm is already due. Its
 * interval callback is parked so the test can run the scheduled tick itself.
 */
function dueCacheKeep(
  logs: LogCapture,
  sessionId: string,
  overrides: Partial<CacheKeepOptions>,
) {
  let now = 10_000_000
  const scheduled: Array<() => void> = []
  const manager = new ObservedCacheKeepManager({
    loadStorage: async () => cacheKeepStorage,
    now: () => now,
    setIntervalImpl: capturingSetInterval(scheduled),
    fetchImpl: fakeFetch(async () => new Response(echoBody, { status: 500 })),
    ...overrides,
  })
  logs.own(() => manager.stop())
  const tracked = manager.track({
    sessionId,
    url: 'https://api.anthropic.com/v1/messages',
    headers: new Headers({ 'content-type': 'application/json' }),
    bodyText: cacheKeepBody,
    storage: cacheKeepStorage,
    cacheMode: 'hybrid',
  })
  expect(tracked).toEqual({ tracked: true })
  now += 56 * 60_000
  return { manager, scheduled }
}

test('CacheKeep provider-body and transport failures log status and flags, never the raw reason', async () => {
  const logs = captureLogs()

  // HTTP failures retain only the allowlisted type and fixed local summary,
  // alongside session and status; provider text never reaches the log.
  await dueCacheKeep(logs, 'ck-http', {}).manager.tick()
  // Transport failure: the exception message never reaches the log.
  await dueCacheKeep(logs, 'ck-transport', {
    fetchImpl: fakeFetch(rejectWithEcho),
  }).manager.tick()
  // Missing credential headers select a fixed credential-unavailable summary,
  // not a provider message or an exception string.
  await dueCacheKeep(logs, 'ck-credential', {
    prepareHeaders: () => undefined,
  }).manager.tick()

  expect(
    logs.find('cachekeep', 'prewarm failed').map((r) => r.payload),
  ).toEqual([
    {
      session: 'ck-http',
      status: 500,
      stage: 'response',
      class: 500,
      provider_error: {
        type: 'api_error',
        reason: 'http_error',
        message: 'Provider prewarm request failed',
      },
    },
    {
      session: 'ck-transport',
      stage: 'send',
      class: 'unknown',
      transient: true,
      provider_error: {
        type: 'unknown',
        reason: 'transport',
        message: 'Provider prewarm transport failed',
      },
    },
    {
      session: 'ck-credential',
      stage: 'authorization',
      class: 'unknown',
      transient: true,
      provider_error: {
        type: 'unknown',
        reason: 'credential_unavailable',
        message: 'OAuth cache prewarm credential is unavailable',
      },
    },
  ])
  expectNoEcho(JSON.stringify(logs.records))

  // Immediate callers receive the same fixed summary and reason text rather
  // than the provider response body.
  const direct = await dueCacheKeep(logs, 'ck-direct', {}).manager.prewarmNow({
    sessionId: 'ck-direct',
    url: 'https://api.anthropic.com/v1/messages',
    headers: new Headers(),
    bodyText: cacheKeepBody,
  })
  expect(direct).toEqual({
    ok: false,
    reason: 'Provider prewarm request failed',
    status: 500,
    stage: 'response',
    class: 500,
    provider_error: {
      type: 'api_error',
      reason: 'http_error',
      message: 'Provider prewarm request failed',
    },
  })
  expectNoEcho(JSON.stringify(direct))
})

test('CacheKeep callback and stage exceptions log fixed stages and safe summaries without exception text', async () => {
  const logs = captureLogs()

  await dueCacheKeep(logs, 'ck-thrown', {
    prepareHeaders: () => {
      throw echoError()
    },
  }).manager.tick()

  await dueCacheKeep(logs, 'ck-prepare', {
    prepareBody: () => {
      throw echoError()
    },
  }).manager.tick()

  // track() reports synchronously to a throwing callback.
  dueCacheKeep(logs, 'ck-publish-sync', {
    onTrackedSessionsChanged: () => {
      throw echoError()
    },
  })
  // A rejecting callback is reported on track() and again when the tick ends.
  await dueCacheKeep(logs, 'ck-publish-async', {
    onTrackedSessionsChanged: () => observeDetached(rejectWithEcho()),
  }).manager.tick()

  const tickFailed = logs.waitFor('cachekeep', 'tick failed')
  const ticking = dueCacheKeep(logs, 'ck-tick', {
    loadStorage: rejectWithEcho,
  })
  expect(ticking.scheduled).toHaveLength(1)
  ticking.scheduled[0]?.()
  await tickFailed

  expect(
    logs
      .find('cachekeep', 'prewarm failed')
      .filter((r) => r.payload?.session === 'ck-thrown')
      .map((r) => r.payload),
  ).toEqual([
    {
      session: 'ck-thrown',
      stage: 'authorization',
      class: 'unknown',
      transient: true,
      provider_error: {
        type: 'unknown',
        reason: 'transport',
        message: 'Provider prewarm transport failed',
      },
    },
  ])
  expect(
    logs.find('cachekeep', 'prepare body failed').map((r) => r.payload),
  ).toEqual([{ session: 'ck-prepare' }])
  // One synchronous failure plus two asynchronous ones, all payload-free.
  expect(
    logs
      .find('cachekeep', 'failed to publish tracked sessions')
      .map((r) => r.payload),
  ).toEqual([undefined, undefined, undefined])
  expect(logs.find('cachekeep', 'tick failed').map((r) => r.payload)).toEqual([
    undefined,
  ])
  expectNoEcho(JSON.stringify(logs.records))
})

// -- Prime -------------------------------------------------------------------

type PrimeOptions = ConstructorParameters<typeof PrimeManager>[0]

/** Tracks every tick, including one started by the parked interval callback. */
class ObservedPrimeManager extends PrimeManager {
  override tick(): Promise<void> {
    return observeDetached(super.tick())
  }
}

const PRIME_NOW = 500 + 120_000

const primeStorage: AccountStorage = {
  version: 1,
  main: { type: 'opencode', provider: 'anthropic' },
  quota: {
    enabled: true,
    checkIntervalMinutes: 5,
    mainQuota: {
      five_hour: {
        usedPercent: 0,
        remainingPercent: 100,
        resetsAt: new Date(500).toISOString(),
        checkedAt: 1,
      },
    },
    mainQuotaCheckedAt: 1,
    mainQuotaToken: 'fp',
  },
  prime: { enabled: true },
  accounts: [],
}

const passedReset: PrimeRefreshResult = {
  quota: {
    five_hour: {
      usedPercent: 0,
      remainingPercent: 100,
      resetsAt: new Date(PRIME_NOW - 1000).toISOString(),
      checkedAt: 1,
    },
  },
  fresh: true,
}

/** A prime manager whose only account, main, is due and claimable. */
async function duePrime(logs: LogCapture, overrides: Partial<PrimeOptions>) {
  const root = await tempRoot('prime-log-')
  const manager = new ObservedPrimeManager({
    storagePath: join(root, 'accounts.json'),
    markerDir: join(root, 'markers'),
    loadStorage: async () => primeStorage,
    getAccountFingerprint: async () => '0123456789abcdef',
    refreshQuota: async () => passedReset,
    sendPrime: async () => ({ ok: true, status: 200, ms: 1 }),
    recordSuccess: async () => ({
      count: 1,
      inputTokens: 1,
      outputTokens: 1,
      since: PRIME_NOW,
    }),
    now: () => PRIME_NOW,
    ...overrides,
  })
  logs.own(() => manager.stop())
  return manager
}

const failWith = (result: PrimeSendResult) => async () => result

test('Prime fire results log the closed reason and status, never the sender error text', async () => {
  const logs = captureLogs()

  await (
    await duePrime(logs, {
      sendPrime: failWith({
        ok: false,
        reason: 'token-refresh',
        error: `refresh rejected: ${echoBody}`,
      }),
    })
  ).tick()
  await (
    await duePrime(logs, {
      sendPrime: failWith({ ok: false, status: 529, error: echoBody }),
    })
  ).tick()
  await (
    await duePrime(logs, {
      sendPrime: failWith({
        ok: false,
        status: 502,
        reason: 'send',
        error: echoBody,
      }),
    })
  ).tick()

  expect(
    logs.find('prime', 'prime token refresh failed').map((r) => r.payload),
  ).toEqual([{ account: 'main', reason: 'token-refresh' }])
  expect(logs.find('prime', 'prime fire failed').map((r) => r.payload)).toEqual(
    [
      { account: 'main', status: 529, reason: 'send' },
      { account: 'main', status: 502, reason: 'send' },
    ],
  )
  expectNoEcho(JSON.stringify(logs.records))
})

test('Prime caught exceptions log fixed stages with the account label only', async () => {
  const logs = captureLogs()

  await (await duePrime(logs, { refreshQuota: rejectWithEcho })).tick()
  await (await duePrime(logs, { getAccountFingerprint: rejectWithEcho })).tick()
  await (await duePrime(logs, { sendPrime: rejectWithEcho })).tick()
  await (await duePrime(logs, { recordSuccess: rejectWithEcho })).tick()

  // The post-fire quota poll runs from a parked timer; its second refresh
  // call is the one that fails.
  const postFire: Array<() => void> = []
  let refreshes = 0
  const delayed = await duePrime(logs, {
    refreshQuota: async () => {
      refreshes += 1
      if (refreshes > 1) throw echoError()
      return passedReset
    },
    setTimeoutImpl: capturingSetTimeout(postFire),
  })
  await delayed.tick()
  expect(postFire).toHaveLength(1)
  const postFireFailed = logs.waitFor('prime', 'post-fire refresh failed')
  postFire[0]?.()
  await postFireFailed

  const tickFailed = logs.waitFor('prime', 'tick failed')
  const scheduled: Array<() => void> = []
  const ticking = await duePrime(logs, {
    loadStorage: rejectWithEcho,
    setIntervalImpl: capturingSetInterval(scheduled),
  })
  ticking.start()
  expect(scheduled).toHaveLength(1)
  scheduled[0]?.()
  await tickFailed

  const payloads = (message: string) =>
    logs.find('prime', message).map((r) => r.payload)
  expect(payloads('refresh failed')).toEqual([{ account: 'main' }])
  expect(payloads('account evaluation failed')).toEqual([
    { account: 'main', stage: 'fingerprint' },
  ])
  expect(payloads('prime fire threw')).toEqual([{ account: 'main' }])
  expect(payloads('recordSuccess failed')).toEqual([{ account: 'main' }])
  expect(payloads('post-fire refresh failed')).toEqual([{ account: 'main' }])
  expect(payloads('tick failed')).toEqual([undefined])
  expectNoEcho(JSON.stringify(logs.records))
})

// -- Fallback accounts -------------------------------------------------------

// -- Owned child processes ---------------------------------------------------

type ChildOwner = Pick<TestLifetime, 'gate' | 'trackDetached' | 'deferCleanup'>
const suiteOwner: ChildOwner = { gate, trackDetached, deferCleanup }
type Note = (event: string) => void

/**
 * A temporary directory whose removal is registered as an owner cleanup. That
 * cleanup first joins every child registered with `join`, so no child can
 * still be writing into the directory when it is removed.
 */
async function ownedRoot(
  owner: ChildOwner,
  prefix: string,
  note: Note = () => {},
) {
  const root = await mkdtemp(join(tmpdir(), prefix))
  const children: Array<Promise<unknown>> = []
  owner.deferCleanup(async () => {
    await Promise.all(children)
    note('root: children joined')
    await rm(root, { recursive: true, force: true })
    note('root: removed')
  })
  return {
    root,
    join(drained: Promise<unknown>) {
      children.push(drained)
    },
  }
}

type OwnedRoot = Awaited<ReturnType<typeof ownedRoot>>

/**
 * Runs `bun -e script` as a child owned by a test lifetime. The cancellation
 * gate exists before the child does; when the owner's teardown opens it, a
 * child that is still running is killed, and that cancellation is tracked so
 * teardown waits for it. The exit status and each output stream are joined
 * with allSettled by the root's cleanup before the root is removed, so a
 * failing body never leaves an unread pipe or a live process behind.
 */
function spawnOwnedChild(
  owner: ChildOwner,
  root: OwnedRoot,
  script: string,
  options: {
    env?: Record<string, string | undefined>
    ipc?: (message: unknown) => void
    note?: Note
  } = {},
) {
  const note = options.note ?? (() => {})
  const cancelled = owner.gate()
  const child = Bun.spawn([process.execPath, '-e', script], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: options.env,
    ipc: options.ipc,
  })
  const exited = child.exited
  const stdout = new Response(child.stdout).text()
  const stderr = new Response(child.stderr).text()
  owner.trackDetached(
    cancelled.wait.then(() => {
      if (child.exitCode !== null || child.signalCode !== null) return
      child.kill()
      note('cancel: killed running child')
    }),
  )
  const settled = (name: string, work: Promise<unknown>) =>
    Promise.allSettled([work]).then(() => note(`${name}: settled`))
  root.join(
    Promise.allSettled([
      settled('exit', exited),
      settled('stdout', stdout),
      settled('stderr', stderr),
    ]),
  )
  return { child, exited, stdout, stderr }
}

test('a child held past its body is killed by owner teardown, fully drained, and only then loses its root', async () => {
  const owner = new TestLifetime()
  // Bound before any wait: if this outer test is torn down early, finishing
  // the private owner kills the held child and drains it.
  const outer = gate()
  trackDetached(outer.wait.then(() => owner.finish()))
  const events: string[] = []
  const note: Note = (event) => {
    events.push(event)
  }
  let signalReady = () => {}
  const ready = new Promise<void>((resolve) => {
    signalReady = resolve
  })
  let held: ReturnType<typeof spawnOwnedChild> | undefined
  let rootPath = ''
  const body = owner.runBody(async () => {
    const fixture = await ownedRoot(owner, 'held-child-', note)
    rootPath = fixture.root
    // The child reports readiness over IPC and then never exits on its own.
    held = spawnOwnedChild(
      owner,
      fixture,
      "process.send('ready'); setInterval(() => {}, 1 << 30)",
      { ipc: () => signalReady(), note },
    )
    await held.exited
    note('body: joined exit')
  })
  await Promise.race([ready, outer.wait, body])
  if (!held) throw new Error('held child was not spawned')
  expect(held.child.exitCode).toBeNull()
  expect(held.child.signalCode).toBeNull()

  await owner.finish()
  await body

  expect(held.child.signalCode).toBe('SIGTERM')
  expect(events[0]).toBe('cancel: killed running child')
  expect(events.slice(-2)).toEqual(['root: children joined', 'root: removed'])
  expect(events.slice(1, -2).sort()).toEqual([
    'body: joined exit',
    'exit: settled',
    'stderr: settled',
    'stdout: settled',
  ])
  expect(await Promise.allSettled([held.stdout, held.stderr])).toEqual([
    { status: 'fulfilled', value: '' },
    { status: 'fulfilled', value: '' },
  ])
  await expect(stat(rootPath)).rejects.toMatchObject({ code: 'ENOENT' })
})

// `relayLog` and `log` are silent whenever NODE_ENV is `test`, so these sites
// are exercised in a child process running the production logger, which
// writes the log file on exit.
test('dump and cached-quota diagnostics written by a production logger omit raw exception text', async () => {
  const fixture = await ownedRoot(suiteOwner, 'relay-log-')
  const root = fixture.root
  const logPath = join(root, 'auth.log')
  // A regular file where the dump directory's parent should be makes mkdir
  // fail with an error message that echoes the path.
  const blockedParent = join(root, `file-${RELAY_ECHO}`)
  await writeFile(blockedParent, '')
  const moduleHref = (name: string) =>
    JSON.stringify(new URL(name, import.meta.url).href)
  const json = (value: unknown) => JSON.stringify(value)
  const script = `
    const dump = await import(${moduleHref('../dump.ts')})
    const { log } = await import(${moduleHref('../logger.ts')})
    dump.setDumpEnabled(true)
    process.env.OPENCODE_ANTHROPIC_AUTH_DUMP_DIR = ${json(join(blockedParent, 'dumps'))}
    const blocked = await dump.dumpDirectRequest({
      affinity: 'dump-session-01', route: 'cachekeep', status: 500, bodyText: '{}',
    })
    process.env.OPENCODE_ANTHROPIC_AUTH_DUMP_DIR = ${json(join(root, 'dumps'))}
    const written = await dump.dumpDirectRequest({
      affinity: 'dump-session-02', route: 'cachekeep', status: 200,
      bodyText: ${json(`{"unterminated": "${RELAY_ECHO}`)},
    })
    await dump.dumpResponseArtifact(
      { responsePath: ${json(join(root, `missing-${TOKEN_ECHO}`, 'r.json'))} },
      { status: 529, message: {} },
    )

    const now = Date.now()
    const window = {
      usedPercent: 10, remainingPercent: 90, checkedAt: now,
      resetsAt: new Date(now + 3_600_000).toISOString(),
    }
    const storage = {
      version: 1,
      quota: { enabled: true, checkIntervalMinutes: 5 },
      accounts: [{
        id: 'fallback-b', type: 'oauth', enabled: true,
        access: 'synthetic-access', refresh: 'synthetic-refresh',
        expires: now + 60_000,
        quota: { five_hour: window, seven_day: window },
      }],
    }
    // The cached-quota producer was retired. Preserve its archived diagnostic as
    // input to the real production logger, not as a claim about account routing.
    log('[refresh] fallback quota using cached quota after refresh error', { accountId: storage.accounts[0].id })
    const usable = storage.accounts
    console.log(JSON.stringify({
      blocked: blocked === null,
      written: written !== null,
      usable: usable.map((account) => account.id),
    }))
  `
  const run = spawnOwnedChild(suiteOwner, fixture, script, {
    env: {
      ...process.env,
      NODE_ENV: 'production',
      OPENCODE_ANTHROPIC_AUTH_LOG_LEVEL: 'debug',
      OPENCODE_ANTHROPIC_AUTH_LOG_FILE: logPath,
    },
  })
  const code = await run.exited
  const out = await run.stdout
  const errors = await run.stderr
  expect(run.child.signalCode, errors).toBeNull()
  expect(code, errors).toBe(0)
  expect(JSON.parse(out)).toEqual({
    blocked: true,
    written: true,
    usable: ['fallback-b'],
  })

  const log = await readFile(logPath, 'utf8')
  const lines = log
    .split('\n')
    .map((line) =>
      line.replace(/^\[[^\]]+\] /, '').replace(/"pid":\d+/, '"pid":0'),
    )
  expect(lines).toContain(
    'DEBUG [relay] dump failed session=dump-session-01 {"pid":0}',
  )
  expect(lines).toContain('DEBUG [relay] dump body parse failed {"pid":0}')
  expect(lines).toContain(
    'DEBUG [relay] dump response failed status=529 {"pid":0}',
  )
  expect(lines).toContain(
    'DEBUG [refresh] fallback quota using cached quota after refresh error {"accountId":"fallback-b","pid":0}',
  )
  expectNoEcho(log)
})
