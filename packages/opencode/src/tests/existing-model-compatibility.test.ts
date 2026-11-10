import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  CLAUDE_MODEL_CAPABILITIES,
  resolveClaudeModelCapabilities,
  selectClaudeCodeBetas,
} from '@cortexkit/anthropic-auth-core'
import { SERVER_SIDE_FALLBACK_BETA } from '../server-fallback'
import { rewriteRequestBody } from '../transform'

// Captured before adding Fable 5.2. Preserve older request bodies and betas;
// Mythos 5.1 deliberately gains effort variants and thinking binding controls.
const snapshotPath = join(
  import.meta.dir,
  'fixtures',
  'pre-fable-5-2-models.json',
)

test('existing model capabilities, request bodies and betas stay byte-identical', async () => {
  const rendered: Record<string, unknown> = {}
  for (const row of CLAUDE_MODEL_CAPABILITIES) {
    if (row.id === 'claude-fable-5-2' || row.id === 'claude-mythos-5-2')
      continue
    const requests: Record<string, unknown> = {}
    for (const thinking of [
      undefined,
      { type: 'adaptive', display: 'summarized' },
      { type: 'disabled' },
    ]) {
      const body = JSON.parse(
        await rewriteRequestBody(
          JSON.stringify({
            model: row.id,
            max_tokens: 32_000,
            messages: [{ role: 'user', content: 'Hello' }],
            thinking,
            tool_choice: { type: 'any' },
          }),
          { serverSideFallbackEnabled: true, fastModeEnabled: true },
        ),
      )
      requests[thinking?.type ?? 'absent'] = {
        body,
        betas: selectClaudeCodeBetas(
          body,
          body.fallbacks ? [SERVER_SIDE_FALLBACK_BETA] : [],
        ),
        auxiliaryBetas: selectClaudeCodeBetas(body, [], 'auxiliary'),
      }
    }
    rendered[row.id] = {
      capabilities: resolveClaudeModelCapabilities(row.id),
      requests,
    }
  }
  const recorded = JSON.parse(readFileSync(snapshotPath, 'utf8'))
  recorded['claude-mythos-5-1'].capabilities.efforts = {
    variants: ['low', 'medium', 'high', 'xhigh', 'max'],
    default: 'high',
  }
  recorded['claude-mythos-5-1'].capabilities.thinkingBindingControls = true
  const serialized = `${JSON.stringify(rendered, null, 2)}\n`
  expect(serialized).toBe(`${JSON.stringify(recorded, null, 2)}\n`)
})
