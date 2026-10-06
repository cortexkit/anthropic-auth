import { expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import type {
  MenuAction,
  MenuKnob,
  SECTION_SLOTS,
} from '@cortexkit/common-auth/commands'
import { moduleReferences } from '../../scripts/check-native-type-closure.ts'
import {
  getNativeMenuModel,
  NATIVE_MENU_GROUP_IDS,
  type NativeMenuAction,
  type NativeMenuActionId,
  type NativeMenuHost,
  type NativeMenuParameter,
  type NativeMenuRefusalCode,
} from '../native-menu-model.ts'

type Assert<T extends true> = T
type Equal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
type Assignable<A, B> = [A] extends [B] ? true : false
type Slot<Group> = Group extends 'Extras'
  ? 'extra'
  : Group extends string
    ? Lowercase<Group>
    : never
type Slots<Groups extends readonly string[]> = {
  [Index in keyof Groups]: Slot<Groups[Index]>
}

// These projections check compile-time compatibility with the published command
// SDK. They are not runtime renderer objects; a host adapter constructs its own payload.
type KnobProjection<P extends NativeMenuParameter> = P extends {
  kind: 'choice'
  choices: readonly (infer Choice extends string)[]
}
  ? {
      kind: 'choice'
      id: P['id']
      label: string
      choices: { value: Choice; label: string }[]
    }
  : P extends { kind: 'number' }
    ? {
        kind: 'number'
        id: P['id']
        label: string
        required: P['required']
      }
    : {
        kind: 'text'
        id: P['id']
        label: string
        required: P['required']
        masked: boolean
      }
type ActionProjection = Pick<NativeMenuAction, 'id' | 'label'> & {
  knobs: KnobProjection<NativeMenuParameter>[]
  confirm?: { message: string; irreversible: boolean }
}
const producerParity: [
  Assert<Equal<Slots<typeof NATIVE_MENU_GROUP_IDS>, typeof SECTION_SLOTS>>,
  Assert<Assignable<KnobProjection<NativeMenuParameter>, MenuKnob>>,
  Assert<Assignable<ActionProjection, MenuAction>>,
  Assert<
    Equal<
      Extract<NativeMenuAction, { kind: 'action' }>['id'],
      Exclude<NativeMenuActionId, 'custody-mode'>
    >
  >,
  Assert<
    Assignable<
      Extract<NativeMenuAction, { id: 'remove' | 'enrollment-reset' }>,
      { destructive: true; confirm: string }
    >
  >,
  Assert<
    Assignable<
      Extract<
        NativeMenuAction,
        {
          id:
            | 'add-apikey'
            | 'add-oauth-start'
            | 'add-oauth-finish'
            | 'custody-mode'
        }
      >,
      { interactive: true; headlessRefusal: NativeMenuRefusalCode }
    >
  >,
] = [true, true, true, true, true, true]

// Parameter notation: ! required, ? optional, # protected entry; choice domains
// and structured entry field identifiers are spelled out rather than inferred.
// Each row is [id, family, group, parameters, destructive, interactive, provenance].
type InventoryRow = readonly [
  string,
  string,
  string,
  readonly string[],
  boolean,
  boolean,
  string,
]
const fixture: Record<
  NativeMenuHost,
  {
    actions: readonly InventoryRow[]
    statuses: readonly InventoryRow[]
    families: readonly string[]
    destructive: readonly string[]
    interactive: readonly string[]
  }
> = {
  opencode: {
    actions: [
      [
        'enable',
        'account',
        'Accounts',
        ['id:account-id!'],
        false,
        false,
        'packages/core/src/commands/account.ts:AccountCommandAction:13-32; packages/opencode/src/index.ts:claude-account:4387-4415',
      ],
      [
        'disable',
        'account',
        'Accounts',
        ['id:account-id!'],
        false,
        false,
        'packages/core/src/commands/account.ts:AccountCommandAction:13-32; packages/opencode/src/index.ts:claude-account:4387-4415',
      ],
      [
        'remove',
        'account',
        'Accounts',
        ['id:account-id!'],
        true,
        false,
        'packages/core/src/commands/account.ts:AccountCommandAction:13-32; packages/opencode/src/index.ts:claude-account:4387-4415',
      ],
      [
        'move-up',
        'account',
        'Accounts',
        ['id:account-id!'],
        false,
        false,
        'packages/core/src/commands/account.ts:AccountCommandAction:13-32; packages/opencode/src/index.ts:claude-account:4387-4415',
      ],
      [
        'move-down',
        'account',
        'Accounts',
        ['id:account-id!'],
        false,
        false,
        'packages/core/src/commands/account.ts:AccountCommandAction:13-32; packages/opencode/src/index.ts:claude-account:4387-4415',
      ],
      [
        'reset-backoff',
        'account',
        'Accounts',
        [],
        false,
        false,
        'packages/core/src/commands/account.ts:AccountCommandAction:13-32; packages/opencode/src/index.ts:claude-account:4387-4415',
      ],
      [
        'enrollment-reset',
        'account',
        'Accounts',
        [],
        true,
        false,
        'packages/core/src/commands/account.ts:AccountCommandAction:13-32; packages/opencode/src/index.ts:claude-account:4387-4415',
      ],
      [
        'add-apikey',
        'account',
        'Accounts',
        [
          'apiKey:text!#',
          'label:text?',
          'baseURL:text?',
          'authHeader:choice?=authorization-bearer|x-api-key',
        ],
        false,
        true,
        'packages/core/src/commands/account.ts:AccountCommandAction:13-32; packages/opencode/src/index.ts:claude-account:4387-4415',
      ],
      [
        'add-oauth-start',
        'account',
        'Accounts',
        [],
        false,
        true,
        'packages/core/src/commands/account.ts:AccountCommandAction:13-32; packages/opencode/src/index.ts:claude-account:4387-4415',
      ],
      [
        'add-oauth-finish',
        'account',
        'Accounts',
        ['code:text!#', 'label:text?'],
        false,
        true,
        'packages/core/src/commands/account.ts:AccountCommandAction:13-32; packages/opencode/src/index.ts:claude-account:4387-4415',
      ],
      [
        'custody-mode',
        'account',
        'Accounts',
        ['mode:choice!=local|claustrum'],
        false,
        true,
        'packages/core/src/commands/account.ts:AccountCommandAction:13-32; packages/opencode/src/index.ts:claude-account:4387-4415',
      ],
      [
        'quota-refresh',
        'quota',
        'Quota',
        [],
        false,
        false,
        'packages/opencode/src/index.ts:claude-quota:3382,4368-4369',
      ],
      [
        'routing-mode',
        'routing',
        'Routing',
        ['mode:choice!=main-first|fallback-first|sticky-balanced'],
        false,
        false,
        'packages/core/src/routing.ts:RoutingCommandAction:21-25; packages/opencode/src/index.ts:claude-routing:4416-4420',
      ],
      [
        'routing-reset',
        'routing',
        'Routing',
        [],
        false,
        false,
        'packages/core/src/routing.ts:RoutingCommandAction:21-25; packages/opencode/src/index.ts:claude-routing:4416-4420',
      ],
      [
        'killswitch-on',
        'killswitch',
        'Limits',
        [],
        false,
        false,
        'packages/core/src/killswitch.ts:KillswitchCommandAction:9-22; packages/opencode/src/index.ts:claude-killswitch:4469',
      ],
      [
        'killswitch-off',
        'killswitch',
        'Limits',
        [],
        false,
        false,
        'packages/core/src/killswitch.ts:KillswitchCommandAction:9-22; packages/opencode/src/index.ts:claude-killswitch:4469',
      ],
      [
        'killswitch-set',
        'killswitch',
        'Limits',
        ['entries:limit-entries!=account|fh|sd|scoped?'],
        false,
        false,
        'packages/core/src/killswitch.ts:KillswitchCommandAction:9-22; packages/opencode/src/index.ts:claude-killswitch:4469',
      ],
      [
        'cache-on',
        'cache',
        'Cache',
        [],
        false,
        false,
        'packages/core/src/cache1h.ts:Cache1hCommandAction:15-20; packages/opencode/src/index.ts:claude-cache:4439-4450',
      ],
      [
        'cache-off',
        'cache',
        'Cache',
        [],
        false,
        false,
        'packages/core/src/cache1h.ts:Cache1hCommandAction:15-20; packages/opencode/src/index.ts:claude-cache:4439-4450',
      ],
      [
        'cache-mode',
        'cache',
        'Cache',
        ['mode:choice!=explicit|automatic|hybrid'],
        false,
        false,
        'packages/core/src/cache1h.ts:Cache1hCommandAction:15-20; packages/opencode/src/index.ts:claude-cache:4439-4450',
      ],
      [
        'cachekeep-always',
        'cachekeep',
        'Cache',
        [],
        false,
        false,
        'packages/core/src/cachekeep.ts:CacheKeepCommandAction:32-38; packages/opencode/src/index.ts:claude-cachekeep:4451-4455',
      ],
      [
        'cachekeep-off',
        'cachekeep',
        'Cache',
        [],
        false,
        false,
        'packages/core/src/cachekeep.ts:CacheKeepCommandAction:32-38; packages/opencode/src/index.ts:claude-cachekeep:4451-4455',
      ],
      [
        'cachekeep-window',
        'cachekeep',
        'Cache',
        ['startHour:number!', 'endHour:number!'],
        false,
        false,
        'packages/core/src/cachekeep.ts:CacheKeepCommandAction:32-38; packages/opencode/src/index.ts:claude-cachekeep:4451-4455',
      ],
      [
        'cachekeep-subagents',
        'cachekeep',
        'Cache',
        ['enabled:choice!=on|off'],
        false,
        false,
        'packages/core/src/cachekeep.ts:CacheKeepCommandAction:32-38; packages/opencode/src/index.ts:claude-cachekeep:4451-4455',
      ],
      [
        'dump-on',
        'dump',
        'Diagnostics',
        [],
        false,
        false,
        'packages/core/src/dump.ts:DumpCommandAction; packages/opencode/src/index.ts:claude-dump:4430-4438',
      ],
      [
        'dump-off',
        'dump',
        'Diagnostics',
        [],
        false,
        false,
        'packages/core/src/dump.ts:DumpCommandAction; packages/opencode/src/index.ts:claude-dump:4430-4438',
      ],
      [
        'logging-level',
        'logging',
        'Diagnostics',
        ['level:choice!=error|warn|info|debug|trace'],
        false,
        false,
        'packages/core/src/logging.ts:LoggingCommandAction:21-24; packages/opencode/src/index.ts:claude-logging:4378-4386',
      ],
      [
        'fast-on',
        'fast',
        'Extras',
        [],
        false,
        false,
        'packages/core/src/fast.ts:FastModeCommandAction; packages/opencode/src/index.ts:claude-fast:4421-4429',
      ],
      [
        'fast-off',
        'fast',
        'Extras',
        [],
        false,
        false,
        'packages/core/src/fast.ts:FastModeCommandAction; packages/opencode/src/index.ts:claude-fast:4421-4429',
      ],
      [
        'prime-on',
        'prime',
        'Extras',
        [],
        false,
        false,
        'packages/core/src/prime.ts:PrimeCommandAction; packages/opencode/src/index.ts:claude-prime:4456-4468',
      ],
      [
        'prime-off',
        'prime',
        'Extras',
        [],
        false,
        false,
        'packages/core/src/prime.ts:PrimeCommandAction; packages/opencode/src/index.ts:claude-prime:4456-4468',
      ],
      [
        'start-fire',
        'start',
        'Extras',
        [],
        false,
        false,
        'packages/core/src/start.ts:LaneStartCommandAction:8; packages/opencode/src/index.ts:claude-start:4370-4377',
      ],
    ],
    statuses: [
      [
        'account-status',
        'account',
        'Accounts',
        [],
        false,
        false,
        'packages/core/src/commands/account.ts:AccountCommandAction:14,32',
      ],
      [
        'quota-status',
        'quota',
        'Quota',
        [],
        false,
        false,
        'packages/opencode/src/index.ts:claude-quota:4368-4369',
      ],
      [
        'routing-status',
        'routing',
        'Routing',
        [],
        false,
        false,
        'packages/core/src/routing.ts:RoutingCommandAction:22,25',
      ],
      [
        'killswitch-status',
        'killswitch',
        'Limits',
        [],
        false,
        false,
        'packages/core/src/killswitch.ts:KillswitchCommandAction:10,22',
      ],
      [
        'cache-status',
        'cache',
        'Cache',
        [],
        false,
        false,
        'packages/core/src/cache1h.ts:Cache1hCommandAction:16,20',
      ],
      [
        'cachekeep-status',
        'cachekeep',
        'Cache',
        [],
        false,
        false,
        'packages/core/src/cachekeep.ts:CacheKeepCommandAction:33,37',
      ],
      [
        'dump-status',
        'dump',
        'Diagnostics',
        [],
        false,
        false,
        'packages/core/src/dump.ts:DumpCommandAction',
      ],
      [
        'logging-status',
        'logging',
        'Diagnostics',
        [],
        false,
        false,
        'packages/core/src/logging.ts:LoggingCommandAction:22,24',
      ],
      [
        'fast-status',
        'fast',
        'Extras',
        [],
        false,
        false,
        'packages/core/src/fast.ts:FastModeCommandAction',
      ],
      [
        'prime-status',
        'prime',
        'Extras',
        [],
        false,
        false,
        'packages/core/src/prime.ts:PrimeCommandAction',
      ],
    ],
    families: [
      'account',
      'quota',
      'routing',
      'killswitch',
      'cache',
      'cachekeep',
      'dump',
      'logging',
      'fast',
      'prime',
      'start',
    ],
    destructive: ['remove', 'enrollment-reset'],
    interactive: [
      'add-apikey',
      'add-oauth-start',
      'add-oauth-finish',
      'custody-mode',
    ],
  },
  pi: {
    actions: [
      [
        'enable',
        'account',
        'Accounts',
        ['id:account-id!'],
        false,
        false,
        'packages/core/src/commands/account.ts:AccountCommandAction:13-32; packages/pi/src/commands.ts:claude-account:272-366',
      ],
      [
        'disable',
        'account',
        'Accounts',
        ['id:account-id!'],
        false,
        false,
        'packages/core/src/commands/account.ts:AccountCommandAction:13-32; packages/pi/src/commands.ts:claude-account:272-366',
      ],
      [
        'remove',
        'account',
        'Accounts',
        ['id:account-id!'],
        true,
        false,
        'packages/core/src/commands/account.ts:AccountCommandAction:13-32; packages/pi/src/commands.ts:claude-account:272-366',
      ],
      [
        'move-up',
        'account',
        'Accounts',
        ['id:account-id!'],
        false,
        false,
        'packages/core/src/commands/account.ts:AccountCommandAction:13-32; packages/pi/src/commands.ts:claude-account:272-366',
      ],
      [
        'move-down',
        'account',
        'Accounts',
        ['id:account-id!'],
        false,
        false,
        'packages/core/src/commands/account.ts:AccountCommandAction:13-32; packages/pi/src/commands.ts:claude-account:272-366',
      ],
      [
        'reset-backoff',
        'account',
        'Accounts',
        [],
        false,
        false,
        'packages/core/src/commands/account.ts:AccountCommandAction:13-32; packages/pi/src/commands.ts:claude-account:272-366',
      ],
      [
        'enrollment-reset',
        'account',
        'Accounts',
        [],
        true,
        false,
        'packages/core/src/commands/account.ts:AccountCommandAction:13-32; packages/pi/src/commands.ts:claude-account:272-366',
      ],
      [
        'add-apikey',
        'account',
        'Accounts',
        [
          'apiKey:text!#',
          'label:text?',
          'baseURL:text?',
          'authHeader:choice?=authorization-bearer|x-api-key',
        ],
        false,
        true,
        'packages/core/src/commands/account.ts:AccountCommandAction:13-32; packages/pi/src/commands.ts:claude-account:272-366',
      ],
      [
        'add-oauth-start',
        'account',
        'Accounts',
        [],
        false,
        true,
        'packages/core/src/commands/account.ts:AccountCommandAction:13-32; packages/pi/src/commands.ts:claude-account:272-366',
      ],
      [
        'add-oauth-finish',
        'account',
        'Accounts',
        ['code:text!#', 'label:text?'],
        false,
        true,
        'packages/core/src/commands/account.ts:AccountCommandAction:13-32; packages/pi/src/commands.ts:claude-account:272-366',
      ],
      [
        'custody-mode',
        'account',
        'Accounts',
        ['mode:choice!=local|claustrum'],
        false,
        true,
        'packages/core/src/commands/account.ts:AccountCommandAction:13-32; packages/pi/src/commands.ts:claude-account:272-366',
      ],
      [
        'routing-mode',
        'routing',
        'Routing',
        ['mode:choice!=main-first|fallback-first|sticky-balanced'],
        false,
        false,
        'packages/core/src/routing.ts:RoutingCommandAction:21-25; packages/pi/src/commands.ts:claude-routing:231-256',
      ],
      [
        'routing-reset',
        'routing',
        'Routing',
        [],
        false,
        false,
        'packages/core/src/routing.ts:RoutingCommandAction:21-25; packages/pi/src/commands.ts:claude-routing:231-256',
      ],
      [
        'cache-on',
        'cache',
        'Cache',
        [],
        false,
        false,
        'packages/core/src/cache1h.ts:Cache1hCommandAction:15-20; packages/pi/src/commands.ts:claude-cache:83-118',
      ],
      [
        'cache-off',
        'cache',
        'Cache',
        [],
        false,
        false,
        'packages/core/src/cache1h.ts:Cache1hCommandAction:15-20; packages/pi/src/commands.ts:claude-cache:83-118',
      ],
      [
        'cache-mode',
        'cache',
        'Cache',
        ['mode:choice!=explicit|automatic|hybrid'],
        false,
        false,
        'packages/core/src/cache1h.ts:Cache1hCommandAction:15-20; packages/pi/src/commands.ts:claude-cache:83-118',
      ],
      [
        'cachekeep-always',
        'cachekeep',
        'Cache',
        [],
        false,
        false,
        'packages/core/src/cachekeep.ts:CacheKeepCommandAction:32-38; packages/pi/src/commands.ts:claude-cachekeep:120-163',
      ],
      [
        'cachekeep-off',
        'cachekeep',
        'Cache',
        [],
        false,
        false,
        'packages/core/src/cachekeep.ts:CacheKeepCommandAction:32-38; packages/pi/src/commands.ts:claude-cachekeep:120-163',
      ],
      [
        'cachekeep-window',
        'cachekeep',
        'Cache',
        ['startHour:number!', 'endHour:number!'],
        false,
        false,
        'packages/core/src/cachekeep.ts:CacheKeepCommandAction:32-38; packages/pi/src/commands.ts:claude-cachekeep:120-163',
      ],
      [
        'cachekeep-subagents',
        'cachekeep',
        'Cache',
        ['enabled:choice!=on|off'],
        false,
        false,
        'packages/core/src/cachekeep.ts:CacheKeepCommandAction:32-38; packages/pi/src/commands.ts:claude-cachekeep:120-163',
      ],
      [
        'dump-on',
        'dump',
        'Diagnostics',
        [],
        false,
        false,
        'packages/core/src/dump.ts:DumpCommandAction; packages/pi/src/commands.ts:claude-dump:165-196',
      ],
      [
        'dump-off',
        'dump',
        'Diagnostics',
        [],
        false,
        false,
        'packages/core/src/dump.ts:DumpCommandAction; packages/pi/src/commands.ts:claude-dump:165-196',
      ],
      [
        'logging-level',
        'logging',
        'Diagnostics',
        ['level:choice!=error|warn|info|debug|trace'],
        false,
        false,
        'packages/core/src/logging.ts:LoggingCommandAction:21-24; packages/pi/src/commands.ts:claude-logging:368-385',
      ],
      [
        'fast-on',
        'fast',
        'Extras',
        [],
        false,
        false,
        'packages/core/src/fast.ts:FastModeCommandAction; packages/pi/src/commands.ts:claude-fast:198-229',
      ],
      [
        'fast-off',
        'fast',
        'Extras',
        [],
        false,
        false,
        'packages/core/src/fast.ts:FastModeCommandAction; packages/pi/src/commands.ts:claude-fast:198-229',
      ],
    ],
    statuses: [
      [
        'account-status',
        'account',
        'Accounts',
        [],
        false,
        false,
        'packages/core/src/commands/account.ts:AccountCommandAction:14,32; packages/pi/src/commands.ts:claude-account:272-366',
      ],
      [
        'quota-status',
        'quota',
        'Quota',
        [],
        false,
        false,
        'packages/pi/src/commands.ts:claude-quota:258-270',
      ],
      [
        'routing-status',
        'routing',
        'Routing',
        [],
        false,
        false,
        'packages/core/src/routing.ts:RoutingCommandAction:22,25; packages/pi/src/commands.ts:claude-routing:231-256',
      ],
      [
        'cache-status',
        'cache',
        'Cache',
        [],
        false,
        false,
        'packages/core/src/cache1h.ts:Cache1hCommandAction:16,20; packages/pi/src/commands.ts:claude-cache:83-118',
      ],
      [
        'cachekeep-status',
        'cachekeep',
        'Cache',
        [],
        false,
        false,
        'packages/core/src/cachekeep.ts:CacheKeepCommandAction:33,37; packages/pi/src/commands.ts:claude-cachekeep:120-163',
      ],
      [
        'dump-status',
        'dump',
        'Diagnostics',
        [],
        false,
        false,
        'packages/core/src/dump.ts:DumpCommandAction; packages/pi/src/commands.ts:claude-dump:165-196',
      ],
      [
        'logging-status',
        'logging',
        'Diagnostics',
        [],
        false,
        false,
        'packages/core/src/logging.ts:LoggingCommandAction:22,24; packages/pi/src/commands.ts:claude-logging:368-385',
      ],
      [
        'fast-status',
        'fast',
        'Extras',
        [],
        false,
        false,
        'packages/core/src/fast.ts:FastModeCommandAction; packages/pi/src/commands.ts:claude-fast:198-229',
      ],
      [
        'prime-status',
        'prime',
        'Extras',
        [],
        false,
        false,
        'packages/pi/src/commands.ts:claude-prime:387-406',
      ],
    ],
    families: [
      'account',
      'quota',
      'routing',
      'cache',
      'cachekeep',
      'dump',
      'logging',
      'fast',
      'prime',
    ],
    destructive: ['remove', 'enrollment-reset'],
    interactive: [
      'add-apikey',
      'add-oauth-start',
      'add-oauth-finish',
      'custody-mode',
    ],
  },
}

function allActions(host: NativeMenuHost) {
  return getNativeMenuModel(host).groups.flatMap((group) => group.actions)
}

function parameterSignature(parameter: NativeMenuParameter): string {
  const base = `${parameter.id}:${parameter.kind}${parameter.required ? '!' : '?'}`
  if (parameter.kind === 'text')
    return `${base}${parameter.protectedEntry ? '#' : ''}`
  if (parameter.kind === 'choice')
    return `${base}=${parameter.choices.join('|')}`
  if (parameter.kind === 'limit-entries')
    return `${base}=${parameter.fields.join('|')}`
  return base
}

function expectKeys(value: object, keys: string[]) {
  expect(Object.keys(value).sort()).toEqual(keys.sort())
}

test('native group order is Accounts, Quota, Routing, Limits, Cache, Diagnostics, Extras', () => {
  const order = [
    'Accounts',
    'Quota',
    'Routing',
    'Limits',
    'Cache',
    'Diagnostics',
    'Extras',
  ] as const
  expect(NATIVE_MENU_GROUP_IDS).toEqual(order)
  for (const host of ['opencode', 'pi'] as const) {
    expect(getNativeMenuModel(host).groups.map((group) => group.id)).toEqual([
      ...order,
    ])
  }
  expect(producerParity).toEqual([true, true, true, true, true, true])
})

for (const host of ['opencode', 'pi'] as const) {
  test(`${host} preserves the literal pinned action and status inventory`, () => {
    const model = getNativeMenuModel(host)
    const actual: (string | boolean | readonly string[])[][] = model.groups
      .flatMap((group) => group.actions)
      .map((action) => [
        action.id,
        action.command,
        action.group,
        action.parameters.map(parameterSignature),
        action.destructive,
        action.interactive,
      ])
    expect(actual).toEqual(fixture[host].actions.map((row) => row.slice(0, 6)))
    const statuses = model.groups.flatMap((group) => group.statuses)
    const actualStatuses: (string | boolean | readonly string[])[][] =
      statuses.map((status) => [
        status.id,
        status.command,
        status.group,
        [],
        false,
        false,
      ])
    expect(actualStatuses).toEqual(
      fixture[host].statuses.map((row) => row.slice(0, 6)),
    )
    expect(actual).toHaveLength(host === 'opencode' ? 32 : 25)
    const families: string[] = [
      ...new Set(
        [...allActions(host), ...statuses].map(
          (descriptor) => descriptor.command,
        ),
      ),
    ]
    expect(families.sort()).toEqual([...fixture[host].families].sort())
    expect(families).toHaveLength(host === 'opencode' ? 11 : 9)
    for (const row of [...fixture[host].actions, ...fixture[host].statuses]) {
      expect(row[6]).toMatch(/packages\/.+\.ts:[A-Za-z]/)
    }
    for (const group of model.groups) {
      for (const descriptor of [...group.actions, ...group.statuses])
        expect(descriptor.group).toBe(group.id)
    }
  })
}

test('Pi Prime and quota remain status-only with no Limits or start actions', () => {
  const pi = getNativeMenuModel('pi')
  expect(pi.groups.find((group) => group.id === 'Limits')).toEqual({
    id: 'Limits',
    actions: [],
    statuses: [],
  })
  expect(
    allActions('pi').filter((action) =>
      ['prime', 'quota', 'killswitch', 'start'].includes(action.command),
    ),
  ).toEqual([])
  expect(
    pi.groups
      .flatMap((group) => group.statuses)
      .filter((status) => ['prime', 'quota'].includes(status.command))
      .map((status) => status.id),
  ).toEqual(['quota-status', 'prime-status'])
  expect(
    allActions('opencode')
      .filter((action) =>
        ['quota', 'killswitch', 'prime', 'start'].includes(action.command),
      )
      .map((action) => action.id),
  ).toEqual([
    'quota-refresh',
    'killswitch-on',
    'killswitch-off',
    'killswitch-set',
    'prime-on',
    'prime-off',
    'start-fire',
  ])
})

test('destructive actions require non-empty confirmation for removal and enrollment reset', () => {
  for (const host of ['opencode', 'pi'] as const) {
    const actions = allActions(host)
    const destructiveIds: string[] = actions
      .filter((action) => action.destructive)
      .map((action) => action.id)
    expect(destructiveIds).toEqual([...fixture[host].destructive])
    for (const id of fixture[host].destructive) {
      const action = actions.find((candidate) => candidate.id === id)
      expect(action?.destructive).toBe(true)
      expect(typeof action?.confirm).toBe('string')
      expect(action?.confirm?.trim().length).toBeGreaterThan(0)
      if (id === 'enrollment-reset') {
        expect(action?.confirm).toBe(
          'Clear denied or blocked enrollment state for this host?',
        )
      }
    }
  }
})

test('interactive actions require closed headless refusals and protected API-key entry', () => {
  for (const host of ['opencode', 'pi'] as const) {
    const actions = allActions(host)
    const interactiveIds: string[] = actions
      .filter((action) => action.interactive)
      .map((action) => action.id)
    expect(interactiveIds).toEqual([...fixture[host].interactive])
    for (const id of fixture[host].interactive) {
      const action = actions.find((candidate) => candidate.id === id)
      expect(action?.interactive).toBe(true)
      expect(action?.headlessRefusal).toBe(
        id === 'custody-mode' ? 'offline-required' : 'interactive-required',
      )
    }
    expect(
      actions.find((action) => action.id === 'add-apikey')?.parameters[0],
    ).toEqual({
      id: 'apiKey',
      kind: 'text',
      required: true,
      protectedEntry: true,
    })
  }
})

test('custody-mode is typed offline setup guidance, never an executable authority change', () => {
  for (const host of ['opencode', 'pi'] as const) {
    const action = allActions(host).find(
      (candidate) => candidate.id === 'custody-mode',
    )
    expect(action?.kind).toBe('setup-guidance')
    if (action?.kind !== 'setup-guidance')
      throw new Error('Missing custody guidance')
    expect(action.command).toBe('account')
    expect(action.group).toBe('Accounts')
    expect(action.interactive).toBe(true)
    expect(action.offlineRequired).toBe(true)
    expect(action.headlessRefusal).toBe('offline-required')
    expect(action.parameters).toEqual([
      {
        id: 'mode',
        kind: 'choice',
        required: true,
        choices: ['local', 'claustrum'],
      },
    ])
    expect(action.setupInstructions).toEqual([
      'Stop all selected hosts before changing credential authority.',
      'Use the explicit offline setup flow for the selected local or claustrum mode.',
      'This menu only provides guidance; it does not change settings, propose enrollment, or report setup success.',
    ])
  }
})

test('every descriptor has only closed public metadata and parameter identifiers', () => {
  for (const host of ['opencode', 'pi'] as const) {
    const model = getNativeMenuModel(host)
    expectKeys(model, ['host', 'groups'])
    for (const group of model.groups) {
      expectKeys(group, ['id', 'actions', 'statuses'])
      for (const status of group.statuses) {
        expectKeys(status, ['kind', 'id', 'command', 'group', 'label'])
        expect(status.kind).toBe('status')
        expect(typeof status.label).toBe('string')
      }
      for (const action of group.actions) {
        const keys = [
          'id',
          'kind',
          'command',
          'group',
          'label',
          'parameters',
          'destructive',
          'interactive',
        ]
        if (action.destructive) keys.push('confirm')
        if (action.interactive) keys.push('headlessRefusal')
        if (action.kind === 'setup-guidance')
          keys.push('offlineRequired', 'setupInstructions')
        expectKeys(action, keys)
        expect(typeof action.label).toBe('string')
        expect(action.label.trim().length).toBeGreaterThan(0)
        expect(['action', 'setup-guidance']).toContain(action.kind)
        for (const parameter of action.parameters) {
          const parameterKeys = ['id', 'kind', 'required']
          if (parameter.kind === 'text') parameterKeys.push('protectedEntry')
          if (parameter.kind === 'choice') parameterKeys.push('choices')
          if (parameter.kind === 'limit-entries') parameterKeys.push('fields')
          expectKeys(parameter, parameterKeys)
          expect(typeof parameter.required).toBe('boolean')
          expect([
            'account-id',
            'text',
            'choice',
            'number',
            'limit-entries',
          ]).toContain(parameter.kind)
          if (parameter.kind === 'text')
            expect(typeof parameter.protectedEntry).toBe('boolean')
          if (parameter.kind === 'choice') {
            expect(parameter.choices.length).toBeGreaterThan(0)
            for (const choice of parameter.choices)
              expect(typeof choice).toBe('string')
          }
          if (parameter.kind === 'limit-entries')
            expect(parameter.fields).toEqual(['account', 'fh', 'sd', 'scoped?'])
        }
      }
    }
    // Exact descriptor keys permit public metadata and parameter names only,
    // never supplied input values, account/credential objects, or callbacks.
    expect(JSON.stringify(model)).not.toMatch(/claude-/)
  }
})

function expectDeepFrozen(value: unknown) {
  if (!value || typeof value !== 'object') return
  expect(Object.isFrozen(value)).toBe(true)
  for (const child of Object.values(value)) expectDeepFrozen(child)
}

test('output is deterministic and deeply frozen including nested parameter domains', () => {
  expectDeepFrozen(NATIVE_MENU_GROUP_IDS)
  for (const host of ['opencode', 'pi'] as const) {
    const model = getNativeMenuModel(host)
    const before = JSON.stringify(model)
    expectDeepFrozen(model)
    expect(getNativeMenuModel(host)).toBe(model)
    expect(Reflect.set(model, 'host', 'other')).toBe(false)
    expect(
      Reflect.set(model.groups, model.groups.length, { id: 'Accounts' }),
    ).toBe(false)
    const action = model.groups[0]!.actions[0]!
    expect(Reflect.set(action, 'label', 'changed')).toBe(false)
    expect(Reflect.set(action.parameters[0]!, 'id', 'changed')).toBe(false)
    expect(JSON.stringify(getNativeMenuModel(host))).toBe(before)
    expect(JSON.parse(before)).toEqual(model)
  }
})

test('emitted native menu declaration has no producer or internal-types references', async () => {
  // Parse only this module's emitted declaration, never the barrel or vendored graph.
  // It must contain no common-auth reference or internal-types edge.
  const declaration = await readFile(
    new URL('../../dist/native-menu-model.d.ts', import.meta.url),
    'utf8',
  )
  expect(declaration).toContain('export declare function getNativeMenuModel')
  const forbidden = moduleReferences(declaration).filter(
    ({ specifier }) =>
      specifier === '@cortexkit/common-auth' ||
      specifier.startsWith('@cortexkit/common-auth/') ||
      /(^|\/)internal-types(\/|$)/.test(specifier.replaceAll('\\', '/')),
  )
  expect(forbidden.map(({ specifier }) => specifier)).toEqual([])
})
