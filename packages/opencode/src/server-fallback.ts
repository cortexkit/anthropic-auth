import {
  resolveClaudeModelCapabilities,
  SERVER_FALLBACK_USAGE_MARKER_TEXT,
  SERVER_FALLBACK_USAGE_SIGNATURE_PREFIX,
  stripServerFallbackUsageMarkers,
} from '@cortexkit/anthropic-auth-core'
import { recoverableRefusalFamily } from './fable-fallback'

export const SERVER_SIDE_FALLBACK_BETA = 'server-side-fallback-2026-07-01'
export const SERVER_FALLBACK_MARKER_TEXT = '\u2060'
export const SERVER_FALLBACK_SIGNATURE_PREFIX = 'cortexkit-server-fallback-v1:'
export {
  SERVER_FALLBACK_USAGE_MARKER_TEXT,
  SERVER_FALLBACK_USAGE_SIGNATURE_PREFIX,
}

function usageMarkerSignature(usage: Record<string, unknown> | undefined) {
  const raw = usage?.iterations
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 8) return
  const iterations: Record<string, unknown>[] = []
  for (const value of raw) {
    const iteration = asRecord(value)
    if (
      !iteration ||
      (iteration.type !== 'message' && iteration.type !== 'fallback_message') ||
      !safeModelId(iteration.model)
    )
      return
    const clean: Record<string, unknown> = {
      type: iteration.type,
      model: iteration.model,
    }
    for (const field of [
      'input_tokens',
      'output_tokens',
      'cache_read_input_tokens',
      'cache_creation_input_tokens',
    ]) {
      const count = iteration[field]
      if (count === undefined && field.startsWith('cache_')) continue
      if (
        typeof count !== 'number' ||
        !Number.isSafeInteger(count) ||
        count < 0
      )
        return
      clean[field] = count
    }
    iterations.push(clean)
  }
  if (!iterations.some((iteration) => iteration.type === 'fallback_message'))
    return
  const payload = JSON.stringify({ iterations })
  if (payload.length > 4096) return
  return SERVER_FALLBACK_USAGE_SIGNATURE_PREFIX + payload
}

export type ContentFilterFallbackMode = 'server' | 'legacy'

export type ServerSideFallbackOutcome = {
  requestedModel: string
  servedModel?: string
  targetModel?: string
  fallback: boolean
  handoff: boolean
  stopReason: string
}

type ServerSideFallbackMarker = {
  fromModel: string
  toModel: string
}

type ParsedSseEvent = {
  event?: string
  data?: Record<string, unknown>
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function stringField(
  value: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const field = value?.[key]
  return typeof field === 'string' ? field : undefined
}

function safeModelId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 128 &&
    /^claude-[a-z0-9-]+$/i.test(value)
  )
}

function encodeMarkerSignature(marker: ServerSideFallbackMarker) {
  return `${SERVER_FALLBACK_SIGNATURE_PREFIX}${marker.fromModel}|${marker.toModel}`
}

function decodeMarkerSignature(
  value: unknown,
): ServerSideFallbackMarker | null {
  if (
    typeof value !== 'string' ||
    !value.startsWith(SERVER_FALLBACK_SIGNATURE_PREFIX)
  ) {
    return null
  }
  const encoded = value.slice(SERVER_FALLBACK_SIGNATURE_PREFIX.length)
  const separator = encoded.indexOf('|')
  if (separator <= 0 || separator !== encoded.lastIndexOf('|')) return null
  const fromModel = encoded.slice(0, separator)
  const toModel = encoded.slice(separator + 1)
  if (!safeModelId(fromModel) || !safeModelId(toModel)) return null
  return { fromModel, toModel }
}

function markerFromFallbackBlock(
  block: Record<string, unknown>,
): ServerSideFallbackMarker | null {
  if (block.type !== 'fallback') return null
  const fromModel = stringField(asRecord(block.from), 'model')
  const toModel = stringField(asRecord(block.to), 'model')
  if (!safeModelId(fromModel) || !safeModelId(toModel)) return null
  return { fromModel, toModel }
}

function fallbackBlock(marker: ServerSideFallbackMarker) {
  return {
    type: 'fallback',
    from: { model: marker.fromModel },
    to: { model: marker.toModel },
  }
}

function rewriteStoredMarkers(body: Record<string, unknown>, enabled: boolean) {
  let restoredMarkers = 0
  let droppedMarkers = stripServerFallbackUsageMarkers(body)
  if (!Array.isArray(body.messages)) {
    return { restoredMarkers, droppedMarkers }
  }

  for (const rawMessage of body.messages) {
    const message = asRecord(rawMessage)
    if (message?.role !== 'assistant' || !Array.isArray(message.content)) {
      continue
    }
    const rewritten: unknown[] = []
    for (const rawBlock of message.content) {
      const block = asRecord(rawBlock)
      const isInternalMarker =
        block?.type === 'thinking' &&
        typeof block.signature === 'string' &&
        block.signature.startsWith(SERVER_FALLBACK_SIGNATURE_PREFIX)
      if (!isInternalMarker) {
        rewritten.push(rawBlock)
        continue
      }

      const marker = decodeMarkerSignature(block.signature)
      if (enabled && marker) {
        rewritten.push(fallbackBlock(marker))
        restoredMarkers++
      } else {
        droppedMarkers++
      }
    }
    message.content = rewritten
  }
  return { restoredMarkers, droppedMarkers }
}

export function resolveContentFilterFallbackMode(
  value: string | undefined,
): ContentFilterFallbackMode {
  return value?.trim().toLowerCase() === 'legacy' ? 'legacy' : 'server'
}

export function applyServerSideFallbackToBody(
  body: Record<string, unknown>,
  requested: boolean,
): {
  enabled: boolean
  restoredMarkers: number
  droppedMarkers: number
} {
  const enabled =
    requested &&
    resolveClaudeModelCapabilities(body.model)?.serverSideFallback === true
  const markerResult = rewriteStoredMarkers(body, enabled)
  if (enabled) {
    body.fallbacks = 'default'
  } else if (body.fallbacks === 'default') {
    delete body.fallbacks
  }
  return { enabled, ...markerResult }
}

function parseSseEvent(rawEvent: string): ParsedSseEvent {
  let event: string | undefined
  const dataLines: string[] = []
  for (const line of rawEvent.split(/\r?\n/)) {
    if (line.startsWith('event:')) {
      event = line.slice('event:'.length).trim()
    } else if (line.startsWith('data:')) {
      const value = line.slice('data:'.length)
      dataLines.push(value.startsWith(' ') ? value.slice(1) : value)
    }
  }
  const text = dataLines.join('\n')
  if (!text || text === '[DONE]') return { event }
  try {
    return { event, data: asRecord(JSON.parse(text)) }
  } catch {
    return { event }
  }
}

function findSseBoundary(value: string) {
  const lf = value.indexOf('\n\n')
  const crlf = value.indexOf('\r\n\r\n')
  if (lf === -1) return crlf === -1 ? null : { index: crlf, length: 4 }
  if (crlf === -1 || lf < crlf) return { index: lf, length: 2 }
  return { index: crlf, length: 4 }
}

function sseFrame(event: string, data: Record<string, unknown>) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

function hiddenThinkingFrames(index: number, text: string, signature: string) {
  return (
    sseFrame('content_block_start', {
      type: 'content_block_start',
      index,
      content_block: {
        type: 'thinking',
        thinking: text,
      },
    }) +
    sseFrame('content_block_delta', {
      type: 'content_block_delta',
      index,
      delta: {
        type: 'signature_delta',
        signature,
      },
    })
  )
}

function sameRequestedModel(requestedModel: string, servedModel: string) {
  const requestedFamily = recoverableRefusalFamily(requestedModel)
  const servedFamily = recoverableRefusalFamily(servedModel)
  if (requestedFamily && servedFamily) return requestedFamily === servedFamily
  return requestedModel === servedModel
}

export function createServerSideFallbackStreamRewriter(options: {
  requestedModel: string
  maxPendingBytes?: number
  onOutcome?: (outcome: ServerSideFallbackOutcome) => void
  onRefusalAfterToolUse?: () => boolean | undefined
}) {
  let pending = ''
  let pendingBytes = 0
  let resync = false
  let resyncCarry = ''
  let servedModel: string | undefined
  let handoff: ServerSideFallbackMarker | undefined
  let fallbackIterationModel: string | undefined
  let completed = false
  let hasCompletedToolUse = false
  let maxBlockIndex = -1
  let usageMarkerEmitted = false
  const openToolUseIndexes = new Set<number>()

  const observeIterations = (usage: Record<string, unknown> | undefined) => {
    if (!Array.isArray(usage?.iterations)) return
    for (const rawIteration of usage.iterations) {
      const iteration = asRecord(rawIteration)
      if (iteration?.type !== 'fallback_message') continue
      const model = stringField(iteration, 'model')
      if (safeModelId(model)) fallbackIterationModel = model
    }
  }

  const complete = (stopReason: string) => {
    if (completed) return
    completed = true
    const targetModel =
      handoff?.toModel ??
      fallbackIterationModel ??
      (servedModel && !sameRequestedModel(options.requestedModel, servedModel)
        ? servedModel
        : undefined)
    options.onOutcome?.({
      requestedModel: options.requestedModel,
      servedModel,
      targetModel,
      fallback: Boolean(targetModel),
      handoff: Boolean(handoff),
      stopReason,
    })
  }

  const rewriteEvent = (rawEvent: string, boundary: string) => {
    const parsed = parseSseEvent(rawEvent)
    const data = parsed.data
    const type = stringField(data, 'type') ?? parsed.event
    if (type === 'message_start') {
      const message = asRecord(data?.message)
      const model = stringField(message, 'model')
      if (safeModelId(model)) servedModel = model
      observeIterations(asRecord(message?.usage))
    } else if (type === 'content_block_start') {
      const block = asRecord(data?.content_block)
      const index = data?.index
      if (
        typeof index === 'number' &&
        Number.isSafeInteger(index) &&
        index >= 0
      )
        maxBlockIndex = Math.max(maxBlockIndex, index)
      if (
        block?.type === 'tool_use' &&
        typeof index === 'number' &&
        Number.isInteger(index) &&
        index >= 0
      ) {
        openToolUseIndexes.add(index)
      }
      const marker = block ? markerFromFallbackBlock(block) : null
      if (marker) {
        handoff = marker
        if (
          typeof index === 'number' &&
          Number.isInteger(index) &&
          index >= 0
        ) {
          return hiddenThinkingFrames(
            index,
            SERVER_FALLBACK_MARKER_TEXT,
            encodeMarkerSignature(marker),
          )
        }
      }
    } else if (type === 'content_block_stop') {
      const index = data?.index
      if (typeof index === 'number' && openToolUseIndexes.delete(index)) {
        hasCompletedToolUse = true
      }
    } else if (type === 'message_delta') {
      observeIterations(asRecord(data?.usage))
      const delta = asRecord(data?.delta)
      const stopReason = stringField(delta, 'stop_reason')
      if (stopReason) complete(stopReason)
      let usageMarker = ''
      if (
        stopReason &&
        !usageMarkerEmitted &&
        maxBlockIndex < Number.MAX_SAFE_INTEGER
      ) {
        const signature = usageMarkerSignature(asRecord(data?.usage))
        if (signature) {
          usageMarkerEmitted = true
          const index = ++maxBlockIndex
          usageMarker =
            hiddenThinkingFrames(
              index,
              SERVER_FALLBACK_USAGE_MARKER_TEXT,
              signature,
            ) +
            sseFrame('content_block_stop', {
              type: 'content_block_stop',
              index,
            })
        }
      }
      if (
        stopReason === 'refusal' &&
        hasCompletedToolUse &&
        openToolUseIndexes.size === 0 &&
        delta &&
        options.onRefusalAfterToolUse &&
        options.onRefusalAfterToolUse() !== false
      ) {
        delta.stop_reason = 'tool_use'
        return `${usageMarker}${parsed.event ? `event: ${parsed.event}\n` : ''}${data ? `data: ${JSON.stringify(data)}\n` : ''}${boundary}`
      }
      return usageMarker + rawEvent + boundary
    }
    return rawEvent + boundary
  }

  const drain = () => {
    let output = ''
    while (true) {
      const boundary = findSseBoundary(pending)
      if (!boundary) break
      const rawEvent = pending.slice(0, boundary.index)
      const delimiter = pending.slice(
        boundary.index,
        boundary.index + boundary.length,
      )
      pending = pending.slice(boundary.index + boundary.length)
      pendingBytes = new TextEncoder().encode(pending).byteLength
      output += rewriteEvent(rawEvent, delimiter)
    }
    return output
  }

  return {
    pendingLength() {
      return pendingBytes
    },
    push(text: string) {
      let output = ''
      if (resync) {
        const window = resyncCarry + text
        const boundary = findSseBoundary(window)
        if (!boundary) {
          resyncCarry = window.slice(-3)
          return text
        }
        const end = boundary.index + boundary.length
        output = text.slice(0, Math.max(0, end - resyncCarry.length))
        text = window.slice(end)
        resync = false
        resyncCarry = ''
      }
      if (!text) return output
      const textBytes = new TextEncoder().encode(text).byteLength
      pending += text
      pendingBytes += textBytes
      output += drain()
      if (
        options.maxPendingBytes !== undefined &&
        pendingBytes > options.maxPendingBytes
      ) {
        const tail = pending
        pending = ''
        pendingBytes = 0
        resync = true
        resyncCarry = tail.slice(-3)
        return output + tail
      }
      return output
    },
    flush() {
      if (resync) {
        resyncCarry = ''
        return ''
      }
      const output = drain()
      if (!pending) return output
      const tail = rewriteEvent(pending, '')
      pending = ''
      pendingBytes = 0
      return output + tail
    },
  }
}
