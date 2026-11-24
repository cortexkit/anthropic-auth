import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  CLAUDE_MODEL_CAPABILITIES,
  selectClaudeCodeBetas,
} from '@cortexkit/anthropic-auth-core'
import { SERVER_SIDE_FALLBACK_BETA } from '../server-fallback'
import { rewriteRequestBody } from '../transform'

// Captured before adding Fable 5.2. Keep the recorded request bodies and apply
// only the explicit capability and header changes below to the expected data.
const snapshotPath = join(
  import.meta.dir,
  'fixtures',
  'pre-fable-5-2-models.json',
)

test('existing model request bodies stay byte-identical with only the expected capability and beta updates', async () => {
  const rendered: Record<string, unknown> = {}
  for (const row of CLAUDE_MODEL_CAPABILITIES) {
    if (
      row.id === 'claude-fable-5-2' ||
      row.id === 'claude-mythos-5-2' ||
      row.id === 'claude-opus-4-8'
    )
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
    // These two fields are fallback-only metadata added after the fixture.
    const {
      tokenLimits: _limits,
      refusalFallbacks: _routes,
      ...capabilities
    } = row
    rendered[row.id] = { capabilities, requests }
  }
  const recorded = JSON.parse(readFileSync(snapshotPath, 'utf8'))
  recorded['claude-mythos-5-1'].capabilities.efforts = {
    variants: ['low', 'medium', 'high', 'xhigh', 'max'],
    default: 'high',
  }
  recorded['claude-mythos-5-1'].capabilities.thinkingBindingControls = true
  const addPerTurnControl = (betas: string) =>
    betas.replace(
      'prompt-caching-scope-2026-01-05',
      'prompt-caching-scope-2026-01-05,per-turn-control-2026-07-01',
    )
  for (const [id, effortMarkers] of [
    ['claude-opus-5', 'with-adaptive-thinking'],
    ['claude-mythos-5-1', 'always'],
  ] as const) {
    const model = recorded[id]
    model.capabilities.effortMarkers = effortMarkers
    for (const kind of ['main', 'title', 'quota']) {
      const betas = model.capabilities.claudeCodeBetas
      betas[kind] = addPerTurnControl(betas[kind].join(',')).split(',')
    }
    for (const thinking of ['absent', 'adaptive', 'disabled']) {
      const request = model.requests[thinking]
      request.betas = addPerTurnControl(request.betas)
      request.auxiliaryBetas = addPerTurnControl(request.auxiliaryBetas)
    }
  }
  recorded['claude-haiku-5-5'].capabilities.effortMarkers =
    'with-adaptive-thinking'
  const serialized = `${JSON.stringify(rendered, null, 2)}\n`
  expect(serialized).toBe(`${JSON.stringify(recorded, null, 2)}\n`)
})
