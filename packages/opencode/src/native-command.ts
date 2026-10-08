import {
  type CommandApplyRequest,
  type CommandApplyResult,
  type CommandDialogPayload,
  type CommandMenu,
  createNativeUi,
  type NativeUiOptions,
} from '@cortexkit/anthropic-auth-core'

export interface NativeCommand {
  readonly menu: CommandMenu
  readonly open: (sessionId: string) => Promise<CommandDialogPayload>
  readonly apply: (request: CommandApplyRequest) => Promise<CommandApplyResult>
}

function session(sessionId: string | undefined): string {
  if (!sessionId?.trim()) throw new TypeError('sessionId is required')
  return sessionId
}

/** Build and execute the Claude menu using account, status and session callbacks supplied by the host. */
export function createNativeCommand(options: NativeUiOptions): NativeCommand {
  if (options.host !== 'opencode')
    throw new TypeError('OpenCode host is required')
  const menu = createNativeUi(options)
  return {
    menu,
    open(sessionId) {
      return menu.open({ sessionId: session(sessionId), notify() {} })
    },
    apply(request) {
      return menu.apply(request, {
        sessionId: session(request.sessionId),
        notify() {},
      })
    },
  }
}
