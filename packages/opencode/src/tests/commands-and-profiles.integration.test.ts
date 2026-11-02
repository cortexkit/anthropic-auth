import { describe, expect, mock, spyOn } from 'bun:test'
import * as filesystem from 'node:fs/promises'
import { readFile } from 'node:fs/promises'
import {
  __setLogTestSink,
  type AccountStorage,
  type CommandApplyRequest,
  type CommandApplyResult,
  createNativeAccountRuntime,
  createNativePoolStore,
  type LogTestRecord,
  type OAuthAccount,
  PROFILE_TTL_MS,
  setLogLevel,
  tokenFingerprint,
} from '@cortexkit/anthropic-auth-core'
import { withLock } from '@cortexkit/common-auth/fs'
import { nativeQuotaCodec } from '../../../core/src/native-quota-codec.ts'
import type { TestLifetime } from '../../../core/src/tests/test-lifetime.ts'
import { drainNotifications } from '../rpc/notifications'
import { COMMAND_MODAL_NAMES } from '../rpc/protocol'
import {
  drainSidebarWrites,
  getSidebarState,
  getSidebarStateFile,
} from '../sidebar-state'
import {
  applyMenuAction as applyMenuActionWithCtx,
  createMockClient,
  expectHandledCommandResponse,
  latestIgnoredReply,
  openClaudeMenu,
} from './support/opencode1-client.ts'
import { installLoaderSetup } from './support/opencode1-loader-setup.ts'
import {
  bindMainQuotaToAccount,
  bindPoolAccounts,
  createFallbackStorage,
  expectNoCredentialFragment as expectNoCredentialFragmentWithCtx,
  getPlugin as getPluginWithCtx,
  loginIssues as loginIssuesWithCtx,
  poolMainAccess as poolMainAccessWithCtx,
  publishPoolMetadata as publishPoolMetadataWithCtx,
  readNativeRuntimeState as readNativeRuntimeStateWithCtx,
  readNativeSettings as readNativeSettingsWithCtx,
  refreshPoolLoginElsewhere as refreshPoolLoginElsewhereWithCtx,
  refreshPoolMainElsewhere as refreshPoolMainElsewhereWithCtx,
  syntheticMainAccountUuid,
  syntheticMainHostAuth,
  useTempAccountFile as useTempAccountFileWithCtx,
  withNativeAdmission as withNativeAdmissionWithCtx,
} from './support/opencode1-pool-fixture.ts'
import { waitForLogRecord as waitForLogRecordWithCtx } from './support/opencode1-quota-feed.ts'
import {
  readAccountStorage as readAccountStorageWithCtx,
  waitForAccountStorage as waitForAccountStorageWithCtx,
  waitForSidebarState as waitForSidebarStateWithCtx,
} from './support/opencode1-state-observers.ts'
import type { PluginRuntimeOverrides } from './support/opencode1-test-context.ts'
import {
  createOpencode1Test,
  createOpencode1TestContext,
  EMPTY_POST,
  getBodyLifetime,
  heldResponse as heldResponseWithCtx,
  installOpencode1TestHooks,
  lifetimeSignal as lifetimeSignalWithCtx,
  setSidebarWriteTestHooks as setSidebarWriteTestHooksWithCtx,
} from './support/opencode1-test-context.ts'
import { extractUrl, MESSAGES_URL } from './test-fetch'

const testContext = createOpencode1TestContext()
installOpencode1TestHooks(testContext)
const test = createOpencode1Test(testContext)

function bodyLifetime(): TestLifetime {
  return getBodyLifetime(testContext)
}
function lifetimeSignal() {
  return lifetimeSignalWithCtx(testContext)
}
function heldResponse() {
  return heldResponseWithCtx(testContext)
}
function __setSidebarStateWriteTestHooks(
  hooks: Parameters<typeof setSidebarWriteTestHooksWithCtx>[1],
  stateFile: string = getSidebarStateFile(),
) {
  return setSidebarWriteTestHooksWithCtx(testContext, hooks, stateFile)
}
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
function loginIssues(current: string, ...accesses: string[]) {
  return loginIssuesWithCtx(testContext, current, ...accesses)
}
function withNativeAdmission<Input, Init>(
  handler: (input: Input, init: Init) => unknown,
) {
  return withNativeAdmissionWithCtx(testContext, handler)
}
function refreshPoolMainElsewhere(successor: {
  access: string
  refresh: string
  expires: number
}) {
  return refreshPoolMainElsewhereWithCtx(testContext, successor)
}
function refreshPoolLoginElsewhere(
  routeId: string,
  successor: { access: string; refresh: string; expires: number },
) {
  return refreshPoolLoginElsewhereWithCtx(testContext, routeId, successor)
}
function publishPoolMetadata(
  routeId: string,
  patch: (
    identity: string,
  ) => Parameters<
    ReturnType<
      typeof import('@cortexkit/anthropic-auth-core').createNativeAccountRuntime
    >['publishLocal']
  >[1],
) {
  return publishPoolMetadataWithCtx(testContext, routeId, patch)
}
function poolMainAccess(): Promise<string> {
  return poolMainAccessWithCtx(testContext)
}
function expectNoCredentialFragment(value: unknown) {
  return expectNoCredentialFragmentWithCtx(testContext, value)
}
function readNativeSettings(): Promise<Record<string, unknown>> {
  return readNativeSettingsWithCtx(testContext)
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
function waitForSidebarState(
  predicate: (state: Awaited<ReturnType<typeof getSidebarState>>) => boolean,
) {
  return waitForSidebarStateWithCtx(testContext, predicate)
}
function readAccountStorage(): Promise<AccountStorage | null> {
  return readAccountStorageWithCtx(testContext)
}
function waitForAccountStorage(
  predicate: (storage: AccountStorage | null) => boolean,
) {
  return waitForAccountStorageWithCtx(testContext, predicate)
}
function applyMenuAction(
  plugin: any,
  sessionId: string,
  request: Omit<CommandApplyRequest, 'command' | 'sessionId'>,
): Promise<CommandApplyResult> {
  return applyMenuActionWithCtx(testContext, plugin, sessionId, request)
}
function waitForLogRecord(
  records: LogTestRecord[],
  predicate: (record: LogTestRecord) => boolean,
  description: string,
) {
  return waitForLogRecordWithCtx(testContext, records, predicate, description)
}

describe('auth.loader', () => {
  installLoaderSetup(testContext)

  test('registers /claude and handles cache settings with ignored status replies', async () => {
    await useTempAccountFile(createFallbackStorage({ accounts: [] }))
    const mockClient = createMockClient()
    const plugin = await getPlugin(mockClient, testContext.tempConfigDir)
    const config: { command?: Record<string, unknown> } = {}

    await plugin.config(config)

    expect(config.command?.claude).toMatchObject({
      template: 'claude',
      description: expect.stringContaining('Claude accounts'),
    })
    for (const command of COMMAND_MODAL_NAMES) {
      expect(config.command?.[command]).toBeUndefined()
    }

    // The menu action's reply is the apply result the TUI shows.
    const enabled = await applyMenuAction(plugin, 'session-menu', {
      sectionId: 'Cache',
      actionId: 'cache-on',
    })
    expect(enabled.ok).toBe(true)
    expect(enabled.text).toContain('## Claude Cache Enabled')

    // Without a connected TUI, /claude replies with an ignored status message.
    await expect(
      plugin['command.execute.before']({
        command: 'claude',
        arguments: '',
        sessionID: 'session-1',
      }),
    ).rejects.toThrow('__OPENCODE_ANTHROPIC_AUTH_COMMAND_HANDLED__')

    expect(latestIgnoredReply(mockClient)).toContain('- Enabled: enabled')

    expect((await readNativeSettings()).claudeCache).toEqual({
      enabled: true,
      mode: 'explicit',
    })
  })

  /**
   * Plugin timers that hold back only the two-second wait /claude makes for a
   * TUI to take its menu; every other timer runs for real. The test decides
   * when that wait expires, so no real time has to pass.
   */
  function heldTuiPickupTimers() {
    const held = new Map<object, () => void>()
    let started = Promise.withResolvers<void>()
    const setTimeoutImpl = ((
      handler: (...args: unknown[]) => void,
      delay?: number,
      ...args: unknown[]
    ) => {
      if (delay !== 2_000) return globalThis.setTimeout(handler, delay, ...args)
      const handle = {}
      held.set(handle, () => handler(...args))
      started.resolve()
      return handle
    }) as unknown as typeof setTimeout
    const clearTimeoutImpl = ((handle: ReturnType<typeof setTimeout>) => {
      if (!held.delete(handle as unknown as object))
        globalThis.clearTimeout(handle)
    }) as unknown as typeof clearTimeout
    return {
      // The default wait applies; the shared test overrides set it to zero.
      overrides: {
        setTimeout: setTimeoutImpl,
        clearTimeout: clearTimeoutImpl,
        tuiPickupTimeoutMs: undefined,
      } as PluginRuntimeOverrides,
      /** Resolves once /claude has started waiting for a TUI. */
      async started() {
        await started.promise
        started = Promise.withResolvers<void>()
      },
      get waiting() {
        return held.size
      },
      expire() {
        for (const [handle, run] of [...held]) {
          held.delete(handle)
          run()
        }
      },
    }
  }

  /** Ignored chat replies that carry the missing-TUI notice. */
  function missingTuiNotices(client: ReturnType<typeof createMockClient>) {
    const calls = (
      client.session.promptAsync as unknown as {
        mock: {
          calls: Array<[{ body: { parts: Array<{ text: string }> } }]>
        }
      }
    ).mock.calls
    return calls
      .map((call) => call[0]?.body.parts[0]?.text ?? '')
      .filter((text) => text.includes('tui.json'))
  }

  test('/claude with no TUI says once per session how to add the TUI part, and a later TUI poll restores the menu', async () => {
    await useTempAccountFile(createFallbackStorage({ accounts: [] }))
    const mockClient = createMockClient()
    const timers = heldTuiPickupTimers()
    const plugin = await getPlugin(mockClient, undefined, timers.overrides)
    const sessionID = 'session-no-tui'
    const runClaude = () =>
      plugin['command.execute.before']({
        command: 'claude',
        arguments: '',
        sessionID,
      })
    const textReplies = () =>
      (
        mockClient.session.promptAsync as unknown as {
          mock: { calls: unknown[] }
        }
      ).mock.calls.length
    const { version } = JSON.parse(
      await readFile(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { version: string }

    const handled = runClaude()
    handled.catch(() => {})
    await timers.started()
    expect(missingTuiNotices(mockClient)).toEqual([])

    timers.expire()
    await expectHandledCommandResponse(handled)

    const notices = missingTuiNotices(mockClient)
    expect(notices).toHaveLength(1)
    const [notice = ''] = notices
    expect(latestIgnoredReply(mockClient)).toBe(notice)
    expect(notice).toContain(`"@cortexkit/opencode-anthropic-auth@${version}"`)
    expect(notice).toContain('restart OpenCode')
    expect(notice).toContain('In OpenCode Desktop, use the text menu below.')
    // The read-only menu text still follows the notice.
    expect(notice).toContain('## Cache')

    // The same session again: no wait and no second notice, only the menu.
    await expectHandledCommandResponse(runClaude())
    expect(timers.waiting).toBe(0)
    expect(textReplies()).toBe(2)
    expect(missingTuiNotices(mockClient)).toHaveLength(1)
    expect(latestIgnoredReply(mockClient)).toContain('## Cache')

    // A TUI that starts polling now finds no stale menu from either call...
    expect(drainNotifications(0, sessionID)).toEqual([])
    // ...and gets the next /claude as a dialog, with no chat reply.
    await expectHandledCommandResponse(runClaude())
    expect(drainNotifications(0, sessionID).at(-1)?.type).toBe('open-menu')
    expect(textReplies()).toBe(2)
  })

  test('/claude in OpenCode Desktop replies with the text menu at once, without the TUI notice', async () => {
    await useTempAccountFile(createFallbackStorage({ accounts: [] }))
    const mockClient = createMockClient()
    const timers = heldTuiPickupTimers()
    const plugin = await getPlugin(mockClient, undefined, timers.overrides)
    const sessionID = 'session-desktop'
    const saved = process.env.OPENCODE_CLIENT
    // OpenCode Desktop starts its server with this variable set.
    process.env.OPENCODE_CLIENT = 'desktop'
    try {
      await expectHandledCommandResponse(
        plugin['command.execute.before']({
          command: 'claude',
          arguments: '',
          sessionID,
        }),
      )
    } finally {
      if (saved === undefined) delete process.env.OPENCODE_CLIENT
      else process.env.OPENCODE_CLIENT = saved
    }
    expect(timers.waiting).toBe(0)
    expect(latestIgnoredReply(mockClient)).toContain('## Cache')
    expect(missingTuiNotices(mockClient)).toEqual([])
    expect(drainNotifications(0, sessionID)).toEqual([])
  })

  test('/claude queues its menu for a polling TUI that drains late, with no notice', async () => {
    await useTempAccountFile(createFallbackStorage({ accounts: [] }))
    const mockClient = createMockClient()
    const timers = heldTuiPickupTimers()
    const plugin = await getPlugin(mockClient, undefined, timers.overrides)
    const sessionID = 'session-busy-tui'

    // The TUI polled this session recently, so it counts as connected even
    // though it does not take the menu until after the wait would have ended.
    drainNotifications(0, sessionID)
    await expectHandledCommandResponse(
      plugin['command.execute.before']({
        command: 'claude',
        arguments: '',
        sessionID,
      }),
    )
    expect(timers.waiting).toBe(0)
    timers.expire()

    const notice = drainNotifications(0, sessionID).at(-1)
    expect(notice?.type).toBe('open-menu')
    expect(missingTuiNotices(mockClient)).toEqual([])
    expect(mockClient.session.promptAsync).not.toHaveBeenCalled()
  })

  test('/claude hands its menu to a TUI that first polls during the wait, with no notice', async () => {
    await useTempAccountFile(createFallbackStorage({ accounts: [] }))
    const mockClient = createMockClient()
    const timers = heldTuiPickupTimers()
    const plugin = await getPlugin(mockClient, undefined, timers.overrides)
    const sessionID = 'session-starting-tui'

    const handled = plugin['command.execute.before']({
      command: 'claude',
      arguments: '',
      sessionID,
    })
    handled.catch(() => {})
    await timers.started()
    // A TUI that has just started polls before the two seconds are up.
    const notice = drainNotifications(0, sessionID).at(-1)
    await expectHandledCommandResponse(handled)

    expect(notice?.type).toBe('open-menu')
    expect(timers.waiting).toBe(0)
    expect(mockClient.session.promptAsync).not.toHaveBeenCalled()
  })

  test('config hook registers only /claude and retires owned aliases without clobbering foreign commands', async () => {
    await useTempAccountFile(createFallbackStorage({ accounts: [] }))
    const plugin = await getPlugin()
    const preExisting = { template: 'other-plugin-cmd', description: 'foreign' }
    const result: { command?: Record<string, unknown> } = {
      command: {
        'other-plugin-cmd': preExisting,
        ...Object.fromEntries(
          COMMAND_MODAL_NAMES.map((name) => [
            name,
            {
              template: name,
              description: 'previous plugin registration',
            },
          ]),
        ),
      },
    }
    await plugin.config(result)

    expect(result.command?.['other-plugin-cmd']).toEqual(preExisting)
    expect(result.command?.claude).toMatchObject({ template: 'claude' })
    for (const name of COMMAND_MODAL_NAMES) {
      expect(result.command?.[name]).toBeUndefined()
    }
    expect(Object.keys(result.command ?? {}).sort()).toEqual([
      'claude',
      'other-plugin-cmd',
    ])
    await plugin.dispose?.()
  })

  test('handles /claude-start by injecting one visible synthetic prompt', async () => {
    await useTempAccountFile(createFallbackStorage({ accounts: [] }))
    const mockClient = createMockClient()
    const plugin = await getPlugin(mockClient, testContext.tempConfigDir)

    const result = await applyMenuAction(plugin, 'session-start', {
      sectionId: 'Extras',
      actionId: 'start-fire',
    })
    expect(result.ok).toBe(true)

    const promptCalls = (
      mockClient.session.promptAsync as unknown as {
        mock: {
          calls: Array<[{ body: { parts: Array<Record<string, unknown>> } }]>
        }
      }
    ).mock.calls as Array<
      [
        {
          path: { id: string }
          body: { noReply: boolean; parts: Array<Record<string, unknown>> }
        },
      ]
    >
    const startCall = promptCalls
      .map(([call]) => call)
      .find((call) => call.body.parts[0]?.synthetic === true)
    expect(startCall).toEqual({
      path: { id: 'session-start' },
      body: {
        noReply: false,
        parts: [
          {
            type: 'text',
            text: '[lane start] — automated cache warm; no response needed.',
            synthetic: true,
          },
        ],
      },
    })
  })

  test('handles /claude-cachekeep command and persists window', async () => {
    await useTempAccountFile(
      createFallbackStorage({
        accounts: [],
        claudeCache: { enabled: true, mode: 'hybrid' },
      }),
    )
    const mockClient = createMockClient()
    const plugin = await getPlugin(mockClient, testContext.tempConfigDir)

    const windowed = await applyMenuAction(plugin, 'session-1', {
      sectionId: 'Cache',
      actionId: 'cachekeep-window',
      values: { startHour: 9, endHour: 23 },
    })
    expect(windowed.ok).toBe(true)
    expect(windowed.text).toContain('## Claude Cache Keep Enabled')
    expect(windowed.text).toContain('Schedule: 09-23')
    expect(windowed.text).toContain('Hybrid active: yes')

    expect((await readNativeSettings()).cacheKeep).toEqual({
      enabled: true,
      always: false,
      startHour: 9,
      endHour: 23,
    })

    const always = await applyMenuAction(plugin, 'session-1', {
      sectionId: 'Cache',
      actionId: 'cachekeep-always',
    })
    expect(always.ok).toBe(true)
    expect((await readNativeSettings()).cacheKeep).toEqual({
      enabled: true,
      always: true,
    })
  })

  test('registers and handles /claude-fast slash command with ignored status replies', async () => {
    await useTempAccountFile(createFallbackStorage({ accounts: [] }))
    const mockClient = createMockClient()
    const plugin = await getPlugin(mockClient, testContext.tempConfigDir)

    // The menu action's reply is the apply result the TUI shows.
    const enabled = await applyMenuAction(plugin, 'session-menu', {
      sectionId: 'Extras',
      actionId: 'fast-on',
    })
    expect(enabled.ok).toBe(true)
    expect(enabled.text).toContain('## Claude Fast Mode Enabled')

    // Without a connected TUI, /claude replies with an ignored status message.
    await expect(
      plugin['command.execute.before']({
        command: 'claude',
        arguments: '',
        sessionID: 'session-1',
      }),
    ).rejects.toThrow('__OPENCODE_ANTHROPIC_AUTH_COMMAND_HANDLED__')

    expect(latestIgnoredReply(mockClient)).toContain('- Enabled: enabled')

    expect((await readNativeSettings()).claudeFast).toEqual({ enabled: true })
  })

  test('handles /claude-routing slash command and persists routing mode', async () => {
    await useTempAccountFile(createFallbackStorage({ accounts: [] }))
    const mockClient = createMockClient()
    const plugin = await getPlugin(mockClient, testContext.tempConfigDir)

    const updated = await applyMenuAction(plugin, 'session-menu', {
      sectionId: 'Routing',
      actionId: 'routing-mode',
      values: { mode: 'sticky-balanced' },
    })
    expect(updated.ok).toBe(true)
    expect(updated.text).toContain('Mode updated to `sticky-balanced`.')

    // Without a connected TUI, /claude replies with an ignored status message.
    await expect(
      plugin['command.execute.before']({
        command: 'claude',
        arguments: '',
        sessionID: 'session-1',
      }),
    ).rejects.toThrow('__OPENCODE_ANTHROPIC_AUTH_COMMAND_HANDLED__')
    expect(latestIgnoredReply(mockClient)).toContain(
      '- Mode: `sticky-balanced`',
    )

    const reset = await applyMenuAction(plugin, 'session-menu', {
      sectionId: 'Routing',
      actionId: 'routing-reset',
    })
    expect(reset.ok).toBe(true)
    expect(reset.text).toContain('Claude Routing Assignment Reset')

    expect((await readNativeSettings()).routing).toEqual({
      mode: 'sticky-balanced',
    })
    for (const maxSameAccountWait of ['0', '15', 'max']) {
      const changed = await applyMenuAction(plugin, 'session-menu', {
        sectionId: 'Routing',
        actionId: 'routing-max-same-account-wait',
        values: { maxSameAccountWait },
      })
      expect(changed.ok).toBe(true)
      expect((await readNativeSettings()).routing).toEqual({
        mode: 'sticky-balanced',
        maxSameAccountWait,
      })
      expect(
        changed.menu.sections
          .find((section) => section.id === 'Routing')
          ?.lines.join('\n'),
      ).toContain(maxSameAccountWait)
    }
  })

  test('hidden slash-command replies preserve previous assistant model and variant', async () => {
    await useTempAccountFile(createFallbackStorage({ accounts: [] }))
    const mockClient = createMockClient([
      {
        info: {
          role: 'user',
          agent: 'Default Agent',
          model: {
            providerID: 'anthropic',
            modelID: 'claude-sonnet-4-6',
            variant: 'low',
          },
        },
      },
      {
        info: {
          role: 'assistant',
          agent: 'Alfonso - CTO',
          providerID: 'anthropic',
          modelID: 'claude-opus-4-7',
          variant: 'xhigh',
        },
      },
    ])
    const plugin = await getPlugin(mockClient)

    await expect(
      plugin['command.execute.before']({
        command: 'claude',
        arguments: '',
        sessionID: 'session-1',
      }),
    ).rejects.toThrow('__OPENCODE_ANTHROPIC_AUTH_COMMAND_HANDLED__')

    expect(mockClient.session.messages).toHaveBeenCalledWith({
      path: { id: 'session-1' },
      query: { limit: 100 },
    })
    expect(mockClient.session.promptAsync).toHaveBeenCalledWith({
      path: { id: 'session-1' },
      body: {
        noReply: true,
        agent: 'Alfonso - CTO',
        model: {
          providerID: 'anthropic',
          modelID: 'claude-opus-4-7',
        },
        variant: 'xhigh',
        parts: [
          {
            type: 'text',
            ignored: true,
            text: expect.stringContaining('## Claude Cache'),
          },
        ],
      },
    })
  })

  test('handles /claude-dump slash command and persists dump capture', async () => {
    await useTempAccountFile(createFallbackStorage({ accounts: [] }))
    const mockClient = createMockClient()
    const plugin = await getPlugin(mockClient, testContext.tempConfigDir)

    const result = await applyMenuAction(plugin, 'session-1', {
      sectionId: 'Diagnostics',
      actionId: 'dump-on',
    })
    expect(result.ok).toBe(true)
    expect(result.text).toContain('## Claude Dump Enabled')

    expect((await readNativeSettings()).dump).toEqual({ enabled: true })
  })

  test('handles /claude-cache mode command and persists cache strategy', async () => {
    await useTempAccountFile(
      createFallbackStorage({ accounts: [], claudeCache: { enabled: true } }),
    )
    const mockClient = createMockClient()
    const plugin = await getPlugin(mockClient, testContext.tempConfigDir)

    const result = await applyMenuAction(plugin, 'session-1', {
      sectionId: 'Cache',
      actionId: 'cache-mode',
      values: { mode: 'hybrid' },
    })

    expect((await readNativeSettings()).claudeCache).toEqual({
      enabled: true,
      mode: 'hybrid',
    })

    expect(result.ok).toBe(true)
    expect(result.text).toContain('Mode updated to `hybrid`.')
  })

  test('persistent cache, dump, fast and logging replies show the selected settings file', async () => {
    await useTempAccountFile(createFallbackStorage({ accounts: [] }))
    const plugin = await getPlugin(undefined, testContext.tempConfigDir)
    const settingsPath = testContext.migratedPool!.paths.config
    const actions = [
      { sectionId: 'Cache', actionId: 'cache-on' },
      { sectionId: 'Diagnostics', actionId: 'dump-on' },
      { sectionId: 'Extras', actionId: 'fast-on' },
      {
        sectionId: 'Diagnostics',
        actionId: 'logging-level',
        values: { level: 'debug' },
      },
    ] as const

    for (const action of actions) {
      const result = await applyMenuAction(plugin, 'settings-path', action)
      expect(result.text).toContain(`- Persisted: ${settingsPath}`)
    }
  })

  test('native quota status works before the host auth loader has run', async () => {
    const checkedAt = Date.now()
    await useTempAccountFile(
      bindMainQuotaToAccount(
        createFallbackStorage({
          accounts: [],
          quota: {
            enabled: false,
            mainQuota: {
              accountIdentity: syntheticMainAccountUuid,
              checkedAt,
              five_hour: { usedPercent: 25, remainingPercent: 75, checkedAt },
              seven_day: { usedPercent: 50, remainingPercent: 50, checkedAt },
            },
            mainQuotaCheckedAt: checkedAt,
          },
        }),
      ),
    )
    let fetchCalls = 0
    globalThis.fetch = Object.assign(
      mock(async () => {
        fetchCalls++
        throw new Error('Unexpected network call during cached native status')
      }),
      { preconnect() {} },
    )
    const mockClient = createMockClient()
    const plugin = await getPlugin(mockClient)

    await expect(
      plugin['command.execute.before']({
        command: 'claude',
        arguments: '',
        sessionID: 'session-1',
      }),
    ).rejects.toThrow('__OPENCODE_ANTHROPIC_AUTH_COMMAND_HANDLED__')

    expect(mockClient.session.promptAsync).toHaveBeenCalledWith({
      path: { id: 'session-1' },
      body: {
        noReply: true,
        parts: [
          {
            type: 'text',
            ignored: true,
            text: expect.stringContaining('5h 75% left'),
          },
        ],
      },
    })
    expect(fetchCalls).toBe(0)
  })

  test('native quota refresh shows live main and fallback quotas', async () => {
    await useTempAccountFile(
      bindPoolAccounts(
        createFallbackStorage({
          quota: { enabled: false },
          accounts: [
            {
              id: 'fallback-1',
              label: 'fallback personal',
              type: 'oauth',
              access: 'sk-ant-oat01-fallback-access',
              refresh: 'fallback-refresh',
              expires: Date.now() + 5 * 60 * 60 * 1000,
              quota: {
                five_hour: {
                  usedPercent: 99,
                  remainingPercent: 1,
                  checkedAt: 1,
                },
                seven_day: {
                  usedPercent: 99,
                  remainingPercent: 1,
                  checkedAt: 1,
                },
              },
            },
          ],
        }),
      ),
    )
    const mockClient = createMockClient()
    const seenTokens: string[] = []

    globalThis.fetch = mock(
      withNativeAdmission(
        (input: string | URL | Request, init?: RequestInit) => {
          const url = String(input)
          if (url.includes('/api/oauth/usage')) {
            const authorization = new Headers(init?.headers).get(
              'authorization',
            )
            if (authorization) seenTokens.push(authorization)
            const utilization =
              authorization === 'Bearer sk-ant-oat01-main-access' ? 25 : 40
            return Promise.resolve(
              new Response(
                JSON.stringify({
                  five_hour: { utilization },
                  seven_day: {
                    utilization:
                      authorization === 'Bearer sk-ant-oat01-main-access'
                        ? 50
                        : 60,
                  },
                }),
                { status: 200 },
              ),
            )
          }

          return Promise.resolve(new Response('{}', { status: 200 }))
        },
      ),
    ) as unknown as typeof fetch

    const plugin = await getPlugin(mockClient, testContext.tempConfigDir)
    await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )

    await expect(
      plugin['command.execute.before']({
        command: 'claude',
        arguments: '',
        sessionID: 'session-1',
      }),
    ).rejects.toThrow('__OPENCODE_ANTHROPIC_AUTH_COMMAND_HANDLED__')

    const refreshed = await applyMenuAction(plugin, 'session-1', {
      sectionId: 'Quota',
      actionId: 'quota-refresh',
    })
    expect(refreshed.ok).toBe(true)
    const freshState = await readNativeRuntimeState()
    expect(freshState.main?.quota?.five_hour?.usedPercent).toBe(25)
    expect(
      freshState.accounts['fallback-1']?.quota?.five_hour?.usedPercent,
    ).toBe(40)
    await expect(
      plugin['command.execute.before']({
        command: 'claude',
        arguments: '',
        sessionID: 'session-1',
      }),
    ).rejects.toThrow('__OPENCODE_ANTHROPIC_AUTH_COMMAND_HANDLED__')
    expect(seenTokens.toSorted()).toEqual([
      'Bearer sk-ant-oat01-fallback-access',
      'Bearer sk-ant-oat01-main-access',
    ])
    // applyMenuAction opens a TUI-connected menu. Inspect its current
    // payload, not the earlier headless notice sent before the refresh.
    const currentMenu = await openClaudeMenu(plugin, 'session-1')
    const text = JSON.stringify(currentMenu)
    expect(refreshed.text).toContain('5h 75% left')
    expect(text).toContain('## Claude Quotas')
    expect(text).toContain('### OpenCode anthropic (main)')
    expect(text).toContain('### fallback personal (fallback)')
    expect(text).toContain('5h 75% left')
    expect(text).toContain('7d 50% left')
  })

  test('/claude-quota bounds stalled profile hydration without hiding quota output', async () => {
    const checkedAt = Date.now()
    await useTempAccountFile(
      bindMainQuotaToAccount(
        createFallbackStorage({
          accounts: [],
          main: {
            type: 'opencode',
            provider: 'anthropic',
            profile: {
              checkedAt: checkedAt - 8 * 24 * 60 * 60_000,
              tier: 'default_claude_free',
              orgType: 'claude_free',
            },
          },
          quota: {
            enabled: true,
            mainQuota: {
              five_hour: { usedPercent: 25, remainingPercent: 75, checkedAt },
              seven_day: { usedPercent: 50, remainingPercent: 50, checkedAt },
              checkedAt,
            },
          },
        }),
      ),
    )
    const mockClient = createMockClient()
    let profileSignal: AbortSignal | undefined
    let usageCalls = 0
    globalThis.fetch = mock(
      withNativeAdmission(
        (input: string | URL | Request, init?: RequestInit) => {
          const url = extractUrl(input)
          if (url.includes('/api/oauth/profile')) {
            profileSignal = init?.signal ?? undefined
            return new Promise<Response>((_resolve, reject) => {
              profileSignal?.addEventListener(
                'abort',
                () => reject(profileSignal?.reason),
                { once: true },
              )
            })
          }
          if (url.includes('/api/oauth/usage')) {
            usageCalls++
            return Promise.resolve(
              Response.json({
                five_hour: { utilization: 25 },
                seven_day: { utilization: 50 },
              }),
            )
          }
          return Promise.resolve(new Response('ok'))
        },
      ),
    ) as unknown as typeof fetch
    const plugin = await getPlugin(mockClient)
    await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )
    delete process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION

    const startedAt = performance.now()
    await expect(
      plugin['command.execute.before']({
        command: 'claude',
        arguments: '',
        sessionID: 'session-1',
      }),
    ).rejects.toThrow('__OPENCODE_ANTHROPIC_AUTH_COMMAND_HANDLED__')

    expect(performance.now() - startedAt).toBeLessThan(4_000)
    expect(profileSignal?.aborted).toBe(true)
    expect(usageCalls).toBe(0)
    const text = (mockClient.session.promptAsync as any).mock.calls.at(-1)?.[0]
      ?.body.parts[0]?.text as string
    expect(text).toContain('## Claude Quotas')
    expect(text).toContain('5h 75% left')
    expect(text).not.toContain('Max 20x')
  }, 5_000)

  test('/claude-quota renders hydrated profile without waiting for profile persistence', async () => {
    await useTempAccountFile(createFallbackStorage({ accounts: [] }))
    const mockClient = createMockClient()
    let profileCalls = 0
    globalThis.fetch = mock(
      withNativeAdmission((input: string | URL | Request) => {
        const url = extractUrl(input)
        if (url.includes('/api/oauth/profile')) {
          profileCalls++
          return Promise.resolve(
            Response.json({
              organization: {
                organization_type: 'claude_max',
                rate_limit_tier: 'default_claude_max_20x',
              },
            }),
          )
        }
        if (url.includes('/api/oauth/usage')) {
          return Promise.resolve(
            Response.json({
              five_hour: { utilization: 25 },
              seven_day: { utilization: 50 },
            }),
          )
        }
        return Promise.resolve(new Response('ok'))
      }),
    ) as unknown as typeof fetch
    const plugin = await getPlugin(mockClient)
    await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )
    delete process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION

    const pool = testContext.migratedPool
    if (!pool) throw new Error('Expected migrated pool')
    const reader = createNativeAccountRuntime({
      paths: pool.paths,
      host: 'opencode',
    })
    try {
      expect((await reader.authorizeLocal('main')).status).toBe('usable')
    } finally {
      reader.close()
    }
    const locked = bodyLifetime().gate()
    const release = bodyLifetime().gate()
    // Hold the profile's runtime-file lock after credential validation.
    // Status must display the fetched tier without waiting for this writer.
    const writer = withLock(
      pool.paths.runtime,
      {
        name: 'native-runtime',
        ttlMs: 10_000,
        timeoutMs: 15_000,
        renew: true,
      },
      async () => {
        locked.open()
        await release.wait
      },
    )
    bodyLifetime().trackDetached(writer)
    await locked.wait

    const command = expectHandledCommandResponse(
      plugin['command.execute.before']({
        command: 'claude',
        arguments: '',
        sessionID: 'session-1',
      }),
    )
    let lockReleased = false
    void release.wait.then(() => {
      lockReleased = true
    })
    try {
      // Only teardown opens the release gate before this point. A status that
      // waited for the held writer (whose lock wait outlasts this test)
      // would complete only after teardown frees the lock. Waiting for the
      // command itself, not for a fixed time, keeps this independent of
      // machine speed.
      const rendered = await command.then(() => !lockReleased)

      expect(rendered).toBe(true)
      expect(profileCalls).toBe(1)
      const text = (mockClient.session.promptAsync as any).mock.calls.at(
        -1,
      )?.[0]?.body.parts[0]?.text as string
      expect(text).toContain('Max 20x')
      expect((await readAccountStorage())?.main?.profile).toBeUndefined()
    } finally {
      release.open()
      await writer
      await command
    }

    const persistedStorage = await waitForAccountStorage(
      (storage) => storage?.main?.profile?.tier === 'default_claude_max_20x',
    )
    expect(persistedStorage?.main?.profile?.tier).toBe('default_claude_max_20x')
  })

  test('profile fetch runs once per account per boot and persists the result', async () => {
    await useTempAccountFile(createFallbackStorage())
    const mockClient = createMockClient()
    const profileCalls: string[] = []
    globalThis.fetch = mock(
      withNativeAdmission(
        (input: string | URL | Request, init?: RequestInit) => {
          const url = extractUrl(input)
          const auth = new Headers(init?.headers).get('authorization') ?? ''
          if (url.includes('/api/oauth/profile')) {
            profileCalls.push(auth)
            return Promise.resolve(
              Response.json({
                organization: {
                  organization_type: auth.includes('fallback')
                    ? 'claude_team'
                    : 'claude_max',
                  rate_limit_tier: auth.includes('fallback')
                    ? 'default_claude_max_5x'
                    : 'default_claude_max_20x',
                },
              }),
            )
          }
          if (url.includes('/api/oauth/usage')) {
            return Promise.resolve(
              Response.json({
                five_hour: { utilization: 10 },
                seven_day: { utilization: 20 },
              }),
            )
          }
          return Promise.resolve(new Response('ok'))
        },
      ),
    ) as unknown as typeof fetch
    const plugin = await getPlugin(mockClient)
    await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )
    delete process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION

    for (let call = 0; call < 2; call++) {
      await expect(
        plugin['command.execute.before']({
          command: 'claude',
          arguments: '',
          sessionID: 'session-1',
        }),
      ).rejects.toThrow('__OPENCODE_ANTHROPIC_AUTH_COMMAND_HANDLED__')
      if (call === 0) {
        await waitForAccountStorage(
          (storage) =>
            storage?.main?.profile?.tier === 'default_claude_max_20x' &&
            (storage.accounts[0] as OAuthAccount | undefined)?.profile?.tier ===
              'default_claude_max_5x',
        )
      }
    }

    // Independent account hydration may finish in either order. Require
    // exactly one request per account, including after the second status read.
    expect(profileCalls.toSorted()).toEqual([
      'Bearer sk-ant-oat01-fallback-access',
      'Bearer sk-ant-oat01-main-access',
    ])
    const loaded = await readAccountStorage()
    expect(loaded?.main?.profile?.tier).toBe('default_claude_max_20x')
    expect((loaded?.accounts[0] as any)?.profile?.tier).toBe(
      'default_claude_max_5x',
    )
    const text = (mockClient.session.promptAsync as any).mock.calls.at(-1)?.[0]
      ?.body.parts[0]?.text as string
    expect(text).toContain('Max 20x')
    expect(text).toContain('Max 5x')
  })

  test('fresh profile under seven days skips fetch', async () => {
    await useTempAccountFile(
      createFallbackStorage({
        accounts: [],
        main: {
          type: 'opencode',
          provider: 'anthropic',
          profile: {
            tier: 'default_claude_max_20x',
            orgType: 'claude_max',
            checkedAt: Date.now(),
            tokenFingerprint: tokenFingerprint('sk-ant-oat01-main-access'),
          },
        },
      }),
    )
    let profileCalls = 0
    globalThis.fetch = mock((input: string | URL | Request) => {
      if (extractUrl(input).includes('/api/oauth/profile')) profileCalls++
      return Promise.resolve(
        Response.json({
          five_hour: { utilization: 10 },
          seven_day: { utilization: 20 },
        }),
      )
    }) as unknown as typeof fetch
    const plugin = await getPlugin(createMockClient())
    await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )
    delete process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION

    await expect(
      plugin['command.execute.before']({
        command: 'claude',
        arguments: '',
        sessionID: 'session-1',
      }),
    ).rejects.toThrow('__OPENCODE_ANTHROPIC_AUTH_COMMAND_HANDLED__')

    expect(profileCalls).toBe(0)
  })

  test('unbound legacy profile is not adopted by a different credential', async () => {
    await useTempAccountFile(
      createFallbackStorage({
        accounts: [],
        main: {
          type: 'opencode',
          provider: 'anthropic',
          profile: {
            tier: 'default_claude_max_20x',
            orgType: 'claude_max',
            checkedAt: Date.now(),
            tokenFingerprint: tokenFingerprint('sk-ant-oat01-old-access'),
          },
        },
      }),
      {
        access: 'sk-ant-oat01-new-access',
        refresh: 'new-refresh',
        expires: Date.now() + 100000,
      },
    )
    const mockClient = createMockClient()
    let profileCalls = 0
    globalThis.fetch = mock(
      withNativeAdmission((input: string | URL | Request) =>
        Promise.resolve(
          (() => {
            if (extractUrl(input).includes('/api/oauth/profile')) {
              profileCalls++
              return new Response('failed', { status: 500 })
            }
            return new Response('ok')
          })(),
        ),
      ),
    ) as unknown as typeof fetch
    const plugin = await getPlugin(mockClient)
    await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-new-access',
          refresh: 'new-refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )
    delete process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION

    await expect(
      plugin['command.execute.before']({
        command: 'claude',
        arguments: '',
        sessionID: 'session-1',
      }),
    ).rejects.toThrow('__OPENCODE_ANTHROPIC_AUTH_COMMAND_HANDLED__')
    const text = (mockClient.session.promptAsync as any).mock.calls.at(-1)?.[0]
      ?.body.parts[0]?.text

    // An old access-token fingerprint cannot prove the replacement account's
    // tier. A failed fresh lookup must not restore that unclaimed profile.
    expect(text).not.toContain('Max 20x')
    expect(profileCalls).toBe(1)
    expect((await readAccountStorage())?.main?.profile).toBeUndefined()
  })

  test('in-flight hydration is shared across access-token rotation', async () => {
    const firstLogin = {
      access: 'sk-ant-oat01-token-a',
      refresh: 'refresh-sk-ant-oat01-token-a',
      expires: Date.now() + 100000,
    }
    await useTempAccountFile(
      createFallbackStorage({ accounts: [] }),
      firstLogin,
    )
    const mockClient = createMockClient()
    let profileCalls = 0
    const firstProfile = heldResponse()
    const profileStarted = lifetimeSignal()
    globalThis.fetch = mock(
      withNativeAdmission((input: string | URL | Request) => {
        if (!extractUrl(input).includes('/api/oauth/profile')) {
          return Promise.resolve(new Response('ok'))
        }
        profileCalls++
        if (profileCalls === 1) {
          profileStarted.raise()
          return firstProfile.response
        }
        return Promise.resolve(
          Response.json({
            organization: {
              organization_type: 'claude_team',
              rate_limit_tier: 'default_claude_max_5x',
            },
          }),
        )
      }),
    ) as unknown as typeof fetch
    // The main login has served before, so the pool already knows which
    // account it belongs to; a refresh elsewhere then stays on that account.
    await poolMainAccess()
    const plugin = await getPlugin(mockClient)
    await plugin.auth.loader(
      () => Promise.resolve({ type: 'oauth', ...firstLogin }),
      { models: {} },
    )
    delete process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION
    const firstCommand = expectHandledCommandResponse(
      plugin['command.execute.before']({
        command: 'claude',
        arguments: '',
        sessionID: 'session-1',
      }),
    )
    await profileStarted.raised

    // Another OpenCode process refreshes the main login while the first
    // profile request is still in flight.
    await refreshPoolMainElsewhere({
      access: 'sk-ant-oat01-token-b',
      refresh: 'refresh-sk-ant-oat01-token-b',
      expires: Date.now() + 100000,
    })
    const command = expectHandledCommandResponse(
      plugin['command.execute.before']({
        command: 'claude',
        arguments: '',
        sessionID: 'session-1',
      }),
    )
    await Bun.sleep(25)
    firstProfile.release(
      Response.json({
        organization: {
          organization_type: 'claude_team',
          rate_limit_tier: 'default_claude_max_5x',
        },
      }),
    )
    await firstCommand
    await command

    expect(profileCalls).toBe(1)
  })

  test('same main token keeps a fresh bound profile without refetching', async () => {
    await useTempAccountFile(
      createFallbackStorage({
        accounts: [],
        main: {
          type: 'opencode',
          provider: 'anthropic',
          profile: {
            accountIdentity: syntheticMainAccountUuid,
            providerAccountUuid: syntheticMainAccountUuid,
            tier: 'default_claude_max_20x',
            orgType: 'claude_max',
            checkedAt: Date.now(),
            tokenFingerprint: tokenFingerprint('sk-ant-oat01-main-access'),
          },
        },
      }),
    )
    let profileCalls = 0
    globalThis.fetch = mock(
      withNativeAdmission((input: string | URL | Request) => {
        if (extractUrl(input).includes('/api/oauth/profile')) profileCalls++
        return Promise.resolve(new Response('ok'))
      }),
    ) as unknown as typeof fetch
    const plugin = await getPlugin(createMockClient())
    await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )
    delete process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION

    await expect(
      plugin['command.execute.before']({
        command: 'claude',
        arguments: '',
        sessionID: 'session-1',
      }),
    ).rejects.toThrow('__OPENCODE_ANTHROPIC_AUTH_COMMAND_HANDLED__')

    expect(profileCalls).toBe(0)
    expect((await readAccountStorage())?.main?.profile?.tier).toBe(
      'default_claude_max_20x',
    )
  })

  test('boot profile hydration publishes tier labels to the sidebar', async () => {
    delete process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION
    await useTempAccountFile(createFallbackStorage({ accounts: [] }))
    expect(
      process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION,
    ).toBeUndefined()
    let profileCalls = 0
    globalThis.fetch = mock(
      withNativeAdmission((input: string | URL | Request) => {
        if (extractUrl(input).includes('/api/oauth/profile')) {
          profileCalls++
          return Promise.resolve(
            Response.json({
              organization: {
                organization_type: 'claude_max',
                rate_limit_tier: 'default_claude_max_20x',
              },
            }),
          )
        }
        return Promise.resolve(new Response('ok'))
      }),
    ) as unknown as typeof fetch
    const plugin = await getPlugin()

    await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )
    const state = await waitForSidebarState(
      (value) => value.main.tierLabel === 'Max 20x',
    )

    expect(state.main.tierLabel).toBe('Max 20x')
    expect(profileCalls).toBe(1)
  })

  test('late fallback profile hydration cannot restore rotated credentials', async () => {
    delete process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION
    await useTempAccountFile(
      createFallbackStorage({
        quota: { enabled: false },
        main: {
          type: 'opencode',
          provider: 'anthropic',
          profile: {
            accountIdentity: syntheticMainAccountUuid,
            providerAccountUuid: syntheticMainAccountUuid,
            tier: 'default_claude_max_20x',
            orgType: 'claude_max',
            checkedAt: Date.now(),
            tokenFingerprint: tokenFingerprint('sk-ant-oat01-main-access'),
          },
        },
        accounts: [
          {
            id: 'fb',
            type: 'oauth',
            access: 'sk-ant-oat01-old-access',
            refresh: 'old-refresh',
            expires: Date.now() + 5 * 60 * 60 * 1000,
            lastRefreshedAt: 100,
          },
        ],
      }),
    )
    const profile = heldResponse()
    const profileStarted = lifetimeSignal()
    let profileCalls = 0
    globalThis.fetch = mock(
      withNativeAdmission((input: string | URL | Request) => {
        if (extractUrl(input).includes('/api/oauth/profile')) {
          profileCalls++
          profileStarted.raise()
          return profile.response
        }
        return Promise.resolve(new Response('ok'))
      }),
    ) as unknown as typeof fetch
    const plugin = await getPlugin()
    await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 100_000,
        }),
      { models: {} },
    )
    await profileStarted.raised
    await drainSidebarWrites()

    const pool = testContext.migratedPool
    if (!pool) throw new Error('Expected migrated pool')
    const reader = createNativeAccountRuntime({
      paths: pool.paths,
      host: 'opencode',
    })
    const records: LogTestRecord[] = []
    __setLogTestSink((record) => records.push(record))
    setLogLevel('debug')
    try {
      const before = await reader.captureLocalSubject('fb')
      loginIssues('sk-ant-oat01-old-access', 'sk-ant-oat01-new-access')
      await refreshPoolLoginElsewhere('fb', {
        access: 'sk-ant-oat01-new-access',
        refresh: 'new-refresh',
        expires: Date.now() + 8 * 60 * 60_000,
      })
      const rotated = await reader.captureLocalSubject('fb')
      expect(rotated.binding.identity).toBe(before.binding.identity)
      expect(rotated.binding.credentialEpoch).toBe(
        before.binding.credentialEpoch,
      )
      expect(rotated.version?.accessFingerprint).not.toBe(
        before.version?.accessFingerprint,
      )
      profile.release(
        Response.json({
          organization: {
            organization_type: 'claude_team',
            rate_limit_tier: 'default_claude_max_5x',
          },
        }),
      )
      // Profile metadata still requires its captured token version. The late
      // response must not replace credentials or publish stale metadata.
      await waitForLogRecord(
        records,
        (record) =>
          record.channel === 'quota' &&
          record.message === 'refused account profile publication' &&
          record.payload?.account === 'fb',
        'stale fallback profile publication refusal',
      )
      await drainSidebarWrites()
      const after = await reader.captureLocalSubject('fb')
      expect(after).toEqual(rotated)
      const snapshot = await reader.read()
      expect(
        snapshot.accounts.find((account) => account.id === 'fb')?.profile,
      ).toBeUndefined()
      const stored = await createNativePoolStore({
        paths: pool.paths,
        quota: nativeQuotaCodec,
      }).read()
      expect(stored.status).toBe('ready')
      const credential =
        stored.status === 'ready'
          ? stored.rows.find((row) => row.id === rotated.binding.rowId)
              ?.credential
          : undefined
      expect(credential).toMatchObject({
        type: 'oauth',
        access: 'sk-ant-oat01-new-access',
        refresh: 'new-refresh',
      })
      expect(profileCalls).toBe(1)
    } finally {
      profile.release(new Response('cancelled', { status: 499 }))
      reader.close()
      __setLogTestSink(null)
      setLogLevel('info')
    }
  })

  test('late main profile hydration cannot replace a rotated-token profile', async () => {
    delete process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION
    const oldLogin = {
      access: 'sk-ant-oat01-old-main-access',
      refresh: 'refresh-sk-ant-oat01-old-main-access',
      expires: Date.now() + 100_000,
    }
    await useTempAccountFile(createFallbackStorage({ accounts: [] }), oldLogin)
    const profile = heldResponse()
    const profileStarted = lifetimeSignal()
    globalThis.fetch = mock(
      withNativeAdmission((input: string | URL | Request) => {
        if (extractUrl(input).includes('/api/oauth/profile')) {
          profileStarted.raise()
          return profile.response
        }
        return Promise.resolve(new Response('ok'))
      }),
    ) as unknown as typeof fetch
    const plugin = await getPlugin()
    await plugin.auth.loader(
      () => Promise.resolve({ type: 'oauth', ...oldLogin }),
      { models: {} },
    )
    await profileStarted.raised
    await drainSidebarWrites()
    const initialSidebarUpdatedAt = (await getSidebarState()).lastUpdated

    // Another OpenCode process refreshes the main login, then records a newer
    // profile for the rotated credential, while this plugin's profile request
    // for the old access token is still in flight.
    await refreshPoolMainElsewhere({
      access: 'sk-ant-oat01-new-main-access',
      refresh: 'refresh-sk-ant-oat01-new-main-access',
      expires: Date.now() + 100_000,
    })
    const rotated = await readAccountStorage()
    if (!rotated) throw new Error('expected account storage')
    await publishPoolMetadata('main', (identity) => ({
      profile: {
        tier: 'default_claude_max_20x',
        orgType: 'claude_max',
        checkedAt: Date.now() + 10_000,
        accountIdentity: identity,
      },
    }))
    await Bun.sleep(2)
    profile.release(
      Response.json({
        organization: {
          organization_type: 'claude_team',
          rate_limit_tier: 'default_claude_max_5x',
        },
      }),
    )
    await waitForSidebarState(
      (state) => state.lastUpdated > initialSidebarUpdatedAt,
    )

    expect((await readAccountStorage())?.main?.profile).toMatchObject({
      tier: 'default_claude_max_20x',
      accountIdentity: rotated.mainAccountId,
    })
  })

  test('delayed boot hydration preserves a live fallback sidebar route', async () => {
    delete process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION
    await useTempAccountFile(
      createFallbackStorage({ routing: { mode: 'fallback-first' } }),
    )
    const mainProfile = heldResponse()
    const mainProfileStarted = lifetimeSignal()
    globalThis.fetch = mock(
      withNativeAdmission(
        (input: string | URL | Request, init?: RequestInit) => {
          const url = extractUrl(input)
          const authorization = new Headers(init?.headers).get('authorization')
          if (
            url.includes('/api/oauth/profile') &&
            authorization === 'Bearer sk-ant-oat01-main-access'
          ) {
            mainProfileStarted.raise()
            return mainProfile.response
          }
          if (url.includes('/api/oauth/profile')) {
            return Promise.resolve(
              Response.json({
                organization: {
                  organization_type: 'claude_team',
                  rate_limit_tier: 'default_claude_max_5x',
                },
              }),
            )
          }
          return Promise.resolve(new Response('ok'))
        },
      ),
    ) as unknown as typeof fetch
    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )
    await mainProfileStarted.raised

    await result.fetch(MESSAGES_URL, EMPTY_POST)
    await waitForSidebarState(
      (state) =>
        state.activeId === 'fallback-1' && state.route === 'fallback-first',
    )
    mainProfile.release(
      Response.json({
        organization: {
          organization_type: 'claude_max',
          rate_limit_tier: 'default_claude_max_20x',
        },
      }),
    )

    const hydratedState = await waitForSidebarState(
      (state) => state.main.tierLabel === 'Max 20x',
    )
    expect(hydratedState).toMatchObject({
      activeId: 'fallback-1',
      route: 'fallback-first',
    })
  })

  test('profile hydration keeps its plugin-scoped fetch across test turnover', async () => {
    delete process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION
    await useTempAccountFile(createFallbackStorage())
    const firstProfileStarted = lifetimeSignal()
    const secondLookupArrived = lifetimeSignal()
    const secondLookupReleased = lifetimeSignal()
    const profilesPublished = lifetimeSignal()
    // Profile responses and their persisted sidebar publications settle separately.
    // Observe the committed labels instead of racing metadata writes with a polling budget.
    __setSidebarStateWriteTestHooks({
      afterRename: async () => {
        const state = await getSidebarState()
        if (
          state.main.tierLabel === 'Max 20x' &&
          state.fallbacks[0]?.tierLabel === 'Team · Max 5x'
        )
          profilesPublished.raise()
      },
    })
    const lookupAccounts: string[] = []
    const firstFetchCalls: string[] = []
    const answer = withNativeAdmission(
      (input: string | URL | Request, init?: RequestInit) => {
        const authorization = new Headers(
          input instanceof Request ? input.headers : init?.headers,
        ).get('authorization')
        if (extractUrl(input).includes('/api/oauth/usage')) {
          return Promise.resolve(
            Response.json({
              five_hour: { utilization: 25 },
              seven_day: { utilization: 30 },
            }),
          )
        }
        firstFetchCalls.push(authorization ?? '')
        firstProfileStarted.raise()
        return Promise.resolve(
          Response.json({
            organization:
              authorization === 'Bearer sk-ant-oat01-main-access'
                ? {
                    organization_type: 'claude_max',
                    rate_limit_tier: 'default_claude_max_20x',
                  }
                : {
                    organization_type: 'claude_team',
                    rate_limit_tier: 'default_claude_max_5x',
                  },
          }),
        )
      },
    )
    globalThis.fetch = mock(
      async (input: string | URL | Request, init?: RequestInit) => {
        // Profiles load one account at a time, in either order, and each
        // account's lookup runs before its profile request. Hold the second
        // account's lookup so its profile request is sent only after the swap.
        if (extractUrl(input).includes('/api/claude_cli/bootstrap')) {
          const account =
            new Headers(
              input instanceof Request ? input.headers : init?.headers,
            ).get('authorization') ?? ''
          if (!lookupAccounts.includes(account)) lookupAccounts.push(account)
          if (lookupAccounts.indexOf(account) === 1) {
            secondLookupArrived.raise()
            await secondLookupReleased.raised
          }
        }
        return answer(input, init)
      },
    ) as unknown as typeof fetch
    const plugin = await getPlugin()
    await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )
    await firstProfileStarted.raised
    await secondLookupArrived.raised

    // Simulate the next test installing its own global fetch. The second
    // account's profile request is sent after this point and must still use the fetch
    // the plugin captured. Quota polls use the global fetch of the moment by
    // design, so only profile requests are checked here.
    const nextTestRequests: string[] = []
    const nextTestFetch = mock((input: string | URL | Request) => {
      nextTestRequests.push(extractUrl(input))
      return Promise.resolve(new Response('ok'))
    })
    globalThis.fetch = nextTestFetch as unknown as typeof fetch
    secondLookupReleased.raise()
    await profilesPublished.raised
    const state = await getSidebarState()
    expect(state.main.tierLabel).toBe('Max 20x')
    expect(state.fallbacks[0]?.tierLabel).toBe('Team · Max 5x')

    expect(firstFetchCalls.toSorted()).toEqual([
      'Bearer sk-ant-oat01-fallback-access',
      'Bearer sk-ant-oat01-main-access',
    ])
    expect(
      nextTestRequests.filter((url) => url.includes('/api/oauth/profile')),
    ).toEqual([])
  })

  test('mock-environment opt-out prevents boot profile network calls', async () => {
    await useTempAccountFile(createFallbackStorage({ accounts: [] }))
    let profileCalls = 0
    globalThis.fetch = mock((input: string | URL | Request) => {
      if (extractUrl(input).includes('/api/oauth/profile')) profileCalls++
      return Promise.resolve(new Response('ok'))
    }) as unknown as typeof fetch
    const plugin = await getPlugin()

    await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )
    await Bun.sleep(20)

    expect(profileCalls).toBe(0)
  })

  test('mock-environment opt-out prevents command profile network calls', async () => {
    await useTempAccountFile(createFallbackStorage({ accounts: [] }))
    let profileCalls = 0
    globalThis.fetch = mock((input: string | URL | Request) => {
      if (extractUrl(input).includes('/api/oauth/profile')) profileCalls++
      if (extractUrl(input).includes('/api/oauth/usage')) {
        return Promise.resolve(
          Response.json({
            five_hour: { utilization: 10 },
            seven_day: { utilization: 20 },
          }),
        )
      }
      return Promise.resolve(new Response('ok'))
    }) as unknown as typeof fetch
    const plugin = await getPlugin(createMockClient())
    await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )

    await expect(
      plugin['command.execute.before']({
        command: 'claude',
        arguments: '',
        sessionID: 'session-1',
      }),
    ).rejects.toThrow('__OPENCODE_ANTHROPIC_AUTH_COMMAND_HANDLED__')

    expect(profileCalls).toBe(0)
  })

  test('boot hydration publishes storage reloaded after the profile await', async () => {
    delete process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION
    await useTempAccountFile(createFallbackStorage({ accounts: [] }))
    const profile = heldResponse()
    const profileStarted = lifetimeSignal()
    globalThis.fetch = mock(
      withNativeAdmission((input: string | URL | Request) => {
        if (extractUrl(input).includes('/api/oauth/profile')) {
          profileStarted.raise()
          return profile.response
        }
        return Promise.resolve(new Response('ok'))
      }),
    ) as unknown as typeof fetch
    const plugin = await getPlugin()
    await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )
    await profileStarted.raised

    const storage = await readAccountStorage()
    if (!storage?.quota) throw new Error('expected quota storage')
    const backoff = {
      message: 'Claude quota check failed: 429 — rate limited',
      checkedAt: Date.now(),
      nextRetryAt: Date.now() + 60_000,
      retryCount: 1,
    }
    // Another OpenCode process records a quota backoff for the main account
    // while this plugin's boot profile request is still in flight.
    await publishPoolMetadata('main', () => ({
      lastQuotaRefreshError: backoff,
    }))
    profile.release(
      Response.json({
        organization: {
          organization_type: 'claude_max',
          rate_limit_tier: 'default_claude_max_20x',
        },
      }),
    )

    const state = await waitForSidebarState(
      (value) => value.main.tierLabel === 'Max 20x',
    )
    expect(state.main.quotaBackedOff).toBe(true)
    // The stored backoff keeps its retry schedule; free-form provider text is
    // not stored, so no credential fragment can be published with it.
    const stored = (await readAccountStorage())?.quota?.mainLastQuotaApiError
    expect(stored).toEqual(
      expect.objectContaining({
        checkedAt: backoff.checkedAt,
        nextRetryAt: backoff.nextRetryAt,
        retryCount: backoff.retryCount,
      }),
    )
    expectNoCredentialFragment(stored)
  })

  test('token rotation reuses the profile for the same account identity', async () => {
    const firstLogin = {
      access: 'sk-ant-oat01-token-a',
      refresh: 'refresh-sk-ant-oat01-token-a',
      expires: Date.now() + 100000,
    }
    await useTempAccountFile(
      createFallbackStorage({ accounts: [] }),
      firstLogin,
    )
    const mockClient = createMockClient()
    const profileCalls: string[] = []
    globalThis.fetch = mock(
      withNativeAdmission(
        (input: string | URL | Request, init?: RequestInit) => {
          if (extractUrl(input).includes('/api/oauth/profile')) {
            const authorization = new Headers(init?.headers).get(
              'authorization',
            )
            profileCalls.push(authorization ?? '')
            const firstToken = authorization?.includes('token-a')
            return Promise.resolve(
              Response.json({
                organization: {
                  organization_type: firstToken ? 'claude_team' : 'claude_max',
                  rate_limit_tier: firstToken
                    ? 'default_claude_max_5x'
                    : 'default_claude_max_20x',
                },
              }),
            )
          }
          return Promise.resolve(new Response('ok'))
        },
      ),
    ) as unknown as typeof fetch
    // The main login has served before, so the pool already knows which
    // account it belongs to; a refresh elsewhere then stays on that account.
    await poolMainAccess()
    const plugin = await getPlugin(mockClient)
    await plugin.auth.loader(
      () => Promise.resolve({ type: 'oauth', ...firstLogin }),
      { models: {} },
    )
    delete process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION
    const showAccounts = async () => {
      await expect(
        plugin['command.execute.before']({
          command: 'claude',
          arguments: '',
          sessionID: 'session-1',
        }),
      ).rejects.toThrow('__OPENCODE_ANTHROPIC_AUTH_COMMAND_HANDLED__')
      return (mockClient.session.promptAsync as any).mock.calls.at(-1)?.[0]
        ?.body.parts[0]?.text as string
    }

    expect(await showAccounts()).toContain('Team · Max 5x')
    await waitForAccountStorage(
      (storage) =>
        storage?.main?.profile?.accountIdentity === storage?.mainAccountId,
    )
    // Another OpenCode process refreshes the main login of the same account.
    await refreshPoolMainElsewhere({
      access: 'sk-ant-oat01-token-b',
      refresh: 'refresh-sk-ant-oat01-token-b',
      expires: Date.now() + 100000,
    })
    expect(await showAccounts()).toContain('Team · Max 5x')
    expect(await showAccounts()).toContain('Team · Max 5x')

    expect(profileCalls).toEqual(['Bearer sk-ant-oat01-token-a'])
    expect((await readAccountStorage())?.main?.profile?.accountIdentity).toBe(
      (await readAccountStorage())?.mainAccountId,
    )
  })

  test('expired profile TTL triggers a fresh hydration in the same process', async () => {
    await useTempAccountFile(createFallbackStorage({ accounts: [] }))
    const mockClient = createMockClient()
    const originalDateNow = Date.now
    let now = 1_000_000
    let profileCalls = 0
    Date.now = () => now
    try {
      globalThis.fetch = mock(
        withNativeAdmission((input: string | URL | Request) => {
          if (extractUrl(input).includes('/api/oauth/profile')) {
            profileCalls++
            return Promise.resolve(
              Response.json({
                organization: {
                  organization_type: 'claude_max',
                  rate_limit_tier: 'default_claude_max_20x',
                },
              }),
            )
          }
          return Promise.resolve(new Response('ok'))
        }),
      ) as unknown as typeof fetch
      const plugin = await getPlugin(mockClient)
      await plugin.auth.loader(
        () =>
          Promise.resolve({
            type: 'oauth',
            access: 'sk-ant-oat01-main-access',
            refresh: 'main-refresh',
            expires: now + PROFILE_TTL_MS * 3,
          }),
        { models: {} },
      )
      delete process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION
      const showAccounts = async () => {
        await expect(
          plugin['command.execute.before']({
            command: 'claude',
            arguments: '',
            sessionID: 'session-1',
          }),
        ).rejects.toThrow('__OPENCODE_ANTHROPIC_AUTH_COMMAND_HANDLED__')
      }

      await showAccounts()
      await waitForAccountStorage(
        (storage) => storage?.main?.profile?.checkedAt === now,
      )
      now += PROFILE_TTL_MS + 1
      await showAccounts()

      expect(profileCalls).toBe(2)
      const refreshedStorage = await waitForAccountStorage(
        (storage) => storage?.main?.profile?.checkedAt === now,
      )
      expect(refreshedStorage?.main?.profile?.checkedAt).toBe(now)
    } finally {
      Date.now = originalDateNow
    }
  })

  test('completed profile hydration does not refetch later token generations', async () => {
    const firstLogin = {
      access: 'sk-ant-oat01-token-0',
      refresh: 'refresh-sk-ant-oat01-token-0',
      expires: Date.now() + 100000,
    }
    await useTempAccountFile(
      createFallbackStorage({ accounts: [] }),
      firstLogin,
    )
    const mockClient = createMockClient()
    let profileCalls = 0
    globalThis.fetch = mock(
      withNativeAdmission((input: string | URL | Request) => {
        if (extractUrl(input).includes('/api/oauth/profile')) {
          profileCalls++
          return Promise.resolve(
            Response.json({
              organization: {
                organization_type: 'claude_max',
                rate_limit_tier: 'default_claude_max_20x',
              },
            }),
          )
        }
        return Promise.resolve(new Response('ok'))
      }),
    ) as unknown as typeof fetch
    // The main login has served before, so the pool already knows which
    // account it belongs to; a refresh elsewhere then stays on that account.
    await poolMainAccess()
    const plugin = await getPlugin(mockClient)
    await plugin.auth.loader(
      () => Promise.resolve({ type: 'oauth', ...firstLogin }),
      { models: {} },
    )
    delete process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION
    const showAccounts = async () => {
      await expect(
        plugin['command.execute.before']({
          command: 'claude',
          arguments: '',
          sessionID: 'session-1',
        }),
      ).rejects.toThrow('__OPENCODE_ANTHROPIC_AUTH_COMMAND_HANDLED__')
    }

    await showAccounts()
    await waitForAccountStorage(
      (storage) =>
        storage?.main?.profile?.accountIdentity === storage?.mainAccountId,
    )
    // Each iteration simulates another process refreshing the same main
    // account, which only rotates its access token. Profile hydration does
    // not look at tokens: once the stored profile is fresh for this account
    // identity the display skips the account, and a completed check is
    // remembered under the route ID and account identity (storage row and
    // login epoch are only consulted while a route's identity is unknown).
    // Nothing there counts or caps rotations, so three rotations in a row
    // cover what more would: none may cause a further profile fetch.
    for (let generation = 1; generation <= 3; generation++) {
      await refreshPoolMainElsewhere({
        access: `sk-ant-oat01-token-${generation}`,
        refresh: `refresh-sk-ant-oat01-token-${generation}`,
        expires: Date.now() + 100000,
      })
      await showAccounts()
    }
    await showAccounts()

    expect(profileCalls).toBe(1)
  })

  test('stale profile refreshes on display', async () => {
    await useTempAccountFile(
      createFallbackStorage({
        accounts: [],
        main: {
          type: 'opencode',
          provider: 'anthropic',
          profile: {
            tier: 'old',
            orgType: 'claude_max',
            checkedAt: Date.now() - 8 * 24 * 60 * 60 * 1000,
          },
        },
      }),
    )
    let profileCalls = 0
    globalThis.fetch = mock(
      withNativeAdmission((input: string | URL | Request) => {
        if (extractUrl(input).includes('/api/oauth/profile')) {
          profileCalls++
          return Promise.resolve(
            Response.json({
              organization: {
                organization_type: 'claude_max',
                rate_limit_tier: 'default_claude_max_20x',
              },
            }),
          )
        }
        return Promise.resolve(
          Response.json({
            five_hour: { utilization: 10 },
            seven_day: { utilization: 20 },
          }),
        )
      }),
    ) as unknown as typeof fetch
    const plugin = await getPlugin(createMockClient())
    await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )
    delete process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION

    await expect(
      plugin['command.execute.before']({
        command: 'claude',
        arguments: '',
        sessionID: 'session-1',
      }),
    ).rejects.toThrow('__OPENCODE_ANTHROPIC_AUTH_COMMAND_HANDLED__')

    expect(profileCalls).toBe(1)
    const refreshedStorage = await waitForAccountStorage(
      (storage) => storage?.main?.profile?.tier === 'default_claude_max_20x',
    )
    expect(refreshedStorage?.main?.profile?.tier).toBe('default_claude_max_20x')
  })

  test('profile fetch failure is silent and label is omitted', async () => {
    await useTempAccountFile(createFallbackStorage({ accounts: [] }))
    const mockClient = createMockClient()
    globalThis.fetch = mock(
      withNativeAdmission((input: string | URL | Request) =>
        Promise.resolve(
          extractUrl(input).includes('/api/oauth/profile')
            ? new Response('failed', { status: 500 })
            : Response.json({
                five_hour: { utilization: 10 },
                seven_day: { utilization: 20 },
              }),
        ),
      ),
    ) as unknown as typeof fetch
    const plugin = await getPlugin(mockClient)
    await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )
    delete process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION
    const records: LogTestRecord[] = []
    __setLogTestSink((record) => records.push(record))
    setLogLevel('debug')

    try {
      await expect(
        plugin['command.execute.before']({
          command: 'claude',
          arguments: '',
          sessionID: 'session-1',
        }),
      ).rejects.toThrow('__OPENCODE_ANTHROPIC_AUTH_COMMAND_HANDLED__')
    } finally {
      __setLogTestSink(null)
      setLogLevel('info')
    }
    const text = (mockClient.session.promptAsync as any).mock.calls.at(-1)?.[0]
      ?.body.parts[0]?.text

    expect(text).not.toContain('Max 20x')
    expect(
      records.filter(
        (record) =>
          record.level === 'debug' &&
          record.channel === 'quota' &&
          record.message === 'failed to hydrate account profile' &&
          record.payload?.account === 'main',
      ),
    ).toHaveLength(1)
  })

  for (const rotate of [false, true]) {
    test(
      rotate
        ? 'profile I/O failure hides a fetched tier after the credential changes'
        : 'profile persistence failure does not block account display',
      async () => {
        await useTempAccountFile(createFallbackStorage({ accounts: [] }))
        const mockClient = createMockClient()
        let profileCalls = 0
        globalThis.fetch = mock(
          withNativeAdmission((input: Parameters<typeof fetch>[0]) => {
            if (extractUrl(input).includes('/api/oauth/profile')) {
              profileCalls++
              return Promise.resolve(
                Response.json({
                  organization: {
                    organization_type: 'claude_max',
                    rate_limit_tier: 'default_claude_max_20x',
                  },
                }),
              )
            }
            return Promise.resolve(new Response('ok'))
          }),
        ) as unknown as typeof fetch
        const plugin = await getPlugin(mockClient)
        await plugin.auth.loader(
          () =>
            Promise.resolve({
              type: 'oauth',
              access: 'sk-ant-oat01-main-access',
              refresh: 'main-refresh',
              expires: Date.now() + 100000,
            }),
          { models: {} },
        )
        const pool = testContext.migratedPool
        if (!pool) throw new Error('Expected migrated pool')
        const reader = createNativeAccountRuntime({
          paths: pool.paths,
          host: 'opencode',
        })
        expect((await reader.authorizeLocal('main')).status).toBe('usable')
        const before = await readFile(pool.paths.runtime)
        const originalRename = filesystem.rename
        let failedWrites = 0
        // Fail only the actual metadata rename after credential admission and
        // production publication guards. Leave credential files untouched.
        const writer = spyOn(filesystem, 'rename').mockImplementation(
          async (from, to) => {
            if (to === pool.paths.runtime) {
              failedWrites++
              throw Object.assign(
                new Error('Synthetic profile rename failure'),
                { code: 'EIO' },
              )
            }
            await originalRename(from, to)
          },
        )
        const records: LogTestRecord[] = []
        __setLogTestSink((record) => records.push(record))
        setLogLevel('debug')
        delete process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION
        const command = () =>
          expectHandledCommandResponse(
            plugin['command.execute.before']({
              command: 'claude',
              arguments: '',
              sessionID: 'session-1',
            }),
          )
        try {
          await command()
          await waitForLogRecord(
            records,
            (record) =>
              record.level === 'warn' &&
              record.channel === 'quota' &&
              record.message === 'failed to persist account profile',
            'profile I/O failure warning',
          )
          expect(failedWrites).toBe(1)
          expect(await readFile(pool.paths.runtime)).toEqual(before)
          writer.mockRestore()
          if (rotate)
            await refreshPoolMainElsewhere({
              access: 'sk-ant-oat01-profile-io-successor',
              refresh: 'profile-io-successor-refresh',
              expires: Date.now() + 8 * 60 * 60_000,
            })
          // Reopen after the I/O outcome, so this assertion cannot pass merely
          // because the first display raced the failing writer.
          await command()
          const calls = (
            mockClient.session.promptAsync as unknown as {
              mock: {
                calls: Array<[{ body: { parts: Array<{ text: string }> } }]>
              }
            }
          ).mock.calls
          const text = calls.at(-1)?.[0].body.parts[0]?.text
          if (rotate) expect(text).not.toContain('Max 20x')
          else expect(text).toContain('Max 20x')
          expect(profileCalls).toBe(1)
          expect(
            (await reader.read()).accounts.find(
              (account) => account.id === 'main',
            )?.profile,
          ).toBeUndefined()
          expect(
            records.filter(
              (record) =>
                record.level === 'warn' &&
                record.channel === 'quota' &&
                record.message === 'failed to persist account profile',
            ),
          ).toHaveLength(1)
        } finally {
          writer.mockRestore()
          reader.close()
          __setLogTestSink(null)
          setLogLevel('info')
        }
      },
    )
  }

  test('ordinary model request never calls the profile endpoint', async () => {
    await useTempAccountFile(createFallbackStorage({ accounts: [] }))
    let profileCalls = 0
    globalThis.fetch = mock(
      withNativeAdmission((input: string | URL | Request) => {
        if (extractUrl(input).includes('/api/oauth/profile')) profileCalls++
        return Promise.resolve(new Response('ok'))
      }),
    ) as unknown as typeof fetch
    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )

    await result.fetch(MESSAGES_URL, EMPTY_POST)

    expect(profileCalls).toBe(0)
  })
})
