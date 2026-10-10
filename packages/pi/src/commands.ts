import {
  createNativeUi,
  type NativeMenuCommandId,
  type NativeMenuDispatch,
  runPiCommandMenu,
} from '@cortexkit/anthropic-auth-core'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

/** Backend callbacks use native authority; the renderer never receives credentials. */
export interface PiNativeCommands {
  dispatch: NativeMenuDispatch
  readStatus: (
    command: Exclude<NativeMenuCommandId, 'start'>,
    invocation: { sessionId?: string },
  ) => Promise<string>
}

export function registerCommands(pi: ExtensionAPI, backend: PiNativeCommands) {
  pi.registerCommand('claude', {
    description:
      'Claude accounts, quota, routing, limits, cache and diagnostics',
    handler: async (args, ctx) => {
      if (args?.trim()) {
        ctx.ui.notify(
          'Use /claude to open the menu. Action parameters are collected in the selected action; custody changes require offline setup.',
          'warning',
        )
        return
      }
      const menu = createNativeUi({
        host: 'pi',
        dispatch: backend.dispatch,
        readStatus: backend.readStatus,
        interactive: ctx.hasUI,
      })
      const sessionId = ctx.sessionManager.getSessionId()
      if (ctx.hasUI) {
        await runPiCommandMenu(menu, ctx.ui, { sessionId })
      } else {
        // A scripted invocation can inspect status, but cannot answer prompts or
        // silently confirm a destructive action.
        const payload = await menu.open({
          sessionId,
          notify: (message, kind) => ctx.ui.notify(message, kind),
        })
        ctx.ui.notify(
          payload.menu.sections
            .map((section) => `${section.title}\n${section.lines.join('\n')}`)
            .join('\n\n'),
          'info',
        )
      }
    },
  })
}
