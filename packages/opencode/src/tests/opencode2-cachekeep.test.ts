import { afterEach, expect, spyOn, test } from 'bun:test'
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'
import {
  __setLogTestSink,
  ANTHROPIC_OAUTH_ORIGIN_REFUSAL,
  CACHE_KEEP_PREWARM_LEAD_MS,
  CACHE_KEEP_TTL_MS,
  CacheKeepManager,
  CacheKeepSessionRegistry,
  type CacheKeepTarget,
  createNativeAccountRuntime,
  createNativePoolStore,
  decideStickyQuotaFailure,
  formatLogLine,
  getLogLevel,
  logger,
  NativeCustodyError,
  type NativeLockEvent,
  RequestGzipLatch,
  resolveNativePoolPaths,
  runNativeMigration,
  sessionCacheActivity,
  setLogLevel,
} from '@cortexkit/anthropic-auth-core'
import {
  type Attempt,
  placeholderSecret,
} from '@cortexkit/common-auth/opencode2'
import type { Plugin } from '@opencode/plugin'
import type { SessionHooks } from '@opencode/plugin/promise/session'
import { nativeQuotaCodec } from '../../../core/src/native-quota-codec'
import { nativeVaultPaths } from '../../../core/src/native-vault-paths.ts'
import * as wireTransform from '../transform'
import * as nativeAdapters from '../v2/adapter'
import {
  createNativeAnthropicAdapter,
  type NativeAnthropicAttemptData,
} from '../v2/adapter'
import * as cacheKeepFactory from '../v2/cachekeep'
import { createNativeCacheKeep } from '../v2/cachekeep'
import {
  type CacheKeepStore,
  cacheKeepStoreDirectory,
} from '../v2/cachekeep-store'
import { createNativeMenuCapabilities } from '../v2/menu'
import { setupAnthropicAuth } from '../v2/setup'
import type { NativeSource } from '../v2/source'
import * as sourceFactory from '../v2/source'

const cleanups: Array<() => void | Promise<void>> = []
let reportFailure: (() => void) | undefined
afterEach(async () => {
  const report = reportFailure
  reportFailure = undefined
  report?.()
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function cacheKeepFailureTrace() {
  const started = performance.now()
  const events: string[] = []
  const pending = new Set<string>()
  const locks = new Map<string, string>()
  let completed = false
  const record = (event: string) => {
    events.push(`${Math.round(performance.now() - started)}ms ${event}`)
    if (events.length > 100) events.shift()
  }
  const snapshot = () => ({
    pending: [...pending],
    locks: [...locks.values()],
    events: [...events],
  })
  let nearDeadline: ReturnType<typeof snapshot> | undefined
  // Capture the pending work before the five-second test timeout; report it only on failure.
  const timer = setTimeout(() => {
    nearDeadline = snapshot()
  }, 4500)
  reportFailure = () => {
    clearTimeout(timer)
    if (!completed)
      console.error(
        'policy-refused CacheKeep failure phases',
        JSON.stringify({ nearDeadline, atFailure: snapshot() }, null, 2),
      )
  }
  return {
    record,
    lock(event: NativeLockEvent) {
      const key = `${event.path}:${event.name}`
      const label = `${event.name} (${basename(event.path)}, ${event.detached ? 'background' : 'foreground'})`
      if (event.type === 'released') locks.delete(key)
      else locks.set(key, `${event.type}: ${label}`)
      if (event.type !== 'contended') record(`lock ${event.type}: ${label}`)
    },
    async wait<T>(phase: string, work: () => T | Promise<T>): Promise<T> {
      pending.add(phase)
      record(`${phase} started`)
      try {
        const result = await work()
        record(`${phase} settled`)
        return result
      } catch (error) {
        record(`${phase} rejected`)
        throw error
      } finally {
        pending.delete(phase)
      }
    },
    observeStore(store: CacheKeepStore, label: string) {
      const removed = store.removed.bind(store)
      const removal = spyOn(store, 'removed').mockImplementation((id) => {
        record(`${label} restart delete enqueued: ${id}`)
        removed(id)
      })
      const drain = store.drain.bind(store)
      const draining = spyOn(store, 'drain').mockImplementation(() =>
        this.wait(`${label} persistence drain`, drain),
      )
      cleanups.push(() => {
        removal.mockRestore()
        draining.mockRestore()
      })
    },
    complete() {
      completed = true
      clearTimeout(timer)
    },
  }
}

class Timers {
  constructor(
    private readonly now: () => number,
    private readonly afterTick: () => Promise<unknown>,
  ) {}
  readonly callbacks = new Map<object, () => unknown>()
  readonly timeouts = new Map<object, { callback: () => unknown; at: number }>()
  readonly setTimeout: typeof globalThis.setTimeout = ((
    callback: () => unknown,
    ms: number,
  ) => {
    const id = { unref() {} }
    this.timeouts.set(id, { callback, at: this.now() + ms })
    return id
  }) as unknown as typeof globalThis.setTimeout
  readonly clearTimeout: typeof globalThis.clearTimeout = ((id: object) => {
    this.timeouts.delete(id)
  }) as unknown as typeof globalThis.clearTimeout
  async fireTimeouts() {
    for (const [id, timeout] of this.timeouts) {
      if (timeout.at > this.now()) continue
      this.timeouts.delete(id)
      await timeout.callback()
    }
    await this.afterTick()
  }
  readonly setInterval: typeof globalThis.setInterval = ((
    callback: () => unknown,
  ) => {
    const id = { unref() {} }
    this.callbacks.set(id, callback)
    return id
  }) as unknown as typeof globalThis.setInterval
  readonly clearInterval: typeof globalThis.clearInterval = ((id: object) => {
    this.callbacks.delete(id)
  }) as unknown as typeof globalThis.clearInterval
  async fire() {
    await Promise.all(
      [...this.callbacks.values()].map((callback) => callback()),
    )
    await this.afterTick()
  }
}

async function fixture(
  child = false,
  brokenRegistry = false,
  savedLevel?: string,
  vaultMode = false,
  unsafePersistence = false,
  trace?: ReturnType<typeof cacheKeepFailureTrace>,
  identity = '11111111-2222-4333-8444-555555555555',
  getSession?: () => Promise<{ parentID?: string }>,
) {
  const directory = await mkdtemp(join(tmpdir(), 'oc2-cachekeep-'))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  const paths = await resolveNativePoolPaths(
    join(directory, 'accounts.json'),
    join(directory, 'state.json'),
  )
  await writeFile(
    paths.legacyConfig,
    JSON.stringify({ version: 1, accounts: [] }),
  )
  await writeFile(
    paths.legacyState,
    JSON.stringify({ version: 1, accounts: {} }),
  )
  await runNativeMigration({
    paths,
    host: 'opencode',
    hostAuthPath: join(directory, 'auth.json'),
    routingSourcePath: join(directory, 'old-routing.json'),
    routingDestinationPath: join(directory, 'routing.json'),
    env: {},
    processFence: async () => {},
    removePiAnthropicAuth: false,
  })
  const store = createNativePoolStore({
    paths,
    quota: nativeQuotaCodec,
    ...(trace && { onLockEvent: trace.lock }),
  })
  for (const id of ['first', 'second']) {
    await store.add({
      id,
      identity:
        id === 'first' ? identity : '99999999-2222-4333-8444-555555555555',
      credential: {
        type: 'oauth',
        access: `sk-ant-oat01-${id}`,
        refresh: `refresh-${id}`,
        expires: Date.now() + 10 * 3600_000,
      },
    })
  }
  await store.updateSettings(() => ({
    mainAccountId: 'first',
    quota: { enabled: false },
    routing: { mode: 'main-first' },
    claudeCache: { enabled: true, mode: 'hybrid' },
    cacheKeep: { enabled: true, always: true },
    ...(savedLevel && { logging: { level: savedLevel } }),
  }))
  if (vaultMode) {
    await writeFile(
      join(directory, 'enrollment.json'),
      JSON.stringify({
        token: '01'.repeat(32),
        token_generation: 1,
      }),
      { mode: 0o600 },
    )
    const vaultStore = createNativePoolStore({
      paths: nativeVaultPaths(paths),
      quota: nativeQuotaCodec,
    })
    await vaultStore.initialize()
    await vaultStore.updateSettings((settings) => ({
      ...settings,
      logging: { level: 'debug' },
    }))
  }
  let now = Date.now()
  const timers = new Timers(
    () => now,
    async () => {
      // Registry publication is queued after a scheduler pass. Join the writer
      // before the fixture's separate registry reader inspects the lease file.
      const key = Symbol.for('cortexkit.anthropic-auth.opencode2.cachekeep.v2')
      await (globalThis as any)[key]?.get(paths.storageId)?.registry.list()
    },
  )
  const registryDirectory = join(directory, 'registry')
  if (brokenRegistry) await writeFile(registryDirectory, 'not a directory')
  const registry = new CacheKeepSessionRegistry({
    directory: registryDirectory,
    now: () => now,
  })
  if (unsafePersistence)
    await mkdir(cacheKeepStoreDirectory(paths.storageId, directory), {
      recursive: true,
      mode: 0o755,
    })
  const start = async (enrollmentFile = 'enrollment.json') => {
    const hooks = new Map<string, Array<(draft: any) => unknown>>()
    const registration = { dispose: async () => {} }
    const ctx = {
      session: {
        get:
          getSession ??
          (async () => ({ parentID: child ? 'ses_parent' : undefined })),
        hook: async (name: string, callback: (draft: any) => unknown) => {
          hooks.set(name, [...(hooks.get(name) ?? []), callback])
          return registration
        },
      },
      model: { transform: async () => registration },
      integration: {
        transform: async () => {
          logger.debug('startup-test', 'registering integration')
          return registration
        },
      },
      rpc: {
        register: async () => ({
          ...registration,
          events: { emit: async () => {} },
        }),
      },
      command: { transform: async () => registration },
      event: { subscribe: async function* () {} },
    } as unknown as Plugin.Context
    const sent: Request[] = []
    let send: (request: Request) => Promise<Response> = async () =>
      Response.json({ usage: { cache_read_input_tokens: 1 } })
    const dispose = await setupAnthropicAuth(ctx, {
      paths,
      vault: {
        env: {
          OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE: join(
            directory,
            enrollmentFile,
          ),
        },
      },
      local: {
        ...(trace && { onLockEvent: trace.lock }),
        resolveIdentity: async (access) =>
          ({
            accountUuid: access.endsWith('first')
              ? identity
              : '99999999-2222-4333-8444-555555555555',
          }) as never,
      },
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        const request = new Request(input as Request, init)
        if (new URL(request.url).pathname !== '/v1/messages') {
          trace?.record(`lifecycle fetch: ${new URL(request.url).pathname}`)
          return Response.json({})
        }
        sent.push(request.clone() as Request)
        return send(request as Request)
      }) as typeof fetch,
      cacheKeep: {
        now: () => now,
        setIntervalImpl: timers.setInterval,
        clearIntervalImpl: timers.clearInterval,
        setTimeoutImpl: timers.setTimeout,
        clearTimeoutImpl: timers.clearTimeout,
        registryDirectory,
        persistence: {
          root: directory,
          now: () => now,
          setTimeoutImpl: timers.setTimeout,
          clearTimeoutImpl: timers.clearTimeout,
        },
      },
    })
    cleanups.push(dispose)
    const prepare = async (
      url = 'https://api.anthropic.com/v1/messages',
      extra: Record<string, unknown> = {},
      sessionID = 'ses_oc2_keep',
      signal?: AbortSignal,
      agent = 'build',
    ) => {
      const draft = {
        sessionID: sessionID as SessionHooks['http.request']['sessionID'],
        agent,
        model: { providerID: 'anthropic', id: 'claude-sonnet-4-6' },
        kind: 'primary',
        request: new Request(url, {
          method: 'POST',
          signal,
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${placeholderSecret('anthropic')}`,
          },
          body: JSON.stringify({
            model: 'claude-sonnet-4-6',
            max_tokens: 8,
            system: 'Cache me',
            messages: [{ role: 'user', content: 'Hello' }],
            metadata: { user_id: 'untrusted' },
            ...extra,
          }),
        }),
      }
      for (const callback of hooks.get('context') ?? [])
        await callback({
          ...draft,
          messages: [
            {
              id: 'msg_oc2_keep',
              role: 'user',
              content: [{ type: 'text', text: 'Hello' }],
            },
          ],
        })
      const modelDraft = { ...draft, headers: {} as Record<string, string> }
      for (const callback of hooks.get('model.request') ?? [])
        await callback(modelDraft)
      for (const [name, value] of Object.entries(modelDraft.headers))
        draft.request.headers.set(name, value)
      for (const callback of hooks.get('http.request') ?? [])
        await callback(draft)
      return draft
    }
    const respond = async (
      draft: Awaited<ReturnType<typeof prepare>>,
      response = Response.json({ usage: { cache_read_input_tokens: 1 } }),
      consume = true,
    ) => {
      const answered = { ...draft, response }
      for (const callback of hooks.get('http.response') ?? [])
        await callback(answered)
      if (consume) await answered.response.text()
      const key = Symbol.for('cortexkit.anthropic-auth.opencode2.cachekeep.v2')
      await (globalThis as any)[key]?.get(paths.storageId)?.registry.list()
      return answered.response
    }
    const live = async (...args: Parameters<typeof prepare>) => {
      const draft = await prepare(...args)
      await respond(draft)
      return draft.request
    }
    return {
      ctx,
      live,
      prepare,
      respond,
      sent,
      dispose,
      setSend: (callback: typeof send) => {
        send = callback
      },
    }
  }
  return {
    ...(await start()),
    /** Another plugin instance for the same account storage and clock. */
    start,
    paths,
    store,
    routingPath: join(directory, 'routing.json'),
    registry,
    disk: cacheKeepStoreDirectory(paths.storageId, directory),
    timers,
    now: () => now,
    due: () => {
      now += CACHE_KEEP_TTL_MS - CACHE_KEEP_PREWARM_LEAD_MS
    },
    advance: (ms: number) => {
      now += ms
    },
  }
}

function firstLeaseParentSettlement() {
  let done!: () => void
  const settled = new Promise<void>((resolve) => {
    done = resolve
  })
  const create = cacheKeepFactory.createNativeCacheKeep
  let leases = 0
  const factory = spyOn(
    cacheKeepFactory,
    'createNativeCacheKeep',
  ).mockImplementation((options) => {
    const result = create(options)
    if (leases++ === 0) {
      const resolved = result.resolvedParent
      result.resolvedParent = (...args) => {
        const pending = Promise.resolve(resolved(...args))
        void pending.then(done, done)
        return pending
      }
    }
    return result
  })
  cleanups.push(() => factory.mockRestore())
  return settled
}

function captureStartupLogs(onLine?: (line: string) => void) {
  const previous = getLogLevel()
  const env = process.env.OPENCODE_ANTHROPIC_AUTH_LOG_LEVEL
  const lines: string[] = []
  delete process.env.OPENCODE_ANTHROPIC_AUTH_LOG_LEVEL
  setLogLevel('info')
  __setLogTestSink(({ level, channel, message, payload }) => {
    const line = formatLogLine(level, channel, message, payload)
    lines.push(line)
    onLine?.(line)
  })
  cleanups.push(() => {
    __setLogTestSink(null)
    setLogLevel(previous)
    if (env === undefined) delete process.env.OPENCODE_ANTHROPIC_AUTH_LOG_LEVEL
    else process.env.OPENCODE_ANTHROPIC_AUTH_LOG_LEVEL = env
  })
  return lines
}

test('OpenCode 2 saved debug level emits a debug line during plugin startup', async () => {
  const lines = captureStartupLogs()
  await fixture(false, false, 'debug')
  expect(
    lines.some(
      (line) =>
        line.includes('DEBUG') && line.includes('registering integration'),
    ),
  ).toBe(true)
  expect(getLogLevel()).toBe('debug')
})

test('OpenCode 2 startup preserves the environment log-level override', async () => {
  const lines = captureStartupLogs()
  process.env.OPENCODE_ANTHROPIC_AUTH_LOG_LEVEL = 'warn'
  // The logger reads the environment on module load, before host startup.
  setLogLevel('warn')
  await fixture(false, false, 'debug')
  expect(getLogLevel()).toBe('warn')
  expect(lines.some((line) => line.includes('registering integration'))).toBe(
    false,
  )
})

test('OpenCode 2 startup reads saved logging from vault rather than local settings', async () => {
  const lines = captureStartupLogs()
  await fixture(false, false, 'warn', true)
  expect(getLogLevel()).toBe('debug')
  expect(
    lines.some(
      (line) =>
        line.includes('DEBUG') && line.includes('registering integration'),
    ),
  ).toBe(true)
})

test('OpenCode 2 menu re-picking the saved log level repairs live drift', async () => {
  const lines = captureStartupLogs()
  const f = await fixture(false, false, 'debug')
  const runtime = createNativeAccountRuntime({
    paths: f.paths,
    host: 'opencode',
  })
  cleanups.push(() => runtime.close())
  const capabilities = createNativeMenuCapabilities({
    runtime,
    source: {} as NativeSource,
    start: async () => {},
  })
  cleanups.push(() => capabilities.close())
  setLogLevel('info')
  await capabilities.dispatch(
    { action: 'logging-level', values: { level: 'debug' } },
    {},
  )
  logger.debug('menu-test', 'debug after re-pick')
  expect(getLogLevel()).toBe('debug')
  expect(
    lines.some(
      (line) => line.includes('DEBUG') && line.includes('debug after re-pick'),
    ),
  ).toBe(true)
  expect((await runtime.read()).settings.logging).toEqual({ level: 'debug' })
})
test('OpenCode 2 hybrid requests publish a CacheKeep lease and dispose removes its timer', async () => {
  const f = await fixture()
  await f.live()
  expect((await f.registry.list()).map((session) => session.id)).toEqual([
    'ses_oc2_keep',
  ])
  expect(f.timers.callbacks.size).toBe(1)
  await f.dispose()
  expect(f.timers.callbacks.size).toBe(0)
  expect(await f.registry.list()).toEqual([])
})

test('OpenCode 2 publishes response and warm cache facts with the actual touch times', async () => {
  const f = await fixture()
  await f.live()
  expect(await f.registry.list()).toEqual([
    {
      id: 'ses_oc2_keep',
      ttlMs: 3_600_000,
      lastTouchAt: f.now(),
      lastTouchKind: 'response',
      cacheExpiresAt: f.now() + 3_600_000,
      nextPrewarmAt: f.now() + 3_300_000,
    },
  ])
  f.due()
  await f.timers.fire()
  expect(await f.registry.list()).toEqual([
    {
      id: 'ses_oc2_keep',
      ttlMs: 3_600_000,
      lastTouchAt: f.now(),
      lastTouchKind: 'warm',
      cacheExpiresAt: f.now() + 3_600_000,
      nextPrewarmAt: f.now() + 3_300_000,
    },
  ])
})

for (const status of [200, 400]) {
  test(`OC2 prewarm status ${status} refreshes cache activity only on success`, async () => {
    const f = await fixture()
    const sessionId = 'ses_oc2_keep'
    cleanups.push(() => sessionCacheActivity.forget(sessionId))
    await f.live()
    sessionCacheActivity.record(
      sessionId,
      'main',
      3_600_000,
      Date.now() - 5 * 60_000,
    )
    const before = sessionCacheActivity.holdUntil(
      sessionId,
      'main',
      Date.now(),
      'max',
    )
    f.setSend(async () => Response.json({ usage: {} }, { status }))
    f.due()
    await f.timers.fire()
    const after = sessionCacheActivity.holdUntil(
      sessionId,
      'main',
      Date.now(),
      'max',
    )
    if (status !== 200) expect(after).toBe(before)
    else {
      expect(after).toBeGreaterThan(before!)
      const now = after! - 50 * 60_000
      expect(
        decideStickyQuotaFailure({
          quota: {
            five_hour: {
              remainingPercent: 0,
              usedPercent: 100,
              checkedAt: now,
              resetsAt: new Date(now + 10 * 60_000).toISOString(),
            },
          },
          sessionId,
          now,
          holdUntil: sessionCacheActivity.holdUntil(sessionId, 'main', now),
        }).action,
      ).toBe('hold')
    }
  })
}

test('OpenCode 2 rejected oversized request keeps the old target without evicting warm sessions', async () => {
  const lines = captureStartupLogs()
  const f = await fixture()
  await f.live(undefined, { system: 'a'.repeat(1024 * 1024) })
  for (let i = 0; i < 10; i++)
    await f.live(
      undefined,
      { system: 'b'.repeat(3 * 1024 * 1024) },
      `ses_healthy_${i}`,
    )
  const key = Symbol.for('cortexkit.anthropic-auth.opencode2.cachekeep.v2')
  const manager = (globalThis as any)[key].get(f.paths.storageId).manager
  const before = manager.trackedRequest('ses_oc2_keep')
  const sessions = await f.registry.list()
  expect(sessions).toHaveLength(11)
  const draft = await f.prepare(undefined, {
    system: 'c'.repeat(40 * 1024 * 1024),
  })
  await f.respond(
    draft,
    Response.json(
      {
        error: { type: 'invalid_request_error', message: 'prompt is too long' },
      },
      { status: 400 },
    ),
  )
  expect(manager.trackedRequest('ses_oc2_keep')?.bodyText.length).toBe(
    before.bodyText.length,
  )
  expect(manager.trackedRequest('ses_oc2_keep')).toEqual(before)
  expect(await f.registry.list()).toEqual(sessions)
  expect(
    lines.filter((line) => line.includes('stopped warming session')),
  ).toEqual([])
})

test('OpenCode 2 accepts the oversized body at 2xx headers before streaming starts', async () => {
  const f = await fixture()
  await f.live()
  const key = Symbol.for('cortexkit.anthropic-auth.opencode2.cachekeep.v2')
  const manager = (globalThis as any)[key].get(f.paths.storageId).manager
  const before = manager.trackedRequest('ses_oc2_keep')
  const draft = await f.prepare(
    undefined,
    { system: 'c'.repeat(40 * 1024 * 1024), stream: true },
    'ses_oc2_accepted',
  )
  expect(manager.trackedRequest('ses_oc2_keep')).toEqual(before)
  const response = await f.respond(
    draft,
    new Response(new ReadableStream(), { status: 201 }),
    false,
  )
  expect(
    manager.trackedRequest('ses_oc2_accepted').bodyText.length,
  ).toBeGreaterThan(40 * 1024 * 1024)
  expect((await f.registry.list()).map((session) => session.id).sort()).toEqual(
    ['ses_oc2_accepted', 'ses_oc2_keep'],
  )
  await response.body?.cancel()
})

test('OpenCode 2 aborted attempt leaves its old target even if late 2xx headers arrive', async () => {
  const f = await fixture()
  await f.live()
  const key = Symbol.for('cortexkit.anthropic-auth.opencode2.cachekeep.v2')
  const manager = (globalThis as any)[key].get(f.paths.storageId).manager
  const before = manager.trackedRequest('ses_oc2_keep')
  const abort = new AbortController()
  const draft = await f.prepare(
    undefined,
    { system: 'aborted request' },
    undefined,
    abort.signal,
  )
  abort.abort()
  await f.respond(draft)
  expect(manager.trackedRequest('ses_oc2_keep')).toEqual(before)
})

test('OpenCode 2 records its use of the pool at setup and serves a request as before', async () => {
  const f = await fixture()
  const holders = JSON.parse(
    await readFile(
      join(dirname(f.paths.runtime), 'anthropic-auth-holders.json'),
      'utf8',
    ),
  ) as { entries: Array<{ pid: number; role: string; files: string[] }> }
  expect(holders.entries).toEqual([
    expect.objectContaining({ pid: process.pid, role: 'opencode2' }),
  ])
  expect(holders.entries[0]?.files).toContain(f.paths.runtime)
  const request = await f.live()
  expect(request.headers.get('authorization')).toBe('Bearer sk-ant-oat01-first')
})

test('OpenCode 2 registry publication failure never rejects the live request', async () => {
  const f = await fixture(false, true)
  const request = await f.live()
  expect(request.headers.get('authorization')).toBe('Bearer sk-ant-oat01-first')
  expect(f.timers.callbacks.size).toBe(1)
})

test('a due OpenCode 2 prewarm sends once with the original account and no billing lineage', async () => {
  const f = await fixture()
  expect(await (await f.live()).text()).toContain('prompt_id')
  await f.store.rotate('first', {
    type: 'oauth',
    access: 'sk-ant-oat01-rotated-first',
    refresh: 'refresh-first',
    expires: Date.now() + 12 * 3600_000,
  })
  await f.store.updateSettings((settings) => ({
    ...settings,
    mainAccountId: 'second',
  }))
  f.due()
  await f.timers.fire()
  expect(f.sent).toHaveLength(1)
  expect(f.sent[0]!.headers.get('authorization')).toBe(
    'Bearer sk-ant-oat01-rotated-first',
  )
  const body = (await f.sent[0]!.json()) as Record<string, any>
  expect(body.max_tokens).toBe(0)
  expect(body.stream).toBeUndefined()
  expect(JSON.stringify(body)).not.toMatch(/prompt_id|previous_request_id/)
  expect(
    body.system.some((block: any) => block.cache_control?.ttl === '1h'),
  ).toBe(true)
  await f.timers.fire()
  expect(f.sent).toHaveLength(1)
})

test('a killswitch-refused OpenCode 2 target warns once, stops, and tracks the next live account', async () => {
  const lines = captureStartupLogs()
  const f = await fixture()
  await f.live()
  await f.store.updateSettings((settings) => ({
    ...settings,
    mainAccountId: 'second',
    quota: { enabled: false, failClosedOnUnknownQuota: false },
    killswitch: {
      enabled: true,
      main: { five_hour: 0, seven_day: 0 },
      accounts: { first: { five_hour: 10 } },
    },
  }))
  f.due()
  await f.timers.fire()
  expect(f.sent).toHaveLength(0)
  const warnings = () => lines.filter((line) => line.includes(' WARN '))
  expect(warnings()).toHaveLength(1)
  expect(warnings()[0]).toContain('stopped warming session')
  expect(warnings()[0]).toContain('"session":"ses_oc2_keep"')
  expect(warnings()[0]).toContain('"reason":"account-policy"')
  expect(warnings()[0]).toContain('"stage":"authorization"')
  expect(warnings()[0]).toContain('"class":"account-policy"')
  expect(await f.registry.list()).toMatchObject([
    { id: 'ses_oc2_keep', warmStopped: { reason: 'policy-refused' } },
  ])
  f.advance(2 * 60_000)
  await f.timers.fire()
  expect(warnings()).toHaveLength(1)
  expect(f.sent).toHaveLength(0)

  expect((await f.live()).headers.get('authorization')).toBe(
    'Bearer sk-ant-oat01-second',
  )
  expect((await f.registry.list()).map((session) => session.id)).toEqual([
    'ses_oc2_keep',
  ])
  f.due()
  await f.timers.fire()
  expect(f.sent).toHaveLength(1)
  expect(f.sent[0]!.headers.get('authorization')).toBe(
    'Bearer sk-ant-oat01-second',
  )
  expect(warnings()).toHaveLength(1)
})

test('an OpenCode 2 API-key request and a prewarm send produce no WARN', async () => {
  const lines = captureStartupLogs()
  const warming = await fixture(false, false, 'debug')
  await warming.live()
  warming.due()
  await warming.timers.fire()
  expect(warming.sent).toHaveLength(1)
  expect(warming.sent[0]!.headers.get('authorization')).toBe(
    'Bearer sk-ant-oat01-first',
  )

  const api = createNativeAnthropicAdapter({
    source: {
      chooseAccount: () => 'paid',
      authorizeAccount: () => ({
        route: 'api',
        headers: { 'x-api-key': 'synthetic-api-key' },
        provenance: null,
      }),
    },
  })
  cleanups.push(() => api.dispose())
  const scope = {
    providerID: 'anthropic',
    modelID: 'claude-sonnet-4-6',
    sessionID: 'ses_api',
    agent: 'build',
    kind: 'primary' as const,
  }
  const accountId = await api.adapter.chooseAccount({
    ...scope,
    phase: 'request',
  })
  expect(accountId).toBe('paid')
  const authorized = (await api.adapter.accountHeaders({
    ...scope,
    accountId: 'paid',
  })) as {
    attempt: NativeAnthropicAttemptData<null>
  }
  const attempt: Attempt<NativeAnthropicAttemptData<null>> = {
    ...scope,
    accountId: 'paid',
    attemptId: 'api-attempt',
    transport: 'http',
    data: authorized.attempt,
  }
  const request = await api.adapter.rewriteRequest!({
    ...attempt,
    attempt,
    request: new Request('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: scope.modelID,
        max_tokens: 8,
        messages: [{ role: 'user', content: 'Hello' }],
      }),
    }),
  })
  expect(request).toBeInstanceOf(Request)
  if (!request) throw new Error('API-key request was not prepared')
  expect(request.headers.get('x-api-key')).toBe('synthetic-api-key')
  expect((await warming.registry.list()).map((session) => session.id)).toEqual([
    'ses_oc2_keep',
  ])
  expect(lines.filter((line) => line.includes(' WARN '))).toEqual([])
})

test.each([
  [
    'AbortError',
    'send',
    async () => {
      throw new DOMException('SECRET native credential', 'AbortError')
    },
  ],
  [
    'TimeoutError',
    'send',
    async () => {
      throw new DOMException('SECRET native credential', 'TimeoutError')
    },
  ],
  [
    'ECONNRESET',
    'send',
    async () => {
      throw Object.assign(new Error('SECRET native credential'), {
        code: 'ECONNRESET',
      })
    },
  ],
  [
    500,
    'response',
    async () =>
      Response.json(
        { error: { type: 'api_error', message: 'SECRET provider body' } },
        { status: 500 },
      ),
  ],
  [
    'TypeError',
    'response',
    async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new TypeError('SECRET native response'))
          },
        }),
      ),
  ],
] as const)(
  'OpenCode 2 prewarm preserves the closed failure class %s at %s',
  async (failureClass, stage, fail) => {
    const lines = captureStartupLogs()
    const f = await fixture()
    await f.live()
    f.setSend(fail)
    f.due()
    await f.timers.fire()
    const warnings = lines.filter((line) => line.includes(' WARN '))
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('prewarm failed')
    expect(warnings[0]).toContain(`"stage":"${stage}"`)
    expect(warnings[0]).toContain(`"class":${JSON.stringify(failureClass)}`)
    expect(lines.join('\n')).not.toContain('SECRET')
    expect(lines.join('\n')).not.toContain('sk-ant-oat01-first')
  },
)

test('OpenCode 2 prewarm classifies a vault authorization refusal without credentials', async () => {
  const lines = captureStartupLogs()
  const f = await fixture()
  await f.live()
  const runtime = createNativeAccountRuntime({
    paths: f.paths,
    host: 'opencode',
  })
  const keeper = createNativeCacheKeep({
    runtime,
    storageId: f.paths.storageId,
    persistence: { root: dirname(f.paths.legacyConfig) },
    source: {
      chooseAccount: () => 'first',
      close: async () => {},
      drainRoutingPublications: async () => {},
      resetRouting: async () => {},
      servedAccount: () => undefined,
      recordPrime: async () => false,
      authorizeAccount: () => {
        const error = new NativeCustodyError('unavailable')
        error.message = 'SECRET vault credential'
        throw error
      },
    },
  })
  cleanups.push(async () => {
    await keeper.dispose()
    runtime.close()
  })
  await keeper.ready
  f.due()
  await f.timers.fire()
  expect(f.sent).toHaveLength(0)
  const warnings = lines.filter((line) => line.includes(' WARN '))
  expect(warnings).toHaveLength(1)
  expect(warnings[0]).toContain('prewarm failed')
  expect(warnings[0]).toContain('"stage":"authorization"')
  expect(warnings[0]).toContain('"class":"unavailable"')
  expect(lines.join('\n')).not.toContain('SECRET')
})

test('an OpenCode 2 prewarm sends the live request prefix as it was sent, without rewriting it again', async () => {
  const f = await fixture()
  // The stored body is the one already sent: tool names prefixed, billing
  // and identity blocks added. Rewriting it again changes that prefix, so the
  // prewarm would write a new cache entry instead of reading the session's.
  const sentLive = JSON.parse(
    await (
      await f.live(undefined, {
        tools: [
          {
            name: 'read',
            description: 'Read a file',
            input_schema: { type: 'object', properties: {} },
          },
        ],
      })
    ).text(),
  ) as Record<string, any>
  expect(sentLive.tools[0].name).toBe('mcp_Read')
  f.due()
  await f.timers.fire()
  expect(f.sent).toHaveLength(1)
  const warm = (await f.sent[0]!.json()) as Record<string, any>
  expect(warm.tools).toEqual(sentLive.tools)
  // Only the first system block, the billing header, may differ: it carries
  // the signature over the changed prewarm body.
  expect(warm.system).toHaveLength(sentLive.system.length)
  expect(warm.system.slice(1)).toEqual(sentLive.system.slice(1))
  expect(warm.messages).toEqual(sentLive.messages)
})

test('turning OpenCode 2 cache keepalive off prevents due prewarms', async () => {
  const f = await fixture()
  await f.live()
  expect(f.timers.callbacks.size).toBe(1)
  await f.store.updateSettings((settings) => ({
    ...settings,
    cacheKeep: { enabled: false },
  }))
  f.due()
  await f.timers.fire()
  expect(f.sent).toHaveLength(0)
})

test('OpenCode 2 only keeps child sessions warm when subagent tracking is enabled', async () => {
  const f = await fixture(true)
  await f.live()
  expect(await f.registry.list()).toEqual([])
  expect(f.timers.callbacks.size).toBe(0)
  await f.store.updateSettings((settings) => ({
    ...settings,
    cacheKeep: { enabled: true, always: true, subagents: true },
  }))
  await f.live()
  expect(f.timers.callbacks.size).toBe(1)
  expect(await f.registry.list()).toHaveLength(1)
})

test('OpenCode 2 never prewarms a replacement login in the same account row', async () => {
  const lines = captureStartupLogs()
  const f = await fixture()
  await f.live()
  expect(f.timers.callbacks.size).toBe(1)
  await f.store.replace(
    'first',
    {
      type: 'oauth',
      access: 'sk-ant-oat01-replaced-first',
      refresh: 'replacement-refresh',
      expires: Date.now() + 12 * 3600_000,
    },
    { identity: '11111111-2222-4333-8444-555555555555' },
  )
  await f.store.updateSettings((settings) => ({
    ...settings,
    mainAccountId: 'first',
  }))
  f.due()
  await f.timers.fire()
  expect(f.sent).toHaveLength(0)
  expect(await f.registry.list()).toMatchObject([
    { id: 'ses_oc2_keep', warmStopped: { reason: 'policy-refused' } },
  ])
  expect(lines.filter((line) => line.includes(' WARN '))).toHaveLength(1)
  expect(lines.find((line) => line.includes(' WARN '))).toContain(
    '"reason":"credential-changed"',
  )
  f.advance(2 * 60_000)
  await f.timers.fire()
  expect(f.sent).toHaveLength(0)
  expect(lines.filter((line) => line.includes(' WARN '))).toHaveLength(1)
})

test('OpenCode 2 dispose aborts and joins an in-flight prewarm', async () => {
  const f = await fixture()
  let entered!: () => void
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  let finish!: () => void
  const ended = new Promise<void>((resolve) => {
    finish = resolve
  })
  f.setSend(async (request) => {
    entered()
    await new Promise<void>((resolve) =>
      request.signal.addEventListener('abort', () => resolve(), { once: true }),
    )
    await ended
    throw new Error('cancelled prewarm')
  })
  await f.live()
  expect(f.timers.callbacks.size).toBe(1)
  f.due()
  const tick = f.timers.fire()
  await started
  let disposed = false
  const closing = Promise.resolve(f.dispose()).then(() => {
    disposed = true
  })
  await Promise.resolve()
  expect(disposed).toBe(false)
  finish()
  await closing
  await tick
  expect(f.timers.callbacks.size).toBe(0)
})

test('a later OpenCode 2 instance for the same storage keeps warming a session the disposed one tracked', async () => {
  const f = await fixture()
  await f.live()
  const next = await f.start()
  await f.dispose()
  expect(f.timers.callbacks.size).toBe(1)
  expect((await f.registry.list()).map((session) => session.id)).toEqual([
    'ses_oc2_keep',
  ])
  // A token refreshed after the reload must be the one the prewarm carries.
  await f.store.rotate('first', {
    type: 'oauth',
    access: 'sk-ant-oat01-reloaded-first',
    refresh: 'refresh-first',
    expires: Date.now() + 12 * 3600_000,
  })
  f.due()
  await f.timers.fire()
  expect(f.sent).toHaveLength(0)
  expect(next.sent).toHaveLength(1)
  expect(next.sent[0]!.headers.get('authorization')).toBe(
    'Bearer sk-ant-oat01-reloaded-first',
  )
})

test('retired OpenCode 2 hooks serve the next step through the successor with the session pin', async () => {
  const f = await fixture()
  await f.store.updateSettings((settings) => ({
    ...settings,
    routing: { mode: 'sticky-balanced' },
  }))
  await f.store.disable('first', 'user')
  const first = await f.live()
  expect(first.headers.get('authorization')).toBe('Bearer sk-ant-oat01-second')
  const next = await f.start()
  await f.dispose()
  const pins = JSON.parse(await readFile(f.routingPath, 'utf8')).assignments
  expect(Object.values(pins)).toMatchObject([{ accountId: 'second' }])
  await f.store.enable('first')
  await f.store.rotate('second', {
    type: 'oauth',
    access: 'sk-ant-oat01-reloaded-second',
    refresh: 'refresh-second',
    expires: Date.now() + 12 * 3600_000,
  })
  const request = await f.live()
  expect(request.headers.get('authorization')).toBe(
    'Bearer sk-ant-oat01-reloaded-second',
  )
  expect(
    Object.values(
      JSON.parse(await readFile(f.routingPath, 'utf8')).assignments,
    ),
  ).toMatchObject([{ accountId: 'second' }])
  f.due()
  await f.timers.fire()
  expect(f.sent).toHaveLength(0)
  expect(next.sent).toHaveLength(1)
  expect(f.timers.callbacks.size).toBe(1)
  await next.dispose()
  expect(f.timers.callbacks.size).toBe(0)
})

test('retired OpenCode 2 hooks still refuse closed without a live successor', async () => {
  const f = await fixture()
  await f.dispose()
  await expect(f.prepare()).rejects.toThrow('Native custody refused: closed')
})

test('retired OpenCode 2 hooks skip a disposed middle generation', async () => {
  const f = await fixture()
  const middle = await f.start()
  const newest = await f.start()
  await f.dispose()
  await middle.dispose()
  await f.live()
  f.due()
  await f.timers.fire()
  expect(f.sent).toHaveLength(0)
  expect(middle.sent).toHaveLength(0)
  expect(newest.sent).toHaveLength(1)
  expect(f.timers.callbacks.size).toBe(1)
})

test('retired OpenCode 2 hooks do not adopt a setup with different vault options', async () => {
  const f = await fixture()
  await f.start('different-enrollment.json')
  await f.dispose()
  await expect(f.prepare()).rejects.toThrow('Native custody refused: closed')
})

test('a late OpenCode 2 dispose of the predecessor leaves its successor warming', async () => {
  const f = await fixture()
  await f.live()
  const next = await f.start()
  let entered!: () => void
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const aborted: boolean[] = []
  next.setSend(async (request) => {
    entered()
    await gate
    aborted.push(request.signal.aborted)
    return Response.json({ usage: { cache_read_input_tokens: 1 } })
  })
  f.due()
  const tick = f.timers.fire()
  await started
  // The predecessor is disposed while its successor's prewarm is in flight.
  await f.dispose()
  release()
  await tick
  expect(aborted).toEqual([false])
  expect(f.timers.callbacks.size).toBe(1)
  f.due()
  await f.timers.fire()
  expect(f.sent).toHaveLength(0)
  expect(next.sent).toHaveLength(2)
  expect(aborted).toEqual([false, false])
})

test('an OpenCode 2 prewarm never goes through a disposed instance, even the newest', async () => {
  const f = await fixture()
  const newer = await f.start()
  await newer.live()
  await newer.dispose()
  f.due()
  await f.timers.fire()
  expect(newer.sent).toHaveLength(0)
  expect(f.sent).toHaveLength(1)
  expect(f.sent[0]!.headers.get('authorization')).toBe(
    'Bearer sk-ant-oat01-first',
  )
})

test('an OpenCode 2 instance for different account storage adopts nothing a disposed instance retained', async () => {
  const f = await fixture()
  await f.live()
  await f.dispose()
  const other = await fixture()
  // Adoption would restart the retained sessions' timer, which runs on the
  // first fixture's timers, and list them in the first fixture's registry.
  expect(f.timers.callbacks.size).toBe(0)
  expect(other.timers.callbacks.size).toBe(0)
  f.due()
  other.due()
  await f.timers.fire()
  await other.timers.fire()
  expect(other.sent).toHaveLength(0)
  expect(await f.registry.list()).toEqual([])
  expect(await other.registry.list()).toEqual([])
})

test('an OpenCode 2 instance that boots after the last one was disposed keeps warming its sessions', async () => {
  const f = await fixture()
  await f.live()
  await f.dispose()
  expect(f.timers.callbacks.size).toBe(0)
  const next = await f.start()
  expect(f.timers.callbacks.size).toBe(1)
  f.due()
  await f.timers.fire()
  expect(f.sent).toHaveLength(0)
  expect(next.sent).toHaveLength(1)
  expect(next.sent[0]!.headers.get('authorization')).toBe(
    'Bearer sk-ant-oat01-first',
  )
})

test('OpenCode 2 restores a gzipped session after a server restart with the same cacheable prefix', async () => {
  const f = await fixture()
  const live = (await (
    await f.live(undefined, {
      tools: [
        { name: 'read', description: 'Read', input_schema: { type: 'object' } },
      ],
    })
  ).json()) as Record<string, any>
  await f.dispose()
  const [name] = await readdir(f.disk)
  expect(name).toMatch(/^[a-f0-9]{64}\.json\.gz$/)
  const bytes = await readFile(join(f.disk, name!))
  expect([...bytes.subarray(0, 2)]).toEqual([0x1f, 0x8b])
  const saved = gunzipSync(bytes).toString()
  expect(saved).not.toMatch(
    /authorization|x-api-key|sk-ant-oat01|refresh-first|placeholder/,
  )
  // A fresh server has no process-wide registry, even though its files survive.
  for (const version of ['v1', 'v2']) {
    const key = Symbol.for(
      `cortexkit.anthropic-auth.opencode2.cachekeep.${version}`,
    )
    ;(globalThis as any)[key]?.delete(f.paths.storageId)
  }
  const next = await f.start()
  f.due()
  await f.timers.fire()
  expect(next.sent).toHaveLength(1)
  const warm = (await next.sent[0]!.json()) as Record<string, any>
  expect(warm.tools).toEqual(live.tools)
  expect(warm.system.slice(1)).toEqual(live.system.slice(1))
  expect(warm.messages).toEqual(live.messages)
  expect(warm.max_tokens).toBe(0)
  expect(next.sent[0]!.headers.get('authorization')).toBe(
    'Bearer sk-ant-oat01-first',
  )
})

function forgetCacheKeepProcess(storageId: string) {
  const key = Symbol.for('cortexkit.anthropic-auth.opencode2.cachekeep.v2')
  ;(globalThis as any)[key]?.delete(storageId)
}

test('OpenCode 2 restores and prewarms a live format-1 record from another plugin version', async () => {
  const lines = captureStartupLogs()
  const f = await fixture(false, false, 'debug')
  const live = (await (await f.live()).json()) as Record<string, any>
  await f.dispose()
  const [name] = await readdir(f.disk)
  const path = join(f.disk, name!)
  const saved = JSON.parse(gunzipSync(await readFile(path)).toString())
  expect(saved.v).toBe(1)
  saved.pluginVersion = '0.0.0'
  await writeFile(path, gzipSync(JSON.stringify(saved)))
  forgetCacheKeepProcess(f.paths.storageId)
  lines.length = 0
  const next = await f.start()
  expect(await readdir(f.disk)).toEqual([name!])
  const summaries = lines.filter((line) =>
    line.includes('restart records loaded'),
  )
  expect(summaries).toHaveLength(1)
  expect(summaries[0]).toContain('INFO  [cachekeep]')
  expect(summaries[0]).toContain('"restored":1,"dropped":0')
  f.due()
  await f.timers.fire()
  expect(next.sent).toHaveLength(1)
  const warm = (await next.sent[0]!.json()) as Record<string, any>
  expect(warm.messages).toEqual(live.messages)
  expect(warm.system.slice(1)).toEqual(live.system.slice(1))
  expect(warm.max_tokens).toBe(0)
})

test.each([false, true])(
  'an OpenCode 2 adopted entry writes through the newer store (legacy callbacks: %s)',
  async (legacy) => {
    const f = await fixture()
    const first = (await (await f.live()).json()) as Record<string, any>
    const key = Symbol.for('cortexkit.anthropic-auth.opencode2.cachekeep.v2')
    const owner = (globalThis as any)[key].get(f.paths.storageId)
    const oldStore: CacheKeepStore = owner.persistence
    if (legacy) delete owner.persistenceFollowsOwner
    const next = await f.start()
    const newStore: CacheKeepStore = owner.persistence
    expect(newStore).not.toBe(oldStore)
    await newStore.drain()
    const [name] = await readdir(f.disk)
    const saved = () =>
      readFile(join(f.disk, name!)).then((bytes) =>
        JSON.parse(gunzipSync(bytes).toString()),
      )
    expect(JSON.parse((await saved()).bodyText).messages).toEqual(
      first.messages,
    )
    const notifications: Array<Readonly<CacheKeepTarget>> = []
    const persist = newStore.changed.bind(newStore)
    const changed = spyOn(newStore, 'changed').mockImplementation((target) => {
      notifications.push({
        ...target,
        policyState: target.policyState && { ...target.policyState },
      })
      persist(target)
    })
    cleanups.push(() => changed.mockRestore())
    const latest = (await (
      await next.live(undefined, {
        messages: [{ role: 'user', content: 'A request after plugin reload' }],
      })
    ).json()) as Record<string, any>
    // The first target notification carries no token counts; after the response
    // drains, one later notification adds them.
    expect(changed).toHaveBeenCalledTimes(2)
    expect(notifications[0]!.policyState?.prefixTokens).toBeUndefined()
    expect(notifications[0]!.policyState?.inputTokens).toBeUndefined()
    expect(notifications[1]).toEqual({
      ...notifications[0]!,
      policyState: {
        ...notifications[0]!.policyState!,
        prefixTokens: 1,
        inputTokens: 1,
      },
    })
    if (legacy) {
      // Emulate an older manager's callback, which captured the first store.
      oldStore.changed(changed.mock.calls[0]![0])
      expect(changed).toHaveBeenCalledTimes(3)
    }
    await newStore.drain()
    expect(JSON.parse((await saved()).bodyText).messages).toEqual(
      latest.messages,
    )
  },
)

test('OpenCode 2 startup reports restored and dropped counts, but not an empty store', async () => {
  const lines = captureStartupLogs()
  const f = await fixture()
  expect(
    lines.filter((line) => line.includes('restart records loaded')),
  ).toEqual([])
  await f.live(undefined, {}, 'ses_live')
  await f.live(undefined, {}, 'ses_expired')
  await f.dispose()
  for (const name of await readdir(f.disk)) {
    const path = join(f.disk, name)
    const saved = JSON.parse(gunzipSync(await readFile(path)).toString())
    if (saved.id !== 'ses_expired') continue
    saved.cacheExpiresAt = 0
    await writeFile(path, gzipSync(JSON.stringify(saved)))
  }
  forgetCacheKeepProcess(f.paths.storageId)
  lines.length = 0
  await f.start()
  const summaries = lines.filter((line) =>
    line.includes('restart records loaded'),
  )
  expect(summaries).toHaveLength(1)
  expect(summaries[0]).toContain('INFO  [cachekeep]')
  expect(summaries[0]).toContain('"restored":1,"dropped":1')
})

test('OpenCode 2 restores the latest body from two steps in the same turn more than five seconds apart', async () => {
  const f = await fixture()
  const first = (await (await f.live()).json()) as Record<string, any>
  f.advance(250)
  await f.timers.fireTimeouts()
  f.advance(6000)
  // live() reuses the same user-message ID, so these tool-loop steps belong
  // to one user turn rather than starting a new turn for the second body.
  const second = (await (
    await f.live(undefined, {
      messages: [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Long tool-loop output' },
        { role: 'user', content: 'Continue from the latest tool step' },
      ],
    })
  ).json()) as Record<string, any>
  expect(second.messages).not.toEqual(first.messages)
  f.advance(250)
  await f.timers.fireTimeouts()
  const [name] = await readdir(f.disk)
  const saved = JSON.parse(
    gunzipSync(await readFile(join(f.disk, name!))).toString(),
  )
  expect(JSON.parse(saved.bodyText).messages).toEqual(second.messages)
  await f.dispose()
  forgetCacheKeepProcess(f.paths.storageId)
  const next = await f.start()
  f.due()
  await f.timers.fire()
  expect(next.sent).toHaveLength(1)
  const warm = (await next.sent[0]!.json()) as Record<string, any>
  expect(warm.messages).toEqual(second.messages)
  expect(warm.system.slice(1)).toEqual(second.system.slice(1))
})

test('OpenCode 2 throttles later tool steps for five seconds but disposal drains the latest body', async () => {
  const f = await fixture()
  const first = (await (await f.live()).json()) as Record<string, any>
  f.advance(250)
  await f.timers.fireTimeouts()
  const second = (await (
    await f.live(undefined, {
      messages: [
        { role: 'user', content: 'Latest tool step before a clean restart' },
      ],
    })
  ).json()) as Record<string, any>
  f.advance(4999)
  await f.timers.fireTimeouts()
  const [name] = await readdir(f.disk)
  const saved = JSON.parse(
    gunzipSync(await readFile(join(f.disk, name!))).toString(),
  )
  expect(JSON.parse(saved.bodyText).messages).toEqual(first.messages)
  expect(f.timers.timeouts.size).toBe(1)
  await f.dispose()
  expect(f.timers.timeouts.size).toBe(0)
  forgetCacheKeepProcess(f.paths.storageId)
  const next = await f.start()
  f.due()
  await f.timers.fire()
  expect(next.sent).toHaveLength(1)
  const warm = (await next.sent[0]!.json()) as Record<string, any>
  expect(warm.messages).toEqual(second.messages)
})

test.each([
  'expired',
  'foreign-identity',
  'format',
  'unreadable',
  'unfinished-write',
  'invalid',
  ...(process.platform === 'win32' ? [] : ['unsafe-file']),
])(
  'OpenCode 2 deletes a %s restart record without sending it',
  async (change) => {
    const lines = captureStartupLogs()
    const f = await fixture(false, false, 'debug')
    await f.live()
    await f.dispose()
    const [name] = await readdir(f.disk)
    const path = join(f.disk, name!)
    const saved = JSON.parse(gunzipSync(await readFile(path)).toString())
    if (change === 'expired') saved.cacheExpiresAt = 0
    if (change === 'foreign-identity')
      saved.oauthAccountIdentity = 'someone-else'
    if (change === 'format') saved.v = 99
    if (change === 'invalid') saved.bodyText = '{not JSON'
    await writeFile(
      path,
      change === 'unreadable' ? 'not gzip' : gzipSync(JSON.stringify(saved)),
    )
    const droppedName =
      change === 'unfinished-write' ? `${name!}.1234.tmp` : name!
    if (change === 'unfinished-write')
      await rename(path, join(f.disk, droppedName))
    if (change === 'unsafe-file') await chmod(path, 0o644)
    forgetCacheKeepProcess(f.paths.storageId)
    lines.length = 0
    const next = await f.start()
    const drops = lines.filter((line) =>
      line.includes('restart record dropped'),
    )
    expect(drops).toHaveLength(1)
    expect(drops[0]).toContain('DEBUG [cachekeep]')
    expect(drops[0]).toContain(`"reason":"${change}"`)
    expect(drops[0]).toContain(`"file":"${droppedName}"`)
    expect(drops[0]).not.toContain(saved.id)
    expect(drops[0]).not.toContain(saved.bodyText)
    const summaries = lines.filter((line) =>
      line.includes('restart records loaded'),
    )
    expect(summaries).toHaveLength(1)
    expect(summaries[0]).toContain('INFO  [cachekeep]')
    expect(summaries[0]).toContain('"restored":0,"dropped":1')
    f.due()
    await f.timers.fire()
    expect(next.sent).toHaveLength(0)
    expect(await readdir(f.disk)).toEqual([])
  },
)

test.each(['removed', 'disabled'])(
  'OpenCode 2 drops a restored session whose account was %s',
  async (change) => {
    const lines = captureStartupLogs()
    const f = await fixture(false, false, 'debug')
    await f.live()
    await f.dispose()
    if (change === 'removed') await f.store.remove('first')
    else await f.store.disable('first', 'user')
    forgetCacheKeepProcess(f.paths.storageId)
    lines.length = 0
    const next = await f.start()
    const drops = lines.filter((line) =>
      line.includes('restart record dropped'),
    )
    expect(drops).toHaveLength(1)
    expect(drops[0]).toContain('"reason":"account-gone"')
    f.due()
    await f.timers.fire()
    expect(next.sent).toHaveLength(0)
    expect(await readdir(f.disk)).toEqual([])
  },
)

test.each(['cachekeep', 'hybrid'])(
  'turning OpenCode 2 %s off deletes persisted targets, including pending writes',
  async (setting) => {
    const f = await fixture()
    await f.live()
    await f.dispose()
    expect(await readdir(f.disk)).toHaveLength(1)
    const next = await f.start()
    await next.live()
    await f.store.updateSettings((settings) => ({
      ...settings,
      ...(setting === 'cachekeep'
        ? { cacheKeep: { enabled: false } }
        : { claudeCache: { enabled: true, mode: 'explicit' as const } }),
    }))
    f.due()
    await f.timers.fire()
    await next.dispose()
    expect(next.sent).toHaveLength(0)
    expect(await readdir(f.disk)).toEqual([])
  },
)

test.skipIf(process.platform === 'win32')(
  'an unsafe OpenCode 2 restart folder warns once and keeps prewarming in memory',
  async () => {
    const logs = captureStartupLogs()
    const f = await fixture(false, false, undefined, false, true)
    await f.live()
    f.due()
    await f.timers.fire()
    expect(f.sent).toHaveLength(1)
    for (let n = 1; n < 25; n++) {
      f.due()
      await f.timers.fire()
    }
    expect(f.sent).toHaveLength(24)
    await f.dispose()
    expect(await readdir(f.disk)).toEqual([])
    expect(logs.filter((line) => line.includes(' WARN '))).toHaveLength(1)
    expect(logs.join('\n')).toContain('retaining sessions in memory only')
  },
)

test('restored OpenCode 2 sessions honour subagent policy', async () => {
  const f = await fixture(true)
  await f.store.updateSettings((settings) => ({
    ...settings,
    cacheKeep: { enabled: true, always: true, subagents: true },
  }))
  await f.live()
  await f.dispose()
  await f.store.updateSettings((settings) => ({
    ...settings,
    cacheKeep: { enabled: true, always: true, subagents: false },
  }))
  forgetCacheKeepProcess(f.paths.storageId)
  const next = await f.start()
  f.due()
  await f.timers.fire()
  expect(next.sent).toHaveLength(0)
  expect(await readdir(f.disk)).toEqual([])
})

test('OpenCode 2 does not restore sessions outside the configured schedule', async () => {
  const f = await fixture()
  await f.live()
  await f.dispose()
  const startHour = (new Date().getHours() + 2) % 24
  await f.store.updateSettings((settings) => ({
    ...settings,
    cacheKeep: { enabled: true, startHour, endHour: (startHour + 1) % 24 },
  }))
  forgetCacheKeepProcess(f.paths.storageId)
  const next = await f.start()
  f.due()
  await f.timers.fire()
  expect(next.sent).toHaveLength(0)
  expect(await readdir(f.disk)).toEqual([])
})

test('OpenCode 2 staggers overdue restored prewarms instead of sending a burst', async () => {
  const f = await fixture()
  await f.live(undefined, {}, 'ses_one')
  await f.live(undefined, {}, 'ses_two')
  await f.dispose()
  forgetCacheKeepProcess(f.paths.storageId)
  f.due()
  const next = await f.start()
  const times: number[] = []
  next.setSend(async () => {
    times.push(Date.now())
    return Response.json({ usage: { cache_read_input_tokens: 1 } })
  })
  await f.timers.fire()
  expect(next.sent).toHaveLength(1)
  f.advance(3000)
  await f.timers.fire()
  expect(next.sent).toHaveLength(2)
  expect(times[1]! - times[0]!).toBeGreaterThanOrEqual(2900)
})

test('a policy-refused OpenCode 2 target is also removed from restart storage', async () => {
  const trace = cacheKeepFailureTrace()
  captureStartupLogs((line) => {
    if (line.includes('stopped warming session')) trace.record(line)
  })
  const f = await trace.wait('fixture', () =>
    fixture(false, false, undefined, false, false, trace),
  )
  const key = Symbol.for('cortexkit.anthropic-auth.opencode2.cachekeep.v2')
  const owner = (globalThis as any)[key].get(f.paths.storageId)
  trace.observeStore(owner.persistence, 'original')
  await trace.wait('accepted live response', () => f.live())
  await trace.wait('original dispose', () => f.dispose())
  const next = await trace.wait('successor startup', () => f.start())
  trace.observeStore(owner.persistence, 'successor')
  await trace.wait('policy settings update', () =>
    f.store.updateSettings((settings) => ({
      ...settings,
      killswitch: {
        enabled: true,
        main: { five_hour: 0, seven_day: 0 },
        accounts: { first: { five_hour: 10 } },
      },
    })),
  )
  f.due()
  await trace.wait('tick and policy refusal', () => f.timers.fire())
  await trace.wait('successor dispose', () => next.dispose())
  expect(next.sent).toHaveLength(0)
  expect(
    await trace.wait('restart directory read', () => readdir(f.disk)),
  ).toEqual([])
  trace.complete()
})

test('nothing is sent while no OpenCode 2 instance exists, and the next one sends with the current token', async () => {
  const f = await fixture()
  await f.live()
  const next = await f.start()
  await next.dispose()
  await f.dispose()
  expect(f.timers.callbacks.size).toBe(0)
  expect(await f.registry.list()).toEqual([])
  f.due()
  await f.timers.fire()
  expect(f.sent).toHaveLength(0)
  expect(next.sent).toHaveLength(0)
  // The prewarm must read the token current when it is sent, never one held
  // from an instance that has gone.
  await f.store.rotate('first', {
    type: 'oauth',
    access: 'sk-ant-oat01-rebooted-first',
    refresh: 'refresh-first',
    expires: Date.now() + 12 * 3600_000,
  })
  const later = await f.start()
  await f.timers.fire()
  expect(f.sent).toHaveLength(0)
  expect(next.sent).toHaveLength(0)
  expect(later.sent).toHaveLength(1)
  expect(later.sent[0]!.headers.get('authorization')).toBe(
    'Bearer sk-ant-oat01-rebooted-first',
  )
})

test('an OpenCode 2 instance that boots after the cache expired adopts nothing', async () => {
  const f = await fixture()
  await f.live()
  await f.dispose()
  f.advance(CACHE_KEEP_TTL_MS)
  const later = await f.start()
  expect(f.timers.callbacks.size).toBe(0)
  await f.timers.fire()
  expect(later.sent).toHaveLength(0)
  expect(await f.registry.list()).toEqual([])
})

/** Sets the test-only loopback OAuth origin until the test's cleanup. */
function admitLoopbackOrigin(origin: string) {
  const saved = process.env.ANTHROPIC_AUTH_TEST_OAUTH_LOOPBACK_ORIGIN
  process.env.ANTHROPIC_AUTH_TEST_OAUTH_LOOPBACK_ORIGIN = origin
  cleanups.push(() => {
    if (saved === undefined)
      delete process.env.ANTHROPIC_AUTH_TEST_OAUTH_LOOPBACK_ORIGIN
    else process.env.ANTHROPIC_AUTH_TEST_OAUTH_LOOPBACK_ORIGIN = saved
  })
}

const LOOPBACK = 'http://127.0.0.1:9'

test('an OpenCode 2 request to a provider baseURL elsewhere is refused and never kept warm', async () => {
  const f = await fixture()
  await expect(f.live(`${LOOPBACK}/v1/messages`)).rejects.toThrow(
    ANTHROPIC_OAUTH_ORIGIN_REFUSAL,
  )
  expect(await f.registry.list()).toEqual([])
  f.due()
  await f.timers.fire()
  expect(f.sent).toHaveLength(0)
})

for (const stillAdmitted of [true, false]) {
  test(`an OpenCode 2 prewarm to a remembered loopback URL ${stillAdmitted ? 'is sent while the test origin admits it' : 'is refused once the origin is no longer allowed'}`, async () => {
    const f = await fixture()
    admitLoopbackOrigin(LOOPBACK)
    await (await f.live(`${LOOPBACK}/v1/messages`)).text()
    expect((await f.registry.list()).map((session) => session.id)).toEqual([
      'ses_oc2_keep',
    ])
    if (!stillAdmitted)
      delete process.env.ANTHROPIC_AUTH_TEST_OAUTH_LOOPBACK_ORIGIN
    f.due()
    await f.timers.fire()
    expect(f.sent.map((request) => new URL(request.url).origin)).toEqual(
      stillAdmitted ? [LOOPBACK] : [],
    )
  })
}

test('planned short warms override local off and child opt-out while preserving the captured prefix', async () => {
  const key = Symbol.for('cortexkit.routing')
  const globals = globalThis as Record<symbol, unknown>
  const original = globals[key]
  globals[key] = (session: string) => ({
    cache: () =>
      session === 'ses_oc2_keep' ? { ttl: 'short', keep_warm: 'always' } : null,
  })
  cleanups.push(() => {
    if (original === undefined) delete globals[key]
    else globals[key] = original
  })
  const f = await fixture(true)
  await f.store.updateSettings((settings) => ({
    ...settings,
    claudeCache: { enabled: false, mode: 'hybrid' },
    cacheKeep: { enabled: false, subagents: false },
  }))
  const live = await f.live()
  const accepted = JSON.parse(await live.clone().text())
  expect(JSON.stringify(accepted)).not.toContain('"ttl":"1h"')
  expect(JSON.stringify(accepted)).toContain(
    '"cache_control":{"type":"ephemeral"}',
  )
  expect(
    [...f.timers.timeouts.values()].some(
      (timer) => timer.at === f.now() + 270_000,
    ),
  ).toBe(true)
  f.advance(270_000)
  await f.timers.fireTimeouts()
  expect(f.sent).toHaveLength(1)
  const warm = JSON.parse(await f.sent[0]!.clone().text())
  // The first system entry is x-anthropic-billing-header: warms remove its
  // prompt IDs and re-sign it. Every other system entry and message stays intact.
  expect(warm.system.slice(1)).toEqual(accepted.system.slice(1))
  expect(warm.messages).toEqual(accepted.messages)
  expect(warm.max_tokens).toBe(0)
  expect(JSON.stringify(warm)).not.toContain('"ttl":"1h"')
  expect((await f.registry.list())[0]).toMatchObject({
    id: 'ses_oc2_keep',
    ttlMs: 300_000,
    lastTouchKind: 'warm',
  })
})

test('OC2 accepted OAuth reports the final no-cache body even with warming refused', async () => {
  const f = await fixture()
  const usage = spyOn(CacheKeepManager.prototype, 'recordAcceptedUsage')
  const key = Symbol.for('cortexkit.routing')
  const globals = globalThis as Record<symbol, unknown>
  const original = globals[key]
  const reports: Array<Record<string, unknown>> = []
  globals[key] = () => ({
    cache: () => ({ ttl: 'none', keep_warm: 'off' }),
    report: (payload: Record<string, unknown>) => {
      if (
        payload.kind === 'cache_touch' ||
        payload.kind === 'cache_warm_stopped'
      )
        reports.push(payload)
    },
  })
  try {
    const draft = await f.prepare()
    expect(await draft.request.clone().text()).not.toContain('cache_control')
    const before = f.now()
    const response = await f.respond(
      draft,
      Response.json({ usage: { cache_read_input_tokens: 12 } }),
      false,
    )
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(reports).toEqual([
      {
        kind: 'cache_touch',
        at: expect.any(Number),
        ttl_ms: 0,
        source: 'response',
      },
    ])
    expect(reports[0]!.at as number).toBeGreaterThanOrEqual(before)
    expect(reports[0]!.at as number).toBeLessThanOrEqual(Date.now())
    expect(f.sent).toEqual([])
    await response.text()
    expect(usage).toHaveBeenCalledWith('ses_oc2_keep', expect.any(String), {
      cache_read_input_tokens: 12,
    })
  } finally {
    usage.mockRestore()
    if (original === undefined) delete globals[key]
    else globals[key] = original
  }
})

test('OC2 recovered 400 to 200 reports exactly once with the recovered applied lifetime', async () => {
  const f = await fixture(
    false,
    false,
    undefined,
    false,
    false,
    undefined,
    '11111111-2222-4333-8444-555555555551',
  )
  const routingKey = Symbol.for('cortexkit.routing')
  const globals = globalThis as Record<symbol, unknown>
  const originalRouting = globals[routingKey]
  const originalFetch = globalThis.fetch
  const reports: Record<string, unknown>[] = []
  const resent: Request[] = []
  globals[routingKey] = () => ({
    cache: () => ({ ttl: 'short', keep_warm: 'always' }),
    report: (payload: Record<string, unknown>) => {
      if (
        payload.kind === 'cache_touch' ||
        payload.kind === 'cache_warm_stopped'
      )
        reports.push(payload)
    },
  })
  globalThis.fetch = (async (
    url: string | URL | Request,
    init?: RequestInit,
  ) => {
    resent.push(new Request(url as Request, init))
    return Response.json(
      { content: [], usage: { cache_read_input_tokens: 12 } },
      { headers: { 'request-id': 'req_recovered_cache' } },
    )
  }) as unknown as typeof fetch
  try {
    const draft = await f.prepare()
    expect(JSON.parse(await draft.request.clone().text()).thread).toEqual({
      type: 'create',
    })
    const before = f.now()
    const response = await f.respond(
      draft,
      Response.json(
        {
          type: 'error',
          error: {
            type: 'invalid_request_error',
            details: { error_code: 'thread_unsupported_request' },
          },
        },
        { status: 400 },
      ),
    )
    expect(response.status).toBe(200)
    expect(resent).toHaveLength(1)
    expect(await resent[0]!.clone().text()).toContain(
      '"cache_control":{"type":"ephemeral"}',
    )
    expect(await resent[0]!.clone().text()).not.toContain('"ttl":"1h"')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(reports).toEqual([
      {
        kind: 'cache_touch',
        at: expect.any(Number),
        ttl_ms: 300_000,
        source: 'response',
      },
    ])
    expect(reports[0]!.at as number).toBeGreaterThanOrEqual(before)
  } finally {
    globalThis.fetch = originalFetch
    if (originalRouting === undefined) delete globals[routingKey]
    else globals[routingKey] = originalRouting
  }
})

test('OC2 aborted recovery reports nothing', async () => {
  const f = await fixture(
    false,
    false,
    undefined,
    false,
    false,
    undefined,
    '11111111-2222-4333-8444-555555555552',
  )
  const routingKey = Symbol.for('cortexkit.routing')
  const globals = globalThis as Record<symbol, unknown>
  const originalRouting = globals[routingKey]
  const originalFetch = globalThis.fetch
  const reports: unknown[] = []
  const abort = new AbortController()
  let sends = 0
  globals[routingKey] = () => ({
    cache: () => ({ ttl: 'short', keep_warm: 'always' }),
    report: (payload: Record<string, unknown>) => {
      if (
        payload.kind === 'cache_touch' ||
        payload.kind === 'cache_warm_stopped'
      )
        reports.push(payload)
    },
  })
  globalThis.fetch = (async () => {
    sends++
    abort.abort()
    return Response.json({
      content: [],
      usage: { cache_read_input_tokens: 12 },
    })
  }) as unknown as typeof fetch
  try {
    const draft = await f.prepare(undefined, {}, 'ses_oc2_keep', abort.signal)
    await f
      .respond(
        draft,
        Response.json(
          {
            type: 'error',
            error: {
              type: 'invalid_request_error',
              details: { error_code: 'thread_unsupported_request' },
            },
          },
          { status: 400 },
        ),
      )
      .catch((error) => expect(error.name).toBe('AbortError'))
    expect(sends).toBe(1)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(reports).toEqual([])
  } finally {
    globalThis.fetch = originalFetch
    if (originalRouting === undefined) delete globals[routingKey]
    else globals[routingKey] = originalRouting
  }
})

test('OC2 ordinary acceptance captures the byte-identical pre-thread snapshot before returning', async () => {
  const f = await fixture()
  const originalRewrite = wireTransform.rewriteRequestBody
  let captured: string | undefined
  const rewrite = spyOn(wireTransform, 'rewriteRequestBody').mockImplementation(
    async (...args) => {
      captured = await originalRewrite(...args)
      return captured
    },
  )
  const track = spyOn(CacheKeepManager.prototype, 'track')
  try {
    const draft = await f.prepare()
    expect(captured).toBeDefined()
    expect(JSON.parse(captured!).thread).toBeUndefined()
    await f.respond(draft, Response.json({ content: [], usage: {} }), false)
    expect(track).toHaveBeenCalledTimes(1)
    expect(track.mock.calls[0]![0].bodyText).toBe(captured!)
  } finally {
    rewrite.mockRestore()
    track.mockRestore()
  }
})

function runnerPolicyForReview(policy: unknown, reports: unknown[] = []) {
  const key = Symbol.for('cortexkit.routing')
  const globals = globalThis as Record<symbol, unknown>
  const original = globals[key]
  globals[key] = () => ({
    cache: () => policy,
    report: (payload: unknown) => reports.push(payload),
  })
  cleanups.push(() => {
    if (original === undefined) delete globals[key]
    else globals[key] = original
  })
}

test('hybrid-disabled request dispatch never waits on a held restart write', async () => {
  const f = await fixture()
  await f.live()
  const owner = (globalThis as any)[
    Symbol.for('cortexkit.anthropic-auth.opencode2.cachekeep.v2')
  ].get(f.paths.storageId)
  await owner.persistence.drain()
  await f.store.updateSettings((settings) => ({
    ...settings,
    cacheKeep: { enabled: false },
  }))
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const drain = spyOn(owner.persistence, 'drain').mockImplementation(() => held)
  let timeout: ReturnType<typeof setTimeout> | undefined
  const preparing = f.prepare()
  try {
    const outcome = await Promise.race([
      preparing.then(() => 'dispatched'),
      new Promise<string>((resolve) => {
        timeout = setTimeout(() => resolve('blocked by bookkeeping'), 2_000)
      }),
    ])
    expect(outcome).toBe('dispatched')
    await f.prepare()
    await owner.manager.tick()
    expect(drain).toHaveBeenCalledTimes(1)
    runnerPolicyForReview({ ttl: 'long', keep_warm: 'always' })
    await f.live()
    release()
    await owner.localCleanup
    drain.mockRestore()
    await owner.persistence.drain()
    const retained: string[] = []
    await owner.persistence.load(f.now(), (entry: { id: string }) => {
      retained.push(entry.id)
      return undefined
    })
    expect(retained).toEqual(['ses_oc2_keep'])
  } finally {
    clearTimeout(timeout)
    release()
    await preparing
    drain.mockRestore()
  }
})

test('reload onto a 2.6.0-shaped owner keeps legacy warm dispatch and accepted usage safe', async () => {
  const f = await fixture()
  const reports: unknown[] = []
  runnerPolicyForReview(null, reports)
  await f.live()
  // Drain the initial response's detached report before counting reload reports.
  await new Promise((resolve) => setTimeout(resolve, 0))
  reports.length = 0
  const owner = (globalThis as any)[
    Symbol.for('cortexkit.anthropic-auth.opencode2.cachekeep.v2')
  ].get(f.paths.storageId)
  const original = owner.manager
  owner.manager = new Proxy(original, {
    get(target, name) {
      if (
        [
          'reserveWarmDispatch',
          'isCurrentTarget',
          'recordAcceptedUsage',
          'trackedPolicyState',
        ].includes(String(name))
      )
        return undefined
      const value = Reflect.get(target, name)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  const next = await f.start()
  await next.live()
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(
    reports.filter((value: any) => value.kind === 'cache_touch'),
  ).toHaveLength(1)
  f.due()
  await f.timers.fire()
  expect(next.sent).toHaveLength(1)
  const debug = spyOn(logger, 'debug')
  cleanups.push(() => debug.mockRestore())
  runnerPolicyForReview({ ttl: 'long', keep_warm: 'always' })
  await next.live()
  f.due()
  await f.timers.fire()
  expect(next.sent).toHaveLength(1)
  expect(
    debug.mock.calls.filter((call) =>
      String(call[1]).includes('planned warming requires a server restart'),
    ),
  ).toHaveLength(1)
  owner.manager = original
})

test.each(['http-relay', 'gzip'] as const)(
  'planned %s warm preserves physical transport framing',
  async (transport) => {
    const f = await fixture()
    await f.live(undefined, {
      system: 'Large stable cache prefix. '.repeat(10_000),
    })
    const owner = (globalThis as any)[
      Symbol.for('cortexkit.anthropic-auth.opencode2.cachekeep.v2')
    ].get(f.paths.storageId)
    const captured = owner.manager.trackedRequest('ses_oc2_keep')
    expect(captured).toBeDefined()
    runnerPolicyForReview({ ttl: 'long', keep_warm: 'always' })
    expect(
      owner.manager.track({
        ...captured,
        sessionId: 'ses_oc2_keep',
        headers: new Headers(),
        storage: { version: 1, accounts: [], cacheKeep: { enabled: false } },
        cacheMode: 'hybrid',
        ttlMs: 3_600_000,
      }).tracked,
    ).toBe(true)
    const original = nativeAdapters.createNativeAnthropicAdapter
    {
      const intercepted = ((deps: Parameters<typeof original>[0]) =>
        original({
          ...deps,
          requestGzipLatch: new RequestGzipLatch(),
          source:
            transport === 'gzip'
              ? deps.source
              : {
                  ...deps.source,
                  async authorizeAccount(
                    ...args: Parameters<
                      NonNullable<typeof deps.source.authorizeAccount>
                    >
                  ) {
                    const authorization = await deps.source.authorizeAccount?.(
                      ...args,
                    )
                    return authorization?.route === 'oauth'
                      ? {
                          ...authorization,
                          dispatch: {
                            kind: 'http-relay',
                            url: 'https://relay.example/v1/messages',
                            token: 'synthetic-relay',
                          },
                        }
                      : authorization
                  },
                },
        })) as typeof original
      const spy = spyOn(
        nativeAdapters,
        'createNativeAnthropicAdapter',
      ).mockImplementation(intercepted)
      cleanups.push(() => spy.mockRestore())
    }
    f.advance(3_580_000)
    await f.timers.fireTimeouts()
    expect(f.sent).toHaveLength(1)
    const sent = f.sent[0]!
    if (transport === 'http-relay') {
      expect(sent.url).toBe('https://relay.example/v1/messages')
      const envelope = (await sent.clone().json()) as { body: string }
      expect(envelope).toMatchObject({
        protocol: 1,
        type: 'request',
        mode: 'full_sync',
        upstream: {
          url: 'https://api.anthropic.com/v1/messages?beta=true',
          method: 'POST',
        },
      })
      expect(JSON.parse(envelope.body).max_tokens).toBe(0)
    } else {
      expect(sent.headers.get('content-encoding')).toBe('gzip')
      const body = JSON.parse(
        gunzipSync(Buffer.from(await sent.clone().arrayBuffer())).toString(),
      )
      expect(body.max_tokens).toBe(0)
      expect(JSON.stringify(body)).toContain('Large stable cache prefix.')
    }
  },
)

test('ttl-only policy keeps the live OC2 subagent opt-out', async () => {
  runnerPolicyForReview({ ttl: 'long' })
  const f = await fixture(true)
  await f.live()
  expect(await f.registry.list()).toEqual([])
  expect(f.timers.callbacks.size).toBe(0)
})

test('ttl-only policy keeps the restored OC2 subagent opt-out', async () => {
  runnerPolicyForReview({ ttl: 'long' })
  const f = await fixture(true)
  await f.store.updateSettings((settings) => ({
    ...settings,
    cacheKeep: { enabled: true, always: true, subagents: true },
  }))
  await f.live()
  const owner = (globalThis as any)[
    Symbol.for('cortexkit.anthropic-auth.opencode2.cachekeep.v2')
  ].get(f.paths.storageId)
  const captured = owner.manager.trackedRequest('ses_oc2_keep')
  expect(
    owner.manager.track({
      ...captured,
      sessionId: 'ses_oc2_keep',
      headers: new Headers(),
      bodyText: JSON.stringify({
        model: 'claude-sonnet-4-6',
        system: [
          {
            type: 'text',
            text: 'Live child prefix',
            cache_control: { type: 'ephemeral', ttl: '1h' },
          },
        ],
        messages: [{ role: 'user', content: 'Hello' }],
      }),
      storage: {
        version: 1,
        accounts: [],
        claudeCache: { enabled: true, mode: 'hybrid' },
        cacheKeep: { enabled: true, always: true, subagents: true },
      },
      cacheMode: 'hybrid',
      isSubagent: true,
      ttlMs: 3_600_000,
    }).tracked,
  ).toBe(true)
  await f.dispose()
  await f.store.updateSettings((settings) => ({
    ...settings,
    cacheKeep: { enabled: true, always: true, subagents: false },
  }))
  forgetCacheKeepProcess(f.paths.storageId)
  const next = await f.start()
  f.due()
  await f.timers.fire()
  expect(next.sent).toHaveLength(0)
  expect(await readdir(f.disk)).toEqual([])
})

test('OC2 priced auto charges every physical warm and stops at the equality boundary', async () => {
  const f = await fixture()
  runnerPolicyForReview({ ttl: 'long', keep_warm: 'auto' })
  const draft = await f.prepare(undefined, { model: 'claude-opus-5-5' })
  await f.respond(
    draft,
    Response.json({ usage: { cache_read_input_tokens: 1_000 } }),
  )
  const key = Symbol.for('cortexkit.anthropic-auth.opencode2.cachekeep.v2')
  const initial = (globalThis as any)[key].get(f.paths.storageId)
  const retained = initial.manager.targets.get(
    'ses_oc2_keep',
  ) as CacheKeepTarget
  expect(retained.policyState).toBeDefined()
  Object.assign(retained.policyState!, {
    warmCostSoFar: 7_400,
    warmsSinceLastRealRequest: 37,
    hasWarmed: true,
    lastWarmAt: f.now(),
  })
  expect(await initial.persistence.reserveWarm(retained)).toBe(true)
  await f.dispose()
  forgetCacheKeepProcess(f.paths.storageId)
  const next = await f.start()
  const owner = (globalThis as any)[key].get(f.paths.storageId)
  let state: CacheKeepTarget['policyState']
  expect(
    JSON.parse(owner.manager.trackedRequest('ses_oc2_keep').bodyText).model,
  ).toBe('claude-opus-5-5')
  const persist = owner.persistence.reserveWarm.bind(owner.persistence)
  const reservation = spyOn(
    owner.persistence,
    'reserveWarm',
  ).mockImplementation(async (target: Readonly<CacheKeepTarget>) => {
    state ??= target.policyState
    return persist(target)
  })
  cleanups.push(() => reservation.mockRestore())
  // For this 1,000-token Opus 5.5 prefix, rewriting the one-hour cache costs
  // 8,000 micro-USD; each read costs 200. The 40th warm reaches equality.
  // Restore the first 37 reads durably, then charge two successful warms
  // through OC2 request preparation, dispatch, and Core cost settlement.
  expect(
    owner.manager.targets.get('ses_oc2_keep')?.policyState?.warmCostSoFar,
  ).toBe(7_400)
  for (const [warm, expectedCost] of [
    [1, 7_600],
    [2, 7_800],
  ] as const) {
    f.advance(3_570_000)
    await f.timers.fireTimeouts()
    await owner.manager.tick()
    expect(next.sent).toHaveLength(warm)
    expect(state).toBeDefined()
    expect(state!.warmCostSoFar).toBe(expectedCost)
    expect(state!.pendingWarmCost).toBeUndefined()
    expect(state!.prefixTokens).toBe(1_000)
  }
  f.advance(3_570_000)
  await f.timers.fireTimeouts()
  await f.timers.fire()
  expect(next.sent).toHaveLength(2)
  expect(owner.manager.trackedSessions()).toEqual([])
})

test.each(['replaced', 'retired'] as const)(
  'an old OC2 503 settlement cannot overwrite a %s target on restart',
  async (change) => {
    const f = await fixture()
    runnerPolicyForReview({ ttl: 'long', keep_warm: 'always' })
    await f.live()
    let entered!: () => void
    let finish!: (response: Response) => void
    const enteredSend = new Promise<void>((resolve) => {
      entered = resolve
    })
    const held = new Promise<Response>((resolve) => {
      finish = resolve
    })
    f.setSend(async () => {
      entered()
      return held
    })
    f.advance(3_570_000)
    const warming = f.timers.fireTimeouts()
    await enteredSend
    const key = Symbol.for('cortexkit.anthropic-auth.opencode2.cachekeep.v2')
    const owner = (globalThis as any)[key].get(f.paths.storageId)
    let latest: string | undefined
    if (change === 'replaced') {
      await f.live(undefined, {
        messages: [{ role: 'user', content: 'The newest accepted prefix' }],
      })
      latest = owner.manager.trackedRequest('ses_oc2_keep').bodyText
    } else owner.manager.untrack('ses_oc2_keep', 'session-forgotten')
    finish(Response.json({ error: { type: 'api_error' } }, { status: 503 }))
    await warming
    await f.dispose()
    forgetCacheKeepProcess(f.paths.storageId)
    const next = await f.start()
    const restored = (globalThis as any)[key]
      .get(f.paths.storageId)
      .manager.trackedRequest('ses_oc2_keep')
    if (change === 'replaced') expect(restored?.bodyText).toBe(latest)
    else expect(restored).toBeUndefined()
    f.advance(3_570_000)
    await f.timers.fireTimeouts()
    if (change === 'replaced') {
      expect(next.sent).toHaveLength(1)
      expect(await next.sent[0]!.clone().text()).toContain(
        'The newest accepted prefix',
      )
    } else expect(next.sent).toEqual([])
  },
)

test('OC2 dispatch and accepted capture do not await tracking readView or an unknown parent', async () => {
  let release!: () => void
  let admitted!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const admittedRequest = new Promise<void>((resolve) => {
    admitted = resolve
  })
  let armed = false
  let tracking = false
  let trackingReads = 0
  let lookups = 0
  const create = sourceFactory.createNativeAnthropicSource
  const source = spyOn(
    sourceFactory,
    'createNativeAnthropicSource',
  ).mockImplementation((options) => {
    const read = options.runtime.read.bind(options.runtime)
    const reading = spyOn(options.runtime, 'read').mockImplementation(
      async () => {
        if (tracking) {
          trackingReads++
          await held
        }
        return read()
      },
    )
    cleanups.push(() => reading.mockRestore())
    const native = create(options)
    return {
      ...native,
      admitRequest: async (
        ...args: Parameters<NonNullable<typeof native.admitRequest>>
      ) => {
        await native.admitRequest?.(...args)
        if (armed) admitted()
      },
      onRequestPrepared: async (
        ...args: Parameters<NonNullable<typeof native.onRequestPrepared>>
      ) => {
        tracking = armed
        try {
          await native.onRequestPrepared?.(...args)
        } finally {
          tracking = false
        }
      },
    }
  })
  cleanups.push(() => source.mockRestore())
  const f = await fixture(
    false,
    false,
    undefined,
    false,
    false,
    undefined,
    undefined,
    async () => {
      lookups++
      await held
      return { parentID: undefined }
    },
  )
  armed = true
  const preparing = f.prepare()
  let cancelTimeout = () => {}
  try {
    await Promise.race([
      admittedRequest,
      preparing.then(() => {
        throw new Error('admission observer did not run before dispatch')
      }),
    ])
    const draft = await Promise.race([
      preparing,
      new Promise<undefined>((resolve) => {
        const timer = setTimeout(resolve, 1000)
        cancelTimeout = () => clearTimeout(timer)
      }),
    ])
    expect(draft).toBeDefined()
    expect(trackingReads).toBe(0)
    expect(lookups).toBe(1)
    await f.respond(draft!)
    const owner = (globalThis as any)[
      Symbol.for('cortexkit.anthropic-auth.opencode2.cachekeep.v2')
    ].get(f.paths.storageId)
    expect(owner.manager.trackedRequest('ses_oc2_keep')?.bodyText).toContain(
      'Hello',
    )
  } finally {
    cancelTimeout()
    release()
    await preparing
  }
  f.due()
  await f.timers.fireTimeouts()
  const owner = (globalThis as any)[
    Symbol.for('cortexkit.anthropic-auth.opencode2.cachekeep.v2')
  ].get(f.paths.storageId)
  await owner.manager.tick()
  expect(f.sent).toHaveLength(1)
})

test('an unknown-parent OC2 child is captured then retired as soon as lookup resolves', async () => {
  const settled = firstLeaseParentSettlement()
  let resolve!: (session: { parentID?: string }) => void
  const held = new Promise<{ parentID?: string }>((done) => {
    resolve = done
  })
  let lookups = 0
  const f = await fixture(
    false,
    false,
    undefined,
    false,
    false,
    undefined,
    undefined,
    () => {
      lookups++
      return held
    },
  )
  await f.live()
  const owner = (globalThis as any)[
    Symbol.for('cortexkit.anthropic-auth.opencode2.cachekeep.v2')
  ].get(f.paths.storageId)
  expect(owner.manager.trackedRequest('ses_oc2_keep')?.bodyText).toContain(
    'Hello',
  )
  expect(lookups).toBe(1)
  resolve({ parentID: 'ses_parent' })
  await held
  // Join the detached retirement decision, including its current settings read.
  await settled
  expect(owner.manager.trackedRequest('ses_oc2_keep')).toBeUndefined()
  await owner.persistence.drain()
  f.due()
  await f.timers.fireTimeouts()
  expect(f.sent).toEqual([])
})

test.each(['pending', 'failed'] as const)(
  'a %s OC2 parent lookup cannot dispatch a warm, and a resolved main later can',
  async (status) => {
    let resolve!: (session: { parentID?: string }) => void
    const held = new Promise<{ parentID?: string }>((done) => {
      resolve = done
    })
    let healthy = false
    const f = await fixture(
      false,
      false,
      undefined,
      false,
      false,
      undefined,
      undefined,
      async () => {
        if (healthy) return { parentID: undefined }
        if (status === 'failed')
          throw new Error('synthetic host lookup unavailable')
        return held
      },
    )
    await f.live()
    const owner = (globalThis as any)[
      Symbol.for('cortexkit.anthropic-auth.opencode2.cachekeep.v2')
    ].get(f.paths.storageId)
    f.due()
    await f.timers.fireTimeouts()
    await owner.manager.tick()
    expect(f.sent).toEqual([])
    healthy = true
    resolve({ parentID: undefined })
    await held
    await new Promise((done) => setTimeout(done, 0))
    f.advance(60_000)
    await f.timers.fireTimeouts()
    await owner.manager.tick()
    if (status === 'failed') {
      f.advance(60_000)
      await f.timers.fireTimeouts()
      await owner.manager.tick()
    }
    expect(f.sent).toHaveLength(1)
  },
)

test.each([false, true])(
  'old lease parent resolution uses current settings and cannot retire a newer capture (replacement=%s)',
  async (replacement) => {
    let resolve!: (session: { parentID?: string }) => void
    const held = new Promise<{ parentID?: string }>((done) => {
      resolve = done
    })
    const settled = firstLeaseParentSettlement()
    let lookups = 0
    const f = await fixture(
      false,
      false,
      undefined,
      false,
      false,
      undefined,
      undefined,
      async () => (++lookups === 1 ? held : { parentID: 'ses_parent' }),
    )
    await f.store.updateSettings((settings) => ({
      ...settings,
      cacheKeep: { enabled: true, always: true, subagents: false },
    }))
    await f.live()
    const key = Symbol.for('cortexkit.anthropic-auth.opencode2.cachekeep.v2')
    const owner = (globalThis as any)[key].get(f.paths.storageId)
    const first = owner.manager.targets.get('ses_oc2_keep')
    expect(first).toBeDefined()
    await f.store.updateSettings((settings) => ({
      ...settings,
      cacheKeep: { enabled: true, always: true, subagents: true },
    }))
    const next = await f.start()
    if (replacement)
      await next.live(undefined, {
        messages: [{ role: 'user', content: 'New allowed child prefix' }],
      })
    const current = owner.manager.targets.get('ses_oc2_keep')
    if (replacement) expect(current.policyState).not.toBe(first.policyState)
    resolve({ parentID: 'ses_parent' })
    await settled
    expect(owner.manager.targets.get('ses_oc2_keep')).toBe(current)
    f.due()
    await f.timers.fire()
    expect(next.sent).toHaveLength(1)
    expect(f.sent).toEqual([])
    if (replacement)
      expect(await next.sent[0]!.clone().text()).toContain(
        'New allowed child prefix',
      )
  },
)

test.each(['cachekeep', 'prime'])(
  'the %s agent does not look up a synthetic session parent',
  async (agent) => {
    const lookups: string[] = []
    const f = await fixture(
      false,
      false,
      undefined,
      false,
      false,
      undefined,
      undefined,
      async () => {
        lookups.push(agent)
        return { parentID: undefined }
      },
    )
    await f.live(undefined, {}, `${agent}:synthetic-session`, undefined, agent)
    expect(lookups).toEqual([])
  },
)

test('explicit runner keep_warm sends before an advisory parent lookup resolves', async () => {
  let resolve!: (session: { parentID?: string }) => void
  const held = new Promise<{ parentID?: string }>((done) => {
    resolve = done
  })
  const f = await fixture(
    false,
    false,
    undefined,
    false,
    false,
    undefined,
    undefined,
    () => held,
  )
  runnerPolicyForReview({ ttl: 'short', keep_warm: 'always' })
  try {
    await f.live()
    f.advance(270_000)
    await f.timers.fireTimeouts()
    expect(f.sent).toHaveLength(1)
  } finally {
    resolve({ parentID: 'ses_parent' })
  }
})

test('OC2 priced auto settles a same-generation known failure and charges the next success once', async () => {
  const f = await fixture()
  runnerPolicyForReview({ ttl: 'long', keep_warm: 'auto' })
  const draft = await f.prepare(undefined, { model: 'claude-opus-5-5' })
  await f.respond(
    draft,
    Response.json({ usage: { cache_read_input_tokens: 1_000 } }),
  )
  const owner = (globalThis as any)[
    Symbol.for('cortexkit.anthropic-auth.opencode2.cachekeep.v2')
  ].get(f.paths.storageId)
  const target = owner.manager.targets.get('ses_oc2_keep') as CacheKeepTarget
  const state = target.policyState!
  let entered!: () => void
  const sending = new Promise<void>((done) => {
    entered = done
  })
  let finish!: (response: Response) => void
  const held = new Promise<Response>((done) => {
    finish = done
  })
  f.setSend(async () => {
    entered()
    return held
  })
  f.advance(3_570_000)
  const warming = f.timers.fireTimeouts()
  await sending
  const [name] = await readdir(f.disk)
  const saved = async () =>
    JSON.parse(gunzipSync(await readFile(join(f.disk, name!))).toString())
      .policyState
  expect(state).toMatchObject({
    warmCostSoFar: 0,
    pendingWarmCost: 200,
    warmsSinceLastRealRequest: 1,
  })
  expect(await saved()).toMatchObject({
    warmCostSoFar: 0,
    pendingWarmCost: 200,
  })
  finish(Response.json({}, { status: 503 }))
  await warming
  expect(owner.manager.targets.get('ses_oc2_keep')?.policyState).toBe(state)
  expect(state.warmCostSoFar).toBe(0)
  expect(state.pendingWarmCost).toBeUndefined()
  expect((await saved()).warmCostSoFar).toBe(0)
  expect((await saved()).pendingWarmCost).toBeUndefined()
  f.setSend(async () =>
    Response.json({ usage: { cache_read_input_tokens: 1_000 } }),
  )
  f.advance(20_000)
  await f.timers.fireTimeouts()
  await owner.persistence.drain()
  expect(f.sent).toHaveLength(2)
  expect(owner.manager.targets.get('ses_oc2_keep')?.policyState).toBe(state)
  expect(state).toMatchObject({
    warmCostSoFar: 200,
    warmsSinceLastRealRequest: 2,
  })
  expect(state.pendingWarmCost).toBeUndefined()
  expect(await saved()).toMatchObject({
    warmCostSoFar: 200,
    warmsSinceLastRealRequest: 2,
  })
  expect((await saved()).pendingWarmCost).toBeUndefined()
})
