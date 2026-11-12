import { expect, test } from 'bun:test'
import { nativeAccountPolicy } from '../native-account-runtime.ts'
import type {
  NativeAccountSnapshot,
  NativeAccountView,
} from '../native-account-view.ts'
import {
  NATIVE_VAULT_NO_ACCOUNT_MESSAGE,
  NativeVaultNoAccountError,
} from '../native-vault-admission.ts'
import { createNativeVaultNoRouteResponse } from '../native-vault-refusal.ts'

function account(id = 'main', state = 'active'): NativeAccountView {
  const checkedAt = Date.now()
  return {
    id,
    type: 'oauth',
    source: 'vault',
    enabled: true,
    state,
    accountIdentity: id,
    quota: {
      accountIdentity: id,
      checkedAt,
      five_hour: { remainingPercent: 100, usedPercent: 0, checkedAt },
      seven_day: { remainingPercent: 19, usedPercent: 81, checkedAt },
    },
  }
}

function snapshot(accounts = [account()]): NativeAccountSnapshot {
  return {
    mode: 'claustrum',
    settings: {},
    accounts,
    policyStorage: {
      version: 1,
      accounts: [],
      quota: {
        enabled: true,
        minimumRemaining: { five_hour: 0, seven_day: 20 },
      },
    },
  }
}

for (const state of ['needs_reauth', 'declined', 'disabled']) {
  test(`vault no-route keeps the sign-in refusal for all ${state} accounts`, () => {
    expect(() =>
      createNativeVaultNoRouteResponse({
        snapshot: snapshot([account('main', state)]),
      }),
    ).toThrow(NATIVE_VAULT_NO_ACCOUNT_MESSAGE)
  })
}

test('vault no-route keeps the sign-in refusal for empty and user-disabled vaults', () => {
  expect(() =>
    createNativeVaultNoRouteResponse({ snapshot: snapshot([]) }),
  ).toThrow(NativeVaultNoAccountError)
  expect(() =>
    createNativeVaultNoRouteResponse({
      snapshot: snapshot([{ ...account(), enabled: false }]),
    }),
  ).toThrow(NativeVaultNoAccountError)
})

test('vault mixed sign-in and quota exclusions preserve local authentication precedence', () => {
  expect(() =>
    createNativeVaultNoRouteResponse({
      snapshot: snapshot([account(), account('other', 'needs_reauth')]),
    }),
  ).toThrow(NativeVaultNoAccountError)
})

test('vault disabled and declined accounts do not hide an active account quota refusal', async () => {
  const view = snapshot([
    account(),
    { ...account('disabled'), enabled: false },
    account('declined', 'declined'),
  ])
  const response = createNativeVaultNoRouteResponse({ snapshot: view })
  expect(response.status).toBe(429)
  expect(await response.json()).toMatchObject({
    error: { message: expect.stringContaining('quota floor') },
  })
})

test('vault model-scoped refusal names the model limit and uses its reset retry hint', async () => {
  const view = snapshot()
  const checkedAt = Date.now()
  view.policyStorage.quota = {
    enabled: true,
    minimumRemaining: { five_hour: 0, seven_day: 0 },
  }
  view.accounts[0]!.quota!.scoped = [
    {
      id: 'seven_day_opus',
      title: 'Opus weekly',
      modelId: 'claude-opus-4-6',
      modelName: 'Opus',
      remainingPercent: 0,
      usedPercent: 100,
      checkedAt,
      resetsAt: new Date(checkedAt + 120_000).toISOString(),
    },
  ]
  const policy = nativeAccountPolicy(view.accounts[0]!, view, 'claude-opus-4-6')
  expect(policy).toMatchObject({
    status: 'blocked',
    reason: 'quota-ineligible',
    quotaPolicyLimits: ['model-scoped'],
  })
  const response = createNativeVaultNoRouteResponse({
    snapshot: view,
    modelId: 'claude-opus-4-6',
    policies: new Map([['main', policy]]),
  })
  expect(response.status).toBe(429)
  expect(Number(response.headers.get('retry-after'))).toBeGreaterThan(0)
  expect(Number(response.headers.get('retry-after'))).toBeLessThanOrEqual(180)
  expect(Number(response.headers.get('retry-after'))).toBeLessThanOrEqual(120)
  const body = (await response.json()) as { error: { message: string } }
  expect(body.error.message).toContain('Opus scoped limit')
  expect(body.error.message).toContain('/claude → Killswitch / Quota')
  expect(body.error.message).toContain('Retrying every 2 minutes.')
})
