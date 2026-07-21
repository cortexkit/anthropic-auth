import { afterEach, describe, expect, mock, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type AccountStorage,
  PRIME_DUE_OFFSET_MS,
  PrimeManager,
  type PrimeManagerOptions,
} from '@cortexkit/anthropic-auth-core'

import { adoptPrimeManager } from '../prime-manager-registry.ts'

const tempDirs: string[] = []
const managers: PrimeManager[] = []
const originalSetInterval = globalThis.setInterval
const originalClearInterval = globalThis.clearInterval

afterEach(async () => {
  for (const manager of managers.splice(0)) manager.stop()
  globalThis.setInterval = originalSetInterval
  globalThis.clearInterval = originalClearInterval
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  )
})

function storage(reset: number): AccountStorage {
  return {
    version: 1,
    main: { type: 'opencode', provider: 'anthropic' },
    fallbackOn: [401, 403, 429],
    accounts: [],
    prime: { enabled: true },
    quota: {
      enabled: true,
      checkIntervalMinutes: 5,
      minimumRemaining: { five_hour: 10, seven_day: 20 },
      failClosedOnUnknownQuota: true,
      mainQuota: {
        five_hour: {
          usedPercent: 0,
          remainingPercent: 100,
          resetsAt: new Date(reset).toISOString(),
          checkedAt: 1,
        },
      },
    },
  }
}

function options(input: {
  storagePath: string
  markerDir: string
  reset: number
  send: () => void
}): PrimeManagerOptions {
  const snapshot = storage(input.reset)
  return {
    storagePath: input.storagePath,
    markerDir: input.markerDir,
    getAccountFingerprint: async () => '0123456789abcdef',
    now: () => input.reset + PRIME_DUE_OFFSET_MS,
    loadStorage: async () => snapshot,
    refreshQuota: async () => ({
      quota: snapshot.quota!.mainQuota!,
      fresh: true,
    }),
    sendPrime: async () => {
      input.send()
      return { ok: true, status: 200, ms: 1 }
    },
    recordSuccess: async () => ({
      count: 1,
      inputTokens: 0,
      outputTokens: 0,
      since: input.reset,
    }),
  }
}

async function markerRoot(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'prime-registry-test-'))
  tempDirs.push(directory)
  return directory
}

function adopt(
  storagePath: string,
  create: () => PrimeManager,
  slot: string,
  rebind: (manager: PrimeManager) => void,
): PrimeManager {
  return adoptPrimeManager(storagePath, create, {
    slot,
    rebind,
  })
}

describe('prime manager registry lifecycle', () => {
  test('same-path adoption rebinds current closures before the next fire', async () => {
    const root = await markerRoot()
    const reset = Date.now() - PRIME_DUE_OFFSET_MS
    const path = join(root, 'accounts.json')
    let firstCalls = 0
    let secondCalls = 0
    const firstOptions = options({
      storagePath: path,
      markerDir: root,
      reset,
      send: () => {
        firstCalls += 1
      },
    })
    const secondOptions = options({
      storagePath: path,
      markerDir: root,
      reset,
      send: () => {
        secondCalls += 1
      },
    })
    const first = adopt(
      path,
      () => {
        const manager = new PrimeManager(firstOptions)
        managers.push(manager)
        return manager
      },
      'project-a',
      (manager) => manager.updateOptions(firstOptions),
    )
    const second = adopt(
      path,
      () => {
        throw new Error('same-path adoption constructed a duplicate manager')
      },
      'project-a',
      (manager) => manager.updateOptions(secondOptions),
    )

    expect(second).toBe(first)
    await second.tick()
    expect(firstCalls).toBe(0)
    expect(secondCalls).toBe(1)
  })

  test('different-path reload stops and evicts the previous slot manager', async () => {
    const root = await markerRoot()
    const reset = Date.now() - PRIME_DUE_OFFSET_MS
    const firstPath = join(root, 'first.json')
    const secondPath = join(root, 'second.json')
    const firstOptions = options({
      storagePath: firstPath,
      markerDir: root,
      reset,
      send() {},
    })
    const secondOptions = options({
      storagePath: secondPath,
      markerDir: root,
      reset,
      send() {},
    })
    const first = adopt(
      firstPath,
      () => {
        const manager = new PrimeManager(firstOptions)
        managers.push(manager)
        return manager
      },
      'project-reload',
      (manager) => manager.updateOptions(firstOptions),
    )
    first.start()
    const second = adopt(
      secondPath,
      () => {
        const manager = new PrimeManager(secondOptions)
        managers.push(manager)
        return manager
      },
      'project-reload',
      (manager) => manager.updateOptions(secondOptions),
    )

    expect(second).not.toBe(first)
    expect(first.isStopped()).toBe(true)
  })

  test('same-path adoption does not create a duplicate interval', async () => {
    let intervalCalls = 0
    globalThis.setInterval = mock(() => {
      intervalCalls += 1
      return { unref() {} } as unknown as ReturnType<typeof setInterval>
    }) as unknown as typeof setInterval
    globalThis.clearInterval = mock(() => {}) as unknown as typeof clearInterval
    const root = await markerRoot()
    const path = join(root, 'accounts.json')
    const managerOptions = options({
      storagePath: path,
      markerDir: root,
      reset: Date.now(),
      send() {},
    })
    const first = adopt(
      path,
      () => {
        const manager = new PrimeManager(managerOptions)
        managers.push(manager)
        return manager
      },
      'project-timer',
      (manager) => manager.updateOptions(managerOptions),
    )
    first.start()
    const second = adopt(
      path,
      () => {
        throw new Error('same-path adoption constructed a duplicate manager')
      },
      'project-timer',
      (manager) => manager.updateOptions(managerOptions),
    )
    second.start()

    expect(second).toBe(first)
    expect(intervalCalls).toBe(1)
  })
})
