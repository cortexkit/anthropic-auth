export class CustodyStateMismatchError extends Error {
  readonly code = 'custody_state_mismatch'
  constructor(
    readonly verdict: string,
    readonly dimensions: {
      mode: 'L' | 'C'
      main: 'R' | 'T' | 'X'
      fallbacks: 'R' | 'T' | 'M'
      evidence: 'V' | 'N'
    },
  ) {
    super(`custody state mismatch: ${verdict}`)
  }
  toJSON() {
    return {
      code: this.code,
      verdict: this.verdict,
      dimensions: this.dimensions,
    }
  }
}

/**
 * L/C select local/Claustrum custody. Main R/T/X means stored tokens, an empty
 * activation marker, or neither; fallback R/T/M means local accounts, tokenless
 * vault accounts, or missing roster metadata. V/N marks verified/missing evidence.
 * Only migrated OAuth uses these checks; ordinary OpenCode API keys are untouched.
 * The activation marker enables the provider but cannot authenticate a request.
 * Before each send, validate the local account and current tokens or obtain
 * fresh authorization for that account from the vault.
 */
export function reconcileCustodyStartup(input: {
  mode: 'L' | 'C'
  main: 'R' | 'T' | 'X'
  fallbacks: 'R' | 'T' | 'M'
  evidence: 'V' | 'N'
  authority?: 'committed' | 'retired'
}): { verdict: 'LOCAL_SERVE' | 'CLAUSTRUM_SERVE' } {
  if (input.authority !== 'committed' && input.authority !== 'retired') {
    throw new CustodyStateMismatchError('MIGRATION_REQUIRED', input)
  }
  if (
    input.mode === 'L' &&
    input.main === 'T' &&
    input.fallbacks === 'R' &&
    input.evidence === 'V'
  ) {
    return { verdict: 'LOCAL_SERVE' }
  }
  if (
    input.mode === 'C' &&
    input.main === 'T' &&
    input.fallbacks === 'T' &&
    input.evidence === 'V'
  ) {
    return { verdict: 'CLAUSTRUM_SERVE' }
  }
  throw new CustodyStateMismatchError('FAIL_CLOSED', input)
}
