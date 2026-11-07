import {
  type AccountCommandResult,
  CLAUSTRUM_PI_ENROLLMENT_NAME,
  type ClaustrumEnrollmentStatus,
  type ClaustrumMode,
  getHostClaustrumEnrollmentPaths,
  isVaultHosted,
  readClaustrumEnrollmentStatus,
  resetClaustrumEnrollmentState,
  VAULT_HOST_CONNECT_REFUSAL,
} from '@cortexkit/anthropic-auth-core'

export async function requirePiEnrollment() {
  if (isVaultHosted()) throw new Error(VAULT_HOST_CONNECT_REFUSAL)
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
    status: () => {
      if (isVaultHosted()) throw new Error(VAULT_HOST_CONNECT_REFUSAL)
      return readClaustrumEnrollmentStatus(
        paths(),
        CLAUSTRUM_PI_ENROLLMENT_NAME,
      )
    },
    async reset() {
      if (isVaultHosted())
        return { text: `Refused: ${VAULT_HOST_CONNECT_REFUSAL}` }
      const result = await resetClaustrumEnrollmentState(
        paths(),
        CLAUSTRUM_PI_ENROLLMENT_NAME,
      )
      const messages = {
        reset:
          'Terminal enrollment state cleared. Run setup to enroll Pi again.',
        idle: 'Pi has no enrollment state to reset.',
        // A pending state may hold a request the vault already stored under
        // this secret; setup replays that secret to resume it. The "Refused:"
        // prefix is how the Pi menu marks the action as not done.
        'refused-pending':
          'Refused: An enrollment request may still be in progress. Quit Pi and run setup again; it picks up the same request.',
        'refused-approved':
          'Refused: Pi already has an approved enrollment token.',
        busy: 'Pi enrollment is busy in another process.',
      }
      return { text: messages[result] }
    },
    async transition(mode) {
      if (isVaultHosted())
        return { text: `Refused: ${VAULT_HOST_CONNECT_REFUSAL}` }
      // Mode changes can remove host credentials and require offline consent.
      // A menu never enrolls, grants custody or writes the authority journal.
      return {
        text: `Refused: Changing Pi authentication to ${mode} requires offline setup. Run \`npx @cortexkit/opencode-anthropic-auth setup\` and review the migration and host OAuth removal consent.`,
      }
    },
  }
}
