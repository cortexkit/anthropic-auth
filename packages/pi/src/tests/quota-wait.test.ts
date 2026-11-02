import { expect, test } from 'bun:test'
import { createQuotaRefusalResponse } from '@cortexkit/anthropic-auth-core'
import {
  type AssistantMessage,
  isRetryableAssistantError,
} from '@earendil-works/pi-ai'
import {
  markPiAccountHold,
  type PiQuotaWaitOptions,
  withPiQuotaWait,
} from '../quota-wait.ts'

class Clock {
  readonly now = Date.parse('2026-11-02T10:00:00Z')
  readonly scheduled = Promise.withResolvers<void>()
  readonly messages: (string | undefined)[] = []
  delay?: number
  callback?: () => void
  cleared = false
  readonly options: PiQuotaWaitOptions = {
    now: () => this.now,
    setWorkingMessage: (message) => this.messages.push(message),
    setTimeout: ((callback: () => void, ms: number) => {
      this.delay = ms
      this.callback = callback
      this.scheduled.resolve()
      return 1
    }) as unknown as typeof setTimeout,
    clearTimeout: (() => {
      this.cleared = true
      this.callback = undefined
    }) as unknown as typeof clearTimeout,
  }
}

const hold = (now: number) =>
  markPiAccountHold(
    new Response(null, { status: 429, headers: { 'retry-after': '120' } }),
    {
      accountId: 'main',
      accountIdentity: 'current',
      resetAt: now + 120_000,
    },
  )

test('Pi waits inside the stream and resumes the same account after showing and clearing its message', async () => {
  const clock = new Clock()
  let sends = 0
  const result = withPiQuotaWait({
    run: async () => hold(clock.now),
    resume: async (account) => {
      expect(account).toMatchObject({
        accountId: 'main',
        accountIdentity: 'current',
      })
      sends++
      return new Response('served')
    },
    wait: clock.options,
  })
  await clock.scheduled.promise
  expect(sends).toBe(0)
  expect(clock.delay).toBe(120_000)
  expect(clock.messages[0]).toMatch(
    /^Waiting for the account to reset at \d\d:\d\d · Esc to cancel$/,
  )
  clock.callback?.()
  expect(await (await result).text()).toBe('served')
  expect(sends).toBe(1)
  expect(clock.messages.at(-1)).toBeUndefined()
})

test('Escape aborts the wait immediately with no resumed send and clears the working message', async () => {
  const clock = new Clock()
  const abort = new AbortController()
  let sends = 0
  const result = withPiQuotaWait({
    run: async () => hold(clock.now),
    resume: async () => {
      sends++
      return new Response()
    },
    signal: abort.signal,
    wait: clock.options,
  })
  await clock.scheduled.promise
  abort.abort()
  await expect(result).rejects.toMatchObject({ name: 'AbortError' })
  expect(sends).toBe(0)
  expect(clock.cleared).toBe(true)
  expect(clock.messages.at(-1)).toBeUndefined()
})

test('a capped pool refusal rechecks once and its final error does not match the installed Pi retry classifier', async () => {
  const clock = new Clock()
  let rechecks = 0
  const refusal = () =>
    createQuotaRefusalResponse(
      'No OAuth account currently satisfies sticky-balanced quota policy.',
      { resetAt: clock.now + 3_600_000, retryAfterSeconds: 900 },
      clock.now,
    )
  const result = withPiQuotaWait({
    run: async () => refusal(),
    resume: async (account) => {
      expect(account).toBeUndefined()
      rechecks++
      return refusal()
    },
    wait: clock.options,
  })
  await clock.scheduled.promise
  expect(rechecks).toBe(0)
  expect(clock.delay).toBe(900_000)
  clock.callback?.()
  const final = await result
  expect(rechecks).toBe(1)
  expect(final.status).toBe(412)
  expect(final.headers.has('retry-after')).toBe(false)
  const message = `Anthropic request failed: HTTP ${final.status} ${await final.text()}`
  expect(
    isRetryableAssistantError({
      stopReason: 'error',
      errorMessage: message,
    } as AssistantMessage),
  ).toBe(false)
  expect(message).toContain('Reset at ')
})

test('zero wait never schedules a timer or rechecks', async () => {
  const clock = new Clock()
  const response = createQuotaRefusalResponse(
    'No OAuth account currently satisfies sticky-balanced quota policy.',
    { resetAt: clock.now + 120_000, retryAfterSeconds: undefined },
    clock.now,
  )
  expect(
    await withPiQuotaWait({
      run: async () => response,
      resume: async () => {
        throw new Error('unexpected recheck')
      },
      wait: clock.options,
    }),
  ).toBe(response)
  expect(clock.delay).toBeUndefined()
  expect(clock.messages).toEqual([])
})
