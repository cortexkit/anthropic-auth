import { type ExecFileException, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { CommandRunner } from './types.ts'

const pExecFile = promisify(execFile)

export const defaultCommandRunner: CommandRunner = {
  async run(command, args, options = {}) {
    try {
      const childEnv = { ...process.env, ...options.env }
      // Children have no in-process relay accessor and must not assume host authority.
      delete childEnv.CORTEXKIT_VAULT_HOST
      const { stdout, stderr } = await pExecFile(command, args, {
        env: childEnv,
        timeout: options.timeoutMs ?? 15_000,
        maxBuffer: 10 * 1024 * 1024,
      })
      return {
        exitCode: 0,
        stdout: typeof stdout === 'string' ? stdout : String(stdout),
        stderr: typeof stderr === 'string' ? stderr : String(stderr),
      }
    } catch (error: unknown) {
      const err = error as ExecFileException & {
        stdout?: unknown
        stderr?: unknown
      }
      return {
        exitCode: typeof err?.code === 'number' ? err.code : 1,
        signal: typeof err?.signal === 'string' ? err.signal : null,
        ...(typeof err?.syscall === 'string' &&
        (err.syscall === 'spawn' || err.syscall.startsWith('spawn '))
          ? { spawnError: true }
          : {}),
        stdout:
          typeof err?.stdout === 'string'
            ? err.stdout
            : err?.stdout != null
              ? String(err.stdout)
              : '',
        stderr:
          typeof err?.stderr === 'string'
            ? err.stderr
            : err?.stderr != null
              ? String(err.stderr)
              : String(err?.message ?? error),
      }
    }
  },
}
