import { expect, test } from 'bun:test'
import { NativeRuntimeError } from '../native-runtime.ts'
import { nativeDisplayProfile } from '../native-vault-runtime.ts'

const profile = {
  tier: 'default_claude_max_20x',
  orgType: 'claude_max',
  checkedAt: 1_000_000,
  accountIdentity: '11111111-2222-4333-8444-555555555555',
}

test('profile publication fence refusal is distinct from an I/O failure', async () => {
  const result = nativeDisplayProfile(
    profile,
    async () => false,
    async () => true,
  )
  expect(await result.persisted).toBe('refused')
})

test('thrown profile publication refusal remains a refusal', async () => {
  const result = nativeDisplayProfile(
    profile,
    async () => {
      throw new NativeRuntimeError('publication-refused')
    },
    async () => true,
  )
  expect(await result.persisted).toBe('refused')
})

test('profile I/O failure settles without rejecting its display result', async () => {
  const result = nativeDisplayProfile(
    profile,
    async () => {
      throw new NativeRuntimeError('runtime-io')
    },
    async () => true,
  )
  expect(await result.persisted).toBe('failed')
  expect(result.profile).toEqual(profile)
})
