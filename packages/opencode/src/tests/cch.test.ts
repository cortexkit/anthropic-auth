import { describe, expect, test } from 'bun:test'
import {
  buildBillingHeaderValue,
  computeCCH,
  computeCcVersionSuffix,
  extractFirstUserMessageText,
  signRequestBody,
} from '@cortexkit/anthropic-auth-core'

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

  test('starts suffix sampling at the command name after leading reminders', () => {
    expect(
      extractFirstUserMessageText([
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: '<system-reminder>ignore this</system-reminder>',
            },
            {
              type: 'text',
              text: '<command-name>help</command-name>\nshow help',
            },
          ],
        },
      ]),
    ).toBe('<command-name>help</command-name>\nshow help')
  })

  test('computes the 5-character body cch hash', async () => {
    expect(
      await computeCCH(new TextEncoder().encode('hello world test message')),
    ).toBe('cc124')
  })

  test('computes the version suffix from the first user text', () => {
    expect(computeCcVersionSuffix('hello world test message', '2.1.257')).toBe(
      '500',
    )
    expect(computeCcVersionSuffix('hella world test message', '2.1.257')).toBe(
      '855',
    )
  })

  test('zero-pads missing sampled text positions', () => {
    expect(computeCcVersionSuffix('short', '2.1.257')).toBe('84d')
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

    expect(await signRequestBody(body)).toContain('cch=12a77;')
  })

  test('signing an already-signed body is idempotent', async () => {
    const body = JSON.stringify({
      messages: [{ role: 'user', content: 'hello' }],
      system: [
        {
          type: 'text',
          text: 'x-anthropic-billing-header: cc_version=2.1.257.123; cc_entrypoint=cli; cch=00000;',
        },
      ],
    })
    const signed = await signRequestBody(body)

    expect(await signRequestBody(signed)).toBe(signed)
  })

  test('uses the empty-text suffix for empty and non-text first-user shapes', () => {
    const expected = computeCcVersionSuffix('', '2.1.257')

    expect(buildBillingHeaderValue([], '2.1.257', 'cli')).toContain(
      `cc_version=2.1.257.${expected};`,
    )
    expect(
      buildBillingHeaderValue(
        [{ role: 'assistant', content: 'no user' }],
        '2.1.257',
        'cli',
      ),
    ).toContain(`cc_version=2.1.257.${expected};`)
    expect(
      buildBillingHeaderValue(
        [
          {
            role: 'user',
            content: [{ type: 'image', text: 'ignored' }],
          },
        ],
        '2.1.257',
        'cli',
      ),
    ).toContain(`cc_version=2.1.257.${expected};`)
  })

  test('canonical cch ignores model and max_tokens but keeps fallbacks', async () => {
    const body = {
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'hello' }],
      system: [
        {
          type: 'text',
          text: 'x-anthropic-billing-header: cc_version=2.1.257.123; cc_entrypoint=cli; cch=00000;',
        },
      ],
      max_tokens: 1024,
      fallbacks: ['claude-haiku-4-5'],
    }
    const changed = {
      ...body,
      model: 'claude-opus-4-6',
      max_tokens: 4096,
    }
    const withoutFallbacks: Record<string, unknown> = { ...body }
    delete withoutFallbacks.fallbacks

    const signed = JSON.parse(await signRequestBody(JSON.stringify(body)))
    const changedSigned = JSON.parse(
      await signRequestBody(JSON.stringify(changed)),
    )
    const withoutFallbacksSigned = JSON.parse(
      await signRequestBody(JSON.stringify(withoutFallbacks)),
    )
    expect(changedSigned.system[0].text).toBe(signed.system[0].text)
    expect(withoutFallbacksSigned.system[0].text).not.toBe(
      signed.system[0].text,
    )
  })

  test('signs only the billing header cch and leaves message history unchanged', async () => {
    const historyText = 'historical debug content: cch=abcde; cch=00000;'
    const body = JSON.stringify({
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: historyText }],
        },
      ],
      system: [
        {
          type: 'text',
          text: 'x-anthropic-billing-header: cc_version=2.1.87.623; cc_entrypoint=sdk-cli; cch=00000;',
        },
      ],
    })

    const signed = await signRequestBody(body)
    const parsed = JSON.parse(signed)

    expect(parsed.messages[0].content[0].text).toBe(historyText)
    expect(parsed.system[0].text).toMatch(/cch=[0-9a-f]{5};$/)
    expect(parsed.system[0].text).not.toContain('cch=00000;')
  })

  test('builds the full billing header value', () => {
    expect(
      buildBillingHeaderValue(
        [{ role: 'user', content: 'hello world test message' }],
        '2.1.257',
        'cli',
      ),
    ).toBe(
      'x-anthropic-billing-header: cc_version=2.1.257.500; cc_entrypoint=cli; cch=00000;',
    )
  })
})
