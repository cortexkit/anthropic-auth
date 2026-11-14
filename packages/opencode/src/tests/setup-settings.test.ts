import { afterEach, expect, spyOn } from 'bun:test'
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import * as core from '@cortexkit/anthropic-auth-core'
import { parse } from 'jsonc-parser'
import { createTestLifetimeSuite } from '../../../core/src/tests/test-lifetime.ts'
import {
  migrateNativeLocalForHost,
  type NativeLocalSetupOptions,
  writeNativeLocalSetupSettings,
} from '../setup/native-local.ts'
import { resolveNativeSetupPaths } from '../setup/native-paths.ts'

const { test: lifetimeTest, deferCleanup } = createTestLifetimeSuite()
afterEach(() => {
  mockWriter?.mockRestore()
  mockWriter = undefined
})
let mockWriter:
  | ReturnType<typeof spyOn<typeof core, 'writeNativeSetupSettings'>>
  | undefined

const moved = {
  dump: { enabled: true },
  claudeCache: { enabled: false },
  quota: { enabled: false, failClosedOnUnknownQuota: false },
}
const keys = [
  'dump_enabled',
  'claude_cache_enabled',
  'quota_enabled',
  'quota_fail_closed_on_unknown_quota',
]

async function json(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await writeFile(path, JSON.stringify(value), { mode: 0o600 })
}

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'opencode-setup-settings-'))
  deferCleanup(() => rm(home, { recursive: true, force: true }))
  const target = join(home, 'settings.jsonc')
  const env = {
    HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_DATA_HOME: join(home, '.data'),
    XDG_STATE_HOME: join(home, '.state'),
    ANTHROPIC_AUTH_SETTINGS_FILE: target,
  }
  const plan = await resolveNativeSetupPaths('opencode', env)
  await json(plan.legacyConfigPath, {
    version: 1,
    mainAccountId: 'main',
    main: { profile: { accountUuid: '11111111-2222-4333-8444-555555555555' } },
    ...moved,
  })
  await json(plan.hostAuthPath, {
    anthropic: {
      type: 'oauth',
      access: 'setup-settings-access',
      refresh: 'setup-settings-refresh',
      expires: 2000,
    },
  })
  const output: string[] = []
  const options: NativeLocalSetupOptions = {
    env,
    paths: plan,
    removePiAnthropicAuth: false,
    fence: { listRunningHosts: async () => [] },
    reportSettings: (message) => output.push(message),
  }
  const stored = async () => {
    const runtime = core.createNativeAccountRuntime({
      host: 'opencode',
      paths: plan.paths,
      vault: { env },
    })
    try {
      return (await runtime.read()).settings
    } finally {
      await runtime.close()
    }
  }
  const imported: Record<string, unknown>[] = []
  const phases: (string | undefined)[] = []
  const beforeWrite: { run?: () => Promise<void> } = {}
  const writer = core.writeNativeSetupSettings
  mockWriter = spyOn(core, 'writeNativeSetupSettings').mockImplementation(
    async (input) => {
      phases.push((await core.readNativeMigrationJournal(plan.paths))?.phase)
      imported.push(await stored())
      expect(input.settings).toEqual(moved)
      await beforeWrite.run?.()
      return writer(input)
    },
  )
  return {
    home,
    target,
    plan,
    options,
    output,
    imported,
    phases,
    stored,
    beforeWrite,
    run: () => migrateNativeLocalForHost('opencode', options),
    marker: () => json(`${target}.moved`, { version: 1, target, at: 1 }),
  }
}

function noMovedFields(settings: Record<string, unknown>) {
  for (const section of Object.keys(moved))
    expect(settings).not.toHaveProperty(section)
}

for (const state of [
  'legacy',
  'handmade',
  'invalid-protection',
  'marked',
] as const) {
  lifetimeTest(
    `stopped setup routes settings once in ${state} state without running the move`,
    async () => {
      const f = await fixture()
      if (state !== 'legacy')
        await json(
          f.target,
          state === 'invalid-protection'
            ? { killswitch_default_five_hour: 101 }
            : {},
        )
      if (state === 'marked') await f.marker()
      await f.run()
      expect(f.phases).toEqual(['committed'])
      expect(f.imported).toHaveLength(1)
      noMovedFields(f.imported[0]!)
      expect((await core.readNativeMigrationJournal(f.plan.paths))?.phase).toBe(
        'retired',
      )
      if (state === 'legacy') {
        expect(await f.stored()).toMatchObject(moved)
        await expect(readFile(f.target)).rejects.toMatchObject({
          code: 'ENOENT',
        })
        await expect(readFile(`${f.target}.moved`)).rejects.toMatchObject({
          code: 'ENOENT',
        })
      } else {
        noMovedFields(await f.stored())
        expect(parse(await readFile(f.target, 'utf8'))).toEqual({
          ...(state === 'invalid-protection'
            ? { killswitch_default_five_hour: 101 }
            : {}),
          dump_enabled: true,
          claude_cache_enabled: 'off',
          quota_enabled: 'off',
          quota_fail_closed_on_unknown_quota: 'off',
        })
        expect(
          JSON.parse(await readFile(`${f.target}.moved`, 'utf8')),
        ).toMatchObject({ version: 1 })
      }
      expect(
        (await readdir(dirname(f.plan.legacyConfigPath))).filter((name) =>
          name.endsWith('.MOVED_READPLEASE'),
        ),
      ).toEqual([])
    },
  )
}

lifetimeTest(
  'setup fills absent keys and reports each differing legacy value once without replacing top-level or host values',
  async () => {
    const f = await fixture()
    await json(f.target, {
      dump_enabled: false,
      claude_cache_enabled: { default: 'default', opencode: 'on' },
    })
    await f.run()
    expect(parse(await readFile(f.target, 'utf8'))).toEqual({
      dump_enabled: false,
      claude_cache_enabled: { default: 'default', opencode: 'on' },
      quota_enabled: 'off',
      quota_fail_closed_on_unknown_quota: 'off',
    })
    noMovedFields(await f.stored())
    for (const [key, value] of [
      ['dump_enabled', 'true'],
      ['claude_cache_enabled', '"off"'],
    ]) {
      expect(
        f.output.filter((line) =>
          line.includes(`Setup skipped setting "${key}"`),
        ),
      ).toHaveLength(1)
      expect(
        f.output.filter(
          (line) =>
            line.includes(`"${key}"`) && line.includes(`legacy value ${value}`),
        ),
      ).toHaveLength(1)
    }
  },
)

for (const copyHost of ['opencode', 'pi'] as const) {
  lifetimeTest(
    `marked missing file recreates with ${copyHost === 'opencode' ? 'acting-host copy' : 'legacy store, not peer copy'} protection`,
    async () => {
      const f = await fixture()
      await f.marker()
      const copied = core.legacySettingsProtection(
        { killswitch: { enabled: true, main: { five_hour: 73 } } },
        'opencode',
      )
      await core.writeSettingsProtectionCopy(f.target, copyHost, {
        readAt: 1,
        values: copied,
      })
      // Under this explicit target Pi's protection is known only from its
      // applied copy: with no Pi store found, recreation would be refused.
      if (copyHost === 'opencode')
        await core.writeSettingsProtectionCopy(f.target, 'pi', {
          readAt: 1,
          values: copied,
        })
      const storedProtection = {
        killswitch: { enabled: true, main: { five_hour: 31 } },
      }
      f.beforeWrite.run = async () => {
        const runtime = core.createNativeAccountRuntime({
          host: 'opencode',
          paths: f.plan.paths,
          vault: { env: f.options.env },
        })
        try {
          await runtime.updateSettings((stored) => ({
            ...stored,
            ...storedProtection,
          }))
        } finally {
          await runtime.close()
        }
      }
      await f.run()
      expect(f.phases).toEqual(['committed'])
      noMovedFields(f.imported[0]!)
      const file = parse(await readFile(f.target, 'utf8'))
      const expected =
        copyHost === 'opencode'
          ? copied
          : core.legacySettingsProtection(storedProtection, 'opencode')
      const service = await core.openSettingsService({
        file: f.target,
        host: 'opencode',
      })
      if (!service) throw new Error('Settings service did not open')
      try {
        const contexts = service.snapshot().contexts
        for (const key of core.SETTINGS_PROTECTION_KEYS)
          expect(contexts.opencode.noModel[key]).toEqual(expected[key])
        expect(contexts.pi.noModel.killswitch_default_five_hour).toBe(73)
      } finally {
        await service.dispose()
      }
      expect(file.killswitch_default_five_hour).toEqual(
        copyHost === 'pi' ? { default: 31, pi: 73 } : 73,
      )
      expect(file).toMatchObject({
        dump_enabled: true,
        claude_cache_enabled: 'off',
        quota_enabled: 'off',
      })
      // The pre-existing protection record is unchanged; none of the imported
      // settings were added to the native store by either phase of setup.
      const stored = await f.stored()
      expect(stored).toMatchObject(storedProtection)
      noMovedFields(stored)
    },
  )
}

lifetimeTest(
  'marked missing file with no acting-host copy and unreadable store refuses recreation on rung 3',
  async () => {
    const f = await fixture()
    await f.marker()
    f.beforeWrite.run = async () => {
      await writeFile(f.plan.paths.config, '{broken')
    }
    await expect(f.run()).rejects.toMatchObject({
      code: 'setup-settings-write-failed',
    })
    expect(f.phases).toEqual(['committed'])
    noMovedFields(f.imported[0]!)
    expect((await core.readNativeMigrationJournal(f.plan.paths))?.phase).toBe(
      'committed',
    )
    await expect(readFile(f.target)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(f.plan.paths.config, 'utf8')).toBe('{broken')
    expect(f.output.join('\n')).toContain('protection settings are unknown')
    expect(f.output.join('\n')).toContain(f.target)
  },
)

lifetimeTest(
  'marked missing file keeps the other host stricter legacy protection at its own level',
  async () => {
    const f = await fixture()
    await f.marker()
    // Pi's own settings store (its account pool) under the same home, never
    // read by OpenCode before.
    await json(join(f.home, '.pi', 'agent', 'anthropic-auth-pool.json'), {
      version: 1,
      accounts: [],
      killswitch: { enabled: true, main: { five_hour: 55 } },
    })
    await f.run()
    expect(f.phases).toEqual(['committed'])
    const file = parse(await readFile(f.target, 'utf8'))
    expect(file.killswitch_default_five_hour).toMatchObject({ pi: 55 })
    expect(file).toMatchObject({ dump_enabled: true })
  },
)

lifetimeTest(
  'setup never persists a settings-service projection to the legacy store',
  async () => {
    const f = await fixture()
    await f.run()
    mockWriter?.mockRestore()
    mockWriter = undefined
    const original = await f.stored()
    await json(f.target, {
      quota_enabled: 'off',
      claude_cache_enabled: 'off',
      quota_fail_closed_on_unknown_quota: 'off',
    })
    const service = await core.openSettingsService({
      file: f.target,
      host: 'opencode',
    })
    if (!service) throw new Error('Settings service did not open')
    const projected = core.resolveSettingsRecord(
      {},
      service.snapshot(),
      'opencode',
    )
    await service.dispose()
    await rm(f.target)
    const outcome = await writeNativeLocalSetupSettings(
      'opencode',
      f.plan,
      f.options,
      projected,
    )
    expect(outcome.outcome).toBe('failed')
    expect(await f.stored()).toEqual(original)
    expect(original).toMatchObject({
      claudeCache: { enabled: false },
      quota: { enabled: false, failClosedOnUnknownQuota: false },
    })
    await expect(readFile(f.target)).rejects.toMatchObject({ code: 'ENOENT' })
  },
)

for (const marker of [false, true]) {
  lifetimeTest(
    `malformed user file ${marker ? 'with' : 'without'} marker refuses only after credential commit`,
    async () => {
      const f = await fixture()
      await writeFile(f.target, '{broken')
      if (marker) await f.marker()
      await expect(f.run()).rejects.toMatchObject({
        code: 'setup-settings-write-failed',
      })
      expect(f.phases).toEqual(['committed'])
      expect((await core.readNativeMigrationJournal(f.plan.paths))?.phase).toBe(
        'committed',
      )
      noMovedFields(await f.stored())
      expect(await readFile(f.target, 'utf8')).toBe('{broken')
      expect(f.output.join('\n')).toContain(
        core.malformedSettingsText(f.target),
      )
      expect(f.output.join('\n')).toContain(
        'Accounts were moved, but these settings were not saved:',
      )
      expect(f.output.join('\n')).toContain(
        'Run the same setup command again to finish; nothing needs to be set by hand.',
      )
      for (const key of keys) expect(f.output.join('\n')).toContain(key)
      if (!marker)
        await expect(readFile(`${f.target}.moved`)).rejects.toMatchObject({
          code: 'ENOENT',
        })
    },
  )
}

lifetimeTest(
  'a failed settings write leaves transferred credentials committed and lists settings to retry',
  async () => {
    const f = await fixture()
    await mkdir(f.target)
    await expect(f.run()).rejects.toMatchObject({
      code: 'setup-settings-write-failed',
    })
    expect(f.phases).toEqual(['committed'])
    expect((await core.readNativeMigrationJournal(f.plan.paths))?.phase).toBe(
      'committed',
    )
    noMovedFields(await f.stored())
    const screen = f.output.join('\n')
    expect(screen).toContain(
      core.SETTINGS_WRITE_FAILURES['settings-unavailable'].text(f.target),
    )
    expect(screen).toContain(
      'Accounts were moved, but these settings were not saved:',
    )
    expect(screen).toContain(
      'Run the same setup command again to finish; nothing needs to be set by hand.',
    )
    for (const key of keys) expect(screen).toContain(key)
  },
)
