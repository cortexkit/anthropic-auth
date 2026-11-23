import { join } from 'node:path'
import {
  createNativeUi,
  disconnectNativeVaultForHost,
  LANE_START_TEXT,
  type NativeMenuCommandId,
  type NativeMenuDispatch,
  type NativeUiOptions,
  openNativePiAuthSlot,
  readNativeEnrollmentMode,
  runPiCommandMenu,
} from '@cortexkit/anthropic-auth-core'
import { type ExtensionAPI, getAgentDir } from '@earendil-works/pi-coding-agent'

/** Backend callbacks use native authority; the renderer never receives credentials. */
export interface PiNativeCommands {
  dispatch: (
    ...args: [...Parameters<NativeMenuDispatch>, queueLaneStart?: () => void]
  ) => ReturnType<NativeMenuDispatch>
  readStatus: (
    command: Exclude<NativeMenuCommandId, 'start'>,
    invocation: { sessionId?: string },
  ) => Promise<string>
  /**
   * Reads Pi's credential custody for each menu open and apply. When left
   * out, the enrollment record the environment points to is read; there is
   * no local fallback.
   */
  readMode?: NativeUiOptions['readMode']
  readAccounts?: NativeUiOptions['readAccounts']
  /**
   * Disconnects Pi from the vault. When left out, Core clears the vault
   * placeholder, restores no sign-in, then ends Pi's enrollment.
   */
  disconnectVault?: NativeUiOptions['disconnectVault']
}

/**
 * Pi's default disconnect. The auth file is the one Pi's SDK uses
 * (getAgentDir() honours PI_CODING_AGENT_DIR); Core chooses the private
 * legacy stash path and placeholder, so setup and disconnect agree on cleanup.
 */
const disconnectPi: NativeUiOptions['disconnectVault'] = () =>
  disconnectNativeVaultForHost({
    host: 'pi',
    env: process.env,
    slot: openNativePiAuthSlot({
      env: process.env,
      authPath: join(getAgentDir(), 'auth.json'),
    }),
  })

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
      const disconnect = backend.disconnectVault ?? disconnectPi
      const queueLaneStart = () => {
        if (
          ctx.model?.provider !== 'anthropic' ||
          ctx.model.api !== 'anthropic-messages'
        )
          throw new Error('Lane start requires an active Claude model')
        pi.sendUserMessage(LANE_START_TEXT, { deliverAs: 'followUp' })
      }
      const menu = createNativeUi({
        host: 'pi',
        dispatch: (request, options) =>
          backend.dispatch(request, options, queueLaneStart),
        readStatus: backend.readStatus,
        readAccounts: backend.readAccounts,
        readMode:
          backend.readMode ??
          (() => readNativeEnrollmentMode('pi', process.env)),
        disconnectVault: async (options) => {
          const result = await disconnect(options)
          // Reload after successful or already-inactive enrollment so Pi sees
          // the cleared vault placeholder. Reload failure cannot undo the completed
          // disconnect, so report it separately without exposing the exception.
          if (result === 'disconnected' || result === 'idle') {
            try {
              await ctx.modelRegistry.refresh()
            } catch {
              ctx.ui.notify(
                'Vault enrollment is inactive, but Pi could not reload its authentication. Restart Pi and sign in again before sending another request.',
                'error',
              )
            }
          }
          return result
        },
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
