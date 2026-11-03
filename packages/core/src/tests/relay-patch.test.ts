import { expect, test } from 'bun:test'
import { createRelayPatch, WORKER_SCRIPT } from '../relay.ts'

const applyPatchSet = new Function(
  WORKER_SCRIPT.replace(/export default[\s\S]*$/, 'return applyPatchSet'),
)() as (base: string, patch: ReturnType<typeof createRelayPatch>) => unknown

for (const change of ['prompt edit', 'effort control'] as const) {
  test(`relay patches reconstruct stateless ${change} before a fixed-position billing cch`, () => {
    const body = (updated: boolean) =>
      JSON.stringify({
        model: 'claude-sonnet-5',
        messages: [
          {
            role: 'user',
            content:
              change === 'prompt edit' && updated
                ? 'next prompt'
                : 'base prompt',
          },
          {
            role: 'system',
            content: [],
            output_config: {
              effort: change === 'effort control' && updated ? 'max' : 'low',
            },
          },
          { role: 'user', content: 'Continue' },
        ],
        system: [
          {
            type: 'text',
            text: `x-anthropic-billing-header: cc_version=2.1.302.abc; cch=${updated ? '22222' : '11111'};`,
          },
        ],
      })
    const previous = body(false)
    const next = body(true)
    expect(previous.indexOf('cch=')).toBe(next.indexOf('cch='))
    expect(JSON.parse(previous).thread).toBeUndefined()
    expect(JSON.parse(next).thread).toBeUndefined()
    const patch = createRelayPatch(previous, next)
    expect(applyPatchSet(previous, patch)).toBe(next)
  })
}
