import { expect, test } from 'bun:test'
import {
  createQuotaRefusalResponse,
  quotaRefusalTiming,
} from '@cortexkit/anthropic-auth-core'
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
    /^Checking account availability in 2 minutes \(reset at \d\d:\d\d UTC\) · Esc to cancel$/,
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

for (const evidence of ['unknown', 'stale'] as const) {
  test(`Pi immediately refuses ${evidence} reset evidence without a timer or working message`, async () => {
    const now = Date.parse('2026-11-02T10:00:00Z')
    const checkedAt = now - 3_600_000
    const timing = quotaRefusalTiming({
      now,
      readings:
        evidence === 'unknown'
          ? []
          : [
              {
                accountIdentity: 'current',
                quota: {
                  accountIdentity: 'current',
                  five_hour: {
                    usedPercent: 100,
                    remainingPercent: 0,
                    checkedAt,
                    resetsAt: new Date(now + 3_600_000).toISOString(),
                  },
                  seven_day: {
                    usedPercent: 100,
                    remainingPercent: 0,
                    checkedAt,
                    resetsAt: new Date(now + 4 * 24 * 3_600_000).toISOString(),
                  },
                },
              },
            ],
    })
    expect(timing).toEqual({ resetAt: undefined, retryAfterSeconds: 300 })
    const response = createQuotaRefusalResponse(
      'Killswitch blocked all OAuth routes',
      timing,
      now,
    )
    expect(response.headers.get('retry-after')).toBe('300')
    let timers = 0
    let rechecks = 0
    const messages: (string | undefined)[] = []
    const final = await withPiQuotaWait({
      run: async () => response,
      resume: async () => {
        rechecks++
        return new Response()
      },
      wait: {
        now: () => now,
        setWorkingMessage: (message) => messages.push(message),
        setTimeout: (() => {
          timers++
          throw new Error('unexpected blind wait')
        }) as unknown as typeof setTimeout,
      },
    })
    expect(timers).toBe(0)
    expect(rechecks).toBe(0)
    expect(messages).toEqual([])
    expect(final.status).toBe(412)
    expect(final.headers.has('retry-after')).toBe(false)
    const message = `Anthropic request failed: HTTP ${final.status} ${await final.text()}`
    expect(message).toContain('Reset time is unknown.')
    expect(
      isRetryableAssistantError({
        stopReason: 'error',
        errorMessage: message,
      } as AssistantMessage),
    ).toBe(false)
  })
}

test('host retry cap bounds Pi unconfirmed sticky retain upstream 93151s headers without a blind wait', async () => {
  const response = await withPiQuotaWait({
    run: async () =>
      new Response('provider limit', {
        status: 429,
        headers: { 'retry-after': '93151', 'retry-after-ms': '93151000' },
      }),
    resume: async () => {
      throw new Error('unexpected upstream retry')
    },
  })
  expect(response.headers.get('retry-after')).toBe('900')
  expect(response.headers.get('retry-after-ms')).toBe('900000')
})

test('host retry cap keeps Pi to one bounded wait and one recheck for a 26-hour pool reset', async () => {
  const clock = new Clock()
  let rechecks = 0
  const refusal = () =>
    createQuotaRefusalResponse(
      'No eligible route.',
      {
        resetAt: clock.now + 26 * 3_600_000,
        retryAfterSeconds: 26 * 3600,
        limitName: 'weekly',
      },
      clock.now,
    )
  const result = withPiQuotaWait({
    run: async () => refusal(),
    resume: async () => {
      rechecks++
      return refusal()
    },
    wait: clock.options,
  })
  await clock.scheduled.promise
  expect(clock.delay).toBe(900_000)
  expect(rechecks).toBe(0)
  clock.callback?.()
  const final = await result
  expect(rechecks).toBe(1)
  expect(final.status).toBe(412)
  expect(final.headers.has('retry-after')).toBe(false)
  const message = await final.text()
  expect(message).toContain('weekly limit')
  expect(message).toContain('12:00 UTC (in 26 h)')
  expect(message).toContain('Send the message again after that.')
  expect(message).not.toContain('Retrying')
  expect(
    isRetryableAssistantError({
      stopReason: 'error',
      errorMessage: `HTTP 412 ${message}`,
    } as AssistantMessage),
  ).toBe(false)
})

test('host retry cap bounds Pi marked holds independently of the response producer', async () => {
  const clock = new Clock()
  const result = withPiQuotaWait({
    run: async () =>
      markPiAccountHold(
        new Response(null, {
          status: 429,
          headers: { 'retry-after': '93151', 'retry-after-ms': '93151000' },
        }),
        {
          accountId: 'main',
          accountIdentity: 'current',
          resetAt: clock.now + 93_151_000,
        },
      ),
    resume: async () => new Response('available'),
    wait: clock.options,
  })
  await clock.scheduled.promise
  expect(clock.delay).toBe(900_000)
  clock.callback?.()
  expect(await (await result).text()).toBe('available')
})
