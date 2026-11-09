import { expect, test } from 'bun:test'
import { createNativeClaudeModelRules } from '../v2/models'

test.each(['claude-fable-5-2', 'claude-fable-5-2-20261109'])(
  'OC2 adds adaptive effort variants to host catalogue model %s',
  (modelID) => {
    const candidate = {
      id: `anthropic/${modelID}`,
      modelID,
      variants: [{ id: 'custom', settings: { effort: 'low' } }],
    }
    const rules = createNativeClaudeModelRules()
    rules.install({
      model: {
        transform: (apply: (editor: unknown) => void) =>
          apply({
            list: () => [candidate],
            update: (
              _provider: string,
              _id: string,
              mutate: (model: typeof candidate) => void,
            ) => mutate(candidate),
          }),
      },
    } as never)
    expect(rules.modelId(candidate.id)).toBe(modelID)
    expect(candidate.variants).toEqual([
      { id: 'custom', settings: { effort: 'low' } },
      ...['low', 'medium', 'high', 'xhigh', 'max'].map((effort) => ({
        id: effort,
        settings: {
          effort,
          thinking: { type: 'adaptive', display: 'summarized' },
        },
      })),
    ])
  },
)
