export const SOURCE_MODEL = 'claude-fable-5-2'
export const TARGET_MODEL = 'claude-opus-5'
export const RECOVERY_FAMILY = 'fable-5-2'
export const TARGET_SIGNATURE = 'synthetic-target-signature'
// Base64url SHA-256 of "thinking\0" followed by the target signature.
export const TARGET_DIGEST = 'fA5ue_nVvpCP0bdn9QEqnSKwFt4b0Rmkzup4zgPXa7w'

export function refusalThinkingReply(model: string) {
  const refused = model === SOURCE_MODEL
  const frames = [
    {
      type: 'message_start',
      message: { id: `msg_${model}`, model, usage: { input_tokens: 12 } },
    },
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'thinking', thinking: 'synthetic', signature: '' },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: {
        type: 'signature_delta',
        signature: refused ? 'synthetic-source-signature' : TARGET_SIGNATURE,
      },
    },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'message_delta',
      delta: refused
        ? {
            stop_reason: 'refusal',
            stop_details: {
              type: 'refusal',
              category: 'bio',
              fallback_credit_token: 'synthetic-fallback-credit',
            },
          }
        : { stop_reason: 'end_turn' },
      usage: { output_tokens: 2 },
    },
    { type: 'message_stop' },
  ]
  return new Response(
    frames
      .map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
      .join(''),
    {
      headers: {
        'content-type': 'text/event-stream',
        'anthropic-ratelimit-unified-5h-utilization': '0',
        'anthropic-ratelimit-unified-7d-utilization': '0',
      },
    },
  )
}
