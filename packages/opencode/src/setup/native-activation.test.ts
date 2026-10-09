import { expect, test } from 'bun:test'
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
import {
  custodyTombstoneOAuth,
  type NativeCustodyInventory,
  nativeMigrationAuthorityPhase,
  readNativeMigrationJournal,
  runNativeMigration,
} from '@cortexkit/anthropic-auth-core'
import { readVaultRoster } from '@cortexkit/common-auth/claustrum'

import { activateNativeVaultForHost } from './native-activation.ts'
import { resolveNativeSetupPaths } from './native-paths.ts'
import type { CommandRunner, HarnessKind, ProcessFence } from './types.ts'

const MAIN_IDENTITY = 'account-main-uuid'
const OTHER_PROVIDER = { type: 'api', key: 'synthetic-unrelated-provider' }
const INVENTORY: NativeCustodyInventory = {
  view: 'synthetic-view',
  skipped: [],
  credentials: [
    {
      credentialId: 'oauth:anthropic',
      credentialType: 'oauth',
      accountIdentity: MAIN_IDENTITY,
      state: 'active',
    },
  ],
}

/**
 * A private synthetic home: host config, enrollment and pool files all live in
 * it. The process fence, ck runner, enrollment client and vault inventory are
 * injected, so no live host, daemon or vault is used.
 */
async function fixture(host: HarnessKind, running: string[] = []) {
  const root = await mkdtemp(join(tmpdir(), 'native-setup-activation-'))
  const env: NodeJS.ProcessEnv = {
    HOME: root,
    XDG_CONFIG_HOME: join(root, '.config'),
    XDG_DATA_HOME: join(root, '.local', 'share'),
    XDG_STATE_HOME: join(root, '.local', 'state'),
    PI_CODING_AGENT_DIR: join(root, '.pi', 'agent'),
  }
  const paths = await resolveNativeSetupPaths(host, env)
  const calls: string[] = []
  let approved = false
  const runner: CommandRunner = {
    run: async (_command, args) => {
      calls.push(args.slice(0, 3).join(' '))
      if (args.includes('approve')) approved = true
      return { exitCode: 0, stdout: '', stderr: '' }
    },
  }
  const fence: ProcessFence = {
    listRunningHosts: async () =>
      running.map((command, index) => ({ pid: 100 + index, command })),
  }
  const options = {
    env,
    runner,
    fence,
    removePiAnthropicAuth: false,
    paths,
    discover: async () => INVENTORY,
    enrollment: {
      paths: {
        tokenPath: join(root, 'enrollment', `${host}.json`),
        statePath: join(root, 'enrollment', `${host}-state.json`),
      },
      client: {
        enrollPropose: async () => {
          calls.push('propose')
          return { requestId: 'synthetic-request-id' }
        },
        enrollPoll: async () => {
          calls.push('poll')
          return approved
            ? {
                status: 'approved' as const,
                name: `anthropic-auth-${host}`,
                token: 'c'.repeat(64),
                tokenGeneration: 1,
              }
            : { status: 'pending' as const }
        },
      },
    },
  }
  return {
    root,
    paths,
    calls,
    options,
    cleanup: () => rm(root, { recursive: true, force: true }),
  }
}

async function writeHostAuth(path: string, anthropic?: unknown) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await writeFile(
    path,
    JSON.stringify({
      ...(anthropic ? { anthropic } : {}),
      other: OTHER_PROVIDER,
    }),
    { mode: 0o600 },
  )
}

test('a fresh OpenCode install is enrolled, migrated with a vault request and activated', async () => {
  const f = await fixture('opencode')
  try {
    await writeHostAuth(f.paths.hostAuthPath)
    expect(await activateNativeVaultForHost('opencode', f.options)).toBe(
      'committed',
    )
    expect(f.calls).toEqual([
      'propose',
      'poll',
      'auth enroll approve',
      'poll',
      'auth grant --principal',
    ])
    const journal = await readNativeMigrationJournal(f.paths.paths)
    expect(nativeMigrationAuthorityPhase(journal)).toBe('retired')
    expect(journal?.activation).toMatchObject({
      kind: 'activation',
      phase: 'committed',
    })
    expect((await readVaultRoster(f.paths.paths.roster))?.rows).toMatchObject([
      { credentialId: 'oauth:anthropic', accountIdentity: MAIN_IDENTITY },
    ])
    expect(JSON.parse(await readFile(f.paths.hostAuthPath, 'utf8'))).toEqual({
      anthropic: custodyTombstoneOAuth('anthropic'),
      other: OTHER_PROVIDER,
    })
  } finally {
    await f.cleanup()
  }
})

test('a retired local pool is activated without rerunning its migration', async () => {
  const f = await fixture('opencode')
  try {
    await writeHostAuth(f.paths.hostAuthPath)
    await runNativeMigration({
      paths: f.paths.paths,
      legacyConfigPath: f.paths.legacyConfigPath,
      legacyStatePath: f.paths.legacyStatePath,
      host: 'opencode',
      hostAuthPath: f.paths.hostAuthPath,
      routingSourcePath: f.paths.routingSourcePath,
      routingDestinationPath: f.paths.routingDestinationPath,
      env: {},
      processFence: async () => {},
      removePiAnthropicAuth: false,
    })
    expect(
      nativeMigrationAuthorityPhase(
        await readNativeMigrationJournal(f.paths.paths),
      ),
    ).toBe('retired')
    expect(await activateNativeVaultForHost('opencode', f.options)).toBe(
      'committed',
    )
    expect(
      (await readNativeMigrationJournal(f.paths.paths))?.activation,
    ).toMatchObject({ phase: 'committed' })
  } finally {
    await f.cleanup()
  }
})

test('environment, running-host and Pi consent fences refuse before enrollment or any file write', async () => {
  const cases: Array<{
    host: HarnessKind
    running?: string[]
    env?: NodeJS.ProcessEnv
    anthropic?: unknown
    consent?: boolean
    error: Record<string, unknown>
  }> = [
    {
      host: 'opencode',
      env: { OPENCODE_AUTH_CONTENT: '{}' },
      error: { code: 'auth-content-refused' },
    },
    {
      host: 'opencode',
      running: ['opencode serve'],
      error: { name: 'ProcessFenceViolationError' },
    },
    {
      host: 'pi',
      anthropic: { type: 'api_key', key: 'synthetic-pi-api-key' },
      consent: true,
      error: { code: 'primary-conflict' },
    },
    {
      host: 'pi',
      anthropic: {
        type: 'oauth',
        access: 'synthetic-pi-access',
        refresh: 'synthetic-pi-refresh',
        expires: 1,
      },
      error: { code: 'consent-required' },
    },
  ]
  for (const item of cases) {
    const f = await fixture(item.host, item.running)
    try {
      await writeHostAuth(f.paths.hostAuthPath, item.anthropic)
      const host = await readFile(f.paths.hostAuthPath, 'utf8')
      await expect(
        activateNativeVaultForHost(item.host, {
          ...f.options,
          env: { ...f.options.env, ...item.env },
          removePiAnthropicAuth: item.consent ?? false,
        }),
      ).rejects.toMatchObject(item.error)
      expect(f.calls).toEqual([])
      expect(await readFile(f.paths.hostAuthPath, 'utf8')).toBe(host)
      expect(await readNativeMigrationJournal(f.paths.paths)).toBeUndefined()
      const entries = await readdir(f.root)
      expect(entries.includes('enrollment')).toBe(false)
    } finally {
      await f.cleanup()
    }
  }
})
