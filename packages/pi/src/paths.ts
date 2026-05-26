import { homedir } from 'node:os'
import { join } from 'node:path'

import { ACCOUNT_FILE_NAME } from '@marcusrbrown/anthropic-auth-core'

export function getPiConfigDir(): string {
  return process.env.PI_AGENT_DIR?.trim() || join(homedir(), '.pi', 'agent')
}

export function getPiAccountStoragePath(): string {
  return (
    process.env.PI_ANTHROPIC_AUTH_FILE?.trim() ||
    join(getPiConfigDir(), ACCOUNT_FILE_NAME)
  )
}
