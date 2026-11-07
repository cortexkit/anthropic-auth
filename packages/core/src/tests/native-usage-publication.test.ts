import { expect } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  __setLogTestSink,
  getLogLevel,
  type LogTestRecord,
  setLogLevel,
} from '../logger.ts'
import { NativeCustodyError } from '../native-custody.ts'
import { NativeRuntimeError, updateNativeRuntime } from '../native-runtime.ts'
import {
  classifySafeErrorForLog,
  createNativeUsagePublisher,
  usagePublicationRefusalIsFatal,
} from '../native-usage-publication.ts'
import { createTestLifetimeSuite } from './test-lifetime.ts'

const { test, gate, deferCleanup } = createTestLifetimeSuite()

test('usage publication classification retains the custody and runtime refusal policy', () => {
  for (const code of [
    'closed',
    'route-unavailable',
    'not-enrolled',
    'roster-busy',
    'invalid-order',
  ] as const)
    expect(usagePublicationRefusalIsFatal(new NativeCustodyError(code))).toBe(
      true,
    )
  for (const code of [
    'publication-refused',
    'unsafe-runtime',
    'invalid-runtime',
  ] as const)
    expect(usagePublicationRefusalIsFatal(new NativeRuntimeError(code))).toBe(
      true,
    )
  for (const error of [
    new NativeRuntimeError('runtime-io'),
    new NativeRuntimeError('runtime-conflict'),
    new Error('timeout'),
    'refused',
    null,
  ])
    expect(usagePublicationRefusalIsFatal(error)).toBe(false)
})

test('safe error classification exposes known network, HTTP and native refusal codes only', () => {
  expect(
    classifySafeErrorForLog(
      Object.assign(new TypeError('socket failed: private text'), {
        code: 'ECONNRESET',
      }),
    ),
  ).toEqual({ name: 'TypeError', code: 'ECONNRESET' })
  expect(
    classifySafeErrorForLog(
      Object.assign(new Error('provider body'), { status: 503 }),
    ),
  ).toEqual({ name: 'Error', code: 'HTTP_503' })
  expect(
    classifySafeErrorForLog(new NativeCustodyError('route-unavailable')),
  ).toEqual({ name: 'NativeCustodyError', code: 'route-unavailable' })
  expect(
    classifySafeErrorForLog(new NativeCustodyError('invalid-order')),
  ).toEqual({ name: 'NativeCustodyError', code: 'invalid-order' })
  expect(
    classifySafeErrorForLog(
      Object.assign(new Error('credential secret'), {
        name: '/private/name',
        code: 'secret-code',
      }),
    ),
  ).toEqual({ name: 'unknown', code: 'unknown' })
})

test('advisory usage publication starts after handoff and drains every write', async () => {
  const publisher = createNativeUsagePublisher('native-auth')
  const entered = gate()
  const release = gate()
  let started = false
  let finished = 0
  publisher.publish(async () => {
    started = true
    entered.open()
    await release.wait
    finished++
  })
  publisher.publish(async () => {
    finished++
  })
  await Promise.resolve()
  expect(started).toBe(false)
  await entered.wait
  let drained = false
  const draining = publisher.drain().then(() => {
    drained = true
  })
  await Promise.resolve()
  expect(drained).toBe(false)
  release.open()
  await draining
  expect(finished).toBe(2)
})

test('observed quota publication keeps its join until the already-started write settles', async () => {
  const publisher = createNativeUsagePublisher('native-auth')
  const release = gate()
  let joined = false
  let drained = false
  const write = release.wait.then(() => 'saved')
  const joining = publisher.observe(write).then(() => {
    joined = true
  })
  const draining = publisher.drain().then(() => {
    drained = true
  })
  await Promise.resolve()
  expect(joined).toBe(false)
  expect(drained).toBe(false)
  release.open()
  await joining
  await draining
  expect(joined).toBe(true)
  expect(drained).toBe(true)
})

test('shutdown cancellation logs one content-free count for all dropped writes', async () => {
  const records: LogTestRecord[] = []
  const previous = getLogLevel()
  setLogLevel('debug')
  __setLogTestSink((record) => records.push(record))
  deferCleanup(() => {
    __setLogTestSink(null)
    setLogLevel(previous)
  })
  const publisher = createNativeUsagePublisher('native-auth')
  for (let i = 0; i < 3; i++)
    publisher.publish(
      (signal) =>
        new Promise((_, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), {
            once: true,
          })
        }),
    )
  await Promise.all([publisher.close(), publisher.close()])
  expect(records).toEqual([
    {
      level: 'debug',
      channel: 'native-auth',
      message: 'Account usage publications dropped at shutdown',
      payload: { count: 3 },
    },
  ])
})

test('a nonterminal drain does not poison later publications', async () => {
  const publisher = createNativeUsagePublisher('quota')
  const release = gate()
  publisher.publish(async () => {
    await release.wait
  })
  const draining = publisher.drain()
  const timer = setTimeout(() => release.open(), 1_100)
  deferCleanup(() => clearTimeout(timer))
  await draining
  expect(publisher.signal.aborted).toBe(false)
  let saved = false
  publisher.publish(async (signal) => {
    signal.throwIfAborted()
    saved = true
  })
  await publisher.drain()
  expect(saved).toBe(true)
})

test('shutdown cancellation still joins a runtime write that already acquired its lock', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'advisory-acquired-'))
  deferCleanup(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, 'runtime.json')
  const storageId = 'a'.repeat(64)
  const publisher = createNativeUsagePublisher('native-auth')
  const acquired = gate()
  let finished = false
  publisher.publish(async (signal) => {
    await updateNativeRuntime(path, storageId, (state) => state, {
      signal,
      beforePublish: async () => {
        acquired.open()
        await new Promise<void>((resolve) =>
          signal.addEventListener('abort', () => resolve(), { once: true }),
        )
      },
    })
    finished = true
  })
  await acquired.wait
  await publisher.close()
  expect(publisher.signal.aborted).toBe(true)
  expect(finished).toBe(true)
  expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
    version: 1,
    storageId,
    accounts: {},
  })
})

test('every publication rejection is absorbed with one fixed closed diagnostic', async () => {
  const records: LogTestRecord[] = []
  const previous = getLogLevel()
  setLogLevel('debug')
  __setLogTestSink((record) => records.push(record))
  deferCleanup(() => {
    __setLogTestSink(null)
    setLogLevel(previous)
  })
  const publisher = createNativeUsagePublisher('native-auth')
  const errors = [
    new NativeCustodyError('route-unavailable'),
    new NativeRuntimeError('publication-refused'),
    new NativeRuntimeError('unsafe-runtime'),
    new NativeRuntimeError('invalid-runtime'),
    new NativeRuntimeError('runtime-io'),
    new NativeRuntimeError('runtime-conflict'),
    Object.assign(new Error('/private/credential secret'), {
      name: '/private/name',
      code: 'secret-code',
    }),
    Object.assign(new Error('/private/roster lock timeout'), {
      name: 'LockContentionError',
    }),
    'credential secret',
  ]
  for (const error of errors)
    publisher.publish(async () => {
      throw error
    })
  await publisher.drain()
  expect(records).toHaveLength(errors.length)
  expect(records.map((record) => record.level)).toEqual([
    'error',
    'error',
    'error',
    'error',
    'warn',
    'warn',
    'warn',
    'warn',
    'warn',
  ])
  for (const record of records) {
    expect(record.message).toBe('Account usage publication unavailable')
    expect(Object.keys(record.payload!)).toEqual(['name', 'code'])
  }
  expect(records[6]?.payload).toEqual({ name: 'unknown', code: 'unknown' })
  expect(records[7]?.payload).toEqual({
    name: 'LockContentionError',
    code: 'unknown',
  })
  expect(JSON.stringify(records)).not.toContain('private')
  expect(JSON.stringify(records)).not.toContain('secret')
})
