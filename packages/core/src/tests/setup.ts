import { afterEach, beforeEach } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

delete process.env.CORTEXKIT_VAULT_HOST

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
  process.env.OPENCODE_ANTHROPIC_AUTH_QUOTA_FEED_DIR = join(
    testDir,
    'quota-header-feed',
  )
  process.env.OPENCODE_ANTHROPIC_AUTH_LOG_FILE = join(testDir, 'auth.log')
  const authority = await import('../native-vault-host.ts')
  authority.resetVaultHostAuthorityForTests?.()
})

afterEach(async () => {
  if (testDir) await rm(testDir, { recursive: true, force: true })
  testDir = undefined
  delete process.env.OPENCODE_ANTHROPIC_AUTH_FILE
  delete process.env.OPENCODE_ANTHROPIC_AUTH_QUOTA_FEED_DIR
  delete process.env.OPENCODE_ANTHROPIC_AUTH_LOG_FILE
})
