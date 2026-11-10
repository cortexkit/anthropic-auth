import { randomUUID } from 'node:crypto'
import {
  type BillingUsage,
  type ReportRoutingInput,
  reportRouting,
} from '@cortexkit/common-auth/routing-accessor'

type BillingReport = Extract<ReportRoutingInput, { kind: 'billing' }>
export type AnthropicBillingRequest = Omit<
  BillingReport,
  | 'kind'
  | 'attemptId'
  | 'provider'
  | 'outcome'
  | 'status'
  | 'providerRequestId'
  | 'providerResponseId'
  | 'usage'
  | 'usageByModel'
> & { attemptId?: string }

function record(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value))
    return value as Record<string, unknown>
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined
}

function usageCounts(raw: Record<string, unknown>): BillingUsage {
  const usage: BillingUsage = {}
  for (const [from, to] of [
    ['input_tokens', 'input'],
    ['output_tokens', 'output'],
    ['cache_read_input_tokens', 'cacheRead'],
    ['cache_creation_input_tokens', 'cacheWrite'],
  ] as const) {
    const value = count(raw[from])
    if (value !== undefined) usage[to] = value
  }
  const creation = record(raw.cache_creation)
  const short = count(creation?.ephemeral_5m_input_tokens)
  const long = count(creation?.ephemeral_1h_input_tokens)
  if (short !== undefined) usage.cacheWrite5m = short
  if (long !== undefined) usage.cacheWrite1h = long
  if (short !== undefined || long !== undefined)
    usage.cacheWrite = (short ?? 0) + (long ?? 0)
  const thinking = count(record(raw.output_tokens_details)?.thinking_tokens)
  if (thinking !== undefined) {
    usage.reasoning = thinking
    usage.reasoningIncludedInOutput = true
  }
  return usage
}

function addUsage(total: BillingUsage, usage: BillingUsage) {
  for (const field of [
    'input',
    'output',
    'cacheRead',
    'cacheWrite',
    'cacheWrite5m',
    'cacheWrite1h',
    'reasoning',
  ] as const) {
    const value = usage[field]
    if (value !== undefined) total[field] = (total[field] ?? 0) + value
  }
  if (usage.reasoningIncludedInOutput) total.reasoningIncludedInOutput = true
}

/** Iteration usage is the billed sum; top-level usage can describe only the last model. */
export function anthropicBillingUsage(raw: Record<string, unknown>): {
  usage: BillingUsage
  usageByModel?: BillingReport['usageByModel']
} {
  if (!Array.isArray(raw.iterations)) return { usage: usageCounts(raw) }
  const usage: BillingUsage = {}
  const byModel = new Map<string, BillingUsage>()
  for (const item of raw.iterations) {
    const iteration = record(item)
    if (!iteration) continue
    const counts = usageCounts(iteration)
    addUsage(usage, counts)
    if (typeof iteration.model === 'string') {
      const modelUsage = byModel.get(iteration.model) ?? {}
      addUsage(modelUsage, counts)
      byModel.set(iteration.model, modelUsage)
    }
  }
  return {
    usage,
    usageByModel: [...byModel].map(([modelUsed, modelUsage]) => ({
      modelUsed,
      usage: modelUsage,
    })),
  }
}

function hasRoutingAccessor() {
  try {
    return (
      typeof Reflect.get(globalThis, Symbol.for('cortexkit.routing')) ===
      'function'
    )
  } catch {
    return false
  }
}

function detachReport(report: BillingReport) {
  if (!hasRoutingAccessor()) return
  // Routing's report callback may never settle; request handling never awaits it.
  setTimeout(() => {
    try {
      reportRouting(report)
    } catch {}
  }, 0).unref?.()
}

function identity(input: AnthropicBillingRequest) {
  return {
    ...input,
    kind: 'billing' as const,
    provider: 'anthropic',
    attemptId: input.attemptId ?? randomUUID(),
  }
}

export function reportAnthropicBillingFailure(input: AnthropicBillingRequest) {
  detachReport({ ...identity(input), cache: undefined, outcome: 'failed' })
}

/** One collector per physical upstream response, including relay responses. */
export function createAnthropicBillingObserver(
  input: AnthropicBillingRequest,
  status: number,
  headers: Headers,
  sse = headers.get('content-type')?.includes('text/event-stream') ?? false,
) {
  const base = {
    ...identity(input),
    status,
    providerRequestId: headers.get('request-id') ?? undefined,
  }
  let sent = false
  let finalUsage = false
  let failed = status >= 400
  let providerResponseId: string | undefined
  let rawUsage: Record<string, unknown> = {}
  const finish = () => {
    if (sent) return
    sent = true
    const measured = anthropicBillingUsage(rawUsage)
    // message_start's zero output is not a measurement of a cut-off answer.
    if (!finalUsage) delete measured.usage.output
    detachReport({
      ...base,
      cache: failed ? undefined : base.cache,
      providerResponseId,
      outcome: failed ? 'failed' : !finalUsage ? 'cut' : 'completed',
      ...measured,
    })
  }
  const observe = (value: unknown) => {
    const event = record(value)
    if (!event) return
    const message = record(event.message) ?? event
    if (typeof message.id === 'string') providerResponseId = message.id
    const usage = record(message.usage)
    if (usage) rawUsage = { ...rawUsage, ...usage }
    if (event.type === 'error') failed = true
    if (event.type === 'message_delta' && usage) finalUsage = true
    if (event.type === 'message' && usage) finalUsage = true
    if (event.type === 'message_stop') finish()
  }
  const decoder = new TextDecoder()
  const maxPending = 1_048_576
  let pending = ''
  let overflow = false
  const parse = (text: string) => {
    try {
      const value = JSON.parse(text)
      observe(value)
      if (!sse && record(record(value)?.usage)) finalUsage = true
    } catch {}
  }
  const consume = (chunk: Uint8Array) => {
    const text = decoder.decode(chunk, { stream: true })
    if (!sse) {
      if (pending.length + text.length <= maxPending) pending += text
      else overflow = true
      return
    }
    for (const part of text.split(/(?<=\n)/)) {
      if (pending.length + part.length > maxPending) overflow = true
      if (!overflow) pending += part
      if (part.endsWith('\n')) {
        if (!overflow && pending.startsWith('data:'))
          parse(pending.slice(5).trim())
        pending = ''
        overflow = false
      }
    }
  }
  return {
    push: consume,
    finish() {
      if (!sse && !overflow) parse(pending + decoder.decode())
      finish()
    },
  }
}

/** Observe only consumed response bytes: no tee, background drain or prompt logging. */
export function observeAnthropicBillingResponse(
  input: AnthropicBillingRequest,
  response: Response,
): Response {
  if (!hasRoutingAccessor()) return response
  const observer = createAnthropicBillingObserver(
    input,
    response.status,
    response.headers,
  )
  if (!response.ok || !response.body) {
    observer.finish()
    return response
  }
  const reader = response.body.getReader()
  const body = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          const next = await reader.read()
          if (next.done) {
            observer.finish()
            controller.close()
            reader.releaseLock()
          } else {
            observer.push(next.value)
            controller.enqueue(next.value)
          }
        } catch (error) {
          observer.finish()
          controller.error(error)
          reader.releaseLock()
        }
      },
      cancel(reason) {
        observer.finish()
        return reader.cancel(reason)
      },
    },
    { highWaterMark: 0 },
  )
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  })
}

/** Call only at the physical send boundary, after authorization and local admission. */
export async function withAnthropicBilling(
  input: AnthropicBillingRequest,
  send: () => Promise<Response>,
): Promise<Response> {
  let response: Response
  try {
    response = await send()
  } catch (error) {
    reportAnthropicBillingFailure(input)
    throw error
  }
  return observeAnthropicBillingResponse(input, response)
}
