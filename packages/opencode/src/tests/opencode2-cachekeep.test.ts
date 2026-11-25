import { afterEach, expect, spyOn, test } from 'bun:test'
import { createHash } from 'node:crypto'
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  utimes,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { gunzipSync, gzipSync } from 'node:zlib'
import {
  __setLogTestSink,
  ANTHROPIC_OAUTH_ORIGIN_REFUSAL,
  CACHE_KEEP_MAX_BODY_BYTES,
  CACHE_KEEP_MAX_TARGETS,
  CACHE_KEEP_PREWARM_LEAD_MS,
  CACHE_KEEP_TTL_MS,
  CacheKeepClaim,
  CacheKeepManager,
  CacheKeepSessionRegistry,
  type CacheKeepTarget,
  createNativeAccountRuntime,
  createNativePoolStore,
  decideStickyQuotaFailure,
  formatLogLine,
  getLogLevel,
  hasValidRequestBodySignature,
  logger,
  NativeCustodyError,
  type NativeLockEvent,
  RequestGzipLatch,
  resolveNativePoolPaths,
  runNativeMigration,
  StickyQuotaRetryCounter,
  StickySessionRouter,
  sessionCacheActivity,
  setLogLevel,
  signRequestBody,
} from '@cortexkit/anthropic-auth-core'
import {
  type Attempt,
  placeholderSecret,
} from '@cortexkit/common-auth/opencode2'
import type { Plugin } from '@opencode/plugin'
import type { SessionHooks } from '@opencode/plugin/promise/session'
import {
  fromNativeQuotaMap,
  nativeQuotaCodec,
  toNativeQuotaMap,
} from '../../../core/src/native-quota-codec'
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
  CacheKeepStore,
  cacheKeepStoreDirectory,
  legacyCacheKeepStoreDirectory,
  type SavedCacheKeepTarget,
} from '../v2/cachekeep-store'
import { createNativeMenuCapabilities } from '../v2/menu'
import { setupAnthropicAuth } from '../v2/setup'
import type { NativeSource } from '../v2/source'
import * as sourceFactory from '../v2/source'

const cleanups: Array<() => void | Promise<void>> = []
let reportFailure: (() => void) | undefined
// Test-only OAuth loopback origin, read by oauth-destination.ts from this
// global symbol (never from the environment).
const loopbackHook = globalThis as Record<symbol, unknown>
const LOOPBACK_KEY = Symbol.for(
  'cortexkit.anthropic-auth.test-oauth-loopback-origin',
)
afterEach(async () => {
  delete loopbackHook[LOOPBACK_KEY]
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
      const removal = spyOn(store, 'removed').mockImplementation((...args) => {
        const [target] = args
        const id = typeof target === 'string' ? target : target.id
        record(`${label} restart delete enqueued: ${id}`)
        removed(...args)
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
  readonly intervals = new Map<object, { at: number; every: number }>()
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
    ms: number,
  ) => {
    const id = { unref() {} }
    this.callbacks.set(id, callback)
    this.intervals.set(id, { at: this.now() + ms, every: ms })
    return id
  }) as unknown as typeof globalThis.setInterval
  readonly clearInterval: typeof globalThis.clearInterval = ((id: object) => {
    this.callbacks.delete(id)
    this.intervals.delete(id)
  }) as unknown as typeof globalThis.clearInterval
  async advanceTo(end: number, advance: (ms: number) => void) {
    for (;;) {
      const next = [
        ...[...this.timeouts].map(([id, timer]) => ({ id, ...timer })),
        ...[...this.intervals].map(([id, timer]) => ({
          id,
          ...timer,
          callback: this.callbacks.get(id)!,
        })),
      ]
        .filter((timer) => timer.at <= Math.max(end, this.now()))
        .sort((a, b) => a.at - b.at)[0]
      if (!next) break
      advance(Math.max(0, next.at - this.now()))
      const interval = this.intervals.get(next.id)
      if (interval) interval.at += interval.every
      else this.timeouts.delete(next.id)
      await next.callback()
      await this.afterTick()
    }
    advance(Math.max(0, end - this.now()))
  }
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
  cacheKeepOptions: cacheKeepFactory.NativeCacheKeepOptions = {},
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

      await keeperFor(paths.storageId)?.registry.list()
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
  const start = async (
    enrollmentFile = 'enrollment.json',
    waitForRestore = true,
    deletedSession?: string,
  ) => {
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
      provider: { transform: async () => registration },
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
      event: {
        subscribe: async function* () {
          if (deletedSession)
            yield {
              type: 'session.deleted',
              data: { sessionID: deletedSession },
            }
        },
      },
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
        ...cacheKeepOptions,
      },
    })
    cleanups.push(dispose)
    if (waitForRestore) {
      await keeperFor(paths.storageId)?.loading
    }
    const prepare = async (
      url = 'https://api.anthropic.com/v1/messages',
      extra: Record<string, unknown> = {},
      sessionID = 'ses_oc2_keep',
      signal?: AbortSignal,
      agent = 'build',
      credential = placeholderSecret('anthropic'),
    ) => {
      const draft = {
        sessionID: sessionID as SessionHooks['http.request']['sessionID'],
        agent,
        model: {
          providerID: 'anthropic',
          id:
            typeof extra.model === 'string' ? extra.model : 'claude-sonnet-4-6',
        },
        kind: 'primary',
        request: new Request(url, {
          method: 'POST',
          signal,
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${credential}`,
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

      await keeperFor(paths.storageId)?.registry.list()
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
  const original = await start()
  const reload = async (waitForRestore = true, previous = original) => {
    // OpenCode closes the folder's activation before running its replacement.
    await previous.dispose()
    // Other folders can still be using the previous module.
    const path = '../v2/cachekeep.ts?reload'
    const fresh: typeof cacheKeepFactory = await import(path)
    const creating = spyOn(
      cacheKeepFactory,
      'createNativeCacheKeep',
    ).mockImplementation(fresh.createNativeCacheKeep)
    try {
      return await start(undefined, waitForRestore)
    } finally {
      creating.mockRestore()
    }
  }
  return {
    ...original,
    setQuota: (id: string, remainingPercent = 80) => {
      const window = {
        remainingPercent,
        usedPercent: 100 - remainingPercent,
        checkedAt: now,
      }
      return store.recordQuota(
        id,
        {
          credentialEpoch: 1,
          identity:
            id === 'first' ? identity : '99999999-2222-4333-8444-555555555555',
        },
        toNativeQuotaMap({
          five_hour: window,
          seven_day: window,
          accountIdentity:
            id === 'first' ? identity : '99999999-2222-4333-8444-555555555555',
        }),
      )
    },
    /** Another plugin instance for the same account storage and clock. */
    start,
    reload,
    paths,
    store,
    routingPath: join(directory, 'routing.json'),
    registry,
    root: directory,
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

test.each([false, true])(
  'OC2 routing-moved stops an old-account warm (restored=%s)',
  async (restored) => {
    const lines = captureStartupLogs()
    const f = await fixture()
    await f.setQuota('first')
    await f.setQuota('second')
    await f.store.close()
    await f.store.updateSettings((settings) => ({
      ...settings,
      routing: { mode: 'fallback-first' },
    }))
    expect((await f.live()).headers.get('authorization')).toBe(
      'Bearer sk-ant-oat01-second',
    )
    if (restored) {
      await f.dispose()
      forgetCacheKeepProcess(f.paths.storageId)
    }
    await f.store.updateSettings((settings) => ({
      ...settings,
      routing: { mode: 'main-first' },
    }))
    const active = restored ? await f.start() : f
    expect((await f.registry.list())[0]?.warmStopped).toBeUndefined()
    f.due()
    await f.timers.fire()
    expect(active.sent).toHaveLength(0)
    const stopped = lines.filter((line) =>
      line.includes('stopped warming session'),
    )
    expect(stopped).toHaveLength(1)
    expect(stopped[0]).toContain('WARN')
    expect(stopped[0]).toContain('"reason":"routing-moved"')
    expect((await f.registry.list())[0]?.warmStopped?.reason).toBe(
      'routing-moved',
    )
  },
)

test.each(['unchanged', 'sticky-pin', 'unknown-reading'] as const)(
  'OC2 routing peek keeps warming on A: %s',
  async (control) => {
    const f = await fixture()
    await f.setQuota('second')
    if (control !== 'unknown-reading') await f.setQuota('first')
    await f.store.close()
    await f.store.updateSettings((settings) => ({
      ...settings,
      routing: {
        mode: control === 'sticky-pin' ? 'sticky-balanced' : 'fallback-first',
      },
    }))
    if (control === 'sticky-pin') await f.store.disable('first', 'user')
    expect((await f.live()).headers.get('authorization')).toBe(
      'Bearer sk-ant-oat01-second',
    )
    if (control === 'sticky-pin') await f.store.enable('first')
    if (control === 'unknown-reading')
      await f.store.updateSettings((settings) => ({
        ...settings,
        routing: { mode: 'main-first' },
      }))
    const resolve = spyOn(StickySessionRouter.prototype, 'resolve')
    const retain = spyOn(StickyQuotaRetryCounter.prototype, 'retain')
    try {
      f.due()
      await f.timers.fire()
      expect(f.sent).toHaveLength(1)
      expect(f.sent[0]!.headers.get('authorization')).toBe(
        'Bearer sk-ant-oat01-second',
      )
      expect((await f.registry.list())[0]?.warmStopped).toBeUndefined()
      expect(resolve).not.toHaveBeenCalled()
      expect(retain).not.toHaveBeenCalled()
    } finally {
      resolve.mockRestore()
      retain.mockRestore()
    }
  },
)

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

test('OpenCode 2 rejected oversized request ends its old target without evicting other warm sessions', async () => {
  const lines = captureStartupLogs()
  const f = await fixture()
  await f.live(undefined, { system: 'a'.repeat(1024 * 1024) })
  for (let i = 0; i < 10; i++)
    await f.live(
      undefined,
      { system: 'b'.repeat(3 * 1024 * 1024) },
      `ses_healthy_${i}`,
    )

  const manager = keeperFor(f.paths.storageId).manager
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
  expect(before).toBeDefined()
  expect(manager.trackedRequest('ses_oc2_keep')).toBeUndefined()
  expect(
    manager
      .trackedSessions()
      .map(({ id }: { id: string }) => id)
      .sort(),
  ).toEqual(
    sessions
      .filter(({ id }) => id !== 'ses_oc2_keep')
      .map(({ id }) => id)
      .sort(),
  )
  expect(
    lines.filter((line) => line.includes('stopped warming session')),
  ).toEqual([])
})

test('OpenCode 2 accepts the oversized body at 2xx headers before streaming starts', async () => {
  const f = await fixture()
  await f.live()

  const manager = keeperFor(f.paths.storageId).manager
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

test('OpenCode 2 aborted attempt ends its old target even if late 2xx headers arrive', async () => {
  const f = await fixture()
  await f.live()

  const manager = keeperFor(f.paths.storageId).manager
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
  expect(before).toBeDefined()
  expect(manager.trackedRequest('ses_oc2_keep')).toBeUndefined()
})

test('an OC2 API-key real turn ends a live warmed prefix through the request boundary', async () => {
  const f = await fixture()
  await f.live()
  f.due()
  await f.timers.fire()
  expect(f.sent).toHaveLength(1)

  const owner = keeperFor(f.paths.storageId)
  await f.live(undefined, {}, undefined, undefined, 'build', 'real-api-key')
  expect(owner.manager.trackedCount()).toBe(0)
  await owner.persistence.drain()
  expect(await readdir(f.disk)).toEqual([])
  expect(owner.manager.warming('ses_oc2_keep')).toEqual({
    on: false,
    stopReason: 'session-ended',
  })
})

test('OC2 skips a due warm while the real request is still choosing its account', async () => {
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let blocked = false
  const create = sourceFactory.createNativeAnthropicSource
  const creating = spyOn(
    sourceFactory,
    'createNativeAnthropicSource',
  ).mockImplementation((options) => {
    const source = create(options)
    const choose = source.chooseAccount.bind(source)
    return {
      ...source,
      chooseAccount: async (input) => {
        if (blocked && input.agent !== 'cachekeep' && input.agent !== 'prime') {
          entered.resolve()
          await release.promise
        }
        return choose(input)
      },
    }
  })
  cleanups.push(() => creating.mockRestore())
  const f = await fixture()
  await f.live()
  f.due()
  blocked = true
  const abort = new AbortController()
  const preparing = f
    .prepare(
      undefined,
      { system: 'new in-flight turn' },
      undefined,
      abort.signal,
    )
    .catch((error) => error)
  await entered.promise
  try {
    await f.timers.fire()
    expect(f.sent).toHaveLength(0)
  } finally {
    abort.abort()
    release.resolve()
    await preparing
  }

  expect(keeperFor(f.paths.storageId).manager.trackedCount()).toBe(0)
})

test('an older OC2 abort cannot unblock or replace a newer in-flight real turn', async () => {
  const f = await fixture()
  await f.live()
  const abort = new AbortController()
  const older = await f.prepare(
    undefined,
    { system: 'older turn' },
    undefined,
    abort.signal,
  )
  const newer = await f.prepare(undefined, { system: 'newer accepted turn' })
  abort.abort()
  f.due()
  await f.timers.fire()
  expect(f.sent).toHaveLength(0)
  await f.respond(newer)
  await f.respond(older)

  const manager = keeperFor(f.paths.storageId).manager
  expect(manager.trackedRequest('ses_oc2_keep')?.bodyText).toContain(
    'newer accepted turn',
  )
  f.due()
  await f.timers.fire()
  expect(f.sent).toHaveLength(1)
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

test('an OpenCode 2 prewarm preserves thinking block binding and carries its beta', async () => {
  const f = await fixture()
  await f.store.updateSettings((settings) => ({
    ...settings,
    thinkingBinding: { prefixMismatchBehavior: 'drop_block' },
  }))
  const live = await f.live(undefined, {
    model: 'claude-fable-5-2',
    thinking: { type: 'adaptive', display: 'summarized' },
    messages: [
      { role: 'user', content: 'first' },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'reasoning', signature: 'signature' },
          { type: 'text', text: 'answer' },
        ],
      },
      { role: 'user', content: 'continue' },
    ],
  })
  const trackedBody = (await live.json()) as Record<string, any>
  expect(trackedBody.thinking.block_binding).toEqual({
    prefix_mismatch_behavior: 'drop_block',
  })
  f.due()
  await f.timers.fire()
  expect(f.sent).toHaveLength(1)
  const warm = f.sent[0]!
  const body = (await warm.json()) as Record<string, any>
  expect(body.max_tokens).toBe(0)
  expect(body.thinking).toEqual(trackedBody.thinking)
  expect(body.messages).toEqual(trackedBody.messages)
  expect(warm.headers.get('x-claude-code-request-class')).toBe('auxiliary')
  expect(warm.headers.get('anthropic-beta')?.split(',')).toContain(
    'thinking-binding-controls-2026-08-01',
  )
})

test('a due OpenCode 2 prewarm sends once with the original account and no billing lineage', async () => {
  const reports: unknown[] = []
  const reportSessions: string[] = []
  runnerPolicyForReview(undefined, reports, reportSessions)
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
  await Bun.sleep(10)
  const billingIndex = reports.findIndex((value) => {
    const report = value as { kind?: string; request_kind?: string }
    return report.kind === 'billing' && report.request_kind === 'keep_warm'
  })
  expect(billingIndex).toBeGreaterThanOrEqual(0)
  expect(reportSessions[billingIndex]).toBe('ses_oc2_keep')
  expect(reports[billingIndex]).toMatchObject({
    account_id: '11111111-2222-4333-8444-555555555555',
    model: body.model,
    outcome: 'completed',
    usage: { cache_read: 1 },
    cache: { ttl_ms: 3_600_000, warming: { on: true } },
  })
})

test.each([200, 429])(
  'OpenCode 2 keep-warm harvests quota without routing reports at status %i',
  async (status) => {
    const reports: unknown[] = []
    runnerPolicyForReview(undefined, reports)
    const f = await fixture()
    await f.live()
    await Bun.sleep(10)
    reports.length = 0
    f.setSend(async () =>
      Response.json(
        status === 200
          ? { usage: { cache_read_input_tokens: 1 } }
          : {
              type: 'error',
              error: { type: 'rate_limit_error', message: 'limited' },
            },
        {
          status,
          headers: {
            'anthropic-ratelimit-unified-5h-utilization':
              status === 200 ? '0.25' : '1',
          },
        },
      ),
    )
    f.due()
    await f.timers.fire()
    expect(f.sent).toHaveLength(1)
    await f.dispose()
    expect(
      reports.filter(
        (value) => (value as { kind?: string }).kind === undefined,
      ),
    ).toEqual([])
    const stored = await f.store.read()
    if (stored.status !== 'ready')
      throw new Error('Missing native account store')
    const quota = fromNativeQuotaMap(
      stored.rows.find((row) => row.id === 'first')?.quota,
    )
    expect(quota?.five_hour?.remainingPercent).toBe(status === 200 ? 75 : 0)
  },
)

test('OpenCode 2 refuses a reserved warm before dispatch without billing it', async () => {
  const reports: unknown[] = []
  runnerPolicyForReview(undefined, reports)
  const f = await fixture()
  await (await f.live()).text()
  await Bun.sleep(10)
  reports.length = 0
  const reserve = spyOn(
    CacheKeepManager.prototype,
    'reserveWarmDispatch',
  ).mockRejectedValue(new Error('reservation refused'))
  cleanups.push(() => reserve.mockRestore())
  f.due()
  await f.timers.fire()
  await Bun.sleep(10)
  expect(reserve).toHaveBeenCalledTimes(1)
  expect(f.sent).toHaveLength(0)
  expect(
    reports.filter((value) => (value as { kind?: string }).kind === 'billing'),
  ).toEqual([])
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

test('OC2 last-lease disposal aborts and joins a due-timer restored delay before closing its runtime', async () => {
  const entered = Promise.withResolvers<void>()
  let signal: AbortSignal | undefined
  let release: (() => void) | undefined
  const f = await fixture(
    false,
    false,
    undefined,
    false,
    false,
    undefined,
    undefined,
    undefined,
    {
      delayImpl: ((_ms, _value, options) =>
        new Promise<void>((resolve, reject) => {
          signal = options?.signal
          release = resolve
          signal?.addEventListener(
            'abort',
            () => reject(new DOMException('aborted', 'AbortError')),
            { once: true },
          )
          entered.resolve()
        })) as cacheKeepFactory.NativeCacheKeepOptions['delayImpl'],
    },
  )
  await f.live()
  await f.dispose()
  forgetCacheKeepProcess(f.paths.storageId)
  f.due()
  const active = await f.start()
  f.advance(1)
  const [id, due] = [...f.timers.timeouts].find(
    ([, timer]) => timer.at === f.now(),
  )!
  expect(due).toBeDefined()
  f.timers.timeouts.delete(id)
  const tick = Promise.resolve(due.callback())
  await entered.promise
  const stopping = active.dispose()
  try {
    await stopping
    expect(signal?.aborted).toBe(true)
    await tick
    expect(active.sent).toHaveLength(0)

    const owner = keeperFor(f.paths.storageId)
    expect(owner.manager.trackedCount()).toBe(0)
    expect(
      (await readdir(f.disk)).filter((name) => name.endsWith('.json.gz')),
    ).toHaveLength(1)
    await f.start()
    expect(owner.manager.trackedCount()).toBe(1)
  } finally {
    release?.()
    await stopping
    await tick
  }
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

test('OC2 hands off committed sessions but keeps an accepted body whose final write failed', async () => {
  const f = await fixture()

  const owner = keeperFor(f.paths.storageId) as {
    manager: CacheKeepManager
    persistence: CacheKeepStore
  }
  await f.live()
  await owner.persistence.drain()
  const [name] = await readdir(f.disk)
  expect(name).toEndWith('.json.gz')
  const record = join(f.disk, name!)
  const old = await readFile(record)
  await f.live(undefined, {
    messages: [{ role: 'user', content: 'Latest accepted body' }],
  })
  await f.live(undefined, {}, 'ses_committed')
  await rm(record)
  await mkdir(record)
  try {
    await f.dispose()
  } finally {
    await rm(record, { recursive: true })
    await writeFile(record, old, { mode: 0o600 })
  }
  expect(owner.manager.trackedSessions().map(({ id }) => id)).toEqual([
    'ses_oc2_keep',
  ])
  const contender = new CacheKeepStore({
    storageId: f.paths.storageId,
    root: f.root,
    sessionClaims: true,
  })
  const visible: string[] = []
  await contender.load(f.now(), (entry) => {
    visible.push(entry.id)
    return undefined
  })
  expect(visible).toEqual(['ses_committed'])
  await f.start()
  expect(owner.manager.trackedRequest('ses_oc2_keep')?.bodyText).toContain(
    'Latest accepted body',
  )
})

test.each(['delete', 'turn'])(
  'OC2 remembers a %s while adoption waits for the last claim release',
  async (action) => {
    const f = await fixture()
    await f.live()

    const owner = keeperFor(f.paths.storageId) as {
      manager: CacheKeepManager
      persistence: CacheKeepStore
    }
    const entered = Promise.withResolvers<void>()
    const resume = Promise.withResolvers<void>()
    const release = owner.persistence.releaseClaims.bind(owner.persistence)
    const releasing = spyOn(
      owner.persistence,
      'releaseClaims',
    ).mockImplementation(async (filter) => {
      entered.resolve()
      await resume.promise
      await release(filter)
    })
    const create = cacheKeepFactory.createNativeCacheKeep
    let next: ReturnType<typeof create> | undefined
    const creating = spyOn(
      cacheKeepFactory,
      'createNativeCacheKeep',
    ).mockImplementation((options) => (next = create(options)))
    const stopping = f.dispose()
    try {
      await entered.promise
      await f.start('enrollment.json', false)
      expect(next).toBeDefined()
      if (action === 'delete') {
        next!.forgetSession('ses_oc2_keep')
        next!.sessionDeleted('ses_oc2_keep')
      } else
        next!.beginRealTurn({
          sessionID: 'ses_oc2_keep',
          kind: 'primary',
          agent: 'build',
          providerID: 'anthropic',
          modelID: 'claude-sonnet-4-6',
        })
      resume.resolve()
      await stopping
      await next!.ready
      expect(owner.manager.trackedRequest('ses_oc2_keep')).toBeUndefined()
    } finally {
      resume.resolve()
      await stopping
      creating.mockRestore()
      releasing.mockRestore()
    }
  },
)

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

test('OC2 dispatches the first request without waiting for restart restoration', async () => {
  const f = await fixture()
  await f.live(undefined, {
    messages: [{ role: 'user', content: 'saved prefix' }],
  })
  await f.dispose()

  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const load = CacheKeepStore.prototype.load
  const scan = spyOn(CacheKeepStore.prototype, 'load').mockImplementation(
    async function (this: CacheKeepStore, ...args) {
      entered.resolve()
      await release.promise
      return load.apply(this, args)
    },
  )
  const firstRequest = (async () => {
    const next = await f.start(undefined, false)
    await next.live(undefined, {
      messages: [{ role: 'user', content: 'first live prefix' }],
    })
    return true
  })()

  const owner = keeperFor(f.paths.storageId)
  let deadline: ReturnType<typeof setTimeout> | undefined
  let finished = false
  try {
    await entered.promise
    finished = await Promise.race([
      firstRequest,
      new Promise<boolean>((resolve) => {
        deadline = setTimeout(() => resolve(false), 1500)
      }),
    ])
  } finally {
    clearTimeout(deadline)
    release.resolve()
    scan.mockRestore()
    await firstRequest
    await owner.loading
  }
  expect(finished).toBe(true)
  expect(owner.manager.trackedRequest('ses_oc2_keep')?.bodyText).toContain(
    'first live prefix',
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
  forgetCacheKeepProcess(f.paths.storageId)
  const next = await f.start()
  f.due()
  await f.timers.fire()
  expect(next.sent).toHaveLength(1)
  const wire = await next.sent[0]!.text()
  const warm = JSON.parse(wire) as Record<string, any>
  expect(await hasValidRequestBodySignature(wire)).toBe(true)
  expect(warm.tools).toEqual(live.tools)
  expect(warm.system.slice(1)).toEqual(live.system.slice(1))
  expect(warm.messages).toEqual(live.messages)
  expect(warm.max_tokens).toBe(0)
  expect(next.sent[0]!.headers.get('authorization')).toBe(
    'Bearer sk-ant-oat01-first',
  )
})

test('OpenCode 2 keeps the source prefix and the signed round template in separate warm targets', async () => {
  const f = await fixture()
  await f.setQuota('first')
  await f.store.updateSettings((settings) => ({
    ...settings,
    dump: { enabled: true },
  }))
  const dumpDir = join(f.root, 'round-dumps')
  const previousDumpDir = process.env.OPENCODE_ANTHROPIC_AUTH_DUMP_DIR
  process.env.OPENCODE_ANTHROPIC_AUTH_DUMP_DIR = dumpDir
  cleanups.push(async () => {
    if (previousDumpDir === undefined)
      delete process.env.OPENCODE_ANTHROPIC_AUTH_DUMP_DIR
    else process.env.OPENCODE_ANTHROPIC_AUTH_DUMP_DIR = previousDumpDir
  })
  const source = 'claude-fable-5-2'
  const target = 'claude-opus-5'
  const sessionID = 'ses_oc2_round_warm'
  const credit = 'credit-sentinel-oc2-warm'
  const usage = { input_tokens: 20, cache_read_input_tokens: 300 }
  const reply = (model: string, refused = false) => {
    const frames = [
      { type: 'message_start', message: { id: `msg_${model}`, model, usage } },
      ...(!refused
        ? [
            {
              type: 'content_block_start',
              index: 0,
              content_block: { type: 'text', text: 'answer' },
            },
            { type: 'content_block_stop', index: 0 },
          ]
        : []),
      {
        type: 'message_delta',
        usage: { output_tokens: 2 },
        delta: refused
          ? {
              stop_reason: 'refusal',
              stop_details: {
                type: 'refusal',
                category: 'bio',
                fallback_credit_token: credit,
              },
            }
          : { stop_reason: 'end_turn' },
      },
      { type: 'message_stop' },
    ]
    return new Response(
      frames
        .map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
        .join(''),
      { headers: { 'content-type': 'text/event-stream' } },
    )
  }
  const send = async (request: Request) => {
    const body = (await request.json()) as { model: string; max_tokens: number }
    return body.max_tokens === 0
      ? Response.json({
          id: 'msg_warm',
          model: body.model,
          usage,
          content: [],
          stop_reason: 'end_turn',
        })
      : reply(body.model)
  }
  f.setSend(send)
  // The native adapter's extra physical sends use the host fetch. Warm sends
  // use the fetch injected into the CacheKeep fixture above.
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const request = new Request(input as Request, init)
    if (new URL(request.url).pathname !== '/v1/messages')
      return originalFetch(input, init)
    f.sent.push(request.clone() as Request)
    return send(request as Request)
  }) as typeof fetch
  cleanups.push(async () => {
    globalThis.fetch = originalFetch
  })
  const prepare = (messages: Array<{ role: string; content: string }>) =>
    f.prepare(
      undefined,
      { model: source, max_tokens: 256, stream: true, messages },
      sessionID,
    )
  const first = [{ role: 'user', content: 'clean source prefix only' }]
  const append = (history: typeof first, content: string) => [
    ...history,
    { role: 'assistant', content: 'answer' },
    { role: 'user', content },
  ]
  const original = await prepare(first)
  await f.respond(original, reply(source))
  const refused = append(first, 'refused suffix')
  const refusedSend = await prepare(refused)
  const joined = await f.respond(refusedSend, reply(source, true), false)
  const answer = await joined.text()
  expect(answer).not.toContain(credit)
  expect(answer).toContain('answer')
  const round = await prepare(append(refused, 'new primary on round'))
  const roundBody = await round.request.clone().text()
  expect(JSON.parse(roundBody)).toMatchObject({
    model: target,
    thread: { type: 'create' },
  })
  expect(await hasValidRequestBodySignature(roundBody)).toBe(true)
  await f.respond(round, reply(target))

  const owner = keeperFor(f.paths.storageId)
  expect(owner.roundNotices.snapshot()).toContainEqual(
    expect.objectContaining({
      sessionId: sessionID,
      requestedModelId: source,
      targetModelId: target,
      category: 'bio',
      remaining: 8,
    }),
  )
  const sourceWarmID = `source-warm:${sessionID}:fable-5-2`
  expect(owner.manager.trackedRequest(sourceWarmID)?.bodyText).toContain(
    'clean source prefix only',
  )
  expect(owner.manager.trackedRequest(sourceWarmID)?.bodyText).not.toContain(
    'refused suffix',
  )
  f.due()
  await f.timers.fire()
  const warmByModel = new Map<string, { wire: string; headers: Headers }>()
  for (const request of f.sent) {
    const wire = await request.text()
    const body = JSON.parse(wire)
    if (body.max_tokens !== 0) continue
    expect(body).not.toHaveProperty('thread')
    expect(wire).not.toContain(credit)
    expect(await hasValidRequestBodySignature(wire)).toBe(true)
    warmByModel.set(body.model, { wire, headers: request.headers })
  }
  expect(warmByModel.get(source)?.wire).toContain('clean source prefix only')
  expect(warmByModel.get(source)?.wire).not.toContain('refused suffix')
  expect(warmByModel.get(target)?.wire).toContain('new primary on round')
  expect(warmByModel.get(target)?.headers.get('anthropic-beta')).toBe(
    round.request.headers.get('anthropic-beta'),
  )
  await owner.persistence.drain()
  const saved = await readdir(f.disk)
  expect(saved.filter((name) => name.endsWith('.json.gz'))).toHaveLength(1)
  // The host may end its attempt before rewriteResponse writes the dump.
  // Disposal joins that outstanding request-artifact write.
  await f.dispose()
  const dumpBodies = await Promise.all(
    (await readdir(dumpDir))
      .filter((name) => name.endsWith('.body.json'))
      .map((name) => readFile(join(dumpDir, name), 'utf8')),
  )
  expect(dumpBodies).toContain(roundBody)
  expect(dumpBodies.join('\n')).not.toContain(credit)
})

const CACHE_KEEP_SLOT = Symbol.for(
  'cortexkit.anthropic-auth.opencode2.cachekeep.v3',
)

function keeperCopies(storageId: string) {
  return (
    (
      (globalThis as any)[CACHE_KEEP_SLOT]?.get(storageId) as
        | Map<symbol, any>
        | undefined
    )?.values() ?? []
  )
}

function keeperFor(storageId: string) {
  return [...keeperCopies(storageId)].at(-1)
}

function forgetCacheKeepProcess(storageId: string) {
  ;(globalThis as any)[CACHE_KEEP_SLOT]?.delete(storageId)
}

test('OC2 legacy migration removes its source after adopting a target and cannot resurrect a forgotten session', async () => {
  const f = await fixture()
  await f.live()
  await f.dispose()
  const legacy = legacyCacheKeepStoreDirectory(
    f.paths.storageId,
    dirname(f.paths.legacyConfig),
  )
  await rename(f.disk, legacy)
  forgetCacheKeepProcess(f.paths.storageId)
  const next = await f.start()

  const owner = keeperFor(f.paths.storageId)
  expect(owner.manager.trackedCount()).toBe(1)
  expect(await readdir(legacy)).toEqual([])
  owner.manager.untrack('ses_oc2_keep')
  await owner.persistence.drain()
  await next.dispose()
  forgetCacheKeepProcess(f.paths.storageId)
  await f.start()
  expect(keeperFor(f.paths.storageId).manager.trackedCount()).toBe(0)
})

test.each([0, 2])(
  'OpenCode 2 restart keeps %s planned records while the policy reads null',
  async (count) => {
    const lines = captureStartupLogs()
    const routingKey = Symbol.for('cortexkit.routing')
    const globals = globalThis as Record<symbol, unknown>
    const original = globals[routingKey]
    let policy: { ttl: 'long'; keep_warm: 'auto' } | null = {
      ttl: 'long',
      keep_warm: 'auto',
    }
    globals[routingKey] = () => ({ cache: () => policy })
    cleanups.push(() => {
      if (original === undefined) delete globals[routingKey]
      else globals[routingKey] = original
    })
    const f = await fixture(true, false, 'debug')

    const before = keeperFor(f.paths.storageId)
    for (let i = 0; i < count; i++) {
      await f.live(undefined, { model: 'claude-opus-5-5' }, `ses_restore_${i}`)
    }
    expect(before.manager.trackedCount()).toBe(count)
    await f.dispose()
    await f.store.updateSettings((settings) => ({
      ...settings,
      cacheKeep: { enabled: false },
      claudeCache: { enabled: false, mode: 'hybrid' },
    }))
    const saved = await readdir(f.disk)
    expect(saved).toHaveLength(count)
    for (const name of saved) {
      const record = JSON.parse(
        gunzipSync(await readFile(join(f.disk, name))).toString(),
      )
      expect(record.policyState).toMatchObject({
        planned: true,
        policy: { ttl: 'long', keep_warm: 'auto' },
        prefixTokens: 1,
      })
    }
    forgetCacheKeepProcess(f.paths.storageId)
    policy = null
    const next = await f.start()
    const owner = keeperFor(f.paths.storageId)
    expect({
      restored: owner.manager.trackedCount(),
      logs: lines,
    }).toMatchObject({ restored: count })
    expect(
      (await readdir(f.disk)).filter((name) => name.endsWith('.json.gz')),
    ).toHaveLength(count)
    f.advance(3_300_000)
    await f.timers.fire()
    expect({ sends: next.sent.length, logs: lines }).toMatchObject({
      sends: count,
    })
    await owner.persistence.drain()
    expect(
      (await readdir(f.disk)).filter((name) => name.endsWith('.json.gz')),
    ).toHaveLength(count)
  },
)

test.each(['hybrid-inactive', 'subagents-disabled', 'not-oauth'] as const)(
  'a real turn skipped as %s ends the restored planned prefix',
  async (reason) => {
    const routingKey = Symbol.for('cortexkit.routing')
    const globals = globalThis as Record<symbol, unknown>
    const original = globals[routingKey]
    let policy: { ttl: 'long'; keep_warm: 'always' } | null = {
      ttl: 'long',
      keep_warm: 'always',
    }
    const reports: { kind: string; reason?: string }[] = []
    globals[routingKey] = () => ({
      cache: () => policy,
      report: (payload: (typeof reports)[number]) => reports.push(payload),
    })
    cleanups.push(() => {
      if (original === undefined) delete globals[routingKey]
      else globals[routingKey] = original
    })
    const f = await fixture(reason === 'subagents-disabled')
    await f.live()
    await f.dispose()
    await f.store.updateSettings((settings) => ({
      ...settings,
      cacheKeep: {
        enabled: reason !== 'hybrid-inactive',
        always: true,
        subagents: false,
      },
    }))
    forgetCacheKeepProcess(f.paths.storageId)
    policy = null
    const next = await f.start()

    const owner = keeperFor(f.paths.storageId)
    expect(owner.manager.trackedCount()).toBe(1)
    if (reason === 'not-oauth') {
      const runtime = createNativeAccountRuntime({
        paths: f.paths,
        host: 'opencode',
      })
      const keeper = createNativeCacheKeep({
        runtime,
        storageId: f.paths.storageId,
        persistence: { root: dirname(f.paths.legacyConfig) },
        source: {} as NativeSource,
      })
      cleanups.push(async () => {
        await keeper.dispose()
        runtime.close()
      })
      await keeper.ready
      await keeper.track({
        sessionID: 'ses_oc2_keep',
        route: 'api-key',
        kind: 'primary',
        agent: 'build',
        attemptId: 999,
      } as never)
    } else
      await next.live(undefined, {
        messages: [{ role: 'user', content: 'new real turn' }],
      })
    expect(owner.manager.trackedCount()).toBe(0)
    await owner.persistence.drain()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(reports.filter(({ kind }) => kind === 'cache_warm_stopped')).toEqual(
      [expect.objectContaining({ reason: 'session-ended' })],
    )
    f.advance(3_300_000)
    await f.timers.fire()
    expect(next.sent).toHaveLength(0)
    expect(await readdir(f.disk)).toEqual([])
  },
)

test('three restored sends reserve distinct start slots without waiting for responses', async () => {
  const scheduled = Promise.withResolvers<void>()
  const response = Promise.withResolvers<void>()
  const delays: { ms: number; release: () => void }[] = []
  const f = await fixture(
    false,
    false,
    undefined,
    false,
    false,
    undefined,
    undefined,
    undefined,
    {
      delayImpl: ((ms: number) => {
        const gate = Promise.withResolvers<void>()
        delays.push({ ms, release: () => gate.resolve() })
        if (delays.length === 3) scheduled.resolve()
        return gate.promise
      }) as cacheKeepFactory.NativeCacheKeepOptions['delayImpl'],
    },
  )
  for (let i = 0; i < 3; i++) await f.live(undefined, {}, `ses_spacing_${i}`)
  await f.dispose()
  forgetCacheKeepProcess(f.paths.storageId)
  const next = await f.start()
  const started = Array.from({ length: 3 }, () => Promise.withResolvers<void>())
  const starts: number[] = []
  next.setSend(async () => {
    starts.push(f.now())
    started[starts.length - 1]!.resolve()
    await response.promise
    return Response.json({})
  })
  f.due()
  const tick = f.timers.fire()
  const ready = await Promise.race([
    scheduled.promise.then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), 500)),
  ])
  if (!ready) {
    for (const entry of delays) entry.release()
    response.resolve()
    await tick
    expect(delays.map(({ ms }) => ms)).toEqual([0, 3000, 6000])
    return
  }
  const spacing = delays.map(({ ms }) => ms)
  delays[0]!.release()
  await started[0]!.promise
  f.advance(3000)
  delays[1]!.release()
  await started[1]!.promise
  f.advance(3000)
  delays[2]!.release()
  await started[2]!.promise
  response.resolve()
  await tick
  expect(spacing).toEqual([0, 3000, 6000])
  expect(starts[1]! - starts[0]!).toBe(3000)
  expect(starts[2]! - starts[1]!).toBe(3000)
})

test('OC2 deferred reservation wait returns skipped without retrying or removing its target', async () => {
  const f = await fixture()
  runnerPolicyForReview({ ttl: 'long', keep_warm: 'always' })
  await f.live()

  const owner = keeperFor(f.paths.storageId)
  const target = owner.manager.targets.get('ses_oc2_keep') as CacheKeepTarget
  const due = target.nextPrewarmAt
  const result = await owner.manager.prewarmNow({
    ...target,
    sessionId: target.id,
    headers: new Headers(),
  })
  expect(result).toEqual({ ok: false, skipped: true, reason: 'wait' })
  expect(owner.manager.trackedCount()).toBe(1)
  expect(target.nextPrewarmAt).toBe(due)
  expect(target.consecutiveFailures).toBe(0)
  expect(target.policyState?.warmsSinceLastRealRequest).toBe(0)
  expect(f.sent).toHaveLength(0)
})

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

test('OpenCode 2 saves a restored warm count without promoting its idle claim', async () => {
  const f = await fixture()
  const { id, peer, record, claim } = await seedPeer(f)
  await peer.releaseClaims(() => true)
  const before = JSON.parse(
    gunzipSync(await readFile(record)).toString(),
  ) as SavedCacheKeepTarget
  const next = await f.start()
  let atSend: SavedCacheKeepTarget | undefined
  next.setSend(async () => {
    atSend = JSON.parse(gunzipSync(await readFile(record)).toString())
    return Response.json({ usage: { cache_read_input_tokens: 1 } })
  })
  f.due()
  await f.timers.fire()
  expect(next.sent).toHaveLength(1)
  expect(atSend).toMatchObject({
    id,
    bodyText: before.bodyText,
    policyState: {
      lastRealRequestAt: before.policyState!.lastRealRequestAt,
      warmsSinceLastRealRequest: 1,
    },
  })
  expect(JSON.parse(await readFile(claim, 'utf8')).restoreOnly).toBe(true)
})

test('OpenCode 2 warm timing measures physical headers before its buffered response body', async () => {
  const lines = captureStartupLogs()
  const f = await fixture(false, false, 'debug')
  await f.live()
  f.setSend(async () => {
    f.advance(120)
    return new Response(
      new ReadableStream({
        start(controller) {
          setTimeout(() => {
            f.advance(80)
            controller.enqueue(new TextEncoder().encode('{}'))
            controller.close()
          }, 0)
        },
      }),
    )
  })
  f.due()
  await f.timers.fire()
  const timing = lines.filter((line) => line.includes('prewarm timing'))
  expect(timing).toHaveLength(1)
  expect(timing[0]).toContain('"headersMs":120')
  expect(timing[0]).toContain('"totalMs":200')
})

test('OpenCode 2 restores a 2.6 record without policyState and durably caps its new count', async () => {
  const lines = captureStartupLogs()
  const f = await fixture(false, false, 'debug')
  const live = (await (await f.live()).json()) as Record<string, any>
  await f.dispose()
  const [name] = await readdir(f.disk)
  const path = join(f.disk, name!)
  const saved = JSON.parse(gunzipSync(await readFile(path)).toString())
  expect(saved.policyState).toBeDefined()
  saved.pluginVersion = '2.6.0'
  delete saved.policyState
  await writeFile(path, gzipSync(JSON.stringify(saved)))
  forgetCacheKeepProcess(f.paths.storageId)
  f.advance(60_000)
  lines.length = 0
  const next = await f.start()
  expect(
    lines.find((line) => line.includes('restart records loaded')),
  ).toContain('"restored":1,"dropped":0')

  const owner = keeperFor(f.paths.storageId)
  expect(owner.manager.trackedPolicyState('ses_oc2_keep')).toMatchObject({
    planned: false,
    lastRealRequestAt: saved.lastTouchAt,
    warmsSinceLastRealRequest: 0,
    warmCostSoFar: 0,
    hasWarmed: false,
  })
  await owner.persistence.drain()
  expect(
    JSON.parse(gunzipSync(await readFile(path)).toString()).policyState
      .warmsSinceLastRealRequest,
  ).toBe(0)
  const reserved: number[] = []
  next.setSend(async () => {
    const persisted = JSON.parse(gunzipSync(await readFile(path)).toString())
    reserved.push(persisted.policyState.warmsSinceLastRealRequest)
    return Response.json({})
  })
  for (let count = 1; count <= 25; count++) {
    f.due()
    await f.timers.fire()
    expect(next.sent).toHaveLength(Math.min(count, 24))
  }
  expect(reserved).toEqual(Array.from({ length: 24 }, (_, i) => i + 1))
  const warm = (await next.sent[0]!.json()) as Record<string, any>
  expect(warm.messages).toEqual(live.messages)
  expect(warm.system.slice(1)).toEqual(live.system.slice(1))
  expect(owner.manager.trackedCount()).toBe(0)
})

test.each(['verified', 'unverified'] as const)(
  'OpenCode 2 warms a live pre-2.7 record with %s initial ownership',
  async (ownership) => {
    const f = await fixture()
    await f.live()
    await f.dispose()
    const [name] = await readdir(f.disk)
    const path = join(f.disk, name!)
    const saved = JSON.parse(gunzipSync(await readFile(path)).toString())
    saved.pluginVersion = '2.6.0'
    delete saved.policyState
    delete saved.lastTouchAt
    delete saved.lastTouchKind
    await writeFile(path, gzipSync(JSON.stringify(saved)))
    forgetCacheKeepProcess(f.paths.storageId)
    f.advance(60_000)
    const next = await f.start()
    const { manager, persistence } = sharedKeeper(f)
    const id = 'ses_oc2_keep'
    expect(manager.trackedPolicyState(id)?.lastRealRequestAt).toBe(f.now())
    const reserve = spyOn(persistence, 'reserveWarm')
    try {
      if (ownership === 'unverified')
        reserve.mockResolvedValueOnce('ownership-unverified')
      f.advance(saved.nextPrewarmAt - f.now())
      await f.timers.fireTimeouts()
      if (ownership === 'unverified') {
        expect(reserve).toHaveBeenCalled()
        expect(next.sent).toHaveLength(0)
        const reservations = reserve.mock.calls.length
        f.advance(999)
        await f.timers.fireTimeouts()
        expect(reserve).toHaveBeenCalledTimes(reservations)
        expect(next.sent).toHaveLength(0)

        const [target] = manager.trackedSessions()
        f.advance(target!.nextPrewarmAt - f.now())
        await f.timers.fireTimeouts()
      }
      expect(next.sent).toHaveLength(1)
      expect(manager.trackedPolicyState(id)?.warmsSinceLastRealRequest).toBe(1)
    } finally {
      reserve.mockRestore()
    }
  },
)

test('OpenCode 2 still drops a restart record requiring a real request', async () => {
  const lines = captureStartupLogs()
  const f = await fixture(false, false, 'debug')
  await f.live()
  await f.dispose()
  const [name] = await readdir(f.disk)
  const path = join(f.disk, name!)
  const saved = JSON.parse(gunzipSync(await readFile(path)).toString())
  saved.policyState.needsRealRequest = true
  saved.policyState.warmsSinceLastRealRequest = 24
  await writeFile(path, gzipSync(JSON.stringify(saved)))
  forgetCacheKeepProcess(f.paths.storageId)
  lines.length = 0
  const next = await f.start()
  expect(lines.some((line) => line.includes('"reason":"unsupported"'))).toBe(
    true,
  )
  expect(await readdir(f.disk)).toEqual([])
  f.due()
  await f.timers.fire()
  expect(next.sent).toEqual([])
})

test('an OpenCode 2 adopted entry writes through the newer store', async () => {
  const f = await fixture()
  const first = (await (await f.live()).json()) as Record<string, any>

  const owner = keeperFor(f.paths.storageId)
  const oldStore: CacheKeepStore = owner.persistence
  const next = await f.reload()
  const newStore = sharedKeeper(f).persistence
  expect(newStore).not.toBe(oldStore)
  await newStore.drain()
  const [name] = await readdir(f.disk)
  const saved = () =>
    readFile(join(f.disk, name!)).then((bytes) =>
      JSON.parse(gunzipSync(bytes).toString()),
    )
  expect(JSON.parse((await saved()).bodyText).messages).toEqual(first.messages)
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
  await newStore.drain()
  expect(JSON.parse((await saved()).bodyText).messages).toEqual(latest.messages)
})

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
  const secondAcceptedAt = f.now()
  f.advance(4999)
  await f.timers.fireTimeouts()
  const [name] = await readdir(f.disk)
  const saved = JSON.parse(
    gunzipSync(await readFile(join(f.disk, name!))).toString(),
  )
  expect(JSON.parse(saved.bodyText).messages).toEqual(first.messages)
  // The pending five-second store flush now coexists with the precise 55-minute warm timer.
  expect(
    [...f.timers.timeouts.values()]
      .map((timer) => timer.at)
      .sort((a, b) => a - b),
  ).toEqual([
    secondAcceptedAt + 5000,
    secondAcceptedAt + CACHE_KEEP_TTL_MS - CACHE_KEEP_PREWARM_LEAD_MS,
  ])
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
    if (change === 'unfinished-write') {
      await rename(path, join(f.disk, droppedName))
      await utimes(join(f.disk, droppedName), 0, 0)
    }
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

test('OpenCode 2 timers warm three overdue restored sessions before their retry windows end', async () => {
  const f = await fixture()
  for (const id of ['ses_one', 'ses_two', 'ses_three'])
    await f.live(undefined, {}, id)
  await f.dispose()
  const restoredAt = f.now()
  // The first-restored session can still start at the minute backstop. The
  // other two have about a minute of cache left and cannot wait that long.
  const names = (await readdir(f.disk)).sort()
  for (const name of names) {
    const path = join(f.disk, name)
    const saved = JSON.parse(gunzipSync(await readFile(path)).toString())
    saved.cacheExpiresAt = restoredAt + (name === names[0] ? 96_000 : 65_000)
    saved.nextPrewarmAt = restoredAt - 1000
    await writeFile(path, gzipSync(JSON.stringify(saved)))
  }
  forgetCacheKeepProcess(f.paths.storageId)
  const next = await f.start()
  const starts: number[] = []
  const clock = spyOn(Date, 'now').mockImplementation(f.now)
  cleanups.push(() => clock.mockRestore())
  next.setSend(async () => {
    starts.push(f.now() - restoredAt)
    f.advance(9000)
    return Response.json({ usage: { cache_read_input_tokens: 1 } })
  })
  await f.timers.advanceTo(restoredAt + 60_000, f.advance)
  expect(next.sent).toHaveLength(3)
  expect(starts).toEqual([1, 9002, 18002])
  const sessions = await f.registry.list()
  expect(sessions).toHaveLength(3)
  expect(sessions.every((session) => session.lastTouchKind === 'warm')).toBe(
    true,
  )
  expect(sessions.every((session) => !session.warmStopped)).toBe(true)
})

test('OpenCode 2 adoption re-arms the due timer for targets retained in memory', async () => {
  const f = await fixture()
  await f.live()
  await f.dispose()
  f.due()
  const adoptedAt = f.now()
  const next = await f.start()
  await f.timers.advanceTo(adoptedAt + 1, f.advance)
  expect(next.sent).toHaveLength(1)
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
    times.push(f.now())
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

  const owner = keeperFor(f.paths.storageId)
  trace.observeStore(owner.persistence, 'shared')
  await trace.wait('accepted live response', () => f.live())
  await trace.wait('original dispose', () => f.dispose())
  const next = await trace.wait('successor startup', () => f.start())
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
  const saved = loopbackHook[LOOPBACK_KEY]
  loopbackHook[LOOPBACK_KEY] = origin
  cleanups.push(() => {
    if (saved === undefined) delete loopbackHook[LOOPBACK_KEY]
    else loopbackHook[LOOPBACK_KEY] = saved
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
    if (!stillAdmitted) delete loopbackHook[LOOPBACK_KEY]
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
      (timer) => timer.at === f.now() + 150_000,
    ),
  ).toBe(true)
  f.advance(150_000)
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
    await expect(
      f.respond(
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
      ),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(sends).toBe(1)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(reports).toEqual([])
  } finally {
    globalThis.fetch = originalFetch
    if (originalRouting === undefined) delete globals[routingKey]
    else globals[routingKey] = originalRouting
  }
})

test('OC2 ordinary acceptance tracks the signed pre-thread snapshot before returning', async () => {
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
    expect(track.mock.calls[0]![0].bodyText).toBe(
      await signRequestBody(captured!),
    )
  } finally {
    rewrite.mockRestore()
    track.mockRestore()
  }
})

function runnerPolicyForReview(
  policy: unknown,
  reports: unknown[] = [],
  reportSessions?: string[],
) {
  const key = Symbol.for('cortexkit.routing')
  const globals = globalThis as Record<symbol, unknown>
  const original = globals[key]
  globals[key] = (sessionId: string) => ({
    cache: () => policy,
    report: (payload: unknown) => {
      reportSessions?.push(sessionId)
      reports.push(payload)
    },
  })
  cleanups.push(() => {
    if (original === undefined) delete globals[key]
    else globals[key] = original
  })
}

test('hybrid-disabled request dispatch never waits on a held restart write', async () => {
  const f = await fixture()
  await f.live()
  const owner = keeperFor(f.paths.storageId)
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
    const files = (await readdir(f.disk)).filter((name) =>
      name.endsWith('.json.gz'),
    )
    const retained = await Promise.all(
      files.map(
        async (file) =>
          JSON.parse(gunzipSync(await readFile(join(f.disk, file))).toString())
            .id,
      ),
    )
    expect(retained).toEqual(['ses_oc2_keep'])
  } finally {
    clearTimeout(timeout)
    release()
    await preparing
    drain.mockRestore()
  }
})

test('the hybrid-off sweep preserves a planned peer record after a clock rollback during drain', async () => {
  const f = await fixture()
  runnerPolicyForReview({ ttl: 'long', keep_warm: 'always' })
  const { id, peer, record, tracked } = await seedPeer(f)
  expect(tracked.policyState?.planned).toBe(true)
  const next = await f.start()
  const current = keeperFor(f.paths.storageId)
  expect(current.manager.trackedRequest(id)).toBeUndefined()
  const saved = await readFile(record)
  await peer.releaseClaims(() => true)
  await f.store.updateSettings((settings) => ({
    ...settings,
    cacheKeep: { enabled: false },
  }))
  const entered = Promise.withResolvers<void>()
  const resume = Promise.withResolvers<void>()
  const drain = current.persistence.drain.bind(current.persistence)
  const draining = spyOn(current.persistence, 'drain').mockImplementationOnce(
    async () => {
      entered.resolve()
      await resume.promise
      await drain()
    },
  )
  try {
    await next.prepare(undefined, {}, 'ses_during_disable')
    await entered.promise
    f.advance(-10_000)
  } finally {
    resume.resolve()
    await current.localCleanup
    draining.mockRestore()
  }
  expect(await readFile(record)).toEqual(saved)
})

test('reload from a 2.6.0-shaped owner supports accepted usage and planned warming', async () => {
  const f = await fixture()
  const reports: unknown[] = []
  runnerPolicyForReview(null, reports)
  await f.live()
  // Drain the initial response's detached report before counting reload reports.
  await new Promise((resolve) => setTimeout(resolve, 0))
  reports.length = 0
  const owner = keeperFor(f.paths.storageId)
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
  const next = await f.reload()
  await next.live()
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(
    reports.filter((value: any) => value.kind === 'cache_touch'),
  ).toHaveLength(1)
  f.due()
  await f.timers.fire()
  expect(next.sent).toHaveLength(1)
  runnerPolicyForReview({ ttl: 'long', keep_warm: 'always' })
  await next.live()
  f.due()
  await f.timers.fire()
  expect(next.sent).toHaveLength(2)
  expect(f.sent).toHaveLength(0)
  owner.manager = original
})

test.each(['http-relay', 'gzip'] as const)(
  'planned %s warm preserves physical transport framing',
  async (transport) => {
    const f = await fixture()
    await f.live(undefined, {
      system: 'Large stable cache prefix. '.repeat(10_000),
    })
    const owner = keeperFor(f.paths.storageId)
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
  const owner = keeperFor(f.paths.storageId)
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

  const initial = keeperFor(f.paths.storageId)
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
  const owner = keeperFor(f.paths.storageId)
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
    f.advance(3_300_000)
    await f.timers.fireTimeouts()
    await owner.manager.tick()
    expect(next.sent).toHaveLength(warm)
    expect(state).toBeDefined()
    expect(state!.warmCostSoFar).toBe(expectedCost)
    expect(state!.pendingWarmCost).toBeUndefined()
    expect(state!.prefixTokens).toBe(1_000)
  }
  f.advance(3_300_000)
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
    f.advance(3_300_000)
    const warming = f.timers.fireTimeouts()
    await enteredSend

    const owner = keeperFor(f.paths.storageId)
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
    const restored = keeperFor(f.paths.storageId).manager.trackedRequest(
      'ses_oc2_keep',
    )
    if (change === 'replaced') expect(restored?.bodyText).toBe(latest)
    else expect(restored).toBeUndefined()
    f.advance(3_300_000)
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
    const owner = keeperFor(f.paths.storageId)
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
  const owner = keeperFor(f.paths.storageId)
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
  const owner = keeperFor(f.paths.storageId)
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
    const owner = keeperFor(f.paths.storageId)
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

    const owner = keeperFor(f.paths.storageId)
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
    f.advance(150_000)
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
  const owner = keeperFor(f.paths.storageId)
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
  f.advance(3_300_000)
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

function runnerPolicies(reports: Array<Record<string, unknown>>) {
  const policies = new Map<string, unknown>()
  const key = Symbol.for('cortexkit.routing')
  const globals = globalThis as Record<symbol, unknown>
  const original = globals[key]
  globals[key] = (sessionId: string) => ({
    cache: () => policies.get(sessionId) ?? null,
    report: (payload: Record<string, unknown>) => reports.push(payload),
  })
  cleanups.push(() => {
    if (original === undefined) delete globals[key]
    else globals[key] = original
  })
  return policies
}

/** A runner hours window six hours from now, so no warm can fall inside it. */
function hoursAway() {
  const hhmm = (at: number) => new Date(at).toISOString().slice(11, 16)
  const from = Date.now() + 6 * 3_600_000
  return { from: hhmm(from), to: hhmm(from + 10 * 60_000), tz: 'UTC' }
}

async function modelBilling(reports: Array<Record<string, unknown>>) {
  await Bun.sleep(10)
  const billed = reports.filter(
    (report) =>
      report.kind === 'billing' && report.request_kind !== 'keep_warm',
  )
  reports.length = 0
  return billed
}

const warmingOf = (report: Record<string, unknown> | undefined) =>
  (report?.cache as Record<string, unknown> | undefined)?.warming

test('OC2 mixed sent cache lifetimes use the shortest for billing and longest for cache_touch', async () => {
  const reports: Array<Record<string, unknown>> = []
  const policies = runnerPolicies(reports)
  policies.set('ses_oc2_keep', { keep_warm: 'off' })
  const f = await fixture()
  const originalRewrite = wireTransform.rewriteRequestBody
  // Inject mixed lifetimes after the host normalizes its cache markers, so the
  // reports must describe the final sent body rather than the host's defaults.
  const rewrite = spyOn(wireTransform, 'rewriteRequestBody').mockImplementation(
    async (...args) => {
      const body = JSON.parse((await originalRewrite(...args))!)
      body.system = [
        {
          type: 'text',
          text: 'Stable',
          cache_control: { type: 'ephemeral', ttl: '1h' },
        },
      ]
      body.messages = [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'Hello',
              cache_control: { type: 'ephemeral' },
            },
          ],
        },
      ]
      return JSON.stringify(body)
    },
  )
  cleanups.push(() => rewrite.mockRestore())
  const request = await f.live()
  const sent = JSON.parse(await request.clone().text())
  expect(sent.system[0].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' })
  expect(sent.messages[0].content[0].cache_control).toEqual({
    type: 'ephemeral',
  })
  await Bun.sleep(10)
  expect(reports.filter((report) => report.kind === 'billing')).toEqual([
    expect.objectContaining({
      outcome: 'completed',
      cache: expect.objectContaining({ ttl_ms: 300_000 }),
    }),
  ])
  expect(reports.filter((report) => report.kind === 'cache_touch')).toEqual([
    {
      kind: 'cache_touch',
      at: expect.any(Number),
      ttl_ms: 3_600_000,
      source: 'response',
    },
  ])
})

test('OC2 model-request billing carries the keep-warm state each step leaves', async () => {
  const reports: Array<Record<string, unknown>> = []
  const policies = runnerPolicies(reports)
  const f = await fixture()
  await f.live()
  const [warm] = await modelBilling(reports)
  expect(warm).toMatchObject({
    outcome: 'completed',
    cache: { ttl_ms: 3_600_000, warming: { on: true } },
  })

  // A failed attempt still carries no cache facts, warming included.
  const failed = await f.prepare()
  await f
    .respond(failed, Response.json({ type: 'error' }, { status: 500 }))
    .catch(() => {})
  const [refused] = await modelBilling(reports)
  expect(refused).toMatchObject({ outcome: 'failed' })
  expect(refused?.cache).toBeUndefined()

  policies.set('ses_oc2_keep', { keep_warm: 'hours', hours: hoursAway() })
  await f.live()
  const [stopped] = await modelBilling(reports)
  expect(stopped).toMatchObject({ outcome: 'completed' })
  expect(warmingOf(stopped)).toEqual({
    on: false,
    stop_reason: 'outside-hours',
  })
})

test('OC2 model-request billing reports keep-warm off when a plan or setting never starts it', async () => {
  const reports: Array<Record<string, unknown>> = []
  const policies = runnerPolicies(reports)
  const f = await fixture()
  policies.set('ses_oc2_plan_off', { keep_warm: 'off' })
  await f.live(undefined, {}, 'ses_oc2_plan_off')
  const [planOff] = await modelBilling(reports)
  expect(planOff).toMatchObject({ outcome: 'completed' })
  expect(warmingOf(planOff)).toEqual({
    on: false,
  })

  await f.store.updateSettings((settings) => ({
    ...settings,
    cacheKeep: { enabled: false },
  }))
  await f.live(undefined, {}, 'ses_oc2_local_off')
  const [localOff] = await modelBilling(reports)
  expect(localOff).toMatchObject({ outcome: 'completed' })
  expect(warmingOf(localOff)).toEqual({
    on: false,
  })
})

function sharedKeeper(f: Awaited<ReturnType<typeof fixture>>) {
  return keeperFor(f.paths.storageId) as {
    manager: CacheKeepManager
    persistence: CacheKeepStore
  }
}

function failNextRestartWrite(store: CacheKeepStore) {
  // Fail the record write, not the caller, so the real persistence path still
  // accounts for the difference between queued and committed state.
  const writer = store as unknown as {
    writeEntry: (
      entry: SavedCacheKeepTarget,
      assertOwned?: () => Promise<void>,
      stillLatest?: () => boolean,
    ) => Promise<boolean>
  }
  const write = writer.writeEntry.bind(writer)
  return spyOn(writer, 'writeEntry')
    .mockImplementation(write)
    .mockRejectedValueOnce(new Error('Temporary restart write failure'))
}

test.each([false, true])(
  'OC2 refunds a cancelled warm copied into a newer usage snapshot (timer already flushing: %s)',
  async (flushTimer) => {
    runnerPolicies([])
    const f = await fixture()
    await f.live(undefined, { model: 'claude-opus-5-5' })
    const { manager, persistence } = sharedKeeper(f)
    const id = 'ses_oc2_keep'
    const target = (
      Reflect.get(manager, 'targets') as Map<string, CacheKeepTarget>
    ).get(id)!
    const state = target.policyState!
    Object.assign(state, {
      warmsSinceLastRealRequest: 23,
      warmCostSoFar: 2,
      prefixTokens: 1000,
      inputTokens: 1000,
      hasWarmed: true,
    })
    expect(await persistence.reserveWarm(target)).toBe(true)
    const [name] = await readdir(f.disk)
    const saved = async () =>
      JSON.parse(gunzipSync(await readFile(join(f.disk, name!))).toString())
        .policyState
    const store = persistence as unknown as {
      directoryReady(): Promise<boolean>
      writeEntry(
        entry: SavedCacheKeepTarget,
        assertOwned?: () => Promise<void>,
        stillLatest?: () => boolean,
      ): Promise<boolean>
    }
    const reserving = Promise.withResolvers<void>()
    const resumeReserve = Promise.withResolvers<void>()
    const flushed = Promise.withResolvers<void>()
    const resumeFlush = Promise.withResolvers<void>()
    const ready = store.directoryReady.bind(store)
    const checking = spyOn(store, 'directoryReady').mockImplementationOnce(
      async () => {
        reserving.resolve()
        await resumeReserve.promise
        return ready()
      },
    )
    const reserve = persistence.reserveWarm.bind(persistence)
    const returnReservation = Promise.withResolvers<void>()
    const settling = Promise.withResolvers<void>()
    const reservation = spyOn(persistence, 'reserveWarm')
      .mockImplementation((entry) => {
        const result = reserve(entry)
        settling.resolve()
        return result
      })
      .mockImplementationOnce(async (entry) => {
        const result = await reserve(entry)
        if (flushTimer) await returnReservation.promise
        return result
      })
    const write = store.writeEntry.bind(store)
    const countsSeenByTimer: number[] = []
    const writing = spyOn(store, 'writeEntry').mockImplementation(
      async (...args) => {
        const [entry] = args
        if (!flushTimer || entry.policyState?.warmsSinceLastRealRequest !== 24)
          return write(...args)
        flushed.resolve()
        await resumeFlush.promise
        const result = await write(...args)
        countsSeenByTimer.push((await saved()).warmsSinceLastRealRequest)
        return result
      },
    )
    f.due()
    const warming = f.timers.fire()
    let reloading: ReturnType<typeof f.reload> | undefined
    let flushing: Promise<unknown> | undefined
    try {
      await Promise.race([reserving.promise, warming])
      expect(state.warmsSinceLastRealRequest).toBe(24)
      expect(state.pendingWarmCost).toBeGreaterThan(0)
      const timersBeforeUsage = new Set(f.timers.timeouts.keys())
      manager.recordAcceptedUsage(id, target.bodyText, {
        cache_read_input_tokens: 2000,
      })
      if (flushTimer) {
        const timer = [...f.timers.timeouts].find(
          ([key, timer]) => !timersBeforeUsage.has(key) && timer.at > f.now(),
        )
        expect(timer).toBeDefined()
        flushing = Promise.resolve(timer![1].callback())
      }
      reloading = f.reload()
      resumeReserve.resolve()
      if (flushTimer) {
        await Promise.race([flushed.promise, flushing!])
        expect(writing).toHaveBeenCalledTimes(1)
        returnReservation.resolve()
        // Let the cancelled reservation publish the refund while the timer's
        // already-started write is still staging its snapshot.
        await Promise.race([settling.promise, warming])
        resumeFlush.resolve()
      }
      const next = await reloading
      expect(f.sent).toHaveLength(0)
      expect(state.warmsSinceLastRealRequest).toBe(23)
      expect(await saved()).toMatchObject({
        warmsSinceLastRealRequest: 23,
        prefixTokens: 2000,
      })
      expect((await saved()).pendingWarmCost).toBeUndefined()
      expect(countsSeenByTimer).toEqual(flushTimer ? [23] : [])
      expect(sharedKeeper(f).manager.trackedRequest(id)).toBeDefined()
      f.advance(20_000)
      await f.timers.fire()
      expect(next.sent).toHaveLength(1)
    } finally {
      resumeReserve.resolve()
      returnReservation.resolve()
      resumeFlush.resolve()
      await Promise.all([warming, reloading, flushing])
      checking.mockRestore()
      reservation.mockRestore()
      writing.mockRestore()
    }
  },
)

test.each([false, true])(
  'OC2 reload preserves a record when an unsent reservation is refunded (refund write fails: %s)',
  async (failRefund) => {
    const reports: Array<Record<string, unknown>> = []
    runnerPolicies(reports)
    const f = await fixture()
    await f.live(undefined, { model: 'claude-opus-5-5' })
    const old = sharedKeeper(f)
    const id = 'ses_oc2_keep'
    const target = (
      Reflect.get(old.manager, 'targets') as Map<string, CacheKeepTarget>
    ).get(id)!
    Object.assign(target.policyState!, {
      warmsSinceLastRealRequest: 23,
      warmCostSoFar: 2,
      prefixTokens: 1000,
      inputTokens: 1000,
      hasWarmed: true,
    })
    expect(await old.persistence.reserveWarm(target)).toBe(true)
    const [name] = await readdir(f.disk)
    const saved = async () =>
      JSON.parse(gunzipSync(await readFile(join(f.disk, name!))).toString())
    expect((await saved()).policyState.warmsSinceLastRealRequest).toBe(23)
    const entered = Promise.withResolvers<void>()
    const resume = Promise.withResolvers<void>()
    const reserve = old.persistence.reserveWarm.bind(old.persistence)
    const reserving = spyOn(old.persistence, 'reserveWarm').mockImplementation(
      async (entry) => {
        const result = await reserve(entry)
        entered.resolve()
        await resume.promise
        return result
      },
    )
    f.due()
    const warming = f.timers.fire()
    let writing: ReturnType<typeof failNextRestartWrite> | undefined
    try {
      await Promise.race([entered.promise, warming])
      expect(reserving).toHaveBeenCalledTimes(1)
      expect((await saved()).policyState.warmsSinceLastRealRequest).toBe(24)
      expect((await saved()).policyState.pendingWarmCost).toBeGreaterThan(0)
      if (failRefund) writing = failNextRestartWrite(old.persistence)
      const reloading = f.reload()
      resume.resolve()
      await warming
      const next = await reloading
      const current = sharedKeeper(f)
      expect(f.sent).toHaveLength(0)
      expect(next.sent).toHaveLength(0)
      expect(target.policyState?.warmsSinceLastRealRequest).toBe(23)
      expect(target.policyState?.pendingWarmCost).toBeUndefined()
      if (failRefund) {
        expect(writing).toHaveBeenCalledTimes(1)
        expect(old.persistence.isCommitted(id)).toBe(false)
        expect(old.manager.trackedRequest(id)).toBeDefined()
        expect(current.manager.trackedRequest(id)).toBeUndefined()
        f.advance(20_000)
        await f.timers.fire()
        expect(next.sent).toHaveLength(0)
        expect((await saved()).policyState.warmsSinceLastRealRequest).toBe(24)
        return
      }
      expect((await saved()).policyState).toMatchObject({
        warmsSinceLastRealRequest: 23,
        warmCostSoFar: 2,
      })
      expect((await saved()).policyState.pendingWarmCost).toBeUndefined()
      expect(target.consecutiveFailures).toBe(0)
      expect(
        reports.filter(({ kind }) => kind === 'cache_warm_stopped'),
      ).toEqual([])
      expect(current.manager.trackedRequest(id)).toBeDefined()
      expect(old.manager.trackedCount()).toBe(0)
      f.advance(20_000)
      await f.timers.fire()
      expect(f.sent).toHaveLength(0)
      expect(next.sent).toHaveLength(1)
    } finally {
      resume.resolve()
      await warming
      reserving.mockRestore()
      writing?.mockRestore()
    }
  },
)

test('OC2 reload keeps a live old folder working and rescans when its replacement loads', async () => {
  const f = await fixture()
  const second = await f.start()
  const old = sharedKeeper(f)
  const existing = 'ses_held_by_old_folder'
  const latest = 'ses_accepted_by_old_folder'
  await second.live(undefined, {}, existing)
  await old.persistence.drain()
  const pending = await second.prepare(
    undefined,
    {
      messages: [
        { role: 'user', content: 'Accepted by the still-live folder' },
      ],
    },
    existing,
  )

  const next = await f.reload()
  const current = sharedKeeper(f)
  expect(current.manager).not.toBe(old.manager)
  // A late response and a new turn on the still-live folder stay with the old manager.
  await second.respond(pending)
  f.advance(5_000)
  await second.live(undefined, {}, latest)
  await old.persistence.drain()
  expect(old.manager.trackedRequest(existing)?.bodyText).toContain(
    'Accepted by the still-live folder',
  )
  expect(old.persistence.isCommitted(existing)).toBe(true)
  expect(old.persistence.isCommitted(latest)).toBe(true)
  expect(current.manager.trackedCount()).toBe(0)

  f.advance(CACHE_KEEP_TTL_MS - CACHE_KEEP_PREWARM_LEAD_MS - 5_000)
  await f.timers.fire()
  expect(second.sent).toHaveLength(1)
  f.advance(5_000)
  await f.timers.fire()
  expect(second.sent).toHaveLength(2)
  expect(f.sent).toHaveLength(0)
  expect(next.sent).toHaveLength(0)

  const schedule = old.manager.trackedSessions()
  const replacement = await f.reload(true, second)
  expect(sharedKeeper(f).manager).toBe(current.manager)
  expect(old.manager.trackedCount()).toBe(0)
  expect(current.manager.trackedSessions()).toEqual(schedule)
  for (const { nextPrewarmAt } of schedule.sort(
    (a, b) => a.nextPrewarmAt - b.nextPrewarmAt,
  )) {
    f.advance(nextPrewarmAt - f.now())
    await f.timers.fire()
  }
  expect(second.sent).toHaveLength(2)
  expect(next.sent).toHaveLength(0)
  expect(replacement.sent).toHaveLength(2)
})

test('a retried claim release prompts one rescan by a live OC2 keeper', async () => {
  const f = await fixture()
  await f.live()
  const previous = sharedKeeper(f)
  await previous.persistence.drain()
  const id = 'ses_oc2_keep'
  const resume = Promise.withResolvers<void>()
  const released = Promise.withResolvers<void>()
  const release = CacheKeepClaim.prototype.release
  const releasing = spyOn(CacheKeepClaim.prototype, 'release')
    .mockRejectedValueOnce(new Error('Temporary claim release failure'))
    .mockImplementationOnce(async function (this: CacheKeepClaim) {
      await resume.promise
      await release.call(this)
      released.resolve()
    })
  try {
    await f.reload()
    const current = sharedKeeper(f)
    expect(current.manager.trackedRequest(id)).toBeUndefined()
    const scanning = spyOn(current.persistence, 'load')
    try {
      resume.resolve()
      await released.promise
      // The notification follows claim release and removal from the old store.
      await delay(0)
      await keeperFor(f.paths.storageId)?.loading
      expect(current.manager.trackedRequest(id)).toBeDefined()
      expect(scanning).toHaveBeenCalledTimes(1)

      const peer = await f.start()
      const normal = 'ses_normally_released'
      await peer.live(undefined, {}, normal)
      await previous.persistence.drain()
      expect(previous.persistence.isCommitted(normal)).toBe(true)
      await peer.dispose()
      expect(scanning).toHaveBeenCalledTimes(1)
    } finally {
      scanning.mockRestore()
    }
  } finally {
    resume.resolve()
    releasing.mockRestore()
  }
})

test('a freshness drop prompts one rescan that adopts the newer peer record', async () => {
  const f = await fixture()
  const { id, peer, tracked } = await seedPeer(f)
  const next = await f.start()
  const current = sharedKeeper(f)
  expect(current.manager.trackedRequest(id)).toBeUndefined()
  await next.live(undefined, {
    messages: [{ role: 'user', content: 'Accepted by the contender' }],
  })
  await current.persistence.drain()
  expect(current.persistence.isCommitted(id)).toBe(false)
  const older = (
    Reflect.get(current.manager, 'targets') as Map<string, CacheKeepTarget>
  ).get(id)!
  expect(older.bodyText).toContain('Accepted by the contender')

  const newest = 'Accepted more recently by the peer'
  f.advance(5_000)
  peer.changed({
    ...tracked,
    bodyText: tracked.bodyText.replace('Hello', newest),
    policyState: { ...tracked.policyState!, lastRealRequestAt: f.now() },
  })
  await peer.drain()
  expect(peer.isCommitted(id)).toBe(true)
  await peer.releaseClaims(() => true)
  const scanning = spyOn(current.persistence, 'load')
  try {
    expect(await current.persistence.reserveWarm(older)).toBe('not-owner')
    await keeperFor(f.paths.storageId)?.loading
    expect(current.manager.trackedRequest(id)?.bodyText).toContain(newest)
    expect(scanning).toHaveBeenCalledTimes(1)
  } finally {
    scanning.mockRestore()
  }
})

test('a superseded OC2 turn cannot overwrite a newer body through a restore claim', async () => {
  const f = await fixture()
  const { id, peer, record, claim } = await seedPeer(f)
  await peer.releaseClaims(() => true)
  const next = await f.start()
  const { manager, persistence } = sharedKeeper(f)
  await persistence.drain()
  const saved = await readFile(record)
  const newer = JSON.parse(gunzipSync(saved).toString()) as SavedCacheKeepTarget
  expect(manager.trackedRequest(id)?.bodyText).toBe(newer.bodyText)
  expect(JSON.parse(await readFile(claim, 'utf8')).restoreOnly).toBe(true)

  const entered = Promise.withResolvers<void>()
  const unblock = Promise.withResolvers<void>()
  Reflect.get(persistence, 'enqueue').call(persistence, () => {
    entered.resolve()
    return unblock.promise
  })
  try {
    await entered.promise
    // Roll the clock back before accepting a different body. The real-claim
    // request and the acceptance's coalesced write cannot run yet.
    f.advance(-500)
    const older = 'Accepted locally after the clock rolled back'
    await next.live(undefined, { messages: [{ role: 'user', content: older }] })
    expect(manager.trackedRequest(id)?.bodyText).toContain(older)
    expect(manager.trackedPolicyState(id)!.lastRealRequestAt).toBeLessThan(
      newer.policyState!.lastRealRequestAt,
    )
    const timer = Reflect.get(persistence, 'timers').get(id)
    const flush = f.timers.timeouts.get(timer)!
    f.advance(flush.at - f.now())
    const flushing = flush.callback()

    // The next foreground turn replaces the pending real-claim request but not
    // the accepted body. The older flush must not write under the restore claim.
    const turn = await next.prepare()
    expect(manager.trackedRequest(id)?.bodyText).toContain(older)
    unblock.resolve()
    await flushing
    await persistence.drain()
    expect(await readFile(record)).toEqual(saved)
    await next.respond(turn)
  } finally {
    unblock.resolve()
    await persistence.drain()
  }
})

test('OC2 budget eviction preserves the body adopted by the restore claim', async () => {
  const f = await fixture()
  const { id, peer, record, claim } = await seedPeer(f)
  await peer.releaseClaims(() => true)
  const next = await f.start()
  const { manager, persistence } = sharedKeeper(f)
  await persistence.drain()
  const saved = await readFile(record)
  const newer = JSON.parse(gunzipSync(saved).toString()) as SavedCacheKeepTarget
  expect(manager.trackedRequest(id)?.bodyText).toBe(newer.bodyText)
  expect(JSON.parse(await readFile(claim, 'utf8')).restoreOnly).toBe(true)

  const imminentId = 'ses_oc2_imminent'
  await next.live(undefined, {}, imminentId)
  const targets = Reflect.get(manager, 'targets') as Map<
    string,
    CacheKeepTarget
  >
  const imminent = targets.get(imminentId)!
  // Model the byte pressure without making a 64 MiB prompt. The other target
  // is due soon and leaves just enough room for the saved body.
  imminent.bodyBytes = CACHE_KEEP_MAX_BODY_BYTES - targets.get(id)!.bodyBytes
  imminent.nextPrewarmAt = f.now() + 30_000
  await persistence.drain()

  const entered = Promise.withResolvers<void>()
  const resume = Promise.withResolvers<void>()
  Reflect.get(persistence, 'enqueue').call(persistence, () => {
    entered.resolve()
    return resume.promise
  })
  const track = spyOn(manager, 'track')
  try {
    await entered.promise
    f.advance(-500)
    expect(f.now()).toBeLessThan(newer.policyState!.lastRealRequestAt)
    await next.live(undefined, {
      messages: [{ role: 'user', content: 'Older, larger body. '.repeat(200) }],
    })
    const accepted = track.mock.lastCall![0]
    const acceptedBytes = Buffer.byteLength(accepted.bodyText)
    expect(accepted.sessionId).toBe(id)
    expect(acceptedBytes).toBeLessThan(CACHE_KEEP_MAX_BODY_BYTES)
    expect(acceptedBytes + imminent.bodyBytes).toBeGreaterThan(
      CACHE_KEEP_MAX_BODY_BYTES,
    )
    expect(track.mock.results.at(-1)?.value).toEqual({
      tracked: false,
      reason: 'evicted by cachekeep limits',
    })
    expect(manager.trackedSessions().map(({ id }) => id)).toEqual([imminentId])

    resume.resolve()
    await persistence.drain()
    await keeperFor(f.paths.storageId)?.loading
    expect(await readFile(record)).toEqual(saved)
  } finally {
    track.mockRestore()
    resume.resolve()
    await persistence.drain()
  }
})

test('a failed OC2 turn cannot unlink a newer body through a restore claim', async () => {
  const f = await fixture()
  const { id, peer, record, claim } = await seedPeer(f)
  await peer.releaseClaims(() => true)
  const next = await f.start()
  const { manager, persistence } = sharedKeeper(f)
  await persistence.drain()
  const saved = await readFile(record)
  const newer = JSON.parse(gunzipSync(saved).toString()) as SavedCacheKeepTarget
  const restoreClaim = await readFile(claim, 'utf8')
  expect(manager.trackedRequest(id)?.bodyText).toBe(newer.bodyText)
  expect(JSON.parse(restoreClaim).restoreOnly).toBe(true)

  const enqueue = Reflect.get(persistence, 'enqueue').bind(persistence)
  const holdQueue = () => {
    const entered = Promise.withResolvers<void>()
    const resume = Promise.withResolvers<void>()
    enqueue(() => {
      entered.resolve()
      return resume.promise
    })
    return { entered: entered.promise, resume: resume.resolve }
  }
  const beforeFlush = holdQueue()
  const resumeScan = Promise.withResolvers<void>()
  const load = persistence.load.bind(persistence)
  const rescan = spyOn(persistence, 'load').mockImplementation(
    async (...args) => {
      await resumeScan.promise
      await load(...args)
    },
  )
  let afterFlush: ReturnType<typeof holdQueue> | undefined
  try {
    await beforeFlush.entered
    f.advance(-500)
    const older = 'Accepted locally after the clock rolled back'
    await next.live(undefined, { messages: [{ role: 'user', content: older }] })
    expect(manager.trackedPolicyState(id)!.lastRealRequestAt).toBeLessThan(
      newer.policyState!.lastRealRequestAt,
    )
    const timer = Reflect.get(persistence, 'timers').get(id)
    const flush = f.timers.timeouts.get(timer)!
    f.advance(flush.at - f.now())
    flush.callback()

    // The next turn supersedes the older body's pending claim. Let its flush
    // finish, but hold unrelated work ahead of the next turn's acquisition.
    afterFlush = holdQueue()
    const turn = await next.prepare()
    beforeFlush.resume()
    await afterFlush.entered
    expect(manager.trackedRequest(id)?.bodyText).toContain(older)
    expect(await readFile(record)).toEqual(saved)

    await next.respond(turn, Response.json({}, { status: 503 }))
    expect(manager.trackedRequest(id)).toBeUndefined()
    afterFlush.resume()
    await persistence.drain()
    expect(await readFile(record)).toEqual(saved)
    await expect(readFile(claim, 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    })

    // Let the claim-available scan finish on the same keeper, with its lease
    // still open. Pausing the scan lets us observe the gap between claims.
    resumeScan.resolve()
    await keeperFor(f.paths.storageId)?.loading
    expect(rescan).toHaveBeenCalledTimes(1)
    expect(manager.trackedRequest(id)?.bodyText).toBe(newer.bodyText)
    const adoptedClaim = await readFile(claim, 'utf8')
    expect(adoptedClaim).not.toBe(restoreClaim)
    expect(JSON.parse(adoptedClaim).restoreOnly).toBe(true)
    expect(await readFile(record)).toEqual(saved)
  } finally {
    beforeFlush.resume()
    afterFlush?.resume()
    resumeScan.resolve()
    rescan.mockRestore()
    await persistence.drain()
  }
})

test('an OC2 primary request does not reuse a restore claim queued for release', async () => {
  const f = await fixture()
  const { id, peer, record, claim } = await seedPeer(f)
  await peer.releaseClaims(() => true)
  const next = await f.start()
  const { manager, persistence } = sharedKeeper(f)
  const saved = await readFile(record)
  const restoreClaim = await readFile(claim, 'utf8')
  const restored = JSON.parse(restoreClaim)
  expect(restored.restoreOnly).toBe(true)

  const entered = Promise.withResolvers<void>()
  const resume = Promise.withResolvers<void>()
  Reflect.get(persistence, 'enqueue').call(persistence, () => {
    entered.resolve()
    return resume.promise
  })
  const resumeScan = Promise.withResolvers<void>()
  const load = persistence.load.bind(persistence)
  const rescan = spyOn(persistence, 'load').mockImplementation(
    async (...args) => {
      await resumeScan.promise
      await load(...args)
    },
  )
  try {
    await entered.promise
    f.advance(-500)
    const older = 'Accepted locally after the clock rolled back'
    await next.live(undefined, { messages: [{ role: 'user', content: older }] })
    expect(manager.trackedRequest(id)?.bodyText).toContain(older)
    const savedTarget = JSON.parse(
      gunzipSync(saved).toString(),
    ) as SavedCacheKeepTarget
    expect(manager.trackedPolicyState(id)!.lastRealRequestAt).toBeLessThan(
      savedTarget.policyState!.lastRealRequestAt,
    )

    // Retire the older body while unrelated store work still holds the queue.
    const failing = await next.prepare()
    await next.respond(failing, Response.json({}, { status: 503 }))
    expect(manager.trackedRequest(id)).toBeUndefined()
    expect(await readFile(claim, 'utf8')).toBe(restoreClaim)

    // The next primary request can start without waiting for the release, but
    // an unaccepted request must not open another claim during cleanup.
    f.advance(1_000)
    const accepted = 'Accepted after the restore claim retired'
    const turn = await next.prepare(undefined, {
      messages: [{ role: 'user', content: accepted }],
    })
    resume.resolve()
    await persistence.drain()
    expect(await readFile(record)).toEqual(saved)
    await expect(readFile(claim, 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    })

    await next.respond(turn)
    await persistence.drain()
    const realClaim = JSON.parse(await readFile(claim, 'utf8'))
    expect(realClaim.restoreOnly).toBeUndefined()
    expect(realClaim.token).toBeTypeOf('string')
    expect(realClaim.token).not.toBe(restored.token)
    expect(persistence.isCommitted(id)).toBe(true)
    const committed = await readFile(record)
    expect(JSON.parse(gunzipSync(committed).toString()).bodyText).toContain(
      accepted,
    )

    resumeScan.resolve()
    await keeperFor(f.paths.storageId)?.loading
    await next.dispose()
    expect(await readdir(`${f.disk}.claims`)).toEqual([])
    expect(await readFile(record)).toEqual(committed)
  } finally {
    resume.resolve()
    resumeScan.resolve()
    rescan.mockRestore()
    await persistence.drain()
    await keeperFor(f.paths.storageId)?.loading
  }
})

test('a failed in-flight OC2 turn cannot delete a newer peer record on a freshness wakeup', async () => {
  const f = await fixture()
  const { id, peer, record, tracked } = await seedPeer(f)
  const next = await f.start()
  const current = sharedKeeper(f)
  await next.live()
  await current.persistence.drain()
  expect(current.persistence.isCommitted(id)).toBe(false)
  const older = (
    Reflect.get(current.manager, 'targets') as Map<string, CacheKeepTarget>
  ).get(id)!
  const pending = await next.prepare()
  const newest = 'Peer accepted this before the pending turn failed'
  f.advance(5_000)
  peer.changed({
    ...tracked,
    bodyText: tracked.bodyText.replace('Hello', newest),
    policyState: { ...tracked.policyState!, lastRealRequestAt: f.now() },
  })
  await peer.drain()
  await peer.releaseClaims(() => true)
  const saved = await readFile(record)
  const scanning = spyOn(current.persistence, 'load')
  try {
    expect(await current.persistence.reserveWarm(older)).toBe('not-owner')
    await keeperFor(f.paths.storageId)?.loading
    expect(scanning).toHaveBeenCalledTimes(1)
    const adoptedWhilePending = current.manager.trackedRequest(id)

    await next.respond(pending, Response.json({}, { status: 503 }))
    await current.persistence.drain()
    expect(await readFile(record)).toEqual(saved)
    expect(adoptedWhilePending).toBeUndefined()
    await keeperFor(f.paths.storageId)?.loading
    expect(current.manager.trackedRequest(id)?.bodyText).toContain(newest)
    expect(scanning).toHaveBeenCalledTimes(2)
  } finally {
    scanning.mockRestore()
  }
})

test('an OC2 turn retiring an unowned target cannot unlink a peer record through a later scan claim', async () => {
  const f = await fixture()
  const { id, peer, record, tracked } = await seedPeer(f)
  const next = await f.start()
  const owner = keeperFor(f.paths.storageId)
  const { manager, persistence } = sharedKeeper(f)
  await next.live()
  await persistence.drain()
  expect(manager.trackedRequest(id)).toBeDefined()
  expect(persistence.isCommitted(id)).toBe(false)

  const listed = Promise.withResolvers<void>()
  const checkRecord = Promise.withResolvers<void>()
  const writing = Promise.withResolvers<void>()
  const finishWrite = Promise.withResolvers<void>()
  const claimed = Promise.withResolvers<boolean>()
  const readRecord = Promise.withResolvers<void>()
  const load = persistence.load.bind(persistence)
  const key = createHash('sha256').update(id).digest('hex')
  const scanning = spyOn(persistence, 'load').mockImplementationOnce(
    (now, accept, claim, guard, mode) =>
      load(
        now,
        accept,
        claim,
        async (hash) => {
          if (hash === key) {
            listed.resolve()
            await checkRecord.promise
          }
          return guard?.(hash) ?? true
        },
        mode,
      ),
  )
  const writer = persistence as unknown as {
    writeEntry: (
      entry: SavedCacheKeepTarget,
      assertOwned?: () => Promise<void>,
      stillLatest?: () => boolean,
    ) => Promise<boolean>
  }
  const write = writer.writeEntry.bind(writer)
  const holdingWrite = spyOn(writer, 'writeEntry').mockImplementationOnce(
    async (...args) => {
      writing.resolve()
      await finishWrite.promise
      return write(...args)
    },
  )
  const scan = owner.adopt()
  let holdingRead: { mockRestore(): void } | undefined
  try {
    // The scan has passed its wait on the store queue and listed the record.
    await listed.promise
    persistence.changed({ ...tracked, id: 'ses_unrelated' })
    void persistence.drain()
    await writing.promise
    const turn = await next.prepare()
    await next.respond(turn, Response.json({}, { status: 503 }))
    expect(manager.trackedRequest(id)).toBeUndefined()

    const newest = 'Peer accepted this after the failed turn retired its target'
    f.advance(5_000)
    peer.changed({
      ...tracked,
      bodyText: tracked.bodyText.replace('Hello', newest),
      policyState: { ...tracked.policyState!, lastRealRequestAt: f.now() },
    })
    await peer.drain()
    await peer.releaseClaims(() => true)
    const saved = await readFile(record)

    // Drain the queued removal while the scan owns the claim but has not read
    // or adopted the peer's new record yet.
    const isCurrent = CacheKeepClaim.prototype.isCurrent
    holdingRead = spyOn(
      CacheKeepClaim.prototype,
      'isCurrent',
    ).mockImplementationOnce(async function (this: CacheKeepClaim) {
      const current = await isCurrent.call(this)
      claimed.resolve(current)
      await readRecord.promise
      return current
    })
    checkRecord.resolve()
    expect(await claimed.promise).toBe(true)
    finishWrite.resolve()
    await persistence.drain()
    expect(await readFile(record)).toEqual(saved)
    expect(manager.trackedRequest(id)).toBeUndefined()

    readRecord.resolve()
    await scan
    expect(manager.trackedRequest(id)?.bodyText).toContain(newest)
    expect(await readFile(record)).toEqual(saved)
  } finally {
    checkRecord.resolve()
    finishWrite.resolve()
    readRecord.resolve()
    await scan
    await persistence.drain()
    holdingRead?.mockRestore()
    holdingWrite.mockRestore()
    scanning.mockRestore()
  }
})

test('OC2 defers restoring an owned target until its owner’s foreground turn settles', async () => {
  const f = await fixture()
  const { id, peer, record, tracked } = await seedPeer(f)
  const next = await f.start()
  const owner = keeperFor(f.paths.storageId)
  const parent = 'ses_owner'
  await next.live(undefined, {}, parent)
  const turn = await next.prepare(undefined, {}, parent)

  peer.changed({
    ...tracked,
    policyState: { ...tracked.policyState!, ownerSessionId: parent },
  })
  await peer.drain()
  await peer.releaseClaims(() => true)
  const saved = await readFile(record)
  await owner.adopt()
  expect(owner.manager.trackedRequest(id)).toBeUndefined()

  await next.respond(turn)
  await owner.loading
  expect(owner.manager.trackedRequest(parent)).toBeDefined()
  expect(owner.manager.trackedRequest(id)?.bodyText).toBe(tracked.bodyText)
  expect(await readFile(record)).toEqual(saved)
})

test('a queued freshness rescan can adopt after a turn finishes during the prior scan', async () => {
  const f = await fixture()
  const { id, peer, tracked } = await seedPeer(f)
  const next = await f.start()
  const current = sharedKeeper(f)
  const owner = keeperFor(f.paths.storageId)
  const entered = Promise.withResolvers<void>()
  const resume = Promise.withResolvers<void>()
  const load = current.persistence.load.bind(current.persistence)
  const scanning = spyOn(current.persistence, 'load').mockImplementationOnce(
    async (...args) => {
      await load(...args)
      entered.resolve()
      await resume.promise
    },
  )
  const scan = owner.adopt()
  try {
    await entered.promise
    await next.live()
    await current.persistence.drain()
    expect(current.persistence.isCommitted(id)).toBe(false)
    const older = (
      Reflect.get(current.manager, 'targets') as Map<string, CacheKeepTarget>
    ).get(id)!

    const newest = 'Peer accepted this during the first scan'
    f.advance(5_000)
    peer.changed({
      ...tracked,
      bodyText: tracked.bodyText.replace('Hello', newest),
      policyState: { ...tracked.policyState!, lastRealRequestAt: f.now() },
    })
    await peer.drain()
    await peer.releaseClaims(() => true)
    expect(await current.persistence.reserveWarm(older)).toBe('not-owner')

    resume.resolve()
    await scan
    await owner.loading
    expect(current.manager.trackedRequest(id)?.bodyText).toContain(newest)
    expect(scanning).toHaveBeenCalledTimes(2)
  } finally {
    resume.resolve()
    await scan
    scanning.mockRestore()
  }
})

test('OC2 saves a real turn at its next warm after the old folder releases its claim', async () => {
  const f = await fixture()
  const second = await f.start()
  const id = 'ses_oc2_keep'
  const old = sharedKeeper(f)
  await second.live()
  await old.persistence.drain()
  const key = createHash('sha256').update(id).digest('hex')
  const path = join(f.disk, `${key}.json.gz`)
  const saved = async () =>
    JSON.parse(gunzipSync(await readFile(path)).toString())
  const before = (await saved()).bodyText

  const next = await f.reload()
  const current = sharedKeeper(f)
  const replacementBody = 'New real turn during the reload'
  await next.live(undefined, {
    messages: [{ role: 'user', content: replacementBody }],
  })
  await current.persistence.drain()
  expect(current.manager.trackedRequest(id)?.bodyText).toContain(
    replacementBody,
  )
  expect(current.persistence.isCommitted(id)).toBe(false)
  expect((await saved()).bodyText).toBe(before)

  const replacement = await f.reload(true, second)
  expect(current.manager.trackedRequest(id)?.bodyText).toContain(
    replacementBody,
  )
  expect((await saved()).bodyText).toBe(before)
  let atDispatch: string | undefined
  replacement.setSend(async () => {
    atDispatch = (await saved()).bodyText
    return Response.json({ usage: { cache_read_input_tokens: 1 } })
  })
  f.due()
  await f.timers.fire()
  expect(second.sent).toHaveLength(0)
  expect(replacement.sent).toHaveLength(1)
  expect(atDispatch).toContain(replacementBody)
  await current.persistence.drain()
  expect(current.persistence.isCommitted(id)).toBe(true)
  expect((await saved()).bodyText).toContain(replacementBody)
})

test.each(['count', 'bytes'] as const)(
  'OC2 keeps a real turn and restores the newest records within the %s budget',
  async (budget) => {
    const f = await fixture()
    const templateId = 'ses_template'
    await f.live(undefined, {}, templateId)
    await f.dispose()
    const recordPath = (id: string) =>
      join(f.disk, `${createHash('sha256').update(id).digest('hex')}.json.gz`)
    const templatePath = recordPath(templateId)
    const template = JSON.parse(
      gunzipSync(await readFile(templatePath)).toString(),
    )
    await rm(templatePath)
    const ids = Array.from(
      { length: CACHE_KEEP_MAX_TARGETS },
      (_, i) => `ses_released_${i}`,
    )
    for (const [i, id] of ids.entries()) {
      await writeFile(
        recordPath(id),
        gzipSync(
          JSON.stringify({
            ...template,
            id,
            cacheExpiresAt: template.cacheExpiresAt + i,
            policyState: { ...template.policyState, ownerSessionId: id },
          }),
        ),
        { mode: 0o600 },
      )
    }
    const overflow = ids[0]!
    const untouched = await readFile(recordPath(overflow))
    const entered = Promise.withResolvers<void>()
    const resume = Promise.withResolvers<void>()
    const load = CacheKeepStore.prototype.load
    const loading = spyOn(CacheKeepStore.prototype, 'load').mockImplementation(
      async function (this: CacheKeepStore, ...args) {
        entered.resolve()
        await resume.promise
        await load.apply(this, args)
      },
    )
    try {
      const next = await f.reload(false)
      await entered.promise
      const current = sharedKeeper(f)
      const liveId = 'ses_new_real_turn'
      await next.live(undefined, {}, liveId)
      expect(current.manager.trackedRequest(liveId)).toBeDefined()
      if (budget === 'bytes') {
        // Leave room for one saved body without allocating a 64 MiB prompt.
        const targets = Reflect.get(current.manager, 'targets') as Map<
          string,
          CacheKeepTarget
        >
        targets.get(liveId)!.bodyBytes =
          CACHE_KEEP_MAX_BODY_BYTES -
          Buffer.byteLength(template.bodyText, 'utf8')
      }
      const ready = Reflect.get(current, 'loading')
      resume.resolve()
      await ready
      await current.persistence.drain()
      expect(
        current.manager
          .trackedSessions()
          .map(({ id }) => id)
          .sort(),
      ).toEqual([...ids.slice(budget === 'count' ? 1 : -1), liveId].sort())
      expect(current.persistence.isCommitted(liveId)).toBe(true)
      expect(await readFile(recordPath(overflow))).toEqual(untouched)
      expect(await readdir(`${f.disk}.claims`)).not.toContain(
        `${createHash('sha256').update(overflow).digest('hex')}.claim.json`,
      )
    } finally {
      resume.resolve()
      loading.mockRestore()
    }
  },
)

test('OC2 reload neither restores nor forgets an old folder’s uncommitted body', async () => {
  const f = await fixture()
  const id = 'ses_oc2_keep'
  const old = sharedKeeper(f)
  await f.live()
  await old.persistence.drain()
  const key = createHash('sha256').update(id).digest('hex')
  const path = join(f.disk, `${key}.json.gz`)
  const saved = await readFile(path)
  const newest = 'Accepted but not committed by the old folder'
  await f.live(undefined, { messages: [{ role: 'user', content: newest }] })
  const writing = failNextRestartWrite(old.persistence)
  try {
    await f.reload()
    const current = sharedKeeper(f)
    expect(writing).toHaveBeenCalledTimes(1)
    expect(old.persistence.isCommitted(id)).toBe(false)
    expect(old.manager.trackedRequest(id)?.bodyText).toContain(newest)
    expect(current.manager.trackedRequest(id)).toBeUndefined()
    expect(await readdir(`${f.disk}.claims`)).toContain(`${key}.claim.json`)
    expect(await readFile(path)).toEqual(saved)
  } finally {
    writing.mockRestore()
  }
})

test('OC2 reload does not wait for a live old folder’s writer before saving a new turn', async () => {
  const f = await fixture()
  const second = await f.start()
  await f.dispose()
  await second.live(undefined, {
    messages: [{ role: 'user', content: 'Accepted on the old module' }],
  })
  const old = sharedKeeper(f)
  const entered = Promise.withResolvers<void>()
  const resume = Promise.withResolvers<void>()
  const drain = old.persistence.drain.bind(old.persistence)
  const draining = spyOn(old.persistence, 'drain').mockImplementation(
    async () => {
      entered.resolve()
      await resume.promise
      await drain()
    },
  )
  const drainingOld = old.persistence.drain()
  try {
    await entered.promise
    const next = await f.reload()
    const current = sharedKeeper(f)
    await next.live(
      undefined,
      { messages: [{ role: 'user', content: 'Accepted during reload' }] },
      'ses_during_reload',
    )
    await current.persistence.drain()
    expect(current.persistence.isCommitted('ses_during_reload')).toBe(true)
    expect(current.manager.trackedRequest('ses_oc2_keep')).toBeUndefined()
    resume.resolve()
    await drainingOld
    const bodies = new Map<string, string>()
    for (const name of (await readdir(f.disk)).filter((file) =>
      file.endsWith('.json.gz'),
    )) {
      const entry = JSON.parse(
        gunzipSync(await readFile(join(f.disk, name))).toString(),
      )
      bodies.set(entry.id, entry.bodyText)
    }
    expect(bodies.get('ses_oc2_keep')).toContain('Accepted on the old module')
    expect(bodies.get('ses_during_reload')).toContain('Accepted during reload')
    expect(old.manager.trackedRequest('ses_oc2_keep')?.bodyText).toContain(
      'Accepted on the old module',
    )
    expect(
      current.manager.trackedRequest('ses_during_reload')?.bodyText,
    ).toContain('Accepted during reload')
    expect(current.persistence.isCommitted('ses_during_reload')).toBe(true)
    expect(await readdir(`${f.disk}.claims`)).toContain(
      `${createHash('sha256').update('ses_during_reload').digest('hex')}.claim.json`,
    )
    expect(current.manager).not.toBe(old.manager)
  } finally {
    resume.resolve()
    await drainingOld
    draining.mockRestore()
  }
})

async function seedPeer(f: Awaited<ReturnType<typeof fixture>>) {
  const id = 'ses_oc2_keep'
  const key = createHash('sha256').update(id).digest('hex')
  const peer = new CacheKeepStore({
    storageId: f.paths.storageId,
    root: f.root,
    sessionClaims: true,
  })
  const record = join(f.disk, `${key}.json.gz`)
  const claim = join(`${f.disk}.claims`, `${key}.claim.json`)
  await f.live()
  const tracked = Reflect.get(sharedKeeper(f).manager, 'targets').get(
    id,
  ) as CacheKeepTarget
  await f.dispose()
  peer.changed(tracked)
  await peer.drain()
  cleanups.push(() => peer.releaseClaims(() => true))
  expect(peer.isCommitted(id)).toBe(true)
  return { id, peer, record, claim, tracked }
}

test.each(['eviction', 'disposal'] as const)(
  'OpenCode 2 %s does not delete a peer-owned warm record',
  async (action) => {
    const create = sourceFactory.createNativeAnthropicSource
    const entered = Promise.withResolvers<void>()
    const resume = Promise.withResolvers<void>()
    let source!: NativeSource
    const f = await fixture()
    const peer = await seedPeer(f)
    const record = await readFile(peer.record)
    const claim = await readFile(peer.claim, 'utf8')
    const capture = spyOn(
      sourceFactory,
      'createNativeAnthropicSource',
    ).mockImplementation((options) => {
      const native = create(options)
      source =
        action === 'disposal'
          ? {
              ...native,
              async chooseAccount(input) {
                entered.resolve()
                await resume.promise
                return native.chooseAccount(input)
              },
            }
          : native
      return source
    })
    cleanups.push(() => capture.mockRestore())
    const next = await f.start()
    const { persistence } = sharedKeeper(f)
    const forget = spyOn(source, 'forgetSession')
    cleanups.push(() => forget.mockRestore())
    if (action === 'eviction') {
      for (const sessionID of [
        peer.id,
        ...Array.from({ length: 512 }, (_, i) => `ses_fill_${i}`),
      ])
        await source.authorizeAccount(
          {
            sessionID,
            kind: 'primary',
            agent: 'build',
            providerID: 'anthropic',
            modelID: 'claude-sonnet-4-6',
          },
          'missing-account',
        )
    } else {
      const preparing = next.prepare().catch(() => undefined)
      try {
        await entered.promise
        await next.dispose()
      } finally {
        resume.resolve()
        await preparing
      }
    }
    expect(forget).toHaveBeenCalledWith(peer.id)
    await persistence.drain()
    expect(await readFile(peer.record)).toEqual(record)
    expect(await readFile(peer.claim, 'utf8')).toBe(claim)
  },
)

test('the OpenCode 2 host deletion event invalidates a peer-owned warm record', async () => {
  const f = await fixture()
  const peer = await seedPeer(f)
  await f.start('enrollment.json', true, peer.id)
  await sharedKeeper(f).persistence.drain()
  expect(JSON.parse(await readFile(peer.claim, 'utf8')).deleted).toBe(true)
  expect(await peer.peer.reserveWarm(peer.tracked)).toBe('not-owner')
  expect(await readdir(f.disk)).toEqual([
    `${createHash('sha256').update(peer.id).digest('hex')}.deleted`,
  ])
})

test('OpenCode 2 sends no warm in an active local window without the session claim', async () => {
  const f = await fixture()
  const peer = await seedPeer(f)
  const startHour = new Date(f.now()).getHours()
  await f.store.updateSettings((settings) => ({
    ...settings,
    cacheKeep: { enabled: true, startHour, endHour: (startHour + 3) % 24 },
  }))
  const next = await f.start()
  await next.live(undefined, {
    messages: [{ role: 'user', content: 'Local accepted turn' }],
  })
  const owner = sharedKeeper(f)
  await owner.persistence.drain()
  expect(owner.manager.trackedRequest(peer.id)).toBeDefined()
  expect(owner.persistence.isCommitted(peer.id)).toBe(false)

  f.due()
  await f.timers.fire()
  expect(next.sent).toHaveLength(0)
  expect(owner.manager.trackedRequest(peer.id)).toBeUndefined()
  expect(await peer.peer.reserveWarm(peer.tracked)).toBe(true)
})

test('OpenCode 2 reload replaces a boolean-protocol scheduler before retrying ownership', async () => {
  const f = await fixture()
  const startHour = new Date(f.now()).getHours()
  await f.store.updateSettings((settings) => ({
    ...settings,
    cacheKeep: { enabled: true, startHour, endHour: (startHour + 3) % 24 },
  }))
  await f.live()
  const owner = sharedKeeper(f)
  const manager = owner.manager
  const oldWriter = owner.persistence
  // An older scheduler treats any truthy store result as a committed count.
  const legacyReserve = spyOn(
    Reflect.get(manager, 'options'),
    'reserveWarm',
  ).mockImplementation(async (target: Readonly<CacheKeepTarget>) =>
    Boolean(await oldWriter.reserveWarm(target)),
  )
  const next = await f.reload()
  const current = sharedKeeper(f)
  expect(current.manager).not.toBe(manager)
  expect(current.persistence).not.toBe(oldWriter)
  await current.persistence.drain()
  expect(current.persistence.isCommitted('ses_oc2_keep')).toBe(true)

  const check = spyOn(
    CacheKeepClaim.prototype,
    'withCurrent',
  ).mockRejectedValue(new Error('Could not verify the claim'))
  try {
    f.due()
    await f.timers.fire()
    expect(check).toHaveBeenCalled()
    expect(next.sent).toHaveLength(0)
    expect(current.manager.trackedRequest('ses_oc2_keep')).toBeDefined()
  } finally {
    check.mockRestore()
  }

  f.advance(20_000)
  await f.timers.fire()
  expect(next.sent).toHaveLength(1)
  expect(f.sent).toHaveLength(0)
  expect(legacyReserve).not.toHaveBeenCalled()
  legacyReserve.mockRestore()
})

test('OpenCode 2 reload cancels a warm already authorizing on the older lease', async () => {
  const create = sourceFactory.createNativeAnthropicSource
  const entered = Promise.withResolvers<void>()
  const resume = Promise.withResolvers<void>()
  let paused = false
  const source = spyOn(
    sourceFactory,
    'createNativeAnthropicSource',
  ).mockImplementation((options) => {
    const native = create(options)
    return {
      ...native,
      async authorizeAccount(input, ...args) {
        if (!paused && input.sessionID === 'oc2-cachekeep:ses_oc2_keep') {
          paused = true
          entered.resolve()
          await resume.promise
        }
        return native.authorizeAccount(input, ...args)
      },
    }
  })
  cleanups.push(() => source.mockRestore())
  const f = await fixture()
  await f.live()
  const { manager } = sharedKeeper(f)
  f.due()
  const warming = f.timers.fire()
  try {
    await Promise.race([entered.promise, warming])
    expect(paused).toBe(true)
    const reloading = f.reload()
    resume.resolve()
    await warming
    const next = await reloading
    const current = sharedKeeper(f)
    expect(f.sent).toHaveLength(0)
    expect(next.sent).toHaveLength(0)
    expect(manager.trackedCount()).toBe(0)
    expect(
      Reflect.get(current.manager, 'targets').get('ses_oc2_keep'),
    ).toMatchObject({
      consecutiveFailures: 0,
      policyState: { warmsSinceLastRealRequest: 0 },
    })

    f.advance(20_000)
    await f.timers.fire()
    expect(next.sent).toHaveLength(1)
  } finally {
    resume.resolve()
    await warming
  }
})

test('OpenCode 2 persists a successor acceptance during release of an earlier claim', async () => {
  const f = await fixture()
  const owner = sharedKeeper(f)
  await f.live(undefined, {}, 'ses_release_first')
  await f.live()
  await owner.persistence.drain()
  expect(owner.persistence.isCommitted('ses_release_first')).toBe(true)
  expect(owner.persistence.isCommitted('ses_oc2_keep')).toBe(true)
  const entered = Promise.withResolvers<void>()
  const resume = Promise.withResolvers<void>()
  const release = CacheKeepClaim.prototype.release
  let first = true
  const releasing = spyOn(
    CacheKeepClaim.prototype,
    'release',
  ).mockImplementation(async function (this: CacheKeepClaim) {
    if (first) {
      first = false
      entered.resolve()
      await resume.promise
    }
    await release.call(this)
  })
  const stopping = f.dispose()
  try {
    await entered.promise
    const next = await f.start('enrollment.json', false)
    await next.live(undefined, {
      messages: [{ role: 'user', content: 'Accepted during hand-over' }],
    })
    expect(owner.manager.trackedRequest('ses_oc2_keep')?.bodyText).toContain(
      'Accepted during hand-over',
    )
    resume.resolve()
    await stopping
    await owner.persistence.drain()
    expect(owner.persistence.isCommitted('ses_oc2_keep')).toBe(true)
    const key = createHash('sha256').update('ses_oc2_keep').digest('hex')
    expect(
      gunzipSync(await readFile(join(f.disk, `${key}.json.gz`))).toString(),
    ).toContain('Accepted during hand-over')
    expect(await readdir(`${f.disk}.claims`)).toContain(`${key}.claim.json`)
  } finally {
    resume.resolve()
    await stopping
    releasing.mockRestore()
  }
})
