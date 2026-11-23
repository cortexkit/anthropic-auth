import { expect, test } from 'bun:test'
import { promptCacheSnapshot } from './prompt-cache-snapshot.ts'

const body = (billing: string) => ({
  system: [{ type: 'text', text: `x-anthropic-billing-header: ${billing}` }],
})
const original = 'cc_version=2.1.302.804; cc_entrypoint=cli; cch=4c6e9;'

test.each([
  ['entrypoint', original.replace('cc_entrypoint=cli', 'cc_entrypoint=sdk')],
  ['version suffix', original.replace('2.1.302.804', '2.1.302.123')],
])(
  'the prompt-cache snapshot detects a changed billing %s',
  (_name, changed) => {
    expect(promptCacheSnapshot(body(changed))).not.toBe(
      promptCacheSnapshot(body(original)),
    )
  },
)

test('the prompt-cache snapshot ignores only the billing signature, lineage and diagnostics', () => {
  expect(
    promptCacheSnapshot({
      ...body(
        `${original.replace('cch=4c6e9', 'cch=5abcd')} cc_prev_req=req_12345678; cc_prompt_id=prompt; cc_turn_origin=human; cc_prompt_index=1; cc_turn_index=1;`,
      ),
      diagnostics: { previous_message_id: 'msg_previous' },
    }),
  ).toBe(
    JSON.stringify(
      body('cc_version=2.1.302.804; cc_entrypoint=cli; cch=00000;'),
    ),
  )
})
