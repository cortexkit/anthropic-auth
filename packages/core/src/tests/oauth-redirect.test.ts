import { expect } from 'bun:test'
import { fileURLToPath } from 'node:url'
import { createTestLifetimeSuite } from './test-lifetime.ts'

const { test, gate, trackDetached } = createTestLifetimeSuite()
for (const operation of ['refresh', 'exchange', 'bootstrap']) {
  for (const status of [200, 302, 307]) {
    test(`${operation} ${status === 200 ? 'accepts the original endpoint' : `refuses HTTP ${status} redirects before sending to the next endpoint`}`, async () => {
      const child = Bun.spawn(
        [
          process.execPath,
          fileURLToPath(
            new URL('./oauth-redirect-fixture.ts', import.meta.url),
          ),
          operation,
          String(status),
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
          operation,
          status,
          accepted: status === 200,
          entries: 1,
          redirected: 0,
        })
      } finally {
        // Cancellation terminates the child before teardown joins its body.
        // Drain each pipe and the process before releasing its fixture lifetime.
        cancel.open()
        await cancellation
        await Promise.allSettled([child.exited, stdout, stderr])
      }
    })
  }
}
