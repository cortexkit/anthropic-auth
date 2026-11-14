import { afterEach, expect, spyOn, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { openSettings } from '@cortexkit/common-auth/settings'
import * as a from '../accounts.ts'
import { createNativeAccountRuntime } from '../native-account-runtime.ts'
import { readNativeEnrollmentMode } from '../native-enrollment-authority.ts'
import { nativeQuotaCodec } from '../native-quota-codec.ts'
import { nativeVaultPaths } from '../native-vault-paths.ts'
import { resolveNativePoolPaths } from '../pool-paths.ts'
import { createNativePoolStore } from '../pool-store.ts'
import { applySessionCacheTtl } from '../session-cache-policy.ts'
import {
  SETTINGS_DEFAULT_READERS,
  SETTINGS_THREE_WAY_READERS,
  settingsDefinition,
} from '../settings-definition.ts'
import { settingsImportRecordPath } from '../settings-mode.ts'
import {
  runSettingsMoveAtStartup,
  type SettingsMoveStartupOptions,
} from '../settings-move-run.ts'
import { SETTINGS_MOVE_PATHS } from '../settings-move-source.ts'
import { resolveSettingsPaths, type SettingsHost } from '../settings-paths.ts'
import { resolveSettingsRecord } from '../settings-record.ts'
import { openSettingsService } from '../settings-service.ts'
import { LEGACY_STATE_LAYOUT } from '../state-layout-paths.ts'
import { applyTurnEndNotes } from '../turn-end-note.ts'
import { initializeNativeTestAuthority } from './native-authority-fixture.ts'
import {
  coreDefaultReaders,
  coreReaderBytes,
  coreThreeWayReaders,
  explicitLegacySettings,
} from './settings-reader-fixture.ts'
import {
  publishedBooleanLeaves,
  publishedRuntimeKeys,
  publishedSettingFields,
} from './settings-rollback-v2.11.4.ts'

const { setSettingsFsForTest } = await import(
  new URL('fs.js', import.meta.resolve('@cortexkit/common-auth/settings')).href
)
const io = { ...fs }
const cleanup: (() => Promise<unknown> | undefined)[] = []
afterEach(async () => {
  setSettingsFsForTest()
  for (const close of cleanup.splice(0).reverse()) await close()
})

async function put(path: string, value: unknown) {
  await io.mkdir(dirname(path), { recursive: true })
  await io.writeFile(path, JSON.stringify(value))
}

async function fixture(
  host: SettingsHost,
  custody: 'local' | 'vault' | 'hosted',
) {
  const root = await io.realpath(
    await io.mkdtemp(join(tmpdir(), 'settings-preserve-')),
  )
  cleanup.push(() => io.rm(root, { recursive: true, force: true }))
  const reads: string[] = []
  const options: SettingsMoveStartupOptions = {
    host,
    home: root,
    platform: process.platform,
    env: {
      HOME: root,
      USERPROFILE: root,
      APPDATA: join(root, 'AppData', 'Roaming'),
      XDG_STATE_HOME: join(root, 'state'),
    },
    readMode:
      custody === 'hosted'
        ? (acting, env) =>
            readNativeEnrollmentMode(acting, env, {
              enrollmentAuthority: async () => 'host',
              readClaustrumEnrollmentStatus: async () => {
                throw new Error('Hosted mode must not inspect vault enrollment')
              },
            })
        : async () => (custody === 'vault' ? 'claustrum' : 'local'),
    initializeVaultSettings: async () => {},
    log: { warn() {} },
    fence: {
      registration: { status: 'registered' },
      floor: '2.12.0',
      self: { pid: 100, incarnation: 'self', instance: 'proof' },
      artifacts: { rpcRoots: [], rpcDirs: [], cacheKeepDirs: [] },
      readHolders: async () => undefined,
    },
  }
  const paths = await resolveSettingsPaths(host, options)
  const stores = {} as Record<
    SettingsHost,
    Awaited<ReturnType<typeof resolveNativePoolPaths>>
  >
  for (const acting of ['opencode', 'pi'] as const) {
    const local = await resolveNativePoolPaths(
      paths.defaults[acting].account,
      paths.defaults[acting].state,
      LEGACY_STATE_LAYOUT,
    )
    stores[acting] =
      custody === 'local' ? local : { ...local, ...nativeVaultPaths(local) }
    // These are deliberately malformed: any accidental local-row read in vault mode fails.
    if (custody !== 'local')
      await put(local.legacyConfig, { accounts: 'forbidden-local-rows' })
  }
  const read = async (path: string, ...args: unknown[]) => {
    const text = String(path)
    expect(
      text === root ||
        text.startsWith(`${root}/`) ||
        text.startsWith(`${root}\\`),
      `outside sandbox: ${text}`,
    ).toBe(true)
    reads.push(text)
    return (io.readFile as (...args: unknown[]) => Promise<unknown>)(
      path,
      ...args,
    )
  }
  const spy = spyOn(fs, 'readFile').mockImplementation(read as never)
  cleanup.push(() => {
    spy.mockRestore()
    return undefined
  })
  setSettingsFsForTest({ ...fs, readFile: read })
  return { root, paths, stores, reads, options }
}

test('preservation snapshots execute exactly the schema-named Core readers', () => {
  expect(Object.keys(coreDefaultReaders).sort()).toEqual(
    Object.entries(SETTINGS_DEFAULT_READERS)
      .filter(([, name]) => name.startsWith('packages/core/'))
      .map(([key]) => key)
      .sort(),
  )
  for (const [key, readers] of Object.entries(coreThreeWayReaders)) {
    expect(Object.keys(readers).sort()).toEqual(
      SETTINGS_THREE_WAY_READERS[key as keyof typeof SETTINGS_THREE_WAY_READERS]
        .filter(({ path }) => path.startsWith('packages/core/'))
        .map(({ reader }) => reader)
        .sort(),
    )
  }
  for (const inventory of [settingsDefinition.settings, SETTINGS_MOVE_PATHS])
    expect(
      Object.keys(inventory).some((key) => /relay|sidebar/.test(key)),
    ).toBe(false)
})

function requestBytes(s: a.AccountStorage) {
  const body: Record<string, unknown> = {
    model: 'claude-opus-5-5',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'hello', cache_control: { type: 'ephemeral' } },
        ],
      },
    ],
    tools: [
      { name: 'custom', description: 'tool', input_schema: { type: 'object' } },
    ],
  }
  applySessionCacheTtl(
    body,
    a.isCache1hPersistentlyEnabled(s) ? 'long' : 'short',
  )
  applyTurnEndNotes(body, { tools: s.turnEndNote?.tools })
  return JSON.stringify(body)
}

function lockMetadata(path: string) {
  return /\.lock(?:$|\.evicting[/\\]owner\.json$)/.test(path)
}

for (const host of ['opencode', 'pi'] as const) {
  for (const custody of ['local', 'vault', 'hosted'] as const) {
    for (const scenario of [
      'explicit',
      'three-way-absent',
      'all-absent',
    ] as const) {
      test(`${host} ${custody} ${scenario}: moved Core reader outputs and request bytes stay identical`, async () => {
        const f = await fixture(host, custody)
        const settings: Partial<a.AccountStorage> =
          scenario === 'all-absent'
            ? {}
            : structuredClone(explicitLegacySettings)
        if (scenario === 'three-way-absent') {
          delete settings.claudeCache?.enabled
          delete settings.quota?.enabled
        }
        // Both hosts explicitly agree, or both omit the field. No inheritance changes the fixture.
        for (const store of Object.values(f.stores))
          await put(store.config, settings)
        const before = { ...a.createEmptyStorage(), ...settings }
        const beforeReaders = coreReaderBytes(before)
        const beforeBody = requestBytes(before)
        const sourceBytes = await Promise.all(
          Object.values(f.stores).map((store) =>
            io.readFile(store.config, 'utf8'),
          ),
        )
        const moved = await runSettingsMoveAtStartup(f.options)
        expect(moved.outcome).toBe('moved')
        expect(f.reads).toContain(f.stores.opencode.config)
        expect(f.reads).toContain(f.stores.pi.config)
        const allowed = [
          f.stores.opencode.config,
          f.stores.pi.config,
          f.paths.marker,
          f.paths.target,
          ...(['opencode', 'pi'] as const).map((acting) =>
            settingsImportRecordPath(f.paths.target, acting),
          ),
          ...Object.values(f.stores).map(
            (store) => `${store.config}.MOVED_READPLEASE`,
          ),
        ]
        // Lock-owner metadata is read during real lock acquisition; account rows and credentials are not.
        expect(
          f.reads.filter(
            (path) => !lockMetadata(path) && !allowed.includes(path),
          ),
        ).toEqual([])
        f.reads.length = 0
        const service = await openSettingsService({
          file: f.paths.target,
          host,
          dependencies: {
            open: (config) => ({
              ...openSettings(settingsDefinition, config),
              watch: () => () => {},
            }),
          },
        })
        if (!service) throw new Error('Missing settings service')
        cleanup.push(() => service.dispose())
        expect(
          f.reads.every(
            (path) =>
              lockMetadata(path) ||
              path === f.paths.target ||
              path === `${f.paths.target}.applied.json`,
          ),
        ).toBe(true)
        expect(f.reads).toContain(f.paths.target)
        f.reads.length = 0
        // A fresh record prevents stale legacy values from hiding a leaf the move lost.
        const after = resolveSettingsRecord(
          a.createEmptyStorage(),
          service.snapshot(),
          host,
        )
        expect(coreReaderBytes(after)).toBe(beforeReaders)
        expect(requestBytes(after)).toBe(beforeBody)
        expect(f.reads).toEqual([])
        expect(
          await Promise.all(
            Object.values(f.stores).map((store) =>
              io.readFile(store.config, 'utf8'),
            ),
          ),
        ).toEqual(sourceBytes)
      })
    }
  }
}

for (const host of ['opencode', 'pi'] as const) {
  test(`${host === 'opencode' ? 'OC2' : 'Pi'} status deliberately shows the disabled effective killswitch with default floors`, async () => {
    const f = await fixture(host, 'local')
    const paths = f.stores[host]
    for (const peer of Object.values(f.stores))
      if (peer !== paths) await put(peer.config, {})
    await initializeNativeTestAuthority(paths)
    const store = createNativePoolStore({ paths, quota: nativeQuotaCodec })
    cleanup.push(() => store.close())
    await store.initialize()
    expect((await runSettingsMoveAtStartup(f.options)).outcome).toBe('moved')
    const service = await openSettingsService({ file: f.paths.target, host })
    if (!service) throw new Error('Missing settings service')
    cleanup.push(() => service.dispose())
    const runtime = createNativeAccountRuntime({
      paths,
      host,
      settingsService: service,
      settingsMode: () => 'user-file',
      vault: {
        env: {
          [`${host === 'pi' ? 'PI' : 'OPENCODE'}_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE`]:
            join(f.root, 'no-enrollment.json'),
        },
      },
    })
    cleanup.push(async () => {
      await runtime.close()
    })
    let status: string
    if (host === 'opencode') {
      const { createNativeMenuCapabilities } = await import(
        new URL('../../../opencode/src/v2/menu.ts', import.meta.url).href
      )
      const menu = createNativeMenuCapabilities({
        runtime,
        source: {},
        start: async () => {},
      })
      cleanup.push(() => {
        menu.close()
        return undefined
      })
      status = await menu.readStatus('killswitch')
    } else {
      const native = await import(
        new URL('../../../pi/src/native.ts', import.meta.url).href
      )
      const spy = spyOn(native, 'getPiNativeRuntime').mockReturnValue({
        service: async () => runtime,
      })
      cleanup.push(() => {
        spy.mockRestore()
        return undefined
      })
      const { createPiNativeCommands } = await import(
        new URL('../../../pi/src/native-commands.ts', import.meta.url).href
      )
      status = await createPiNativeCommands(paths.config).readStatus(
        'killswitch',
        {},
      )
    }
    // File-mode Status reports effective values, not the old store's optional object shape.
    const config =
      '{"enabled":false,"main":{"five_hour":5,"seven_day":10,"scoped":0},"accounts":{}}'
    expect(status.split('\nSettings file:')[0]).toBe(
      host === 'opencode' ? config : `Killswitch: disabled\n${config}`,
    )
    expect(status).toContain(`Settings file: ${f.paths.target}`)
    const snapshot = await runtime.read()
    expect(a.isKillswitchEnabled(snapshot.policyStorage)).toBe(false)
    expect(a.getKillswitchThresholdsForAccount(snapshot.policyStorage)).toEqual(
      { five_hour: 5, seven_day: 10, scoped: 0 },
    )
  })
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function sameKeyTypes(before: unknown, after: unknown, path = '<root>') {
  expect(typeof after, path).toBe(typeof before)
  expect(Array.isArray(after), path).toBe(Array.isArray(before))
  if (Array.isArray(before) && Array.isArray(after)) {
    for (const [index, item] of after.entries())
      sameKeyTypes(before[index], item, `${path}[${index}]`)
  } else if (record(before) && record(after)) {
    for (const key of Object.keys(after)) {
      expect(Object.hasOwn(before, key), `${path}.${key} is a new key`).toBe(
        true,
      )
      sameKeyTypes(before[key], after[key], `${path}.${key}`)
    }
  }
}

function legacySettings(document: Record<string, unknown>) {
  return Object.fromEntries(
    ['fallbackOn', ...Object.keys(publishedSettingFields)]
      .filter((key) => Object.hasOwn(document, key))
      .map((key) => [key, document[key]]),
  )
}

function publishedTypes(document: Record<string, unknown>) {
  for (const [section, leaves] of Object.entries(publishedSettingFields)) {
    const value = document[section]
    if (value === undefined) continue
    expect(record(value), section).toBe(true)
    if (!record(value)) continue
    for (const leaf of leaves) {
      if (value[leaf] === undefined) continue
      if ((publishedBooleanLeaves as readonly string[]).includes(leaf))
        expect(typeof value[leaf], `${section}.${leaf}`).toBe('boolean')
    }
  }
  // Released quota readers use `!== false`; even the string "off" enables quota there.
  for (const [section, leaf] of [
    ['claudeCache', 'enabled'],
    ['quota', 'enabled'],
    ['quota', 'failClosedOnUnknownQuota'],
  ] as const) {
    const value = (document[section] as Record<string, unknown> | undefined)?.[
      leaf
    ]
    if (value !== undefined)
      expect(
        typeof value,
        `${section}.${leaf} must remain a legacy boolean`,
      ).toBe('boolean')
  }
}

function publishedRuntime(document: Record<string, unknown>) {
  expect(
    Object.keys(document).every((key) =>
      (publishedRuntimeKeys.root as readonly string[]).includes(key),
    ),
  ).toBe(true)
  for (const value of Object.values(
    document.accounts as Record<string, Record<string, unknown>>,
  ))
    expect(
      Object.keys(value).every((key) =>
        (publishedRuntimeKeys.entry as readonly string[]).includes(key),
      ),
    ).toBe(true)
}

for (const host of ['opencode', 'pi'] as const) {
  for (const custody of ['local', 'vault'] as const) {
    test(`${host} ${custody}: move and later store write retain published rollback keys, types, and legacy settings`, async () => {
      const f = await fixture(host, custody)
      const paths = f.stores[host]
      if (custody === 'local') await initializeNativeTestAuthority(paths)
      const store = createNativePoolStore({ paths, quota: nativeQuotaCodec })
      cleanup.push(() => store.close())
      await store.initialize()
      if (custody === 'local') {
        await store.add({
          id: 'local',
          credential: {
            type: 'api',
            apiKey: 'synthetic-key',
            baseURL: 'https://api.anthropic.com',
          },
        })
        await store.disable('local', 'user-disabled')
      }
      await store.updateSettings((settings) => ({
        ...settings,
        ...structuredClone(explicitLegacySettings),
        mainAccountId: 'local',
        nativeAccountOrder: ['local', 'other'],
      }))
      await put(paths.runtime, {
        version: 1,
        storageId: paths.storageId,
        accounts: {},
      })
      const files = [paths.config, paths.state, paths.runtime]
      const readJson = (file: string) =>
        io.readFile(file, 'utf8').then(JSON.parse, (error) => {
          if (error.code !== 'ENOENT') throw error
        })
      const before = await Promise.all(files.map(readJson))
      const check = async (written = false) => {
        const after = await Promise.all(files.map(readJson))
        for (let index = 0; index < files.length; index++)
          sameKeyTypes(before[index], after[index], files[index])
        publishedTypes(after[0])
        publishedRuntime(after[2])
        expect(legacySettings(after[0])).toEqual(legacySettings(before[0]))
        if (written)
          expect(JSON.stringify(after[0])).not.toBe(JSON.stringify(before[0]))
      }
      publishedTypes(before[0])
      publishedRuntime(before[2])
      expect((await runSettingsMoveAtStartup(f.options)).outcome).toBe('moved')
      await check()
      // This host moved the file, so it uses it.
      const service = await openSettingsService({
        file: f.paths.target,
        host,
        adopted: () => true,
      })
      if (!service) throw new Error('Missing settings service')
      cleanup.push(() => service.dispose())
      await service.update(
        [
          'claude_cache_enabled',
          'quota_enabled',
          'quota_fail_closed_on_unknown_quota',
        ].map((setting) => ({ setting, value: 'off' })),
        host,
      )
      if (custody === 'local') {
        const runtime = createNativeAccountRuntime({
          paths,
          host,
          settingsService: service,
          settingsMode: () => 'user-file',
          vault: {
            env: {
              [`${host === 'pi' ? 'PI' : 'OPENCODE'}_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE`]:
                join(f.root, 'no-enrollment.json'),
            },
          },
        })
        cleanup.push(async () => {
          await runtime.close()
        })
        await runtime.setEnabled('main', true)
      } else {
        // Vault account flags live in the roster. Exercise a real settings-store write too.
        await store.updateSettings((settings) => ({
          ...settings,
          nativeAccountOrder: ['other', 'local'],
        }))
      }
      await check(true)
    })
  }
}
