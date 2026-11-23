import { expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import {
  getAccountStoragePath,
  getDefaultCacheKeepRegistryDirectory,
  getDumpDirectory,
  getLogFilePath,
  resolveClaustrumConnectionPath,
} from '@cortexkit/anthropic-auth-core'
import { getRpcDir } from '../rpc/rpc-dir.ts'
import { getOpenCodeAuthPath, getPiAuthPath } from '../setup/paths.ts'
import {
  DEFAULT_SIDEBAR_STATE,
  getSidebarStateFile,
  setSidebarState,
} from '../sidebar-state.ts'

const FEATURE_OVERRIDES = [
  'OPENCODE_ANTHROPIC_AUTH_FILE',
  'OPENCODE_ANTHROPIC_AUTH_SIDEBAR_STATE_FILE',
  'OPENCODE_ANTHROPIC_AUTH_CACHEKEEP_REGISTRY_DIR',
  'OPENCODE_ANTHROPIC_AUTH_RPC_DIR',
  'OPENCODE_ANTHROPIC_AUTH_DUMP_DIR',
] as const

test('feature-path overrides deleted by a test cannot resolve outside the preload sandbox', async () => {
  const root = process.env.OPENCODE_ANTHROPIC_AUTH_TEST_DIR
  const connectionFile =
    process.env.OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_CONNECTION_FILE
  if (!root || !connectionFile)
    throw new Error('OpenCode test preload is missing')
  const saved = FEATURE_OVERRIDES.map(
    (name) => [name, process.env[name]] as const,
  )
  try {
    for (const name of FEATURE_OVERRIDES) delete process.env[name]
    for (const path of [
      getAccountStoragePath(),
      getOpenCodeAuthPath(),
      getPiAuthPath(),
      getSidebarStateFile(),
      getDefaultCacheKeepRegistryDirectory('opencode'),
      getRpcDir('/tmp/hostile-project'),
      getDumpDirectory(),
      getLogFilePath(),
    ]) {
      expect(path.startsWith(`${root}/`), path).toBe(true)
    }
    expect(resolveClaustrumConnectionPath()).toBe(connectionFile)
    const lastUpdated = Date.now()
    await setSidebarState({ ...DEFAULT_SIDEBAR_STATE, lastUpdated })
    const persisted = JSON.parse(await readFile(getSidebarStateFile(), 'utf8'))
    expect(persisted.lastUpdated).toBe(lastUpdated)
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
})
