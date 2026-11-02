import { describe, expect, test } from 'bun:test'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { disconnectClaustrumEnrollment } from '@cortexkit/common-auth/claustrum'
import type {
  CommandApplyRequest,
  KnobValues,
} from '@cortexkit/common-auth/commands'
import { authorize, exchange } from '../auth.ts'
import { getHostClaustrumEnrollmentPaths } from '../claustrum-enrollment.ts'
import { TOKEN_URL } from '../constants.ts'
import { readNativeEnrollmentMode } from '../native-enrollment-authority.ts'
import type {
  NativeMenuDispatchRequest,
  NativeVaultDisconnect,
  NativeVaultDisconnectResult,
} from '../native-menu-executor.ts'
import type {
  NativeMenuActionId,
  NativeMenuGroupId,
} from '../native-menu-model.ts'
import {
  type CommandMenu,
  createNativeUi,
  type NativeUiOptions,
  runPiCommandMenu,
} from '../native-ui.ts'
import { disconnectNativeVaultForHost } from '../native-vault-connection.ts'
import { resolveNativePoolPaths } from '../pool-paths.ts'

const opaqueId = 'vault:oauth:team:person'
const entries = [{ account: opaqueId, fh: 5, sd: 10, scoped: 23 }]
const fixtures = {
  enable: ['Accounts', { id: opaqueId }],
  disable: ['Accounts', { id: opaqueId }],
  remove: ['Accounts', { id: opaqueId }],
  'move-up': ['Accounts', { id: opaqueId }],
  'move-down': ['Accounts', { id: opaqueId }],
  'reset-backoff': ['Accounts', {}],
  'enrollment-reset': ['Accounts', {}],
  'add-apikey': [
    'Accounts',
    {
      apiKey: 'synthetic-key',
      label: 'two words',
      baseURL: 'https://example.invalid/v1',
      authHeader: 'x-api-key',
    },
  ],
  'add-oauth-start': ['Accounts', {}],
  'add-oauth-finish': [
    'Accounts',
    { code: 'synthetic-code', label: 'two words' },
  ],
  'custody-mode': ['Accounts', { mode: 'claustrum' }],
  'vault-disconnect': ['Accounts', {}],
  'quota-refresh': ['Quota', {}],
  'routing-mode': ['Routing', { mode: 'sticky-balanced' }],
  'routing-reset': ['Routing', {}],
  'routing-max-same-account-wait': ['Routing', { maxSameAccountWait: 'max' }],
  'killswitch-on': ['Limits', {}],
  'killswitch-off': ['Limits', {}],
  'killswitch-set': ['Limits', { entries: JSON.stringify(entries) }],
  'cache-on': ['Cache', {}],
  'cache-off': ['Cache', {}],
  'cache-mode': ['Cache', { mode: 'hybrid' }],
  'cachekeep-always': ['Cache', {}],
  'cachekeep-off': ['Cache', {}],
  'cachekeep-window': ['Cache', { startHour: 23, endHour: 7 }],
  'cachekeep-subagents': ['Cache', { enabled: 'off' }],
  'dump-on': ['Diagnostics', {}],
  'dump-off': ['Diagnostics', {}],
  'logging-level': ['Diagnostics', { level: 'trace' }],
  'fast-on': ['Extras', {}],
  'fast-off': ['Extras', {}],
  'prime-on': ['Extras', {}],
  'prime-off': ['Extras', {}],
  'start-fire': ['Extras', {}],
} satisfies Record<NativeMenuActionId, [NativeMenuGroupId, KnobValues]>

const invocation = { sessionId: 'conversation-1', notify() {} }
const localCustody = async () => 'local' as const
/** These tests never select disconnect; return 'idle' if the callback is invoked. */
const unusedDisconnect = async () => 'idle' as const
const piUnavailable = [
  'quota-refresh',
  'killswitch-on',
  'killswitch-off',
  'killswitch-set',
  'prime-on',
  'prime-off',
  'start-fire',
]

function applyFixture(
  menu: CommandMenu,
  actionId: NativeMenuActionId,
  patch: Partial<CommandApplyRequest> = {},
) {
  return menu.apply(
    {
      command: 'claude',
      sectionId: fixtures[actionId][0],
      actionId,
      values: fixtures[actionId][1],
      sessionId: invocation.sessionId,
      confirmed: true,
      ...patch,
    },
    invocation,
  )
}

/**
 * Exercise JavaScript callers that return an invalid value from readMode.
 * Reflect.apply allows those inputs without weakening the production type.
 */
function rawSetup(
  readMode: () => Promise<unknown>,
  disconnectVault: NativeVaultDisconnect,
) {
  const calls: NativeMenuDispatchRequest[] = []
  const options: unknown = {
    host: 'opencode',
    interactive: true,
    readMode,
    disconnectVault,
    dispatch: async (request: NativeMenuDispatchRequest) => {
      calls.push(request)
      return { ok: true, text: 'Applied' }
    },
    readStatus: async (command: string) => `${command}: public status`,
  }
  const menu: CommandMenu = Reflect.apply(createNativeUi, undefined, [options])
  return {
    menu,
    calls,
    apply: (
      actionId: NativeMenuActionId,
      patch: Partial<CommandApplyRequest> = {},
    ) => applyFixture(menu, actionId, patch),
  }
}

function setup(
  host: 'opencode' | 'pi' = 'opencode',
  interactive = true,
  readMode: NativeUiOptions['readMode'] = localCustody,
  disconnectVault: NativeVaultDisconnect = unusedDisconnect,
) {
  const calls: NativeMenuDispatchRequest[] = []
  const reads: string[] = []
  const menu = createNativeUi({
    host,
    interactive,
    readMode,
    disconnectVault,
    dispatch: async (request) => {
      calls.push(request)
      return { ok: true, text: 'Applied' }
    },
    readStatus: async (command, context) => {
      reads.push(`${command}:${context.sessionId}`)
      return `${command}: public status`
    },
  })
  const apply = (
    actionId: NativeMenuActionId,
    patch: Partial<CommandApplyRequest> = {},
  ) => applyFixture(menu, actionId, patch)
  return { menu, calls, reads, apply }
}

describe('native UI contract', () => {
  test('separate host login notice is read once per local render and is never selectable', async () => {
    let separateLogin = true
    let reads = 0
    const menu = createNativeUi({
      host: 'opencode',
      interactive: true,
      readMode: localCustody,
      disconnectVault: unusedDisconnect,
      dispatch: async () => ({ ok: true, text: '' }),
      readStatus: async () => 'public status',
      readSeparateHostLoginNotice: async () => {
        reads++
        return separateLogin
      },
    })
    const notice =
      "OpenCode's separate Anthropic login is not used. Add that account through /claude Accounts if needed, or remove the separate login from OpenCode."
    for (let render = 1; render <= 2; render++) {
      const { menu: model } = await menu.open(invocation)
      expect(reads).toBe(render)
      expect(
        model.sections
          .flatMap((section) => section.lines)
          .filter((line) => line === notice),
      ).toHaveLength(1)
      expect(
        JSON.stringify(
          model.sections.flatMap((section) => [
            ...section.items,
            ...section.actions,
          ]),
        ),
      ).not.toContain(notice)
    }
    separateLogin = false
    expect(JSON.stringify(await menu.open(invocation))).not.toContain(notice)
    expect(reads).toBe(3)
  })

  test('notice reader failures and non-boolean values stay silent and non-local custody never reads it', async () => {
    for (const mode of ['local', 'claustrum', undefined] as const) {
      for (const value of [
        false,
        'true',
        1,
        undefined,
        new Error('synthetic-private-error'),
      ]) {
        let reads = 0
        const options = {
          host: 'opencode',
          interactive: false,
          readMode: async () => mode,
          disconnectVault: unusedDisconnect,
          dispatch: async () => ({ ok: true, text: '' }),
          readStatus: async () => '',
          readSeparateHostLoginNotice: async () => {
            reads++
            if (value instanceof Error) throw value
            return value
          },
        }
        const menu: CommandMenu = Reflect.apply(createNativeUi, undefined, [
          options,
        ])
        const rendered = JSON.stringify(await menu.open(invocation))
        expect(reads).toBe(mode === 'local' ? 1 : 0)
        expect(rendered).not.toContain('separate Anthropic login')
        expect(rendered).not.toContain('synthetic-private-error')
      }
    }
  })

  test('hosts without the optional reader show no separate login notice', async () => {
    for (const host of ['opencode', 'pi'] as const)
      expect(
        JSON.stringify(await setup(host).menu.open(invocation)),
      ).not.toContain('separate Anthropic login')
  })

  for (const host of ['opencode', 'pi'] as const) {
    for (const enabled of [true, false]) {
      test(`${host} shared vault menu names reauth accounts and the replacement command (enabled=${enabled})`, async () => {
        let state = 'needs_reauth'
        const menu = createNativeUi({
          host,
          interactive: false,
          readMode: async () => 'claustrum',
          disconnectVault: unusedDisconnect,
          dispatch: async () => ({ ok: true, text: '' }),
          readStatus: async () => 'public status',
          readAccounts: async () => ({
            mode: 'claustrum',
            settings: {},
            policyStorage: { version: 1, accounts: [] },
            accounts: [
              {
                id: 'main',
                label: 'Personal Claude',
                source: 'vault',
                type: 'oauth',
                enabled,
                state,
                credentialId: 'oauth:anthropic',
              },
            ],
          }),
        })
        const first = await menu.open(invocation)
        const lines = first.menu.sections
          .flatMap((section) => section.lines)
          .join('\n')
        expect(lines).toContain(
          'Personal Claude (oauth:anthropic) needs signing in again.',
        )
        expect(lines).toContain(
          'ck auth login --provider anthropic --id oauth:anthropic --replace',
        )
        state = 'active'
        const second = await menu.open(invocation)
        expect(
          second.menu.sections.flatMap((section) => section.lines).join('\n'),
        ).not.toContain('--replace')
      })
    }
  }

  test('bundled Pi renderer executes the same checked menu without a second backend', async () => {
    const { menu, calls } = setup('pi')
    const inputs = [
      'synthetic-private-key',
      'two words',
      'https://example.invalid/api',
    ]
    const notices: string[] = []
    let roots = 0
    let sections = 0
    await runPiCommandMenu(
      menu,
      {
        async select(title, choices) {
          if (title === 'Claude')
            return roots++ === 0
              ? choices.find((choice) => choice.startsWith('Accounts:'))
              : undefined
          if (title.startsWith('Accounts'))
            return sections++ === 0
              ? choices.find((choice) => choice === 'Add API-key fallback')
              : undefined
          if (title === 'authHeader')
            return choices.find((choice) => choice === 'x-api-key')
          return undefined
        },
        async input() {
          return inputs.shift()
        },
        async confirm() {
          throw new Error('API key creation is not destructive')
        },
        notify(text) {
          notices.push(text)
        },
      },
      { sessionId: invocation.sessionId },
    )
    expect(calls).toEqual([
      {
        action: 'add-apikey',
        values: {
          apiKey: 'synthetic-private-key',
          label: 'two words',
          baseURL: 'https://example.invalid/api',
          authHeader: 'x-api-key',
        },
      },
    ])
    expect(inputs).toEqual([])
    expect(notices).toEqual(['Applied'])
  })
  for (const host of ['opencode', 'pi'] as const) {
    test(`${host} presents the exact native inventory and typed knobs`, async () => {
      const { menu, reads } = setup(host)
      const payload = await menu.open(invocation)
      expect(payload.command).toBe('claude')
      expect(payload.menu.sections.map((section) => section.id)).toEqual([
        'Accounts',
        'Quota',
        'Routing',
        'Limits',
        'Cache',
        'Diagnostics',
        'Extras',
      ])
      expect(
        payload.menu.sections.flatMap((section) =>
          section.actions.map((action) => action.id),
        ),
      ).toEqual(
        Object.keys(fixtures).filter(
          (id) =>
            (host === 'opencode' || !piUnavailable.includes(id)) &&
            id !== 'vault-disconnect',
        ),
      )
      const actions = payload.menu.sections.flatMap(
        (section) => section.actions,
      )
      const api = actions.find((action) => action.id === 'add-apikey')
      expect(
        actions.find((action) => action.id === 'routing-max-same-account-wait'),
      ).toMatchObject({
        label: 'Longest wait on the same account',
        knobs: [
          {
            id: 'maxSameAccountWait',
            kind: 'choice',
            label: 'Longest wait on the same account',
            choices: [
              { value: '0', label: "Don't wait" },
              { value: '15', label: '15 minutes' },
              { value: 'max', label: 'Until the cache expires' },
            ],
          },
        ],
      })
      expect(api?.knobs.map((knob) => knob.id)).toEqual([
        'apiKey',
        'label',
        'baseURL',
        'authHeader',
      ])
      expect(api?.knobs[0]).toEqual({
        kind: 'text',
        id: 'apiKey',
        label: 'apiKey',
        required: true,
        masked: true,
      })
      expect(
        actions.find((action) => action.id === 'remove')?.confirm?.irreversible,
      ).toBe(true)
      expect(
        actions.find((action) => action.id === 'enrollment-reset')?.confirm,
      ).toBeDefined()
      expect(reads).toEqual([
        'account:conversation-1',
        'quota:conversation-1',
        'routing:conversation-1',
        ...(host === 'opencode' ? ['killswitch:conversation-1'] : []),
        'cache:conversation-1',
        'cachekeep:conversation-1',
        'dump:conversation-1',
        'logging:conversation-1',
        'fast:conversation-1',
        'prime:conversation-1',
      ])
    })
    for (const actionId of Object.keys(fixtures) as NativeMenuActionId[]) {
      if (host === 'pi' && piUnavailable.includes(actionId)) continue
      // This loop covers local accounts. Separate disconnect tests check hosts
      // with vault enrollment and every disconnect outcome.
      if (actionId === 'vault-disconnect') continue
      test(`${host} executes ${actionId} with all parameters intact`, async () => {
        const { calls, apply } = setup(host)
        const result = await apply(actionId)
        expect(result.ok).toBe(true)
        if (actionId === 'custody-mode') {
          expect(calls).toEqual([])
          expect(result.text).toContain('nothing changed')
          expect(result.text).toContain('Stop all selected hosts')
          return
        }
        expect<unknown>(calls).toEqual([
          {
            action: actionId,
            values:
              actionId === 'killswitch-set'
                ? { entries }
                : fixtures[actionId][1],
            ...([
              'routing-reset',
              'start-fire',
              'add-oauth-start',
              'add-oauth-finish',
            ].includes(actionId)
              ? { sessionId: invocation.sessionId }
              : {}),
          },
        ])
      })
    }
  }

  test('confirmation cannot be bypassed by transport or the renderer', async () => {
    const { calls, apply } = setup()
    for (const action of ['remove', 'enrollment-reset'] as const) {
      const result = await apply(action, { confirmed: false })
      expect(result.code).toBe('confirmation-required')
      expect(result.needsConfirmation).toBe(true)
    }
    expect(calls).toEqual([])
  })

  test('headless credential entry and custody guidance are refused', async () => {
    const { calls, apply } = setup('opencode', false)
    expect((await apply('add-apikey')).code).toBe('interactive-required')
    expect((await apply('add-oauth-start')).code).toBe('interactive-required')
    expect((await apply('custody-mode')).code).toBe('offline-required')
    expect(calls).toEqual([])
  })

  test('Pi cannot dispatch OpenCode-only capabilities', async () => {
    const { calls, apply } = setup('pi')
    for (const action of piUnavailable as NativeMenuActionId[]) {
      expect((await apply(action)).ok).toBe(false)
    }
    expect(calls).toEqual([])
  })

  test('forged sections, items, aliases and cross-session requests never dispatch', async () => {
    const { calls, apply } = setup()
    for (const patch of [
      { command: 'claude-account' },
      { sectionId: 'Quota' },
      { itemId: opaqueId },
      { sessionId: 'other-session' },
    ]) {
      expect((await apply('enable', patch)).code).toBe('invalid-request')
    }
    expect(calls).toEqual([])
  })

  test('structured limits reject bad JSON, scoped thresholds and unknown fields', async () => {
    const { calls, apply } = setup()
    for (const value of [
      'main:5,10',
      '[{"account":"main","fh":5,"sd":10,"scoped":-1}]',
      '[{"account":"main","fh":5,"sd":10,"extra":1}]',
    ]) {
      expect(
        (await apply('killswitch-set', { values: { entries: value } })).ok,
      ).toBe(false)
    }
    expect(
      (
        await apply('cachekeep-window', {
          values: { startHour: 3, endHour: 3 },
        })
      ).code,
    ).toBe('invalid-parameter')
    expect(
      (await apply('enable', { values: { id: opaqueId, token: 'synthetic' } }))
        .code,
    ).toBe('unknown-parameter')
    expect(calls).toEqual([])
  })

  test('optional empty values reach the backend as absent, not invented defaults', async () => {
    const { calls, apply } = setup()
    expect(
      (
        await apply('add-apikey', {
          values: {
            apiKey: 'synthetic-key',
            label: null,
            baseURL: null,
            authHeader: '',
          },
        })
      ).ok,
    ).toBe(true)
    expect(calls).toEqual([
      { action: 'add-apikey', values: { apiKey: 'synthetic-key' } },
    ])
  })

  test('outcome and refreshed status never echo a protected value', async () => {
    let after = false
    const menu = createNativeUi({
      host: 'opencode',
      interactive: true,
      readMode: localCustody,
      disconnectVault: unusedDisconnect,
      dispatch: async () => {
        after = true
        return { ok: true, text: 'Accepted synthetic-private-key' }
      },
      readStatus: async () =>
        after ? 'status synthetic-private-key sk-ant-testsecret' : 'public',
    })
    const result = await menu.apply(
      {
        command: 'claude',
        sectionId: 'Accounts',
        actionId: 'add-apikey',
        values: { apiKey: 'synthetic-private-key' },
      },
      invocation,
    )
    expect(result.ok).toBe(true)
    expect(JSON.stringify(result)).not.toContain('synthetic-private-key')
    expect(JSON.stringify(result)).not.toContain('sk-ant-testsecret')
    expect(result.text).toContain('[REDACTED]')
  })

  test('protected API key and OAuth code notifications are scrubbed on success, refusal and invalid refreshes', async () => {
    for (const [actionId, parameter, secret] of [
      ['add-apikey', 'apiKey', 'arbitrary-custom-provider-private-key'],
      ['add-oauth-finish', 'code', 'private approval proof#verifier'],
    ] as const) {
      for (const mode of [
        'success',
        'headless',
        'wrong-section',
        'invalid-action',
        'session-mismatch',
        'invalid-parser',
      ] as const) {
        const notifications: { text: string; kind: string | undefined }[] = []
        let dispatches = 0
        const menu = createNativeUi({
          host: 'opencode',
          interactive: mode !== 'headless',
          readMode: localCustody,
          disconnectVault: unusedDisconnect,
          dispatch: async () => {
            dispatches++
            return { ok: true, text: `Accepted ${secret}` }
          },
          readStatus: async (_command, context) => {
            context.notify('Public refresh completed', 'info')
            context.notify(`Provider notification: ${secret}`, 'warning')
            return `Provider status: ${secret}`
          },
        })
        const result = await menu.apply(
          {
            command: 'claude',
            sectionId: mode === 'wrong-section' ? 'Quota' : 'Accounts',
            actionId:
              mode === 'invalid-action' ? 'unknown-native-action' : actionId,
            values: {
              [parameter]: secret,
              ...(mode === 'invalid-parser' ? { malformed: Number.NaN } : {}),
            },
            sessionId:
              mode === 'session-mismatch'
                ? 'different-session'
                : 'notification-session',
          },
          {
            sessionId: 'notification-session',
            notify(text, kind) {
              notifications.push({ text, kind })
            },
          },
        )
        expect(dispatches).toBe(mode === 'success' ? 1 : 0)
        expect(result.ok).toBe(mode === 'success')
        expect(notifications).toHaveLength(20)
        expect(
          notifications.filter(
            (entry) => entry.text === 'Public refresh completed',
          ),
        ).toEqual(
          Array.from({ length: 10 }, () => ({
            text: 'Public refresh completed',
            kind: 'info',
          })),
        )
        expect(
          notifications.filter((entry) => entry.kind === 'warning'),
        ).toEqual(
          Array.from({ length: 10 }, () => ({
            text: 'Provider notification: [REDACTED]',
            kind: 'warning',
          })),
        )
        expect(JSON.stringify({ result, notifications })).not.toContain(secret)
      }
    }
  })

  test('unreadable requests never invoke credential getters, proxy traps or echoing status callbacks', async () => {
    let getters = 0
    let traps = 0
    let statuses = 0
    let dispatches = 0
    const notifications: string[] = []
    const secret = 'unreadable-request-private-value'
    const hostile = new Proxy(
      {},
      {
        get() {
          traps++
          throw new Error('unexpected proxy get')
        },
        getOwnPropertyDescriptor() {
          traps++
          throw new Error('unexpected proxy descriptor')
        },
        getPrototypeOf() {
          traps++
          throw new Error('unexpected proxy prototype')
        },
        ownKeys() {
          traps++
          throw new Error('unexpected proxy enumeration')
        },
      },
    )
    const request = {
      command: 'claude',
      sectionId: 'Accounts',
      actionId: 'add-apikey',
      values: { apiKey: secret },
    }
    const accessorRequest = { ...request }
    Object.defineProperty(accessorRequest, 'values', {
      enumerable: true,
      get() {
        getters++
        throw new Error('unexpected values getter')
      },
    })
    const accessorValues = { apiKey: secret }
    Object.defineProperty(accessorValues, 'unknown', {
      enumerable: true,
      get() {
        getters++
        throw new Error('unexpected unknown getter')
      },
    })
    const menu = createNativeUi({
      host: 'opencode',
      interactive: true,
      readMode: localCustody,
      disconnectVault: unusedDisconnect,
      dispatch: async () => {
        dispatches++
        return { ok: true, text: 'not expected' }
      },
      readStatus: async (_command, context) => {
        statuses++
        context.notify(secret)
        return secret
      },
    })
    for (const raw of [
      hostile,
      { ...request, values: hostile },
      accessorRequest,
      { ...request, values: accessorValues },
    ]) {
      const result = await menu.apply(raw as CommandApplyRequest, {
        sessionId: 'a',
        notify(text) {
          notifications.push(text)
        },
      })
      expect(result.code).toBe('invalid-request')
      expect(result.ok).toBe(false)
      expect(result.menu.sections[0]?.lines[0]).toContain('status unavailable')
      expect(JSON.stringify(result)).not.toContain(secret)
    }
    expect(getters).toBe(0)
    expect(traps).toBe(0)
    expect(statuses).toBe(0)
    expect(dispatches).toBe(0)
    expect(notifications).toEqual([])
  })

  test('exceptions do not leak and status failures are visibly unavailable', async () => {
    const menu = createNativeUi({
      host: 'opencode',
      interactive: true,
      readMode: localCustody,
      disconnectVault: unusedDisconnect,
      dispatch: async () => {
        throw new Error('secret-operation-material')
      },
      readStatus: async () => {
        throw new Error('secret-status-material')
      },
    })
    const result = await menu.apply(
      { command: 'claude', sectionId: 'Cache', actionId: 'cache-on' },
      invocation,
    )
    expect(result.ok).toBe(false)
    expect(result.code).toBe('execution-failed')
    expect(JSON.stringify(result)).not.toContain('secret-')
    expect(result.menu.sections[0]?.lines[0]).toContain('status unavailable')
  })
})

describe('OAuth sign-in link', () => {
  type TokenCall = { url: string; body: Record<string, unknown> }

  // Replace fetch so only the token endpoint answers, from a local fixture.
  // Any other URL throws, so these tests never reach the network.
  async function withTokenFixture<T>(
    run: (calls: TokenCall[]) => Promise<T>,
  ): Promise<T> {
    const calls: TokenCall[] = []
    const nativeFetch = globalThis.fetch
    const tokenFetch: typeof fetch = Object.assign(
      async (
        input: Parameters<typeof fetch>[0],
        init?: Parameters<typeof fetch>[1],
      ) => {
        const url = input instanceof Request ? input.url : String(input)
        if (url !== TOKEN_URL)
          throw new Error(`unexpected network request: ${url}`)
        calls.push({ url, body: JSON.parse(String(init?.body)) })
        return Response.json({
          access_token: 'synthetic-access',
          refresh_token: 'synthetic-refresh',
          expires_in: 3600,
        })
      },
      { preconnect: nativeFetch.preconnect },
    )
    globalThis.fetch = tokenFetch
    try {
      return await run(calls)
    } finally {
      globalThis.fetch = nativeFetch
    }
  }

  // Mirrors the OpenCode host: start keeps the real authorize() result as
  // pending sign-in state and shows its URL; finish exchanges the pasted
  // code#state against that pending state.
  function signInMenu(
    statusText: (url: string | undefined) => string = () => 'public',
  ) {
    let pending: Awaited<ReturnType<typeof authorize>> | undefined
    const menu = createNativeUi({
      host: 'opencode',
      interactive: true,
      readMode: localCustody,
      disconnectVault: unusedDisconnect,
      dispatch: async (request) => {
        if (request.action === 'add-oauth-start') {
          pending = await authorize('max')
          return {
            ok: true,
            text: `Open this URL in your browser:\n${pending.url}`,
          }
        }
        if (request.action === 'add-oauth-finish' && pending) {
          const result = await exchange(
            request.values.code,
            pending.verifier,
            pending.redirectUri,
            pending.state,
          )
          return result.type === 'success'
            ? { ok: true, text: 'OAuth account added.' }
            : {
                ok: true,
                text: 'OAuth authentication failed. Please check the code and try again.',
              }
        }
        return { ok: false, text: 'unexpected' }
      },
      readStatus: async (_command, context) => {
        const text = statusText(pending?.url)
        context.notify(text, 'info')
        return text
      },
    })
    return { menu, pending: () => pending }
  }

  test('successful start shows the real authorize URL unchanged and finish correlates its state', async () => {
    await withTokenFixture(async (calls) => {
      const notifications: string[] = []
      const session = {
        sessionId: 'oauth-session',
        notify(text: string) {
          notifications.push(text)
        },
      }
      const { menu, pending } = signInMenu((url) =>
        url ? `Pending sign-in: ${url}` : 'No pending sign-in',
      )
      const started = await menu.apply(
        {
          command: 'claude',
          sectionId: 'Accounts',
          actionId: 'add-oauth-start',
          values: {},
        },
        session,
      )
      const auth = pending()
      expect(auth).toBeDefined()
      if (!auth) return
      expect(started.ok).toBe(true)
      expect(started.text).toBe(`Open this URL in your browser:\n${auth.url}`)
      // The same checked link is also its own field, for hosts that show it
      // in a dialog of its own.
      expect((started as { authorizationUrl?: string }).authorizationUrl).toBe(
        auth.url,
      )
      const shown = new URL(started.text.split('\n')[1] ?? '')
      expect(shown.searchParams.get('state')).toBe(auth.state)
      expect(shown.searchParams.get('code_challenge')).toMatch(
        /^[A-Za-z0-9_-]{43}$/,
      )
      // The PKCE verifier stays with the host; only its public challenge shows.
      expect(JSON.stringify({ started, notifications })).not.toContain(
        auth.verifier,
      )
      // Only the result text is exempt: status lines and notifications that
      // quote the same link still have its state masked.
      expect(JSON.stringify(started.menu)).toContain('***REDACTED***')
      expect(JSON.stringify(started.menu)).not.toContain(auth.state)
      expect(notifications.length).toBeGreaterThan(0)
      for (const text of notifications) expect(text).not.toContain(auth.state)

      // A person pastes the code with the state copied from the shown URL.
      const finished = await menu.apply(
        {
          command: 'claude',
          sectionId: 'Accounts',
          actionId: 'add-oauth-finish',
          values: {
            code: `synthetic-code#${shown.searchParams.get('state')}`,
          },
        },
        session,
      )
      expect(finished.text).toBe('OAuth account added.')
      expect(calls).toHaveLength(1)
      expect(calls[0]?.body).toMatchObject({
        code: 'synthetic-code',
        state: auth.state,
        grant_type: 'authorization_code',
        redirect_uri: auth.redirectUri,
        code_verifier: auth.verifier,
      })
    })
  })

  // A menu whose capability answers every action with the given outcome.
  function fixedOutcome(outcome: { ok: boolean; text: string }) {
    let dispatches = 0
    const menu = createNativeUi({
      host: 'opencode',
      interactive: true,
      readMode: localCustody,
      disconnectVault: unusedDisconnect,
      dispatch: async () => {
        dispatches++
        return outcome
      },
      readStatus: async () => 'public',
    })
    return { menu, dispatches: () => dispatches }
  }

  async function startText(
    text: string,
    ok = true,
    actionId: NativeMenuActionId = 'add-oauth-start',
  ): Promise<string> {
    const { menu } = fixedOutcome({ ok, text })
    const result = await menu.apply(
      {
        command: 'claude',
        sectionId: fixtures[actionId][0],
        actionId,
        values: fixtures[actionId][1],
      },
      invocation,
    )
    // Only a link the text shows verbatim may be named as the sign-in link.
    const named = (result as { authorizationUrl?: string }).authorizationUrl
    if (named !== undefined) expect(result.text).toContain(named)
    return result.text
  }

  test('text around a valid link and any changed or untrusted link stay redacted', async () => {
    const auth = await authorize('max')
    const state = auth.state
    const hex = 'a'.repeat(40)
    const around = await startText(
      `Open this URL:\n${auth.url}\nBearer synthetic-bearer sk-ant-synthetic-key ${hex}`,
    )
    expect(around).toBe(
      `Open this URL:\n${auth.url}\n***REDACTED*** ***REDACTED*** ***REDACTED***`,
    )

    const variant = (change: (url: URL) => void) => {
      const url = new URL(auth.url)
      change(url)
      return url.href
    }
    const untrusted = {
      'other host': auth.url.replace(
        'https://claude.com/',
        'https://claude.com.example.invalid/',
      ),
      'plain http': auth.url.replace('https://', 'http://'),
      'explicit port': auth.url.replace(
        'https://claude.com/',
        'https://claude.com:8443/',
      ),
      'embedded credentials': auth.url.replace(
        'https://',
        'https://person:pw@',
      ),
      'other path': auth.url.replace('/cai/oauth/authorize', '/oauth/token'),
      fragment: `${auth.url}#token=synthetic`,
      'extra secret parameter': variant((url) =>
        url.searchParams.set('client_secret', 'synthetic-client-secret'),
      ),
      'duplicate state': variant((url) =>
        url.searchParams.append('state', 'b'.repeat(32)),
      ),
      'reflected callback': variant((url) =>
        url.searchParams.set('redirect_uri', 'https://example.invalid/cb'),
      ),
      'other client': variant((url) =>
        url.searchParams.set('client_id', 'synthetic-client'),
      ),
      'unexpected state shape': variant((url) =>
        url.searchParams.set('state', `${state}${state}`),
      ),
      'missing challenge': variant((url) =>
        url.searchParams.delete('code_challenge'),
      ),
    }
    for (const [name, link] of Object.entries(untrusted)) {
      const text = await startText(`Open this URL:\n${link}`)
      expect({ name, leaked: text.includes(state) }).toEqual({
        name,
        leaked: false,
      })
    }
    // Two different links cannot both be the pending login; neither shows.
    const second = await authorize('max')
    const both = await startText(`${auth.url}\n${second.url}`)
    expect(both).not.toContain(state)
    expect(both).not.toContain(second.state)
  })

  test('a valid link is masked outside a successful checked OAuth start', async () => {
    const auth = await authorize('max')
    const text = `Open this URL in your browser:\n${auth.url}`
    expect(await startText(text, false)).not.toContain(auth.state)
    for (const actionId of ['add-oauth-finish', 'cache-on'] as const)
      expect(await startText(text, true, actionId)).not.toContain(auth.state)

    const { menu, dispatches } = fixedOutcome({ ok: true, text })
    const request = {
      command: 'claude',
      sectionId: 'Accounts',
      actionId: 'add-oauth-start',
    }
    const refusals = [
      // An OAuth start takes no input, so submitted values are refused.
      await menu.apply(
        { ...request, values: { code: 'synthetic-code' } },
        invocation,
      ),
      await menu.apply({ ...request, sessionId: 'other-session' }, invocation),
      await menu.apply({ ...request, actionId: 'add-oauth-begin' }, invocation),
      await menu.apply({ ...request, sectionId: 'Quota' }, invocation),
    ]
    expect(refusals.map((result) => result.code)).toEqual([
      'unknown-parameter',
      'invalid-request',
      'invalid-request',
      'invalid-request',
    ])
    expect(dispatches()).toBe(0)
    for (const refused of refusals)
      expect('authorizationUrl' in refused).toBe(false)
    const headless = createNativeUi({
      host: 'opencode',
      interactive: false,
      readMode: localCustody,
      disconnectVault: unusedDisconnect,
      dispatch: async () => ({ ok: true, text }),
      readStatus: async () => 'public',
    })
    expect((await headless.apply(request, invocation)).code).toBe(
      'interactive-required',
    )
  })
})

const localCustodyIds: readonly NativeMenuActionId[] = [
  'remove',
  'move-up',
  'move-down',
  'enrollment-reset',
  'add-apikey',
  'add-oauth-start',
  'add-oauth-finish',
  'custody-mode',
]
const vaultGuidance =
  'Accounts are managed in the vault. Disconnect from the vault to use local accounts.'
const unknownGuidance =
  'Account custody could not be read, so local account changes are unavailable.'

function offeredIds(
  sections: readonly { actions: readonly { id: string }[] }[],
) {
  return sections.flatMap((section) =>
    section.actions.map((action) => action.id),
  )
}

describe('vault custody', () => {
  for (const host of ['opencode', 'pi'] as const) {
    test(`${host} vault menu removes local-custody actions and shows one guidance line`, async () => {
      const { menu, calls, reads } = setup(
        host,
        true,
        async () => 'claustrum',
        async () => 'disconnected',
      )
      const local = await setup(host).menu.open(invocation)
      const payload = await menu.open(invocation)
      const accounts = payload.menu.sections.find(
        (section) => section.id === 'Accounts',
      )
      expect(accounts?.lines[0]).toBe(vaultGuidance)
      expect(
        payload.menu.sections.flatMap((section) => section.lines),
      ).toContain(vaultGuidance)
      expect(
        payload.menu.sections
          .flatMap((section) => section.lines)
          .filter((line) => line === vaultGuidance),
      ).toHaveLength(1)
      // The guidance is a read-only line, never a selectable item or action.
      expect(accounts?.items).toEqual([])
      expect(accounts?.actions.map((action) => action.id)).toEqual([
        'enable',
        'disable',
        'reset-backoff',
        'vault-disconnect',
      ])
      // Disconnect is confirmed, but marked reversible: connecting again
      // through offline setup undoes it.
      expect(accounts?.actions.at(-1)?.confirm).toEqual({
        message:
          "Disconnect this host from the vault and return to local accounts? The vault keeps this host's enrollment approved until an operator revokes it there.",
        irreversible: false,
      })
      expect(
        offeredIds(payload.menu.sections).filter(
          (id) => id !== 'vault-disconnect',
        ),
      ).toEqual(
        offeredIds(local.menu.sections).filter(
          (id) => !(localCustodyIds as readonly string[]).includes(id),
        ),
      )
      expect(offeredIds(local.menu.sections)).not.toContain('vault-disconnect')
      // Every other section, its status lines and its actions are unchanged.
      expect(payload.menu.sections.slice(1)).toEqual(
        local.menu.sections.slice(1),
      )
      expect(accounts?.lines.slice(1)).toEqual(
        local.menu.sections[0]?.lines ?? [],
      )
      expect(reads).toContain('account:conversation-1')
      expect(calls).toEqual([])
    })
  }

  test('a stale local-custody apply is refused before dispatch and the refreshed menu is the vault menu', async () => {
    let custody: 'local' | 'claustrum' = 'local'
    const { menu, calls, apply } = setup('opencode', true, async () => custody)
    const opened = await menu.open(invocation)
    for (const id of localCustodyIds)
      expect(offeredIds(opened.menu.sections)).toContain(id)
    // The vault is connected after the menu was opened.
    custody = 'claustrum'
    for (const id of localCustodyIds) {
      const result = await apply(id)
      expect(result).toMatchObject({ ok: false, code: 'vault-managed' })
      expect(result.text).toBe(`Action refused: ${vaultGuidance}`)
      expect(result.text).not.toContain('synthetic-key')
      expect(result.text).not.toContain('synthetic-code')
      expect(result.menu?.sections[0]?.lines[0]).toBe(vaultGuidance)
      expect(offeredIds(result.menu?.sections ?? [])).not.toContain(id)
    }
    expect(calls).toEqual([])
    // Retained settings and vault-account controls still dispatch.
    expect((await apply('cache-on')).ok).toBe(true)
    expect((await apply('enable')).ok).toBe(true)
    expect(calls.map((call) => call.action)).toEqual(['cache-on', 'enable'])
  })

  test('local-custody actions return after the vault is disconnected', async () => {
    let custody: 'local' | 'claustrum' = 'claustrum'
    const { menu, calls, apply } = setup('opencode', true, async () => custody)
    expect(
      offeredIds((await menu.open(invocation)).menu.sections),
    ).not.toContain('add-oauth-start')
    expect((await apply('add-oauth-start')).code).toBe('vault-managed')
    custody = 'local'
    const restored = await menu.open(invocation)
    for (const id of localCustodyIds)
      expect(offeredIds(restored.menu.sections)).toContain(id)
    expect(
      restored.menu.sections.flatMap((section) => section.lines),
    ).not.toContain(vaultGuidance)
    expect((await apply('add-oauth-start')).ok).toBe(true)
    expect((await apply('remove')).ok).toBe(true)
    expect(calls.map((call) => call.action)).toEqual([
      'add-oauth-start',
      'remove',
    ])
  })

  test('an unreadable or unknown custody mode never counts as local but still offers disconnect', async () => {
    let disconnects = 0
    const disconnect = async () => {
      disconnects++
      return 'disconnected' as const
    }
    // readMode returns a Promise, so a rejecting reader satisfies its type.
    const rejecting = setup(
      'opencode',
      true,
      async () => {
        throw new Error('sk-ant-synthetic-secret unreadable')
      },
      disconnect,
    )
    // Results outside the declared mode type can only come from an untyped
    // host, so these menus are built through the untyped runtime boundary.
    const malformed = ['vault', 'LOCAL', undefined, null, 1].map((mode) =>
      rawSetup(async () => mode, disconnect),
    )
    for (const [index, { menu, calls, apply }] of [
      rejecting,
      ...malformed,
    ].entries()) {
      const payload = await menu.open(invocation)
      expect(payload.menu.sections[0]?.lines[0]).toBe(unknownGuidance)
      expect(JSON.stringify(payload)).not.toContain('synthetic-secret')
      for (const id of localCustodyIds) {
        expect(offeredIds(payload.menu.sections)).not.toContain(id)
        const result = await apply(id)
        expect(result).toMatchObject({ ok: false, code: 'custody-unavailable' })
        expect(result.text).toBe(`Action refused: ${unknownGuidance}`)
      }
      expect(calls).toEqual([])
      expect((await apply('cache-off')).ok).toBe(true)
      expect(calls.map((call) => call.action)).toEqual(['cache-off'])
      // When the enrollment record cannot be read, disconnecting is the way
      // back to local accounts, so it stays offered and still requires
      // confirmation.
      expect(offeredIds(payload.menu.sections)).toContain('vault-disconnect')
      expect(
        await apply('vault-disconnect', { confirmed: false }),
      ).toMatchObject({ ok: false, code: 'confirmation-required' })
      expect(disconnects).toBe(index)
      expect((await apply('vault-disconnect')).ok).toBe(true)
      expect(disconnects).toBe(index + 1)
    }
  })

  test('a malformed enrollment token offers a confirmed disconnect that returns to local without touching local account files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'native-ui-malformed-token-'))
    try {
      const env = {
        OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE: join(
          root,
          'opencode-enrollment.json',
        ),
      }
      const enrollment = getHostClaustrumEnrollmentPaths('opencode', env)
      const local = await resolveNativePoolPaths(
        join(root, 'anthropic-auth.json'),
        join(root, 'anthropic-auth-state.json'),
      )
      const files = [
        local.legacyConfig,
        local.legacyState,
        local.config,
        local.state,
        local.runtime,
        local.journal,
        local.roster,
      ]
      for (const file of files)
        await writeFile(file, JSON.stringify({ file }), { mode: 0o600 })
      const bytes = () => Promise.all(files.map((file) => readFile(file)))
      const before = await bytes()
      await writeFile(enrollment.tokenPath, 'synthetic-secret-not-json', {
        mode: 0o600,
      })
      const calls: NativeMenuDispatchRequest[] = []
      const menu = createNativeUi({
        host: 'opencode',
        interactive: true,
        readMode: () => readNativeEnrollmentMode('opencode', env),
        // The common-auth helper that deletes this host's enrollment token and
        // ceremony state under the enrollment lock. OpenCode disconnect is
        // only this step: OpenCode keeps no host sign-in to restore.
        disconnectVault: () =>
          disconnectClaustrumEnrollment(enrollment, 'anthropic-auth-opencode'),
        dispatch: async (request) => {
          calls.push(request)
          return { ok: true, text: 'Applied' }
        },
        readStatus: async (command) => `${command}: public status`,
      })
      const opened = await menu.open(invocation)
      expect(opened.menu.sections[0]?.lines[0]).toBe(unknownGuidance)
      expect(offeredIds(opened.menu.sections)).toContain('vault-disconnect')
      expect(offeredIds(opened.menu.sections)).not.toContain('add-apikey')
      expect(JSON.stringify(opened)).not.toContain('synthetic-secret')
      const apply = (patch: Partial<CommandApplyRequest> = {}) =>
        applyFixture(menu, 'vault-disconnect', patch)
      expect(await apply({ confirmed: false })).toMatchObject({
        ok: false,
        code: 'confirmation-required',
      })
      expect(await readFile(enrollment.tokenPath, 'utf8')).toBe(
        'synthetic-secret-not-json',
      )
      const result = await apply()
      expect(result).toMatchObject({
        ok: true,
        text: 'Disconnected from the vault. This host uses local accounts again.',
      })
      expect(await readNativeEnrollmentMode('opencode', env)).toBe('local')
      const ids = offeredIds(result.menu?.sections ?? [])
      for (const id of localCustodyIds) expect(ids).toContain(id)
      expect(ids).not.toContain('vault-disconnect')
      expect(calls).toEqual([])
      expect(await bytes()).toEqual(before)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('the custody reader is required', () => {
    const base = {
      host: 'opencode',
      interactive: true,
      dispatch: async () => ({ ok: true, text: 'Applied' }),
      readStatus: async () => 'public',
    }
    for (const options of [base, { ...base, readMode: 'local' }]) {
      // Invoked through the untyped boundary: these objects do not satisfy
      // NativeUiOptions, which is what a JavaScript host could still pass.
      expect(() => Reflect.apply(createNativeUi, undefined, [options])).toThrow(
        'Native UI requires a custody mode reader',
      )
    }
  })

  const disconnectTexts: Record<
    NativeVaultDisconnectResult,
    { ok: boolean; code?: string; text: string }
  > = {
    disconnected: {
      ok: true,
      text: 'Disconnected from the vault. This host uses local accounts again.',
    },
    idle: {
      ok: true,
      text: 'This host has no active vault enrollment.',
    },
    busy: {
      ok: false,
      code: 'busy',
      text: "Vault disconnect could not finish because another process is changing this host's enrollment. Try again.",
    },
    conflict: {
      ok: false,
      code: 'conflict',
      text: 'Disconnect stopped: this host already has a different stored sign-in, so it and the sign-in saved when the host joined the vault were both kept, and the vault connection remains. Resolve the two sign-ins with offline setup.',
    },
  }

  for (const host of ['opencode', 'pi'] as const) {
    test(`${host} confirmed vault disconnect runs only the disconnect capability and reports each result`, async () => {
      for (const [result, expected] of Object.entries(disconnectTexts)) {
        let custody: 'local' | 'claustrum' = 'claustrum'
        let disconnects = 0
        const { menu, calls, apply } = setup(
          host,
          true,
          async () => custody,
          async () => {
            disconnects++
            // A real disconnect makes the custody reader report local, so
            // local accounts are in use again.
            if (result === 'disconnected') custody = 'local'
            return result as NativeVaultDisconnectResult
          },
        )
        await menu.open(invocation)
        const unconfirmed = await apply('vault-disconnect', {
          confirmed: false,
        })
        expect(unconfirmed).toMatchObject({
          ok: false,
          code: 'confirmation-required',
          needsConfirmation: true,
        })
        expect(disconnects).toBe(0)
        const applied = await apply('vault-disconnect')
        expect({
          ok: applied.ok,
          text: applied.text,
          ...(applied.code !== undefined ? { code: applied.code } : {}),
        }).toEqual(expected)
        expect(disconnects).toBe(1)
        expect(calls).toEqual([])
        // The menu returned with the result reads the custody mode again
        // after the disconnect ran.
        const ids = offeredIds(applied.menu?.sections ?? [])
        if (result === 'disconnected') {
          expect(ids).not.toContain('vault-disconnect')
          for (const id of localCustodyIds) expect(ids).toContain(id)
        } else {
          expect(ids).toContain('vault-disconnect')
          expect(ids).not.toContain('add-apikey')
        }
      }
    })
  }

  test('a stale or headless disconnect is refused before the capability runs', async () => {
    let custody: 'local' | 'claustrum' = 'claustrum'
    let disconnects = 0
    const disconnect = async () => {
      disconnects++
      return 'disconnected' as const
    }
    const { menu, apply } = setup(
      'opencode',
      true,
      async () => custody,
      disconnect,
    )
    expect(offeredIds((await menu.open(invocation)).menu.sections)).toContain(
      'vault-disconnect',
    )
    // The host's custody changed to local after this menu was opened.
    custody = 'local'
    const stale = await apply('vault-disconnect')
    expect(stale).toMatchObject({
      ok: false,
      code: 'vault-not-connected',
      text: 'Action refused: this host is not connected to the vault.',
    })
    const headless = setup(
      'opencode',
      false,
      async () => 'claustrum',
      disconnect,
    )
    expect((await headless.apply('vault-disconnect')).code).toBe(
      'interactive-required',
    )
    expect(disconnects).toBe(0)
  })

  test('the vault disconnect callback is required', () => {
    const base = {
      host: 'pi',
      interactive: true,
      readMode: async () => 'claustrum',
      dispatch: async () => ({ ok: true, text: 'Applied' }),
      readStatus: async () => 'public',
    }
    for (const options of [
      base,
      { ...base, disconnectVault: undefined },
      { ...base, disconnectVault: 'disconnect' },
    ]) {
      // Invoked through the untyped boundary: these objects do not satisfy
      // NativeUiOptions, which is what a JavaScript host could still pass.
      expect(() => Reflect.apply(createNativeUi, undefined, [options])).toThrow(
        'Native UI requires a vault disconnect callback',
      )
    }
  })

  for (const kind of ['unsafe-file', 'wrong-consumer'] as const) {
    test(`disconnect explains ${kind} from the locked helper and preserves enrollment`, async () => {
      const root = await mkdtemp(
        join(tmpdir(), 'native-ui-disconnect-refusal-'),
      )
      try {
        const env = {
          OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE: join(
            root,
            'enrollment.json',
          ),
        }
        const enrollment = getHostClaustrumEnrollmentPaths('opencode', env)
        await writeFile(enrollment.tokenPath, 'synthetic-secret-token', {
          mode: 0o600,
        })
        await writeFile(
          enrollment.statePath,
          JSON.stringify({
            version: 1,
            phase: 'approved',
            proposedName: 'another-consumer',
            tokenGeneration: 1,
            updatedAt: 1,
          }),
          { mode: 0o600 },
        )
        if (kind === 'unsafe-file') await chmod(enrollment.statePath, 0o644)
        const files = [enrollment.tokenPath, enrollment.statePath]
        const before = await Promise.all(files.map((path) => readFile(path)))
        const { apply } = setup(
          'opencode',
          true,
          async () => {
            throw new Error('synthetic-secret')
          },
          () => disconnectNativeVaultForHost({ host: 'opencode', env }),
        )
        const result = await apply('vault-disconnect')
        expect(result).toMatchObject({
          ok: false,
          code: `disconnect-${kind}`,
          text:
            kind === 'unsafe-file'
              ? 'OpenCode could not disconnect from the vault. Check file ownership, private permissions, and safe storage. Then try Disconnect again. Do not delete enrollment files by hand.'
              : 'OpenCode could not disconnect from the vault. The enrollment belongs to another host or plugin. Check this host’s enrollment path. Then try Disconnect again. Do not delete another host’s enrollment.',
        })
        expect(JSON.stringify(result)).not.toContain('synthetic-secret')
        expect(await Promise.all(files.map((path) => readFile(path)))).toEqual(
          before,
        )
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    })
  }

  test('Pi disconnect maps closed slot refusals without reading raw text or accessors', async () => {
    const cases = [
      ['unsafe-path', 'disconnect-unsafe-file', 'Check file ownership'],
      [
        'invalid-auth',
        'disconnect-pi-recovery',
        'Repair the Pi sign-in and its private recovery copy',
      ],
      [
        'invalid-stash',
        'disconnect-pi-recovery',
        'Repair the Pi sign-in and its private recovery copy',
      ],
      [
        'missing-stash',
        'disconnect-pi-recovery',
        'Repair the Pi sign-in and its private recovery copy',
      ],
      [
        'conflict',
        'disconnect-conflict',
        'Resolve the stored Pi sign-in and its private recovery copy',
      ],
      [
        'lock-timeout',
        'disconnect-busy',
        'Stop other setup or disconnect attempts',
      ],
      [
        'lock-compromised',
        'disconnect-busy',
        'Stop other setup or disconnect attempts',
      ],
      ['io', 'disconnect-io', 'Check file access and free disk space'],
    ]
    let reads = 0
    for (const [code, expectedCode, recovery] of cases) {
      const error = Object.assign(new Error('synthetic-secret'), {
        name: 'PiSlotError',
        code,
      })
      Object.defineProperty(error, 'message', {
        get() {
          reads++
          throw new Error('not safe')
        },
      })
      const { apply } = setup(
        'pi',
        true,
        async () => 'claustrum',
        async () => {
          throw error
        },
      )
      const result = await apply('vault-disconnect')
      expect(result.code).toBe(expectedCode)
      expect(result.text).toStartWith('Pi could not disconnect from the vault.')
      expect(result.text).toContain(recovery!)
      expect(JSON.stringify(result)).not.toContain('synthetic-secret')
    }
    expect(reads).toBe(0)
  })

  test('a failing disconnect capability gives safe recovery for an unknown failure', async () => {
    const { apply } = setup(
      'pi',
      true,
      async () => 'claustrum',
      async () => {
        throw new Error('sk-ant-synthetic-secret refused')
      },
    )
    const result = await apply('vault-disconnect')
    expect(result).toMatchObject({
      ok: false,
      code: 'execution-failed',
      text: 'Pi could not disconnect from the vault. Check this host’s vault connection and file access. Then try Disconnect again.',
    })
    expect(JSON.stringify(result)).not.toContain('synthetic-secret')
  })
})
