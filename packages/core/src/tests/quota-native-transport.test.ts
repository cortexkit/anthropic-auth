import { expect } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createTestLifetimeSuite } from './test-lifetime.ts'

const { test, gate, trackDetached, deferCleanup } = createTestLifetimeSuite()
for (const scenario of ['main', 'fallback', 'missing']) {
  test(`native quota ${scenario} transport authorizes without legacy custody flags only when a callback owns dispatch`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'native-quota-transport-'))
    deferCleanup(() => rm(root, { recursive: true, force: true }))
    const child = Bun.spawn(
      [
        process.execPath,
        fileURLToPath(
          new URL('./quota-native-transport-fixture.ts', import.meta.url),
        ),
        root,
        scenario,
      ],
      { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
    )
    const stdout = new Response(child.stdout).text()
    const stderr = new Response(child.stderr).text()
    const cancel = gate()
    const cancellation = cancel.wait.then(() => {
      if (child.exitCode === null) child.kill()
    })
    trackDetached(cancellation)
    try {
      const [exit, output, error] = await Promise.all([
        child.exited,
        stdout,
        stderr,
      ])
      expect(exit).toBe(0)
      expect(error).toBe('')
      expect(JSON.parse(output)).toEqual({
        fetched: scenario !== 'missing',
        tokenless: scenario !== 'missing',
        calls:
          scenario === 'missing'
            ? []
            : [
                {
                  kind: scenario,
                  accountId: `synthetic-${scenario}`,
                  accessToken: '',
                },
              ],
      })
    } finally {
      cancel.open()
      await cancellation
      await Promise.allSettled([child.exited, stdout, stderr])
    }
  })
}
