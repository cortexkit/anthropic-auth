import type {
  OAuthCredentials,
  OAuthLoginCallbacks,
} from '@earendil-works/pi-ai'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import {
  authorize,
  exchange,
  refreshClaudeOAuthToken,
} from '@marcusrbrown/anthropic-auth-core'

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
      {
        id: 'claude-opus-4-5',
        name: 'Claude Opus 4.5',
        reasoning: true,
        input: ['text', 'image'],
        cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
        contextWindow: 200_000,
        maxTokens: 64_000,
      },
      {
        id: 'claude-sonnet-4-5',
        name: 'Claude Sonnet 4.5',
        reasoning: true,
        input: ['text', 'image'],
        cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
        contextWindow: 200_000,
        maxTokens: 64_000,
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
