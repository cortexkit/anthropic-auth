import { beforeEach, describe, expect, test } from 'bun:test'
import {
  buildFastModeStatusSummary,
  executeFastModeCommand,
  isFastModeEnabled,
  parseFastModeCommandAction,
  resetFastModeState,
  setFastModeEnabled,
} from '@cortexkit/anthropic-auth-core'

function parseEnabled(summary: string) {
  const enabledMatch = summary.match(/- Enabled: (enabled|disabled)/)
  if (!enabledMatch)
    throw new Error(`Malformed /claude-fast summary:\n${summary}`)
  return enabledMatch[1] === 'enabled'
}

beforeEach(() => {
  resetFastModeState()
})

describe('claude-fast command state', () => {
  test('bare command reports disabled status by default', () => {
    const summary = buildFastModeStatusSummary()

    expect(summary).toContain('## Claude Fast Mode Status')
    expect(parseEnabled(summary)).toBe(false)
    expect(summary).toContain(
      'claude-opus-4-6, claude-opus-4-7, claude-opus-4-8, and claude-opus-5',
    )
  })

  test('on and off render requested state without mutating module state directly', () => {
    const enabledReply = executeFastModeCommand({ argumentsText: 'on' })

    expect(enabledReply).toContain('## Claude Fast Mode Enabled')
    expect(parseEnabled(enabledReply)).toBe(true)
    expect(isFastModeEnabled()).toBe(false)

    const disabledReply = executeFastModeCommand({ argumentsText: 'off' })

    expect(disabledReply).toContain('## Claude Fast Mode Disabled')
    expect(parseEnabled(disabledReply)).toBe(false)
    expect(isFastModeEnabled()).toBe(false)
  })

  test('invalid arguments return usage without mutating state', () => {
    setFastModeEnabled(true)

    const reply = executeFastModeCommand({ argumentsText: 'on now' })

    expect(reply).toContain('## Claude Fast Mode Usage')
    expect(reply).toContain(
      'Usage: `/claude-fast`, `/claude-fast on`, or `/claude-fast off`.',
    )
    expect(parseEnabled(reply)).toBe(true)
    expect(isFastModeEnabled()).toBe(true)
  })

  test('parses actions', () => {
    expect(parseFastModeCommandAction('')).toEqual({ type: 'status' })
    expect(parseFastModeCommandAction('on')).toEqual({ type: 'enable' })
    expect(parseFastModeCommandAction('off')).toEqual({ type: 'disable' })
    expect(parseFastModeCommandAction('bogus')).toEqual({ type: 'usage' })
  })
})
