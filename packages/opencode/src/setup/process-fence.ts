import { defaultCommandRunner } from './command-runner.ts'
import type { CommandRunner, ProcessFence } from './types.ts'

const HOST_PATTERN =
  /(?:^|[/\\])(opencode|litecode|opencode2|pi)(?:\.exe)?(?=$|\s|")/i

export class ProcessInspectionError extends Error {
  readonly code = 'process-inspection-failed'
  constructor() {
    super('Process inspection failed; setup cannot prove hosts are stopped.')
    this.name = 'ProcessInspectionError'
  }
}

export class ProcessFenceViolationError extends Error {
  readonly activeHosts: Array<{ pid: number; command: string }>
  constructor(activeHosts: Array<{ pid: number; command: string }>) {
    // Process arguments can contain bearer material. Retain only the recognized
    // executable name in diagnostics, never the full command or runner stderr.
    const safeHosts = activeHosts.map((host) => ({
      pid: host.pid,
      command: HOST_PATTERN.exec(host.command)?.[1] ?? 'host',
    }))
    const list = safeHosts
      .map((h) => `  - PID ${h.pid}: ${h.command}`)
      .join('\n')
    super(
      `OpenCode or Pi processes are currently running:\n${list}\n\n` +
        `Please quit all OpenCode, LiteCode, and Pi processes before running setup.`,
    )
    this.activeHosts = safeHosts
    this.name = 'ProcessFenceViolationError'
  }
}

export function createProcessFence(
  runner: CommandRunner = defaultCommandRunner,
  options: { platform?: NodeJS.Platform } = {},
): ProcessFence {
  const isWin = (options.platform ?? process.platform) === 'win32'
  return {
    async listRunningHosts(
      env?: Record<string, string | undefined>,
    ): Promise<Array<{ pid: number; command: string }>> {
      const cmd = isWin ? 'tasklist' : 'ps'
      const args = isWin ? ['/fo', 'csv', '/nh'] : ['-eo', 'pid,command']
      let result: Awaited<ReturnType<CommandRunner['run']>>
      try {
        result = await runner.run(cmd, args, { env })
      } catch {
        throw new ProcessInspectionError()
      }

      if (result.exitCode !== 0) {
        throw new ProcessInspectionError()
      }

      const lines = result.stdout.split(/\r?\n/)
      const running: Array<{ pid: number; command: string }> = []
      const currentPid = process.pid

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue

        let pid: number
        let command: string

        if (isWin) {
          // CSV format: "Image Name","PID","Session Name","Session#","Mem Usage"
          const parts = trimmed.split(',').map((p) => p.replace(/^"|"$/g, ''))
          if (parts.length < 2) throw new ProcessInspectionError()
          command = parts[0] ?? ''
          pid = Number(parts[1])
        } else {
          const match = /^(\d+)\s+(.+)$/.exec(trimmed)
          if (!match) {
            if (/^PID\s+COMMAND$/i.test(trimmed)) continue
            throw new ProcessInspectionError()
          }
          pid = Number(match[1])
          command = match[2] ?? ''
        }

        if (!Number.isInteger(pid) || pid < 0)
          throw new ProcessInspectionError()
        if (pid === currentPid) continue
        if (HOST_PATTERN.test(command)) {
          running.push({ pid, command })
        }
      }

      return running
    },
  }
}

export const defaultProcessFence = createProcessFence(defaultCommandRunner)

export async function assertHostsStopped(
  fence: ProcessFence = defaultProcessFence,
): Promise<void> {
  const active = await fence.listRunningHosts()
  if (active.length > 0) {
    throw new ProcessFenceViolationError(active)
  }
}
