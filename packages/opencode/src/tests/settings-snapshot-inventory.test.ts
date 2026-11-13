import { expect, test } from 'bun:test'
import { SETTINGS_THREE_WAY_READERS } from '@cortexkit/anthropic-auth-core'
import { snapshotSettings } from './settings-snapshot-fixture'
import { observeSettings } from './settings-snapshot-observe'

test('release observations cover every schema-named OpenCode and shared cache/quota reader', async () => {
  const observed = await observeSettings(snapshotSettings(true), 2)
  // Each entry points to the consumer result in the observation, not to a value
  // derived from the schema's declared default or absent flag.
  const covered = [
    [
      'packages/core/src/accounts.ts',
      'isCache1hPersistentlyEnabled',
      observed.shared.isCache1hPersistentlyEnabled,
    ],
    [
      'packages/core/src/cachekeep.ts',
      'isCacheKeepHybridActive',
      observed.shared.isCacheKeepHybridActive,
    ],
    [
      'packages/opencode/src/index.ts',
      'AnthropicAuthPlugin (persistent cache latch via isCache1hPersistentlyEnabled)',
      observed.hostReaders.oc1.persistentCacheLatch,
    ],
    [
      'packages/opencode/src/v2/wire.ts',
      'createNativeWirePolicy transformOptions',
      observed.readers.wire.cache1hEnabled,
    ],
    [
      'packages/core/src/accounts.ts',
      'quotaEnabled',
      observed.shared.quotaEnabled,
    ],
    [
      'packages/core/src/accounts.ts',
      'quotaSnapshotPassesPolicy (via quotaEnabled)',
      observed.shared.quotaSnapshotPassesPolicy,
    ],
    [
      'packages/core/src/accounts.ts',
      'quotaRefusalTiming (via quotaEnabled)',
      observed.shared.quotaRefusalTiming,
    ],
    [
      'packages/core/src/accounts.ts',
      'getQuotaNextRefreshAt (via quotaEnabled)',
      observed.shared.getQuotaNextRefreshAt,
    ],
    [
      'packages/opencode/src/index.ts',
      'mainProviderQuotaRestriction',
      observed.hostReaders.oc1.mainProviderQuotaRestriction,
    ],
    [
      'packages/opencode/src/index.ts',
      'pollFallbackQuotas',
      observed.hostReaders.oc1.pollFallbackQuotas,
    ],
    [
      'packages/opencode/src/index.ts',
      'scheduleSidebarMainQuotaRefresh',
      observed.hostReaders.oc1.scheduleSidebarMainQuotaRefresh,
    ],
    [
      'packages/opencode/src/index.ts',
      'mainQuotaRoutingEnabled',
      observed.hostReaders.oc1.mainQuotaRoutingEnabled,
    ],
    [
      'packages/opencode/src/v2/source.ts',
      'createNativeAnthropicSource chooseAccount',
      observed.hostReaders.oc2.chooseAccount,
    ],
    [
      'packages/opencode/src/v2/lifecycle.ts',
      'startNativeAnthropicLifecycle run',
      observed.hostReaders.oc2.lifecycle,
    ],
  ] as const
  expect(covered.map(([path, reader]) => `${path}:${reader}`).sort()).toEqual(
    [
      ...SETTINGS_THREE_WAY_READERS.claude_cache_enabled,
      ...SETTINGS_THREE_WAY_READERS.quota_enabled,
    ]
      .filter(({ path }) => !path.startsWith('packages/pi/'))
      .map(({ path, reader }) => `${path}:${reader}`)
      .sort(),
  )
  expect(covered.every(([, , output]) => output !== undefined)).toBe(true)
})
