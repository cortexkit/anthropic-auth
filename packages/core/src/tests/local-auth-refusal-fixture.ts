import { fingerprintOf } from '@cortexkit/common-auth/store'
import { nativeQuotaCodec } from '../native-quota-codec.ts'
import { updateNativeRuntime } from '../native-runtime.ts'
import { captureNativeLocalPoolBinding } from '../pool-binding.ts'
import type { NativePoolPaths } from '../pool-paths.ts'
import { createNativePoolStore } from '../pool-store.ts'
import { tokenFingerprint } from '../token-fingerprint.ts'

export const localAuthRefusalScenarios = [
  'dead login',
  'live alternate',
  'quota-blocked alternate',
  'validation wait',
  'stale record',
] as const

export async function seedLocalAuthRefusal(
  paths: NativePoolPaths,
  state: 'dead' | 'validation' | 'stale' | 'proven',
  id = 'main',
) {
  const store = createNativePoolStore({ paths, quota: nativeQuotaCodec })
  const pool = await store.read()
  if (pool.status !== 'ready') throw new Error('Missing fixture pool')
  const settings = await store.readSettings()
  if (settings.status !== 'ready') throw new Error('Missing fixture settings')
  const rowId = id === 'main' ? settings.settings.mainAccountId : id
  const row = pool.rows.find((row) => row.id === rowId)
  if (row?.credential?.type !== 'oauth')
    throw new Error('Missing fixture OAuth credential')
  const credential = row.credential
  const { access, expires } = credential
  if (!access || expires === undefined)
    throw new Error('Incomplete fixture OAuth credential')
  const captured = captureNativeLocalPoolBinding(paths, row)
  if (!captured.identity)
    throw new Error('Fixture OAuth account has no identity')
  const binding = { ...captured, identity: captured.identity }
  const subject = {
    binding,
    credentialFingerprint: fingerprintOf(credential),
    version: {
      accessFingerprint: tokenFingerprint(access),
      expires,
      ...(Object.hasOwn(credential, 'lastRefreshedAt')
        ? { lastRefreshedAt: credential.lastRefreshedAt }
        : {}),
    },
  }
  const now = Date.now()
  const entry = {
    binding,
    ...(state === 'proven' && { credentialValidation: subject }),
    ...((state === 'validation' || state === 'stale') && {
      validationRetry: { subject, checkedAt: now, nextRetryAt: now + 300_000 },
    }),
    ...((state === 'dead' || state === 'stale') && {
      lastRefreshError: {
        credentialFingerprint:
          state === 'dead'
            ? subject.credentialFingerprint
            : fingerprintOf({
                ...credential,
                refresh: 'replaced-fixture-refresh',
              }),
        checkedAt: now,
        nextRetryAt: now + 86_400_000,
        message: 'Local refresh failed',
        status: 400,
        permanent: true,
        accountIdentity: binding.identity,
      },
    }),
  }
  await updateNativeRuntime(paths.runtime, paths.storageId, (current) => ({
    ...current,
    accounts: { ...current.accounts, [row.id]: entry },
  }))
  return subject
}

export function localAuthFixtureQuota(remainingPercent: number) {
  const checkedAt = Date.now()
  const window = {
    checkedAt,
    usedPercent: 100 - remainingPercent,
    remainingPercent,
  }
  return {
    checkedAt,
    source: 'poll' as const,
    five_hour: window,
    seven_day: window,
  }
}
