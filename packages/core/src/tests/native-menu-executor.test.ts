import { expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { projectVaultRoster } from '@cortexkit/common-auth/claustrum'
import type { KnobValue } from '@cortexkit/common-auth/commands'
import { moduleReferences } from '../../scripts/check-native-type-closure.ts'
import { isValidApiBaseURL } from '../accounts.ts'
import { parseCacheKeepCommandAction } from '../cachekeep.ts'
import { parseKillswitchCommandAction } from '../killswitch.ts'
import {
  createNativeMenuExecutor,
  type NativeMenuActionValues,
  type NativeMenuCapabilityOutcome,
  type NativeMenuDispatch,
  type NativeMenuDispatchActionId,
  type NativeMenuDispatchOptions,
  type NativeMenuDispatchRequest,
  type NativeMenuDispatchValues,
  type NativeMenuExecutionContext,
  type NativeMenuExecutionResult,
  type NativeMenuExecutorOptions,
  type NativeMenuRequest,
} from '../native-menu-executor.ts'
import {
  getNativeMenuModel,
  type NativeMenuActionId,
  type NativeMenuHost,
} from '../native-menu-model.ts'

type Assert<T extends true> = T
type Equal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
type Assignable<A, B> = [A] extends [B] ? true : false
type RequestFor<Id extends NativeMenuActionId> = Extract<
  NativeMenuRequest,
  { action: Id }
>

// Compile-time contracts. Each refused shape sits next to an accepted
// companion, so a refusal cannot pass merely because the whole type collapsed.
type NarrowDispatch = (
  request: Extract<NativeMenuDispatchRequest, { action: 'enable' }>,
  options: NativeMenuDispatchOptions,
) => Promise<NativeMenuCapabilityOutcome>
type FullDispatch = (
  request: NativeMenuDispatchRequest,
  options: NativeMenuDispatchOptions,
) => Promise<NativeMenuCapabilityOutcome>
const typeContracts: [
  Assert<Equal<NativeMenuRequest['action'], NativeMenuActionId>>,
  Assert<
    Equal<
      NativeMenuDispatchRequest['action'],
      Exclude<NativeMenuActionId, 'custody-mode'>
    >
  >,
  Assert<Equal<keyof NativeMenuActionValues, NativeMenuActionId>>,
  // A callback written for one action cannot stand in for the full capability.
  Assert<Equal<Assignable<NarrowDispatch, NativeMenuDispatch>, false>>,
  Assert<Equal<Assignable<FullDispatch, NativeMenuDispatch>, true>>,
  // The capability is a required function property, not an optional one.
  Assert<
    Equal<
      Record<never, never> extends Pick<NativeMenuExecutorOptions, 'dispatch'>
        ? true
        : false,
      false
    >
  >,
  Assert<
    Equal<
      Assignable<
        { action: 'enable'; values: { mode: 'local' } },
        NativeMenuRequest
      >,
      false
    >
  >,
  Assert<
    Equal<
      Assignable<
        { action: 'enable'; values: { id: string } },
        NativeMenuRequest
      >,
      true
    >
  >,
  Assert<Equal<Assignable<{ action: 'enable' }, NativeMenuRequest>, false>>,
  Assert<
    Equal<
      Assignable<
        { action: 'cache-on'; values: { id: string } },
        NativeMenuRequest
      >,
      false
    >
  >,
  Assert<Equal<Assignable<{ action: 'cache-on' }, NativeMenuRequest>, true>>,
  Assert<
    Equal<
      Assignable<
        { action: 'routing-mode'; values: { mode: 'hybrid' } },
        NativeMenuRequest
      >,
      false
    >
  >,
  Assert<
    Equal<
      Assignable<
        { action: 'routing-mode'; values: { mode: 'sticky-balanced' } },
        NativeMenuRequest
      >,
      true
    >
  >,
  Assert<Equal<Assignable<{ action: 'quota' }, NativeMenuRequest>, false>>,
  Assert<
    Equal<
      Assignable<
        {
          action: 'cachekeep-window'
          values: { startHour: string; endHour: number }
        },
        NativeMenuRequest
      >,
      false
    >
  >,
  // The optional model-scoped remaining-percent threshold stays part of the
  // typed killswitch entry.
  Assert<
    Equal<
      Assignable<
        {
          action: 'killswitch-set'
          values: {
            entries: {
              account: string
              fh: number
              sd: number
              scoped: number
            }[]
          }
        },
        NativeMenuRequest
      >,
      true
    >
  >,
  Assert<
    Equal<
      Assignable<
        {
          action: 'killswitch-set'
          values: { entries: { account: string; fh: number }[] }
        },
        NativeMenuRequest
      >,
      false
    >
  >,
  // The optional API-key account label may arrive as null (an input left
  // empty) but is omitted from the checked request, which never carries null.
  Assert<
    Equal<
      Assignable<
        { action: 'add-apikey'; values: { apiKey: string; label: null } },
        NativeMenuRequest
      >,
      true
    >
  >,
  Assert<
    Equal<
      Assignable<
        { action: 'add-apikey'; values: { apiKey: string; label: null } },
        NativeMenuDispatchRequest
      >,
      false
    >
  >,
  Assert<
    Equal<
      Assignable<
        { action: 'custody-mode'; values: { mode: 'local' } },
        NativeMenuDispatchRequest
      >,
      false
    >
  >,
  Assert<
    Equal<
      Assignable<
        { action: 'routing-reset'; values: Record<never, never> },
        NativeMenuDispatchRequest
      >,
      false
    >
  >,
  Assert<
    Equal<
      Assignable<
        {
          action: 'routing-reset'
          values: Record<never, never>
          sessionId: string
        },
        NativeMenuDispatchRequest
      >,
      true
    >
  >,
  Assert<
    Equal<
      Assignable<
        { action: 'enable'; values: { id: string }; sessionId: string },
        NativeMenuDispatchRequest
      >,
      false
    >
  >,
  // The compile-time checked input types stay within the value types the
  // shared UI sends for an input (its KnobValue projection).
  Assert<
    Assignable<
      Exclude<
        NativeMenuActionValues['add-apikey'][keyof NativeMenuActionValues['add-apikey']],
        undefined
      >,
      KnobValue
    >
  >,
] = [
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
]

const samples: { [Id in NativeMenuActionId]: RequestFor<Id> } = {
  enable: { action: 'enable', values: { id: 'work-alt' } },
  disable: { action: 'disable', values: { id: 'work alt' } },
  remove: { action: 'remove', values: { id: 'acct-3' } },
  'move-up': { action: 'move-up', values: { id: 'acct-4' } },
  'move-down': { action: 'move-down', values: { id: 'acct-5' } },
  'reset-backoff': { action: 'reset-backoff' },
  'enrollment-reset': { action: 'enrollment-reset', values: {} },
  'add-apikey': {
    action: 'add-apikey',
    values: {
      apiKey: 'sk-sample-key',
      label: ' Spare ',
      baseURL: 'https://api.example.test/claude',
      authHeader: 'x-api-key',
    },
  },
  'add-oauth-start': { action: 'add-oauth-start' },
  'add-oauth-finish': {
    action: 'add-oauth-finish',
    values: { code: 'abc#state', label: 'Second' },
  },
  'custody-mode': { action: 'custody-mode', values: { mode: 'claustrum' } },
  'quota-refresh': { action: 'quota-refresh' },
  'routing-mode': {
    action: 'routing-mode',
    values: { mode: 'fallback-first' },
  },
  'routing-reset': { action: 'routing-reset' },
  'killswitch-on': { action: 'killswitch-on' },
  'killswitch-off': { action: 'killswitch-off' },
  'killswitch-set': {
    action: 'killswitch-set',
    values: {
      entries: [
        { account: 'main', fh: 3, sd: 8, scoped: 0 },
        { account: 'work-alt', fh: 5, sd: 10 },
      ],
    },
  },
  'cache-on': { action: 'cache-on' },
  'cache-off': { action: 'cache-off' },
  'cache-mode': { action: 'cache-mode', values: { mode: 'hybrid' } },
  'cachekeep-always': { action: 'cachekeep-always' },
  'cachekeep-off': { action: 'cachekeep-off' },
  'cachekeep-window': {
    action: 'cachekeep-window',
    values: { startHour: 22, endHour: 6 },
  },
  'cachekeep-subagents': {
    action: 'cachekeep-subagents',
    values: { enabled: 'off' },
  },
  'dump-on': { action: 'dump-on' },
  'dump-off': { action: 'dump-off' },
  'logging-level': { action: 'logging-level', values: { level: 'trace' } },
  'fast-on': { action: 'fast-on' },
  'fast-off': { action: 'fast-off' },
  'prime-on': { action: 'prime-on' },
  'prime-off': { action: 'prime-off' },
  'start-fire': { action: 'start-fire' },
}

const expectedValues: {
  [Id in NativeMenuDispatchActionId]: NativeMenuDispatchValues<Id>
} = {
  enable: { id: 'work-alt' },
  disable: { id: 'work alt' },
  remove: { id: 'acct-3' },
  'move-up': { id: 'acct-4' },
  'move-down': { id: 'acct-5' },
  'reset-backoff': {},
  'enrollment-reset': {},
  'add-apikey': {
    apiKey: 'sk-sample-key',
    label: ' Spare ',
    baseURL: 'https://api.example.test/claude',
    authHeader: 'x-api-key',
  },
  'add-oauth-start': {},
  'add-oauth-finish': { code: 'abc#state', label: 'Second' },
  'quota-refresh': {},
  'routing-mode': { mode: 'fallback-first' },
  'routing-reset': {},
  'killswitch-on': {},
  'killswitch-off': {},
  'killswitch-set': {
    entries: [
      { account: 'main', fh: 3, sd: 8, scoped: 0 },
      { account: 'work-alt', fh: 5, sd: 10 },
    ],
  },
  'cache-on': {},
  'cache-off': {},
  'cache-mode': { mode: 'hybrid' },
  'cachekeep-always': {},
  'cachekeep-off': {},
  'cachekeep-window': { startHour: 22, endHour: 6 },
  'cachekeep-subagents': { enabled: 'off' },
  'dump-on': {},
  'dump-off': {},
  'logging-level': { level: 'trace' },
  'fast-on': {},
  'fast-off': {},
  'prime-on': {},
  'prime-off': {},
  'start-fire': {},
}

const SESSION_ACTIONS: readonly NativeMenuActionId[] = [
  'routing-reset',
  'start-fire',
  'add-oauth-start',
  'add-oauth-finish',
]
const full: NativeMenuExecutionContext = {
  interactive: true,
  confirmed: true,
  sessionId: 'session-1',
}

function harness(
  host: NativeMenuHost = 'opencode',
  outcome: NativeMenuCapabilityOutcome = { ok: true, text: 'done' },
) {
  const calls: [NativeMenuDispatchRequest, NativeMenuDispatchOptions][] = []
  const dispatch: NativeMenuDispatch = async (request, options) => {
    calls.push([request, options])
    return outcome
  }
  return { calls, executor: createNativeMenuExecutor({ host, dispatch }) }
}

function hostActionIds(host: NativeMenuHost): NativeMenuActionId[] {
  return getNativeMenuModel(host).groups.flatMap((group) =>
    group.actions.map((action) => action.id),
  )
}

// Untyped entry point for malformed runtime input a menu could still send.
function executeRaw(
  executor: ReturnType<typeof createNativeMenuExecutor>,
  request: unknown,
  context: unknown = full,
): Promise<NativeMenuExecutionResult> {
  return Reflect.apply(executor.execute, undefined, [request, context])
}

function trappedProxy<T extends object>(target: T, log: string[]): T {
  const handler: ProxyHandler<T> = {}
  for (const trap of [
    'get',
    'has',
    'ownKeys',
    'getOwnPropertyDescriptor',
    'getPrototypeOf',
    'defineProperty',
    'set',
    'apply',
  ] as const) {
    ;(handler as Record<string, unknown>)[trap] = (...args: unknown[]) => {
      log.push(trap)
      return Reflect.apply(
        Reflect[trap] as (...input: unknown[]) => unknown,
        undefined,
        args,
      )
    }
  }
  return new Proxy(target, handler)
}

test('type contracts hold at compile time', () => {
  expect(typeContracts.every(Boolean)).toBe(true)
})

test('every available action reaches the capability with exactly the checked values', async () => {
  expect(Object.keys(samples).sort()).toEqual(hostActionIds('opencode').sort())
  for (const host of ['opencode', 'pi'] as const) {
    for (const id of hostActionIds(host)) {
      if (id === 'custody-mode') continue
      const { calls, executor } = harness(host)
      const result = await executor.execute(samples[id], full)
      expect(result).toEqual({
        status: 'executed',
        action: id,
        ok: true,
        text: 'done',
      })
      expect(calls).toHaveLength(1)
      const [request, options] = calls[0] ?? []
      const expected = SESSION_ACTIONS.includes(id)
        ? { action: id, values: expectedValues[id], sessionId: 'session-1' }
        : { action: id, values: expectedValues[id] }
      expect(request).toEqual(expected as NativeMenuDispatchRequest)
      expect(Object.keys(request ?? {}).sort()).toEqual(
        Object.keys(expected).sort(),
      )
      expect(Object.isFrozen(request)).toBe(true)
      expect(Object.isFrozen(request?.values)).toBe(true)
      expect(options).toEqual({})
    }
  }
})

test('dispatched requests are fresh copies, not the caller objects', async () => {
  const { calls, executor } = harness()
  const entries = [{ account: 'main', fh: 1, sd: 2, scoped: 3 }]
  await executor.execute(
    { action: 'killswitch-set', values: { entries } },
    full,
  )
  const sent = calls[0]?.[0]
  expect(sent?.action).toBe('killswitch-set')
  if (sent?.action !== 'killswitch-set') return
  expect(sent.values.entries).not.toBe(entries)
  expect(sent.values.entries[0]).not.toBe(entries[0])
  expect(Object.isFrozen(sent.values.entries)).toBe(true)
  expect(Object.isFrozen(sent.values.entries[0])).toBe(true)
  entries[0] = { account: 'other', fh: 9, sd: 9, scoped: 9 }
  expect(sent.values.entries).toEqual([
    { account: 'main', fh: 1, sd: 2, scoped: 3 },
  ])
})

test('actions the host does not offer and unknown actions are refused', async () => {
  const unavailable = hostActionIds('opencode').filter(
    (id) => !hostActionIds('pi').includes(id),
  )
  expect(unavailable.sort()).toEqual(
    (
      [
        'quota-refresh',
        'killswitch-on',
        'killswitch-off',
        'killswitch-set',
        'prime-on',
        'prime-off',
        'start-fire',
      ] satisfies NativeMenuActionId[]
    ).sort(),
  )
  const { calls, executor } = harness('pi')
  for (const id of unavailable) {
    expect(await executor.execute(samples[id], full)).toEqual({
      status: 'refused',
      code: 'unsupported-action',
    })
  }
  for (const action of [
    'nope',
    'status',
    'constructor',
    '__proto__',
    'toString',
  ]) {
    expect(await executeRaw(executor, { action })).toEqual({
      status: 'refused',
      code: 'unsupported-action',
    })
  }
  expect(await executeRaw(executor, { action: 7 })).toEqual({
    status: 'refused',
    code: 'invalid-request',
  })
  expect(calls).toHaveLength(0)
  // The healthy companion: the same executor still serves an available action.
  expect((await executor.execute(samples['dump-on'], full)).status).toBe(
    'executed',
  )
})

test('custody setup is offline guidance only and never dispatches', async () => {
  const { calls, executor } = harness()
  const model = getNativeMenuModel('opencode')
    .groups.flatMap((group) => group.actions)
    .find((action) => action.id === 'custody-mode')
  if (model?.kind !== 'setup-guidance')
    throw new Error('custody metadata missing')
  for (const mode of ['local', 'claustrum'] as const) {
    const result = await executor.execute(
      { action: 'custody-mode', values: { mode } },
      { interactive: true },
    )
    expect(result).toEqual({
      status: 'guidance',
      action: 'custody-mode',
      mode,
      instructions: model.setupInstructions,
    })
    if (result.status === 'guidance')
      expect(result.instructions).toBe(model.setupInstructions)
  }
  expect(
    await executor.execute(samples['custody-mode'], { interactive: false }),
  ).toEqual({
    status: 'refused',
    code: 'offline-required',
    action: 'custody-mode',
  })
  expect(
    await executeRaw(executor, {
      action: 'custody-mode',
      values: { mode: 'remote' },
    }),
  ).toEqual({
    status: 'refused',
    code: 'invalid-parameter',
    action: 'custody-mode',
    parameter: 'mode',
  })
  expect(calls).toHaveLength(0)
})

test('interactive-only actions are refused in headless contexts', async () => {
  const { calls, executor } = harness()
  for (const id of [
    'add-apikey',
    'add-oauth-start',
    'add-oauth-finish',
  ] as const) {
    expect(
      await executor.execute(samples[id], { ...full, interactive: false }),
    ).toEqual({ status: 'refused', code: 'interactive-required', action: id })
  }
  expect(calls).toHaveLength(0)
  expect(
    (await executor.execute(samples.enable, { interactive: false })).status,
  ).toBe('executed')
})

test('destructive actions require explicit confirmation', async () => {
  const { calls, executor } = harness()
  for (const id of ['remove', 'enrollment-reset'] as const) {
    for (const context of [
      { interactive: true },
      { interactive: true, confirmed: false },
    ]) {
      expect(await executor.execute(samples[id], context)).toEqual({
        status: 'refused',
        code: 'confirmation-required',
        action: id,
      })
    }
  }
  expect(calls).toHaveLength(0)
  expect((await executor.execute(samples.remove, full)).status).toBe('executed')
  expect(
    (await executor.execute(samples.enable, { interactive: true })).status,
  ).toBe('executed')
})

test('session-dependent actions require a session identifier', async () => {
  const { calls, executor } = harness()
  for (const id of SESSION_ACTIONS) {
    for (const sessionId of [undefined, '', '   ']) {
      const context =
        sessionId === undefined
          ? { interactive: true }
          : { interactive: true, sessionId }
      expect(await executor.execute(samples[id], context)).toEqual({
        status: 'refused',
        code: 'session-required',
        action: id,
      })
    }
  }
  expect(calls).toHaveLength(0)
  expect(
    (await executor.execute(samples['quota-refresh'], { interactive: true }))
      .status,
  ).toBe('executed')
})

test('a signal aborted before dispatch does no work', async () => {
  const { calls, executor } = harness()
  const controller = new AbortController()
  controller.abort()
  expect(
    await executor.execute(samples['prime-on'], {
      ...full,
      signal: controller.signal,
    }),
  ).toEqual({ status: 'refused', code: 'aborted', action: 'prime-on' })
  expect(
    await executor.execute(samples['custody-mode'], {
      interactive: true,
      signal: controller.signal,
    }),
  ).toEqual({ status: 'refused', code: 'aborted', action: 'custody-mode' })
  expect(calls).toHaveLength(0)
})

test('an abort after dispatch begins reports what the capability did', async () => {
  const controller = new AbortController()
  let seen: AbortSignal | undefined
  const executor = createNativeMenuExecutor({
    host: 'opencode',
    dispatch: async (_request, options) => {
      seen = options.signal
      controller.abort()
      return { ok: true, text: 'Prime enabled' }
    },
  })
  expect(
    await executor.execute(samples['prime-on'], {
      ...full,
      signal: controller.signal,
    }),
  ).toEqual({
    status: 'executed',
    action: 'prime-on',
    ok: true,
    text: 'Prime enabled',
  })
  expect(seen).toBe(controller.signal)
})

// A hole at index 0: the array reports length 2 but owns only index 1.
const sparseEntries: unknown[] = []
sparseEntries[1] = { account: 'main', fh: 1, sd: 2 }

type Rejection = readonly [
  label: string,
  request: unknown,
  code: string,
  parameter?: string,
]
const rejections: readonly Rejection[] = [
  [
    'missing account id',
    { action: 'enable', values: {} },
    'missing-parameter',
    'id',
  ],
  ['missing values', { action: 'enable' }, 'missing-parameter', 'id'],
  [
    'null account id',
    { action: 'enable', values: { id: null } },
    'missing-parameter',
    'id',
  ],
  [
    'blank account id',
    { action: 'enable', values: { id: '  ' } },
    'missing-parameter',
    'id',
  ],
  [
    'numeric account id',
    { action: 'enable', values: { id: 4 } },
    'invalid-parameter',
    'id',
  ],
  [
    'unknown parameter',
    { action: 'enable', values: { id: 'a', extra: 1 } },
    'unknown-parameter',
  ],
  [
    'parameter on a no-input action',
    { action: 'cache-on', values: { id: 'a' } },
    'unknown-parameter',
  ],
  [
    'api-key primary flag',
    { action: 'add-apikey', values: { apiKey: 'k', primary: true } },
    'unknown-parameter',
  ],
  [
    'missing api key',
    { action: 'add-apikey', values: { label: 'x' } },
    'missing-parameter',
    'apiKey',
  ],
  [
    'api key with whitespace',
    { action: 'add-apikey', values: { apiKey: 'sk-a b' } },
    'invalid-parameter',
    'apiKey',
  ],
  [
    'api key with line break',
    { action: 'add-apikey', values: { apiKey: 'sk-ab\n' } },
    'invalid-parameter',
    'apiKey',
  ],
  [
    'ftp base URL',
    { action: 'add-apikey', values: { apiKey: 'k', baseURL: 'ftp://x.test' } },
    'invalid-parameter',
    'baseURL',
  ],
  [
    'base URL with credentials',
    {
      action: 'add-apikey',
      values: { apiKey: 'k', baseURL: 'https://u:p@x.test' },
    },
    'invalid-parameter',
    'baseURL',
  ],
  [
    'unparseable base URL',
    { action: 'add-apikey', values: { apiKey: 'k', baseURL: 'not a url' } },
    'invalid-parameter',
    'baseURL',
  ],
  [
    'unknown auth header',
    { action: 'add-apikey', values: { apiKey: 'k', authHeader: 'cookie' } },
    'invalid-parameter',
    'authHeader',
  ],
  [
    'numeric label',
    { action: 'add-apikey', values: { apiKey: 'k', label: 3 } },
    'invalid-parameter',
    'label',
  ],
  [
    'missing oauth code',
    { action: 'add-oauth-finish', values: { code: ' ' } },
    'missing-parameter',
    'code',
  ],
  [
    'routing mode case',
    { action: 'routing-mode', values: { mode: 'Main-First' } },
    'invalid-parameter',
    'mode',
  ],
  [
    'cache mode from routing',
    { action: 'cache-mode', values: { mode: 'main-first' } },
    'invalid-parameter',
    'mode',
  ],
  [
    'logging level',
    { action: 'logging-level', values: { level: 'verbose' } },
    'invalid-parameter',
    'level',
  ],
  [
    'subagents boolean',
    { action: 'cachekeep-subagents', values: { enabled: true } },
    'invalid-parameter',
    'enabled',
  ],
  [
    'missing hour',
    { action: 'cachekeep-window', values: { startHour: 1 } },
    'missing-parameter',
    'endHour',
  ],
  [
    'hour above 23',
    { action: 'cachekeep-window', values: { startHour: 1, endHour: 24 } },
    'invalid-parameter',
    'endHour',
  ],
  [
    'negative hour',
    { action: 'cachekeep-window', values: { startHour: -1, endHour: 4 } },
    'invalid-parameter',
    'startHour',
  ],
  [
    'fractional hour',
    { action: 'cachekeep-window', values: { startHour: 1.5, endHour: 4 } },
    'invalid-parameter',
    'startHour',
  ],
  [
    'negative zero hour',
    { action: 'cachekeep-window', values: { startHour: -0, endHour: 4 } },
    'invalid-parameter',
    'startHour',
  ],
  [
    'string hour',
    { action: 'cachekeep-window', values: { startHour: '3', endHour: 4 } },
    'invalid-parameter',
    'startHour',
  ],
  [
    'NaN hour',
    {
      action: 'cachekeep-window',
      values: { startHour: Number.NaN, endHour: 4 },
    },
    'invalid-parameter',
    'startHour',
  ],
  [
    'empty window',
    { action: 'cachekeep-window', values: { startHour: 5, endHour: 5 } },
    'invalid-parameter',
    'endHour',
  ],
  [
    'entries missing',
    { action: 'killswitch-set', values: {} },
    'missing-parameter',
    'entries',
  ],
  [
    'entries empty',
    { action: 'killswitch-set', values: { entries: [] } },
    'invalid-parameter',
    'entries',
  ],
  [
    'entries as text',
    { action: 'killswitch-set', values: { entries: 'main:3,8' } },
    'invalid-parameter',
    'entries',
  ],
  [
    'entry account blank',
    {
      action: 'killswitch-set',
      values: { entries: [{ account: ' \t', fh: 1, sd: 2 }] },
    },
    'invalid-parameter',
    'entries',
  ],
  [
    'entry account empty',
    {
      action: 'killswitch-set',
      values: { entries: [{ account: '', fh: 1, sd: 2 }] },
    },
    'invalid-parameter',
    'entries',
  ],
  [
    'entry negative threshold',
    {
      action: 'killswitch-set',
      values: { entries: [{ account: 'main', fh: -1, sd: 2 }] },
    },
    'invalid-parameter',
    'entries',
  ],
  [
    'entry fractional threshold',
    {
      action: 'killswitch-set',
      values: { entries: [{ account: 'main', fh: 1, sd: 2.5 }] },
    },
    'invalid-parameter',
    'entries',
  ],
  [
    'entry unsafe threshold',
    {
      action: 'killswitch-set',
      values: { entries: [{ account: 'main', fh: 2 ** 53, sd: 2 }] },
    },
    'invalid-parameter',
    'entries',
  ],
  [
    'entry null scoped',
    {
      action: 'killswitch-set',
      values: { entries: [{ account: 'main', fh: 1, sd: 2, scoped: null }] },
    },
    'invalid-parameter',
    'entries',
  ],
  [
    'entry missing sd',
    {
      action: 'killswitch-set',
      values: { entries: [{ account: 'main', fh: 1 }] },
    },
    'invalid-parameter',
    'entries',
  ],
  [
    'entry extra field',
    {
      action: 'killswitch-set',
      values: { entries: [{ account: 'main', fh: 1, sd: 2, model: 'x' }] },
    },
    'invalid-parameter',
    'entries',
  ],
  [
    'sparse entries',
    {
      action: 'killswitch-set',
      values: { entries: sparseEntries },
    },
    'invalid-parameter',
    'entries',
  ],
]

test('parameter values are checked against the domain rules', async () => {
  const { calls, executor } = harness()
  for (const [label, request, code, parameter] of rejections) {
    const result = await executeRaw(executor, request)
    const action = (request as { action: NativeMenuActionId }).action
    expect({ label, result }).toEqual({
      label,
      result: {
        status: 'refused',
        code,
        action,
        ...(parameter !== undefined ? { parameter } : {}),
      } as NativeMenuExecutionResult,
    })
  }
  expect(calls).toHaveLength(0)
})

test('empty optional inputs are left out and filled ones forwarded unchanged', async () => {
  const { calls, executor } = harness()
  await executor.execute(
    {
      action: 'add-apikey',
      values: {
        apiKey: 'sk-only',
        label: null,
        baseURL: '  ',
        authHeader: null,
      },
    },
    full,
  )
  await executor.execute(
    { action: 'add-oauth-finish', values: { code: 'c#s', label: '' } },
    full,
  )
  expect(calls.map(([request]) => request)).toEqual([
    { action: 'add-apikey', values: { apiKey: 'sk-only' } },
    {
      action: 'add-oauth-finish',
      values: { code: 'c#s' },
      sessionId: 'session-1',
    },
  ])
})

test('cache keep hours accept exactly what the cachekeep parser accepts', async () => {
  const { executor } = harness()
  for (let startHour = -1; startHour <= 24; startHour++) {
    for (let endHour = -1; endHour <= 24; endHour++) {
      const parsed = parseCacheKeepCommandAction(`${startHour}-${endHour}`)
      const result = await executor.execute(
        { action: 'cachekeep-window', values: { startHour, endHour } },
        full,
      )
      expect({
        startHour,
        endHour,
        accepted: result.status === 'executed',
      }).toEqual({
        startHour,
        endHour,
        accepted: parsed.type === 'window',
      })
    }
  }
})

test('killswitch entries keep published native route IDs intact', async () => {
  // A real route ID from the published roster projection. Native IDs contain
  // colons by design, so the executor must not apply the text command's
  // `account:fh,sd` delimiter rule to structured entries.
  const roster = projectVaultRoster(
    undefined,
    {
      view: 'synthetic-view',
      credentials: [
        {
          credentialId: 'oauth:anthropic:synthetic-work',
          credentialType: 'oauth',
          accountIdentity: 'synthetic-work-account',
          state: 'active',
        },
      ],
      skipped: [],
    },
    { now: 1 },
  )
  const routeId = roster.rows[0]?.routeId ?? ''
  expect(routeId.startsWith('vault:oauth:anthropic:synthetic-work~')).toBe(true)
  const entries = [
    { account: routeId, fh: 4, sd: 9, scoped: 1 },
    { account: ' padded id ', fh: 0, sd: 0 },
  ]
  const { calls, executor } = harness()
  expect(
    await executor.execute(
      { action: 'killswitch-set', values: { entries } },
      full,
    ),
  ).toEqual({
    status: 'executed',
    action: 'killswitch-set',
    ok: true,
    text: 'done',
  })
  expect(calls.map(([request]) => request)).toEqual([
    { action: 'killswitch-set', values: { entries } },
  ])
})

test('killswitch main and all selectors reach the capability unchanged', async () => {
  const { calls, executor } = harness()
  const entries = [
    { account: 'main', fh: 3, sd: 8, scoped: 0 },
    { account: 'all', fh: 5, sd: 10 },
  ]
  expect(
    (
      await executor.execute(
        { action: 'killswitch-set', values: { entries } },
        full,
      )
    ).status,
  ).toBe('executed')
  expect(calls.map(([request]) => request)).toEqual([
    { action: 'killswitch-set', values: { entries } },
  ])
})

test('killswitch entries forward exactly what the killswitch parser yields', async () => {
  const { calls, executor } = harness()
  const tokens = [
    'main:3,8',
    'main:3,8,0',
    'all:5,10',
    'work-alt:5,10,2',
    'x:0,0,100',
  ]
  for (const token of tokens) {
    const parsed = parseKillswitchCommandAction(`set ${token}`)
    if (parsed.type !== 'set') throw new Error(`parser refused ${token}`)
    calls.length = 0
    const result = await executor.execute(
      { action: 'killswitch-set', values: { entries: parsed.entries } },
      full,
    )
    expect(result.status).toBe('executed')
    const sent = calls[0]?.[0]
    expect(
      sent?.action === 'killswitch-set' ? sent.values.entries : undefined,
    ).toEqual(parsed.entries)
  }
})

test('base URL check matches the stored-account rule', async () => {
  const { executor } = harness()
  for (const baseURL of [
    'https://api.kie.ai/claude',
    'http://localhost:8080',
    ' https://padded.test ',
    'ftp://x.test',
    'https://user@x.test',
    'https://user:pw@x.test',
    'javascript:alert(1)',
    'not a url',
  ]) {
    const result = await executor.execute(
      { action: 'add-apikey', values: { apiKey: 'k', baseURL } },
      full,
    )
    expect({ baseURL, accepted: result.status === 'executed' }).toEqual({
      baseURL,
      accepted: isValidApiBaseURL(baseURL),
    })
  }
})

test('malformed contexts are refused before any dispatch', async () => {
  const { calls, executor } = harness()
  const fakeSignal = Object.create(AbortSignal.prototype) as AbortSignal
  for (const context of [
    null,
    undefined,
    {},
    { interactive: 'yes' },
    { interactive: true, confirmed: 1 },
    { interactive: true, sessionId: 5 },
    { interactive: true, extra: true },
    { interactive: true, signal: fakeSignal },
    { interactive: true, signal: {} },
  ]) {
    // Called directly so an undefined context is not replaced by a default.
    const result = await Reflect.apply(executor.execute, undefined, [
      samples.enable,
      context,
    ])
    expect(result).toEqual({
      status: 'refused',
      code: 'invalid-context',
      action: 'enable',
    })
  }
  expect(calls).toHaveLength(0)
})

test('proxies are refused without running any trap', async () => {
  const { calls, executor } = harness()
  const log: string[] = []
  const cases: [unknown, unknown][] = [
    [trappedProxy({ action: 'enable', values: { id: 'a' } }, log), full],
    [{ action: 'enable', values: trappedProxy({ id: 'a' }, log) }, full],
    [samples.enable, trappedProxy({ interactive: true }, log)],
    [
      samples['prime-on'],
      {
        interactive: true,
        signal: trappedProxy(new AbortController().signal, log),
      },
    ],
    [
      {
        action: 'killswitch-set',
        values: {
          entries: trappedProxy([{ account: 'main', fh: 1, sd: 2 }], log),
        },
      },
      full,
    ],
    [
      {
        action: 'killswitch-set',
        values: {
          entries: [trappedProxy({ account: 'main', fh: 1, sd: 2 }, log)],
        },
      },
      full,
    ],
  ]
  for (const [request, context] of cases) {
    expect((await executeRaw(executor, request, context)).status).toBe(
      'refused',
    )
  }
  expect(log).toEqual([])
  expect(calls).toHaveLength(0)
})

test('accessors, iterators and foreign prototypes are refused without being called', async () => {
  const { calls, executor } = harness()
  const touched: string[] = []
  const getter = (name: string, value: unknown) => ({
    get() {
      touched.push(name)
      return value
    },
    enumerable: true,
  })
  const accessorRequest = Object.defineProperty(
    { values: { id: 'a' } },
    'action',
    getter('action', 'enable'),
  )
  const accessorValues = Object.defineProperty({}, 'id', getter('id', 'a'))
  const accessorContext = Object.defineProperty(
    {},
    'interactive',
    getter('interactive', true),
  )
  const accessorEntry = Object.defineProperty(
    { fh: 1, sd: 2 },
    'account',
    getter('account', 'main'),
  )
  const accessorEntries = Object.defineProperty(
    [],
    '0',
    getter('entry', { account: 'main', fh: 1, sd: 2 }),
  )
  const iteratingEntries = [{ account: 'main', fh: 1, sd: 2 }]
  Object.defineProperty(iteratingEntries, Symbol.iterator, {
    value: () => {
      touched.push('iterator')
      return [][Symbol.iterator]()
    },
  })
  class Entries extends Array {}
  const subclassEntries = Entries.from([{ account: 'main', fh: 1, sd: 2 }])
  class Values {
    id = 'a'
  }
  const cases: [unknown, unknown][] = [
    [accessorRequest, full],
    [{ action: 'enable', values: accessorValues }, full],
    [samples.enable, accessorContext],
    [{ action: 'killswitch-set', values: { entries: [accessorEntry] } }, full],
    [{ action: 'killswitch-set', values: { entries: accessorEntries } }, full],
    [{ action: 'killswitch-set', values: { entries: iteratingEntries } }, full],
    [{ action: 'killswitch-set', values: { entries: subclassEntries } }, full],
    [{ action: 'enable', values: new Values() }, full],
    [{ action: 'enable', values: { id: 'a', [Symbol('x')]: 1 } }, full],
    [new Map([['action', 'enable']]), full],
  ]
  for (const [request, context] of cases) {
    expect((await executeRaw(executor, request, context)).status).toBe(
      'refused',
    )
  }
  expect(touched).toEqual([])
  expect(calls).toHaveLength(0)
})

test('capability failures are reported as a closed generic failure', async () => {
  const secret = 'sk-ant-secret-value'
  const touched: string[] = []
  const hostile = {
    get message() {
      touched.push('message')
      return secret
    },
    get cause() {
      touched.push('cause')
      return secret
    },
  }
  const throwers: NativeMenuDispatch[] = [
    async () => {
      throw new Error(`upstream rejected ${secret}`, { cause: secret })
    },
    async () => {
      throw hostile
    },
    () => {
      throw new Error(secret)
    },
    async () => Promise.reject(trappedProxy({ secret }, touched)),
  ]
  for (const dispatch of throwers) {
    const executor = createNativeMenuExecutor({ host: 'opencode', dispatch })
    const result = await executor.execute(
      { action: 'add-apikey', values: { apiKey: secret } },
      full,
    )
    expect(result).toEqual({
      status: 'failed',
      action: 'add-apikey',
      code: 'execution-failed',
    })
    expect(Reflect.ownKeys(result).sort()).toEqual(['action', 'code', 'status'])
    expect(JSON.stringify(result)).not.toContain(secret)
  }
  expect(touched).toEqual([])
})

test('refusals never echo submitted values', async () => {
  const { executor } = harness()
  const secret = 'sk-ant-pasted secret'
  const result = await executor.execute(
    { action: 'add-apikey', values: { apiKey: secret } },
    full,
  )
  expect(result).toEqual({
    status: 'refused',
    code: 'invalid-parameter',
    action: 'add-apikey',
    parameter: 'apiKey',
  })
  expect(JSON.stringify(result)).not.toContain('sk-ant')
})

test('an unreadable capability outcome is reported as unknown, not success', async () => {
  const touched: string[] = []
  // Resolving any promise with an object makes the platform look up `then` on
  // it; that lookup belongs to the capability's own promise. Every other read
  // would come from the executor and must not happen.
  const thenLookups: string[] = []
  const outcomeProxy = new Proxy(
    { ok: true, text: 'x' },
    {
      get(target, key, receiver) {
        if (key === 'then') thenLookups.push('then')
        else touched.push(`get:${String(key)}`)
        return Reflect.get(target, key, receiver)
      },
      getOwnPropertyDescriptor(target, key) {
        touched.push(`descriptor:${String(key)}`)
        return Reflect.getOwnPropertyDescriptor(target, key)
      },
      ownKeys(target) {
        touched.push('ownKeys')
        return Reflect.ownKeys(target)
      },
      getPrototypeOf(target) {
        touched.push('getPrototypeOf')
        return Reflect.getPrototypeOf(target)
      },
    },
  )
  const outcomes: unknown[] = [
    undefined,
    { ok: 'yes', text: 'x' },
    { ok: true },
    { ok: true, text: 'x', extra: 1 },
    Object.defineProperty({ ok: true }, 'text', {
      get() {
        touched.push('text')
        return 'x'
      },
      enumerable: true,
    }),
    outcomeProxy,
  ]
  for (const outcome of outcomes) {
    const executor = createNativeMenuExecutor({
      host: 'opencode',
      dispatch: async () => outcome as NativeMenuCapabilityOutcome,
    })
    expect(await executor.execute(samples['dump-on'], full)).toEqual({
      status: 'failed',
      action: 'dump-on',
      code: 'invalid-outcome',
    })
  }
  expect(touched).toEqual([])
  expect(thenLookups).toEqual(['then'])
  const reported = createNativeMenuExecutor({
    host: 'opencode',
    dispatch: async () => ({ ok: false, text: 'Quota service unavailable' }),
  })
  expect(await reported.execute(samples['dump-on'], full)).toEqual({
    status: 'executed',
    action: 'dump-on',
    ok: false,
    text: 'Quota service unavailable',
  })
})

test('construction captures only a known host and a plain function capability', async () => {
  const dispatch: NativeMenuDispatch = async () => ({ ok: true, text: 'first' })
  const touched: string[] = []
  const bad: unknown[] = [
    null,
    { host: 'claude', dispatch },
    { host: 'opencode' },
    { host: 'opencode', dispatch: 'run' },
    { host: 'opencode', dispatch, extra: 1 },
    { host: 'opencode', dispatch: trappedProxy(dispatch, touched) },
    trappedProxy({ host: 'opencode', dispatch }, touched),
    Object.defineProperty({ host: 'opencode' }, 'dispatch', {
      get() {
        touched.push('dispatch')
        return dispatch
      },
      enumerable: true,
    }),
  ]
  for (const options of bad) {
    expect(() =>
      Reflect.apply(createNativeMenuExecutor, undefined, [options]),
    ).toThrow(TypeError)
  }
  expect(touched).toEqual([])

  const options = { host: 'opencode' as NativeMenuHost, dispatch }
  const executor = createNativeMenuExecutor(options)
  options.dispatch = async () => ({ ok: true, text: 'second' })
  options.host = 'pi'
  expect(Object.isFrozen(executor)).toBe(true)
  expect(Reflect.ownKeys(executor)).toEqual(['execute'])
  expect(await executor.execute(samples['quota-refresh'], full)).toEqual({
    status: 'executed',
    action: 'quota-refresh',
    ok: true,
    text: 'first',
  })
})

test('the module imports only the menu model and node:util at runtime', async () => {
  const source = await readFile(
    new URL('../native-menu-executor.ts', import.meta.url),
    'utf8',
  )
  const runtime = new Bun.Transpiler({ loader: 'ts' })
    .scanImports(source)
    .map(({ path }) => path)
    .sort()
  expect(runtime).toEqual(['./native-menu-model.ts', 'node:util'])
  // Neither file relies on suppressing type errors.
  const testSource = await readFile(new URL(import.meta.url), 'utf8')
  const suppression = new RegExp(
    ['@ts-', '(ignore|expect-error|nocheck)|as ', 'any\\b'].join(''),
  )
  expect(suppression.test(source)).toBe(false)
  expect(suppression.test(testSource)).toBe(false)
})

test('the emitted declaration carries no common-auth reference', async () => {
  const declaration = await readFile(
    new URL('../../dist/native-menu-executor.d.ts', import.meta.url),
    'utf8',
  )
  expect(declaration).toContain(
    'export declare function createNativeMenuExecutor',
  )
  const specifiers = moduleReferences(declaration).map(
    ({ specifier }) => specifier,
  )
  expect(specifiers.sort()).toEqual(['./native-menu-model.ts'])
})
