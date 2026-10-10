import {
  type AccountCommandResult,
  CLAUSTRUM_PI_ENROLLMENT_NAME,
  type ClaustrumEnrollmentStatus,
  type ClaustrumMode,
  getHostClaustrumEnrollmentPaths,
  readClaustrumEnrollmentStatus,
  resetClaustrumEnrollmentState,
} from '@cortexkit/anthropic-auth-core'

export async function requirePiEnrollment() {
  const status = await readClaustrumEnrollmentStatus(
    getHostClaustrumEnrollmentPaths('pi'),
    CLAUSTRUM_PI_ENROLLMENT_NAME,
  )
  if (
    status.state !== 'approved' ||
    status.proposedName !== CLAUSTRUM_PI_ENROLLMENT_NAME
  ) {
    throw new Error(
      'Pi requires its own approved Claustrum enrollment; run setup',
    )
  }
  return status
}

export interface PiCustodyCommands {
  transition(mode: ClaustrumMode): Promise<AccountCommandResult>
  status(): Promise<ClaustrumEnrollmentStatus>
  reset(): Promise<AccountCommandResult>
}

export function createPiCustodyCommands(): PiCustodyCommands {
  const paths = () => getHostClaustrumEnrollmentPaths('pi')
  return {
    status: () =>
      readClaustrumEnrollmentStatus(paths(), CLAUSTRUM_PI_ENROLLMENT_NAME),
    async reset() {
      const result = await resetClaustrumEnrollmentState(
        paths(),
        CLAUSTRUM_PI_ENROLLMENT_NAME,
      )
      const messages = {
        reset:
          'Terminal enrollment state cleared. Run setup to enroll Pi again.',
        idle: 'Pi has no enrollment state to reset.',
        'refused-pending': 'Refused: Pi enrollment is still pending.',
        'refused-approved':
          'Refused: Pi already has an approved enrollment token.',
        busy: 'Pi enrollment is busy in another process.',
      }
      return { text: messages[result] }
    },
    async transition(mode) {
      // Mode changes can remove host credentials and require offline consent.
      // A menu never enrolls, grants custody or writes the authority journal.
      return {
        text: `Refused: Changing Pi authentication to ${mode} requires offline setup. Run \`bunx @cortexkit/opencode-anthropic-auth setup\` and review the migration and host OAuth removal consent.`,
      }
    },
  }
}
