import {
  CLAUDE_FABLE_MYTHOS_5_MODEL_SPECS,
  CLAUDE_HAIKU_5_5_CONTEXT_WINDOW,
  CLAUDE_HAIKU_5_5_LONG_CONTEXT_PRICING,
  CLAUDE_HAIKU_5_5_LONG_CONTEXT_THRESHOLD,
  CLAUDE_HAIKU_5_5_MAX_OUTPUT_TOKENS,
  CLAUDE_HAIKU_5_5_MODEL_ID,
  CLAUDE_HAIKU_5_5_PRICING,
  CLAUDE_SONNET_5_5_CONTEXT_WINDOW,
  CLAUDE_SONNET_5_5_MAX_OUTPUT_TOKENS,
  CLAUDE_SONNET_5_5_MODEL_ID,
  CLAUDE_SONNET_5_5_PRICING,
  defaultAdaptiveEffort,
  getClaudeModelCatalogue,
  type MidConversationEffortTransition,
  type NativeAccountSnapshot,
  type NativeCustodyClient,
  nativeAccountCanServe,
  readNativeEnrollmentMode,
  sessionCacheActivity,
} from '@cortexkit/anthropic-auth-core'
import type { Provider, SimpleStreamOptions } from '@earendil-works/pi-ai'
import type {
  ExtensionAPI,
  ProviderConfig,
} from '@earendil-works/pi-coding-agent'

import { registerCommands } from './commands.ts'
import {
  collectPiEffortHistory,
  deriveContextEntries,
} from './effort-history.ts'
import {
  closePiNativeRuntime,
  getPiNativeRuntime,
  isNativeMigrationRequired,
} from './native.ts'
import { createPiNativeCommands } from './native-commands.ts'
import { getPiAccountStoragePath, requirePiNativeHostAuth } from './paths.ts'
import type { PiQuotaWaitOptions } from './quota-wait.ts'
import { forgetPiMessageThread, streamCortexKitAnthropic } from './stream.ts'

function textImageInput(): Array<'text' | 'image'> {
  return ['text', 'image']
}

/**
 * Refuses every Anthropic prompt with Core's migration message. Registered
 * only when startup found an install that offline setup has never migrated.
 * Pi checks a prompt's credentials after its input handlers run. Handling the
 * input here stops it before that check, which would otherwise answer with
 * Pi's generic missing-key text for a 1.x install whose Pi login is still
 * stored. Extension commands such as /claude run before input handlers, so
 * they stay reachable.
 */
function refuseUnmigratedPrompts(pi: ExtensionAPI, storagePath: string) {
  pi.on('input', async (_event, ctx) => {
    // Prompts for other providers do not use this install's accounts.
    if (ctx.model?.provider !== 'anthropic') return { action: 'continue' }
    const refusal = await getPiNativeRuntime(storagePath).migrationRefusal()
    if (!refusal) return { action: 'continue' }
    if (ctx.hasUI) ctx.ui.notify(refusal.message, 'error')
    else process.stderr.write(`${refusal.message}\n`)
    return { action: 'handled' }
  })
}

export default async function cortexKitPiAnthropicAuth(
  pi: ExtensionAPI,
  options: {
    connectScoped?: () => Promise<NativeCustodyClient>
    quotaWait?: PiQuotaWaitOptions
  } = {},
) {
  const storagePath = getPiAccountStoragePath()
  const quotaWait = options.quotaWait
  getPiNativeRuntime(storagePath, {
    ...(options.connectScoped && { connect: options.connectScoped }),
  })
  registerCommands(pi, createPiNativeCommands(storagePath))
  const effortHistoryBySession = new Map<
    string,
    MidConversationEffortTransition[]
  >()
  const workingMessageBySession = new Map<string, (message?: string) => void>()
  pi.on('turn_start', async (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId()
    if (!sessionId) return
    if (ctx.hasUI) {
      workingMessageBySession.set(sessionId, (message) => {
        if (ctx.sessionManager.getSessionId() === sessionId)
          ctx.ui.setWorkingMessage(message)
      })
      if (workingMessageBySession.size > 128) {
        const oldest = workingMessageBySession.keys().next().value
        if (oldest !== undefined) workingMessageBySession.delete(oldest)
      }
    }
    // This hook collects effort history for the per-message effort markers
    // that core adds to Fable 5.1, Opus 5.5 and Sonnet 5.5 requests. A host
    // whose session entries do not match what this reads must cost the
    // session its transitions and nothing else: the handler runs before every
    // turn, and an exception here surfaced as a per-turn extension error while
    // collecting no effort history at all (issue #200).
    //
    // The catch stays quiet: `ExtensionAPI` carries no log surface on either
    // host, and writing to stdout from a per-turn hook corrupts the host's
    // rendering — which is the same per-turn noise this fix removes. The
    // degraded state is observable in the request: no effort markers.
    let transitions: MidConversationEffortTransition[]
    try {
      const branch = ctx.sessionManager.getBranch()
      transitions = collectPiEffortHistory(
        deriveContextEntries(branch),
        branch,
        defaultAdaptiveEffort(ctx.model?.id),
      )
    } catch {
      transitions = []
    }
    effortHistoryBySession.delete(sessionId)
    effortHistoryBySession.set(sessionId, transitions)
    while (effortHistoryBySession.size > 128) {
      const oldest = effortHistoryBySession.keys().next().value
      if (oldest) effortHistoryBySession.delete(oldest)
      else break
    }
  })
  pi.on('session_shutdown', async (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId()
    if (sessionId) {
      effortHistoryBySession.delete(sessionId)
      workingMessageBySession.delete(sessionId)
      sessionCacheActivity.forget(sessionId)
      forgetPiMessageThread(sessionId)
    }
    await closePiNativeRuntime(storagePath)
  })

  // Keep the catalog chat-only even when Pi also accepts image/classifier models.
  const configuration = {
    name: 'Anthropic (CortexKit OAuth)',
    baseUrl: 'https://api.anthropic.com',
    api: 'cortexkit-anthropic-messages',
    models: [
      ...Object.values(CLAUDE_FABLE_MYTHOS_5_MODEL_SPECS).map((model) => {
        const catalogue = getClaudeModelCatalogue(model.id)
        const pricing = catalogue.pricing
        return {
          id: model.id,
          name: model.name,
          reasoning: true,
          input: textImageInput(),
          cost: {
            input: pricing.input,
            output: pricing.output,
            cacheRead: pricing.cacheRead,
            cacheWrite: pricing.cacheWrite5m,
          },
          contextWindow: catalogue.contextWindow,
          maxTokens: catalogue.maxOutputTokens,
        }
      }),
      {
        id: 'claude-opus-5-5',
        name: 'Claude Opus 5.5',
        reasoning: true,
        // Opus 5.5 always uses adaptive thinking: it cannot disable thinking or
        // honor a generic `minimal` effort. Advertise only the API's effort
        // choices, including the extended levels, as for Sonnet/Haiku 5.5.
        thinkingLevelMap: {
          off: null,
          minimal: null,
          xhigh: 'xhigh',
          max: 'max',
        },
        input: textImageInput(),
        cost: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 8 },
        contextWindow: 1_000_000,
        maxTokens: 128_000,
      },
      {
        id: 'claude-opus-5',
        name: 'Claude Opus 5',
        reasoning: true,
        input: textImageInput(),
        cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
        contextWindow: 1_000_000,
        maxTokens: 128_000,
      },
      {
        id: 'claude-opus-4-8',
        name: 'Claude Opus 4.8',
        reasoning: true,
        input: textImageInput(),
        cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
        contextWindow: 1_000_000,
        maxTokens: 128_000,
      },
      {
        id: 'claude-opus-4-5',
        name: 'Claude Opus 4.5',
        reasoning: true,
        input: textImageInput(),
        cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
        contextWindow: 200_000,
        maxTokens: 64_000,
      },
      {
        id: 'claude-sonnet-4-5',
        name: 'Claude Sonnet 4.5',
        reasoning: true,
        input: textImageInput(),
        cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
        contextWindow: 200_000,
        maxTokens: 64_000,
      },
      {
        id: 'claude-sonnet-5',
        name: 'Claude Sonnet 5',
        reasoning: true,
        input: textImageInput(),
        cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
        contextWindow: 1_000_000,
        maxTokens: 128_000,
      },
      {
        id: CLAUDE_HAIKU_5_5_MODEL_ID,
        name: 'Claude Haiku 5.5',
        reasoning: true,
        thinkingLevelMap: {
          off: null,
          minimal: null,
          xhigh: 'xhigh',
          max: 'max',
        },
        input: textImageInput(),
        cost: {
          input: CLAUDE_HAIKU_5_5_PRICING.input,
          output: CLAUDE_HAIKU_5_5_PRICING.output,
          cacheRead: CLAUDE_HAIKU_5_5_PRICING.cacheRead,
          cacheWrite: CLAUDE_HAIKU_5_5_PRICING.cacheWrite5m,
          tiers: [
            {
              inputTokensAbove: CLAUDE_HAIKU_5_5_LONG_CONTEXT_THRESHOLD,
              input: CLAUDE_HAIKU_5_5_LONG_CONTEXT_PRICING.input,
              output: CLAUDE_HAIKU_5_5_LONG_CONTEXT_PRICING.output,
              cacheRead: CLAUDE_HAIKU_5_5_LONG_CONTEXT_PRICING.cacheRead,
              cacheWrite: CLAUDE_HAIKU_5_5_LONG_CONTEXT_PRICING.cacheWrite5m,
            },
          ],
        },
        contextWindow: CLAUDE_HAIKU_5_5_CONTEXT_WINDOW,
        maxTokens: CLAUDE_HAIKU_5_5_MAX_OUTPUT_TOKENS,
      },
      {
        id: CLAUDE_SONNET_5_5_MODEL_ID,
        name: 'Claude Sonnet 5.5',
        reasoning: true,
        thinkingLevelMap: {
          off: null,
          minimal: null,
          xhigh: 'xhigh',
          max: 'max',
        },
        input: textImageInput(),
        cost: {
          input: CLAUDE_SONNET_5_5_PRICING.input,
          output: CLAUDE_SONNET_5_5_PRICING.output,
          cacheRead: CLAUDE_SONNET_5_5_PRICING.cacheRead,
          cacheWrite: CLAUDE_SONNET_5_5_PRICING.cacheWrite5m,
        },
        contextWindow: CLAUDE_SONNET_5_5_CONTEXT_WINDOW,
        maxTokens: CLAUDE_SONNET_5_5_MAX_OUTPUT_TOKENS,
      },
    ],
    streamSimple: (model, context, options) =>
      streamCortexKitAnthropic(
        model,
        context,
        options,
        options?.sessionId
          ? effortHistoryBySession.get(options.sessionId)
          : undefined,
        {
          ...quotaWait,
          setWorkingMessage:
            (options?.sessionId
              ? workingMessageBySession.get(options.sessionId)
              : undefined) ?? quotaWait?.setWorkingMessage,
        },
      ),
  } satisfies ProviderConfig

  async function configureProvider() {
    const streamSimple = configuration.streamSimple
    if (!streamSimple)
      throw new Error('Anthropic stream implementation is unavailable')
    // Register vault-backed models even if no account can serve yet, so a
    // repaired enrollment or re-login takes effect on the next request. Local
    // credentials still require completed offline migration before serving.
    const startupMode = await readNativeEnrollmentMode('pi').catch(
      () => undefined,
    )
    try {
      if (startupMode === 'local') await getPiNativeRuntime(storagePath).view()
    } catch (error) {
      // An install that offline setup has never migrated, such as a 1.x
      // install upgraded in place, must still load: a failed load drops the
      // /claude menu and Pi exits at startup. Its prompts are refused instead.
      // Any other failure stops the load as before.
      const refusal = await getPiNativeRuntime(storagePath).migrationRefusal()
      if (!refusal) throw error
      refuseUnmigratedPrompts(pi, storagePath)
    }
    const configured = async () => {
      const mode = await readNativeEnrollmentMode('pi').catch(() => undefined)
      if (mode !== 'local') return true
      await requirePiNativeHostAuth()
      let snapshot: NativeAccountSnapshot
      try {
        snapshot = await (
          await getPiNativeRuntime(storagePath).service()
        ).read()
      } catch (error) {
        // An unmigrated install still reports the provider as configured, so
        // Pi keeps its Anthropic models selectable and its prompts reach the
        // refusal above (or, from any other caller, the stream, which refuses
        // with the same Core message). If this check threw instead, Pi would
        // record the refusal as a startup availability error.
        if (isNativeMigrationRequired(error)) return true
        throw error
      }
      return snapshot.accounts.some(
        (account) => account.type === 'oauth' && nativeAccountCanServe(account),
      )
    }
    const provider: Provider = {
      id: 'anthropic',
      name: 'Anthropic (CortexKit Native)',
      baseUrl: 'https://api.anthropic.com',
      auth: {
        // Native ambient auth avoids fake keys and local OAuth refresh. Pi refuses
        // a leftover stored OAuth credential because this provider has no OAuth
        // handler; setup must obtain consent before removing that local entry.
        apiKey: {
          name: 'CortexKit Native',
          check: async () =>
            (await configured())
              ? { type: 'api_key', source: 'CortexKit Native' }
              : undefined,
          resolve: async () =>
            (await configured())
              ? { auth: {}, source: 'CortexKit Native' }
              : undefined,
        },
      },
      getModels: () =>
        (configuration.models ?? []).map((model) => ({
          ...model,
          provider: 'anthropic',
          api: configuration.api,
          baseUrl: configuration.baseUrl,
        })),
      // Preserve the legacy provider's simplified option surface for raw calls.
      stream: (model, context, options) =>
        streamSimple(model, context, options as SimpleStreamOptions),
      streamSimple,
    }
    pi.registerProvider(provider)
  }
  await configureProvider()
}
