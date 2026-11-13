import { expect, test } from 'bun:test'
import { resolve } from 'node:path'
import {
  type AccountSettingsReaderInput,
  type AccountStorage,
  createEmptyStorage,
  type NativeAccountRuntime,
  type NativeAccountSnapshot,
  resolveNativePoolPaths,
  type ThreeWayBoolean,
} from '@cortexkit/anthropic-auth-core'
import type { NativeAnthropicRequestContext } from '../v2/adapter'
import { startNativeAnthropicLifecycle } from '../v2/lifecycle'
import {
  createNativeAnthropicSource,
  type NativeSourceProvenance,
} from '../v2/source'
import { createNativeWirePolicy } from '../v2/wire'

const inputs = [true, false, undefined, 'on', 'off', 'default'] as const
const enabledByDefault = [true, false, true, true, false, true]

function snapshotFor(
  section: 'quota' | 'claudeCache',
  value: ThreeWayBoolean | undefined,
): NativeAccountSnapshot {
  const policy: AccountSettingsReaderInput = createEmptyStorage()
  policy[section] = value === undefined ? {} : { enabled: value }
  return {
    mode: 'local',
    settings: {},
    accounts: [{ id: 'main', type: 'oauth', source: 'local', enabled: true }],
    // The legacy persistence shape stays boolean-only. Supply the settings
    // reader's wider input at the policy boundary, not through a store writer.
    policyStorage: policy as AccountStorage,
  }
}

test('createNativeWirePolicy transformOptions reads all six cache inputs and preserves excluded agents', () => {
  const policy = createNativeWirePolicy()
  const context = {
    attemptId: 'three-way-cache',
    sessionID: 'three-way-cache',
    agent: 'build',
    correlation: {},
  } as NativeAnthropicRequestContext<NativeSourceProvenance>
  expect(
    inputs.map(
      (value) =>
        policy.requestOptions(context, snapshotFor('claudeCache', value))
          .cache1hEnabled,
    ),
  ).toEqual(enabledByDefault)
  for (const agent of ['compaction', 'title']) {
    expect(
      inputs.map(
        (value) =>
          policy.requestOptions(
            { ...context, agent },
            snapshotFor('claudeCache', value),
          ).cache1hEnabled,
      ),
    ).toEqual([false, false, false, false, false, false])
  }
})

test('createNativeAnthropicSource chooseAccount reads all six quota inputs before reroute maintenance', async () => {
  const outputs: boolean[] = []
  for (const value of inputs) {
    const snapshot = snapshotFor('quota', value)
    let polls = 0
    const runtime = {
      read: async () => snapshot,
      drainRoutingPublications: async () => {},
      fetchQuota: async () => {
        polls++
      },
    } as unknown as NativeAccountRuntime
    const source = createNativeAnthropicSource({
      runtime,
      paths: await resolveNativePoolPaths(
        resolve(import.meta.dir, '../../../../target/scratch/three-way-reader'),
      ),
      requestOptions: () => ({}),
    })
    try {
      // Credential-change maintenance polls but must not select or pin a route.
      expect(
        await source.chooseAccount({
          phase: 'retry',
          providerID: 'anthropic',
          modelID: 'claude-sonnet-5',
          sessionID: 'three-way-quota',
          agent: 'build',
          kind: 'primary',
          rerouteFrom: {
            accountId: 'main',
            limit: { reason: 'local-newer:credential', retryAfterMs: 0 },
          },
        }),
      ).toBeUndefined()
      outputs.push(polls === 1)
      expect(polls).toBeLessThanOrEqual(1)
    } finally {
      await source.close()
    }
  }
  expect(outputs).toEqual(enabledByDefault)
})

test('startNativeAnthropicLifecycle run reads all six quota inputs at a background tick', async () => {
  const outputs: boolean[] = []
  for (const value of inputs) {
    const snapshot = snapshotFor('quota', value)
    let tick: (() => Promise<void> | undefined) | undefined
    let polls = 0
    let profiles = 0
    let closed = false
    const runtime = {
      read: async () => snapshot,
      fetchQuota: async () => {
        polls++
      },
      fetchProfile: async () => {
        profiles++
      },
      vault: {
        watch: (options: { onRefresh: typeof tick }) => {
          tick = options.onRefresh
          return {
            ready: Promise.resolve(),
            close: () => {
              closed = true
            },
          }
        },
      },
    } as unknown as NativeAccountRuntime
    const lifecycle = startNativeAnthropicLifecycle(runtime)
    try {
      expect(tick).toBeDefined()
      await tick!()
      outputs.push(polls === 1)
      expect(polls).toBeLessThanOrEqual(1)
      expect(profiles).toBe(1)
    } finally {
      await lifecycle.dispose()
    }
    expect(closed).toBe(true)
  }
  expect(outputs).toEqual(enabledByDefault)
})
