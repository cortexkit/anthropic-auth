import { afterEach, beforeEach, describe, expect, mock } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import * as Core from '@cortexkit/anthropic-auth-core'
import {
  type AccountStorage,
  type CommandApplyRequest,
  type CommandApplyResult,
  createNativeAccountRuntime,
  getHostClaustrumEnrollmentPaths,
  isOAuthAccount,
  type NativeCustodyClient,
  type OAuthAccount,
  PARALLEL_TOOL_CALLS_SYSTEM_PROMPT,
  type ProviderAccountUuid,
  type SetupIO,
} from '@cortexkit/anthropic-auth-core'
import { ClaustrumCredentialError } from '@cortexkit/claustrum-client'
import * as commonAuthSetup from '@cortexkit/common-auth/setup'
import type { NativeRefreshObservation } from '../../../core/src/native-refresh-coordinator.ts'
import {
  publishNativeLocalRefreshFailure,
  readNativeRuntime,
} from '../../../core/src/native-runtime.ts'
import { runSetupCommand } from '../setup/command'
import { drainSidebarWrites } from '../sidebar-state'
import {
  applyMenuAction as applyMenuActionWithCtx,
  createMockClient,
  openClaudeMenu,
} from './support/opencode1-client.ts'
import { installLoaderSetup } from './support/opencode1-loader-setup.ts'
import {
  bindPoolAccounts,
  createFallbackStorage,
  getPlugin as getPluginWithCtx,
  mainOnlyVault,
  readNativeRuntimeState as readNativeRuntimeStateWithCtx,
  syntheticMainHostAuth,
  syntheticMainIdentity,
  useTempAccountFile as useTempAccountFileWithCtx,
  useUnmigratedAccountFile as useUnmigratedAccountFileWithCtx,
  useVaultAccountFile as useVaultAccountFileWithCtx,
  withNativeAdmission as withNativeAdmissionWithCtx,
} from './support/opencode1-pool-fixture.ts'
import {
  readAccountStorage as readAccountStorageWithCtx,
  restoreProcessTestFiles,
} from './support/opencode1-state-observers.ts'
import type { PluginRuntimeOverrides } from './support/opencode1-test-context.ts'
import {
  createOpencode1Test,
  createOpencode1TestContext,
  installOpencode1TestHooks,
} from './support/opencode1-test-context.ts'
import { extractUrl, MESSAGES_URL } from './test-fetch'

const testContext = createOpencode1TestContext()
installOpencode1TestHooks(testContext)
const test = createOpencode1Test(testContext)

function useTempAccountFile(
  storage: AccountStorage,
  mainHostAuth: {
    access: string
    refresh: string
    expires: number
  } = syntheticMainHostAuth(),
) {
  return useTempAccountFileWithCtx(testContext, storage, mainHostAuth)
}
function useVaultAccountFile(
  storage: AccountStorage,
  client: NativeCustodyClient,
) {
  return useVaultAccountFileWithCtx(testContext, storage, client)
}
function useUnmigratedAccountFile(storage: AccountStorage) {
  return useUnmigratedAccountFileWithCtx(testContext, storage)
}
function withNativeAdmission<Input, Init>(
  handler: (input: Input, init: Init) => unknown,
) {
  return withNativeAdmissionWithCtx(testContext, handler)
}
function readNativeRuntimeState() {
  return readNativeRuntimeStateWithCtx(testContext)
}
function getPlugin(
  client?: ReturnType<typeof createMockClient>,
  directory?: string,
  runtimeOverrides: PluginRuntimeOverrides = {},
): any {
  return getPluginWithCtx(testContext, client, directory, runtimeOverrides)
}
function readAccountStorage(): Promise<AccountStorage | null> {
  return readAccountStorageWithCtx(testContext)
}
function applyMenuAction(
  plugin: any,
  sessionId: string,
  request: Omit<CommandApplyRequest, 'command' | 'sessionId'>,
): Promise<CommandApplyResult> {
  return applyMenuActionWithCtx(testContext, plugin, sessionId, request)
}

test('extractUrl uses canonical fetch URLs and preserves raw invalid strings', () => {
  expect(extractUrl('https://example.com/a/../b')).toBe('https://example.com/b')
  expect(extractUrl('/relative')).toBe('/relative')
  expect(extractUrl('not a URL')).toBe('not a URL')
})

describe('package metadata', () => {
  test('exports a runtime-loadable TUI entrypoint', async () => {
    const packageJson = JSON.parse(
      await readFile(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as {
      exports?: Record<string, { import?: string; types?: string }>
      files?: string[]
      'oc-plugin'?: string[]
      scripts?: Record<string, string>
      dependencies?: Record<string, string>
    }

    expect(packageJson.exports?.['./tui']).toEqual({
      types: './dist/tui.d.ts',
      import: './src/tui/entry.mjs',
    })
    expect(packageJson.files).toContain('src/tui.tsx')
    expect(packageJson.files).toContain('src/tui')
    expect(packageJson.files).toContain('src/tui-compiled')
    expect(packageJson.files).toContain('src/sidebar-state.ts')
    expect(packageJson['oc-plugin']).toEqual(['server', 'tui'])
    expect(packageJson.scripts?.build).toContain('bun run build:tui')
    for (const dependency of ['@opentui/core', '@opentui/solid', 'solid-js']) {
      expect(packageJson.dependencies?.[dependency]).toMatch(/^\d/)
    }
  })

  test('raw TUI fallback is loadable for development hosts', async () => {
    const mod = await import('../tui.tsx')
    expect(mod.default?.id).toBe('cortexkit.anthropic-auth')
    expect(mod.default?.tui).toBeFunction()
  })
})

describe('scoped enrollment is explicit', () => {
  if ('UNSUPPORTED_VAULT_MESSAGE' in commonAuthSetup) {
    test('unsupported vault setup clears state for /claude status and reset', async () => {
      const vault = mainOnlyVault()
      const fixture = await useVaultAccountFile(
        createFallbackStorage({
          accounts: [],
          mainAccountId: 'primary-route',
          claustrum: {
            mode: 'claustrum',
            scopedRoster: true,
            primaryAccount: {
              credentialId: 'oauth:anthropic',
              accountId: syntheticMainIdentity as ProviderAccountUuid,
              state: 'active',
            },
          },
        }),
        vault,
      )
      const setupEnv: NodeJS.ProcessEnv = {
        ...fixture.env,
        HOME: fixture.root,
      }
      const enrollment = getHostClaustrumEnrollmentPaths('opencode', setupEnv)
      // Remove the fixture's enrollment token and state so setup starts a
      // fresh enrollment ceremony against the unsupported vault.
      await rm(enrollment.tokenPath, { force: true })
      await rm(enrollment.statePath, { force: true })
      const bin = join(fixture.root, 'fixture-bin')
      const connectionFile =
        setupEnv.OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_CONNECTION_FILE
      if (!connectionFile) throw new Error('Missing isolated connection path')
      setupEnv.PATH = bin
      const executable = (path: string) =>
        path === join(bin, 'opencode') || path === join(bin, 'ck')
      const setupIO: SetupIO = {
        env: setupEnv,
        platform: 'linux',
        fs: {
          exists: (path) => path === connectionFile || existsSync(path),
          isDirectory: (path) => {
            try {
              return statSync(path).isDirectory()
            } catch {
              return false
            }
          },
          isFile: executable,
          isExecutable: executable,
          readText: (path) => readFileSync(path, 'utf8'),
          realpath: (path) => realpathSync(path),
        },
        runner: {
          run: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
        },
        fence: { listRunningHosts: async () => [] },
        terminal: { input: process.stdin, output: new PassThrough() },
        connect: async () => ({
          close() {},
          enrollPropose: async () => {
            throw new ClaustrumCredentialError(
              'unknown_method',
              'transient',
              'retry',
            )
          },
          enrollPoll: async () => ({ status: 'pending' as const }),
        }),
      }

      expect(
        await runSetupCommand(
          ['--yes', '--claustrum', '--opencode=2'],
          setupIO,
        ),
      ).toBe(1)
      await expect(
        readFile(enrollment.statePath, 'utf8'),
      ).rejects.toMatchObject({
        code: 'ENOENT',
      })
      const enrollmentStatus = await Core.readClaustrumEnrollmentStatus(
        enrollment,
        'anthropic-auth-opencode',
      )
      expect(enrollmentStatus.state).toBe('idle')
      expect(Core.formatEnrollmentStatus(enrollmentStatus)).toEqual([
        '- Enrollment: not enrolled',
      ])

      const plugin = await getPlugin(createMockClient(), fixture.root, {
        claustrumScopedConnect: async () => vault,
      })
      const menu = await openClaudeMenu(plugin, 'ses_unsupported_vault')
      const status = (
        menu.menu.sections.find((section) => section.id === 'Accounts')
          ?.lines ?? []
      ).join('\n')
      expect(status).not.toContain('request not sent')
      expect(status).not.toContain('Enrollment: pending')
      expect(status).not.toContain('pending approval')

      const reset = await applyMenuAction(
        plugin,
        'ses_unsupported_vault_reset',
        {
          sectionId: 'Accounts',
          actionId: 'enrollment-reset',
          confirmed: true,
        },
      )
      expect(reset.text).toContain('No Claustrum enrollment state to reset.')
      expect(reset.text).not.toContain('request may still be in progress')
    })
  }

  test('account dialog reports approved enrollment without false setup guidance for a vault-served main', async () => {
    const vault = mainOnlyVault()
    const fixture = await useVaultAccountFile(
      createFallbackStorage({
        accounts: [],
        mainAccountId: 'primary-route',
        claustrum: {
          mode: 'claustrum',
          scopedRoster: true,
          primaryAccount: {
            credentialId: 'oauth:anthropic',
            accountId: syntheticMainIdentity as ProviderAccountUuid,
            state: 'active',
          },
        },
      }),
      vault,
    )
    const sessionId = `ses_approved_vault_account_dialog_${randomUUID()}`
    const plugin = await getPlugin(undefined, fixture.root, {
      claustrumScopedConnect: async () => vault,
    })
    const menu = await openClaudeMenu(plugin, sessionId)
    const status = (
      menu.menu.sections.find((section) => section.id === 'Accounts')?.lines ??
      []
    ).join('\n')
    // The main account's status line names the vault as its source.
    expect(status).toContain('[main] enabled — vault')
    expect(status).toContain('approved as enrolled:anthropic-auth-opencode')
    expect(status).not.toContain('scoped serving not active yet')
    expect(status).not.toContain('Quit the host and run')
  })

  test('boot and account status are read-only for an unscoped Claustrum configuration', async () => {
    // A Claustrum configuration without a scoped account roster cannot migrate.
    // Startup and status reads must not propose or persist enrollment state.
    await useUnmigratedAccountFile(
      createFallbackStorage({ accounts: [], claustrum: { mode: 'claustrum' } }),
    )
    const enrollmentFile =
      process.env.OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE
    if (!enrollmentFile) throw new Error('Missing isolated enrollment path')
    const stateFile = enrollmentFile.replace(/\.json$/, '-state.json')
    const plugin = await getPlugin(createMockClient())
    await openClaudeMenu(plugin, 'ses_read_only')
    await expect(readFile(stateFile, 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    })
    // Also reject the enrollment-starting call in source: detached enrollment
    // work could begin after the file-absence assertion has already passed.
    const pluginSource = await readFile(
      join(import.meta.dir, '..', 'index.ts'),
      'utf8',
    )
    expect(pluginSource.includes('adoptClaustrumEnrollment')).toBe(false)
  })

  test('enrollment-reset only clears terminal state; setup owns the next proposal', async () => {
    await useTempAccountFile(createFallbackStorage({ accounts: [] }))
    if (!testContext.tempConfigDir)
      throw new Error('Missing local fixture directory')
    process.env.OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE = join(
      testContext.tempConfigDir,
      'opencode-enrollment.json',
    )
    // A terminal refused ceremony has no approved token. Local custody can
    // clear that record without proposing another enrollment.
    const stateFile = join(
      testContext.tempConfigDir,
      'opencode-enrollment-state.json',
    )
    await writeFile(
      stateFile,
      JSON.stringify({
        version: 1,
        phase: 'blocked',
        proposedName: 'anthropic-auth-opencode',
        errorCode: 'superseded',
        updatedAt: Date.now(),
      }),
      { mode: 0o600 },
    )
    const plugin = await getPlugin(
      createMockClient(),
      testContext.tempConfigDir,
    )
    const result = await applyMenuAction(plugin, 'ses_reset_only', {
      sectionId: 'Accounts',
      actionId: 'enrollment-reset',
      confirmed: true,
    })
    await expect(readFile(stateFile, 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    })
    expect(result.text).toContain('setup')
  })

  test('enrollment-reset keeps a pending request and tells the user to rerun setup', async () => {
    await useTempAccountFile(createFallbackStorage({ accounts: [] }))
    if (!testContext.tempConfigDir)
      throw new Error('Missing local fixture directory')
    process.env.OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE = join(
      testContext.tempConfigDir,
      'opencode-enrollment.json',
    )
    // Setup saves the request secret before it proposes, so a pending state
    // without a request id may still match a request the vault stored. The
    // menu must leave it for setup to resume.
    const stateFile = join(
      testContext.tempConfigDir,
      'opencode-enrollment-state.json',
    )
    const pending = JSON.stringify({
      version: 1,
      phase: 'pending',
      proposedName: 'anthropic-auth-opencode',
      requestSecret: 'ab'.repeat(32),
      createdAt: 1,
      updatedAt: 1,
    })
    await writeFile(stateFile, pending, { mode: 0o600 })
    const plugin = await getPlugin(
      createMockClient(),
      testContext.tempConfigDir,
    )
    const result = await applyMenuAction(plugin, 'ses_reset_pending', {
      sectionId: 'Accounts',
      actionId: 'enrollment-reset',
      confirmed: true,
    })
    expect(await readFile(stateFile, 'utf8')).toBe(pending)
    expect(result.text).toContain(
      'An enrollment request may still be in progress. Quit OpenCode and run setup again; it picks up the same request.',
    )
    expect(result.text).not.toContain('refused-pending')
  })
})

describe('AnthropicAuthPlugin', () => {
  test('fixed auth content refuses before creating the main OAuth URL', async () => {
    await useTempAccountFile({ version: 1, accounts: [] })
    const previous = process.env.OPENCODE_AUTH_CONTENT
    process.env.OPENCODE_AUTH_CONTENT = '{}'
    try {
      const authorize = mock(() =>
        Promise.resolve({
          url: 'https://example.test/oauth',
          redirectUri: 'https://example.test/callback',
          state: 'state',
          verifier: 'verifier',
        }),
      )
      const plugin = await getPlugin(undefined, undefined, { authorize })
      await expect(plugin.auth.methods[0].authorize()).rejects.toThrow(
        'Local login cannot be verified while OPENCODE_AUTH_CONTENT is set',
      )
      expect(authorize).not.toHaveBeenCalled()
      // The refused login added no account to the native pool.
      const state = await readNativeRuntimeState()
      expect(state.accounts).toEqual({})
      await plugin.dispose?.()
    } finally {
      if (previous === undefined) delete process.env.OPENCODE_AUTH_CONTENT
      else process.env.OPENCODE_AUTH_CONTENT = previous
    }
  })

  test('returns an object with auth properties', async () => {
    const plugin = await getPlugin()
    expect(plugin.auth).toBeDefined()
    expect(plugin.auth.provider).toBe('anthropic')
    expect(plugin.auth.loader).toBeFunction()
    expect(plugin.auth.methods).toBeArray()
    expect(plugin.provider?.id).toBe('anthropic')
    expect(plugin.provider?.models).toBeFunction()
  })

  test('refresh error merge prefers the newer observation by checkedAt', async () => {
    const accountId = 'fallback-fence-recency'
    const now = Date.now()
    await useTempAccountFile(
      bindPoolAccounts(
        createFallbackStorage({
          quota: { enabled: false },
          accounts: [
            {
              id: accountId,
              type: 'oauth',
              access: 'sk-ant-oat01-dead',
              refresh: 'dead-refresh',
              expires: now + 8 * 60 * 60_000,
            },
          ],
        }),
      ),
    )
    if (!testContext.migratedPool)
      throw new Error('Missing native refresh fixture')
    const paths = testContext.migratedPool.paths
    const runtime = createNativeAccountRuntime({ paths, host: 'opencode' })
    try {
      const subject = await runtime.captureLocalSubject(accountId)
      const read = await readNativeRuntime(paths.runtime, paths.storageId)
      const entry = Object.values(
        read.status === 'ready' ? read.state.accounts : {},
      ).find(
        (value) =>
          value.binding.kind === 'local' &&
          value.binding.rowId === subject.binding.rowId,
      )
      const event: NativeRefreshObservation = {
        status: 'failed',
        failure: {
          kind: 'provider',
          classification: 'invalid-grant',
          status: 400,
        },
        persisted: false,
        binding: subject.binding,
        credentialFingerprint: subject.credentialFingerprint,
        credentialVersion: subject.version,
        attempt: 1,
        bootstrap: 'unavailable',
        handoff: 'not-needed',
        context: {
          subject,
          runtimeBinding:
            entry?.binding.kind === 'local' ? entry.binding : null,
          refreshErrorClearedAt: entry?.refreshErrorClearedAt ?? null,
          quotaErrorClearedAt: entry?.quotaErrorClearedAt ?? null,
          quotaErrorGeneration: entry?.quotaErrorGeneration ?? null,
        },
      }
      const publish = (checkedAt: number) =>
        publishNativeLocalRefreshFailure(paths, event, {
          checkedAt,
          nextRetryAt: checkedAt + 86_400_000,
          retryCount: 1,
        })
      expect((await publish(now - 200_000)).status).toBe('published')
      expect((await publish(now)).status).toBe('published')
      const beforeStale = await readFile(paths.runtime, 'utf8')
      expect(await publish(now - 300_000)).toEqual({
        status: 'superseded',
        reason: 'older-than-stored',
      })
      expect(await readFile(paths.runtime, 'utf8')).toBe(beforeStale)
      const afterOlder = (await readAccountStorage())?.accounts.find(
        (account): account is OAuthAccount =>
          account.id === accountId && isOAuthAccount(account),
      )
      expect(afterOlder?.lastRefreshError).toMatchObject({
        checkedAt: now,
        status: 400,
        permanent: true,
      })
    } finally {
      runtime.close()
    }
  })
})

describe('experimental.chat.system.transform', () => {
  test('injects parallel tool-call prompt only for Anthropic chat sessions', async () => {
    const plugin = await getPlugin()
    const system = ['base system']

    await plugin['experimental.chat.system.transform'](
      {
        sessionID: 'ses_test',
        model: { providerID: 'anthropic', id: 'claude-opus-4-8' },
      },
      { system },
    )

    expect(system).toEqual(['base system', PARALLEL_TOOL_CALLS_SYSTEM_PROMPT])
  })

  test('does not inject parallel tool-call prompt for non-Anthropic models', async () => {
    const plugin = await getPlugin()
    const system = ['base system']

    await plugin['experimental.chat.system.transform'](
      {
        sessionID: 'ses_test',
        model: { providerID: 'openai', id: 'gpt-5.5-fast' },
      },
      { system },
    )

    expect(system).toEqual(['base system'])
  })

  test('does not inject parallel tool-call prompt outside chat sessions', async () => {
    const plugin = await getPlugin()
    const system = ['base system']

    await plugin['experimental.chat.system.transform'](
      {
        model: { providerID: 'anthropic', id: 'claude-opus-4-8' },
      },
      { system },
    )

    expect(system).toEqual(['base system'])
  })

  test('does not duplicate an existing parallel tool-call prompt', async () => {
    const plugin = await getPlugin()
    const system = ['base system', PARALLEL_TOOL_CALLS_SYSTEM_PROMPT]

    await plugin['experimental.chat.system.transform'](
      {
        sessionID: 'ses_test',
        model: { providerID: 'anthropic', id: 'claude-opus-4-8' },
      },
      { system },
    )

    expect(system).toEqual(['base system', PARALLEL_TOOL_CALLS_SYSTEM_PROMPT])
  })

  test('parallel tool-call prompt forbids parallelizing dependent calls', () => {
    expect(PARALLEL_TOOL_CALLS_SYSTEM_PROMPT).toContain(
      'Do not parallelize tool calls when one call depends on the output of another call.',
    )
    expect(PARALLEL_TOOL_CALLS_SYSTEM_PROMPT).toContain(
      'Never invent placeholder IDs, guessed task IDs, or other guessed values',
    )
  })
})

describe('auth.methods', () => {
  test('has three auth methods', async () => {
    const plugin = await getPlugin()
    expect(plugin.auth.methods).toHaveLength(3)
  })

  test('first method is Claude Pro/Max OAuth with code flow', async () => {
    const plugin = await getPlugin()
    const method = plugin.auth.methods[0]
    expect(method.label).toBe('Claude Pro/Max')
    expect(method.type).toBe('oauth')
    expect(method.authorize).toBeFunction()
  })

  test('second method is Create an API Key OAuth with code flow', async () => {
    const plugin = await getPlugin()
    const method = plugin.auth.methods[1]
    expect(method.label).toBe('Create an API Key')
    expect(method.type).toBe('oauth')
    expect(method.authorize).toBeFunction()
  })

  test('third method is manual API key', async () => {
    const plugin = await getPlugin()
    const method = plugin.auth.methods[2]
    expect(method.label).toBe('Manually enter API Key')
    expect(method.type).toBe('api')
    expect(method.provider).toBe('anthropic')
  })
})

describe('provider.models', () => {
  test('registers Fable 5.2 on OC1 with its own price, limits and release date', async () => {
    const plugin = await getPlugin()
    const result = await plugin.provider?.models?.(
      {
        models: {
          'claude-opus-4-8': {
            id: 'claude-opus-4-8',
            api: {
              id: 'claude-opus-4-8',
              type: 'aisdk',
              package: '@ai-sdk/anthropic',
            },
          },
        },
      } as never,
      { auth: { type: 'api' } } as never,
    )
    expect(result?.['claude-fable-5-2']).toMatchObject({
      name: 'Claude Fable 5.2',
      api: { id: 'claude-fable-5-2' },
      cost: { input: 8, output: 40, cache: { read: 0.2, write: 10 } },
      limit: { context: 1_000_000, output: 128_000 },
      release_date: '2026-11-09',
    })
    expect(Object.keys(result?.['claude-fable-5-2']?.variants ?? {})).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ])
  })

  beforeEach(async () => {
    await useTempAccountFile(createFallbackStorage({ accounts: [] }))
  })

  afterEach(async () => {
    await drainSidebarWrites()
    restoreProcessTestFiles()
    // Clear testContext.tempConfigDir without deleting the account files used by plugins.
    // TestLifetime disposes those plugins and joins their work before removal.
    testContext.tempConfigDir = undefined
  })

  test('zeros out Anthropic model costs for OAuth auth', async () => {
    const plugin = await getPlugin()
    const models = {
      'claude-opus-4-8': {
        id: 'claude-opus-4-8',
        name: 'Claude Opus 4.8',
        api: {
          id: 'claude-opus-4-8',
          type: 'aisdk',
          package: '@ai-sdk/anthropic',
        },
        cost: { input: 5, output: 25, cache: { read: 0.5, write: 6.25 } },
        limit: { context: 1_000_000, output: 128_000 },
        capabilities: { reasoning: true, attachment: true, toolcall: true },
        release_date: '2026-01-01',
      },
    }

    const result = await plugin.provider?.models?.(
      { models } as never,
      { auth: { type: 'oauth' } } as never,
    )

    expect(result?.['claude-opus-4-8']?.cost).toEqual({
      input: 0,
      output: 0,
      cache: { read: 0, write: 0 },
    })
    expect(result?.['claude-fable-5']?.name).toBe('Claude Fable 5')
    expect(result?.['claude-fable-5']?.api?.id).toBe('claude-fable-5')
    expect(result?.['claude-fable-5']?.cost).toEqual({
      input: 0,
      output: 0,
      cache: { read: 0, write: 0 },
    })
    expect(result?.['claude-fable-5']?.limit).toMatchObject({
      context: 1_000_000,
      output: 128_000,
    })
    expect(result?.['claude-mythos-5']?.name).toBe('Claude Mythos 5')
    expect(result?.['claude-fable-5-1']?.name).toBe('Claude Fable 5.1')
    expect(result?.['claude-fable-5']?.release_date).toBe('2026-06-09')
    expect(result?.['claude-fable-5-1']?.release_date).toBe('2026-09-01')
    expect(result?.['claude-fable-5-1']?.cost).toEqual({
      input: 0,
      output: 0,
      cache: { read: 0, write: 0 },
    })
    expect(Object.keys(result?.['claude-fable-5-1']?.variants ?? {})).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ])
    expect(result?.['claude-fable-5-1']?.variants?.xhigh).toEqual({
      thinking: { type: 'adaptive', display: 'summarized' },
      effort: 'xhigh',
    })
    expect(result?.['claude-mythos-5-1']?.variants).toBeUndefined()
    expect(result?.['claude-mythos-5-1']?.name).toBe('Claude Mythos 5.1')
    expect(result?.['claude-haiku-5-5']?.api?.id).toBe('claude-haiku-5-5')
    expect(result?.['claude-haiku-5-5']?.name).toBe('Claude Haiku 5.5')
    expect(result?.['claude-haiku-5-5']?.release_date).toBe('2026-10-07')
    expect(result?.['claude-haiku-5-5']?.limit).toMatchObject({
      context: 1_000_000,
      output: 128_000,
    })
    expect(result?.['claude-haiku-5-5']?.cost).toEqual({
      input: 0,
      output: 0,
      cache: { read: 0, write: 0 },
    })
    expect(Object.keys(result?.['claude-haiku-5-5']?.variants ?? {})).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ])
    expect(result?.['claude-haiku-5-5']?.variants?.max).toEqual({
      thinking: { type: 'adaptive', display: 'summarized' },
      effort: 'max',
    })
    expect(result?.['claude-sonnet-5-5']?.api?.id).toBe('claude-sonnet-5-5')
    expect(result?.['claude-sonnet-5-5']?.release_date).toBe('2026-09-28')
    expect(result?.['claude-sonnet-5-5']?.cost).toEqual({
      input: 0,
      output: 0,
      cache: { read: 0, write: 0 },
    })
    expect(result?.['claude-sonnet-5-5']?.limit).toMatchObject({
      context: 1_000_000,
      output: 128_000,
    })
    expect(Object.keys(result?.['claude-sonnet-5-5']?.variants ?? {})).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ])
    expect(models['claude-opus-4-8'].cost).toEqual({
      input: 5,
      output: 25,
      cache: { read: 0.5, write: 6.25 },
    })
  })

  test('keeps Anthropic API-key model costs unchanged and prices Fable 5/5.1', async () => {
    const plugin = await getPlugin()
    const models = {
      'claude-opus-4-8': {
        id: 'claude-opus-4-8',
        name: 'Claude Opus 4.8',
        api: {
          id: 'claude-opus-4-8',
          type: 'aisdk',
          package: '@ai-sdk/anthropic',
        },
        cost: { input: 5, output: 25, cache: { read: 0.5, write: 6.25 } },
        limit: { context: 1_000_000, output: 128_000 },
        capabilities: { reasoning: true, attachment: true, toolcall: true },
        release_date: '2026-01-01',
      },
    }

    const result = await plugin.provider?.models?.(
      { models } as never,
      { auth: { type: 'api' } } as never,
    )

    expect(result).not.toBe(models)
    expect(result?.['claude-opus-4-8']?.cost).toEqual({
      input: 5,
      output: 25,
      cache: { read: 0.5, write: 6.25 },
    })
    expect(result?.['claude-fable-5']?.api?.id).toBe('claude-fable-5')
    expect(result?.['claude-fable-5']?.cost).toEqual({
      input: 10,
      output: 50,
      cache: { read: 1, write: 12.5 },
    })
    expect(result?.['claude-fable-5-1']?.cost).toEqual({
      input: 10,
      output: 50,
      cache: { read: 0.25, write: 12.5 },
    })
    expect(result?.['claude-sonnet-5-5']?.cost).toEqual({
      input: 2,
      output: 10,
      cache: { read: 0.2, write: 2.5 },
    })
    expect(result?.['claude-haiku-5-5']?.cost).toEqual({
      input: 0.1,
      output: 0.5,
      cache: { read: 0.01, write: 0.125 },
      tiers: [
        {
          tier: { type: 'context', size: 100_000 },
          input: 0.5,
          output: 2.5,
          cache: { read: 0.05, write: 0.625 },
        },
      ],
    })
  })

  test('replaces stale Opus 5 manual-thinking variants with adaptive efforts', async () => {
    const plugin = await getPlugin()
    const models = {
      'claude-opus-4-8': {
        id: 'claude-opus-4-8',
        variants: {
          high: {
            thinking: { type: 'adaptive', display: 'summarized' },
            effort: 'high',
          },
        },
      },
      'claude-opus-5': {
        id: 'claude-opus-5',
        api: { id: 'claude-opus-5' },
        variants: {
          high: { thinking: { type: 'enabled', budgetTokens: 16_000 } },
          max: { thinking: { type: 'enabled', budgetTokens: 31_999 } },
        },
      },
    }

    const result = await plugin.provider?.models?.(
      { models } as never,
      { auth: { type: 'api' } } as never,
    )

    expect(result?.['claude-opus-5-5']?.name).toBe('Claude Opus 5.5')
    expect(result?.['claude-sonnet-5-5']?.name).toBe('Claude Sonnet 5.5')
    expect(result?.['claude-sonnet-5-5']?.variants).toEqual(
      result?.['claude-opus-5']?.variants,
    )
    expect(result?.['claude-opus-5-5']?.variants).toEqual(
      result?.['claude-opus-5']?.variants,
    )
    expect(result?.['claude-opus-5']?.variants).toEqual({
      low: {
        thinking: { type: 'adaptive', display: 'summarized' },
        effort: 'low',
      },
      medium: {
        thinking: { type: 'adaptive', display: 'summarized' },
        effort: 'medium',
      },
      high: {
        thinking: { type: 'adaptive', display: 'summarized' },
        effort: 'high',
      },
      xhigh: {
        thinking: { type: 'adaptive', display: 'summarized' },
        effort: 'xhigh',
      },
      max: {
        thinking: { type: 'adaptive', display: 'summarized' },
        effort: 'max',
      },
    })
    expect(models['claude-opus-5'].variants.max.thinking).toEqual({
      type: 'enabled',
      budgetTokens: 31_999,
    })
  })

  test('does not zero OAuth model costs when costZeroing is disabled', async () => {
    await useTempAccountFile(
      createFallbackStorage({ accounts: [], costZeroing: { enabled: false } }),
    )
    const plugin = await getPlugin()
    const models = {
      'claude-opus-4-8': {
        id: 'claude-opus-4-8',
        name: 'Claude Opus 4.8',
        cost: { input: 5, output: 25, cache: { read: 0.5, write: 6.25 } },
        limit: { context: 1_000_000, output: 128_000 },
        capabilities: { reasoning: true, attachment: true, toolcall: true },
        release_date: '2026-01-01',
      },
    }

    const result = await plugin.provider?.models?.(
      { models } as never,
      { auth: { type: 'oauth' } } as never,
    )

    // OAuth auth but opted out → real costs preserved, not zeroed.
    expect(result?.['claude-opus-4-8']?.cost).toEqual({
      input: 5,
      output: 25,
      cache: { read: 0.5, write: 6.25 },
    })
  })
})

describe('auth.loader', () => {
  installLoaderSetup(testContext)

  test('returns empty object for non-oauth auth', async () => {
    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () => Promise.resolve({ type: 'api' }),
      { models: {} },
    )
    expect(result).toEqual({})
  })

  test('remaps a non-OAuth Request body supplied without init.body', async () => {
    const previousModel = process.env.ANTHROPIC_MODEL
    process.env.ANTHROPIC_MODEL = 'proxy-model-alias'
    let auth: {
      type: string
      access?: string
      refresh?: string
      expires?: number
    } = {
      type: 'oauth',
      access: 'sk-ant-oat01-initial-oauth',
      refresh: 'initial-refresh',
      expires: Date.now() + 100_000,
    }
    await useTempAccountFile(createFallbackStorage({ accounts: [] }), {
      access: 'sk-ant-oat01-initial-oauth',
      refresh: 'initial-refresh',
      expires: auth.expires as number,
    })
    let observedBody: Record<string, unknown> | undefined
    globalThis.fetch = mock(
      withNativeAdmission(async (_input: unknown, init?: RequestInit) => {
        observedBody = JSON.parse(String(init?.body))
        return new Response('{}', { status: 200 })
      }),
    ) as unknown as typeof fetch

    try {
      const plugin = await getPlugin()
      const result = await plugin.auth.loader(
        () => Promise.resolve(auth as never),
        {
          models: {},
        },
      )
      auth = { type: 'api' }
      await result.fetch(
        new Request(MESSAGES_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: 'claude-custom-family',
            messages: [{ role: 'user', content: 'hello' }],
          }),
        }),
      )

      expect(observedBody?.model).toBe('proxy-model-alias')
    } finally {
      if (previousModel === undefined) delete process.env.ANTHROPIC_MODEL
      else process.env.ANTHROPIC_MODEL = previousModel
    }
  })

  test('a foreign ANTHROPIC_BASE_URL is refused for OAuth and honoured for an API key', async () => {
    const previousBase = process.env.ANTHROPIC_BASE_URL
    process.env.ANTHROPIC_BASE_URL = 'https://proxy.example.test/anthropic'
    let auth: {
      type: string
      access?: string
      refresh?: string
      expires?: number
    } = {
      type: 'oauth',
      access: 'sk-ant-oat01-base-url-oauth',
      refresh: 'base-url-refresh',
      expires: Date.now() + 100_000,
    }
    await useTempAccountFile(createFallbackStorage({ accounts: [] }), {
      access: 'sk-ant-oat01-base-url-oauth',
      refresh: 'base-url-refresh',
      expires: auth.expires as number,
    })
    const proxied: string[] = []
    globalThis.fetch = mock(
      withNativeAdmission(async (input: unknown) => {
        const url =
          input instanceof Request ? input.url : String(input as string | URL)
        if (url.startsWith('https://proxy.example.test')) proxied.push(url)
        return new Response('{}', { status: 200 })
      }),
    ) as unknown as typeof fetch
    const request = () => ({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        messages: [{ role: 'user', content: 'hello' }],
      }),
    })

    try {
      const plugin = await getPlugin()
      const result = await plugin.auth.loader(
        () => Promise.resolve(auth as never),
        { models: {} },
      )
      const refused = await result.fetch(MESSAGES_URL, request())
      expect(refused.status).toBe(400)
      expect(((await refused.json()) as any).error.message).toBe(
        Core.ANTHROPIC_OAUTH_ORIGIN_REFUSAL,
      )
      expect(proxied).toEqual([])

      auth = { type: 'api' }
      const passed = await result.fetch(MESSAGES_URL, request())
      expect(passed.status).toBe(200)
      expect(proxied).toEqual([
        'https://proxy.example.test/anthropic/v1/messages?beta=true',
      ])
    } finally {
      if (previousBase === undefined) delete process.env.ANTHROPIC_BASE_URL
      else process.env.ANTHROPIC_BASE_URL = previousBase
    }
  })

  test('returns fetch wrapper for oauth auth', async () => {
    await useTempAccountFile(createFallbackStorage({ accounts: [] }), {
      access: 'sk-ant-oat01-token',
      refresh: 'refresh',
      expires: Date.now() + 100000,
    })
    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-token',
          refresh: 'refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )
    expect(result.apiKey).toBe('')
    expect(result.fetch).toBeFunction()
  })
})
