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

/** Keep the legacy stash path stable so setup and disconnect remove old saved credentials. */
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

/** Delegate Pi-auth replacement and legacy cleanup to the shared locked writer. */
export function openNativePiAuthSlot(options: NativePiAuthSlotOptions): PiSlot {
  return openPiSlot(nativePiAuthSlotPaths(options))
}

export type NativeVaultDisconnectOptions =
  | { host: 'opencode'; env?: NodeJS.ProcessEnv }
  | { host: 'pi'; env?: NodeJS.ProcessEnv; slot: Pick<PiSlot, 'exitVault'> }

export type NativeVaultDisconnectResult = 'disconnected' | 'idle' | 'busy'

/**
 * Clear Pi's vault placeholder before removing this host's enrollment.
 * No saved sign-in is restored; a new sign-in made through Pi is left alone.
 * OpenCode authentication is never changed by this operation.
 */
export async function disconnectNativeVaultForHost(
  options: NativeVaultDisconnectOptions,
): Promise<NativeVaultDisconnectResult> {
  if (isVaultHosted()) throw new Error(VAULT_HOST_CONNECT_REFUSAL)
  if (options.host === 'pi') await options.slot.exitVault()
  const paths = getHostClaustrumEnrollmentPaths(options.host, options.env)
  const result = await disconnectClaustrumEnrollment(
    paths,
    `anthropic-auth-${options.host}`,
  )
  if (result === 'disconnected' || result === 'idle')
    closeNativeVaultAuthority(paths.tokenPath)
  return result
}
