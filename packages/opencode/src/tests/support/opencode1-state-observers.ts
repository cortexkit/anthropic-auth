import { watch } from 'node:fs'
import { dirname, join } from 'node:path'
import type {
  AccountStorage,
  OAuthQuotaSnapshot,
} from '@cortexkit/anthropic-auth-core'
import {
  createNativeAccountRuntime,
  createNativePoolStore,
} from '@cortexkit/anthropic-auth-core'
import {
  fromNativeQuotaMap,
  nativeQuotaCodec,
} from '../../../../core/src/native-quota-codec.ts'
import { readLegacyJson } from '../../../../core/src/tests/legacy-account-fixture.ts'
import {
  getSidebarState,
  getSidebarStateFile,
  setSidebarState,
} from '../../sidebar-state'
import { STATE_READ_PAUSE_MS } from './opencode1-pool-fixture.ts'
import {
  type Opencode1TestContext,
  onSidebarWrite,
  untilStateOrTestEnd,
} from './opencode1-test-context.ts'

export { STATE_READ_PAUSE_MS }

export function restoreProcessTestFiles() {
  const testDir = process.env.OPENCODE_ANTHROPIC_AUTH_TEST_DIR
  if (!testDir) return
  process.env.OPENCODE_ANTHROPIC_AUTH_FILE = join(
    testDir,
    'anthropic-auth.json',
  )
  process.env.OPENCODE_ANTHROPIC_AUTH_SIDEBAR_STATE_FILE = join(
    testDir,
    'sidebar-state.json',
  )
  process.env.OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE = join(
    testDir,
    'opencode-enrollment.json',
  )
  process.env.OPENCODE_ANTHROPIC_AUTH_CACHEKEEP_REGISTRY_DIR = join(
    testDir,
    'cachekeep-registry',
  )
}

/**
 * Wait for the plugin's sidebar write that satisfies `predicate`: the state
 * file is re-read after each completed sidebar write (sidebar-state's
 * after-rename hook), never after a fixed number of polls.
 */
export async function waitForSidebarState(
  ctx: Opencode1TestContext,
  predicate: (state: Awaited<ReturnType<typeof getSidebarState>>) => boolean,
) {
  const changes = untilStateOrTestEnd(ctx)
  const stopListening = onSidebarWrite(
    ctx,
    getSidebarStateFile(),
    changes.notify,
  )
  try {
    while (!changes.ended) {
      await changes.next()
      const state = await getSidebarState()
      if (predicate(state)) return state
    }
  } finally {
    stopListening()
    changes.close()
  }
  const state = await getSidebarState()
  throw new Error(`Sidebar state did not match: ${JSON.stringify(state)}`)
}

/**
 * The account storage a plugin process sees. For a migrated pool this is the
 * native runtime's AccountStorage-shaped projection (settings, account
 * metadata and quota, never credential material), the same view the plugin
 * reads; migration retires the legacy files. Without a migrated pool it is
 * the unmigrated legacy store.
 */
export async function readAccountStorage(
  ctx: Opencode1TestContext,
): Promise<AccountStorage | null> {
  const pool = ctx.migratedPool
  if (!pool) {
    const file = process.env.OPENCODE_ANTHROPIC_AUTH_FILE
    if (!file)
      throw new Error(
        'Missing OPENCODE_ANTHROPIC_AUTH_FILE for unmigrated storage read',
      )
    return readLegacyJson<AccountStorage>(file)
  }
  const runtime = createNativeAccountRuntime({
    paths: pool.paths,
    host: 'opencode',
  })
  try {
    return (await runtime.read()).policyStorage
  } finally {
    runtime.close()
  }
}

/**
 * Wait for an account storage write that satisfies `predicate`, re-reading
 * the pool (or the unmigrated legacy store) until it matches or the test ends.
 */
export async function waitForAccountStorage(
  ctx: Opencode1TestContext,
  predicate: (storage: AccountStorage | null) => boolean,
) {
  const changes = untilStateOrTestEnd(ctx, STATE_READ_PAUSE_MS)
  try {
    while (!changes.ended) {
      await changes.next()
      const storage = await readAccountStorage(ctx)
      if (predicate(storage)) return storage
    }
  } finally {
    changes.close()
  }
  const storage = await readAccountStorage(ctx)
  throw new Error(`Account storage did not match: ${JSON.stringify(storage)}`)
}

/** Wait on pool file changes, not an in-memory cache event, when asserting disk quota. */
export async function waitForNativePoolQuota(
  ctx: Opencode1TestContext,
  routeId: string,
  predicate: (quota: OAuthQuotaSnapshot | undefined) => boolean,
  options: { keepAliveUntil?: Promise<unknown> } = {},
): Promise<OAuthQuotaSnapshot | undefined> {
  const pool = ctx.migratedPool
  if (!pool) throw new Error('This test has no migrated pool')
  const changes = untilStateOrTestEnd(ctx)
  const directories = new Set([
    dirname(pool.paths.config),
    dirname(pool.paths.state),
  ])
  const watchers: Array<ReturnType<typeof watch>> = []
  const reader = createNativePoolStore({
    paths: pool.paths,
    quota: nativeQuotaCodec,
  })
  let quota: OAuthQuotaSnapshot | undefined
  try {
    // Keep a live event source while waiting for the store's unref'ed flush timer.
    for (const directory of directories)
      watchers.push(watch(directory, changes.notify))
    while (!changes.ended) {
      await changes.next()
      const [loaded, settings] = await Promise.all([
        reader.read(),
        reader.readSettings(),
      ])
      const id =
        routeId === 'main' && settings.status === 'ready'
          ? settings.settings.mainAccountId
          : routeId
      const raw =
        loaded.status === 'ready'
          ? loaded.rows.find((row) => row.id === id)?.quota
          : undefined
      quota = raw === undefined ? undefined : fromNativeQuotaMap(raw)
      if (predicate(quota)) {
        // The quota commit can precede another publication the caller awaits.
        // Keep the live event source until that publication has also finished.
        if (options.keepAliveUntil) await options.keepAliveUntil
        return quota
      }
    }
  } finally {
    for (const watcher of watchers) watcher.close()
    changes.close()
    await reader.close()
  }
  throw new Error(`Pool quota did not match: ${JSON.stringify(quota)}`)
}

export async function seedSidebarRouting(
  activeId: string,
  route: string,
  lastUpdated: number,
) {
  await setSidebarState({
    ...(await getSidebarState()),
    activeId,
    route,
    lastUpdated,
  })
}

export async function waitForMockCall(fn: { mock?: { calls: unknown[] } }) {
  for (let attempt = 0; attempt < 50; attempt++) {
    if ((fn.mock?.calls.length ?? 0) > 0) return
    await Bun.sleep(10)
  }
}
