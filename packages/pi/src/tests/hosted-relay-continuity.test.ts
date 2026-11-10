import { afterEach, expect, spyOn, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as core from '@cortexkit/anthropic-auth-core'
import { ClaustrumUnreachableError } from '@cortexkit/common-auth/claustrum'
import { closePiNativeRuntime, getPiNativeRuntime } from '../native.ts'
import { saveNativePiFixture } from './native-fixture.ts'

const key = Symbol.for('cortexkit.vault')
const globals = globalThis as unknown as Record<symbol, unknown>
const prior = globals[key]
const cleanup: (() => unknown | Promise<unknown>)[] = []
const envKeys = [
  'PI_CODING_AGENT_DIR',
  'OPENCODE_ANTHROPIC_AUTH_STATE_FILE',
] as const
const priorEnv = new Map(envKeys.map((key) => [key, process.env[key]]))
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
  if (prior === undefined) delete globals[key]
  else globals[key] = prior
  delete process.env.CORTEXKIT_VAULT_HOST
  for (const key of envKeys) {
    const value = priorEnv.get(key)
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  core.resetVaultHostAuthorityForTests?.()
})
const accountId = '11111111-2222-4333-8444-555555555555'
const credentialId = 'oauth:anthropic'
const gate = () => Promise.withResolvers<void>()

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'pi-relay-continuity-'))
  const path = join(root, 'anthropic-auth.json')
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  cleanup.push(() => closePiNativeRuntime(path))
  await saveNativePiFixture({ version: 1, accounts: [] }, path, {
    primary: false,
  })
  core.resetVaultHostAuthorityForTests?.()
  process.env.CORTEXKIT_VAULT_HOST = 'thalamus'
  let outage = false,
    connections = 0
  const closed = gate()
  const reports: Array<{ connection: number; recordVersion: number }> = []
  const gets: number[] = []
  globals[key] = () => {
    const connection = connections++
    let version = 6
    const check = () => {
      if (connection === 0 && outage) throw new ClaustrumUnreachableError()
    }
    return {
      listScoped: async () => {
        check()
        return {
          view: 'same-view',
          rows: [
            {
              id: credentialId,
              accountId,
              credentialType: 'oauth',
              categories: ['anthropic-native'],
              refreshAdapter: 'anthropic',
              serves: ['anthropic'],
              providerIds: [],
              state: 'active',
              operations: ['read'],
              recordVersion: 7,
              createdAtMs: null,
            },
          ],
          grants: undefined,
          grantTuples: undefined,
        }
      },
      getScoped: async () => {
        check()
        gets.push(connection)
        return {
          credentialId,
          accountId,
          material: `synthetic-relay-${connection}`,
          recordVersion: ++version,
          expiresAtMs: Date.now() + 3_600_000,
        }
      },
      reportAuthFailureScoped: async (input: { recordVersion: number }) => {
        reports.push({ connection, recordVersion: input.recordVersion })
      },
      close: () => {
        if (connection === 0) closed.resolve()
      },
    }
  }
  type Timer = {
    callback(): void
    delay: number
    cleared: boolean
    unref(): void
  }
  const timers: Timer[] = []
  const acquire = core.acquireNativeAccountRuntime
  const spy = spyOn(core, 'acquireNativeAccountRuntime').mockImplementation(
    (options) =>
      acquire({
        ...options,
        vault: {
          ...options.vault,
          setTimeout: ((callback: () => void, delay: number) => {
            const timer = { callback, delay, cleared: false, unref() {} }
            timers.push(timer)
            return timer
          }) as unknown as typeof setTimeout,
          clearTimeout: ((timer: Timer) => {
            timer.cleared = true
          }) as unknown as typeof clearTimeout,
        },
      }),
  )
  cleanup.push(() => spy.mockRestore())
  const native = getPiNativeRuntime(path, { vaultPoll: { intervalMs: 0 } })
  const runtime = await native.service()
  spy.mockRestore()
  await runtime.vault.refresh()
  const route = (await runtime.read()).accounts[0]!.id
  const swap = async () => {
    outage = true
    await runtime.vault.authorize(route)
    const timer = timers.find((timer) => timer.delay === 0 && !timer.cleared)
    if (!timer) throw new Error('Reconnect was not scheduled')
    timer.cleared = true
    timer.callback()
    await closed.promise
  }
  return { native, runtime, route, swap, reports, gets }
}

for (const operation of ['authorize', 'retry'] as const) {
  test(`Pi ${operation} keeps its receipt usable across a relay swap during its final runtime read`, async () => {
    const f = await fixture()
    const first =
      operation === 'retry' ? await f.native.authorize(f.route) : undefined
    const read = f.runtime.read.bind(f.runtime)
    const entered = gate(),
      release = gate()
    let reads = 0
    const spy = spyOn(f.runtime, 'read').mockImplementation(async (...args) => {
      const snapshot = await read(...args)
      if (++reads === 2) {
        entered.resolve()
        await release.promise
      }
      return snapshot
    })
    const pending = first
      ? f.native.retry(f.route, first)
      : f.native.authorize(f.route)
    const settled = Promise.allSettled([pending])
    cleanup.push(async () => {
      release.resolve()
      await settled
      spy.mockRestore()
    })
    await Promise.race([
      entered.promise,
      pending.then(() => {
        throw new Error('Pi returned before the receipt-held read barrier')
      }),
    ])
    await f.swap()
    release.resolve()
    const attempt = await pending
    if (attempt?.source !== 'vault')
      throw new Error('Pi lost its vault attempt')
    expect(attempt.receipt.accessToken).toBe('synthetic-relay-0')
    expect(
      await f.runtime.vault.publish(attempt.receipt, { lastUsed: Date.now() }),
    ).toBe(true)
    expect(f.reports).toEqual([])
    await f.runtime.vault.reportFailure(attempt.receipt, 401, 'direct')
    expect(f.reports).toEqual([
      { connection: 1, recordVersion: attempt.receipt.recordVersion },
    ])
    if (operation === 'authorize') {
      // Reconnecting to the same vault does not rotate the served credential.
      expect(await f.native.retry(f.route, attempt)).toBeUndefined()
      expect(f.gets).toEqual([0, 1])
    } else {
      expect(await f.native.retry(f.route, attempt)).toBeUndefined()
      expect(f.gets).toEqual([0, 0])
    }
  })
}
