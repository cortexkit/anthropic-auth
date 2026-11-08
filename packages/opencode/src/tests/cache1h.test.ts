import { beforeEach, describe, expect, test } from 'bun:test'
import {
  buildCache1hStatusSummary,
  executeCache1hCommand,
  getCache1hMode,
  isCache1hEnabled,
  parseCache1hCommandAction,
  resetCache1hState,
  setCache1hEnabled,
  setCache1hMode,
} from '@cortexkit/anthropic-auth-core'
import { rewriteRequestBody } from '../transform.ts'

function parseEnabled(summary: string) {
  const enabledMatch = summary.match(/- Enabled: (enabled|disabled)/)
  if (!enabledMatch)
    throw new Error(`Malformed /claude-cache summary:\n${summary}`)
  return enabledMatch[1] === 'enabled'
}

function parseMode(summary: string) {
  const modeMatch = summary.match(/- Mode: (explicit|automatic|hybrid)/)
  if (!modeMatch)
    throw new Error(`Malformed /claude-cache summary:\n${summary}`)
  return modeMatch[1]
}

beforeEach(() => {
  resetCache1hState()
})

test('session lifetimes override enable but preserve every selected placement mode', async () => {
  const key = Symbol.for('cortexkit.routing')
  const globals = globalThis as Record<symbol, unknown>
  const previous = globals[key]
  try {
    for (const mode of ['explicit', 'automatic', 'hybrid'] as const) {
      for (const ttl of ['none', 'short', 'long'] as const) {
        globals[key] = () => ({ cache: () => ({ ttl, keep_warm: 'off' }) })
        const sent = await rewriteRequestBody(
          JSON.stringify({
            model: 'claude-sonnet-5',
            max_tokens: 10,
            system: [
              {
                type: 'text',
                text: 'Stable',
                cache_control: { type: 'ephemeral', ttl: '1h' },
              },
            ],
            messages: [
              {
                role: 'user',
                content: [
                  {
                    type: 'text',
                    text: 'Hello',
                    cache_control: { type: 'ephemeral', ttl: '1h' },
                  },
                ],
              },
            ],
          }),
          {
            sessionId: 'ses_oc_cache_policy',
            isOAuth: true,
            cache1hEnabled: false,
            cache1hMode: mode,
          },
        )
        const markers: unknown[] = []
        const body = JSON.parse(sent, (key, value: unknown) => {
          if (key === 'cache_control' || key === 'cacheControl')
            markers.push(value)
          return value
        })
        if (ttl === 'none') expect(markers).toEqual([])
        else {
          expect(markers.length).toBeGreaterThan(0)
          expect(markers.length).toBeLessThanOrEqual(4)
          for (const marker of markers)
            expect(marker).toEqual(
              ttl === 'long'
                ? { type: 'ephemeral', ttl: '1h' }
                : { type: 'ephemeral' },
            )
          if (mode === 'automatic') expect(body.cache_control).toBeDefined()
          else expect(body.cache_control).toBeUndefined()
        }
      }
    }
  } finally {
    if (previous === undefined) delete globals[key]
    else globals[key] = previous
  }
})

describe('claude-cache command state', () => {
  test('bare command reports disabled status by default', () => {
    const summary = buildCache1hStatusSummary()

    expect(summary).toContain('## Claude Cache Status')
    expect(parseEnabled(summary)).toBe(false)
    expect(parseMode(summary)).toBe('explicit')
  })

  test('on and off render requested state without mutating module cache directly', () => {
    const enabledReply = executeCache1hCommand({ argumentsText: 'on' })

    expect(enabledReply).toContain('## Claude Cache Enabled')
    expect(parseEnabled(enabledReply)).toBe(true)
    expect(parseMode(enabledReply)).toBe('explicit')
    expect(isCache1hEnabled()).toBe(false)

    const disabledReply = executeCache1hCommand({ argumentsText: 'off' })

    expect(disabledReply).toContain('## Claude Cache Disabled')
    expect(parseEnabled(disabledReply)).toBe(false)
    expect(parseMode(disabledReply)).toBe('explicit')
    expect(isCache1hEnabled()).toBe(false)
  })

  test('mode command renders requested mode without mutating module cache directly', () => {
    setCache1hEnabled(true)
    setCache1hMode('explicit')

    const reply = executeCache1hCommand({ argumentsText: 'mode hybrid' })

    expect(reply).toContain('Mode updated to `hybrid`.')
    expect(parseEnabled(reply)).toBe(true)
    expect(parseMode(reply)).toBe('hybrid')
    expect(getCache1hMode()).toBe('explicit')
  })

  test('invalid arguments return usage without mutating state', () => {
    setCache1hEnabled(true)

    const reply = executeCache1hCommand({ argumentsText: 'on now' })

    expect(reply).toContain('## Claude Cache Usage')
    expect(reply).toContain(
      'Usage: `/claude-cache`, `/claude-cache on`, `/claude-cache off`, or `/claude-cache mode explicit|automatic|hybrid`.',
    )
    expect(parseEnabled(reply)).toBe(true)
    expect(isCache1hEnabled()).toBe(true)
  })

  test('parses actions', () => {
    expect(parseCache1hCommandAction('')).toEqual({ type: 'status' })
    expect(parseCache1hCommandAction('on')).toEqual({ type: 'enable' })
    expect(parseCache1hCommandAction('off')).toEqual({ type: 'disable' })
    expect(parseCache1hCommandAction('mode explicit')).toEqual({
      type: 'mode',
      mode: 'explicit',
    })
    expect(parseCache1hCommandAction('mode automatic')).toEqual({
      type: 'mode',
      mode: 'automatic',
    })
    expect(parseCache1hCommandAction('mode hybrid')).toEqual({
      type: 'mode',
      mode: 'hybrid',
    })
    expect(parseCache1hCommandAction('mode bogus')).toEqual({ type: 'usage' })
    expect(parseCache1hCommandAction('bogus')).toEqual({ type: 'usage' })
  })
})
