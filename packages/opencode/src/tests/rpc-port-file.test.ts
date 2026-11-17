import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { discoverPortFile, writePortFile } from '../rpc/port-file'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'aa-rpc-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

for (const phase of ['write', 'rename'] as const) {
  test(`writer recreates a folder removed once before the temp ${phase}`, async () => {
    let attempts = 0
    let removed = false
    const delays: number[] = []
    const path = await writePortFile(
      dir,
      { port: 5123, token: 'test-only', pid: 123 },
      {
        mkdir: async (path) => {
          attempts++
          await mkdir(path, { recursive: true })
        },
        write: async (path, text) => {
          if (phase === 'write' && !removed) {
            removed = true
            await rm(dir, { recursive: true })
          }
          await writeFile(path, text, { encoding: 'utf8', mode: 0o600 })
        },
        rename: async (from, to) => {
          if (phase === 'rename' && !removed) {
            removed = true
            await rm(dir, { recursive: true })
          }
          await rename(from, to)
        },
        sleep: async (ms) => {
          delays.push(ms)
        },
      },
    )
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({
      pid: 123,
      port: 5123,
      token: 'test-only',
    })
    expect(attempts).toBe(2)
    expect(delays).toEqual([25])
  })

  test(`writer gives up after five persistent temp ${phase} ENOENT failures`, async () => {
    const error = Object.assign(new Error('missing directory'), {
      code: 'ENOENT',
    })
    let attempts = 0
    let failures = 0
    const delays: number[] = []
    await expect(
      writePortFile(
        dir,
        { port: 5123, token: 'test-only', pid: 123 },
        {
          mkdir: async (path) => {
            attempts++
            await mkdir(path, { recursive: true })
          },
          write: async (path, text) => {
            if (phase === 'write') {
              failures++
              throw error
            }
            await writeFile(path, text, { encoding: 'utf8', mode: 0o600 })
          },
          rename: async () => {
            failures++
            throw error
          },
          sleep: async (ms) => {
            delays.push(ms)
          },
        },
      ),
    ).rejects.toBe(error)
    expect(attempts).toBe(5)
    expect(failures).toBe(5)
    expect(delays).toEqual([25, 25, 25, 25])
  })

  test(`writer throws a non-ENOENT temp ${phase} error immediately`, async () => {
    const error = Object.assign(new Error('denied'), { code: 'EACCES' })
    let attempts = 0
    const delays: number[] = []
    await expect(
      writePortFile(
        dir,
        { port: 5123, token: 'test-only', pid: 123 },
        {
          mkdir: async (path) => {
            attempts++
            await mkdir(path, { recursive: true })
          },
          write: async (path, text) => {
            if (phase === 'write') throw error
            await writeFile(path, text, { encoding: 'utf8', mode: 0o600 })
          },
          rename: async () => {
            throw error
          },
          sleep: async (ms) => {
            delays.push(ms)
          },
        },
      ),
    ).rejects.toBe(error)
    expect(attempts).toBe(1)
    expect(delays).toEqual([])
  })
}

describe('port-file', () => {
  test('writePortFile then discover returns the entry for a live pid', async () => {
    await writePortFile(dir, { port: 5123, token: 'tok', pid: process.pid })
    const found = await discoverPortFile(dir)
    expect(found?.port).toBe(5123)
    expect(found?.token).toBe('tok')
  })

  test('discover ignores dead pids', async () => {
    await writeFile(
      join(dir, 'port-99999999.json'),
      JSON.stringify({ port: 1, token: 'x', pid: 99999999, startedAt: 1 }),
      'utf8',
    )
    expect(await discoverPortFile(dir)).toBeNull()
  })

  test('discover picks the newest startedAt among live entries', async () => {
    await writePortFile(dir, { port: 1, token: 'a', pid: process.pid })
    await new Promise((r) => setTimeout(r, 5))
    await writePortFile(dir, { port: 2, token: 'b', pid: process.pid })
    expect((await discoverPortFile(dir))?.port).toBe(2)
  })
})

describe('writer stamp', () => {
  // discoverPortFile reads only port, pid and startedAt, as in 2.2.x, so the
  // stamp a 2.3.0 writer adds is invisible to it.
  test('a written port file carries a writer stamp and is still discovered', async () => {
    const path = await writePortFile(dir, {
      port: 5124,
      token: 'tok',
      pid: process.pid,
    })
    const stored = JSON.parse(await readFile(path, 'utf8'))
    expect(stored.writer).toMatchObject({ protocol: 1 })
    expect(typeof stored.writer.release).toBe('string')
    expect(await discoverPortFile(dir)).toMatchObject({
      port: 5124,
      token: 'tok',
      pid: process.pid,
    })
  })
})

describe('pid matching', () => {
  test('expectedPid matching live entries returns most recent among matches', async () => {
    await writePortFile(dir, { port: 1, token: 'a', pid: process.pid })
    await new Promise((r) => setTimeout(r, 5))
    await writePortFile(dir, { port: 2, token: 'b', pid: process.pid })
    await new Promise((r) => setTimeout(r, 5))
    await writePortFile(dir, { port: 3, token: 'c', pid: process.pid })

    const found = await discoverPortFile(dir, process.pid)
    // All three match the expectedPid, picks the most recent among them
    expect(found?.port).toBe(3)
    expect(found?.token).toBe('c')
  })

  test('expectedPid matching none falls back to most recent overall', async () => {
    await writePortFile(dir, { port: 1, token: 'a', pid: process.pid })
    await new Promise((r) => setTimeout(r, 5))
    await writePortFile(dir, { port: 2, token: 'b', pid: process.pid })

    const found = await discoverPortFile(dir, 99999999)
    // No pid matches 99999999, falls back to most recent among all live
    expect(found?.port).toBe(2)
    expect(found?.token).toBe('b')
  })

  test('no expectedPid returns most recent among all live', async () => {
    await writePortFile(dir, { port: 1, token: 'a', pid: process.pid })
    await new Promise((r) => setTimeout(r, 5))
    await writePortFile(dir, { port: 2, token: 'b', pid: process.pid })

    const found = await discoverPortFile(dir)
    expect(found?.port).toBe(2)
    expect(found?.token).toBe('b')
  })

  test('pid match wins over newer non-matching entry', async () => {
    // Write a matching entry first (older)
    await writePortFile(dir, { port: 10, token: 'match', pid: process.pid })
    await new Promise((r) => setTimeout(r, 5))
    // Write a dead entry (newer but filtered out by pidAlive)
    await writeFile(
      join(dir, 'port-88888888.json'),
      JSON.stringify({
        port: 20,
        token: 'dead',
        pid: 88888888,
        startedAt: Date.now(),
      }),
      'utf8',
    )

    const found = await discoverPortFile(dir, process.pid)
    // Only the matching entry survives pidAlive
    expect(found?.port).toBe(10)
    expect(found?.token).toBe('match')
  })
})

test('pid match wins over newer competing live entry', async () => {
  const child = Bun.spawn(['sleep', '60'])
  try {
    await writePortFile(dir, { port: 100, token: 'older-a', pid: child.pid })
    await new Promise((r) => setTimeout(r, 5))
    await writePortFile(dir, {
      port: 200,
      token: 'newer-b',
      pid: process.pid,
    })

    // process.pid match → returns its entry even though it is newer
    const byMain = await discoverPortFile(dir, process.pid)
    expect(byMain?.port).toBe(200)
    expect(byMain?.token).toBe('newer-b')

    // child.pid match → returns its entry even though it is OLDER
    // Pre-fix code would return the newer process.pid entry here
    const byChild = await discoverPortFile(dir, child.pid)
    expect(byChild?.port).toBe(100)
    expect(byChild?.token).toBe('older-a')
  } finally {
    child.kill()
  }
})
