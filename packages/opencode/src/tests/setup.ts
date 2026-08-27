import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const testDir = mkdtempSync(join(tmpdir(), 'anthropic-auth-opencode-test-'))

process.env.OPENCODE_ANTHROPIC_AUTH_TEST_DIR = testDir
process.env.OPENCODE_ANTHROPIC_AUTH_FILE = join(testDir, 'anthropic-auth.json')
process.env.OPENCODE_ANTHROPIC_AUTH_SIDEBAR_STATE_FILE = join(
  testDir,
  'sidebar-state.json',
)
process.env.OPENCODE_ANTHROPIC_AUTH_CACHEKEEP_REGISTRY_DIR = join(
  testDir,
  'cachekeep-registry',
)
process.env.OPENCODE_ANTHROPIC_AUTH_QUOTA_FEED_DIR = join(
  testDir,
  'quota-header-feed',
)
