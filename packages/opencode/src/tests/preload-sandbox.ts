import { afterAll } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

delete process.env.CORTEXKIT_VAULT_HOST

// This must run before setup.ts imports Core. Core's logger and dump modules
// capture default paths at import time; setting TMPDIR in setup.ts is too late.
const testDir = mkdtempSync(join(tmpdir(), 'anthropic-auth-opencode-test-'))

// Feature-specific overrides may be deleted by a test's teardown. The lower
// level defaults must remain inside this sandbox too: Bun caches os.homedir()
// at startup, so setting HOME alone after preload cannot protect auth/config.
const safetyPaths = {
  OPENCODE_ANTHROPIC_AUTH_TEST_DIR: testDir,
  OPENCODE_CONFIG_DIR: join(testDir, 'config'),
  XDG_CONFIG_HOME: join(testDir, 'xdg-config'),
  XDG_DATA_HOME: join(testDir, 'data'),
  XDG_CACHE_HOME: join(testDir, 'cache'),
  XDG_STATE_HOME: join(testDir, 'state'),
  PI_CODING_AGENT_DIR: join(testDir, 'pi-agent'),
  XDG_RUNTIME_DIR: join(testDir, 'runtime'),
  HOME: testDir,
  TMPDIR: testDir,
  OPENCODE_ANTHROPIC_AUTH_FILE: join(testDir, 'anthropic-auth.json'),
  OPENCODE_ANTHROPIC_AUTH_LOG_FILE: join(testDir, 'auth.log'),
  OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE: join(
    testDir,
    'opencode-enrollment.json',
  ),
  OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_CONNECTION_FILE: join(
    testDir,
    'unavailable-subc-connection.json',
  ),
  OPENCODE_ANTHROPIC_AUTH_SIDEBAR_STATE_FILE: join(
    testDir,
    'sidebar-state.json',
  ),
  OPENCODE_ANTHROPIC_AUTH_CACHEKEEP_REGISTRY_DIR: join(
    testDir,
    'cachekeep-registry',
  ),
  OPENCODE_ANTHROPIC_AUTH_QUOTA_FEED_DIR: join(testDir, 'quota-header-feed'),
  OPENCODE_ANTHROPIC_AUTH_RPC_DIR: join(testDir, 'rpc'),
  OPENCODE_ANTHROPIC_AUTH_DUMP_DIR: join(testDir, 'dumps'),
} as const

export function restoreTestSafetyPaths() {
  for (const [key, value] of Object.entries(safetyPaths)) {
    process.env[key] = value
  }
}

restoreTestSafetyPaths()

afterAll(async () => {
  await rm(testDir, { recursive: true, force: true }).catch(() => {})
})
