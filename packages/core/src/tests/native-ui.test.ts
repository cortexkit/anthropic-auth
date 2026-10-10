import { describe, expect, test } from 'bun:test'
import type {
  CommandApplyRequest,
  KnobValues,
} from '@cortexkit/common-auth/commands'
import { authorize, exchange } from '../auth.ts'
import { TOKEN_URL } from '../constants.ts'
import type { NativeMenuDispatchRequest } from '../native-menu-executor.ts'
import type {
  NativeMenuActionId,
  NativeMenuGroupId,
} from '../native-menu-model.ts'
import { createNativeUi, runPiCommandMenu } from '../native-ui.ts'

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
  'quota-refresh': ['Quota', {}],
  'routing-mode': ['Routing', { mode: 'sticky-balanced' }],
  'routing-reset': ['Routing', {}],
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
const piUnavailable = [
  'quota-refresh',
  'killswitch-on',
  'killswitch-off',
  'killswitch-set',
  'prime-on',
  'prime-off',
  'start-fire',
]

function setup(host: 'opencode' | 'pi' = 'opencode', interactive = true) {
  const calls: NativeMenuDispatchRequest[] = []
  const reads: string[] = []
  const menu = createNativeUi({
    host,
    interactive,
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
  ) =>
    menu.apply(
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
  return { menu, calls, reads, apply }
}

describe('native UI contract', () => {
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
          (id) => host === 'opencode' || !piUnavailable.includes(id),
        ),
      )
      const actions = payload.menu.sections.flatMap(
        (section) => section.actions,
      )
      const api = actions.find((action) => action.id === 'add-apikey')
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
    const headless = createNativeUi({
      host: 'opencode',
      interactive: false,
      dispatch: async () => ({ ok: true, text }),
      readStatus: async () => 'public',
    })
    expect((await headless.apply(request, invocation)).code).toBe(
      'interactive-required',
    )
  })
})
