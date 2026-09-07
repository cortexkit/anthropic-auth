import { expect, test } from 'bun:test'

import { QuotaManager } from '../quota-manager.ts'

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve
  })
  return { promise, resolve }
}

const quotaResponse = {
  five_hour: { utilization: 4 },
  seven_day: { utilization: 13 },
  extra_usage: { is_enabled: false, monthly_limit: null, used_credits: null },
  spend: null,
}

test('a completed older main request does not clear a newer in-flight refresh', async () => {
  const firstStarted = deferred()
  const releaseFirst = deferred()
  const secondStarted = deferred()
  const releaseSecond = deferred()
  let fetches = 0
  const manager = new QuotaManager({
    storage: null,
    fetchImpl: (async () => {
      fetches += 1
      if (fetches === 1) {
        firstStarted.resolve()
        await releaseFirst.promise
      } else if (fetches === 2) {
        secondStarted.resolve()
        await releaseSecond.promise
      }
      return Response.json(quotaResponse)
    }) as typeof fetch,
  })

  const first = manager.refreshMainWithMetadata('main', 'token-a')
  await firstStarted.promise
  const second = manager.refreshMainWithMetadata('main', 'token-b')
  releaseFirst.resolve()
  await secondStarted.promise
  const joinedSecond = manager.refreshMainWithMetadata('main', 'token-b')
  releaseSecond.resolve()

  await Promise.all([first, second, joinedSecond])

  expect(fetches).toBe(2)
})
