import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  acquireNativeAccountRuntime,
  resolveNativePoolPaths,
  runNativeMigration,
} from '@cortexkit/anthropic-auth-core'
import type { Plugin } from '@opencode/plugin'
import { setupAnthropicAuth } from '../v2/setup'

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'oc2-quota-shutdown-'))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  const paths = await resolveNativePoolPaths(
    join(directory, 'accounts.json'),
    join(directory, 'state.json'),
  )
  await writeFile(
    paths.legacyConfig,
    JSON.stringify({ version: 1, accounts: [] }),
  )
  await writeFile(
    paths.legacyState,
    JSON.stringify({ version: 1, accounts: {} }),
  )
  await runNativeMigration({
    paths,
    host: 'opencode',
    hostAuthPath: join(directory, 'auth.json'),
    routingSourcePath: join(directory, 'old-routing.json'),
    routingDestinationPath: join(directory, 'routing.json'),
    env: {},
    processFence: async () => {},
    removePiAnthropicAuth: false,
  })
  const registration = { dispose: async () => {} }
  const ctx = {
    session: {
      get: async () => ({ parentID: undefined }),
      hook: async () => registration,
    },
    model: { transform: async () => registration },
    provider: { transform: async () => registration },
    integration: { transform: async () => registration },
    rpc: {
      register: async () => ({
        ...registration,
        events: { emit: async () => {} },
      }),
    },
    command: { transform: async () => registration },
    event: { subscribe: async function* () {} },
  } as unknown as Plugin.Context
  // The test leases the plugin's account runtime with these same options, so
  // both handles share one runtime and one set of pending quota writes.
  const vault = {
    env: {
      OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE: join(
        directory,
        'enrollment.json',
      ),
    },
  }
  let disposed: Promise<void> | undefined
  const cleanup = await setupAnthropicAuth(ctx, {
    paths,
    vault,
    fetch: (async () => Response.json({})) as unknown as typeof fetch,
  })
  const dispose = () => {
    disposed ??= Promise.resolve(cleanup())
    return disposed
  }
  cleanups.push(dispose)
  const lease = acquireNativeAccountRuntime({ paths, host: 'opencode', vault })
  cleanups.push(() => lease.close())
  return { dispose, lease }
}

test('OpenCode 2 disposal waits for a pending quota write before closing its runtime', async () => {
  const { dispose, lease } = await fixture()
  const checkedAt = Date.now()
  const write = Promise.withResolvers<void>()
  const order: string[] = []
  const published = lease.quotaObservations.publish(
    'main',
    {
      lineage: 'synthetic-lineage',
      accountUuid: '11111111-2222-4333-8444-555555555555',
      entry: {
        quota: {
          five_hour: { usedPercent: 10, remainingPercent: 90, checkedAt },
          checkedAt,
          source: 'poll',
        },
        checkedAt,
        refreshAfter: checkedAt,
      },
      generalExhausted: false,
    },
    async () => {
      await write.promise
      order.push('written')
      return true
    },
  )
  const disposing = dispose().then(() => order.push('disposed'))
  // Disposal that does not wait for the write finishes well within this.
  await Bun.sleep(1_000)
  expect(order).toEqual([])
  write.resolve()
  await Promise.all([published, disposing])
  expect(order).toEqual(['written', 'disposed'])
}, 15_000)
