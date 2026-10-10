import { expect, test } from 'bun:test'
import type { NativeMenuDispatchRequest } from '@cortexkit/anthropic-auth-core'
import { createNativeCommand } from '../native-command.ts'

test('native command requires a session and dispatches to the injected backend', async () => {
  const calls: NativeMenuDispatchRequest[] = []
  const command = createNativeCommand({
    host: 'opencode',
    interactive: true,
    dispatch: async (request) => {
      calls.push(request)
      return { ok: true, text: 'reset' }
    },
    readStatus: async (_command, invocation) =>
      `session ${invocation.sessionId}`,
  })
  expect((await command.open('session-a')).menu.command).toBe('claude')
  const result = await command.apply({
    command: 'claude',
    sectionId: 'Routing',
    actionId: 'routing-reset',
    sessionId: 'session-a',
  })
  expect(result.ok).toBe(true)
  expect(calls).toEqual([
    { action: 'routing-reset', values: {}, sessionId: 'session-a' },
  ])
  expect(() => command.open('')).toThrow('sessionId is required')
  expect(() =>
    command.apply({
      command: 'claude',
      sectionId: 'Routing',
      actionId: 'routing-reset',
    }),
  ).toThrow('sessionId is required')
})

test('native command never substitutes success for a failed backend', async () => {
  const command = createNativeCommand({
    host: 'opencode',
    interactive: true,
    dispatch: async () => ({ ok: false, text: 'Backend refused' }),
    readStatus: async () => 'public',
  })
  expect(
    (
      await command.apply({
        command: 'claude',
        sectionId: 'Cache',
        actionId: 'cache-off',
        sessionId: 'a',
      })
    ).ok,
  ).toBe(false)
})
