import { dirname, join, resolve } from 'node:path'
import {
  disconnectClaustrumEnrollment,
  VAULT_HOST_CONNECT_REFUSAL,
} from '@cortexkit/common-auth/claustrum'
import { placeholderSecret } from '@cortexkit/common-auth/opencode2'
import { openPiSlot, type PiSlot } from '@cortexkit/common-auth/pi-slot'
import { getHostClaustrumEnrollmentPaths } from './claustrum-enrollment.ts'
import { isVaultHosted } from './native-vault-host.ts'
import { closeNativeVaultAuthority } from './native-vault-invalidation.ts'

export type {
  PiSlot as NativePiAuthSlot,
  PiSlotErrorCode as NativePiAuthSlotErrorCode,
  PiSlotInspection as NativePiAuthSlotInspection,
} from '@cortexkit/common-auth/pi-slot'
export { PiSlotError as NativePiAuthSlotError } from '@cortexkit/common-auth/pi-slot'

export interface NativePiAuthSlotOptions {
  /** The Pi adapter supplies its SDK-owned auth path; enrollment paths do not identify that file. */
  authPath: string
  env?: NodeJS.ProcessEnv
}

/** Setup and disconnect must use the same host auth file, private stash and inert API-key marker. */
export function nativePiAuthSlotPaths(options: NativePiAuthSlotOptions) {
  return {
    authPath: resolve(options.authPath),
    stashPath: join(
      dirname(getHostClaustrumEnrollmentPaths('pi', options.env).tokenPath),
      'pi-auth-slot',
      'anthropic.json',
    ),
    provider: 'anthropic',
    placeholderKey: placeholderSecret('anthropic'),
  }
}

/** Delegate private Pi-auth preservation to the shared locked writer; never create a second host-slot writer. */
export function openNativePiAuthSlot(options: NativePiAuthSlotOptions): PiSlot {
  return openPiSlot(nativePiAuthSlotPaths(options))
}

export type NativeVaultDisconnectOptions =
  | { host: 'opencode'; env?: NodeJS.ProcessEnv }
  | { host: 'pi'; env?: NodeJS.ProcessEnv; slot: Pick<PiSlot, 'exitVault'> }

export type NativeVaultDisconnectResult =
  | 'disconnected'
  | 'idle'
  | 'busy'
  | 'conflict'

/**
 * Restore Pi's stored authentication before removing this host's enrollment.
 * A conflicting replacement belongs to the user: leave both it and enrollment
 * intact rather than selecting local custody with unresolved recovery data.
 * OpenCode authentication is never changed by this operation.
 */
export async function disconnectNativeVaultForHost(
  options: NativeVaultDisconnectOptions,
): Promise<NativeVaultDisconnectResult> {
  if (isVaultHosted()) throw new Error(VAULT_HOST_CONNECT_REFUSAL)
  if (options.host === 'pi' && (await options.slot.exitVault()) === 'conflict')
    return 'conflict'
  const paths = getHostClaustrumEnrollmentPaths(options.host, options.env)
  const result = await disconnectClaustrumEnrollment(
    paths,
    `anthropic-auth-${options.host}`,
  )
  if (result === 'disconnected' || result === 'idle')
    closeNativeVaultAuthority(paths.tokenPath)
  return result
}
