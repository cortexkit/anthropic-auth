import { expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { OAuthQuotaSnapshot } from '../accounts.ts'
import type { NativeAccountSnapshot } from '../native-account-view.ts'
import { peekRoutingAccount } from '../routing-peek.ts'
import {
  StickyQuotaRetryCounter,
  StickySessionRouter,
} from '../sticky-routing.ts'

const now = Date.now()
const modelId = 'claude-fable-5'
const quota = (remainingPercent = 80): OAuthQuotaSnapshot => ({
  five_hour: {
    remainingPercent,
    usedPercent: 100 - remainingPercent,
    checkedAt: now,
  },
  seven_day: {
    remainingPercent,
    usedPercent: 100 - remainingPercent,
    checkedAt: now,
  },
})
function snapshot(): NativeAccountSnapshot {
  return {
    mode: 'local',
    settings: {},
    accounts: ['main', 'A', 'B'].map((id) => ({
      id,
      type: 'oauth',
      source: 'local',
      enabled: true,
      quota: quota(),
    })),
    policyStorage: {
      version: 1,
      accounts: [],
      routing: { mode: 'fallback-first' },
      quota: { minimumRemaining: { five_hour: 1, seven_day: 1 } },
    },
  }
}

test('routing peek follows ordered mode, stored quota, floors and model scope', () => {
  const view = snapshot()
  const peek = () =>
    peekRoutingAccount({ snapshot: view, sessionId: 'S', modelId })
  expect(peek()).toBe('A')
  view.policyStorage.routing!.mode = 'main-first'
  expect(peek()).toBe('main')
  view.accounts[0]!.quota = quota(0)
  expect(peek()).toBe('A')
  view.accounts[0]!.quota = quota()
  expect(peek()).toBe('main')
  view.accounts[0]!.enabled = false
  view.accounts[1]!.quota = {
    ...quota(),
    scoped: [
      {
        id: 'fable-weekly',
        title: 'Fable only',
        modelName: 'Fable',
        remainingPercent: 0,
        usedPercent: 100,
        checkedAt: now,
      },
    ],
  }
  expect(peek()).toBe('B')
  expect(
    peekRoutingAccount({
      snapshot: view,
      sessionId: 'S',
      modelId: 'claude-opus-4-8',
    }),
  ).toBe('A')
  view.accounts[1]!.quota = quota(10)
  view.policyStorage.quota = { minimumRemaining: { five_hour: 20 } }
  expect(peek()).toBe('B')
})

test('routing peek keeps missing roster or a higher-priority missing reading undecidable', () => {
  expect(
    peekRoutingAccount({ snapshot: undefined, sessionId: 'S', modelId }),
  ).toBeUndefined()
  const view = snapshot()
  view.accounts[1]!.quota = undefined
  expect(
    peekRoutingAccount({ snapshot: view, sessionId: 'S', modelId }),
  ).toBeUndefined()
})

test('routing peek leaves sticky pins and same-account retry counts untouched', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'routing-peek-'))
  const path = join(directory, 'pins.json')
  const router = new StickySessionRouter({ path, now: () => now })
  try {
    const view = snapshot()
    view.policyStorage.routing!.mode = 'sticky-balanced'
    await router.resolve({
      sessionId: 'S',
      family: 'fable',
      modelId,
      candidates: [{ accountId: 'A', order: 0, quota: quota() }],
      retainAccountIds: new Set(['A']),
      storage: view.policyStorage,
      inputBytes: 1,
    })
    await router.drain()
    const before = await readFile(path, 'utf8')
    const pin = router.peekAssignment('S')
    const counter = new StickyQuotaRetryCounter()
    expect(counter.retain('S', 'turn', 'A')).toBe(true)
    for (let i = 0; i < 3; i++) {
      expect(
        peekRoutingAccount({ snapshot: view, router, sessionId: 'S', modelId }),
      ).toBe('A')
      expect(
        peekRoutingAccount({
          snapshot: view,
          router,
          sessionId: 'unknown',
          modelId,
        }),
      ).toBeUndefined()
    }
    expect(router.peekAssignment('S')).toEqual(pin)
    expect(counter.retain('S', 'turn', 'A')).toBe(true)
    expect(counter.retain('S', 'turn', 'A')).toBe(false)
    await router.drain()
    expect(await readFile(path, 'utf8')).toBe(before)
  } finally {
    await router.drain()
    await rm(directory, { recursive: true, force: true })
  }
})
