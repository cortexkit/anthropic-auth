import { afterEach, expect, test } from 'bun:test'
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, win32 } from 'node:path'

import {
  getAccountStatePath,
  getAccountStoragePath,
  getOpenCodeConfigDir,
} from '../accounts.ts'
import type { PathResolutionOptions } from '../path-options.ts'
import { canonicalPath } from '../pool-paths.ts'
import {
  hasSettingsMoveMarker,
  resolveSettingsMode,
  type SettingsModeFs,
  writeSettingsMoveMarker,
} from '../settings-mode.ts'
import {
  getDefaultSettingsStorePaths,
  getPiAgentDir,
  getSettingsFilePath,
  getSettingsStorePaths,
  hasPrivateSettingsConfigHome,
  isSeparateSettingsInstall,
  resolveSettingsPaths,
  type SettingsHost,
} from '../settings-paths.ts'
import { writeOwnerOnlyExclusive } from '../state-layout-io.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

async function sandbox(overrides: Record<string, string | undefined> = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'settings-paths-')))
  roots.push(root)
  const touched: string[] = []
  const warnings: string[] = []
  const record = (path: string) => {
    expect(path === root || path.startsWith(`${root}/`)).toBe(true)
    touched.push(path)
  }
  const options = {
    home: root,
    env: { HOME: root, ...overrides } as NodeJS.ProcessEnv,
    platform: 'linux' as const,
    realpath: async (path: string) => {
      record(path)
      return realpath(path)
    },
    warn: (message: string) => warnings.push(message),
  }
  const fs: SettingsModeFs = {
    async exists(path) {
      record(path)
      try {
        await lstat(path)
        return true
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
        throw error
      }
    },
    async mkdir(path) {
      record(path)
      await mkdir(path, { recursive: true, mode: 0o700 })
    },
    async writeMarker(path, bytes) {
      record(path)
      await writeOwnerOnlyExclusive(path, bytes, 'linux')
    },
  }
  return { root, options, fs, touched, warnings }
}

test('account resolvers accept isolated inputs and preserve legacy naming and precedence', async () => {
  const { root, options, touched } = await sandbox()
  const directory = join(root, '.config', 'opencode')
  expect(getOpenCodeConfigDir(options.env, root, options)).toBe(directory)
  expect(getAccountStoragePath(options)).toBe(
    join(directory, 'anthropic-auth.json'),
  )
  expect(getAccountStatePath(undefined, options)).toBe(
    join(directory, 'anthropic-auth-state.json'),
  )
  const custom = join(root, 'custom.json')
  options.env.OPENCODE_ANTHROPIC_AUTH_FILE = ` ${custom} `
  expect(getAccountStoragePath(options)).toBe(custom)
  expect(getAccountStatePath(undefined, options)).toBe(`${custom}.state.json`)
  options.env.OPENCODE_ANTHROPIC_AUTH_STATE_FILE = join(root, 'state.json')
  expect(getAccountStatePath(custom, options)).toBe(join(root, 'state.json'))
  expect(touched).toEqual([])
})

test('the shared default target and both hosts defaults stay inside the supplied home', async () => {
  const { root, options, fs } = await sandbox()
  for (const host of ['opencode', 'pi'] as const) {
    const paths = await resolveSettingsPaths(host, options)
    expect(paths.target).toBe(
      join(root, '.config', 'cortexkit', 'anthropic-auth.jsonc'),
    )
    expect(paths.marker).toBe(`${paths.target}.moved`)
    expect(paths.sourceRule).toBe('default')
    expect(paths.separate).toBe(false)
    expect(paths.defaults.opencode).toEqual({
      account: join(root, '.config', 'opencode', 'anthropic-auth.json'),
      state: join(root, '.config', 'opencode', 'anthropic-auth-state.json'),
    })
    expect(paths.defaults.pi).toEqual({
      account: join(root, '.pi', 'agent', 'anthropic-auth.json'),
      state: join(root, '.pi', 'agent', 'anthropic-auth-state.json'),
    })
    expect(paths.own).toEqual(paths.defaults[host])
    expect(await resolveSettingsMode(paths, { ...options, fs })).toBe('legacy')
  }
})

for (const host of ['opencode', 'pi'] as const) {
  for (const xdgKind of ['private', 'home-config', 'relative'] as const) {
    test(`${host}: ${xdgKind} XDG selects the target and source rule, not a separate install`, async () => {
      const { root, options } = await sandbox()
      options.env.XDG_CONFIG_HOME =
        xdgKind === 'private'
          ? join(root, 'private-config')
          : xdgKind === 'home-config'
            ? join(root, '.config')
            : 'relative-config'
      const paths = await resolveSettingsPaths(host, options)
      expect(paths.target).toBe(
        join(
          root,
          xdgKind === 'private' ? 'private-config' : '.config',
          'cortexkit',
          'anthropic-auth.jsonc',
        ),
      )
      expect(paths.sourceRule).toBe(xdgKind === 'private' ? 'own' : 'default')
      expect(paths.separate).toBe(false)
      expect(paths.defaults.opencode.account).toBe(
        join(
          root,
          xdgKind === 'private' ? 'private-config' : '.config',
          'opencode',
          'anthropic-auth.json',
        ),
      )
    })
  }
}

const separateCases: [SettingsHost, string, boolean?][] = [
  ['opencode', 'OPENCODE_ANTHROPIC_AUTH_FILE'],
  ['opencode', 'OPENCODE_ANTHROPIC_AUTH_STATE_FILE'],
  ['opencode', 'OPENCODE_CONFIG_DIR'],
  ['opencode', 'OPENCODE_CONFIG_DIR', true],
  ['pi', 'PI_ANTHROPIC_AUTH_FILE'],
  ['pi', 'PI_CODING_AGENT_DIR'],
  ['pi', 'PI_AGENT_DIR'],
]

for (const [host, variable, xdg] of separateCases) {
  test(`${host}: ${variable}${xdg ? ' with XDG' : ''} at a non-default path is separate`, async () => {
    const { root, options, fs, touched } = await sandbox()
    options.env[variable] = join(root, 'separate')
    if (xdg) options.env.XDG_CONFIG_HOME = join(root, 'xdg')
    expect(await isSeparateSettingsInstall(host, options)).toBe(true)
    const paths = await resolveSettingsPaths(host, options)
    expect(await resolveSettingsMode(paths, { ...options, fs })).toBe(
      'separate',
    )
    // A separate install does not inspect even an existing shared settings file.
    await mkdir(dirname(paths.target), { recursive: true })
    await writeFile(paths.target, '{}')
    touched.length = 0
    expect(await resolveSettingsMode(paths, { ...options, fs })).toBe(
      'separate',
    )
    expect(touched).toEqual([])
  })

  test(`${host}: ${variable}${xdg ? ' with XDG' : ''} equal by real path is not separate`, async () => {
    const { root, options } = await sandbox()
    if (xdg) options.env.XDG_CONFIG_HOME = join(root, 'xdg')
    const defaults = getDefaultSettingsStorePaths(host, options)
    const alias = join(root, 'home-alias')
    await symlink(root, alias, 'dir')
    const baseline = variable.endsWith('_STATE_FILE')
      ? defaults.state
      : variable.endsWith('_FILE')
        ? defaults.account
        : host === 'pi'
          ? join(root, '.pi', 'agent')
          : join(root, xdg ? 'xdg' : '.config', 'opencode')
    options.env[variable] = baseline.replace(root, alias)
    expect(await isSeparateSettingsInstall(host, options)).toBe(false)
  })
}

for (const host of ['opencode', 'pi'] as const) {
  test(`${host}: foreign-host, routing and state-layout overrides do not make it separate`, async () => {
    const { root, options } = await sandbox()
    for (const variable of host === 'pi'
      ? [
          'OPENCODE_ANTHROPIC_AUTH_FILE',
          'OPENCODE_ANTHROPIC_AUTH_STATE_FILE',
          'OPENCODE_CONFIG_DIR',
        ]
      : ['PI_ANTHROPIC_AUTH_FILE', 'PI_CODING_AGENT_DIR', 'PI_AGENT_DIR'])
      options.env[variable] = join(root, variable)
    options.env.OPENCODE_ANTHROPIC_AUTH_ROUTING_STATE_FILE = join(
      root,
      'oc-routing',
    )
    options.env.PI_ANTHROPIC_AUTH_ROUTING_STATE_FILE = join(root, 'pi-routing')
    options.env.XDG_STATE_HOME = join(root, 'state')
    expect(await isSeparateSettingsInstall(host, options)).toBe(false)
  })

  for (const storeOverride of [false, true]) {
    test(`${host}: an absolute settings override${storeOverride ? ' plus a store override' : ''} opts into the user file`, async () => {
      const { root, options, touched } = await sandbox()
      options.env.ANTHROPIC_AUTH_SETTINGS_FILE = join(
        root,
        'shared',
        'settings.jsonc',
      )
      if (storeOverride)
        options.env[
          host === 'opencode'
            ? 'OPENCODE_ANTHROPIC_AUTH_FILE'
            : 'PI_ANTHROPIC_AUTH_FILE'
        ] = join(root, 'own', 'accounts.json')
      const paths = await resolveSettingsPaths(host, options)
      expect(paths.target).toBe(options.env.ANTHROPIC_AUTH_SETTINGS_FILE)
      expect(paths.separate).toBe(false)
      expect(paths.sourceRule).toBe('own')
      expect(touched).toEqual([])
      expect(paths.own.account).toBe(
        storeOverride
          ? join(root, 'own', 'accounts.json')
          : paths.defaults[host].account,
      )
    })
  }
}

for (const invalid of ['', 'relative/settings.jsonc']) {
  test(`settings override ${JSON.stringify(invalid)} is ignored and logged once`, async () => {
    const { root, options, warnings } = await sandbox({
      ANTHROPIC_AUTH_SETTINGS_FILE: invalid,
    })
    for (let i = 0; i < 2; i++) {
      const paths = await resolveSettingsPaths('opencode', options)
      expect(paths.target).toBe(
        join(root, '.config', 'cortexkit', 'anthropic-auth.jsonc'),
      )
      expect(paths.sourceRule).toBe('default')
    }
    expect(warnings).toEqual([
      'ANTHROPIC_AUTH_SETTINGS_FILE is empty or relative; ignoring it (an absolute path is required).',
    ])
    options.env.OPENCODE_CONFIG_DIR = join(root, 'separate')
    expect(await isSeparateSettingsInstall('opencode', options)).toBe(true)
    expect(warnings).toHaveLength(1)
  })
}

test('Pi directory precedence and custom state naming match the extension without OpenCode state leakage', async () => {
  const { root, options } = await sandbox()
  options.env.PI_AGENT_DIR = join(root, 'agent')
  options.env.PI_CODING_AGENT_DIR = join(root, 'coding-agent')
  options.env.OPENCODE_ANTHROPIC_AUTH_STATE_FILE = join(root, 'wrong-state')
  expect(getPiAgentDir(options)).toBe(join(root, 'coding-agent'))
  expect(getSettingsStorePaths('pi', options)).toEqual({
    account: join(root, 'coding-agent', 'anthropic-auth.json'),
    state: join(root, 'coding-agent', 'anthropic-auth-state.json'),
  })
  options.env.PI_ANTHROPIC_AUTH_FILE = join(root, 'custom.json')
  expect(getSettingsStorePaths('pi', options).state).toBe(
    join(root, 'custom.json.state.json'),
  )
})

test('canonical comparisons use aliases of the nearest existing parent for missing descendants', async () => {
  const { root, options } = await sandbox()
  await mkdir(join(root, '.config'))
  await symlink(join(root, '.config'), join(root, 'config-alias'), 'dir')
  options.env.XDG_CONFIG_HOME = join(root, 'config-alias')
  expect(await hasPrivateSettingsConfigHome(options)).toBe(false)
  expect((await resolveSettingsPaths('opencode', options)).sourceRule).toBe(
    'default',
  )
  expect(
    await canonicalPath(
      join(root, 'config-alias', 'missing', 'nested.json'),
      options,
    ),
  ).toBe(join(root, '.config', 'missing', 'nested.json'))
})

test('canonical comparison errors other than absence are not mistaken for different paths', async () => {
  const { options } = await sandbox()
  options.realpath = async () => {
    throw Object.assign(new Error('unreadable'), { code: 'EACCES' })
  }
  await expect(isSeparateSettingsInstall('opencode', options)).rejects.toThrow(
    'unreadable',
  )
})

test('an env with no home variable uses only the supplied sandbox home', async () => {
  const { root, options } = await sandbox()
  options.env = {}
  const paths = await resolveSettingsPaths('opencode', options)
  expect(paths.target).toBe(
    join(root, '.config', 'cortexkit', 'anthropic-auth.jsonc'),
  )
  expect(paths.own.account).toBe(
    join(root, '.config', 'opencode', 'anthropic-auth.json'),
  )
  expect(paths.separate).toBe(false)
})

for (const xdg of ['unset', 'relative', 'home-config', 'private'] as const) {
  test(`Windows ${xdg} XDG has the shared API target and correct source rule`, async () => {
    const home = 'C:\\sandbox\\home'
    const touched: string[] = []
    const options: PathResolutionOptions = {
      home,
      platform: 'win32',
      env: {
        USERPROFILE: home,
        APPDATA: win32.join(home, 'AppData', 'Roaming'),
        XDG_CONFIG_HOME:
          xdg === 'home-config'
            ? win32.join(home, '.config')
            : xdg === 'private'
              ? win32.join(home, 'private')
              : xdg === 'relative'
                ? 'relative-config'
                : undefined,
      },
      realpath: async (path) => {
        expect(path === home || path.startsWith(`${home}\\`)).toBe(true)
        touched.push(path)
        return path
      },
    }
    for (const host of ['opencode', 'pi'] as const) {
      const paths = await resolveSettingsPaths(host, options)
      const base =
        xdg === 'home-config'
          ? '.config'
          : xdg === 'private'
            ? 'private'
            : 'AppData\\Roaming'
      expect(paths.target).toBe(
        win32.join(home, base, 'cortexkit', 'anthropic-auth.jsonc'),
      )
      expect(paths.sourceRule).toBe(xdg === 'private' ? 'own' : 'default')
      expect(paths.separate).toBe(false)
      expect(paths.defaults.opencode.account).toBe(
        win32.join(
          home,
          xdg === 'private' ? 'private' : '.config',
          'opencode',
          'anthropic-auth.json',
        ),
      )
      expect(paths.defaults.pi.account).toBe(
        win32.join(home, '.pi', 'agent', 'anthropic-auth.json'),
      )
    }
    expect(touched.length).toBeGreaterThan(0)
    if (xdg === 'unset') {
      options.env = {}
      expect(getSettingsFilePath(options)).toBe(
        win32.join(
          home,
          'AppData',
          'Roaming',
          'cortexkit',
          'anthropic-auth.jsonc',
        ),
      )
    }
  })
}

test('marker publication is owner-only, target-specific and canonical before missing folders exist', async () => {
  const { root, options, fs, touched } = await sandbox()
  const alias = join(root, 'alias')
  await symlink(root, alias, 'dir')
  const target = join(alias, 'not-yet', 'nested', 'settings.jsonc')
  const markerOptions = { ...options, fs, now: () => 123456789 }
  expect(await hasSettingsMoveMarker(target, markerOptions)).toBe(false)
  await writeSettingsMoveMarker(target, markerOptions)
  expect(await hasSettingsMoveMarker(target, markerOptions)).toBe(true)
  expect(JSON.parse(await readFile(`${target}.moved`, 'utf8'))).toEqual({
    version: 1,
    target: join(root, 'not-yet', 'nested', 'settings.jsonc'),
    at: 123456789,
  })
  expect((await lstat(`${target}.moved`)).mode & 0o777).toBe(0o600)
  const bytes = await readFile(`${target}.moved`, 'utf8')
  await writeSettingsMoveMarker(target, { ...markerOptions, now: () => 999 })
  expect(await readFile(`${target}.moved`, 'utf8')).toBe(bytes)
  const other = join(root, 'other.jsonc')
  expect(await hasSettingsMoveMarker(other, markerOptions)).toBe(false)
  expect(touched.some((path) => path.endsWith('MOVED_READPLEASE'))).toBe(false)
})

test('concurrent marker publishers keep the first marker', async () => {
  const { root, options, fs } = await sandbox()
  const target = join(root, 'shared.jsonc')
  await Promise.all([
    writeSettingsMoveMarker(target, { ...options, fs, now: () => 1 }),
    writeSettingsMoveMarker(target, { ...options, fs, now: () => 2 }),
  ])
  const marker = JSON.parse(await readFile(`${target}.moved`, 'utf8'))
  expect([1, 2]).toContain(marker.at)
  expect(marker.target).toBe(target)
  expect(marker.version).toBe(1)
})

test('Windows marker creation delegates owner-only creation to the native backend', async () => {
  const home = 'C:\\sandbox\\home'
  const target = win32.join(home, 'missing', 'settings.jsonc')
  const writes: { path: string; bytes: string }[] = []
  await writeSettingsMoveMarker(target, {
    home,
    env: { USERPROFILE: home },
    platform: 'win32',
    realpath: async (path) => {
      expect(path === home || path.startsWith(`${home}\\`)).toBe(true)
      if (path === home) return home
      throw Object.assign(new Error('absent'), { code: 'ENOENT' })
    },
    now: () => 42,
    fs: {
      exists: async (path) => {
        expect(path).toBe(`${target}.moved`)
        return false
      },
      mkdir: async (path) => {
        expect(path).toBe(win32.dirname(target))
      },
    },
    ownership: {
      privateFiles: {
        verifyOwnerOnly: async () => {
          throw new Error('unexpected verification')
        },
        readPrivateFile: async () => {
          throw new Error('unexpected read')
        },
        createPrivateFile: async (path, bytes) => {
          writes.push({ path, bytes: Buffer.from(bytes ?? '').toString() })
        },
      },
    },
  })
  expect(writes).toHaveLength(1)
  expect(writes[0]?.path).toBe(`${target}.moved`)
  expect(JSON.parse(writes[0]?.bytes ?? '')).toEqual({
    version: 1,
    target,
    at: 42,
  })
})

for (const file of [false, true]) {
  for (const marker of [false, true]) {
    for (const completed of [false, true]) {
      test(`mode: file=${file}, marker=${marker}, own move completed=${completed}`, async () => {
        const { root, options, fs } = await sandbox()
        const target = join(root, 'settings.jsonc')
        if (file) await writeFile(target, 'malformed still exists')
        if (marker)
          await writeFile(`${target}.moved`, 'existence alone is authoritative')
        expect(
          await resolveSettingsMode(
            { target, separate: false },
            {
              ...options,
              fs,
              moveCompleted: completed,
            },
          ),
        ).toBe(file || marker || completed ? 'user-file' : 'legacy')
      })
    }
  }
}

test('a note never establishes authority, and a deleted file stays in user-file mode with a marker', async () => {
  const { root, options, fs, touched } = await sandbox()
  const target = join(root, 'settings.jsonc')
  await writeFile(join(root, 'anthropic-auth.json.MOVED_READPLEASE'), target)
  const paths = { target, separate: false }
  expect(await resolveSettingsMode(paths, { ...options, fs })).toBe('legacy')
  await writeSettingsMoveMarker(target, { ...options, fs })
  await writeFile(target, '{}')
  await rm(target)
  expect(await resolveSettingsMode(paths, { ...options, fs })).toBe('user-file')
  expect(touched.every((path) => !path.endsWith('MOVED_READPLEASE'))).toBe(true)
})
