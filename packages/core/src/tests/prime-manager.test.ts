import { afterEach, describe, expect, test } from 'bun:test'
import {
  mkdtemp,
  readdir,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import type { AccountStorage, OAuthQuotaSnapshot } from '../accounts.ts'
import {
  buildPrimeRequestBody,
  PRIME_DUE_OFFSET_MS,
  PRIME_MARKER_MAX_AGE_MS,
  PrimeManager,
  primeMarkerNamespaceDir,
  primeStorageFingerprint,
} from '../prime.ts'

const tempDirs: string[] = []
const managers: PrimeManager[] = []

afterEach(async () => {
  for (const manager of managers.splice(0)) manager.stop()
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  )
})

function storage(resetsAt?: number): AccountStorage {
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
      ...(resetsAt === undefined
        ? {}
        : {
            mainQuota: {
              five_hour: {
                usedPercent: 0,
                remainingPercent: 100,
                resetsAt: new Date(resetsAt).toISOString(),
                checkedAt: 1,
              },
            },
          }),
    },
  }
}

async function tempMarkerRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'prime-manager-test-'))
  tempDirs.push(dir)
  return dir
}

function manager(input: {
  storagePath: string
  markerDir: string
  now: () => number
  loadStorage: () => Promise<AccountStorage>
  refreshQuota: () => Promise<OAuthQuotaSnapshot>
  sendPrime: () => Promise<void>
  accountFingerprint?: () => Promise<string>
}): PrimeManager {
  const instance = new PrimeManager({
    storagePath: input.storagePath,
    markerDir: input.markerDir,
    now: input.now,
    loadStorage: input.loadStorage,
    getAccountFingerprint:
      input.accountFingerprint ?? (async () => '0123456789abcdef'),
    refreshQuota: async () => ({
      quota: await input.refreshQuota(),
      fresh: true,
    }),
    sendPrime: async () => {
      await input.sendPrime()
      return { ok: true, status: 200, ms: 1 }
    },
    recordSuccess: async () => ({
      count: 1,
      inputTokens: 0,
      outputTokens: 0,
      since: input.now(),
    }),
  } as ConstructorParameters<typeof PrimeManager>[0])
  managers.push(instance)
  return instance
}

describe('PrimeManager storage namespaces', () => {
  test('fingerprints resolved paths without exposing the path', () => {
    const relative = join('.', 'config', 'accounts.json')
    const fingerprint = primeStorageFingerprint(relative)

    expect(fingerprint).toBe(primeStorageFingerprint(resolve(relative)))
    expect(fingerprint).toMatch(/^[a-f0-9]{12}$/)
    expect(fingerprint).not.toContain('config')
  })

  test('symlink and real storage paths share a fingerprint', async () => {
    const directory = await tempMarkerRoot()
    const realPath = join(directory, 'accounts.json')
    const symlinkPath = join(directory, 'linked-accounts.json')
    await writeFile(realPath, '{}', 'utf8')
    await symlink(realPath, symlinkPath)

    expect(primeStorageFingerprint(symlinkPath)).toBe(
      primeStorageFingerprint(realPath),
    )
  })

  test('different storage paths prime the same account and reset independently', async () => {
    const markerDir = await tempMarkerRoot()
    const reset = Date.now() - PRIME_DUE_OFFSET_MS
    let fires = 0
    const make = (storagePath: string) =>
      manager({
        storagePath,
        markerDir,
        now: () => reset + PRIME_DUE_OFFSET_MS,
        loadStorage: async () => storage(reset),
        refreshQuota: async () => storage(reset).quota!.mainQuota!,
        sendPrime: async () => {
          fires += 1
        },
      })

    await make('/config/a/accounts.json').tick()
    await make('/config/b/accounts.json').tick()

    expect(fires).toBe(2)
  })

  test('the same storage path still deduplicates simulated processes', async () => {
    const markerDir = await tempMarkerRoot()
    const reset = Date.now() - PRIME_DUE_OFFSET_MS
    let fires = 0
    const make = () =>
      manager({
        storagePath: '/config/shared/accounts.json',
        markerDir,
        now: () => reset + PRIME_DUE_OFFSET_MS,
        loadStorage: async () => storage(reset),
        refreshQuota: async () => storage(reset).quota!.mainQuota!,
        sendPrime: async () => {
          fires += 1
        },
      })

    await Promise.all([make().tick(), make().tick()])

    expect(fires).toBe(1)
  })

  test('a main OAuth credential switch primes independently and sweeps the old identity', async () => {
    const markerDir = await tempMarkerRoot()
    const storagePath = join(markerDir, 'accounts.json')
    const reset = Date.now() - PRIME_DUE_OFFSET_MS
    let accountFingerprint = 'aaaaaaaaaaaaaaaa'
    let fires = 0
    const mgr = manager({
      storagePath,
      markerDir,
      now: () => reset + PRIME_DUE_OFFSET_MS,
      loadStorage: async () => storage(reset),
      refreshQuota: async () => storage(reset).quota!.mainQuota!,
      accountFingerprint: async () => accountFingerprint,
      sendPrime: async () => {
        fires += 1
      },
    })

    await mgr.tick()
    accountFingerprint = 'bbbbbbbbbbbbbbbb'
    await mgr.tick()

    expect(fires).toBe(2)
    const namespaceDir = primeMarkerNamespaceDir(markerDir, storagePath)
    const oldIdentityDir = join(namespaceDir, 'aaaaaaaaaaaa')
    const newIdentityDir = join(namespaceDir, 'bbbbbbbbbbbb')
    expect(await readdir(oldIdentityDir)).toEqual([`main-${reset}`])
    expect(await readdir(newIdentityDir)).toEqual([`main-${reset}`])

    const oldMarker = join(oldIdentityDir, `main-${reset}`)
    const staleAt = new Date(
      reset + PRIME_DUE_OFFSET_MS - PRIME_MARKER_MAX_AGE_MS - 1,
    )
    await utimes(oldMarker, staleAt, staleAt)
    await mgr.tick()

    expect(await readdir(oldIdentityDir)).toEqual([])
    expect(await readdir(newIdentityDir)).toEqual([`main-${reset}`])
  })

  test('bootstrap sentinels are independent after a main OAuth credential switch', async () => {
    const markerDir = await tempMarkerRoot()
    const storagePath = join(markerDir, 'accounts.json')
    let accountFingerprint = 'aaaaaaaaaaaaaaaa'
    let fires = 0
    const mgr = manager({
      storagePath,
      markerDir,
      now: () => Date.now(),
      loadStorage: async () => storage(),
      refreshQuota: async () => ({}),
      accountFingerprint: async () => accountFingerprint,
      sendPrime: async () => {
        fires += 1
      },
    })

    await mgr.tick()
    accountFingerprint = 'bbbbbbbbbbbbbbbb'
    await mgr.tick()

    expect(fires).toBe(2)
    const namespaceDir = primeMarkerNamespaceDir(markerDir, storagePath)
    expect(await readdir(join(namespaceDir, 'aaaaaaaaaaaa'))).toEqual([
      'main-bootstrap',
    ])
    expect(await readdir(join(namespaceDir, 'bbbbbbbbbbbb'))).toEqual([
      'main-bootstrap',
    ])
  })

  test('bootstrap sentinels do not cross storage namespaces', async () => {
    const markerDir = await tempMarkerRoot()
    let fires = 0
    const make = (storagePath: string) =>
      manager({
        storagePath,
        markerDir,
        now: () => Date.now(),
        loadStorage: async () => storage(),
        refreshQuota: async () => ({}),
        sendPrime: async () => {
          fires += 1
        },
      })

    await make('/config/a/accounts.json').tick()
    await make('/config/b/accounts.json').tick()

    expect(fires).toBe(2)
  })
})

test('PrimeManager walks two complete reset cycles without firing between windows', async () => {
  const markerDir = await tempMarkerRoot()
  const firstReset = Date.UTC(2026, 0, 1, 5)
  const secondReset = Date.UTC(2026, 0, 1, 10)
  let now = firstReset - 1
  let currentStorage = storage(firstReset)
  let refreshedReset = firstReset
  const requestBodies: unknown[] = []
  const mgr = manager({
    storagePath: '/config/cycle/accounts.json',
    markerDir,
    now: () => now,
    loadStorage: async () => currentStorage,
    refreshQuota: async () => storage(refreshedReset).quota!.mainQuota!,
    sendPrime: async () => {
      requestBodies.push(buildPrimeRequestBody())
    },
  })

  await mgr.tick()
  expect(requestBodies).toHaveLength(0)

  now = firstReset + PRIME_DUE_OFFSET_MS
  await mgr.tick()
  expect(requestBodies).toEqual([
    {
      model: 'claude-haiku-4-5',
      max_tokens: 1,
      system: 'Reply with 1 when you receive 0.',
      messages: [{ role: 'user', content: '0' }],
    },
  ])

  currentStorage = storage(secondReset)
  refreshedReset = secondReset
  now = secondReset - 1
  await mgr.tick()
  expect(requestBodies).toHaveLength(1)

  now = secondReset + PRIME_DUE_OFFSET_MS
  await mgr.tick()
  expect(requestBodies).toHaveLength(2)
})
