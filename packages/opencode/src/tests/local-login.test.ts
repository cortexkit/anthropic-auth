import { describe, expect, test } from 'bun:test'

import {
  acknowledgeLocalOAuthLogin,
  type CompletedLocalLogin,
  localAuthFingerprint,
} from '../local-login.ts'

const completion: CompletedLocalLogin = {
  accountId: 'main',
  credentialId: 'oauth:anthropic:main',
  authFingerprint: localAuthFingerprint('access-new', 'refresh-new'),
  completedAt: 1,
}

const entry = {
  label: 'main',
  handle: `ckh_${'A'.repeat(43)}`,
  credentialId: completion.credentialId,
}

describe('acknowledgeLocalOAuthLogin', () => {
  test('restored material without an in-process completion does not clear', async () => {
    const calls: unknown[] = []
    await expect(
      acknowledgeLocalOAuthLogin(
        undefined,
        {
          type: 'oauth',
          access: 'access-new',
          refresh: 'refresh-new',
        },
        {
          manifestPath: '/manifest.json',
          entry,
          remove: async (input) => {
            calls.push(input)
            return 'removed'
          },
        },
      ),
    ).resolves.toBe('not-cleared')
    expect(calls).toHaveLength(0)
  })

  test('completion without matching live read-back does not clear', async () => {
    const calls: unknown[] = []
    await expect(
      acknowledgeLocalOAuthLogin(
        completion,
        {
          type: 'oauth',
          access: 'restored-access',
          refresh: 'restored-refresh',
        },
        {
          manifestPath: '/manifest.json',
          entry,
          remove: async (input) => {
            calls.push(input)
            return 'removed'
          },
        },
      ),
    ).resolves.toBe('not-cleared')
    expect(calls).toHaveLength(0)
  })

  test('matching completion and live read-back clear the binding', async () => {
    const calls: unknown[] = []
    await expect(
      acknowledgeLocalOAuthLogin(
        completion,
        {
          type: 'oauth',
          access: 'access-new',
          refresh: 'refresh-new',
        },
        {
          manifestPath: '/manifest.json',
          entry,
          remove: async (input) => {
            calls.push(input)
            return 'removed'
          },
        },
      ),
    ).resolves.toBe('cleared')
    expect(calls).toEqual([{ path: '/manifest.json', entry }])
  })
})
