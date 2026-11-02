import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CacheKeepSessionRegistry,
  createNativeMenuExecutor,
  createNativePoolStore,
  getHostClaustrumEnrollmentPaths,
  type NativeCustodyClient,
  type NativeMenuRequest,
  openNativePiAuthSlot,
  readNativeEnrollmentMode,
  resolveNativePoolPaths,
  StickySessionRouter,
} from '@cortexkit/anthropic-auth-core'
import { readVaultRoster } from '@cortexkit/common-auth/claustrum'
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from '@earendil-works/pi-coding-agent'
import { nativeQuotaCodec } from '../../../core/src/native-quota-codec.ts'
import { readNativeRuntime } from '../../../core/src/native-runtime.ts'
import { nativeVaultPaths } from '../../../core/src/native-vault-paths.ts'
import { type PiNativeCommands, registerCommands } from '../commands.ts'
import { closePiNativeRuntime, getPiNativeRuntime } from '../native.ts'
import { createPiNativeCommands } from '../native-commands.ts'
import { readNativePiFixture, saveNativePiFixture } from './native-fixture.ts'

let directory: string
let storagePath: string
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'pi-native-commands-'))
  storagePath = join(directory, 'anthropic-auth.json')
  process.env.PI_ANTHROPIC_AUTH_FILE = storagePath
  process.env.PI_CODING_AGENT_DIR = directory
  process.env.PI_ANTHROPIC_AUTH_CACHEKEEP_REGISTRY_DIR = join(
    directory,
    'cachekeep',
  )
  process.env.PI_ANTHROPIC_AUTH_ROUTING_STATE_FILE = join(
    directory,
    'captured-routing.json',
  )
  await saveNativePiFixture(
    {
      version: 1,
      accounts: [
        {
          id: 'fallback',
          type: 'oauth',
          refresh: 'fixture-fallback-refresh',
          access: 'sk-ant-oat01-fixture-fallback-access',
          expires: Date.now() + 3_600_000,
        },
      ],
    },
    storagePath,
  )
})
afterEach(async () => {
  await closePiNativeRuntime(storagePath)
  delete process.env.PI_ANTHROPIC_AUTH_FILE
  delete process.env.PI_CODING_AGENT_DIR
  delete process.env.PI_ANTHROPIC_AUTH_CACHEKEEP_REGISTRY_DIR
  delete process.env.PI_ANTHROPIC_AUTH_ROUTING_STATE_FILE
  await rm(directory, { recursive: true, force: true })
})

async function bytes() {
  const paths = await resolveNativePoolPaths(storagePath)
  return Promise.all(
    [paths.config, paths.state, paths.runtime, paths.journal].map((path) =>
      readFile(path, 'utf8'),
    ),
  )
}
function controller() {
  const backend = createPiNativeCommands(storagePath)
  const executor = createNativeMenuExecutor({
    host: 'pi',
    dispatch: backend.dispatch,
  })
  return {
    backend,
    execute: (request: NativeMenuRequest) =>
      executor.execute(request, {
        interactive: true,
        custodyMode: 'local',
        confirmed: true,
        sessionId: 'command-session',
      }),
  }
}
function registration(
  readMode: () => Promise<'local' | 'claustrum'> = async () => 'local',
  ui: Record<string, unknown> = {},
  disconnectVault?: PiNativeCommands['disconnectVault'],
  refreshRegistry?: () => Promise<void>,
) {
  const commands = new Map<
    string,
    Parameters<ExtensionAPI['registerCommand']>[1]
  >()
  const pi = {
    registerCommand: (
      name: string,
      definition: Parameters<ExtensionAPI['registerCommand']>[1],
    ) => commands.set(name, definition),
  } as unknown as ExtensionAPI
  const notified: string[] = []
  const noticeLevels: Array<string | undefined> = []
  const refreshes: number[] = []
  const ctx = {
    hasUI: Object.keys(ui).length > 0,
    ui: {
      notify: (message: string, level?: string) => {
        notified.push(message)
        noticeLevels.push(level)
      },
      ...ui,
    },
    sessionManager: { getSessionId: () => 'command-session' },
    modelRegistry: {
      refresh: async () => {
        refreshes.push(Date.now())
        await refreshRegistry?.()
      },
    },
  } as unknown as ExtensionCommandContext
  registerCommands(pi, {
    ...createPiNativeCommands(storagePath),
    readMode,
    ...(disconnectVault !== undefined ? { disconnectVault } : {}),
  })
  return { commands, ctx, notified, noticeLevels, refreshes }
}

describe('native account command persistence', () => {
  test('custody changes give offline guidance and preserve native config and state', async () => {
    const before = await bytes()
    const result = await controller().execute({
      action: 'custody-mode',
      values: { mode: 'claustrum' },
    })
    expect(result.status).toBe('guidance')
    expect(await bytes()).toEqual(before)
    expect(
      (await readNativePiFixture(storagePath)).claustrum?.mode ?? 'local',
    ).toBe('local')
  })
  test('disable persists to native storage without writing legacy files', async () => {
    expect(
      (
        await controller().execute({
          action: 'disable',
          values: { id: 'fallback' },
        })
      ).status,
    ).toBe('executed')
    expect(
      (await readNativePiFixture(storagePath)).accounts.find(
        (account) => account.id === 'fallback',
      )?.enabled,
    ).toBe(false)
    await expect(readFile(storagePath, 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })
  test('remove persists to native storage', async () => {
    expect(
      (
        await controller().execute({
          action: 'remove',
          values: { id: 'fallback' },
        })
      ).status,
    ).toBe('executed')
    expect(
      (await readNativePiFixture(storagePath)).accounts.find(
        (account) => account.id === 'fallback',
      ),
    ).toBeUndefined()
  })
  test('enable persists to native storage', async () => {
    const c = controller()
    await c.execute({ action: 'disable', values: { id: 'fallback' } })
    await c.execute({ action: 'enable', values: { id: 'fallback' } })
    expect(
      (await readNativePiFixture(storagePath)).accounts.find(
        (account) => account.id === 'fallback',
      )?.enabled,
    ).not.toBe(false)
  })
  test('reset-backoff clears native main refresh and quota errors with a lineage fence', async () => {
    await saveNativePiFixture(
      {
        version: 1,
        accounts: [],
        refresh: {
          mainLastRefreshError: {
            message: 'invalid_grant',
            checkedAt: Date.now(),
            permanent: true,
          },
        },
        quota: {
          mainLastQuotaApiError: {
            message: 'quota unavailable',
            checkedAt: Date.now(),
          },
        },
      },
      storagePath,
    )
    const before = await readNativePiFixture(storagePath)
    expect(before.refresh?.mainLastRefreshError).toBeDefined()
    expect(before.quota?.mainLastQuotaApiError).toBeDefined()
    const result = await controller().execute({ action: 'reset-backoff' })
    expect(result).toMatchObject({ status: 'executed', ok: true })
    const after = await readNativePiFixture(storagePath)
    expect(after.refresh?.mainLastRefreshError).toBeUndefined()
    expect(after.quota?.mainLastQuotaApiError).toBeUndefined()
  })
  test('account status is display-only and contains no credential material', async () => {
    const before = await bytes()
    const text = await controller().backend.readStatus('account', {})
    expect(text).toContain('fallback')
    expect(text).not.toContain('sk-ant-oat01-fixture-fallback-access')
    expect(text).not.toContain('fixture-fallback-refresh')
    expect(await bytes()).toEqual(before)
  })
})

describe('native diagnostics persistence', () => {
  test('sets log level and persists in native settings', async () => {
    await controller().execute({
      action: 'logging-level',
      values: { level: 'debug' },
    })
    expect((await readNativePiFixture(storagePath)).logging?.level).toBe(
      'debug',
    )
  })
  test('settings status shows the selected native settings file for every persistent setting', async () => {
    const expectedPath = (await resolveNativePoolPaths(storagePath)).config
    for (const command of ['cache', 'dump', 'fast', 'logging'] as const) {
      expect(await controller().backend.readStatus(command, {})).toContain(
        `- Persisted: ${expectedPath}`,
      )
    }
  })

  test('quota status uses shared wording and reports stale checked age', async () => {
    const now = Date.now()
    await saveNativePiFixture(
      {
        version: 1,
        accounts: [],
        quota: {
          mainQuota: {
            five_hour: {
              usedPercent: 60,
              remainingPercent: 40,
              checkedAt: now - 2 * 24 * 60 * 60_000,
            },
          },
        },
      },
      storagePath,
    )

    const text = await controller().backend.readStatus('quota', {})
    expect(text).toContain('5h 40% left')
    expect(text).toContain('checked 2d ago')
  })

  test('Ultra quota status shows only weekly and Fable limits through Core', async () => {
    const checkedAt = Date.now()
    await saveNativePiFixture(
      {
        version: 1,
        accounts: [],
        quota: {
          mainQuota: {
            source: 'poll',
            checkedAt,
            seven_day: { usedPercent: 0, remainingPercent: 100, checkedAt },
            scoped: [
              {
                id: 'fable',
                title: 'Fable only',
                modelName: 'Fable',
                usedPercent: 20,
                remainingPercent: 80,
                checkedAt,
              },
            ],
          },
        },
      },
      storagePath,
    )
    const text = await controller().backend.readStatus('quota', {})
    expect(text).toContain('7d 100% left')
    expect(text).toContain('Fable only 80% left')
    expect(text).not.toContain('5h')
  })

  test('logging status shows current level without mutating', async () => {
    await controller().execute({
      action: 'logging-level',
      values: { level: 'warn' },
    })
    const before = await bytes()
    expect(await controller().backend.readStatus('logging', {})).toContain(
      'warn',
    )
    expect(await bytes()).toEqual(before)
  })
})

describe('native CacheKeep and routing commands', () => {
  test('Routing menu round-trips every longest same-account wait value', async () => {
    await controller().execute({
      action: 'routing-mode',
      values: { mode: 'sticky-balanced' },
    })
    for (const maxSameAccountWait of ['0', '15', 'max'] as const) {
      expect(
        (
          await controller().execute({
            action: 'routing-max-same-account-wait',
            values: { maxSameAccountWait },
          })
        ).status,
      ).toBe('executed')
      expect((await readNativePiFixture(storagePath)).routing).toEqual({
        mode: 'sticky-balanced',
        maxSameAccountWait,
      })
      expect(await controller().backend.readStatus('routing', {})).toContain(
        `Longest wait on the same account: ${maxSameAccountWait}`,
      )
    }
  })
  test('lists tracked sessions from all live Pi instances', async () => {
    const registry = new CacheKeepSessionRegistry({
      directory: join(directory, 'cachekeep'),
      instanceId: 'other-pi-instance',
    })
    const cacheExpiresAt = Date.now() + 60 * 60_000
    await registry.publish([
      {
        id: 'pi-session-1',
        cacheExpiresAt,
        nextPrewarmAt: cacheExpiresAt - 5 * 60_000,
      },
    ])
    const text = await controller().backend.readStatus('cachekeep', {})
    expect(text).toContain('Tracked sessions: 1')
    expect(text).toContain('Sessions:\n- pi-session-1')
  })
  test('persists and reports the always schedule in native settings', async () => {
    await controller().execute({ action: 'cachekeep-always' })
    expect((await readNativePiFixture(storagePath)).cacheKeep).toMatchObject({
      enabled: true,
      always: true,
    })
    expect(await controller().backend.readStatus('cachekeep', {})).toContain(
      'Schedule: always (while this process is running)',
    )
  })
  test('reset clears only the current session assignment at the journal destination without changing mode', async () => {
    const path = await getPiNativeRuntime(storagePath).routingPath()
    const router = new StickySessionRouter({ path })
    for (const sessionId of ['command-session', 'other-session'])
      await router.resolve({
        sessionId,
        family: 'opus',
        modelId: 'claude-opus-5-5',
        inputBytes: 1,
        candidates: [
          { accountId: 'main', order: 0, quota: { kind: 'unknown' } },
        ],
        retainAccountIds: new Set(['main']),
        storage: await readNativePiFixture(storagePath),
      })
    await router.drain()
    const before = await readNativePiFixture(storagePath)
    await controller().execute({ action: 'routing-reset' })
    await getPiNativeRuntime(storagePath).drainRoutingPublications()
    const cleared = await router.resolve({
      sessionId: 'command-session',
      family: 'opus',
      modelId: 'claude-opus-5-5',
      inputBytes: 1,
      candidates: [],
      retainAccountIds: new Set(['main']),
      storage: before,
    })
    expect(cleared).toBeNull()
    const other = await router.resolve({
      sessionId: 'other-session',
      family: 'opus',
      modelId: 'claude-opus-5-5',
      inputBytes: 1,
      candidates: [],
      retainAccountIds: new Set(['main']),
      storage: before,
    })
    expect(other?.accountId).toBe('main')
    expect((await readNativePiFixture(storagePath)).routing).toEqual(
      before.routing,
    )
  })
})

describe('single /claude menu and Pi Prime status', () => {
  test('registers only claude, not a legacy claude-prime alias', () => {
    expect([...registration().commands.keys()]).toEqual(['claude'])
  })
  test('Prime status leaves native config and state bytes unchanged', async () => {
    const before = await bytes()
    expect(await controller().backend.readStatus('prime', {})).toContain(
      'Prime',
    )
    expect(await bytes()).toEqual(before)
  })
  test('Prime on is unsupported in Pi and never toggles the persistent setting', async () => {
    const before = await bytes()
    expect(await controller().execute({ action: 'prime-on' })).toMatchObject({
      status: 'refused',
      code: 'unsupported-action',
    })
    expect(await bytes()).toEqual(before)
  })
  test('Prime off is unsupported in Pi and never toggles the persistent setting', async () => {
    const before = await bytes()
    expect(await controller().execute({ action: 'prime-off' })).toMatchObject({
      status: 'refused',
      code: 'unsupported-action',
    })
    expect(await bytes()).toEqual(before)
  })
  test('empty headless claude invocation shows status without mutating native storage', async () => {
    const before = await bytes()
    const { commands, ctx, notified } = registration()
    await commands.get('claude')?.handler('', ctx)
    expect(notified.join('\n')).toContain('Prime')
    expect(notified.join('\n')).not.toContain(
      'sk-ant-oat01-fixture-fallback-access',
    )
    expect(await bytes()).toEqual(before)
  })
})

const vaultGuidance =
  'Accounts are managed in the vault. Disconnect from the vault to use local accounts.'

/**
 * Drives the Pi /claude menu: opens Accounts, picks `label`, answers each
 * input from `inputs` and confirms. `onPick` runs when the action is chosen,
 * before its inputs are collected and the request is applied.
 */
function piMenuDriver(
  label: string,
  inputs: string[],
  onPick: () => void = () => {},
) {
  const seen: { title: string; choices: string[] }[] = []
  let roots = 0
  let picks = 0
  const ui = {
    async select(title: string, choices: string[]) {
      seen.push({ title, choices })
      if (title === 'Claude')
        return roots++ === 0
          ? choices.find((choice) => choice.startsWith('Accounts'))
          : undefined
      if (title.startsWith('Accounts') && picks++ === 0) {
        onPick()
        return choices.find((choice) => choice === label)
      }
      return undefined
    },
    async input() {
      return inputs.shift()
    },
    async confirm() {
      return true
    },
  }
  return { ui, seen }
}

describe('vault custody in the Pi /claude menu', () => {
  test('headless vault status shows the guidance line and leaves native storage unchanged', async () => {
    const before = await bytes()
    const { commands, ctx, notified } = registration(async () => 'claustrum')
    await commands.get('claude')?.handler('', ctx)
    expect(notified.join('\n')).toContain(`Accounts\n${vaultGuidance}`)
    expect(await bytes()).toEqual(before)
  })

  test('the interactive vault menu offers no local account actions', async () => {
    const before = await bytes()
    const { ui, seen } = piMenuDriver('Remove account', ['fallback'])
    const { commands, ctx, notified } = registration(
      async () => 'claustrum',
      ui,
    )
    await commands.get('claude')?.handler('', ctx)
    const root = seen.find((entry) => entry.title === 'Claude')
    expect(root?.choices).toContain(`Accounts: ${vaultGuidance}`)
    const accounts = seen.find((entry) => entry.title.startsWith('Accounts'))
    expect(accounts?.title).toContain(vaultGuidance)
    for (const hidden of [
      'Remove account',
      'Move account up',
      'Move account down',
      'Reset host enrollment',
      'Add API-key fallback',
      'Start OAuth sign-in',
      'Finish OAuth sign-in',
    ])
      expect(accounts?.choices).not.toContain(hidden)
    expect(accounts?.choices).toContain('Disable account')
    expect(notified).toEqual([])
    expect(await bytes()).toEqual(before)
  })

  test('a stale remove is refused after the vault connects, and allowed again after disconnect', async () => {
    let custody: 'local' | 'claustrum' = 'local'
    const before = await bytes()
    // The menu is opened in local custody; the vault connects while the
    // person is choosing the action, before the request is applied.
    const stale = piMenuDriver('Remove account', ['fallback'], () => {
      custody = 'claustrum'
    })
    const first = registration(async () => custody, stale.ui)
    await first.commands.get('claude')?.handler('', first.ctx)
    expect(
      stale.seen.find((entry) => entry.title.startsWith('Accounts'))?.choices,
    ).toContain('Remove account')
    expect(first.notified).toContain(`Action refused: ${vaultGuidance}`)
    expect(await bytes()).toEqual(before)
    expect(
      (await readNativePiFixture(storagePath)).accounts.map(
        (account) => account.id,
      ),
    ).toContain('fallback')

    custody = 'local'
    const restored = piMenuDriver('Remove account', ['fallback'])
    const second = registration(async () => custody, restored.ui)
    await second.commands.get('claude')?.handler('', second.ctx)
    expect(second.notified.join('\n')).not.toContain('Action refused')
    expect(
      (await readNativePiFixture(storagePath)).accounts.find(
        (account) => account.id === 'fallback',
      ),
    ).toBeUndefined()
  })
})

const listedVaultRow = {
  id: 'oauth:anthropic',
  accountId: '11111111-2222-4333-8444-555555555555',
  credentialType: 'oauth',
  categories: ['anthropic-native'],
  refreshAdapter: 'anthropic',
  serves: ['anthropic'],
  providerIds: [],
  state: 'active',
  operations: ['read'],
  recordVersion: 7,
  createdAtMs: null,
} as const

/** Reads a file's bytes, or undefined when it does not exist. */
async function bytesOrAbsent(path: string): Promise<Buffer | undefined> {
  return readFile(path).catch((error: unknown) => {
    if ((error as { code?: unknown })?.code === 'ENOENT') return undefined
    throw error
  })
}

describe('vault custody controls through the Pi /claude menu', () => {
  test('enable, disable and reset-backoff change only vault files and leave every local account file byte-identical', async () => {
    // Enrol Pi in the vault as completed setup leaves it: an enrollment state
    // file in the 'approved' phase for Pi's enrollment name, plus the token
    // the vault issued, at the path the Pi runtime reads from
    // PI_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE.
    process.env.PI_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE = join(
      directory,
      'pi-enrollment.json',
    )
    const enrollment = getHostClaustrumEnrollmentPaths('pi')
    await writeFile(
      enrollment.tokenPath,
      JSON.stringify({ token: '01'.repeat(32), token_generation: 1 }),
      { mode: 0o600 },
    )
    await writeFile(
      enrollment.statePath,
      JSON.stringify({
        version: 1,
        phase: 'approved',
        proposedName: 'anthropic-auth-pi',
        tokenGeneration: 1,
        updatedAt: 1,
      }),
      { mode: 0o600 },
    )
    try {
      expect(await readNativeEnrollmentMode('pi', process.env)).toBe(
        'claustrum',
      )
      const paths = await resolveNativePoolPaths(storagePath)
      const vaultPaths = nativeVaultPaths(paths)
      await createNativePoolStore({
        paths: vaultPaths,
        quota: nativeQuotaCodec,
      }).initialize()
      const client: NativeCustodyClient = {
        listScoped: async () => ({
          view: 'synthetic',
          rows: [listedVaultRow],
          grants: undefined,
          grantTuples: undefined,
        }),
        getScoped: async (input) => ({
          credentialId: input.credentialId,
          accountId: listedVaultRow.accountId,
          material: 'synthetic-vault-bearer',
          recordVersion: 7,
          expiresAtMs: Date.now() + 3_600_000,
        }),
        reportAuthFailureScoped: async () => {},
        close: () => {},
      }
      // The real Pi native runtime that the /claude command dispatches to;
      // only the vault client it connects to is a test double.
      const runtime = await getPiNativeRuntime(storagePath, {
        connect: async () => client,
      }).service()
      await runtime.vault.refresh()
      expect((await runtime.read()).mode).toBe('claustrum')
      // Record a quota failure on the vault account so the test can check
      // that reset-backoff clears it.
      const receipt = await runtime.authorizeVault('main')
      expect(
        await runtime.vault.publish(receipt, {
          lastQuotaRefreshError: {
            message: 'synthetic quota failure',
            checkedAt: Date.now(),
            accountIdentity: listedVaultRow.accountId,
          },
        }),
      ).toBe(true)

      const localFiles = [
        paths.legacyConfig,
        paths.legacyState,
        paths.config,
        paths.state,
        paths.runtime,
        paths.journal,
        paths.roster,
      ]
      const localBefore = await Promise.all(localFiles.map(bytesOrAbsent))
      expect(localBefore.some((file) => file !== undefined)).toBe(true)
      const vaultRoster = () => readVaultRoster(vaultPaths.roster)
      const vaultMetadata = async () => {
        const state = await readNativeRuntime(
          vaultPaths.runtime,
          vaultPaths.storageId,
        )
        return state.status === 'ready' ? state.state : undefined
      }
      const quotaError = async () =>
        Object.values((await vaultMetadata())?.accounts ?? {}).find(
          (entry) => entry.lastQuotaRefreshError !== undefined,
        )?.lastQuotaRefreshError
      expect(await quotaError()).toBeDefined()

      const run = async (label: string, inputs: string[]) => {
        const { ui, seen } = piMenuDriver(label, inputs)
        const { commands, ctx, notified } = registration(
          () => readNativeEnrollmentMode('pi', process.env),
          ui,
        )
        await commands.get('claude')?.handler('', ctx)
        const accounts = seen.find((entry) =>
          entry.title.startsWith('Accounts'),
        )
        expect(accounts?.title).toContain(vaultGuidance)
        expect(accounts?.choices).toContain(label)
        return notified
      }

      expect(await run('Disable account', ['main'])).toEqual([
        'Native account disabled.',
      ])
      expect((await vaultRoster())?.rows[0]?.enabled).toBe(false)
      expect((await vaultRoster())?.declined).toEqual([
        {
          credentialId: listedVaultRow.id,
          accountIdentity: listedVaultRow.accountId,
        },
      ])
      expect(await Promise.all(localFiles.map(bytesOrAbsent))).toEqual(
        localBefore,
      )

      expect(await run('Enable account', ['main'])).toEqual([
        'Native account enabled.',
      ])
      expect((await vaultRoster())?.rows[0]?.enabled).toBe(true)
      expect((await vaultRoster())?.declined).toEqual([])
      expect(await Promise.all(localFiles.map(bytesOrAbsent))).toEqual(
        localBefore,
      )

      expect(await run('Reset account backoff', [])).toEqual([
        'Native main OAuth refresh and quota backoff cleared.',
      ])
      expect(await quotaError()).toBeUndefined()
      expect(await Promise.all(localFiles.map(bytesOrAbsent))).toEqual(
        localBefore,
      )
      expect(await readFile(vaultPaths.runtime, 'utf8')).not.toContain(
        'synthetic-vault-bearer',
      )
    } finally {
      delete process.env.PI_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE
    }
  })
})

/** Writes Pi's approved enrollment and its token where the runtime reads them. */
async function enrollPi() {
  process.env.PI_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE = join(
    directory,
    'pi-enrollment.json',
  )
  const enrollment = getHostClaustrumEnrollmentPaths('pi')
  await writeFile(
    enrollment.tokenPath,
    JSON.stringify({ token: '01'.repeat(32), token_generation: 1 }),
    { mode: 0o600 },
  )
  await writeFile(
    enrollment.statePath,
    JSON.stringify({
      version: 1,
      phase: 'approved',
      proposedName: 'anthropic-auth-pi',
      tokenGeneration: 1,
      updatedAt: 1,
    }),
    { mode: 0o600 },
  )
  return enrollment
}

describe('vault disconnect through the Pi /claude menu', () => {
  for (const [result, refreshes, notice] of [
    [
      'disconnected',
      1,
      'Disconnected from the vault. This host uses local accounts again.',
    ],
    ['idle', 1, 'This host has no active vault enrollment.'],
    [
      'busy',
      0,
      "Vault disconnect could not finish because another process is changing this host's enrollment. Try again.",
    ],
    [
      'conflict',
      0,
      'Disconnect stopped: this host already has a different stored sign-in, so it and the sign-in saved when the host joined the vault were both kept, and the vault connection remains. Resolve the two sign-ins with offline setup.',
    ],
  ] as const) {
    test(`a confirmed '${result}' disconnect ${refreshes ? 'reloads' : 'does not reload'} Pi's model registry`, async () => {
      let disconnects = 0
      const { ui, seen } = piMenuDriver('Disconnect from the vault', [])
      const {
        commands,
        ctx,
        notified,
        refreshes: reloads,
      } = registration(
        async () => 'claustrum',
        ui,
        async () => {
          disconnects++
          return result
        },
      )
      await commands.get('claude')?.handler('', ctx)
      expect(
        seen.find((entry) => entry.title.startsWith('Accounts'))?.choices,
      ).toContain('Disconnect from the vault')
      expect(disconnects).toBe(1)
      expect(reloads).toHaveLength(refreshes)
      expect(notified).toEqual([notice])
    })
  }

  for (const reloadFails of [false, true]) {
    test(
      reloadFails
        ? 'Pi reports reload failure without undoing a completed vault disconnect or exposing the exception'
        : 'the default disconnect restores the stored Pi sign-in, selects local custody and leaves local account files byte-identical',
      async () => {
        const enrollment = await enrollPi()
        try {
          // Pi's SDK keeps its sign-ins in <agent dir>/auth.json; beforeEach points
          // PI_CODING_AGENT_DIR at this test's directory.
          const authPath = join(directory, 'auth.json')
          const original = `{\n  "other": {"type":"api_key","key":"synthetic-unrelated"},\n  "anthropic": {"type":"oauth","access":"sk-ant-oat01-synthetic-host","refresh":"synthetic-refresh","expires":1}\n}\n`
          await writeFile(authPath, original, { mode: 0o600 })
          // Joining the vault set the sign-in aside through Core's shared slot
          // writer, leaving an inert placeholder in Pi's auth file.
          const slot = openNativePiAuthSlot({ env: process.env, authPath })
          await slot.enterVault()
          expect(await slot.inspect()).toEqual({
            slot: 'placeholder',
            stash: 'valid',
          })
          expect(await readNativeEnrollmentMode('pi', process.env)).toBe(
            'claustrum',
          )
          const paths = await resolveNativePoolPaths(storagePath)
          const localFiles = [
            paths.legacyConfig,
            paths.legacyState,
            paths.config,
            paths.state,
            paths.runtime,
            paths.journal,
            paths.roster,
          ]
          const localBefore = await Promise.all(localFiles.map(bytesOrAbsent))
          expect(localBefore.some((file) => file !== undefined)).toBe(true)

          // No disconnect callback is injected: the menu uses Pi's real wiring.
          const { ui } = piMenuDriver('Disconnect from the vault', [])
          const { commands, ctx, notified, noticeLevels, refreshes } =
            registration(
              () => readNativeEnrollmentMode('pi', process.env),
              ui,
              undefined,
              async () => {
                if (reloadFails)
                  throw new Error('synthetic-private-reload-exception')
              },
            )
          await commands.get('claude')?.handler('', ctx)
          expect(notified).toEqual([
            ...(reloadFails
              ? [
                  'Vault enrollment is inactive, but Pi could not reload its saved sign-in. Restart Pi before sending another request.',
                ]
              : []),
            'Disconnected from the vault. This host uses local accounts again.',
          ])
          if (reloadFails) expect(noticeLevels[0]).toBe('error')
          expect(notified.join('\n')).not.toContain(
            'synthetic-private-reload-exception',
          )
          expect(await readFile(authPath, 'utf8')).toBe(original)
          expect(await slot.inspect()).toEqual({
            slot: 'original',
            stash: 'missing',
          })
          expect(await readNativeEnrollmentMode('pi', process.env)).toBe(
            'local',
          )
          expect(await bytesOrAbsent(enrollment.tokenPath)).toBeUndefined()
          expect(refreshes).toHaveLength(1)
          expect(await Promise.all(localFiles.map(bytesOrAbsent))).toEqual(
            localBefore,
          )
        } finally {
          delete process.env.PI_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE
        }
      },
    )
  }
})
