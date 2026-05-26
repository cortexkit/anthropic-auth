import {
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  calculateCost,
  createAssistantMessageEventStream,
  type Model,
  type SimpleStreamOptions,
  type StopReason,
  type TextContent,
  type ThinkingContent,
  type ToolCall,
} from '@earendil-works/pi-ai'
import {
  applyClaudeCodeHeaders,
  CACHE_KEEP_EXTENDED_TTL_BETA,
  CacheKeepManager,
  FAST_MODE_BETA,
  FallbackAccountManager,
  getCache1hPersistentMode,
  getRelayConfig,
  isCache1hPersistentlyEnabled,
  isCacheKeepHybridActive,
  isFastModePersistentlyEnabled,
  loadAccounts,
  mergeAnthropicBetas,
  resolveClaudeCodeIdentity,
  sendViaRelay,
  shouldFallbackStatus,
} from '@marcusrbrown/anthropic-auth-core'

import { buildAnthropicRequest, fromClaudeCodeToolName } from './convert.ts'
import { getPiAccountStoragePath } from './paths.ts'

const cacheKeepManager = new CacheKeepManager({
  loadStorage: () => loadAccounts(getPiAccountStoragePath()),
  prepareHeaders: async (headers, target) => {
    const authorization = headers.get('authorization') ?? ''
    const match = /^Bearer\s+(.+)$/i.exec(authorization)
    const accessToken = match?.[1]
    if (!accessToken) return headers
    try {
      const body = JSON.parse(target.bodyText) as Record<string, unknown>
      const identity = await resolveClaudeCodeIdentity(
        accessToken,
        typeof body.model === 'string' ? body.model : undefined,
      )
      headers.delete('anthropic-beta')
      applyClaudeCodeHeaders(headers, accessToken, { body, identity })
      headers.set(
        'anthropic-beta',
        mergeAnthropicBetas(headers.get('anthropic-beta'), [
          CACHE_KEEP_EXTENDED_TTL_BETA,
        ]),
      )
      if (body.speed === 'fast') {
        headers.set(
          'anthropic-beta',
          mergeAnthropicBetas(headers.get('anthropic-beta'), [FAST_MODE_BETA]),
        )
      }
    } catch {
      applyClaudeCodeHeaders(headers, accessToken)
    }
    return headers
  },
})

function mapStopReason(reason: string | null | undefined): StopReason {
  switch (reason) {
    case 'end_turn':
    case 'pause_turn':
    case 'stop_sequence':
      return 'stop'
    case 'max_tokens':
      return 'length'
    case 'tool_use':
      return 'toolUse'
    default:
      return 'error'
  }
}

function createOutput(model: Model<Api>): AssistantMessage {
  return {
    role: 'assistant',
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
    timestamp: Date.now(),
  }
}

type AnthropicEvent = {
  type?: string
  index?: number
  content_block?: Record<string, unknown>
  delta?: Record<string, unknown>
  message?: { usage?: Record<string, number> }
  usage?: Record<string, number>
}

type Block = (
  | TextContent
  | ThinkingContent
  | (ToolCall & { partialJson?: string })
) & {
  index?: number
}

function updateUsage(
  model: Model<Api>,
  output: AssistantMessage,
  usage?: Record<string, number>,
) {
  if (!usage) return
  output.usage.input = usage.input_tokens ?? output.usage.input
  output.usage.output = usage.output_tokens ?? output.usage.output
  output.usage.cacheRead =
    usage.cache_read_input_tokens ?? output.usage.cacheRead
  output.usage.cacheWrite =
    usage.cache_creation_input_tokens ?? output.usage.cacheWrite
  output.usage.totalTokens =
    output.usage.input +
    output.usage.output +
    output.usage.cacheRead +
    output.usage.cacheWrite
  calculateCost(model, output.usage)
}

async function* parseSse(response: Response): AsyncGenerator<AnthropicEvent> {
  if (!response.body) return
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let boundary = buffer.indexOf('\n\n')
    while (boundary !== -1) {
      const frame = buffer.slice(0, boundary)
      buffer = buffer.slice(boundary + 2)
      boundary = buffer.indexOf('\n\n')
      for (const line of frame.split('\n')) {
        if (!line.startsWith('data:')) continue
        const data = line.slice(5).trim()
        if (!data || data === '[DONE]') continue
        yield JSON.parse(data) as AnthropicEvent
      }
    }
  }
}

async function sendAnthropicRequest(options: {
  model: Model<Api>
  context: Context
  streamOptions?: SimpleStreamOptions
  accessToken: string
  storagePath: string
}): Promise<Response> {
  const storage = await loadAccounts(options.storagePath)
  const identity = await resolveClaudeCodeIdentity(
    options.accessToken,
    options.model.id,
  )
  const { body, bodyText } = await buildAnthropicRequest(
    options.model.id,
    options.context,
    options.streamOptions,
    {
      enabled: isCache1hPersistentlyEnabled(storage),
      mode: getCache1hPersistentMode(storage),
    },
    isFastModePersistentlyEnabled(storage),
    identity,
  )
  const headers = applyClaudeCodeHeaders(new Headers(), options.accessToken, {
    body,
    identity,
  })
  if (body.speed === 'fast') {
    headers.set(
      'anthropic-beta',
      mergeAnthropicBetas(headers.get('anthropic-beta'), [FAST_MODE_BETA]),
    )
  }
  const relayAffinity = options.streamOptions?.sessionId ?? null

  const input = new URL('/v1/messages?beta=true', options.model.baseUrl)
  const init: RequestInit = {
    method: 'POST',
    headers,
    body: bodyText,
    signal: options.streamOptions?.signal,
  }

  await cacheKeepManager.track({
    sessionId: relayAffinity,
    url: input.toString(),
    headers,
    bodyText,
    storage,
    cacheMode: isCacheKeepHybridActive(storage) ? 'hybrid' : 'disabled',
  })

  return sendViaRelay({
    config: getRelayConfig(storage),
    input,
    init,
    headers,
    body: bodyText,
    fallback: () => fetch(input, init),
    affinity: relayAffinity,
  })
}

async function firstStreamingError(
  response: Response,
): Promise<Response | string> {
  if (!response.ok) return response
  const clone = response.clone()
  try {
    for await (const event of parseSse(clone as unknown as Response)) {
      if (
        event.type === 'error' &&
        typeof event.delta?.type === 'string' &&
        event.delta.type === 'rate_limit_error'
      ) {
        return 'rate_limit_error'
      }
      return response
    }
  } catch {
    return response
  }
  return response
}

async function executeWithFallback(options: {
  model: Model<Api>
  context: Context
  streamOptions?: SimpleStreamOptions
  primaryAccessToken: string
  storagePath: string
}): Promise<Response> {
  const manager = new FallbackAccountManager({
    configPath: options.storagePath,
  })
  const storage = await loadAccounts(options.storagePath)
  const primary = await sendAnthropicRequest({
    ...options,
    accessToken: options.primaryAccessToken,
  })
  const primaryPreflight = await firstStreamingError(primary)
  if (primaryPreflight instanceof Response) {
    if (!shouldFallbackStatus(primaryPreflight.status, storage))
      return primaryPreflight
  }

  for (const account of await manager.getUsableFallbackAccounts()) {
    if (!account.access) continue
    const response = await sendAnthropicRequest({
      ...options,
      accessToken: account.access,
    })
    const preflight = await firstStreamingError(response)
    if (preflight instanceof Response && preflight.ok) {
      await manager.markUsed(account)
      return preflight
    }
    if (
      preflight instanceof Response &&
      !shouldFallbackStatus(preflight.status, storage)
    ) {
      return preflight
    }
  }

  return primaryPreflight instanceof Response ? primaryPreflight : primary
}

export function streamCortexKitAnthropic(
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream()

  void (async () => {
    const output = createOutput(model)
    stream.push({ type: 'start', partial: output })

    try {
      const accessToken = options?.apiKey ?? ''
      if (!accessToken) throw new Error('Missing Anthropic OAuth access token')

      const storagePath = getPiAccountStoragePath()
      const response = await executeWithFallback({
        model,
        context,
        streamOptions: options,
        primaryAccessToken: accessToken,
        storagePath,
      })

      if (!response.ok) {
        throw new Error(
          `Anthropic request failed: HTTP ${response.status} ${await response.text()}`,
        )
      }

      const blocks = output.content as Block[]
      for await (const event of parseSse(response)) {
        if (event.type === 'message_start') {
          updateUsage(model, output, event.message?.usage)
        } else if (event.type === 'content_block_start') {
          const block = event.content_block
          if (block?.type === 'text') {
            output.content.push({
              type: 'text',
              text: '',
              index: event.index,
            } as Block)
            stream.push({
              type: 'text_start',
              contentIndex: output.content.length - 1,
              partial: output,
            })
          } else if (block?.type === 'thinking') {
            output.content.push({
              type: 'thinking',
              thinking: '',
              thinkingSignature: '',
              index: event.index,
            } as Block)
            stream.push({
              type: 'thinking_start',
              contentIndex: output.content.length - 1,
              partial: output,
            })
          } else if (block?.type === 'tool_use') {
            output.content.push({
              type: 'toolCall',
              id: String(block.id),
              name: fromClaudeCodeToolName(String(block.name), context.tools),
              arguments: {},
              partialJson: '',
              index: event.index,
            } as Block)
            stream.push({
              type: 'toolcall_start',
              contentIndex: output.content.length - 1,
              partial: output,
            })
          }
        } else if (event.type === 'content_block_delta') {
          const contentIndex = blocks.findIndex(
            (block) => block.index === event.index,
          )
          const block = blocks[contentIndex]
          if (!block || !event.delta) continue
          if (event.delta.type === 'text_delta' && block.type === 'text') {
            const delta = String(event.delta.text ?? '')
            block.text += delta
            stream.push({
              type: 'text_delta',
              contentIndex,
              delta,
              partial: output,
            })
          } else if (
            event.delta.type === 'thinking_delta' &&
            block.type === 'thinking'
          ) {
            const delta = String(event.delta.thinking ?? '')
            block.thinking += delta
            stream.push({
              type: 'thinking_delta',
              contentIndex,
              delta,
              partial: output,
            })
          } else if (
            event.delta.type === 'signature_delta' &&
            block.type === 'thinking'
          ) {
            block.thinkingSignature = `${block.thinkingSignature ?? ''}${String(event.delta.signature ?? '')}`
          } else if (
            event.delta.type === 'input_json_delta' &&
            block.type === 'toolCall'
          ) {
            const delta = String(event.delta.partial_json ?? '')
            block.partialJson = `${block.partialJson ?? ''}${delta}`
            try {
              block.arguments = JSON.parse(block.partialJson)
            } catch {}
            stream.push({
              type: 'toolcall_delta',
              contentIndex,
              delta,
              partial: output,
            })
          }
        } else if (event.type === 'content_block_stop') {
          const contentIndex = blocks.findIndex(
            (block) => block.index === event.index,
          )
          const block = blocks[contentIndex]
          if (!block) continue
          delete block.index
          if (block.type === 'text') {
            stream.push({
              type: 'text_end',
              contentIndex,
              content: block.text,
              partial: output,
            })
          } else if (block.type === 'thinking') {
            stream.push({
              type: 'thinking_end',
              contentIndex,
              content: block.thinking,
              partial: output,
            })
          } else if (block.type === 'toolCall') {
            try {
              block.arguments = JSON.parse(block.partialJson ?? '{}')
            } catch {}
            delete block.partialJson
            stream.push({
              type: 'toolcall_end',
              contentIndex,
              toolCall: block,
              partial: output,
            })
          }
        } else if (event.type === 'message_delta') {
          output.stopReason = mapStopReason(
            String(event.delta?.stop_reason ?? ''),
          )
          updateUsage(model, output, event.usage)
        } else if (event.type === 'error') {
          throw new Error(JSON.stringify(event))
        }
      }

      if (options?.signal?.aborted) throw new Error('Request was aborted')
      for (const block of output.content as Block[]) delete block.index
      stream.push({
        type: 'done',
        reason: output.stopReason as 'stop' | 'length' | 'toolUse',
        message: output,
      })
      stream.end()
    } catch (error) {
      for (const block of output.content as Block[]) delete block.index
      output.stopReason = options?.signal?.aborted ? 'aborted' : 'error'
      output.errorMessage =
        error instanceof Error ? error.message : String(error)
      stream.push({ type: 'error', reason: output.stopReason, error: output })
      stream.end()
    }
  })()

  return stream
}
