import {
  authorize,
  CLAUDE_FABLE_MYTHOS_5_CONTEXT_WINDOW,
  CLAUDE_FABLE_MYTHOS_5_MAX_OUTPUT_TOKENS,
  CLAUDE_FABLE_MYTHOS_5_MODEL_SPECS,
  CLAUDE_FABLE_MYTHOS_5_PRICING,
  exchange,
  refreshClaudeOAuthToken,
} from '@cortexkit/anthropic-auth-core'
import type {
  OAuthCredentials,
  OAuthLoginCallbacks,
} from '@earendil-works/pi-ai'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

import { registerCommands } from './commands.ts'
import { streamCortexKitAnthropic } from './stream.ts'

async function loginAnthropic(
  callbacks: OAuthLoginCallbacks,
): Promise<OAuthCredentials> {
  const auth = await authorize('max')
  callbacks.onAuth({ url: auth.url })
  const callback = await callbacks.onPrompt({
    message: 'Paste the Claude OAuth callback URL or code:',
  })
  const result = await exchange(
    callback,
    auth.verifier,
    auth.redirectUri,
    auth.state,
  )
  if (result.type !== 'success') {
    throw new Error('Anthropic OAuth exchange failed')
  }
  return {
    refresh: result.refresh,
    access: result.access,
    expires: result.expires,
  }
}

function textImageInput(): Array<'text' | 'image'> {
  return ['text', 'image']
}

async function refreshAnthropicToken(
  credentials: OAuthCredentials,
): Promise<OAuthCredentials> {
  const refreshed = await refreshClaudeOAuthToken({
    refreshToken: credentials.refresh,
  })

  return {
    refresh: refreshed.refresh,
    access: refreshed.access,
    expires: refreshed.expires,
  }
}

export default function cortexKitPiAnthropicAuth(pi: ExtensionAPI) {
  registerCommands(pi)

  pi.registerProvider('anthropic', {
    name: 'Anthropic (CortexKit OAuth)',
    baseUrl: 'https://api.anthropic.com',
    api: 'cortexkit-anthropic-messages',
    models: [
      ...Object.values(CLAUDE_FABLE_MYTHOS_5_MODEL_SPECS).map((model) => ({
        id: model.id,
        name: model.name,
        reasoning: true,
        input: textImageInput(),
        cost: {
          input: CLAUDE_FABLE_MYTHOS_5_PRICING.input,
          output: CLAUDE_FABLE_MYTHOS_5_PRICING.output,
          cacheRead: CLAUDE_FABLE_MYTHOS_5_PRICING.cacheRead,
          cacheWrite: CLAUDE_FABLE_MYTHOS_5_PRICING.cacheWrite5m,
        },
        contextWindow: CLAUDE_FABLE_MYTHOS_5_CONTEXT_WINDOW,
        maxTokens: CLAUDE_FABLE_MYTHOS_5_MAX_OUTPUT_TOKENS,
      })),
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
    ],
    oauth: {
      name: 'Anthropic Claude Pro/Max (CortexKit)',
      login: loginAnthropic,
      refreshToken: refreshAnthropicToken,
      getApiKey: (credentials) => credentials.access,
    },
    streamSimple: streamCortexKitAnthropic,
  })
}
