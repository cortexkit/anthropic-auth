import { logger } from './logger.ts'
import { NativeCustodyError } from './native-custody.ts'

let hosted: boolean | undefined
let changed = false
const listeners = new Set<() => void>()

/**
 * Latches the Thalamus vault-host marker for the life of the process. The read
 * mirrors common-auth's `hasVaultHost()`, which the pinned common-auth doesn't
 * export yet. A later change of the marker refuses every request until restart.
 */
export function isVaultHosted(): boolean {
  const observed = process.env.CORTEXKIT_VAULT_HOST === 'thalamus'
  hosted ??= observed
  if (!changed && observed !== hosted) {
    changed = true
    logger.warn('claustrum', 'Vault host authority changed; restart required')
    for (const stop of listeners) {
      try {
        stop()
      } catch {
        // A failed client close must not reopen authority or prevent other closes.
      }
    }
  }
  if (changed) throw new NativeCustodyError('route-unavailable')
  return hosted
}

/** Final synchronous admission fence after awaited reads and before credential use or publication. */
export function assertHostAuthorityStable(): void {
  isVaultHosted()
}

/** Cancel owned relay work as soon as any operation observes an authority change. */
export function onHostAuthorityChanged(stop: () => void): () => void {
  listeners.add(stop)
  return () => listeners.delete(stop)
}

/** Test-only process restart seam. Production callers must restart instead. */
export function resetVaultHostAuthorityForTests(): void {
  hosted = undefined
  changed = false
}
