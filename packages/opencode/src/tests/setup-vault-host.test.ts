import { afterEach, expect, mock, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { VAULT_HOST_CONNECT_REFUSAL } from '@cortexkit/anthropic-auth-core'
import { runSetupCommand } from '../setup/command.ts'
import { defaultCommandRunner } from '../setup/command-runner.ts'

afterEach(() => {
  delete process.env.CORTEXKIT_VAULT_HOST
})

for (const argv of [
  [],
  ['--claustrum', '--yes'],
  ['--login'],
  ['--restore-legacy'],
]) {
  test(`hosted setup refuses ${argv.join(' ') || 'default'} before detection or any setup callback`, async () => {
    let output = ''
    process.env.CORTEXKIT_VAULT_HOST = 'thalamus'
    const stream = new PassThrough()
    stream.on('data', (chunk) => {
      output += chunk.toString()
    })
    const run = mock(async () => {
      throw new Error('child forbidden')
    })
    const fence = mock(async () => {
      throw new Error('detection forbidden')
    })
    const local = mock(async () => {
      throw new Error('local sign-in forbidden')
    })
    const preflight = mock(async () => {
      throw new Error('enrollment forbidden')
    })
    expect(
      await runSetupCommand(argv, {
        env: { CORTEXKIT_VAULT_HOST: 'thalamus' },
        terminal: {
          input: Object.assign(new PassThrough(), {
            setRawMode() {
              return this
            },
          }),
          output: stream,
          signals: new EventEmitter(),
        },
        runner: { run },
        fence: { listRunningHosts: fence },
        localLogin: local,
        vaultPreflight: preflight,
      }),
    ).toBe(1)
    expect(output.trim()).toBe(VAULT_HOST_CONNECT_REFUSAL)
    for (const callback of [run, fence, local, preflight])
      expect(callback).not.toHaveBeenCalled()
  })
}

test('setup children never inherit hosted authority without an in-process relay', async () => {
  process.env.CORTEXKIT_VAULT_HOST = 'thalamus'
  try {
    const result = await defaultCommandRunner.run(
      process.execPath,
      [
        '-e',
        'process.stdout.write(process.env.CORTEXKIT_VAULT_HOST ?? "absent")',
      ],
      { env: { CORTEXKIT_VAULT_HOST: 'thalamus' } },
    )
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('absent')
  } finally {
    delete process.env.CORTEXKIT_VAULT_HOST
  }
})
