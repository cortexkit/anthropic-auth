/** Public menu metadata only; host adapters collect input and apply commands. */
export const NATIVE_MENU_GROUP_IDS = Object.freeze([
  'Accounts',
  'Quota',
  'Routing',
  'Limits',
  'Cache',
  'Diagnostics',
  'Extras',
] as const)

export type NativeMenuGroupId = (typeof NATIVE_MENU_GROUP_IDS)[number]
/** OpenCode 1 and OpenCode 2 share this action profile; host integration is separate. */
export type NativeMenuHost = 'opencode' | 'pi'
export type NativeMenuCommandId =
  | 'account'
  | 'quota'
  | 'routing'
  | 'killswitch'
  | 'cache'
  | 'cachekeep'
  | 'dump'
  | 'logging'
  | 'fast'
  | 'prime'
  | 'start'
export type NativeMenuRefusalCode = 'interactive-required' | 'offline-required'
export type NativeMenuCustodyMode = 'local' | 'claustrum'
export type NativeMenuRoutingMode =
  | 'main-first'
  | 'fallback-first'
  | 'sticky-balanced'
export type NativeMenuCacheMode = 'explicit' | 'automatic' | 'hybrid'
export type NativeMenuLogLevel = 'error' | 'warn' | 'info' | 'debug' | 'trace'
export type NativeMenuParameterId =
  | 'id'
  | 'apiKey'
  | 'label'
  | 'baseURL'
  | 'authHeader'
  | 'code'
  | 'mode'
  | 'entries'
  | 'startHour'
  | 'endHour'
  | 'enabled'
  | 'level'

export type NativeMenuChoiceParameter<
  Id extends NativeMenuParameterId = NativeMenuParameterId,
  Choice extends string = string,
> = {
  readonly id: Id
  readonly kind: 'choice'
  readonly required: boolean
  readonly choices: readonly Choice[]
}

/** Identifiers describe inputs, not the inputs' values or credential objects. */
export type NativeMenuParameter =
  | {
      readonly id: 'id'
      readonly kind: 'account-id'
      readonly required: true
    }
  | {
      readonly id: 'apiKey' | 'label' | 'baseURL' | 'code'
      readonly kind: 'text'
      readonly required: boolean
      readonly protectedEntry: boolean
    }
  | NativeMenuChoiceParameter<'mode', NativeMenuCustodyMode>
  | NativeMenuChoiceParameter<'mode', NativeMenuRoutingMode>
  | NativeMenuChoiceParameter<'mode', NativeMenuCacheMode>
  | NativeMenuChoiceParameter<
      'authHeader',
      'authorization-bearer' | 'x-api-key'
    >
  | NativeMenuChoiceParameter<'enabled', 'on' | 'off'>
  | NativeMenuChoiceParameter<'level', NativeMenuLogLevel>
  | {
      readonly id: 'startHour' | 'endHour'
      readonly kind: 'number'
      readonly required: true
    }
  | {
      readonly id: 'entries'
      readonly kind: 'limit-entries'
      readonly required: true
      readonly fields: readonly ['account', 'fh', 'sd', 'scoped?']
    }

export type NativeMenuActionId =
  | 'enable'
  | 'disable'
  | 'remove'
  | 'move-up'
  | 'move-down'
  | 'reset-backoff'
  | 'enrollment-reset'
  | 'add-apikey'
  | 'add-oauth-start'
  | 'add-oauth-finish'
  | 'custody-mode'
  | 'quota-refresh'
  | 'routing-mode'
  | 'routing-reset'
  | 'killswitch-on'
  | 'killswitch-off'
  | 'killswitch-set'
  | 'cache-on'
  | 'cache-off'
  | 'cache-mode'
  | 'cachekeep-always'
  | 'cachekeep-off'
  | 'cachekeep-window'
  | 'cachekeep-subagents'
  | 'dump-on'
  | 'dump-off'
  | 'logging-level'
  | 'fast-on'
  | 'fast-off'
  | 'prime-on'
  | 'prime-off'
  | 'start-fire'

type DestructiveId = 'remove' | 'enrollment-reset'
type InteractiveId =
  | 'add-apikey'
  | 'add-oauth-start'
  | 'add-oauth-finish'
  | 'custody-mode'

type ActionSafety<Id extends NativeMenuActionId> = (Id extends DestructiveId
  ? { readonly destructive: true; readonly confirm: string }
  : { readonly destructive: false; readonly confirm?: never }) &
  (Id extends InteractiveId
    ? {
        readonly interactive: true
        readonly headlessRefusal: NativeMenuRefusalCode
      }
    : { readonly interactive: false; readonly headlessRefusal?: never })

export type NativeMenuAction = {
  [Id in NativeMenuActionId]: {
    readonly id: Id
    readonly label: string
  } & ActionSafety<Id> &
    (Id extends 'custody-mode'
      ? {
          readonly kind: 'setup-guidance'
          readonly command: 'account'
          readonly group: 'Accounts'
          readonly parameters: readonly [
            NativeMenuChoiceParameter<'mode', NativeMenuCustodyMode>,
          ]
          readonly offlineRequired: true
          readonly setupInstructions: readonly string[]
        }
      : {
          readonly kind: 'action'
          readonly command: NativeMenuCommandId
          readonly group: NativeMenuGroupId
          readonly parameters: readonly NativeMenuParameter[]
        })
}[NativeMenuActionId]

export type NativeMenuStatus = {
  readonly kind: 'status'
  readonly id: `${Exclude<NativeMenuCommandId, 'start'>}-status`
  readonly command: Exclude<NativeMenuCommandId, 'start'>
  readonly group: NativeMenuGroupId
  readonly label: string
}
export type NativeMenuGroup = {
  readonly id: NativeMenuGroupId
  readonly actions: readonly NativeMenuAction[]
  readonly statuses: readonly NativeMenuStatus[]
}
export type NativeMenuModel = {
  readonly host: NativeMenuHost
  readonly groups: readonly NativeMenuGroup[]
}

const ordinary = {
  kind: 'action',
  destructive: false,
  interactive: false,
} as const
const accountId = { id: 'id', kind: 'account-id', required: true } as const
const label = {
  id: 'label',
  kind: 'text',
  required: false,
  protectedEntry: false,
} as const

// Freeze only the closed metadata structure; there is no input to scrub or copy.
function freezeAction(action: NativeMenuAction): NativeMenuAction {
  for (const parameter of action.parameters) {
    if (parameter.kind === 'choice') Object.freeze(parameter.choices)
    if (parameter.kind === 'limit-entries') Object.freeze(parameter.fields)
    Object.freeze(parameter)
  }
  Object.freeze(action.parameters)
  if (action.kind === 'setup-guidance') Object.freeze(action.setupInstructions)
  return Object.freeze(action)
}

const actions: readonly NativeMenuAction[] = Object.freeze(
  (
    [
      {
        ...ordinary,
        id: 'enable',
        command: 'account',
        group: 'Accounts',
        label: 'Enable account',
        parameters: [accountId],
      },
      {
        ...ordinary,
        id: 'disable',
        command: 'account',
        group: 'Accounts',
        label: 'Disable account',
        parameters: [accountId],
      },
      {
        ...ordinary,
        id: 'remove',
        command: 'account',
        group: 'Accounts',
        label: 'Remove account',
        parameters: [accountId],
        destructive: true,
        confirm: 'Remove the selected account from this host?',
      },
      {
        ...ordinary,
        id: 'move-up',
        command: 'account',
        group: 'Accounts',
        label: 'Move account up',
        parameters: [accountId],
      },
      {
        ...ordinary,
        id: 'move-down',
        command: 'account',
        group: 'Accounts',
        label: 'Move account down',
        parameters: [accountId],
      },
      {
        ...ordinary,
        id: 'reset-backoff',
        command: 'account',
        group: 'Accounts',
        label: 'Reset account backoff',
        parameters: [],
      },
      {
        ...ordinary,
        id: 'enrollment-reset',
        command: 'account',
        group: 'Accounts',
        label: 'Reset host enrollment',
        parameters: [],
        destructive: true,
        confirm: 'Clear denied or blocked enrollment state for this host?',
      },
      {
        ...ordinary,
        id: 'add-apikey',
        command: 'account',
        group: 'Accounts',
        label: 'Add API-key fallback',
        interactive: true,
        headlessRefusal: 'interactive-required',
        parameters: [
          { id: 'apiKey', kind: 'text', required: true, protectedEntry: true },
          label,
          {
            id: 'baseURL',
            kind: 'text',
            required: false,
            protectedEntry: false,
          },
          {
            id: 'authHeader',
            kind: 'choice',
            required: false,
            choices: ['authorization-bearer', 'x-api-key'],
          },
        ],
      },
      {
        ...ordinary,
        id: 'add-oauth-start',
        command: 'account',
        group: 'Accounts',
        label: 'Start OAuth sign-in',
        parameters: [],
        interactive: true,
        headlessRefusal: 'interactive-required',
      },
      {
        ...ordinary,
        id: 'add-oauth-finish',
        command: 'account',
        group: 'Accounts',
        label: 'Finish OAuth sign-in',
        parameters: [
          { id: 'code', kind: 'text', required: true, protectedEntry: true },
          label,
        ],
        interactive: true,
        headlessRefusal: 'interactive-required',
      },
      {
        id: 'custody-mode',
        kind: 'setup-guidance',
        command: 'account',
        group: 'Accounts',
        label: 'Custody setup guidance',
        destructive: false,
        interactive: true,
        headlessRefusal: 'offline-required',
        offlineRequired: true,
        parameters: [
          {
            id: 'mode',
            kind: 'choice',
            required: true,
            choices: ['local', 'claustrum'],
          },
        ],
        setupInstructions: [
          'Stop all selected hosts before changing credential authority.',
          'Use the explicit offline setup flow for the selected local or claustrum mode.',
          'This menu only provides guidance; it does not change settings, propose enrollment, or report setup success.',
        ],
      },
      {
        ...ordinary,
        id: 'quota-refresh',
        command: 'quota',
        group: 'Quota',
        label: 'Refresh quota',
        parameters: [],
      },
      {
        ...ordinary,
        id: 'routing-mode',
        command: 'routing',
        group: 'Routing',
        label: 'Routing mode',
        parameters: [
          {
            id: 'mode',
            kind: 'choice',
            required: true,
            choices: ['main-first', 'fallback-first', 'sticky-balanced'],
          },
        ],
      },
      {
        ...ordinary,
        id: 'routing-reset',
        command: 'routing',
        group: 'Routing',
        label: 'Reset routing session',
        parameters: [],
      },
      {
        ...ordinary,
        id: 'killswitch-on',
        command: 'killswitch',
        group: 'Limits',
        label: 'Enable killswitch',
        parameters: [],
      },
      {
        ...ordinary,
        id: 'killswitch-off',
        command: 'killswitch',
        group: 'Limits',
        label: 'Disable killswitch',
        parameters: [],
      },
      {
        ...ordinary,
        id: 'killswitch-set',
        command: 'killswitch',
        group: 'Limits',
        label: 'Set killswitch thresholds',
        parameters: [
          {
            id: 'entries',
            kind: 'limit-entries',
            required: true,
            fields: ['account', 'fh', 'sd', 'scoped?'],
          },
        ],
      },
      {
        ...ordinary,
        id: 'cache-on',
        command: 'cache',
        group: 'Cache',
        label: 'Enable cache',
        parameters: [],
      },
      {
        ...ordinary,
        id: 'cache-off',
        command: 'cache',
        group: 'Cache',
        label: 'Disable cache',
        parameters: [],
      },
      {
        ...ordinary,
        id: 'cache-mode',
        command: 'cache',
        group: 'Cache',
        label: 'Cache mode',
        parameters: [
          {
            id: 'mode',
            kind: 'choice',
            required: true,
            choices: ['explicit', 'automatic', 'hybrid'],
          },
        ],
      },
      {
        ...ordinary,
        id: 'cachekeep-always',
        command: 'cachekeep',
        group: 'Cache',
        label: 'Keep cache warm always',
        parameters: [],
      },
      {
        ...ordinary,
        id: 'cachekeep-off',
        command: 'cachekeep',
        group: 'Cache',
        label: 'Disable cache keep',
        parameters: [],
      },
      {
        ...ordinary,
        id: 'cachekeep-window',
        command: 'cachekeep',
        group: 'Cache',
        label: 'Cache keep window',
        parameters: [
          { id: 'startHour', kind: 'number', required: true },
          { id: 'endHour', kind: 'number', required: true },
        ],
      },
      {
        ...ordinary,
        id: 'cachekeep-subagents',
        command: 'cachekeep',
        group: 'Cache',
        label: 'Cache keep for subagents',
        parameters: [
          {
            id: 'enabled',
            kind: 'choice',
            required: true,
            choices: ['on', 'off'],
          },
        ],
      },
      {
        ...ordinary,
        id: 'dump-on',
        command: 'dump',
        group: 'Diagnostics',
        label: 'Enable request dumps',
        parameters: [],
      },
      {
        ...ordinary,
        id: 'dump-off',
        command: 'dump',
        group: 'Diagnostics',
        label: 'Disable request dumps',
        parameters: [],
      },
      {
        ...ordinary,
        id: 'logging-level',
        command: 'logging',
        group: 'Diagnostics',
        label: 'Logging level',
        parameters: [
          {
            id: 'level',
            kind: 'choice',
            required: true,
            choices: ['error', 'warn', 'info', 'debug', 'trace'],
          },
        ],
      },
      {
        ...ordinary,
        id: 'fast-on',
        command: 'fast',
        group: 'Extras',
        label: 'Enable fast mode',
        parameters: [],
      },
      {
        ...ordinary,
        id: 'fast-off',
        command: 'fast',
        group: 'Extras',
        label: 'Disable fast mode',
        parameters: [],
      },
      {
        ...ordinary,
        id: 'prime-on',
        command: 'prime',
        group: 'Extras',
        label: 'Enable Prime',
        parameters: [],
      },
      {
        ...ordinary,
        id: 'prime-off',
        command: 'prime',
        group: 'Extras',
        label: 'Disable Prime',
        parameters: [],
      },
      {
        ...ordinary,
        id: 'start-fire',
        command: 'start',
        group: 'Extras',
        label: 'Fire lane start',
        parameters: [],
      },
    ] satisfies NativeMenuAction[]
  ).map(freezeAction),
)

const statuses: readonly NativeMenuStatus[] = Object.freeze(
  (
    [
      {
        kind: 'status',
        id: 'account-status',
        command: 'account',
        group: 'Accounts',
        label: 'Account status and usage',
      },
      {
        kind: 'status',
        id: 'quota-status',
        command: 'quota',
        group: 'Quota',
        label: 'Quota summary',
      },
      {
        kind: 'status',
        id: 'routing-status',
        command: 'routing',
        group: 'Routing',
        label: 'Routing status',
      },
      {
        kind: 'status',
        id: 'killswitch-status',
        command: 'killswitch',
        group: 'Limits',
        label: 'Killswitch status',
      },
      {
        kind: 'status',
        id: 'cache-status',
        command: 'cache',
        group: 'Cache',
        label: 'Cache status',
      },
      {
        kind: 'status',
        id: 'cachekeep-status',
        command: 'cachekeep',
        group: 'Cache',
        label: 'Cache keep status',
      },
      {
        kind: 'status',
        id: 'dump-status',
        command: 'dump',
        group: 'Diagnostics',
        label: 'Dump status',
      },
      {
        kind: 'status',
        id: 'logging-status',
        command: 'logging',
        group: 'Diagnostics',
        label: 'Logging status',
      },
      {
        kind: 'status',
        id: 'fast-status',
        command: 'fast',
        group: 'Extras',
        label: 'Fast mode status',
      },
      {
        kind: 'status',
        id: 'prime-status',
        command: 'prime',
        group: 'Extras',
        label: 'Prime quota window status',
      },
    ] satisfies NativeMenuStatus[]
  ).map((status) => Object.freeze(status)),
)

function buildModel(host: NativeMenuHost): NativeMenuModel {
  return Object.freeze({
    host,
    groups: Object.freeze(
      NATIVE_MENU_GROUP_IDS.map((id) =>
        Object.freeze({
          id,
          actions: Object.freeze(
            actions.filter(
              (action) =>
                action.group === id &&
                (host === 'opencode' ||
                  !['quota', 'killswitch', 'prime', 'start'].includes(
                    action.command,
                  )),
            ),
          ),
          statuses: Object.freeze(
            statuses.filter(
              (status) =>
                status.group === id &&
                (host === 'opencode' || status.command !== 'killswitch'),
            ),
          ),
        }),
      ),
    ),
  })
}

const models = Object.freeze({
  opencode: buildModel('opencode'),
  pi: buildModel('pi'),
})

/** Stable frozen metadata, with no current settings or credential material. */
export function getNativeMenuModel(host: NativeMenuHost): NativeMenuModel {
  return models[host]
}
