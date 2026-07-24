export const CLAUDE_FAST_COMMAND_NAME = 'claude-fast'

const FAST_STATUS_TITLE = '## Claude Fast Mode Status'
const FAST_ENABLED_TITLE = '## Claude Fast Mode Enabled'
const FAST_DISABLED_TITLE = '## Claude Fast Mode Disabled'
const FAST_USAGE_TITLE = '## Claude Fast Mode Usage'
const FAST_USAGE =
  'Usage: `/claude-fast`, `/claude-fast on`, or `/claude-fast off`.'

let fastModeEnabled = false

export type FastModeCommandAction =
  | { type: 'status' }
  | { type: 'enable' }
  | { type: 'disable' }
  | { type: 'usage' }

export function isFastModeEnabled() {
  return fastModeEnabled
}

export function setFastModeEnabled(enabled: boolean) {
  fastModeEnabled = enabled
}

export function resetFastModeState() {
  fastModeEnabled = false
}

export function parseFastModeCommandAction(
  argumentsText: string,
): FastModeCommandAction {
  const normalized = argumentsText.trim().split(/\s+/).filter(Boolean)
  if (normalized.length === 0) return { type: 'status' }
  if (normalized.length === 1 && normalized[0] === 'on')
    return { type: 'enable' }
  if (normalized.length === 1 && normalized[0] === 'off')
    return { type: 'disable' }
  return { type: 'usage' }
}

export function buildFastModeStatusSummary(input?: { enabled?: boolean }) {
  const enabled = input?.enabled ?? fastModeEnabled
  return [
    FAST_STATUS_TITLE,
    '',
    `- Enabled: ${enabled ? 'enabled' : 'disabled'}`,
    '- Persisted: ~/.config/opencode/anthropic-auth.json',
    '- Scope: adds Anthropic fast mode to supported Opus requests',
    '- Supported models: claude-opus-4-6, claude-opus-4-7, claude-opus-4-8, and claude-opus-5',
    '- Request changes: adds `speed: "fast"` and the `fast-mode-2026-02-01` beta header',
    '- Note: fast and standard speeds do not share prompt-cache prefixes',
  ].join('\n')
}

export function executeFastModeCommand(input: {
  argumentsText: string
  enabled?: boolean
}) {
  const action = parseFastModeCommandAction(input.argumentsText)
  const enabled = input.enabled ?? fastModeEnabled

  if (action.type === 'status') return buildFastModeStatusSummary({ enabled })

  if (action.type === 'enable') {
    return [
      FAST_ENABLED_TITLE,
      '',
      buildFastModeStatusSummary({ enabled: true }),
    ].join('\n')
  }

  if (action.type === 'disable') {
    return [
      FAST_DISABLED_TITLE,
      '',
      buildFastModeStatusSummary({ enabled: false }),
    ].join('\n')
  }

  return [
    FAST_USAGE_TITLE,
    '',
    FAST_USAGE,
    '',
    buildFastModeStatusSummary({ enabled }),
  ].join('\n')
}
