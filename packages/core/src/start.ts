export const CLAUDE_START_COMMAND_NAME = 'claude-start'
export const LANE_START_TEXT =
  '[lane start] — automated cache warm; no response needed.'

const START_STATUS_TITLE = '## Claude Lane Start Status'
const START_QUEUED_TITLE = '## Claude Lane Start Queued'
const START_USAGE_TITLE = '## Claude Lane Start Usage'
const START_USAGE = 'Usage: `/claude-start`.'

export type LaneStartCommandAction = { type: 'fire' } | { type: 'usage' }

export function parseLaneStartCommandAction(
  input: string,
): LaneStartCommandAction {
  const normalized = input.trim().split(/\s+/).filter(Boolean)
  if (normalized.length === 0) return { type: 'fire' }
  return { type: 'usage' }
}

export function executeLaneStartCommand(input: { argumentsText: string }): {
  action: LaneStartCommandAction
  text: string
} {
  const action = parseLaneStartCommandAction(input.argumentsText)
  if (action.type === 'fire') {
    return {
      action,
      text: [
        START_QUEUED_TITLE,
        '',
        '- Queued an explicit lane-start request.',
        '- This is a billed request: the one-token limit does not remove prompt-cache read or write charges.',
      ].join('\n'),
    }
  }
  return {
    action,
    text: [START_USAGE_TITLE, '', START_USAGE, '', START_STATUS_TITLE].join(
      '\n',
    ),
  }
}
