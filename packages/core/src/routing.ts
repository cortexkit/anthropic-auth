import type {
  AccountSettingsReaderInput,
  AccountStorage,
  RoutingMode,
} from './accounts.ts'

export const CLAUDE_ROUTING_COMMAND_NAME = 'claude-routing'
export const ROUTING_MODES = [
  'main-first',
  'fallback-first',
  'sticky-balanced',
] as const
export const DEFAULT_ROUTING_MODE: RoutingMode = 'main-first'
export const MAX_SAME_ACCOUNT_WAITS = ['0', '15', 'max'] as const
export type MaxSameAccountWait = (typeof MAX_SAME_ACCOUNT_WAITS)[number]
export const DEFAULT_MAX_SAME_ACCOUNT_WAIT: MaxSameAccountWait = '15'

export function getMaxSameAccountWait(
  storage: AccountSettingsReaderInput | null,
): MaxSameAccountWait {
  const value = storage?.routing?.maxSameAccountWait
  return MAX_SAME_ACCOUNT_WAITS.includes(value as MaxSameAccountWait)
    ? (value as MaxSameAccountWait)
    : DEFAULT_MAX_SAME_ACCOUNT_WAIT
}

const ROUTING_USAGE =
  'Usage: `/claude-routing`, `/claude-routing main-first`, `/claude-routing fallback-first`, `/claude-routing sticky-balanced`, or `/claude-routing reset`.'

type RoutingCommandAction =
  | { type: 'status' }
  | { type: 'mode'; mode: RoutingMode }
  | { type: 'reset' }
  | { type: 'usage' }

function normalizeRoutingMode(value: unknown): RoutingMode {
  return typeof value === 'string' &&
    ROUTING_MODES.includes(value as RoutingMode)
    ? (value as RoutingMode)
    : DEFAULT_ROUTING_MODE
}

export function getRoutingMode(storage: AccountStorage | null): RoutingMode {
  return normalizeRoutingMode(storage?.routing?.mode)
}

export function parseRoutingCommandAction(
  argumentsText: string,
): RoutingCommandAction {
  const tokens = argumentsText.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return { type: 'status' }
  if (tokens.length === 1 && tokens[0] === 'reset') return { type: 'reset' }
  if (tokens.length === 1 && ROUTING_MODES.includes(tokens[0] as RoutingMode)) {
    return { type: 'mode', mode: tokens[0] as RoutingMode }
  }
  if (
    tokens.length === 2 &&
    tokens[0] === 'mode' &&
    ROUTING_MODES.includes(tokens[1] as RoutingMode)
  ) {
    return { type: 'mode', mode: tokens[1] as RoutingMode }
  }
  return { type: 'usage' }
}

function routingDescription(mode: RoutingMode) {
  if (mode === 'fallback-first') {
    return 'Try usable fallback accounts before the main account. If no fallback succeeds, try the main account.'
  }
  if (mode === 'sticky-balanced') {
    return 'Assign each session to a quota-weighted OAuth account, keep it sticky across transient failures, and migrate only for confirmed long-lived exhaustion or permanent account failure.'
  }
  return 'Try the main account first. Use fallback accounts only when quota policy or fallback errors require it.'
}

export function buildRoutingStatusSummary(input?: {
  mode?: RoutingMode
  maxSameAccountWait?: MaxSameAccountWait
}) {
  const mode = input?.mode ?? DEFAULT_ROUTING_MODE
  return [
    '## Claude Routing Status',
    '',
    `- Mode: \`${mode}\``,
    `- Longest wait on the same account: \`${input?.maxSameAccountWait ?? DEFAULT_MAX_SAME_ACCOUNT_WAIT}\``,
    `- Behavior: ${routingDescription(mode)}`,
    '',
    ROUTING_USAGE,
  ].join('\n')
}

export function executeRoutingCommand(input: {
  argumentsText: string
  mode?: RoutingMode
  maxSameAccountWait?: MaxSameAccountWait
}) {
  const action = parseRoutingCommandAction(input.argumentsText)
  const mode = input.mode ?? DEFAULT_ROUTING_MODE
  const maxSameAccountWait = input.maxSameAccountWait
  if (action.type === 'status')
    return buildRoutingStatusSummary({ mode, maxSameAccountWait })
  if (action.type === 'mode') {
    return [
      '## Claude Routing Updated',
      '',
      `Mode updated to \`${action.mode}\`.`,
      '',
      ...buildRoutingStatusSummary({ mode: action.mode, maxSameAccountWait })
        .split('\n')
        .slice(2),
    ].join('\n')
  }
  if (action.type === 'reset') {
    return [
      '## Claude Routing Assignment Reset',
      '',
      'The current session will be assigned again on its next request.',
      '',
      ...buildRoutingStatusSummary({ mode, maxSameAccountWait })
        .split('\n')
        .slice(2),
    ].join('\n')
  }
  return [
    '## Claude Routing Usage',
    '',
    ROUTING_USAGE,
    '',
    ...buildRoutingStatusSummary({ mode, maxSameAccountWait })
      .split('\n')
      .slice(2),
  ].join('\n')
}
