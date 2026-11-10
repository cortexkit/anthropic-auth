import { expect, test } from 'bun:test'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CLAUDE_MODEL_CAPABILITIES } from '@cortexkit/anthropic-auth-core'
import { rewriteRequestBody } from '../transform'

const baselinePath = join(
  import.meta.dir,
  'fixtures',
  'pre-mythos-5-2-requests.json',
)

// Adding block_binding changes the signed body's billing checksum as well.
// These golden checksums cover the only permitted byte differences besides
// the explicit binding field; every other model keeps its original checksum.
const bindingChecksums: Record<string, string> = {
  drop_block: '2b441',
  error: '1faa6',
  'forced/drop_block': '0a6ee',
  'forced/error': '6042b',
}

async function renderRequests() {
  const requests: Record<string, Record<string, string>> = {}
  for (const row of CLAUDE_MODEL_CAPABILITIES) {
    if (row.id === 'claude-mythos-5-2') continue
    const shapes: Record<string, unknown> = {
      plain: {},
      adaptive: { thinking: { type: 'adaptive', display: 'summarized' } },
      disabled: { thinking: { type: 'disabled' } },
      forced: {
        thinking: { type: 'adaptive' },
        tool_choice: { type: 'tool', name: 'board' },
        output_config: { effort: 'max' },
      },
    }
    const rowRequests: Record<string, string> = {}
    requests[row.id] = rowRequests
    for (const [shape, fields] of Object.entries(shapes)) {
      for (const behavior of [
        'account-default',
        'drop_block',
        'error',
      ] as const) {
        rowRequests[`${shape}/${behavior}`] = await rewriteRequestBody(
          JSON.stringify({
            model: row.id,
            max_tokens: 32_000,
            messages: [
              { role: 'user', content: 'Hello' },
              {
                role: 'assistant',
                content: [
                  { type: 'thinking', thinking: 'plan', signature: 'sig-1' },
                  { type: 'text', text: 'Hello' },
                ],
              },
              { role: 'user', content: 'Continue' },
            ],
            ...(fields as Record<string, unknown>),
          }),
          {
            serverSideFallbackEnabled: true,
            fastModeEnabled: true,
            thinkingPrefixMismatchBehavior: behavior,
          },
        )
      }
    }
  }
  return requests
}

test('existing model request bytes change only for explicit Mythos 5.1 binding', async () => {
  const after = await renderRequests()
  if (process.env.MYTHOS_AFTER_REQUESTS_PATH) {
    writeFileSync(
      process.env.MYTHOS_AFTER_REQUESTS_PATH,
      `${JSON.stringify(after, null, 2)}\n`,
    )
  }
  const before = JSON.parse(readFileSync(baselinePath, 'utf8')) as typeof after
  expect(Object.keys(after)).toEqual(Object.keys(before))
  for (const [model, shapes] of Object.entries(before)) {
    for (const [shape, body] of Object.entries(shapes)) {
      if (
        model === 'claude-mythos-5-1' &&
        !shape.endsWith('/account-default')
      ) {
        const expected = JSON.parse(body)
        expected.thinking.block_binding = {
          prefix_mismatch_behavior: shape.split('/')[1],
        }
        const checksum =
          bindingChecksums[
            shape.startsWith('forced/')
              ? shape
              : shape.slice(shape.indexOf('/') + 1)
          ]
        expected.system[0].text = expected.system[0].text.replace(
          /cch=[0-9a-f]{5}/,
          `cch=${checksum}`,
        )
        expect(after[model]?.[shape]).toBe(JSON.stringify(expected))
      } else {
        expect(after[model]?.[shape]).toBe(body)
      }
    }
  }
})
