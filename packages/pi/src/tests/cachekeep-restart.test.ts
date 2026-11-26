import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

async function withProcesses(
  run: (spawn: (phase: string) => ReturnType<typeof start>) => Promise<void>,
) {
  function start(phase: string, env: NodeJS.ProcessEnv) {
    const opened = Promise.withResolvers<{ tracked: boolean }>()
    const child = Bun.spawn(
      [
        process.execPath,
        new URL('./fixtures/pi-cachekeep-process.ts', import.meta.url).pathname,
        phase,
      ],
      {
        env,
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
        ipc(message) {
          opened.resolve(message as { tracked: boolean })
        },
      },
    )
    const result = Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]).then(([stdout, stderr, exit]) => {
      if (exit !== 0)
        throw new Error(`Pi ${phase} exited ${exit}: ${stderr}\n${stdout}`)
      const line = stdout
        .split('\n')
        .find((row) => row.startsWith('PI_RESTART_RESULT '))
      if (!line)
        throw new Error(`Missing Pi ${phase} result: ${stderr}\n${stdout}`)
      const value = JSON.parse(line.slice('PI_RESTART_RESULT '.length)) as {
        live: number
        warm: number
      }
      if (
        ['resume', 'round-resume', 'takeover'].includes(phase) &&
        value.warm !== 1
      )
        throw new Error(`Pi ${phase} sent ${value.warm} warms: ${stderr}`)
      return value
    })
    void result.catch(() => {})
    return { child, opened: opened.promise, result }
  }
  const root = await mkdtemp(join(tmpdir(), 'pi-extension-restart-'))
  const children: Array<ReturnType<typeof start>> = []
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
      PI_RESTART_CLOCK: String(Date.now()),
      OPENCODE_ANTHROPIC_AUTH_LOG_LEVEL: 'debug',
    }
    await run((phase) => {
      const child = start(phase, {
        ...env,
        PI_ANTHROPIC_AUTH_CACHEKEEP_REGISTRY_DIR: join(
          root,
          `registry-${phase}`,
        ),
      })
      children.push(child)
      return child
    })
  } finally {
    for (const { child } of children) {
      if (child.exitCode === null) child.kill()
      await child.exited
    }
    await rm(root, { recursive: true, force: true })
  }
}

async function restart(seedPhase: 'seed' | 'locked') {
  await withProcesses(async (spawn) => {
    expect(await spawn(seedPhase).result).toEqual({ live: 1, warm: 0 })
    expect(await spawn('resume').result).toEqual({ live: 0, warm: 1 })
  })
}

test(
  'Pi session_start warms an idle session after a real process restart without a new request',
  () => restart('seed'),
  20_000,
)

test('Pi signs only the requested-model warm during a round and after restart', async () => {
  await withProcesses(async (spawn) => {
    expect(await spawn('round-seed').result).toEqual({ live: 4, warm: 1 })
    expect(await spawn('round-resume').result).toEqual({ live: 0, warm: 1 })
  })
}, 20_000)

test('Pi round activity renews the warm budget and an idle end advances backoff', async () => {
  await withProcesses(async (spawn) => {
    expect(await spawn('round-idle').result).toEqual({ live: 8, warm: 2 })
  })
}, 20_000)

test('Pi stops warming when the OAuth account changes mid-round', async () => {
  await withProcesses(async (spawn) => {
    expect(await spawn('round-account').result).toEqual({ live: 4, warm: 1 })
  })
}, 20_000)

test('Pi drops only the refused retry thinking from source replay after restart', async () => {
  await withProcesses(async (spawn) => {
    expect(await spawn('thinking-seed').result).toEqual({ live: 2, warm: 0 })
    expect(await spawn('thinking-resume').result).toEqual({ live: 1, warm: 0 })
  })
}, 20_000)

test(
  'Pi startup, turn and accepted response proceed while the keep-warm lock is held',
  () => restart('locked'),
  20_000,
)

test('Pi gives an idle restored session to a real turn in another process', async () => {
  await withProcesses(async (spawn) => {
    expect(await spawn('seed').result).toEqual({ live: 1, warm: 0 })
    const idle = spawn('idle-owner')
    expect(await Promise.race([idle.opened, idle.result])).toEqual({
      tracked: true,
    })
    expect(await spawn('takeover').result).toEqual({ live: 1, warm: 1 })
    await idle.child.stdin.end()
    expect(await idle.result).toEqual({ live: 0, warm: 0 })
  })
}, 20_000)
