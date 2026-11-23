import type { Context, Model, SimpleStreamOptions } from '@earendil-works/pi-ai'
import { stream } from '@earendil-works/pi-ai/api/anthropic-messages'
import { normalizeContext } from '@earendil-works/pi-ai/utils/transcript'
import type { AnthropicRequestBody } from '../convert.ts'

// Pi's dist/api/anthropic-messages.js places markers in buildParams,
// convertMessages and convertTools; getBetaFeatures adds no retention beta.
export async function captureNativeAnthropicCacheRequest(
  model: Model<'anthropic-messages'>,
  context: Context,
  options: SimpleStreamOptions,
) {
  let request: { body: AnthropicRequestBody; headers: Headers } | undefined
  const result = await stream(model, normalizeContext(context), {
    ...options,
    apiKey: 'synthetic-native-pi-key',
    fetch: Object.assign(
      async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const wire =
          input instanceof Request
            ? new Request(input, init)
            : new Request(String(input), init)
        request = {
          body: (await wire.json()) as AnthropicRequestBody,
          headers: wire.headers,
        }
        return new Response(
          [
            { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
            { type: 'message_stop' },
          ]
            .map(
              (event) =>
                `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
            )
            .join(''),
          { headers: { 'content-type': 'text/event-stream' } },
        )
      },
      { preconnect: globalThis.fetch.preconnect },
    ),
  }).result()
  if (!request || result.stopReason !== 'stop')
    throw new Error(
      `Native Pi request did not complete: ${result.errorMessage}`,
    )
  return request
}
