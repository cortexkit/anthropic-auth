import { types } from 'node:util'

export type HarnessKind = 'opencode' | 'pi'

export interface SharedSetupRunnerEntry {
  /**
   * Only the setup CLI sets this: the shared runner listed processes immediately
   * before calling the adapter. Standalone callers must keep the entry check.
   */
  sharedRunnerCheckedEntry?: true
}

const setupRefusals = new WeakMap<object, string>()

export function setupRefusalMessage(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null
    ? setupRefusals.get(error)
    : undefined
}

/** runSetup prints failures from its own stopped-host checks; provider callbacks need a displayable refusal for their separate process checks. */
export function setupProcessInspectionMessage(
  error: unknown,
): string | undefined {
  if (!error || typeof error !== 'object' || types.isProxy(error))
    return undefined
  if (
    Object.getOwnPropertyDescriptor(error, 'name')?.value ===
      'ProcessInspectionError' &&
    Object.getOwnPropertyDescriptor(error, 'code')?.value ===
      'process-inspection-failed'
  )
    return 'Process inspection failed; setup cannot prove hosts are stopped.'
  return undefined
}

/** A setup refusal whose message is safe to show on the terminal. */
export class SetupRefusal extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SetupRefusal'
    setupRefusals.set(this, message)
  }
}

export interface HostDetection {
  kind: HarnessKind
  installed: boolean
  version: string | null
  configPath: string
  pluginInstalled: boolean
  hasLocalAuth?: boolean
}

export interface ClaustrumDetection {
  ckInstalled: boolean
  ckVersion: string | null
  daemonRunning: boolean
  connectionPath: string | null
}

export interface SetupDetection {
  opencode: HostDetection
  pi: HostDetection
  claustrum: ClaustrumDetection
}

export interface CommandRunnerResult {
  exitCode: number
  stdout: string
  stderr: string
  signal?: NodeJS.Signals | null
  spawnError?: boolean
}

export interface CommandRunner {
  run(
    command: string,
    args: string[],
    options?: {
      env?: Record<string, string | undefined>
      timeoutMs?: number
    },
  ): Promise<CommandRunnerResult>
}

export interface ProcessFence {
  listRunningHosts(
    env?: Record<string, string | undefined>,
  ): Promise<Array<{ pid: number; command: string }>>
}
