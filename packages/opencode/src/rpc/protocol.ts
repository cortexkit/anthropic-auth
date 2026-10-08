import type {
  ClaustrumEnrollmentStatus,
  CommandDialogPayload,
} from '@cortexkit/anthropic-auth-core'

export const COMMAND_MODAL_NAMES = [
  'claude-account',
  'claude-cache',
  'claude-cachekeep',
  'claude-prime',
  'claude-start',
  'claude-quota',
  'claude-dump',
  'claude-fast',
  'claude-routing',
  'claude-killswitch',
  'claude-logging',
] as const

export type CommandModalName = (typeof COMMAND_MODAL_NAMES)[number]

export interface AccountDialogAccount {
  id: string
  label: string
  role: 'main' | 'fallback'
  enabled: boolean
  quotaPercent: number | null
  tierLabel?: string
  claustrumGate: 'on' | 'off' | 'na'
  vaultServed: boolean
  vaultReauth: boolean
  custodyState:
    | 'na'
    | 'off'
    | 'on-vault-served'
    | 'on-vault-reauth'
    | 'on-cold'
    | 'unknown-identity'
    | 'on-identity-mismatch'
    | 'on-corrupt-binding'
}

export interface AccountDialogKnobs {
  accounts: AccountDialogAccount[]
  claustrumDetection: string
  custodyMode?: 'local' | 'claustrum'
  custodyModeKnown?: boolean
  enrollmentStatus?: string
  claustrumEnrollment?: ClaustrumEnrollmentStatus
  [key: string]: unknown
}

export interface OpenDialogPayload {
  command: CommandModalName
  text: string
  knobs: Record<string, unknown>
}

export type RpcNotification = { id: number; sessionId: string } & (
  | { type: 'open-dialog'; payload: OpenDialogPayload }
  | { type: 'open-menu'; payload: CommandDialogPayload }
)

export interface ApplyRequest {
  command: CommandModalName
  arguments: string
  sessionId?: string
}

export interface ApplyResult {
  text: string
  knobs: Record<string, unknown>
}
