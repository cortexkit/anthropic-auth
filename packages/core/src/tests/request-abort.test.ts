import { describe, expect, test } from 'bun:test'
import { abortableFetch, raceWithSignal } from '../request-abort.ts'

describe('request abort boundary', () => {
  test('rejects with the caller reason even if work never settles', async () => {
    const controller = new AbortController()
    const reason = new Error('header timeout')
    const pending = raceWithSignal(
      controller.signal,
      () => new Promise(() => {}),
    )
    controller.abort(reason)
    await expect(pending).rejects.toBe(reason)
  })

  test('does not start work for an already aborted caller', async () => {
    const controller = new AbortController()
    controller.abort('cancelled')
    let started = false
    await expect(
      raceWithSignal(controller.signal, async () => {
        started = true
      }),
    ).rejects.toBe('cancelled')
    expect(started).toBe(false)
  })

  test('shared work can finish after its caller leaves', async () => {
    const controller = new AbortController()
    let finish!: () => void
    const work = new Promise<void>((resolve) => {
      finish = resolve
    })
    const pending = raceWithSignal(controller.signal, () => work)
    await Promise.resolve()
    controller.abort('cancelled')
    await expect(pending).rejects.toBe('cancelled')
    finish()
    await work
  })

  test('fetch inherits a Request signal', async () => {
    const controller = new AbortController()
    const send = abortableFetch(async () => new Promise<Response>(() => {}))
    const pending = send(
      new Request('https://example.com', { signal: controller.signal }),
    )
    controller.abort('cancelled')
    await expect(pending).rejects.toBe('cancelled')
  })

  test('an explicit init signal, including null, overrides the Request signal', async () => {
    const controller = new AbortController()
    controller.abort('request cancelled')
    const input = new Request('https://example.com', {
      signal: controller.signal,
    })
    const send = abortableFetch(async () => new Response('ok'))
    for (const signal of [null, new AbortController().signal]) {
      expect(await (await send(input, { signal })).text()).toBe('ok')
    }
  })
})
