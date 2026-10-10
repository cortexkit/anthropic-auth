import {
  CLAUDE_FABLE_MYTHOS_5_1_PRICING,
  CLAUDE_FABLE_MYTHOS_5_CONTEXT_WINDOW,
  CLAUDE_FABLE_MYTHOS_5_MAX_OUTPUT_TOKENS,
  CLAUDE_FABLE_MYTHOS_5_MODEL_SPECS,
  CLAUDE_FABLE_MYTHOS_5_PRICING,
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
  isClaudeFableOrMythos51Model,
  type MidConversationEffortTransition,
  type NativeCustodyClient,
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
import { closePiNativeRuntime, getPiNativeRuntime } from './native.ts'
import { createPiNativeCommands } from './native-commands.ts'
import { getPiAccountStoragePath, requirePiNativeHostAuth } from './paths.ts'
import { streamCortexKitAnthropic } from './stream.ts'

function textImageInput(): Array<'text' | 'image'> {
  return ['text', 'image']
}

export default async function cortexKitPiAnthropicAuth(
  pi: ExtensionAPI,
  options: {
    connectScoped?: () => Promise<NativeCustodyClient>
  } = {},
) {
  const storagePath = getPiAccountStoragePath()
  getPiNativeRuntime(storagePath, {
    ...(options.connectScoped && { connect: options.connectScoped }),
  })
  registerCommands(pi, createPiNativeCommands(storagePath))
  const effortHistoryBySession = new Map<
    string,
    MidConversationEffortTransition[]
  >()
  pi.on('turn_start', async (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId()
    if (!sessionId) return
    // This hook only adds mid-conversation effort markers to Fable/Mythos 5.1
    // requests. A host whose session entries do not match what this reads must
    // cost the session its transitions and nothing else: the handler runs
    // before every turn, and an exception here surfaced as a per-turn extension
    // error while collecting no effort history at all (issue #200).
    //
    // The catch stays quiet: `ExtensionAPI` carries no log surface on either
    // host, and writing to stdout from a per-turn hook corrupts the host's
    // rendering — which is the same per-turn noise this fix removes. The
    // degraded state is observable in the request: no effort markers.
    let transitions: MidConversationEffortTransition[]
    try {
      const branch = ctx.sessionManager.getBranch()
      transitions = collectPiEffortHistory(deriveContextEntries(branch), branch)
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
    if (sessionId) effortHistoryBySession.delete(sessionId)
    closePiNativeRuntime(storagePath)
  })

  const configuration: ProviderConfig = {
    name: 'Anthropic (CortexKit OAuth)',
    baseUrl: 'https://api.anthropic.com',
    api: 'cortexkit-anthropic-messages',
    models: [
      ...Object.values(CLAUDE_FABLE_MYTHOS_5_MODEL_SPECS).map((model) => {
        const pricing = isClaudeFableOrMythos51Model(model.id)
          ? CLAUDE_FABLE_MYTHOS_5_1_PRICING
          : CLAUDE_FABLE_MYTHOS_5_PRICING
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
          contextWindow: CLAUDE_FABLE_MYTHOS_5_CONTEXT_WINDOW,
          maxTokens: CLAUDE_FABLE_MYTHOS_5_MAX_OUTPUT_TOKENS,
        }
      }),
      {
        id: 'claude-opus-5-5',
        name: 'Claude Opus 5.5',
        reasoning: true,
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
      ),
  }

  async function configureProvider() {
    const streamSimple = configuration.streamSimple
    if (!streamSimple)
      throw new Error('Anthropic stream implementation is unavailable')
    // Read the account list installed by offline migration before registering
    // the provider. Token authorization happens separately for each request.
    await getPiNativeRuntime(storagePath).view()
    const configured = async () => {
      await requirePiNativeHostAuth()
      const snapshot = await (
        await getPiNativeRuntime(storagePath).service()
      ).read()
      return snapshot.accounts.some(
        (account) =>
          account.type === 'oauth' &&
          account.enabled &&
          (account.source !== 'vault' || account.state === 'active'),
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
          api: model.api ?? 'cortexkit-anthropic-messages',
          baseUrl: model.baseUrl ?? 'https://api.anthropic.com',
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
