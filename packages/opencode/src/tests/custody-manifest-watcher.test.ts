import { describe, expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import type { FSWatcher, watch } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { adoptCustodyManifestWatcher } from '../custody-manifest-watcher.ts'

describe('custody manifest watcher registry', () => {
  test('shares one directory watcher and releases listeners by lease', async () => {
    let watchCalls = 0
    let closeCalls = 0
    let fire: ((event: string, filename: string | null) => void) | undefined
    const watcher = Object.assign(new EventEmitter(), {
      close() {
        closeCalls += 1
      },
    }) as FSWatcher
    const watchImpl = ((_path, _options, listener) => {
      watchCalls += 1
      fire = listener as typeof fire
      return watcher
    }) as typeof watch
    let firstCalls = 0
    let secondCalls = 0

    const first = adoptCustodyManifestWatcher(
      '/tmp/custody-watch/handles.json',
      () => {
        firstCalls += 1
      },
      { watchImpl, debounceMs: 1 },
    )
    const second = adoptCustodyManifestWatcher(
      '/tmp/custody-watch/handles.json',
      () => {
        secondCalls += 1
      },
      { watchImpl, debounceMs: 1 },
    )

    expect(watchCalls).toBe(1)
    await Bun.sleep(5)
    expect([firstCalls, secondCalls]).toEqual([1, 1])

    fire?.('rename', 'unrelated.json')
    await Bun.sleep(5)
    expect([firstCalls, secondCalls]).toEqual([1, 1])

    fire?.('rename', 'handles.json')
    await Bun.sleep(5)
    expect([firstCalls, secondCalls]).toEqual([2, 2])

    first.release()
    fire?.('change', 'handles.json')
    await Bun.sleep(5)
    expect([firstCalls, secondCalls]).toEqual([2, 3])
    expect(closeCalls).toBe(0)

    second.release()
    expect(closeCalls).toBe(1)
    second.release()
    expect(closeCalls).toBe(1)
  })

  test('treats an undefined filename as a directory-level change', async () => {
    let fire:
      | ((event: string, filename: string | undefined) => void)
      | undefined
    const watcher = Object.assign(new EventEmitter(), {
      close() {},
    }) as FSWatcher
    const watchImpl = ((_path, _options, listener) => {
      fire = listener as typeof fire
      return watcher
    }) as typeof watch
    let calls = 0
    const adoption = adoptCustodyManifestWatcher(
      '/tmp/custody-watch/undefined-filename.json',
      () => {
        calls += 1
      },
      { watchImpl, debounceMs: 1 },
    )

    try {
      await Bun.sleep(5)
      const baseline = calls
      // Node may omit the filename entirely; the watcher must reconcile
      // rather than throw on the missing value.
      expect(() => fire?.('change', undefined)).not.toThrow()
      await Bun.sleep(5)
      expect(calls).toBeGreaterThan(baseline)
    } finally {
      adoption.release()
    }
  })

  test('polling observes replacement when fs.watch is unavailable', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'custody-watch-'))
    const path = join(directory, 'handles.json')
    await writeFile(path, '{}')
    const errors: unknown[] = []
    let tick: (() => void) | undefined
    let calls = 0
    const pollTimer = { unref() {} } as unknown as ReturnType<typeof setTimeout>
    const adoption = adoptCustodyManifestWatcher(
      path,
      () => {
        calls += 1
      },
      {
        watchImpl: (() => {
          throw new Error('watch unavailable')
        }) as typeof watch,
        pollSetTimeoutImpl: ((handler: () => void) => {
          tick = handler
          return pollTimer
        }) as unknown as typeof setTimeout,
        pollClearTimeoutImpl: (() => {}) as typeof clearTimeout,
        debounceMs: 1,
        onError: (error) => errors.push(error),
      },
    )

    try {
      await Bun.sleep(10)
      const baseline = calls
      await writeFile(path, '{"version":1}')
      tick?.()
      await Bun.sleep(10)

      expect(errors).toHaveLength(1)
      expect(String(errors[0])).toContain('watch unavailable')
      expect(calls).toBeGreaterThan(baseline)
    } finally {
      adoption.release()
      await rm(directory, { recursive: true, force: true })
    }
  })
})
