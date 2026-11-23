import { afterEach, expect, spyOn, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { NativeAccountView } from '../native-account-view.ts'
import {
  createRoutingRelay,
  RoutingRefusalError,
  routingWarmCredential,
} from '../routing-relay.ts'
import { StickySessionRouter } from '../sticky-routing.ts'

const key = Symbol.for('cortexkit.routing')
const globals = globalThis as Record<symbol, unknown>
afterEach(() => {
  delete globals[key]
})

test('an unreadable routing pin omits the warm hint without repairing or publishing state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'routing-warm-hint-'))
  const path = join(root, 'routing.json')
  try {
    await writeFile(path, 'unreadable routing state')
    const router = new StickySessionRouter({ path })
    expect(await router.readAssignment('session')).toBeUndefined()
    expect(await readFile(path, 'utf8')).toBe('unreadable routing state')
    await router.drain()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('warm credential hints require the pinned account to remain servable and identity-bound', () => {
  const account: NativeAccountView = {
    id: 'main',
    type: 'oauth',
    source: 'vault',
    enabled: true,
    state: 'active',
    accountIdentity: 'account',
    credentialId: 'credential',
  }
  const pin = { accountId: 'main', accountIdentity: 'account' }
  expect(routingWarmCredential([account], pin)).toBe('credential')
  expect(routingWarmCredential([account], undefined)).toBeUndefined()
  expect(
    routingWarmCredential([account], { ...pin, accountId: 'other' }),
  ).toBeUndefined()
  expect(
    routingWarmCredential([account], { ...pin, accountIdentity: 'replaced' }),
  ).toBeUndefined()
  for (const change of [
    { enabled: false },
    { state: 'needs_reauth' },
    { state: 'expired' },
    { type: 'api' as const },
    { source: 'local' as const },
  ])
    expect(
      routingWarmCredential([{ ...account, ...change }], pin),
    ).toBeUndefined()
})

test('warm hints add only the matching candidate credential to the routing request', async () => {
  const requests: unknown[] = []
  globals[key] = () => ({
    accountFor: async (request: unknown) => {
      requests.push(request)
      return null
    },
  })
  const relay = createRoutingRelay()
  const accounts = [{ accountIdentity: 'account', credentialId: 'credential' }]
  const wait = { capacityWait: 'wait' } as const
  await relay.accountFor('session', 'model', accounts, wait)
  await relay.accountFor('session', 'model', accounts, {
    ...wait,
    warmCredentialId: 'credential',
  })
  await relay.accountFor('session', 'model', accounts, {
    ...wait,
    warmCredentialId: 'not-a-candidate',
  })
  const plain = {
    provider: 'anthropic',
    modelId: 'model',
    request_id: expect.any(String),
    refusals: true,
    waits_for_capacity: true,
  }
  const candidates = {
    view_digest:
      'c7eaf74ae1601bfb35b7b99d470a66b6f28037161cf31d53da2cab10aabeb9aa',
    accounts: [{ account_id: 'account', credential_id: 'credential' }],
  }
  expect(requests).toEqual([
    { ...plain, candidates },
    { ...plain, warm_credential: 'credential', candidates },
    { ...plain, candidates },
  ])
})

test('routing refusal uses fixed text and explicit retry seconds before reset time', async () => {
  globals[key] = () => ({
    accountFor: async () => ({
      refused: {
        code: 'account_limit_exhausted',
        routing_code: 'not user text',
        retry_after_secs: 17,
        resets_at_ms: Date.now() + 900_000,
      },
    }),
  })
  await expect(
    createRoutingRelay().accountFor('session', 'model', [], {
      capacityWait: 'wait',
    }),
  ).rejects.toMatchObject({
    code: 'account_limit_exhausted',
    retryAfterSecs: 17,
    message: 'Shared routing has no account for this request right now.',
  })
})

const capacityAccount = {
  accountIdentity: 'account',
  credentialId: 'credential',
}
const capacitySelection = { account_id: 'account', credential_id: 'credential' }

function capacityRefusal(resetsAtMs: number) {
  return { refused: { code: 'concurrency_full', resets_at_ms: resetsAtMs } }
}

test('capacity wait re-asks the same question and takes the selection without a wait report', async () => {
  const requests: unknown[] = []
  const reports: unknown[] = []
  const notices: string[] = []
  globals[key] = () => ({
    accountFor: async (request: unknown, options: unknown) => {
      expect(options).toEqual({ deadlineMs: 2_000 })
      requests.push(request)
      return requests.length === 1
        ? capacityRefusal(Date.now() + 5)
        : capacitySelection
    },
    report: (report: unknown) => reports.push(report),
  })
  const relay = createRoutingRelay()
  expect(
    await relay.accountFor('session', 'model', [capacityAccount], {
      capacityWait: 'wait',
      warmCredentialId: 'credential',
      onCapacityWait: () => {
        notices.push('started')
        return () => notices.push('ended')
      },
    }),
  ).toEqual(capacitySelection)
  expect(requests).toHaveLength(2)
  expect(requests[0]).toMatchObject({
    request_id: expect.any(String),
    waits_for_capacity: true,
    refusals: true,
    warm_credential: 'credential',
    candidates: { accounts: [capacitySelection] },
  })
  expect(requests[1]).toEqual(requests[0])
  expect(relay.admitted('session', capacityAccount)).toBe(true)
  expect(notices).toEqual(['started', 'ended'])
  expect(reports).toEqual([])
})

test('abort during a capacity wait ends it without another ask', async () => {
  const controller = new AbortController()
  let asks = 0
  globals[key] = () => ({
    accountFor: async () => {
      asks++
      return capacityRefusal(Date.now() + 60_000)
    },
  })
  await expect(
    createRoutingRelay().accountFor('session', 'model', [capacityAccount], {
      capacityWait: 'wait',
      signal: controller.signal,
      onCapacityWait: () => {
        const timer = setTimeout(() => controller.abort(), 0)
        return () => clearTimeout(timer)
      },
    }),
  ).rejects.toMatchObject({ name: 'AbortError' })
  expect(asks).toBe(1)
})

test('capacity wait beyond the in-request budget returns the refusal with its reset', async () => {
  const now = 1_800_000_000_000
  const resetsAtMs = now + 300_000
  const clock = spyOn(Date, 'now').mockReturnValue(now)
  let asks = 0
  globals[key] = () => ({
    accountFor: async () => {
      asks++
      return capacityRefusal(resetsAtMs)
    },
  })
  try {
    await expect(
      createRoutingRelay().accountFor('session', 'model', [capacityAccount], {
        capacityWait: { maxInRequestMs: 240_000 },
      }),
    ).rejects.toMatchObject({
      code: 'concurrency_full',
      resetsAtMs,
      status: 429,
    })
    expect(asks).toBe(1)
  } finally {
    clock.mockRestore()
  }
})

test.each(['timeout', 'outage'])(
  'routing %s falls back to local choice without a capacity wait',
  async (failure) => {
    globals[key] = () => ({
      accountFor: async () => {
        if (failure === 'outage') throw new Error('routing is unavailable')
        return new Promise(() => {})
      },
    })
    await expect(
      createRoutingRelay().accountFor('session', 'model', [capacityAccount], {
        capacityWait: 'wait',
        onCapacityWait: () => {
          throw new Error('expected local fallback without a wait')
        },
      }),
    ).resolves.toBeUndefined()
  },
)

test('routing refusal reset time is rounded up and final selection has no retry hint', () => {
  expect(
    new RoutingRefusalError(
      { code: 'account_selection_refused', resetsAtMs: 4501 },
      1000,
    )
      .response()
      .headers.get('retry-after'),
  ).toBe('4')
  expect(
    new RoutingRefusalError({
      code: 'account_selection_final',
      retryAfterSecs: 5,
    })
      .response()
      .headers.get('retry-after'),
  ).toBeNull()
})

test('rejected routing admission sends no served or exhausted report', async () => {
  const reports: unknown[] = []
  globals[key] = () => ({
    accountFor: async () => ({
      account_id: 'account',
      credential_id: 'credential',
    }),
    report: (report: unknown) => reports.push(report),
  })
  const relay = createRoutingRelay()
  const account = { accountIdentity: 'account', credentialId: 'credential' }
  await relay.accountFor('session', 'model', [account], {
    capacityWait: 'wait',
  })
  expect(relay.admitted('session', account)).toBe(true)
  relay.override('session', 'credential unavailable')
  expect(relay.admitted('session', account)).toBe(false)
  relay.report('session', { accountIdentity: 'other' }, new Headers(), 200)
  relay.report(
    'session',
    account,
    new Headers({ 'anthropic-ratelimit-unified-5h-status': 'rejected' }),
    429,
  )
  await Promise.resolve()
  expect(reports).toEqual([])
})

test('host retry cap bounds routing refusals and hosted holds to fifteen minutes', async () => {
  for (const refusal of [
    { code: 'account_limit_exhausted' as const, retryAfterSecs: 93_151 },
    {
      code: 'account_limit_exhausted' as const,
      resetsAtMs: Date.now() + 26 * 3_600_000,
    },
  ]) {
    const error = new RoutingRefusalError(refusal)
    expect(error.retryAfterSecs).toBe(900)
    expect(error.response().headers.get('retry-after')).toBe('900')
  }
  globals[key] = () => ({
    accountFor: async () => ({
      account_id: 'account',
      credential_id: 'credential',
      hold: { retry_after_ms: 93_151_000 },
    }),
  })
  expect(
    await createRoutingRelay().accountFor(
      'session',
      'model',
      [{ accountIdentity: 'account', credentialId: 'credential' }],
      { capacityWait: 'wait' },
    ),
  ).toMatchObject({ hold: { retry_after_ms: 900_000 } })
})
