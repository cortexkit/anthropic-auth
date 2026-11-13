// Frozen from tag v2.11.4, commit 1145c98e73d2b9d5c1ed28f35dc10b25992952e0:
// packages/core/src/native-runtime.ts (decodeNativeRuntime and entryKeys), and
// packages/core/src/native-migration-source.ts (settingFields and validateNativeMigrationSettings).
// The runtime file and the settings validator/key list are identical at v2.11.2
// (5a5f8a1b9c51521e9f928a4211e0b269679e86fb); only splitNativeMigrationSettings was added.
export const publishedRuntimeKeys = {
  root: ['version', 'storageId', 'accounts', 'relay', 'relayGeneration'],
  entry: [
    'binding',
    'credentialValidation',
    'validationRetry',
    'lastUsed',
    'lastRefreshedAt',
    'lastRefreshError',
    'refreshErrorClearedAt',
    'refreshLeaseId',
    'refreshLeaseUntil',
    'refreshLeaseTokenHash',
    'lastQuotaRefreshError',
    'quotaErrorGeneration',
    'quotaErrorClearedAt',
    'quota',
    'quotaCheckedAt',
    'quotaToken',
    'profile',
    'profileToken',
    'prime',
    'authLineageId',
    'primeAuthLineageRefreshTokenFingerprint',
  ],
} as const

export const publishedSettingFields = {
  routing: ['mode', 'maxSameAccountWait'],
  refresh: ['enabled', 'intervalMinutes', 'refreshBeforeExpiryMinutes'],
  quota: [
    'enabled',
    'checkIntervalMinutes',
    'refreshEveryNRequests',
    'minimumRemaining',
    'failClosedOnUnknownQuota',
    'showToasts',
  ],
  quotaHeaderFeed: ['enabled'],
  claudeCache: ['enabled', 'mode'],
  dump: ['enabled'],
  logging: ['level'],
  claudeFast: ['enabled'],
  thinkingBinding: ['prefixMismatchBehavior'],
  turnEndNote: ['tools'],
  costZeroing: ['enabled'],
  cacheKeep: ['enabled', 'always', 'startHour', 'endHour', 'subagents'],
  prime: ['enabled'],
  relay: ['enabled', 'url', 'fallbackToDirect', 'transport'],
  killswitch: ['enabled', 'main', 'accounts'],
} as const

export const publishedBooleanLeaves = [
  'enabled',
  'always',
  'subagents',
  'failClosedOnUnknownQuota',
  'showToasts',
  'fallbackToDirect',
] as const
