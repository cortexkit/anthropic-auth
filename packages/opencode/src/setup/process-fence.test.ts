import { expect, test } from 'bun:test'
import {
  assertHostsStopped,
  createProcessFence,
  ProcessFenceViolationError,
} from './process-fence.ts'

test('portable Windows process fence recognizes executable suffixes and blocks stopped-host preflight', async () => {
  const opencodePid = process.pid + 100_000
  const piPid = opencodePid + 1
  const calls: Array<[string, string[]]> = []
  const fence = createProcessFence(
    {
      run: async (command, args) => {
        calls.push([command, args])
        return {
          exitCode: 0,
          stdout: `"opencode.exe","${opencodePid}","Console","1","1 K"\n"pi.exe","${piPid}","Console","1","1 K"`,
          stderr: '',
        }
      },
    },
    { platform: 'win32' },
  )
  expect(await fence.listRunningHosts()).toEqual([
    { pid: opencodePid, command: 'opencode.exe' },
    { pid: piPid, command: 'pi.exe' },
  ])
  await expect(assertHostsStopped(fence)).rejects.toBeInstanceOf(
    ProcessFenceViolationError,
  )
  expect(calls[0]).toEqual(['tasklist', ['/fo', 'csv', '/nh']])
})

test('process fence fails closed on inspection failure and malformed output without echoing stderr', async () => {
  for (const output of [
    { exitCode: 1, stdout: '', stderr: 'synthetic-bearer-in-stderr' },
    { exitCode: 0, stdout: 'unexpected process output', stderr: '' },
  ]) {
    const fence = createProcessFence(
      { run: async () => output },
      { platform: 'linux' },
    )
    let caught: unknown
    try {
      await fence.listRunningHosts()
    } catch (error) {
      caught = error
    }
    expect(caught).toMatchObject({ code: 'process-inspection-failed' })
    expect(String(caught)).not.toContain('synthetic-bearer')
  }
})

test('active process diagnostics never serialize command arguments', () => {
  const error = new ProcessFenceViolationError([
    { pid: 123, command: '/synthetic/opencode --key synthetic-command-secret' },
  ])
  expect(error.message).toContain('PID 123: opencode')
  expect(error.message).not.toContain('synthetic-command-secret')
  expect(JSON.stringify(error)).not.toContain('synthetic-command-secret')
})
