import { describe, expect, test } from 'bun:test'
import {
  buildBillingHeaderValue,
  computeCCH,
  computeVersionSuffix,
  extractFirstUserMessageText,
  signRequestBody,
} from '@marcusrbrown/anthropic-auth-core'

describe('billing header helpers', () => {
  test('extracts text from the first user message', () => {
    expect(
      extractFirstUserMessageText([
        { role: 'assistant', content: 'ignore me' },
        {
          role: 'user',
          content: [
            { type: 'image', text: 'ignored' },
            { type: 'text', text: 'hello world test message' },
          ],
        },
      ]),
    ).toBe('hello world test message')
  })

  test('computes the 5-character body cch hash', async () => {
    expect(
      await computeCCH(new TextEncoder().encode('hello world test message')),
    ).toBe('5236e')
  })

  test('computes a stable daily 3-character version suffix', () => {
    expect(computeVersionSuffix('2.1.87', new Date('2026-04-29'))).toBe('623')
  })

  test('signs serialized request body cch placeholder', async () => {
    const body = JSON.stringify({
      system: [
        {
          type: 'text',
          text: 'x-anthropic-billing-header: cc_version=2.1.87.623; cc_entrypoint=sdk-cli; cch=00000;',
        },
      ],
    })

    expect(await signRequestBody(body)).toContain('cch=59353;')
  })

  test('builds the full billing header value', () => {
    expect(
      buildBillingHeaderValue(
        [{ role: 'user', content: 'hello world test message' }],
        '2.1.87',
        'sdk-cli',
        new Date('2026-04-29'),
      ),
    ).toBe(
      'x-anthropic-billing-header: cc_version=2.1.87.623; cc_entrypoint=sdk-cli; cch=00000;',
    )
  })
})
