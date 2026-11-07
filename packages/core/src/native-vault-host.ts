import { logger } from './logger.ts'
import { NativeCustodyError } from './native-custody.ts'

let hosted: boolean | undefined
let changed = false
const listeners = new Set<() => void>()

/** Latches process authority using common-auth's hasVaultHost marker check. Replace only that read with its public export when pinning 0.41.0. */
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
