import { expect, spyOn } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as Core from '@cortexkit/anthropic-auth-core'
import {
  type NativeAccountSnapshot,
  type OAuthQuotaSnapshot,
  resetClaudeCodeIdentityCachesForTest,
  tokenFingerprint,
} from '@cortexkit/anthropic-auth-core'
import { createOpencodeClient, type Provider } from '@opencode-ai/sdk'
import { $ } from 'bun'
import {
  createTestLifetimeSuite,
  TestLifetime,
} from '../../../core/src/tests/test-lifetime.ts'
import { AnthropicAuthPlugin } from '../index.ts'
import { drainSidebarWrites } from '../sidebar-state.ts'
import {
  migrateNativeOpencodeFixture,
  type NativeOpencodeFixture,
} from './native-fixture.ts'

/*
 * A killswitch-enabled request polls every due fallback quota before it may
 * route to that fallback. The first test makes that poll fail for a real
 * reason: a second process is half-way through replacing the fallback's
 * login. Its new credential is in the pool state file, but the config write
 * that completes the row has not happened yet, so the row is "torn" and the
 * runtime refuses to read its quota. The writer then finishes, so by the
 * time the request chooses a route the row is coherent again but still has
 * no quota reading. The second test lets the same writer finish before the
 * poll, which then reads the new login's quota.
 *
 * Settings: fallback-first routing, so the fallback is considered before
 * main; killswitch floors 5% (five-hour) and 10% (seven-day), which the
 * fallback inherits; quota.enabled=false and refresh.enabled=false, so no
 * startup poll or proactive refresh touches the fallback (the killswitch
 * still requires its own poll); failClosedOnUnknownQuota=false, so an
 * unknown quota alone is not a refusal.
 */

type PluginHooks = Awaited<ReturnType<typeof AnthropicAuthPlugin>>
type PluginFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>
type AuthLoader = NonNullable<NonNullable<PluginHooks['auth']>['loader']>
type HostAuth = Awaited<ReturnType<Parameters<AuthLoader>[0]>>

const MAIN_UUID = '00000000-0000-4000-8000-00000000a001'
const FALLBACK_UUID = '00000000-0000-4000-8000-00000000b001'
const FALLBACK_ID = 'preflight-fallback'
const MAIN_ACCESS = 'sk-ant-oat01-preflight-main-access'
const MAIN_REFRESH = 'sk-ant-ort01-preflight-main-refresh'
const FALLBACK_ACCESS = 'sk-ant-oat01-preflight-fallback-access'
const FALLBACK_REFRESH = 'sk-ant-ort01-preflight-fallback-refresh'
// The login the second process writes over the fallback. While the fallback
// has no quota reading, a request must not reach the model endpoint with it.
const REPLACEMENT_ACCESS = 'sk-ant-oat01-preflight-fallback-replacement'
const REPLACEMENT_REFRESH = 'sk-ant-ort01-preflight-fallback-replacement'
const MESSAGES_URL = 'https://api.anthropic.com/v1/messages'

const accountForBearer = new Map([
  [`Bearer ${MAIN_ACCESS}`, MAIN_UUID],
  [`Bearer ${FALLBACK_ACCESS}`, FALLBACK_UUID],
  [`Bearer ${REPLACEMENT_ACCESS}`, FALLBACK_UUID],
])

// Every variable a body sets; each body restores all of them.
const envKeys = [
  'OPENCODE_ANTHROPIC_AUTH_FILE',
  'OPENCODE_ANTHROPIC_AUTH_STATE_FILE',
  'OPENCODE_ANTHROPIC_AUTH_ROUTING_STATE_FILE',
  'OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE',
  'OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_CONNECTION_FILE',
  'OPENCODE_ANTHROPIC_AUTH_SIDEBAR_STATE_FILE',
  'OPENCODE_ANTHROPIC_AUTH_CACHEKEEP_REGISTRY_DIR',
  'OPENCODE_ANTHROPIC_AUTH_RPC_DIR',
  'OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION',
  'OPENCODE_AUTH_CONTENT',
  'CLAUDE_CONFIG_DIR',
  'XDG_DATA_HOME',
] as const

const provider: Provider = {
  id: 'anthropic',
  name: 'Anthropic',
  source: 'custom',
  env: [],
  options: {},
  models: {},
}

const lifetimes = createTestLifetimeSuite()
const test = lifetimes.test

/** The parts of a fallback's public account view this file compares. */
type RowState = {
  present: boolean
  enabled: boolean
  credentialEpoch?: number
  accountIdentity?: string
  hasQuota: boolean
}

function rowState(snapshot: NativeAccountSnapshot, id: string): RowState {
  const row = snapshot.accounts.find((account) => account.id === id)
  return {
    present: row !== undefined,
    enabled: row?.enabled === true,
    ...(row?.binding ? { credentialEpoch: row.binding.credentialEpoch } : {}),
    ...(row?.accountIdentity ? { accountIdentity: row.accountIdentity } : {}),
    hasQuota: row?.quota !== undefined,
  }
}

type OutboundRecord = { url: string; authorization: string }

function usageReading(now: number) {
  return {
    five_hour: {
      utilization: 10,
      resets_at: new Date(now + 60 * 60_000).toISOString(),
    },
    seven_day: {
      utilization: 10,
      resets_at: new Date(now + 3 * 24 * 60 * 60_000).toISOString(),
    },
  }
}

const opencodePackageRoot = new URL('../..', import.meta.url).pathname
const quotaCodecModule = new URL(
  '../../../core/src/native-quota-codec.ts',
  import.meta.url,
).pathname

/*
 * The second process. It replaces the fallback's login through the public
 * runtime's putAccount. A replacement writes the pool state file first and
 * the config file second, and the runtime calls beforePoolWrite before each
 * of those writes without saying which one. So at each call the writer reads
 * the pool: when its row already shows as torn, the state write has landed
 * and this call precedes the config write. In "hold" mode the writer reports
 * the torn row on stdout and waits there until stdin delivers "release";
 * in "complete" mode it never waits.
 */
const WRITER_SCRIPT = `
import {
  createNativeAccountRuntime,
  createNativePoolStore,
} from '@cortexkit/anthropic-auth-core'
import { nativeQuotaCodec } from ${JSON.stringify(quotaCodecModule)}

const input = JSON.parse(process.env.KILLSWITCH_PREFLIGHT_WRITER)
const emit = (event) => process.stdout.write(JSON.stringify(event) + '\\n')
const released = input.hold
  ? new Promise((resolve, reject) => {
      let text = ''
      process.stdin.setEncoding('utf8')
      process.stdin.on('data', (chunk) => {
        text += chunk
        if (text.includes('release\\n')) resolve()
      })
      process.stdin.on('end', () =>
        reject(new Error('writer input closed before release')),
      )
    })
  : Promise.resolve()
released.catch(() => {})
const store = createNativePoolStore({ paths: input.paths, quota: nativeQuotaCodec })
const observed = []
let held = false
const runtime = createNativeAccountRuntime({
  paths: input.paths,
  host: 'opencode',
  beforePoolWrite: async () => {
    const read = await store.read()
    const row =
      read.status === 'ready'
        ? read.rows.find((candidate) => candidate.id === input.routeId)
        : undefined
    observed.push(row?.torn === true ? 'torn' : 'coherent')
    if (!input.hold || held || row?.torn !== true) return
    held = true
    emit({
      event: 'held',
      row: {
        torn: row.torn,
        candidate: row.candidate,
        credentialEpoch: row.credentialEpoch,
        identity: row.identity,
        hasQuota: row.quota !== undefined,
      },
    })
    await released
  },
})
try {
  const view = await runtime.putAccount({
    routeId: input.routeId,
    credential: input.credential,
    accountIdentity: input.accountIdentity,
    replace: true,
  })
  emit({
    event: 'done',
    held,
    observed,
    view: {
      id: view.id,
      enabled: view.enabled,
      credentialEpoch: view.binding?.credentialEpoch,
    },
  })
} finally {
  runtime.close()
}
`

type WriterEvent = { event: string; [key: string]: unknown }
type WriterResult = {
  exitCode: number | null
  signalCode: Bun.Subprocess['signalCode']
  events: WriterEvent[]
  stderr: string
}

/** Collect a child's stdout as lines; next() waits for the next line or end. */
function lineReader(stream: ReadableStream<Uint8Array>) {
  const lines: string[] = []
  let cursor = 0
  let ended = false
  let wake: (() => void) | undefined
  const done = (async () => {
    const reader = stream.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    try {
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) break
        buffer += decoder.decode(chunk.value, { stream: true })
        for (
          let end = buffer.indexOf('\n');
          end >= 0;
          end = buffer.indexOf('\n')
        ) {
          lines.push(buffer.slice(0, end))
          buffer = buffer.slice(end + 1)
          wake?.()
        }
      }
      buffer += decoder.decode()
      if (buffer) lines.push(buffer)
    } finally {
      ended = true
      wake?.()
    }
    return lines
  })()
  return {
    done,
    async next(): Promise<string | undefined> {
      while (cursor >= lines.length && !ended)
        await new Promise<void>((resolve) => {
          wake = resolve
        })
      return cursor < lines.length ? lines[cursor++] : undefined
    },
  }
}

function parseEvent(line: string | undefined): WriterEvent {
  if (line === undefined) return { event: 'stdout-ended' }
  try {
    const value: unknown = JSON.parse(line)
    if (
      value &&
      typeof value === 'object' &&
      'event' in value &&
      typeof value.event === 'string'
    )
      return { ...value, event: value.event }
  } catch {}
  return { event: 'unparsed', line }
}

/**
 * Start the writer child, owned by `lifetime` (this test body's by
 * default). Its cancellation gate opens either when join() has seen the exit
 * and both pipes end, or when that lifetime starts closing, which happens
 * before the lifetime waits for its body. In the second case the child is
 * killed if it is still running, so a body waiting on it (or on pool locks it
 * holds) can finish. The lifetime waits for the cancellation, the exit and
 * both pipes, and fails teardown if any of them rejected, even when the body
 * never called join().
 */
function startWriter(
  fixture: NativeOpencodeFixture,
  mode: 'hold' | 'complete',
  lifetime: Pick<TestLifetime, 'gate' | 'trackDetached'> = lifetimes,
) {
  const child = Bun.spawn([process.execPath, '--eval', WRITER_SCRIPT], {
    cwd: opencodePackageRoot,
    env: {
      ...process.env,
      ...fixture.env,
      KILLSWITCH_PREFLIGHT_WRITER: JSON.stringify({
        paths: fixture.paths,
        routeId: FALLBACK_ID,
        hold: mode === 'hold',
        accountIdentity: FALLBACK_UUID,
        credential: {
          type: 'oauth',
          access: REPLACEMENT_ACCESS,
          refresh: REPLACEMENT_REFRESH,
          expires: Date.now() + 8 * 60 * 60_000,
        },
      }),
    },
    stdin: mode === 'hold' ? 'pipe' : 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const cancel = lifetime.gate()
  const cancellation = cancel.wait.then(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill()
  })
  lifetime.trackDetached(cancellation)
  const stdout = lineReader(child.stdout)
  const joined = Promise.allSettled([
    child.exited,
    stdout.done,
    new Response(child.stderr).text(),
  ])
  lifetime.trackDetached(
    joined.then((results) => {
      const failures = results.flatMap((result) =>
        result.status === 'rejected' ? [result.reason] : [],
      )
      if (failures.length)
        throw new AggregateError(failures, 'Writer process join failed')
    }),
  )
  let released = false
  return {
    next: async () => parseEvent(await stdout.next()),
    release() {
      if (released || !child.stdin) return
      released = true
      // A child that already exited has closed its input; that exit is
      // reported by join() instead.
      try {
        child.stdin.write('release\n')
        child.stdin.end()
      } catch {}
    },
    async join(): Promise<WriterResult> {
      const [exit, lines, stderr] = await joined
      // The child has exited and both pipes have ended; the gate is no
      // longer needed for cancellation.
      cancel.open()
      await cancellation
      return {
        exitCode: exit.status === 'fulfilled' ? exit.value : null,
        signalCode: child.signalCode,
        events:
          lines.status === 'fulfilled'
            ? lines.value.map((line) => parseEvent(line))
            : [{ event: 'stdout-failed' }],
        stderr:
          stderr.status === 'fulfilled' ? stderr.value : 'stderr-read-failed',
      }
    },
  }
}

type FallbackFloors = { five_hour: number; seven_day: number; scoped: number }

/** What the wrapped fallback quota fetch observed during its first call. */
type PreflightEvidence = {
  before?: RowState
  held?: WriterEvent
  during?: RowState
  outcome?:
    | { status: 'fulfilled'; value: OAuthQuotaSnapshot }
    | { status: 'rejected'; name: unknown; code: unknown }
  writer?: WriterResult
  after?: RowState
}

type PreflightStep = (call: {
  /** Read the pool's public account views, outside the plugin. */
  read: () => Promise<NativeAccountSnapshot>
  /** The unwrapped fetchQuota for this call's arguments. */
  fetchQuota: () => Promise<OAuthQuotaSnapshot>
  fixture: NativeOpencodeFixture
  evidence: PreflightEvidence
}) => Promise<OAuthQuotaSnapshot>

/**
 * Migrate a private local pool for this test body through the shared native
 * fixture: main plus one OAuth fallback, neither with a quota reading.
 * `fallbackFloors` gives the fallback its own killswitch floors instead of
 * inheriting main's. Process environment is left unchanged.
 */
async function migratePool(fallbackFloors?: FallbackFloors) {
  const root = await mkdtemp(join(tmpdir(), 'killswitch-preflight-'))
  // The fixture removes the root once it accepts it; this covers a body that
  // fails before that.
  lifetimes.deferCleanup(() => rm(root, { recursive: true, force: true }))
  const now = Date.now()
  const fixture = await migrateNativeOpencodeFixture({
    root,
    lifetime: lifetimes,
    legacyConfig: {
      version: 1,
      main: {
        type: 'opencode',
        provider: 'anthropic',
        // A profile observed for the main access token lets migration bind
        // main to its account, which bootstrap then confirms.
        profile: {
          tier: 'default_claude_max_20x',
          orgType: 'claude_max',
          checkedAt: now,
          providerAccountUuid: MAIN_UUID,
          tokenFingerprint: tokenFingerprint(MAIN_ACCESS),
        },
      },
      fallbackOn: [401, 403, 429],
      routing: { mode: 'fallback-first' },
      refresh: { enabled: false },
      quota: { enabled: false, failClosedOnUnknownQuota: false },
      killswitch: {
        enabled: true,
        main: { five_hour: 5, seven_day: 10 },
        ...(fallbackFloors && { accounts: { [FALLBACK_ID]: fallbackFloors } }),
      },
      claudeCache: { enabled: false },
      accounts: [
        {
          id: FALLBACK_ID,
          label: FALLBACK_ID,
          type: 'oauth',
          enabled: true,
          access: FALLBACK_ACCESS,
          refresh: FALLBACK_REFRESH,
          expires: now + 8 * 60 * 60_000,
          anthropicAccountUuid: FALLBACK_UUID,
        },
      ],
    },
    hostAuth: {
      anthropic: {
        type: 'oauth',
        access: MAIN_ACCESS,
        refresh: MAIN_REFRESH,
        expires: now + 8 * 60 * 60_000,
      },
    },
  })
  return { fixture, now }
}

/**
 * Migrate a private local pool (main plus one OAuth fallback, neither with a
 * quota reading), install the transport mock, and load the plugin with the
 * fallback's first quota fetch routed through `step`. The step runs only
 * once the request starts, so plugin startup cannot consume it.
 * `fallbackFloors` gives the fallback its own killswitch floors instead of
 * inheriting main's.
 */
async function startBody(step: PreflightStep, fallbackFloors?: FallbackFloors) {
  const savedFetch = globalThis.fetch
  const savedEnv = new Map(envKeys.map((key) => [key, process.env[key]]))
  let stopPlugin: (() => Promise<void>) | undefined
  // Runs after the body and its tracked work. The plugin has normally been
  // stopped already through its gate; stopping again is a no-op.
  lifetimes.deferCleanup(async () => {
    try {
      await stopPlugin?.()
    } finally {
      try {
        await drainSidebarWrites()
      } finally {
        globalThis.fetch = savedFetch
        for (const key of envKeys) {
          const value = savedEnv.get(key)
          if (value === undefined) delete process.env[key]
          else process.env[key] = value
        }
        resetClaudeCodeIdentityCachesForTest()
      }
    }
  })
  const { fixture, now } = await migratePool(fallbackFloors)
  for (const [key, value] of Object.entries(fixture.env))
    process.env[key] = value
  process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION = '1'
  process.env.XDG_DATA_HOME = join(fixture.root, 'synthetic-data')
  delete process.env.OPENCODE_AUTH_CONTENT
  resetClaudeCodeIdentityCachesForTest()

  const records: OutboundRecord[] = []
  globalThis.fetch = Object.assign(
    async (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ): Promise<Response> => {
      const url =
        input instanceof Request
          ? input.url
          : input instanceof URL
            ? input.href
            : input
      const headers = new Headers(
        init?.headers ?? (input instanceof Request ? input.headers : undefined),
      )
      const authorization = headers.get('authorization') ?? ''
      records.push({ url, authorization })
      const account = accountForBearer.get(authorization)
      if (url.includes('/claude_cli/bootstrap'))
        return account
          ? Response.json({ oauth_account: { account_uuid: account } })
          : new Response('unknown token', { status: 401 })
      if (url.includes('/api/oauth/usage'))
        return account
          ? Response.json(usageReading(Date.now()))
          : new Response('unknown token', { status: 401 })
      if (url.includes('/v1/messages'))
        return Response.json({
          id: 'msg_preflight',
          type: 'message',
          role: 'assistant',
          model: 'claude-sonnet-4-6',
          content: [{ type: 'text', text: 'ok' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 1, output_tokens: 1 },
        })
      return new Response('unexpected request', { status: 599 })
    },
    { preconnect: savedFetch.preconnect },
  )

  const evidence: PreflightEvidence = {}
  let armed = false
  let consumed = false
  const factory = Core.createNativeAccountRuntime
  // The test reads public account views through its own runtime, which the
  // spy below does not wrap and which stays open until the body has settled.
  const observer = factory({ paths: fixture.paths, host: 'opencode' })
  lifetimes.deferCleanup(() => observer.close())
  const read = () => observer.read()
  const spy = spyOn(Core, 'createNativeAccountRuntime').mockImplementation(
    (options) => {
      const runtime = factory(options)
      const fetchQuota = runtime.fetchQuota.bind(runtime)
      runtime.fetchQuota = (routeId, fetchImpl, signal, dispatch) => {
        if (routeId !== FALLBACK_ID || !armed || consumed)
          return fetchQuota(routeId, fetchImpl, signal, dispatch)
        consumed = true
        return step({
          read,
          fetchQuota: () => fetchQuota(routeId, fetchImpl, signal, dispatch),
          fixture,
          evidence,
        })
      }
      return runtime
    },
  )
  lifetimes.deferCleanup(() => spy.mockRestore())

  // Stop the plugin when the lifetime starts closing, before it waits for the
  // body, so a body blocked on plugin work is released.
  const stopping = lifetimes.gate()
  const creation = AnthropicAuthPlugin(
    {
      client: createOpencodeClient({
        baseUrl: 'http://127.0.0.1:9',
        fetch: globalThis.fetch,
      }),
      project: {
        id: 'killswitch-preflight-fixture',
        worktree: fixture.root,
        time: { created: now },
      },
      directory: fixture.root,
      worktree: fixture.root,
      serverUrl: new URL('http://127.0.0.1:9'),
      experimental_workspace: { register() {} },
      $,
    },
    { scopedRosterPollIntervalMs: 0, cacheKeepAggregateRefreshIntervalMs: 0 },
  )
  let disposal: Promise<void> | undefined
  const stop = () => {
    disposal ??= creation.then(async (created) => {
      await created.dispose?.()
    })
    return disposal
  }
  stopPlugin = stop
  lifetimes.trackDetached(stopping.wait.then(stop))
  const plugin = await creation
  const loader: AuthLoader | undefined = plugin.auth?.loader
  if (!loader) throw new Error('Plugin did not install its auth loader')
  // OpenCode passes the auth entry the migration left in its auth.json.
  const options = await loader(async () => {
    const stored: { anthropic: HostAuth } = JSON.parse(
      await readFile(fixture.hostAuthPath, 'utf8'),
    )
    return stored.anthropic
  }, provider)
  const handler = options.fetch
  if (typeof handler !== 'function')
    throw new Error('Plugin did not install its request handler')
  const send: PluginFetch = async (input, init) => {
    const response: unknown = await handler(input, init)
    if (!(response instanceof Response))
      throw new Error('Plugin request handler did not return a Response')
    return response
  }
  return {
    fixture,
    records,
    evidence,
    read,
    /** Send one replayable model request; the fallback preflight is armed for it. */
    async request() {
      armed = true
      const response = await send(MESSAGES_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 1,
          messages: [{ role: 'user', content: 'hello' }],
        }),
      })
      return { status: response.status, body: await response.text() }
    },
  }
}

function bearersFor(records: OutboundRecord[], path: string) {
  return records
    .filter((record) => record.url.includes(path))
    .map((record) => record.authorization)
}

/**
 * Run the plugin's first fallback quota fetch (the poll the killswitch
 * requires before it may route to the fallback) while the writer process is
 * held between its two writes, so the real fetch meets a torn row. Then let
 * the writer finish and wait for it to exit before returning the fetch's own
 * outcome to the plugin. The plugin's poll therefore receives a genuine
 * refusal, and its next pool read finds a coherent row with the new
 * credential and no quota reading.
 */
const fetchDuringTornReplacement: PreflightStep = async ({
  read,
  fetchQuota,
  fixture,
  evidence,
}) => {
  evidence.before = rowState(await read(), FALLBACK_ID)
  const writer = startWriter(fixture, 'hold')
  evidence.held = await writer.next()
  evidence.during = rowState(await read(), FALLBACK_ID)
  let outcome:
    | { status: 'fulfilled'; value: OAuthQuotaSnapshot }
    | { status: 'rejected'; reason: unknown }
  try {
    outcome = { status: 'fulfilled', value: await fetchQuota() }
  } catch (reason) {
    outcome = { status: 'rejected', reason }
  }
  writer.release()
  evidence.writer = await writer.join()
  evidence.after = rowState(await read(), FALLBACK_ID)
  if (outcome.status === 'fulfilled') {
    evidence.outcome = outcome
    return outcome.value
  }
  const reason = outcome.reason
  evidence.outcome = {
    status: 'rejected',
    name: reason instanceof Error ? reason.name : typeof reason,
    code:
      reason && typeof reason === 'object' && 'code' in reason
        ? reason.code
        : undefined,
  }
  throw reason
}

/** Let the writer finish completely, then run the real quota fetch. */
const fetchAfterCompletedReplacement: PreflightStep = async ({
  read,
  fetchQuota,
  fixture,
  evidence,
}) => {
  evidence.before = rowState(await read(), FALLBACK_ID)
  const writer = startWriter(fixture, 'complete')
  evidence.writer = await writer.join()
  evidence.during = rowState(await read(), FALLBACK_ID)
  const value = await fetchQuota()
  evidence.outcome = { status: 'fulfilled', value }
  evidence.after = rowState(await read(), FALLBACK_ID)
  return value
}

/**
 * The fallback's state before, during and after a held cross-process
 * replacement whose torn row refused the plugin's first quota fetch.
 * `migrated` is the fallback as the fixture's migration left it.
 */
function expectTornPreflight(evidence: PreflightEvidence, migrated: RowState) {
  // The preflight started from a coherent row with no reading.
  expect(evidence.before).toEqual(migrated)
  // The writer process stopped after its state write, leaving the row torn.
  expect(evidence.held).toEqual({
    event: 'held',
    row: {
      torn: true,
      candidate: false,
      credentialEpoch: expect.any(Number),
      identity: FALLBACK_UUID,
      hasQuota: false,
    },
  })
  expect(evidence.during).toMatchObject({ present: true, enabled: false })
  // The real fetch refused the torn row; this error reached the plugin.
  expect(evidence.outcome).toEqual({
    status: 'rejected',
    name: 'NativeCustodyError',
    code: 'route-unavailable',
  })
  // The writer finished its replacement and exited before the plugin saw
  // the refusal.
  expect(evidence.writer).toEqual({
    exitCode: 0,
    signalCode: null,
    stderr: '',
    events: [
      expect.objectContaining({ event: 'held' }),
      {
        event: 'done',
        held: true,
        observed: ['coherent', 'torn'],
        view: {
          id: FALLBACK_ID,
          enabled: true,
          credentialEpoch: expect.any(Number),
        },
      },
    ],
  })
  // Routing then reads a coherent, enabled row with the new login and still
  // no quota reading.
  expect(evidence.after).toEqual({
    present: true,
    enabled: true,
    credentialEpoch: expect.any(Number),
    accountIdentity: FALLBACK_UUID,
    hasQuota: false,
  })
  expect(evidence.after?.credentialEpoch).toBeGreaterThan(
    migrated.credentialEpoch ?? Number.POSITIVE_INFINITY,
  )
}

/** The fallback as migration left it: enabled, bound, and with no reading. */
async function expectMigratedFallback(body: {
  read: () => Promise<NativeAccountSnapshot>
}) {
  const migrated = rowState(await body.read(), FALLBACK_ID)
  expect(migrated).toEqual({
    present: true,
    enabled: true,
    credentialEpoch: migrated.credentialEpoch,
    accountIdentity: FALLBACK_UUID,
    hasQuota: false,
  })
  expect(migrated.credentialEpoch).toBeNumber()
  return migrated
}

test('a fallback whose required killswitch preflight was refused by a torn cross-process replacement is not routed', async () => {
  const body = await startBody(fetchDuringTornReplacement)
  const migrated = await expectMigratedFallback(body)

  const response = await body.request()
  const { evidence, records } = body
  expectTornPreflight(evidence, migrated)

  // Main is above its floor, so it serves the request with its own login.
  // The fallback's new login never reaches the model endpoint.
  expect(response.status).toBe(200)
  expect(bearersFor(records, '/v1/messages')).toEqual([`Bearer ${MAIN_ACCESS}`])
  expect(bearersFor(records, '/api/oauth/usage')).toContain(
    `Bearer ${MAIN_ACCESS}`,
  )
  const main = (await body.read()).accounts.find(
    (account) => account.id === 'main',
  )
  expect(main?.quota?.accountIdentity).toBe(MAIN_UUID)
  expect(main?.quota?.five_hour?.remainingPercent).toBe(90)
  expect(main?.quota?.seven_day?.remainingPercent).toBe(90)
})

test('a fallback with no killswitch floors stays routable after a torn cross-process replacement refuses its preflight', async () => {
  // This fallback's own floors are all zero, so it has no floor that a
  // reading would have to prove, and failClosedOnUnknownQuota=false lets it
  // serve without one. Main keeps its positive 5% and 10% floors.
  const body = await startBody(fetchDuringTornReplacement, {
    five_hour: 0,
    seven_day: 0,
    scoped: 0,
  })
  const migrated = await expectMigratedFallback(body)

  const response = await body.request()
  const { evidence, records } = body
  expectTornPreflight(evidence, migrated)

  // The refused quota poll does not exclude this floorless fallback. With
  // fallback-first routing the request goes to the fallback, using its new
  // login, and is never sent with main's login.
  expect(response.status).toBe(200)
  expect(bearersFor(records, '/v1/messages')).toEqual([
    `Bearer ${REPLACEMENT_ACCESS}`,
  ])
})

test('a fallback replaced by another process before its killswitch preflight is read and routed', async () => {
  const body = await startBody(fetchAfterCompletedReplacement)
  const migrated = rowState(await body.read(), FALLBACK_ID)

  const response = await body.request()
  const { evidence, records } = body

  expect(evidence.before).toEqual(migrated)
  expect(evidence.writer).toEqual({
    exitCode: 0,
    signalCode: null,
    stderr: '',
    events: [
      {
        event: 'done',
        held: false,
        observed: ['coherent', 'torn'],
        view: {
          id: FALLBACK_ID,
          enabled: true,
          credentialEpoch: expect.any(Number),
        },
      },
    ],
  })
  expect(evidence.during).toEqual({
    present: true,
    enabled: true,
    credentialEpoch: expect.any(Number),
    accountIdentity: FALLBACK_UUID,
    hasQuota: false,
  })
  expect(evidence.during?.credentialEpoch).toBeGreaterThan(
    migrated.credentialEpoch ?? Number.POSITIVE_INFINITY,
  )
  // The preflight read the new login's quota: 90% left on both windows,
  // above the 5% and 10% floors.
  expect(evidence.outcome).toMatchObject({
    status: 'fulfilled',
    value: {
      accountIdentity: FALLBACK_UUID,
      five_hour: { remainingPercent: 90 },
      seven_day: { remainingPercent: 90 },
    },
  })
  expect(evidence.after).toMatchObject({
    present: true,
    enabled: true,
    hasQuota: true,
  })
  expect(bearersFor(records, '/api/oauth/usage')).toContain(
    `Bearer ${REPLACEMENT_ACCESS}`,
  )

  // Fallback-first routing sends the request with the fallback's new login.
  expect(response.status).toBe(200)
  expect(bearersFor(records, '/v1/messages')).toEqual([
    `Bearer ${REPLACEMENT_ACCESS}`,
  ])
})

test('finishing the owning lifetime kills a held writer and joins its exit and both pipes before cleanup', async () => {
  // No plugin and no request: this case checks only the writer's
  // cancellation. It uses its own TestLifetime, finished directly by the
  // test rather than by a Bun timeout. Outer cancellation also finishes the
  // private owner before joining this body, including a wait for child stdout.
  const owner = new TestLifetime()
  const outerClosing = lifetimes.gate()
  lifetimes.trackDetached(outerClosing.wait.then(() => owner.finish()))
  lifetimes.deferCleanup(() => owner.finish())
  const { fixture } = await migratePool()
  const writer = startWriter(fixture, 'hold', owner)
  // The child has written the new credential to the state file and is now
  // waiting before the config write, holding the pool locks.
  expect(await writer.next()).toEqual({
    event: 'held',
    row: {
      torn: true,
      candidate: false,
      credentialEpoch: expect.any(Number),
      identity: FALLBACK_UUID,
      hasQuota: false,
    },
  })

  let joinedResult: WriterResult | undefined
  const joining = owner.runBody(async () => {
    joinedResult = await writer.join()
    return joinedResult
  })
  // Cleanup runs only after the body and all tracked work have settled.
  // Record what had settled by then.
  let atCleanup: WriterResult | undefined
  owner.deferCleanup(() => {
    atCleanup = joinedResult
  })
  // Nothing releases the writer, so only the gate's kill lets join() end.
  await owner.finish()

  // Bun reports a SIGTERM exit as status 143 (128 + 15).
  const killed = {
    exitCode: 143,
    signalCode: 'SIGTERM' as const,
    stderr: '',
    events: [expect.objectContaining({ event: 'held' })],
  }
  expect(atCleanup).toEqual(killed)
  expect(await joining).toEqual(killed)
})
