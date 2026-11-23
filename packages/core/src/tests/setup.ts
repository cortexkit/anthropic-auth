import { afterEach, beforeEach } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

delete process.env.CORTEXKIT_VAULT_HOST

// Tests keep their account stores in temporary folders chosen with
// environment variables, never in the operating system account's default
// place, so every test starts with the relay location check skipped. Tests of
// that check install their own value; the next test starts from this again.
const RELAY_ACCOUNT_HOME = Symbol.for(
  'cortexkit.anthropic-auth.test-only.relay-account-home',
)
const relayAccountHome = globalThis as Record<symbol, unknown>
relayAccountHome[RELAY_ACCOUNT_HOME] = 'unchecked'
beforeEach(() => {
  relayAccountHome[RELAY_ACCOUNT_HOME] = 'unchecked'
})

let testDir: string | undefined

beforeEach(async () => {
  delete process.env.CORTEXKIT_VAULT_HOST
  testDir = await mkdtemp(join(tmpdir(), 'anthropic-auth-core-test-'))
  process.env.OPENCODE_ANTHROPIC_AUTH_FILE = join(
    testDir,
    'anthropic-auth.json',
  )
  // The state file is left to derive beside whichever config path a test uses: an explicit
  // STATE_FILE overrides that derivation for every caller, which would redirect tests that
  // pass their own storage path (and their spawned worker processes) to a shared file.
  process.env.OPENCODE_ANTHROPIC_AUTH_LOG_FILE = join(testDir, 'auth.log')
  const authority = await import('../native-vault-host.ts')
  authority.resetVaultHostAuthorityForTests?.()
})

afterEach(async () => {
  if (testDir) await rm(testDir, { recursive: true, force: true })
  testDir = undefined
  delete process.env.OPENCODE_ANTHROPIC_AUTH_FILE
  delete process.env.OPENCODE_ANTHROPIC_AUTH_LOG_FILE
})
