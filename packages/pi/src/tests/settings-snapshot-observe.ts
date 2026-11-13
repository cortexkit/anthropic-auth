import { spyOn } from 'bun:test'
import * as crypto from 'node:crypto'
import { dirname, join } from 'node:path'
import * as core from '@cortexkit/anthropic-auth-core'
import {
  __piRequestPolicyForTest,
  closePiNativeRuntime,
  getPiNativeRuntime,
} from '../native.ts'
import { createPiNativeCommands } from '../native-commands.ts'
import {
  __getPiRoutingServicesForTest,
  __sendPiAnthropicRequestForTest,
} from '../stream.ts'
import {
  fixtureAccountIdentity,
  saveNativePiFixture,
} from './native-fixture.ts'
import {
  snapshotModel,
  snapshotQuota,
  snapshotReaderOutputs,
  snapshotSharedThreeWayReaders,
  snapshotTime,
} from './settings-snapshot-fixture.ts'

/** Observe consumers, not the boolean/enum record representation they receive. */
export async function observeSettings(
  storage: core.AccountStorage,
  storagePath: string,
) {
  const environment = { ...process.env }
  process.env.PI_ANTHROPIC_AUTH_FILE = storagePath
  process.env.PI_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE = join(
    dirname(storagePath),
    'local-observer-enrollment.json',
  )
  delete process.env.ANTHROPIC_AUTH_SETTINGS_FILE
  await saveNativePiFixture(
    {
      version: 1,
      accounts: [
        {
          id: 'fallback',
          type: 'oauth',
          refresh: 'synthetic-snapshot-refresh',
          quota: snapshotQuota(15),
        },
      ],
      quota: { enabled: false, mainQuota: snapshotQuota(90) },
      prime: { enabled: false },
    },
    storagePath,
  )
  const native = getPiNativeRuntime(storagePath)
  const service = await native.service()
  const initial = await service.read()
  const snapshot = {
    ...initial,
    policyStorage: { ...storage, accounts: initial.policyStorage.accounts },
  }
  const read = service.read.bind(service)
  service.read = async () => snapshot
  const identity = core.getClaudeCodeIdentityForVerifiedAccount(
    'main',
    fixtureAccountIdentity('main'),
  )
  // Fix random wire identity before serialization; no captured bytes are scrubbed.
  Object.assign(identity, {
    deviceId: '0'.repeat(64),
    sessionId: '11111111-1111-4111-8111-111111111111',
  })
  let now = snapshotTime
  const tracks: unknown[] = []
  const sends: { url: string; body: string; headers: [string, string][] }[] = []
  const warms: { body: string; headers: [string, string][] }[] = []
  const logs: core.LogTestRecord[] = []
  const level = core.getLogLevel()
  const keep = new core.CacheKeepManager({
    loadStorage: async () => storage,
    now: () => now,
    setIntervalImpl: (() => ({ unref() {} })) as unknown as typeof setInterval,
    clearIntervalImpl: () => {},
    setTimeoutImpl: (() => ({ unref() {} })) as unknown as typeof setTimeout,
    clearTimeoutImpl: () => {},
    fetchImpl: (async (_url, init) => {
      warms.push({
        body: String(init?.body),
        headers: [...new Headers(init?.headers).entries()],
      })
      return new Response('{}', { status: 200 })
    }) as typeof fetch,
  })
  const track = keep.track.bind(keep)
  keep.track = (input) => {
    const decision = track(input)
    tracks.push(decision)
    return decision
  }
  core.setLogLevel('debug')
  core.__setLogTestSink((record) => logs.push(record))
  const requestId = spyOn(crypto, 'randomUUID').mockReturnValue(
    '22222222-2222-4222-8222-222222222222',
  )
  try {
    const readers = snapshotReaderOutputs(storage)
    const shared = snapshotSharedThreeWayReaders(storage)
    const policy = __piRequestPolicyForTest('fallback', snapshotModel.id)
    const fallback = snapshot.accounts.find((row) => row.id === 'fallback')
    if (!fallback) throw new Error('Snapshot fixture has no fallback account')
    const admission = policy(fallback, snapshot)
    const routing = __getPiRoutingServicesForTest(storagePath, snapshot)
    routing.quotaManager.seedFallbacksFromAccounts(
      snapshot.policyStorage.accounts.filter(core.isOAuthAccount),
    )
    const eligible = (
      await routing.getUsableFallbackAccounts(snapshot.policyStorage, {
        modelId: snapshotModel.id,
      })
    ).map((row) => row.id)
    const cacheStatus = (
      await createPiNativeCommands(storagePath).readStatus('cache', {})
    ).split('\n')[0]
    const response = await __sendPiAnthropicRequestForTest(
      {
        model: snapshotModel,
        context: {
          systemPrompt: 'Snapshot system prompt.',
          messages: [{ role: 'user', content: 'hello', timestamp: 0 }],
          tools: [],
        },
        storagePath,
        streamOptions: { sessionId: 'settings-snapshot' },
      },
      {
        native,
        cacheKeep: keep,
        fetch: (async (url, init) => {
          sends.push({
            url: String(url),
            body: String(init?.body),
            headers: [...new Headers(init?.headers).entries()],
          })
          return new Response('{}', { status: 200 })
        }) as typeof fetch,
      },
    )
    await response.body?.cancel()
    now += 55 * 60_000 + 30_000
    await keep.tick()
    return {
      readers,
      shared,
      admission,
      eligible,
      cacheStatus,
      sends,
      tracks,
      warms,
      logs,
    }
  } finally {
    requestId.mockRestore()
    keep.stop()
    service.read = read
    await closePiNativeRuntime(storagePath)
    core.__setLogTestSink(null)
    core.setLogLevel(level)
    for (const key of Object.keys(process.env))
      if (!(key in environment)) delete process.env[key]
    Object.assign(process.env, environment)
  }
}
