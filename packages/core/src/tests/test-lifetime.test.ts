import { afterAll, afterEach, expect, test as registerTest } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  createTestLifetimeSuite,
  type TestGate,
  TestLifetime,
} from './test-lifetime.ts'

const childMode = process.env.NATIVE_TEST_LIFETIME_CHILD
const childName = 'controlled fixture deadline'

if (childMode) {
  if (childMode !== 'managed' && childMode !== 'unsafe')
    throw new Error('Invalid lifetime fixture mode')
  const root = process.env.NATIVE_TEST_LIFETIME_ROOT
  if (!root) throw new Error('Missing lifetime fixture root')
  const leaf = join(root, 'fixture.txt')
  const events: string[] = []
  const result = {
    finalRead: 'pending',
    detachedRead: 'pending',
    bodyDone: false,
    detachedDone: false,
    cleanupAfterBody: false,
    cleanupAfterDetached: false,
    lateGateOpened: false,
  }
  let bodyFinished!: () => void
  let detachedFinished!: () => void
  const bodyDone = new Promise<void>((resolve) => {
    bodyFinished = resolve
  })
  const detachedDone = new Promise<void>((resolve) => {
    detachedFinished = resolve
  })
  const managed =
    childMode === 'managed' ? createTestLifetimeSuite() : undefined
  let closing = false
  const unsafeGates = new Set<() => void>()
  const gate = (): TestGate => {
    if (managed) return managed.gate()
    let resolve!: () => void
    const wait = new Promise<void>((done) => {
      resolve = done
    })
    const open = () => {
      unsafeGates.delete(open)
      resolve()
    }
    if (closing) open()
    else unsafeGates.add(open)
    return { wait, open }
  }
  const cleanup = async () => {
    events.push('cleanup-start')
    result.cleanupAfterBody = result.bodyDone
    result.cleanupAfterDetached = result.detachedDone
    await rm(root, { recursive: true, force: true })
    events.push('cleanup-end')
  }
  const inspectLeaf = async () => {
    try {
      return await readFile(leaf, 'utf8')
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
        return 'ENOENT'
      throw error
    }
  }
  if (!managed)
    afterEach(async () => {
      // Remove fixture.txt before unblocking the test body. The resumed body and
      // its detached task must read ENOENT to demonstrate this unsafe order.
      await cleanup()
      closing = true
      for (const open of [...unsafeGates]) open()
    })
  const test = managed?.test ?? registerTest
  test(childName, async () => {
    events.push('body-start')
    if (managed) managed.deferCleanup(cleanup)
    const initial = gate()
    await initial.wait
    const late = gate()
    let automaticallyOpened = false
    void late.wait.then(() => {
      automaticallyOpened = true
    })
    await Promise.resolve()
    result.lateGateOpened = automaticallyOpened
    // If teardown did not open the late gate, open it manually so the test can
    // finish. Only teardown's automatic opening satisfies the assertion.
    if (!result.lateGateOpened) late.open()
    await late.wait
    const detached = (async () => {
      try {
        await new Promise<void>((resolve) => setTimeout(resolve, 25))
        result.detachedRead = await inspectLeaf()
        events.push('detached-read')
      } finally {
        result.detachedDone = true
        detachedFinished()
      }
    })()
    managed?.trackDetached(detached)
    try {
      result.finalRead = await inspectLeaf()
      events.push('final-read')
    } finally {
      result.bodyDone = true
      events.push('body-end')
      bodyFinished()
    }
    // The 100 ms deadline makes Bun start teardown while this body still waits
    // on its initial test gate.
  }, 100)
  afterAll(async () => {
    await bodyDone
    await detachedDone
    console.log(
      `LIFETIME_CHILD_RESULT ${JSON.stringify({ ...result, events })}`,
    )
  })
} else {
  const { test, deferCleanup } = createTestLifetimeSuite()

  test('lifetime finish waits for the entire body including final reads', async () => {
    const lifetime = new TestLifetime()
    const gate = lifetime.gate()
    const events: string[] = []
    lifetime.deferCleanup(() => {
      events.push('cleanup')
    })
    const body = lifetime.runBody(async () => {
      await gate.wait
      await Promise.resolve()
      events.push('final-read')
      await Promise.resolve()
      events.push('body-end')
    })
    await lifetime.finish()
    await body
    expect(events).toEqual(['final-read', 'body-end', 'cleanup'])
  })

  test('lifetime drains detached calls added by other detached calls before cleanup', async () => {
    const lifetime = new TestLifetime()
    const gate = lifetime.gate()
    const events: string[] = []
    let completed!: () => void
    const done = new Promise<void>((resolve) => {
      completed = resolve
    })
    lifetime.deferCleanup(() => {
      events.push('cleanup')
    })
    const body = lifetime.runBody(() => {
      lifetime.trackDetached(
        (async () => {
          await gate.wait
          lifetime.trackDetached(
            (async () => {
              await new Promise<void>((resolve) => setTimeout(resolve, 10))
              events.push('detached-final-read')
              completed()
            })(),
          )
        })(),
      )
    })
    await lifetime.finish()
    await body
    await done
    expect(events).toEqual(['detached-final-read', 'cleanup'])
  })

  test('lifetime opens gates created after teardown starts', async () => {
    const lifetime = new TestLifetime()
    const initial = lifetime.gate()
    let opened = false
    let automaticallyOpened = false
    const body = lifetime.runBody(async () => {
      await initial.wait
      const late = lifetime.gate()
      void late.wait.then(() => {
        opened = true
      })
      await Promise.resolve()
      automaticallyOpened = opened
      if (!opened) late.open()
      await late.wait
    })
    await lifetime.finish()
    await body
    expect(automaticallyOpened).toBe(true)
  })

  test('lifetime includes late cleanup registration and cleans only once', async () => {
    const lifetime = new TestLifetime()
    const initial = lifetime.gate()
    let cleanups = 0
    const body = lifetime.runBody(async () => {
      await initial.wait
      lifetime.deferCleanup(() => {
        cleanups++
      })
    })
    const first = lifetime.finish()
    expect(lifetime.finish()).toBe(first)
    await first
    await body
    expect(cleanups).toBe(1)
    expect(() => lifetime.deferCleanup(() => {})).toThrow('closed')
  })

  test('lifetime reports detached failures after draining and still runs every cleanup', async () => {
    const lifetime = new TestLifetime()
    const failure = new Error('detached assertion failed')
    const cleanupFailure = new Error('cleanup failed')
    const events: string[] = []
    lifetime.trackDetached(Promise.reject(failure))
    lifetime.deferCleanup(() => {
      events.push('first')
      throw cleanupFailure
    })
    lifetime.deferCleanup(() => {
      events.push('second')
    })
    await expect(lifetime.finish()).rejects.toMatchObject({
      errors: [failure, cleanupFailure],
    })
    expect(events).toEqual(['first', 'second'])
  })

  test('lifetime preserves the original body failure while waiting before cleanup', async () => {
    const lifetime = new TestLifetime()
    const failure = new Error('body assertion failed')
    let cleaned = false
    lifetime.deferCleanup(() => {
      cleaned = true
    })
    const body = lifetime.runBody(() => {
      throw failure
    })
    await expect(body).rejects.toBe(failure)
    await lifetime.finish()
    expect(cleaned).toBe(true)
  })

  for (const mode of ['unsafe', 'managed'] as const) {
    test(`real Bun child timeout ${mode === 'managed' ? 'waits for final reads and detached work before cleanup' : 'exposes the former premature cleanup order'}`, async () => {
      const parent = fileURLToPath(
        new URL(
          '../../../../node_modules/.cache/native-journal-lifetimes/',
          import.meta.url,
        ),
      )
      await mkdir(parent, { recursive: true })
      const root = await mkdtemp(join(parent, `${mode}-`))
      deferCleanup(() => rm(root, { recursive: true, force: true }))
      await writeFile(join(root, 'fixture.txt'), 'fixture-alive')
      const child = Bun.spawn(
        [
          process.execPath,
          'test',
          fileURLToPath(import.meta.url),
          '--test-name-pattern',
          `^${childName}$`,
        ],
        {
          cwd: fileURLToPath(new URL('../../', import.meta.url)),
          env: {
            ...process.env,
            NATIVE_TEST_LIFETIME_CHILD: mode,
            NATIVE_TEST_LIFETIME_ROOT: root,
          },
          stdout: 'pipe',
          stderr: 'pipe',
        },
      )
      const stdout = await new Response(child.stdout).text()
      const stderr = await new Response(child.stderr).text()
      const exit = await child.exited
      const logRoot = fileURLToPath(
        new URL(
          '../../../../node_modules/.cache/native-journal-diagnostics/',
          import.meta.url,
        ),
      )
      await mkdir(logRoot, { recursive: true })
      const prefix = join(logRoot, `lifetime-${basename(root)}`)
      await writeFile(`${prefix}.stdout`, stdout)
      await writeFile(`${prefix}.stderr`, stderr)
      console.log(`Lifetime child logs: ${prefix}.{stdout,stderr}`)
      expect(exit, stderr).toBe(1)
      expect(stderr).toContain(`(fail) ${childName}`)
      expect(stderr).toContain('this test timed out after 100ms')
      expect(stderr).toContain('\n 1 fail\n')
      expect(stderr).not.toContain('Unhandled error')
      const line = stdout
        .split('\n')
        .find((value) => value.startsWith('LIFETIME_CHILD_RESULT '))
      expect(line).toBeDefined()
      const result = JSON.parse(line!.slice('LIFETIME_CHILD_RESULT '.length))
      expect(result).toMatchObject({
        finalRead: mode === 'managed' ? 'fixture-alive' : 'ENOENT',
        detachedRead: mode === 'managed' ? 'fixture-alive' : 'ENOENT',
        bodyDone: true,
        detachedDone: true,
        lateGateOpened: true,
        cleanupAfterBody: mode === 'managed',
        cleanupAfterDetached: mode === 'managed',
      })
      if (mode === 'managed') {
        expect(result.events.indexOf('cleanup-start')).toBeGreaterThan(
          result.events.indexOf('body-end'),
        )
        expect(result.events.indexOf('cleanup-start')).toBeGreaterThan(
          result.events.indexOf('detached-read'),
        )
      } else {
        expect(result.events.indexOf('cleanup-end')).toBeLessThan(
          result.events.indexOf('final-read'),
        )
      }
    })
  }
}
