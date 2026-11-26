import { expect, spyOn } from 'bun:test'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as locks from '@cortexkit/common-auth/fs'
import type { ProviderAccountUuid } from '../claude-code.ts'
import { getHostClaustrumEnrollmentPaths } from '../claustrum-enrollment.ts'
import {
  createNativeAccountRuntime,
  type NativeAccountRuntimeOptions,
} from '../native-account-runtime.ts'
import { readNativeEnrollmentMode } from '../native-enrollment-authority.ts'
import { nativeQuotaCodec } from '../native-quota-codec.ts'
import * as writer from '../native-runtime.ts'
import { resolveNativePoolPaths } from '../pool-paths.ts'
import { createNativePoolStore } from '../pool-store.ts'
import { initializeNativeTestAuthority } from './native-authority-fixture.ts'
import { createTestLifetimeSuite } from './test-lifetime.ts'

const { test, gate, trackDetached, deferCleanup } = createTestLifetimeSuite()
const originalOpen = fs.open
const originalRead = fs.readFile
const uuid = '11111111-2222-4333-8444-555555555555' as ProviderAccountUuid
const now = 1_000_000

async function fixture(
  beforePoolWrite?: NativeAccountRuntimeOptions['beforePoolWrite'],
  local?: NativeAccountRuntimeOptions['local'],
) {
  const root = await fs.mkdtemp(join(tmpdir(), 'enrollment-parent-'))
  deferCleanup(() => fs.rm(root, { recursive: true, force: true }))
  const paths = await resolveNativePoolPaths(
    join(root, 'anthropic-auth.json'),
    join(root, 'anthropic-auth-state.json'),
  )
  await initializeNativeTestAuthority(paths)
  const store = createNativePoolStore({
    paths,
    quota: nativeQuotaCodec,
    now: () => now,
  })
  await store.initialize()
  await store.add({
    id: 'main-row',
    identity: uuid,
    credential: {
      type: 'oauth',
      access: 'sk-ant-oat01-parent-synthetic',
      refresh: 'synthetic-refresh',
      expires: now + 3_600_000,
    },
  })
  await store.add({
    id: 'api-row',
    credential: {
      type: 'api',
      apiKey: 'synthetic-api-key',
      baseURL: 'https://api.example.invalid',
    },
  })
  await store.updateSettings((settings) => {
    settings.mainAccountId = 'main-row'
  })
  const env = {
    OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE: join(
      root,
      'enrollment.json',
    ),
  }
  const runtime = createNativeAccountRuntime({
    paths,
    host: 'opencode',
    vault: {
      env,
      connect: async () => {
        throw new Error('Synthetic vault client unavailable')
      },
    },
    beforePoolWrite,
    local: {
      now: () => now,
      resolveIdentity: async () => ({
        deviceId: 'synthetic-device',
        sessionId: 'synthetic-session',
        accountUuid: uuid,
      }),
      ...local,
    },
  })
  deferCleanup(() => runtime.close())
  return { paths, store, runtime, env }
}
type Fixture = Awaited<ReturnType<typeof fixture>>

async function bytes(f: Fixture) {
  const files = [
    f.paths.config,
    f.paths.state,
    f.paths.runtime,
    f.paths.journal,
  ]
  return Promise.all(
    files.map(async (path) => {
      try {
        return await originalRead(path)
      } catch (error) {
        if (
          error instanceof Error &&
          'code' in error &&
          error.code === 'ENOENT'
        )
          return null
        throw error
      }
    }),
  )
}

function holdRead(predicate: (path: string) => boolean) {
  const entered = gate(),
    release = gate()
  let reached = false
  async function hold(path: unknown) {
    if (!reached && predicate(String(path))) {
      reached = true
      entered.open()
      await release.wait
    }
  }
  const interceptedRead = new Proxy(originalRead, {
    apply(target, receiver, args) {
      const pending: ReturnType<typeof originalRead> = Reflect.apply(
        target,
        receiver,
        args,
      )
      return pending.then(async (value) => {
        await hold(args[0])
        return value
      })
    },
  })
  const readSpy = spyOn(fs, 'readFile').mockImplementation(interceptedRead)
  const openSpy = spyOn(fs, 'open').mockImplementation(
    async (path, flags, mode) => {
      const handle = await originalOpen(path, flags, mode)
      try {
        await hold(path)
        return handle
      } catch (error) {
        await handle.close()
        throw error
      }
    },
  )
  deferCleanup(() => {
    readSpy.mockRestore()
    openSpy.mockRestore()
  })
  return { entered, release, reached: () => reached }
}

async function settleAtBoundary<T>(
  f: Fixture,
  held: ReturnType<typeof holdRead>,
  operation: () => Promise<T>,
  enroll: boolean,
) {
  const result = operation().then(
    (value) => ({ kind: 'returned' as const, value }),
    (error) => ({ kind: 'threw' as const, error: error as unknown }),
  )
  trackDetached(result)
  try {
    const first = await Promise.race([
      held.entered.wait.then(() => 'held'),
      result.then(() => 'early'),
    ])
    expect(first).toBe('held')
    expect(held.reached()).toBe(true)
    const before = await bytes(f)
    if (enroll) {
      const path = getHostClaustrumEnrollmentPaths('opencode', f.env).tokenPath
      await fs.writeFile(
        path,
        JSON.stringify({ token: '01'.repeat(32), token_generation: 1 }),
        { mode: 0o600 },
      )
      expect(await readNativeEnrollmentMode('opencode', f.env)).toBe(
        'claustrum',
      )
    }
    held.release.open()
    const outcome = await result
    const after = await bytes(f)
    return { outcome, before, after }
  } finally {
    held.release.open()
    await result
  }
}

for (const enroll of [false, true]) {
  test(`local OAuth final journal read rechecks custody / enroll=${enroll}`, async () => {
    const f = await fixture()
    const warm = await f.runtime.authorizeLocal('main')
    expect(warm.status).toBe('usable')
    let reads = 0,
      armed = false
    const read = f.runtime.read.bind(f.runtime)
    const readSpy = spyOn(f.runtime, 'read').mockImplementation(async () => {
      if (++reads === 2) armed = true
      return read()
    })
    deferCleanup(() => readSpy.mockRestore())
    const held = holdRead((path) => armed && path === f.paths.journal)
    const r = await settleAtBoundary(
      f,
      held,
      () => f.runtime.authorizeLocal('main'),
      enroll,
    )
    expect(r.outcome.kind).toBe('returned')
    if (r.outcome.kind !== 'returned') throw r.outcome.error
    expect(r.outcome.value.status).toBe(enroll ? 'refused' : 'usable')
    expect(r.after).toEqual(r.before)
  })
  test(`local API final journal read rechecks custody / enroll=${enroll}`, async () => {
    const f = await fixture()
    let journals = 0
    const held = holdRead(
      (path) => path === f.paths.journal && ++journals === 2,
    )
    const r = await settleAtBoundary(
      f,
      held,
      () => f.runtime.authorizeApi('api-row'),
      enroll,
    )
    expect(r.outcome.kind).toBe(enroll ? 'threw' : 'returned')
    if (!enroll && r.outcome.kind === 'returned')
      expect(r.outcome.value.apiKey).toBe('synthetic-api-key')
    expect(r.after).toEqual(r.before)
  })
  test(`local settings final journal read rechecks custody / enroll=${enroll}`, async () => {
    let armed = false
    const f = await fixture(async () => {
      armed = true
    })
    const held = holdRead((path) => armed && path === f.paths.journal)
    const r = await settleAtBoundary(
      f,
      held,
      () =>
        f.runtime.updateSettings((settings) => ({
          ...settings,
          cache1h: { enabled: true },
        })),
      enroll,
    )
    expect(r.outcome.kind).toBe(enroll ? 'threw' : 'returned')
    if (enroll) expect(r.after).toEqual(r.before)
    else expect(r.after).not.toEqual(r.before)
  })
  for (const operation of ['metadata', 'Prime'] as const) {
    test(`local ${operation} binding read rechecks custody / enroll=${enroll}`, async () => {
      const f = await fixture()
      const warm = await f.runtime.authorizeLocal('main')
      if (warm.status !== 'usable') throw new Error('Invalid healthy fixture')
      let armed = false
      const update = writer.updateNativeRuntimeMetadata
      const writerSpy = spyOn(
        writer,
        'updateNativeRuntimeMetadata',
      ).mockImplementation((path, storageId, change, hooks) =>
        update(path, storageId, change, {
          ...hooks,
          beforeRename: async () => {
            armed = true
            try {
              await hooks?.beforeRename?.()
            } finally {
              armed = false
            }
          },
        }),
      )
      deferCleanup(() => writerSpy.mockRestore())
      const held = holdRead((path) => armed && path === f.paths.config)
      const r = await settleAtBoundary(
        f,
        held,
        () =>
          operation === 'metadata'
            ? f.runtime.publishLocal(warm.subject, { lastUsed: now + 100 })
            : f.runtime.incrementPrimeUsage('main', warm.subject, {
                inputTokens: 7,
              }),
        enroll,
      )
      expect(r.outcome.kind).toBe(enroll ? 'threw' : 'returned')
      if (r.outcome.kind === 'threw')
        expect(r.outcome.error).toMatchObject({ code: 'publication-refused' })
      else expect(r.outcome.value).toBe(true)
      if (enroll) expect(r.after).toEqual(r.before)
      else expect(r.after).not.toEqual(r.before)
    })
  }
}

for (const enroll of [false, true]) {
  test(`local identity lookup cannot publish validation after enrollment / enroll=${enroll}`, async () => {
    const entered = gate(),
      release = gate()
    let reached = false
    const f = await fixture(undefined, {
      resolveIdentity: async () => {
        reached = true
        entered.open()
        await release.wait
        return {
          deviceId: 'synthetic-device',
          sessionId: 'synthetic-session',
          accountUuid: uuid,
        }
      },
    })
    const r = await settleAtBoundary(
      f,
      { entered, release, reached: () => reached },
      () => f.runtime.authorizeLocal('main'),
      enroll,
    )
    expect(r.outcome.kind).toBe('returned')
    if (r.outcome.kind !== 'returned') throw r.outcome.error
    expect(r.outcome.value.status).toBe(enroll ? 'refused' : 'usable')
    if (enroll) expect(r.after).toEqual(r.before)
    else expect(r.after).not.toEqual(r.before)
  })
  test(`consumed local refresh remains durable without renewed local use after enrollment / enroll=${enroll}`, async () => {
    const entered = gate(),
      release = gate()
    let reached = false,
      refreshes = 0,
      sends = 0
    const successor = 'sk-ant-oat01-parent-consumed-successor'
    const f = await fixture(undefined, {
      refreshToken: async () => {
        refreshes++
        reached = true
        entered.open()
        await release.wait
        return {
          access: refreshes === 1 ? successor : `${successor}-next`,
          refresh:
            refreshes === 1
              ? 'synthetic-consumed-refresh'
              : 'synthetic-next-refresh',
          expires: now + 28_800_000,
          expiresIn: 28_800,
        }
      },
    })
    expect((await f.runtime.authorizeLocal('main')).status).toBe('usable')
    const r = await settleAtBoundary(
      f,
      { entered, release, reached: () => reached },
      () =>
        f.runtime.authorizeLocal('main', {
          rejectedAccessToken: 'sk-ant-oat01-parent-synthetic',
        }),
      enroll,
    )
    expect(r.outcome.kind).toBe('returned')
    if (r.outcome.kind !== 'returned') throw r.outcome.error
    expect(r.outcome.value.status).toBe(enroll ? 'refused' : 'usable')
    const pool = await f.store.read()
    expect(pool.status).toBe('ready')
    if (pool.status !== 'ready') throw new Error('Missing committed successor')
    const row = pool.rows.find((row) => row.id === 'main-row')
    expect(row?.credential?.type).toBe('oauth')
    if (row?.credential?.type !== 'oauth')
      throw new Error('Missing OAuth successor')
    expect(row.credential.access).toBe(successor)
    expect(row.credential.refresh).toBe('synthetic-consumed-refresh')
    expect(refreshes).toBe(1)
    const again = await f.runtime.authorizeLocal('main', {
      rejectedAccessToken: successor,
    })
    expect(again.status).toBe(enroll ? 'refused' : 'usable')
    const transport: typeof fetch = Object.assign(
      async () => {
        sends++
        return Response.json({
          five_hour: { utilization: 10, resets_at: null },
          seven_day: { utilization: 10, resets_at: null },
        })
      },
      { preconnect() {} },
    )
    const poll = await f.runtime.fetchQuota('main', transport).then(
      (value) => ({ kind: 'returned' as const, value }),
      (error) => ({ kind: 'threw' as const, error: error as unknown }),
    )
    expect(poll.kind).toBe(enroll ? 'threw' : 'returned')
    expect(sends).toBe(enroll ? 0 : 1)
    expect(refreshes).toBe(enroll ? 1 : 2)
  })
}

for (const enroll of [false, true]) {
  test(`local metadata runtime-lease await rechecks custody / enroll=${enroll}`, async () => {
    const f = await fixture()
    const warm = await f.runtime.authorizeLocal('main')
    if (warm.status !== 'usable') throw new Error('Invalid healthy fixture')
    const entered = gate(),
      release = gate()
    let armed = false,
      reached = false
    const update = writer.updateNativeRuntimeMetadata
    const updateSpy = spyOn(
      writer,
      'updateNativeRuntimeMetadata',
    ).mockImplementation((path, storageId, change, hooks) =>
      update(path, storageId, change, {
        ...hooks,
        beforeRename: async () => {
          await hooks?.beforeRename?.()
          armed = true
        },
      }),
    )
    deferCleanup(() => updateSpy.mockRestore())
    type Lease = Parameters<Parameters<typeof locks.withLock>[2]>[0]
    const intercepted = new Proxy(locks.withLock, {
      apply(target, receiver, args) {
        if (args[0] !== f.paths.runtime)
          return Reflect.apply(target, receiver, args)
        const callback: unknown = args[2]
        if (typeof callback !== 'function')
          throw new Error('Missing runtime lock callback')
        const run = async (lease: Lease) => {
          const observed = new Proxy(lease, {
            get(target, key, receiver) {
              if (key !== 'assertOwned')
                return Reflect.get(target, key, receiver)
              return async () => {
                await target.assertOwned()
                if (armed && !reached) {
                  reached = true
                  entered.open()
                  await release.wait
                }
              }
            },
          })
          const result: unknown = Reflect.apply(callback, undefined, [observed])
          return result
        }
        return Reflect.apply(target, receiver, [args[0], args[1], run])
      },
    })
    const lockSpy = spyOn(locks, 'withLock').mockImplementation(intercepted)
    deferCleanup(() => lockSpy.mockRestore())
    const r = await settleAtBoundary(
      f,
      { entered, release, reached: () => reached },
      () => f.runtime.publishLocal(warm.subject, { lastUsed: now + 100 }),
      enroll,
    )
    expect(r.outcome.kind).toBe(enroll ? 'threw' : 'returned')
    if (r.outcome.kind === 'threw')
      expect(r.outcome.error).toMatchObject({ code: 'publication-refused' })
    else expect(r.outcome.value).toBe(true)
    if (enroll) expect(r.after).toEqual(r.before)
    else expect(r.after).not.toEqual(r.before)
  })
}
