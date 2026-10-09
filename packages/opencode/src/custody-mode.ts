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
 * Native OAuth startup requires a completed migration, an inert host auth
 * marker and verified credential storage. Local mode requires local account
 * rows; vault mode requires a token-free account inventory. Other combinations
 * refuse startup. The letter dimensions describe those states in diagnostics.
 * Ordinary OpenCode API keys remain untouched. The host marker enables the
 * provider but cannot authenticate: each send still validates local credentials
 * or gets fresh authorization for the selected vault account.
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
