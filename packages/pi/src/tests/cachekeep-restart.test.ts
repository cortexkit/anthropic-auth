import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('Pi session_start warms an idle session after a real process restart without a new request', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-extension-restart-'))
  try {
    const env = {
      ...process.env,
      PI_ANTHROPIC_AUTH_FILE: join(root, 'anthropic-auth.json'),
      PI_CODING_AGENT_DIR: root,
      OPENCODE_ANTHROPIC_AUTH_STATE_FILE: join(
        root,
        'anthropic-auth-state.json',
      ),
      XDG_DATA_HOME: join(root, 'data'),
      PI_ANTHROPIC_AUTH_CACHEKEEP_REGISTRY_DIR: join(root, 'registry'),
      PI_RESTART_CLOCK: String(Date.now()),
      OPENCODE_ANTHROPIC_AUTH_LOG_LEVEL: 'debug',
    }
    const run = async (phase: string) => {
      const child = Bun.spawn(
        [
          process.execPath,
          new URL('./fixtures/pi-cachekeep-process.ts', import.meta.url)
            .pathname,
          phase,
        ],
        {
          env,
          stdout: 'pipe',
          stderr: 'pipe',
        },
      )
      const [stdout, stderr, exit] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      if (exit !== 0)
        throw new Error(`Pi ${phase} exited ${exit}: ${stderr}\n${stdout}`)
      const line = stdout
        .split('\n')
        .find((row) => row.startsWith('PI_RESTART_RESULT '))
      if (!line)
        throw new Error(`Missing Pi ${phase} result: ${stderr}\n${stdout}`)
      const result = JSON.parse(line.slice('PI_RESTART_RESULT '.length)) as {
        live: number
        warm: number
      }
      if (phase === 'resume' && result.warm !== 1)
        throw new Error(`Pi resumed with ${result.warm} warms: ${stderr}`)
      return result
    }
    expect(await run('seed')).toEqual({ live: 1, warm: 0 })
    expect(await run('resume')).toEqual({ live: 0, warm: 1 })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 20_000)
