import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import {
  ACCOUNT_FILE_NAME,
  parseJsonRedacted,
  primeStorageFingerprint,
} from '@cortexkit/anthropic-auth-core'

export function getPiConfigDir(): string {
  return (
    process.env.PI_CODING_AGENT_DIR?.trim() ||
    process.env.PI_AGENT_DIR?.trim() ||
    join(homedir(), '.pi', 'agent')
  )
}

export function getPiAccountStoragePath(): string {
  return (
    process.env.PI_ANTHROPIC_AUTH_FILE?.trim() ||
    join(getPiConfigDir(), ACCOUNT_FILE_NAME)
  )
}

export function getPiClaustrumConnectionOptions(
  storagePath = getPiAccountStoragePath(),
) {
  return {
    storagePath,
    identity: {
      project_root: process.cwd(),
      harness: 'pi',
      session: `store-${primeStorageFingerprint(storagePath)}`,
    },
    connectionFile:
      process.env.PI_ANTHROPIC_AUTH_CLAUSTRUM_CONNECTION_FILE?.trim() ||
      process.env.CLAUSTRUM_SUBC_CONNECTION?.trim() ||
      undefined,
  }
}

/** Read-only metadata inspection; never create or rewrite Pi's credential store. */
export async function hasPiLocalAnthropicOAuth(): Promise<boolean> {
  try {
    const value: unknown = parseJsonRedacted(
      await readFile(join(getPiConfigDir(), 'auth.json'), 'utf8'),
    )
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('Invalid authentication store')
    const credential = (value as Record<string, unknown>).anthropic
    if (credential === undefined) return false
    if (
      !credential ||
      typeof credential !== 'object' ||
      Array.isArray(credential)
    )
      throw new Error('Invalid Anthropic authentication entry')
    const type = (credential as Record<string, unknown>).type
    if (type !== 'oauth' && type !== 'api_key')
      throw new Error('Unknown Anthropic authentication entry')
    return type === 'oauth'
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw new Error('Cannot safely inspect Pi authentication metadata')
  }
}

/** The user must approve removing the host’s Anthropic OAuth credential before the shared account store can serve requests. */
export async function requirePiNativeHostAuth(): Promise<void> {
  if (await hasPiLocalAnthropicOAuth()) {
    throw new Error(
      'Pi still has a host Anthropic OAuth credential. Run offline setup to migrate it and approve its removal before using the native pool.',
    )
  }
}
