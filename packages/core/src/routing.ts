import {
  type AccountStorage,
  createEmptyStorage,
  getAccountStoragePath,
  loadAccounts,
  type RoutingMode,
  saveAccounts,
} from './accounts.ts'

export const CLAUDE_ROUTING_COMMAND_NAME = 'claude-routing'
export const ROUTING_MODES = ['main-first', 'fallback-first'] as const
export const DEFAULT_ROUTING_MODE: RoutingMode = 'main-first'

const ROUTING_USAGE =
  'Usage: `/claude-routing`, `/claude-routing main-first`, or `/claude-routing fallback-first`.'

type RoutingCommandAction =
  | { type: 'status' }
  | { type: 'mode'; mode: RoutingMode }
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

export async function setRoutingMode(
  mode: RoutingMode,
  path = getAccountStoragePath(),
) {
  const storage = (await loadAccounts(path)) ?? createEmptyStorage()
  storage.routing = {
    ...(storage.routing ?? {}),
    mode,
  }
  await saveAccounts(storage, path)
  return storage
}

export function parseRoutingCommandAction(
  argumentsText: string,
): RoutingCommandAction {
  const tokens = argumentsText.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return { type: 'status' }
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
  return 'Try the main account first. Use fallback accounts only when quota policy or fallback errors require it.'
}

export function buildRoutingStatusSummary(input?: { mode?: RoutingMode }) {
  const mode = input?.mode ?? DEFAULT_ROUTING_MODE
  return [
    '## Claude Routing Status',
    '',
    `- Mode: \`${mode}\``,
    `- Behavior: ${routingDescription(mode)}`,
    '',
    ROUTING_USAGE,
  ].join('\n')
}

export function executeRoutingCommand(input: {
  argumentsText: string
  mode?: RoutingMode
}) {
  const action = parseRoutingCommandAction(input.argumentsText)
  const mode = input.mode ?? DEFAULT_ROUTING_MODE
  if (action.type === 'status') return buildRoutingStatusSummary({ mode })
  if (action.type === 'mode') {
    return [
      '## Claude Routing Updated',
      '',
      `Mode updated to \`${action.mode}\`.`,
      '',
      ...buildRoutingStatusSummary({ mode: action.mode }).split('\n').slice(2),
    ].join('\n')
  }
  return [
    '## Claude Routing Usage',
    '',
    ROUTING_USAGE,
    '',
    ...buildRoutingStatusSummary({ mode }).split('\n').slice(2),
  ].join('\n')
}
