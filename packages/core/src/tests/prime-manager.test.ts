import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import {
  chmod,
  lstat,
  mkdir,
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
  __setLogTestSink,
  getLogLevel,
  type LogTestRecord,
  setLogLevel,
} from '../logger.ts'
import {
  buildPrimeRequestBody,
  PRIME_CHECK_THROTTLE_MS,
  PRIME_DUE_OFFSET_MS,
  PRIME_MARKER_MAX_AGE_MS,
  PrimeManager,
  type PrimeSendResult,
  primeAccountMarkerDir,
  primeMarkerNamespaceDir,
  primeStorageFingerprint,
} from '../prime.ts'
import { tokenFingerprint } from '../token-fingerprint.ts'

const TEST_LINEAGE = '0123456789abcdef'

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
  markerDir?: string
  now: () => number
  loadStorage: () => Promise<AccountStorage>
  refreshQuota: () => Promise<OAuthQuotaSnapshot>
  sendPrime: () => Promise<void | PrimeSendResult>
  accountLineage?: () => Promise<string>
  accountIdentity?: () => Promise<string | undefined>
}): PrimeManager {
  const instance = new PrimeManager({
    storagePath: input.storagePath,
    markerDir: input.markerDir,
    now: input.now,
    loadStorage: input.loadStorage,
    getAccountEvidence: async () => ({
      lineage: (await input.accountLineage?.()) ?? TEST_LINEAGE,
      accountIdentity: await input.accountIdentity?.(),
    }),
    refreshQuota: async () => ({
      quota: await input.refreshQuota(),
      fresh: true,
    }),
    sendPrime: async () =>
      (await input.sendPrime()) ?? { ok: true, status: 200, ms: 1 },
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
  test.skipIf(process.platform === 'win32')(
    'the default Prime root writes and sweeps only in the user data folder',
    async () => {
      const root = await tempMarkerRoot()
      const data = join(root, 'data')
      const storagePath = join(root, 'accounts.json')
      const lineage = tokenFingerprint(TEST_LINEAGE)
      const accountDir = primeAccountMarkerDir(
        join(data, 'cortexkit', 'anthropic-auth', 'prime'),
        storagePath,
        lineage,
      )
      const legacyDir = primeAccountMarkerDir(
        join(root, 'opencode-anthropic-auth', 'prime'),
        storagePath,
        lineage,
      )
      const now = Date.now()
      const staleName = 'main-1'
      const stale = new Date(now - PRIME_MARKER_MAX_AGE_MS - 1_000)
      const oldTmp = process.env.TMPDIR
      const oldData = process.env.XDG_DATA_HOME
      process.env.TMPDIR = root
      process.env.XDG_DATA_HOME = data
      try {
        await mkdir(legacyDir, { recursive: true, mode: 0o700 })
        await writeFile(join(legacyDir, staleName), '')
        await utimes(join(legacyDir, staleName), stale, stale)
        const legacyClaim = join(legacyDir, 'main-bootstrap')
        await writeFile(legacyClaim, '')
        await utimes(legacyClaim, new Date(now), new Date(now))

        let sends = 0
        const prime = manager({
          storagePath,
          now: () => now,
          loadStorage: async () => storage(),
          refreshQuota: async () => ({}),
          sendPrime: async () => {
            sends++
          },
        })
        await prime.tick()
        expect(await readdir(accountDir)).toEqual(['main-bootstrap'])
        expect(sends).toBe(1)
        expect((await lstat(accountDir)).mode & 0o777).toBe(0o700)
        await writeFile(join(accountDir, staleName), '')
        await utimes(join(accountDir, staleName), stale, stale)
        await prime.tick()
        expect(await readdir(accountDir)).toEqual(['main-bootstrap'])
        expect((await readdir(legacyDir)).sort()).toEqual([
          staleName,
          'main-bootstrap',
        ])
      } finally {
        if (oldTmp === undefined) delete process.env.TMPDIR
        else process.env.TMPDIR = oldTmp
        if (oldData === undefined) delete process.env.XDG_DATA_HOME
        else process.env.XDG_DATA_HOME = oldData
      }
    },
  )

  for (const mode of [0o775, 0o755]) {
    test.skipIf(process.platform === 'win32')(
      `Prime writes without changing a CortexKit parent at ${mode.toString(8)}`,
      async () => {
        const root = await tempMarkerRoot()
        const shared = join(root, 'cortexkit')
        await mkdir(shared)
        await chmod(shared, mode)
        const storagePath = join(root, 'accounts.json')
        const oldData = process.env.XDG_DATA_HOME
        process.env.XDG_DATA_HOME = root
        try {
          const prime = manager({
            storagePath,
            now: Date.now,
            loadStorage: async () => storage(),
            refreshQuota: async () => ({}),
            sendPrime: async () => {},
          })
          await prime.tick()
          const accountDir = primeAccountMarkerDir(
            join(shared, 'anthropic-auth', 'prime'),
            storagePath,
            tokenFingerprint(TEST_LINEAGE),
          )
          expect(await readdir(accountDir)).toEqual(['main-bootstrap'])
          expect((await lstat(shared)).mode & 0o777).toBe(mode)
        } finally {
          if (oldData === undefined) delete process.env.XDG_DATA_HOME
          else process.env.XDG_DATA_HOME = oldData
        }
      },
    )
  }

  test('Ultra skips priming a stored or newly polled account with no five-hour limit', async () => {
    const now = Date.now()
    const quota: OAuthQuotaSnapshot = {
      source: 'poll',
      checkedAt: now,
      seven_day: { usedPercent: 0, remainingPercent: 100, checkedAt: now },
    }
    const markerDir = await tempMarkerRoot()
    const records: LogTestRecord[] = []
    const previous = getLogLevel()
    setLogLevel('debug')
    __setLogTestSink((record) => records.push(record))
    let fires = 0
    let refreshes = 0
    try {
      for (const age of [undefined, 0, 301_000]) {
        const config = storage()
        if (age !== undefined)
          config.quota!.mainQuota = {
            ...quota,
            checkedAt: now - age,
            seven_day: { ...quota.seven_day!, checkedAt: now - age },
          }
        await manager({
          storagePath: `/config/ultra-${age}/accounts.json`,
          markerDir,
          now: () => now,
          loadStorage: async () => config,
          refreshQuota: async () => {
            refreshes++
            return quota
          },
          sendPrime: async () => {
            fires++
          },
        }).tick()
      }
      expect(fires).toBe(0)
      expect(refreshes).toBe(1)
      expect(
        records.filter((record) => record.message === 'no five-hour limit'),
      ).toHaveLength(3)
      expect(await readdir(markerDir)).toEqual([])
    } finally {
      __setLogTestSink(null)
      setLogLevel(previous)
    }
  })
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

  test('missing and dangling storage files retain their configured-path fingerprint', async () => {
    const directory = await tempMarkerRoot()
    const realFolder = join(directory, 'real')
    const aliasFolder = join(directory, 'alias')
    await mkdir(realFolder)
    await symlink(realFolder, aliasFolder, 'dir')
    await symlink('absent.json', join(realFolder, 'dangling.json'))
    for (const path of [
      join(aliasFolder, 'missing.json'),
      join(aliasFolder, 'dangling.json'),
    ]) {
      const releasedFingerprint = createHash('sha256')
        .update(resolve(path))
        .digest('hex')
        .slice(0, 12)
      expect(primeStorageFingerprint(path)).toBe(releasedFingerprint)
    }
  })

  test('storage symlink loops still refuse a fingerprint', async () => {
    const directory = await tempMarkerRoot()
    const file = join(directory, 'loop.json')
    await symlink('other.json', file)
    await symlink('loop.json', join(directory, 'other.json'))
    expect(() => primeStorageFingerprint(file)).toThrow()
  })

  test('unverified identities in different stores prime independently', async () => {
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
    expect(await readdir(markerDir)).not.toContain('accounts')
  })

  for (const bootstrap of [false, true]) {
    const window = bootstrap ? 'bootstrap' : 'reset'
    test(`verified UUID deduplicates ${window} claims across different stores`, async () => {
      const markerDir = await tempMarkerRoot()
      const reset = Date.now() - PRIME_DUE_OFFSET_MS
      let now = reset + PRIME_DUE_OFFSET_MS
      const identity = '11111111-1111-4111-8111-111111111111'
      const digest = createHash('sha256').update(identity).digest('hex')
      const config = storage(bootstrap ? undefined : reset)
      let fires = 0
      const instances = [
        '/config/opencode/accounts.json',
        '/config/pi/accounts.json',
      ].map((storagePath, index) =>
        manager({
          storagePath,
          markerDir,
          now: () => now,
          loadStorage: async () => config,
          refreshQuota: async () => config.quota!.mainQuota ?? {},
          accountLineage: async () =>
            index === 0 ? 'aaaaaaaaaaaaaaaa' : 'bbbbbbbbbbbbbbbb',
          accountIdentity: async () => identity,
          sendPrime: async () => {
            fires++
          },
        }),
      )

      await Promise.all(instances.map((instance) => instance.tick()))
      now += PRIME_CHECK_THROTTLE_MS
      await Promise.all(instances.map((instance) => instance.tick()))

      expect(fires).toBe(1)
      expect(await readdir(join(markerDir, 'accounts'))).toEqual([
        `${digest}-${bootstrap ? 'bootstrap' : reset}`,
      ])
      for (const instance of instances) {
        const legacyDir = primeAccountMarkerDir(
          markerDir,
          instance.options.storagePath,
          tokenFingerprint(
            (await instance.options.getAccountEvidence('main'))!.lineage,
          ),
        )
        expect(await readdir(legacyDir)).toEqual([
          `main-${bootstrap ? 'bootstrap' : reset}`,
        ])
      }
    })

    test(`different verified UUIDs each prime their ${window} across stores`, async () => {
      const markerDir = await tempMarkerRoot()
      const reset = Date.now() - PRIME_DUE_OFFSET_MS
      const config = storage(bootstrap ? undefined : reset)
      let fires = 0
      await Promise.all(
        [
          '11111111-1111-4111-8111-111111111111',
          '22222222-2222-4222-8222-222222222222',
        ].map((identity, index) =>
          manager({
            storagePath: `/config/${index}/accounts.json`,
            markerDir,
            now: () => reset + PRIME_DUE_OFFSET_MS,
            loadStorage: async () => config,
            refreshQuota: async () => config.quota!.mainQuota ?? {},
            accountIdentity: async () => identity,
            sendPrime: async () => {
              fires++
            },
          }).tick(),
        ),
      )

      expect(fires).toBe(2)
      expect(await readdir(join(markerDir, 'accounts'))).toHaveLength(2)
    })

    test(`an old process holding a legacy ${window} claim blocks a verified process without claiming its UUID`, async () => {
      const markerDir = await tempMarkerRoot()
      const storagePath = '/config/legacy/accounts.json'
      const reset = Date.now() - PRIME_DUE_OFFSET_MS
      const config = storage(bootstrap ? undefined : reset)
      const legacyDir = primeAccountMarkerDir(
        markerDir,
        storagePath,
        tokenFingerprint(TEST_LINEAGE),
      )
      let fires = 0
      await manager({
        storagePath,
        markerDir,
        now: () => reset + PRIME_DUE_OFFSET_MS,
        loadStorage: async () => config,
        refreshQuota: async () => {
          // The old process wins after the new process's initial marker check.
          await mkdir(legacyDir, { recursive: true })
          await writeFile(
            join(legacyDir, `main-${bootstrap ? 'bootstrap' : reset}`),
            '',
            { flag: 'wx' },
          )
          return config.quota!.mainQuota ?? {}
        },
        accountIdentity: async () => '11111111-1111-4111-8111-111111111111',
        sendPrime: async () => {
          fires++
        },
      }).tick()

      expect(fires).toBe(0)
      expect(await readdir(markerDir)).not.toContain('accounts')
      expect(await readdir(legacyDir)).toEqual([
        `main-${bootstrap ? 'bootstrap' : reset}`,
      ])
    })
  }

  test('sweeps stale verified account markers with the six-hour rule', async () => {
    const markerDir = await tempMarkerRoot()
    const accountDir = join(markerDir, 'accounts')
    const now = Date.now()
    const digest = createHash('sha256')
      .update('11111111-1111-4111-8111-111111111111')
      .digest('hex')
    await mkdir(accountDir)
    for (const suffix of ['1', 'bootstrap', '2', 'not-a-marker']) {
      const path = join(accountDir, `${digest}-${suffix}`)
      await writeFile(path, '')
      const age =
        suffix === '2'
          ? PRIME_MARKER_MAX_AGE_MS - 1_000
          : PRIME_MARKER_MAX_AGE_MS + 1_000
      const modified = new Date(now - age)
      await utimes(path, modified, modified)
    }
    const config = storage()
    config.accounts = []
    config.main = undefined

    await manager({
      storagePath: '/config/sweep/accounts.json',
      markerDir,
      now: () => now,
      loadStorage: async () => config,
      refreshQuota: async () => ({}),
      sendPrime: async () => {},
    }).tick()

    expect((await readdir(accountDir)).sort()).toEqual([
      `${digest}-2`,
      `${digest}-not-a-marker`,
    ])
  })

  test('a disabled tick does not sweep markers', async () => {
    const markerDir = await tempMarkerRoot()
    const storagePath = join(markerDir, 'accounts.json')
    const accountDir = primeAccountMarkerDir(
      markerDir,
      storagePath,
      tokenFingerprint(TEST_LINEAGE),
    )
    await mkdir(accountDir, { recursive: true })
    const marker = join(accountDir, 'main-bootstrap')
    await writeFile(marker, '')
    const old = new Date(Date.now() - PRIME_MARKER_MAX_AGE_MS - 1_000)
    await utimes(marker, old, old)
    await manager({
      markerDir,
      storagePath,
      now: Date.now,
      loadStorage: async () => ({ ...storage(), prime: { enabled: false } }),
      refreshQuota: async () => ({}),
      sendPrime: async () => {},
    }).tick()
    expect(await readdir(accountDir)).toEqual(['main-bootstrap'])
  })

  test.skipIf(process.platform === 'win32')(
    'sweep ignores links, unrelated directories and unrelated files',
    async () => {
      const markerDir = await tempMarkerRoot()
      const outside = await tempMarkerRoot()
      const storagePath = join(markerDir, 'accounts.json')
      const namespace = primeMarkerNamespaceDir(markerDir, storagePath)
      const accountDir = join(namespace, '123456abcdef')
      const unrelatedDir = join(namespace, 'unrelated')
      await mkdir(accountDir, { recursive: true })
      await mkdir(unrelatedDir)
      await symlink(outside, join(namespace, '987654abcdef'), 'dir')
      const old = new Date(Date.now() - PRIME_MARKER_MAX_AGE_MS - 1_000)
      for (const path of [
        join(accountDir, 'fallback%2Fone-12345'),
        join(accountDir, 'keep.txt'),
        join(unrelatedDir, 'main-bootstrap'),
        join(outside, 'main-bootstrap'),
      ]) {
        await writeFile(path, '')
        await utimes(path, old, old)
      }
      await manager({
        markerDir,
        storagePath,
        now: Date.now,
        loadStorage: async () => storage(Date.now()),
        refreshQuota: async () => ({}),
        sendPrime: async () => {},
      }).tick()
      expect(await readdir(accountDir)).toEqual(['keep.txt'])
      expect(await readdir(unrelatedDir)).toEqual(['main-bootstrap'])
      expect(await readdir(outside)).toEqual(['main-bootstrap'])
    },
  )

  test.skipIf(process.platform === 'win32')(
    'Prime tightens an owned marker root and refuses a writable or linked root',
    async () => {
      const root = await tempMarkerRoot()
      const target = await tempMarkerRoot()
      const link = join(root, 'linked-markers')
      await symlink(target, link, 'dir')
      let sends = 0
      const tick = (markerDir: string) =>
        manager({
          markerDir,
          storagePath: join(root, 'accounts.json'),
          now: Date.now,
          loadStorage: async () => storage(),
          refreshQuota: async () => ({}),
          sendPrime: async () => {
            sends++
          },
        }).tick()
      await chmod(target, 0o777)
      await tick(target)
      await tick(link)
      expect(await readdir(target)).toEqual([])
      expect(sends).toBe(0)
      await chmod(target, 0o755)
      await tick(target)
      expect((await lstat(target)).mode & 0o777).toBe(0o700)
      expect(sends).toBe(1)
    },
  )

  test('a verified epoch claim blocks a stale bootstrap view in another store', async () => {
    const markerDir = await tempMarkerRoot()
    const reset = Date.now() - PRIME_DUE_OFFSET_MS
    let fires = 0
    for (const knownReset of [true, false]) {
      const config = storage(knownReset ? reset : undefined)
      await manager({
        storagePath: `/config/${knownReset}/accounts.json`,
        markerDir,
        now: () => reset + PRIME_DUE_OFFSET_MS,
        loadStorage: async () => config,
        refreshQuota: async () => config.quota!.mainQuota ?? {},
        accountIdentity: async () => '11111111-1111-4111-8111-111111111111',
        sendPrime: async () => {
          fires++
        },
      }).tick()
    }
    expect(fires).toBe(1)
  })

  for (const ending of ['account-changed', 'stopped'] as const) {
    test(`a losing store retries a verified claim abandoned as ${ending}`, async () => {
      const markerDir = await tempMarkerRoot()
      let now = Date.now()
      const epoch = ending === 'stopped' ? undefined : now - PRIME_DUE_OFFSET_MS
      const config = storage(epoch)
      const entered = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      const shared = {
        markerDir,
        now: () => now,
        refreshQuota: async () => config.quota!.mainQuota ?? {},
        accountIdentity: async () => '11111111-1111-4111-8111-111111111111',
      }
      let loads = 0
      let winnerSends = 0
      let loserSends = 0
      const winner = manager({
        ...shared,
        storagePath: '/config/winner/accounts.json',
        loadStorage: async () => {
          if (++loads === 3 && ending === 'stopped') {
            entered.resolve()
            await release.promise
          }
          return config
        },
        sendPrime: async () => {
          if (ending === 'account-changed') {
            entered.resolve()
            await release.promise
            return { ok: false, reason: 'account-changed', error: 'replaced' }
          }
          winnerSends++
        },
      })
      const loser = manager({
        ...shared,
        storagePath: '/config/loser/accounts.json',
        loadStorage: async () => config,
        sendPrime: async () => {
          loserSends++
        },
      })
      const winningTick = winner.tick()
      try {
        await Promise.race([
          entered.promise,
          winningTick.then(() => {
            throw new Error('Winner never acquired the claim')
          }),
        ])
        await loser.tick()
        expect(loserSends).toBe(0)
        const legacyDir = primeAccountMarkerDir(
          markerDir,
          loser.options.storagePath,
          tokenFingerprint(TEST_LINEAGE),
        )
        expect(await readdir(legacyDir)).toEqual([
          `main-${epoch ?? 'bootstrap'}`,
        ])
        if (ending === 'stopped') winner.stop()
      } finally {
        release.resolve()
        await winningTick
      }
      expect(winnerSends).toBe(0)
      now += PRIME_CHECK_THROTTLE_MS
      await loser.tick()
      await loser.tick()
      expect(loserSends).toBe(1)
    })
  }

  for (const outcome of [
    'account-changed',
    'ambiguous',
    'dispatched',
  ] as const) {
    test(`an epoch claim preserves bootstrap until dispatch (${outcome})`, async () => {
      const markerDir = await tempMarkerRoot()
      const storagePath = '/config/epoch/accounts.json'
      let now = Date.now()
      let epoch: number | undefined
      const identity = '11111111-1111-4111-8111-111111111111'
      const digest = createHash('sha256').update(identity).digest('hex')
      const legacyDir = primeAccountMarkerDir(
        markerDir,
        storagePath,
        tokenFingerprint(TEST_LINEAGE),
      )
      const verifiedDir = join(markerDir, 'accounts')
      const view = () => storage(epoch)
      let duringSend: string[][] | undefined
      const mgr = manager({
        markerDir,
        storagePath,
        now: () => now,
        loadStorage: async () => view(),
        refreshQuota: async () => view().quota!.mainQuota ?? {},
        accountIdentity: async () => identity,
        sendPrime: async () => {
          if (epoch === undefined) return
          duringSend = [await readdir(legacyDir), await readdir(verifiedDir)]
          return {
            ok: false,
            reason: outcome === 'ambiguous' ? 'send' : 'account-changed',
            ...(outcome === 'dispatched' && { dispatched: true }),
            error: 'not completed',
          }
        },
      })
      await mgr.tick()
      epoch = now
      now += PRIME_DUE_OFFSET_MS
      await mgr.tick()
      expect(duringSend?.[0]).toContain('main-bootstrap')
      expect(duringSend?.[1]).toContain(`${digest}-bootstrap`)
      const suffixes =
        outcome === 'account-changed'
          ? ['bootstrap']
          : outcome === 'ambiguous'
            ? ['bootstrap', epoch]
            : [epoch]
      expect((await readdir(legacyDir)).sort()).toEqual(
        suffixes.map((suffix) => `main-${suffix}`).sort(),
      )
      expect((await readdir(verifiedDir)).sort()).toEqual(
        suffixes.map((suffix) => `${digest}-${suffix}`).sort(),
      )
    })
  }

  for (const scope of ['storage', 'verified'] as const) {
    test(`an unrelated ${scope} filename does not suppress bootstrap`, async () => {
      const markerDir = await tempMarkerRoot()
      const storagePath = '/config/bootstrap/accounts.json'
      const identity = '11111111-1111-4111-8111-111111111111'
      const digest = createHash('sha256').update(identity).digest('hex')
      const dir =
        scope === 'storage'
          ? primeAccountMarkerDir(
              markerDir,
              storagePath,
              tokenFingerprint(TEST_LINEAGE),
            )
          : join(markerDir, 'accounts')
      const name =
        scope === 'storage' ? 'main-bootstrap.bak' : `${digest}-not-a-marker`
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, name), '')
      let sends = 0
      await manager({
        markerDir,
        storagePath,
        now: Date.now,
        loadStorage: async () => storage(),
        refreshQuota: async () => ({}),
        accountIdentity: async () => identity,
        sendPrime: async () => {
          sends++
        },
      }).tick()
      expect(sends).toBe(1)
      expect(await readdir(dir)).toContain(name)
    })
  }

  test('disabling after a verified claim releases both owned markers', async () => {
    const markerDir = await tempMarkerRoot()
    const reset = Date.now() - PRIME_DUE_OFFSET_MS
    let loads = 0
    let fires = 0
    const mgr = manager({
      storagePath: '/config/disable/accounts.json',
      markerDir,
      now: () => reset + PRIME_DUE_OFFSET_MS,
      loadStorage: async () => {
        const config = storage(reset)
        if (++loads === 3) config.prime!.enabled = false
        return config
      },
      refreshQuota: async () => storage(reset).quota!.mainQuota!,
      accountIdentity: async () => '11111111-1111-4111-8111-111111111111',
      sendPrime: async () => {
        fires++
      },
    })
    await mgr.tick()

    expect(fires).toBe(0)
    expect(await readdir(join(markerDir, 'accounts'))).toEqual([])
    expect(
      await readdir(
        primeAccountMarkerDir(
          markerDir,
          mgr.options.storagePath,
          tokenFingerprint(TEST_LINEAGE),
        ),
      ),
    ).toEqual([])
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
      accountLineage: async () => accountFingerprint,
      sendPrime: async () => {
        fires += 1
      },
    })

    await mgr.tick()
    accountFingerprint = 'bbbbbbbbbbbbbbbb'
    await mgr.tick()

    expect(fires).toBe(2)
    const namespaceDir = primeMarkerNamespaceDir(markerDir, storagePath)
    const oldIdentityDir = join(
      namespaceDir,
      tokenFingerprint('aaaaaaaaaaaaaaaa').slice(0, 12),
    )
    const newIdentityDir = join(
      namespaceDir,
      tokenFingerprint('bbbbbbbbbbbbbbbb').slice(0, 12),
    )
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
      accountLineage: async () => accountFingerprint,
      sendPrime: async () => {
        fires += 1
      },
    })

    await mgr.tick()
    accountFingerprint = 'bbbbbbbbbbbbbbbb'
    await mgr.tick()

    expect(fires).toBe(2)
    const namespaceDir = primeMarkerNamespaceDir(markerDir, storagePath)
    expect(
      await readdir(
        join(namespaceDir, tokenFingerprint('aaaaaaaaaaaaaaaa').slice(0, 12)),
      ),
    ).toEqual(['main-bootstrap'])
    expect(
      await readdir(
        join(namespaceDir, tokenFingerprint('bbbbbbbbbbbbbbbb').slice(0, 12)),
      ),
    ).toEqual(['main-bootstrap'])
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
