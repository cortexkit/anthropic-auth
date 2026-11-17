import { expect } from 'bun:test'
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTestLifetimeSuite } from '../../../core/src/tests/test-lifetime'
import { startRpcServer } from '../rpc/rpc-server'
import { type RpcSweepOptions, sweepRpcState } from '../rpc/sweep'

const { test, deferCleanup } = createTestLifetimeSuite()
const NOW = Date.UTC(2035, 0, 2)
const WRITTEN = NOW - 60_000
const hash = (n: number) => n.toString(16).padStart(16, '0')
const gone = () => {
  throw Object.assign(new Error('dead'), { code: 'ESRCH' })
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'rpc-sweep-'))
  deferCleanup(() => rm(root, { recursive: true, force: true }))
  const active = join(root, hash(0))
  await mkdir(active)
  const options: RpcSweepOptions = {
    root,
    now: () => NOW,
    probe: gone,
    processStartedAtMs: async () => null,
    state: {},
  }
  return { root, active, options }
}

async function record(
  dir: string,
  pid: number,
  fields: Record<string, unknown> = {},
) {
  await mkdir(dir, { recursive: true })
  const path = join(dir, `port-${pid}.json`)
  await writeFile(
    path,
    JSON.stringify({
      pid,
      port: 1234,
      token: 'test-only',
      startedAt: WRITTEN,
      ...fields,
    }),
  )
  return path
}

async function exists(path: string) {
  return lstat(path).then(
    () => true,
    () => false,
  )
}

async function eventuallyAbsent(path: string) {
  for (let i = 0; i < 200 && (await exists(path)); i++) await Bun.sleep(5)
  expect(await exists(path)).toBe(false)
}

test('full sweep keeps fresh empty folders and removes only folders older than sixty seconds', async () => {
  const { root, active, options } = await fixture()
  const fresh = join(root, hash(1))
  const boundary = join(root, hash(2))
  const old = join(root, hash(3))
  for (const [dir, age] of [
    [fresh, 0],
    [boundary, 60_000],
    [old, 60_001],
  ] as const) {
    await mkdir(dir)
    await utimes(dir, new Date(NOW - age), new Date(NOW - age))
  }
  await sweepRpcState(active, options)
  expect(await exists(fresh)).toBe(true)
  expect(await exists(boundary)).toBe(true)
  expect(await exists(old)).toBe(false)
})

test('sweep removes dead pid files across many sibling folders and removes only empty managed folders', async () => {
  const { root, active, options } = await fixture()
  const dirs = Array.from({ length: 80 }, (_, i) => join(root, hash(i + 1)))
  for (const dir of dirs) await record(dir, 123)
  const nonempty = join(root, hash(81))
  await record(nonempty, 123)
  await writeFile(join(nonempty, 'keep.txt'), 'keep')
  await sweepRpcState(active, options)
  for (const dir of dirs) expect(await exists(dir)).toBe(false)
  expect(await exists(join(nonempty, 'port-123.json'))).toBe(false)
  expect(await readFile(join(nonempty, 'keep.txt'), 'utf8')).toBe('keep')
  expect(await exists(active)).toBe(false)
})

test('live, EPERM and uncheckable pids are kept', async () => {
  const { active, options } = await fixture()
  const paths = await Promise.all(
    [11, 12, 13].map((pid) => record(active, pid)),
  )
  options.probe = (pid) => {
    if (pid === 12) throw Object.assign(new Error('denied'), { code: 'EPERM' })
    if (pid === 13) throw Object.assign(new Error('unknown'), { code: 'EIO' })
  }
  await sweepRpcState(active, options)
  for (const path of paths) expect(await exists(path)).toBe(true)
})

test('parsed pid mismatches and nonmatching filenames are never removed, even for dead pids', async () => {
  const { active, options } = await fixture()
  const mismatch = await record(active, 123, { pid: 456 })
  const missing = join(active, 'port-124.json')
  await writeFile(missing, '{}')
  const odd = join(active, 'port-123.json.backup')
  await writeFile(odd, '{}')
  const malformed = join(active, 'port-125.json')
  await writeFile(malformed, '{bad-json')
  await sweepRpcState(active, options)
  for (const path of [mismatch, missing, odd])
    expect(await exists(path)).toBe(true)
  expect(await exists(malformed)).toBe(false)
})

test('nonmatching directories, symlinks and anything outside the root are untouched', async () => {
  const { root, active, options } = await fixture()
  const outside = await mkdtemp(join(tmpdir(), 'rpc-sweep-outside-'))
  deferCleanup(() => rm(outside, { recursive: true, force: true }))
  const external = await record(outside, 123)
  const odd = await record(join(root, 'not-a-project-hash'), 123)
  const upper = await record(join(root, '0123456789ABCDEF'), 123)
  await symlink(outside, join(root, hash(2)), 'dir')
  await symlink(external, join(active, 'port-123.json'))
  await sweepRpcState(active, options)
  for (const path of [external, odd, upper, join(active, 'port-123.json')])
    expect(await exists(path)).toBe(true)
  await sweepRpcState(outside, { ...options, state: {} })
  expect(await exists(external)).toBe(true)
})

test('temp files are removed only for a dead writer pid, not a dead target pid', async () => {
  const { active, options } = await fixture()
  const deadWriter = join(active, 'port-11.json.22.tmp')
  const liveWriter = join(active, 'port-22.json.11.tmp')
  const deniedWriter = join(active, 'port-22.json.33.tmp')
  const unknownName = join(active, 'port-22.json.uuid.tmp')
  for (const path of [deadWriter, liveWriter, deniedWriter, unknownName])
    await writeFile(path, '')
  options.probe = (pid) => {
    if (pid === 22) gone()
    if (pid === 33) throw Object.assign(new Error('denied'), { code: 'EPERM' })
  }
  options.processStartedAtMs = async () => NOW
  await sweepRpcState(active, options)
  expect(await exists(deadWriter)).toBe(false)
  for (const path of [liveWriter, deniedWriter, unknownName])
    expect(await exists(path)).toBe(true)
})

for (const start of [
  WRITTEN - 1_000,
  WRITTEN + 1_000,
  WRITTEN + 2_000,
  WRITTEN + 2_001,
  null,
]) {
  test(`live pid process start ${start} is removed only beyond the two-second margin`, async () => {
    const { active, options } = await fixture()
    const path = await record(active, 123)
    await sweepRpcState(active, {
      ...options,
      probe: () => {},
      processStartedAtMs: async () => start,
    })
    expect(await exists(path)).toBe(start !== WRITTEN + 2_001)
  })
}

test('missing write times and malformed bytes use mtime to prove pid reuse', async () => {
  const { active, options } = await fixture()
  const missing = join(active, 'port-123.json')
  const malformed = join(active, 'port-124.json')
  await writeFile(missing, JSON.stringify({ pid: 123 }))
  await writeFile(malformed, '{bad-json')
  for (const path of [missing, malformed])
    await utimes(path, new Date(WRITTEN), new Date(WRITTEN))
  await sweepRpcState(active, {
    ...options,
    probe: () => {},
    processStartedAtMs: async () => WRITTEN + 2_001,
  })
  expect(await exists(missing)).toBe(false)
  expect(await exists(malformed)).toBe(false)
})

test('explicit invalid timestamps, live malformed bytes and unknown starts are kept', async () => {
  const { active, options } = await fixture()
  const paths = await Promise.all(
    ['invalid', -1, NOW + 1].map((startedAt, i) =>
      record(active, 123 + i, { startedAt }),
    ),
  )
  const malformed = join(active, 'port-126.json')
  await writeFile(malformed, '{bad-json')
  await sweepRpcState(active, {
    ...options,
    probe: () => {},
    processStartedAtMs: async () => null,
  })
  for (const path of [...paths, malformed])
    expect(await exists(path)).toBe(true)
  await sweepRpcState(active, {
    ...options,
    state: {},
    probe: () => {},
    processStartedAtMs: async () => WRITTEN + 20_000,
  })
  for (const path of paths) expect(await exists(path)).toBe(true)
})

test('a port file replaced during a process-start lookup is kept', async () => {
  const { active, options } = await fixture()
  const path = await record(active, 123)
  await sweepRpcState(active, {
    ...options,
    probe: () => {},
    processStartedAtMs: async () => {
      await record(active, 123, { startedAt: NOW, token: 'new-writer' })
      return WRITTEN + 10_000
    },
  })
  expect(JSON.parse(await readFile(path, 'utf8')).token).toBe('new-writer')
})

test('server start removes a live but provably reused pid', async () => {
  const { active, options } = await fixture()
  const path = await record(active, 123)
  const server = await startRpcServer({
    dir: active,
    drain: () => [],
    sweep: {
      ...options,
      probe: () => {},
      processStartedAtMs: async (pid) => (pid === 123 ? WRITTEN + 2_001 : null),
    },
  })
  deferCleanup(server.stop)
  await eventuallyAbsent(path)
})

test('successive server starts throttle sibling sweeps process-wide but always clean the active folder', async () => {
  const { root, active, options } = await fixture()
  let now = NOW
  const sibling = join(root, hash(1))
  const old = await record(sibling, 123)
  // Omit state to exercise the process-wide throttle across starts.
  const sweep = {
    ...options,
    state: undefined,
    now: () => now,
    probe: (pid: number) => {
      if (pid !== process.pid) gone()
    },
  }
  const first = await startRpcServer({ dir: active, drain: () => [], sweep })
  deferCleanup(first.stop)
  await eventuallyAbsent(old)
  const missed = await record(sibling, 123)
  const secondDir = join(root, hash(2))
  const ownOld = await record(secondDir, 123)
  now += 59_999
  const second = await startRpcServer({
    dir: secondDir,
    drain: () => [],
    sweep,
  })
  deferCleanup(second.stop)
  await eventuallyAbsent(ownOld)
  expect(await exists(missed)).toBe(true)
  expect(await exists(join(secondDir, `port-${process.pid}.json`))).toBe(true)
  now += 1
  const third = await startRpcServer({
    dir: join(root, hash(3)),
    drain: () => [],
    sweep,
  })
  deferCleanup(third.stop)
  await eventuallyAbsent(missed)
  await second.stop()
  expect(await exists(join(secondDir, `port-${process.pid}.json`))).toBe(false)
})

test('server start is detached from a slow sweep', async () => {
  const { active, options } = await fixture()
  const path = await record(active, 123)
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  deferCleanup(() => release())
  const server = await startRpcServer({
    dir: active,
    drain: () => [],
    sweep: {
      ...options,
      probe: () => {},
      processStartedAtMs: async () => {
        await gate
        return WRITTEN + 10_000
      },
    },
  })
  deferCleanup(server.stop)
  expect((await fetch(`http://127.0.0.1:${server.port}/health`)).status).toBe(
    200,
  )
  expect(await exists(path)).toBe(true)
  release()
  await eventuallyAbsent(path)
})

test('a sweep error logs once without leaking errors or preventing server start', async () => {
  const { active, options } = await fixture()
  const logs: string[] = []
  const server = await startRpcServer({
    dir: active,
    drain: () => [],
    sweep: {
      ...options,
      now: () => {
        throw new Error('/private/path/token')
      },
      log: (name) => {
        logs.push(name)
      },
    },
  })
  deferCleanup(server.stop)
  expect((await fetch(`http://127.0.0.1:${server.port}/health`)).status).toBe(
    200,
  )
  expect(logs).toEqual(['.'])
})
