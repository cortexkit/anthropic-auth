import { afterEach, beforeEach } from 'bun:test'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  type RefusalFallbackMode,
  resetCache1hState,
  resetClaudeCodeIdentityCachesForTest,
  resetDumpState,
  resetFastModeState,
} from '@cortexkit/anthropic-auth-core'
import { resetNotificationsForTest } from '../../rpc/notifications'
import {
  __setInitialSidebarRoutingTestHooks,
  drainSidebarWrites,
  __setSidebarStateWriteTestHooks as installSidebarStateWriteHooks,
} from '../../sidebar-state'
import {
  createFallbackStorage,
  useTempAccountFile,
} from './opencode1-pool-fixture.ts'
import { restoreProcessTestFiles } from './opencode1-state-observers.ts'
import {
  drainBeforeReset,
  getBodyLifetime,
  type Opencode1TestContext,
} from './opencode1-test-context.ts'

export async function setUserRefusalFallbackMode(
  ctx: Opencode1TestContext,
  mode: RefusalFallbackMode,
) {
  if (!ctx.tempConfigDir)
    throw new Error('Missing test configuration directory')
  const path = join(ctx.tempConfigDir, 'refusal-settings.jsonc')
  await writeFile(path, JSON.stringify({ refusal_fallback: mode }))
  const previous = process.env.ANTHROPIC_AUTH_SETTINGS_FILE
  process.env.ANTHROPIC_AUTH_SETTINGS_FILE = path
  getBodyLifetime(ctx).deferCleanup(() => {
    if (previous === undefined) delete process.env.ANTHROPIC_AUTH_SETTINGS_FILE
    else process.env.ANTHROPIC_AUTH_SETTINGS_FILE = previous
  })
}

/**
 * Opt-in setup hooks that reset caches, dump state, fast-mode state,
 * notifications and sidebar hooks, configure the profile/fallback
 * environment, and create an empty migrated fixture. Register once per
 * describe block or test file. Teardown drains the test body's lifetime,
 * or the context's test lifetime when no body lifetime exists, before
 * restoring fetch, Math.random and Date.now.
 */
export function installLoaderSetup(ctx: Opencode1TestContext) {
  const originalFetch = globalThis.fetch
  const originalRandom = Math.random
  const originalDateNow = Date.now

  beforeEach(async () => {
    ctx.pluginRuntimeOverrides = {}
    Math.random = originalRandom
    Date.now = originalDateNow
    resetCache1hState()
    resetDumpState()
    resetFastModeState()
    resetNotificationsForTest()
    __setInitialSidebarRoutingTestHooks(null)
    installSidebarStateWriteHooks(null)
    // Clear the context's sidebar hook maps alongside the global hooks so a
    // previous test's listeners cannot observe the next test's writes.
    ctx.testSidebarWriteHooks.clear()
    ctx.sidebarWriteListeners.clear()
    process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION = '1'
    await useTempAccountFile(ctx, createFallbackStorage({ accounts: [] }))
  })

  afterEach(async () => {
    await drainBeforeReset(
      getBodyLifetime(ctx) ?? ctx.testLifetime,
      async () => {
        globalThis.fetch = originalFetch
        ctx.pluginRuntimeOverrides = {}
        Math.random = originalRandom
        Date.now = originalDateNow
        resetNotificationsForTest()
        __setInitialSidebarRoutingTestHooks(null)
        installSidebarStateWriteHooks(null)
        ctx.testSidebarWriteHooks.clear()
        ctx.sidebarWriteListeners.clear()
        delete process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION
        await drainSidebarWrites()
        restoreProcessTestFiles()
        ctx.tempConfigDir = undefined
      },
    )
  })

  beforeEach(() => {
    resetClaudeCodeIdentityCachesForTest()
  })
}
