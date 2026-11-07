/** Mirrors common-auth's hasVaultHost; replace with its public export when pinning 0.41.0. */
export function isVaultHosted(): boolean {
  return process.env.CORTEXKIT_VAULT_HOST === 'thalamus'
}
