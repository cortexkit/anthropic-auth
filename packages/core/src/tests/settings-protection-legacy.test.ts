import { afterEach, expect, spyOn, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createNativePoolStore } from '../pool-store.ts'
import {
  legacySettingsProtection,
  readLegacySettingsProtection,
} from '../settings-protection-legacy.ts'
import {
  openSettingsService,
  type SettingsProtectionValues,
} from '../settings-service.ts'

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

const emptyProtection: SettingsProtectionValues = {
  killswitch_enabled: false,
  killswitch_default_five_hour: 5,
  killswitch_default_seven_day: 10,
  killswitch_default_scoped: 0,
  killswitch_account_floors: [],
  quota_minimum_remaining_five_hour: 0,
  quota_minimum_remaining_seven_day: 0,
  quota_minimum_remaining_scoped: 0,
  quota_fail_closed_on_unknown_quota: 'default',
  max_same_account_wait: '15m',
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'settings-protection-legacy-'))
  cleanup.push(() => rm(root, { force: true, recursive: true }))
  const store = (name: string) => {
    const paths = {
      config: join(root, `${name}.json`),
      state: join(root, `${name}-state.json`),
    }
    return {
      paths,
      store: createNativePoolStore({
        paths,
        quota: { validate: () => true, merge: (_, value) => value },
      }),
    }
  }
  return { root, local: store('local'), vault: store('vault') }
}

for (const host of ['opencode', 'pi'] as const) {
  for (const mode of ['local', 'claustrum'] as const) {
    test(`${host} ${mode} rung 2 selects only the current store and canonicalizes every legacy protection field`, async () => {
      const f = await fixture()
      const selected = mode === 'local' ? f.local : f.vault
      const other = mode === 'local' ? f.vault : f.local
      const account =
        mode === 'local' ? 'row-id' : 'vault:credential~0123456789'
      const settings = {
        killswitch: {
          enabled: true,
          main: { '5h': 21, five_hour: 31, '1w': 42, scoped: 13 },
          accounts: { [account]: { '5h': 51, '1w': 62, scoped: 23 } },
        },
        quota: {
          minimumRemaining: { '5h': 14, '1w': 25, scoped: 36 },
          failClosedOnUnknownQuota: false,
        },
        routing: { maxSameAccountWait: 'max' },
      }
      await selected.store.updateSettings(() => settings)
      await other.store.updateSettings(() => ({
        killswitch: { enabled: false, main: { five_hour: 99 } },
      }))
      const otherRead = spyOn(other.store, 'readSettings')
      const rowsRead = spyOn(selected.store, 'read')
      let seeds = 0
      try {
        const result = await readLegacySettingsProtection({
          host,
          localStore: f.local.store,
          vaultStore: f.vault.store,
          readMode: async () => mode,
          initializeVaultSettings: async () => {
            seeds++
          },
        })
        expect(result).toEqual({
          killswitch_enabled: true,
          killswitch_default_five_hour: 31,
          killswitch_default_seven_day: 42,
          killswitch_default_scoped: 13,
          killswitch_account_floors: [
            {
              account,
              host: mode === 'local' ? host : 'both',
              five_hour: 51,
              seven_day: 62,
              scoped: 23,
            },
          ],
          quota_minimum_remaining_five_hour: 14,
          quota_minimum_remaining_seven_day: 25,
          quota_minimum_remaining_scoped: 36,
          quota_fail_closed_on_unknown_quota: 'off',
          max_same_account_wait: 'cache',
        })
        expect(seeds).toBe(mode === 'claustrum' ? 1 : 0)
        expect(otherRead).not.toHaveBeenCalled()
        expect(rowsRead).not.toHaveBeenCalled()
      } finally {
        otherRead.mockRestore()
        rowsRead.mockRestore()
      }
    })

    for (const exists of [false, true]) {
      test(`${host} ${mode} ${exists ? 'readable store with no protection' : 'missing store'} is rung 2 with killswitch off`, async () => {
        const f = await fixture()
        const selected = mode === 'local' ? f.local : f.vault
        if (exists)
          await selected.store.updateSettings(() => ({
            dump: { enabled: true },
          }))
        const result = await readLegacySettingsProtection({
          host,
          localStore: f.local.store,
          vaultStore: f.vault.store,
          readMode: async () => mode,
          initializeVaultSettings: async () => {},
        })
        expect(result).toEqual(emptyProtection)
      })
    }

    for (const broken of ['unparseable', 'unreadable'] as const) {
      test(`${host} ${mode} ${broken} store leaves rung 2`, async () => {
        const f = await fixture()
        const selected = mode === 'local' ? f.local : f.vault
        if (broken === 'unparseable')
          await writeFile(selected.paths.config, '{broken')
        else await mkdir(selected.paths.config)
        expect(
          await readLegacySettingsProtection({
            host,
            localStore: f.local.store,
            vaultStore: f.vault.store,
            readMode: async () => mode,
            initializeVaultSettings: async () => {},
          }),
        ).toBeUndefined()
      })
    }
  }
}

test('partial legacy thresholds keep reader defaults, not stricter main floors or another rung', () => {
  expect(
    legacySettingsProtection(
      {
        killswitch: {
          enabled: true,
          main: { five_hour: 70, seven_day: 80, scoped: 90 },
          accounts: { partial: { '5h': 2 } },
        },
        quota: { minimumRemaining: { '1w': 12 } },
        routing: { maxSameAccountWait: '0' },
      },
      'pi',
    ),
  ).toEqual({
    ...emptyProtection,
    killswitch_enabled: true,
    killswitch_default_five_hour: 70,
    killswitch_default_seven_day: 80,
    killswitch_default_scoped: 90,
    killswitch_account_floors: [
      {
        account: 'partial',
        host: 'pi',
        five_hour: 2,
        seven_day: 10,
        scoped: 0,
      },
    ],
    quota_minimum_remaining_seven_day: 12,
    max_same_account_wait: 'off',
  })
  expect(
    legacySettingsProtection(
      { quota: { failClosedOnUnknownQuota: true } },
      'opencode',
    ).quota_fail_closed_on_unknown_quota,
  ).toBe('on')
})

for (const failure of ['mode', 'seed'] as const) {
  test(`${failure} failure leaves rung 2 without reading a settings store`, async () => {
    const f = await fixture()
    const localRead = spyOn(f.local.store, 'readSettings')
    const vaultRead = spyOn(f.vault.store, 'readSettings')
    try {
      expect(
        await readLegacySettingsProtection({
          host: 'pi',
          localStore: f.local.store,
          vaultStore: f.vault.store,
          readMode: async () => {
            if (failure === 'mode') throw new Error('authority unreadable')
            return 'claustrum'
          },
          initializeVaultSettings: async () => {
            throw new Error('own seed failed')
          },
        }),
      ).toBeUndefined()
      expect(localRead).not.toHaveBeenCalled()
      expect(vaultRead).not.toHaveBeenCalled()
    } finally {
      localRead.mockRestore()
      vaultRead.mockRestore()
    }
  })
}

test('own vault seeding completes before the vault settings read', async () => {
  const f = await fixture()
  const result = await readLegacySettingsProtection({
    host: 'opencode',
    localStore: f.local.store,
    vaultStore: f.vault.store,
    readMode: async () => 'claustrum',
    initializeVaultSettings: async () => {
      await f.vault.store.updateSettings(() => ({
        killswitch: { enabled: true },
      }))
    },
  })
  expect(result).toEqual({ ...emptyProtection, killswitch_enabled: true })
})

for (const host of ['opencode', 'pi'] as const) {
  test(`${host} uses the real enrollment reader and an isolated local store when no enrollment exists`, async () => {
    const f = await fixture()
    const env = {
      [`${host.toUpperCase()}_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE`]: join(
        f.root,
        'enrollment.json',
      ),
    }
    expect(
      await readLegacySettingsProtection({
        host,
        env,
        localStore: f.local.store,
        vaultStore: f.vault.store,
        initializeVaultSettings: async () => {
          throw new Error('local mode must not seed vault')
        },
      }),
    ).toEqual(emptyProtection)
  })
}

test('same-host leases sharing one bad target apply their own real stores on rung 2', async () => {
  const f = await fixture()
  const file = join(f.root, 'settings.jsonc')
  await writeFile(file, '{broken')
  await f.local.store.updateSettings(() => ({
    killswitch: { enabled: true, main: { five_hour: 21 } },
  }))
  await f.vault.store.updateSettings(() => ({
    killswitch: { enabled: false, main: { five_hour: 43 } },
  }))
  const open = async (localStore: typeof f.local.store) => {
    const service = await openSettingsService({
      file,
      protection: {
        readLegacyProtection: (host) =>
          readLegacySettingsProtection({
            host,
            localStore,
            vaultStore: f.vault.store,
            readMode: async () => 'local',
            initializeVaultSettings: async () => {},
          }),
      },
    })
    if (!service) throw new Error('Expected user-file service')
    cleanup.push(() => service.dispose())
    return service
  }
  const [a, b] = await Promise.all([open(f.local.store), open(f.vault.store)])
  expect(a.resolve('pi').killswitch_enabled).toBe(true)
  expect(a.resolve('pi').killswitch_default_five_hour).toBe(21)
  expect(b.resolve('pi').killswitch_enabled).toBe(false)
  expect(b.resolve('pi').killswitch_default_five_hour).toBe(43)
  expect(a.snapshot().protection.pi.rung).toBe(2)
  expect(b.snapshot().protection.pi.rung).toBe(2)
})
