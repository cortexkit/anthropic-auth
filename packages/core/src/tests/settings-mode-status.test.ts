import { expect, test } from 'bun:test'
import { createNativeRuntimeSettings } from '../native-runtime-settings.ts'
import {
  formatSettingsModeStatus,
  type SettingsMoveDiagnostic,
  settingsMoveBlockerIdentity,
} from '../settings-mode-status.ts'

const file = '/settings/anthropic-auth.jsonc'

test('a newer startup diagnostic replaces the cached reason without settings I/O', async () => {
  const runtime = createNativeRuntimeSettings({
    host: 'opencode',
    settingsMode: () => 'legacy',
    settingsDiagnostic: {
      outcome: 'fence-closed',
      blockers: [{ kind: 'registration' }],
    },
  })
  try {
    expect(runtime.modeStatus(file)).toContain('this process to register')
    runtime.setDiagnostic({
      outcome: 'fence-closed',
      blockers: [{ kind: 'artifact-scan', path: '/rpc' }],
    })
    expect(runtime.modeStatus(file)).toContain(
      'an artifact scan that could not be completed',
    )
    expect(runtime.modeStatus(file)).not.toContain('this process to register')
  } finally {
    await runtime.close()
  }
})

test('settings mode status names every fence kind in plain words, without identities or error text', () => {
  const blockers = [
    { kind: 'registration', reason: 'private registration error' },
    { kind: 'floor', release: 'bad-release' },
    {
      kind: 'holder-file',
      holderFile: '/private/holders',
      reason: 'private read error',
    },
    {
      kind: 'settings-holder',
      holderFile: '/private/holders',
      pid: 123,
      release: '2.11.2',
      reason: 'release',
    },
    {
      kind: 'pre-n-artifact',
      artifact: '/private/rpc/port-123.json',
      pid: 123,
    },
    {
      kind: 'artifact-scan',
      path: '/private/cachekeep',
      reason: 'private parse error',
    },
  ] as const
  const identities = blockers.map(settingsMoveBlockerIdentity)
  expect(identities).toEqual([
    { kind: 'registration' },
    { kind: 'floor', release: 'bad-release' },
    { kind: 'holder-file', path: '/private/holders' },
    {
      kind: 'settings-holder',
      path: '/private/holders',
      pid: 123,
      release: '2.11.2',
    },
    { kind: 'pre-n-artifact', path: '/private/rpc/port-123.json', pid: 123 },
    { kind: 'artifact-scan', path: '/private/cachekeep' },
  ])
  expect(
    formatSettingsModeStatus({
      mode: 'legacy',
      file,
      diagnostic: {
        outcome: 'fence-closed',
        blockers: [...identities, ...identities],
      },
    }),
  ).toBe(
    `Settings: using the old settings; the move to \`${file}\` waits for: this process to register as a settings holder; a valid minimum plugin release; a settings holder registry that could not be read; an older or unrecognized settings holder; an older plugin process recorded in an RPC or CacheKeep file; an artifact scan that could not be completed`,
  )
})

const reasons: [SettingsMoveDiagnostic['outcome'], string][] = [
  [
    'source-unavailable',
    'the old settings stores to become readable and ready',
  ],
  ['import-refused', "this host's protection settings to be safely imported"],
  ['import-unknown', "this host's old protection settings to become readable"],
  [
    'import-pending',
    "the shared file to become usable so this host's protection settings can be checked",
  ],
  [
    'authority-refused',
    'account enrollment or credential migration to allow settings access',
  ],
  ['startup-failed', 'settings startup to succeed'],
  [
    'busy',
    'another settings operation to finish; restart to try the move again',
  ],
  ['failed', 'the settings move to succeed; restart to try again'],
  ['fence-closed', 'a safe settings-holder check'],
  [
    'aborted-target-appeared',
    'a settings file published by another process to be checked',
  ],
  ['done-already', 'the existing settings file to be checked'],
  ['marker-present', 'the previously moved settings file to be checked'],
  ['moved', 'the moved settings file to be opened'],
  ['separate-install', 'this separate install, which keeps its own settings'],
]
for (const [outcome, reason] of reasons) {
  test(`legacy settings status explains ${outcome}`, () => {
    expect(
      formatSettingsModeStatus({
        mode: 'legacy',
        file,
        diagnostic: { outcome },
      }),
    ).toBe(
      `Settings: using the old settings; the move to \`${file}\` waits for: ${reason}`,
    )
  })
}

test('shared-file and separate status override a cached waiting reason', () => {
  const diagnostic = { outcome: 'fence-closed' } as const
  expect(
    formatSettingsModeStatus({ mode: 'user-file', file, diagnostic }),
  ).toBe(`Settings: shared file \`${file}\``)
  expect(formatSettingsModeStatus({ mode: 'separate', file, diagnostic })).toBe(
    'Settings: using the old settings; this separate install keeps its own settings and does not move them to the shared file',
  )
})

for (const [sourceReason, reason] of [
  ['custody-unreadable', 'account enrollment to become readable'],
  ['seeding-failed', 'the vault settings to be initialized'],
  ['paths-unreadable', 'the old settings store paths to become readable'],
  ['vault-unseeded', 'the vault settings to be ready'],
] as const) {
  test(`settings status explains source preparation reason ${sourceReason}`, () => {
    expect(
      formatSettingsModeStatus({
        mode: 'legacy',
        file,
        diagnostic: { outcome: 'source-unavailable', sourceReason },
      }),
    ).toBe(
      `Settings: using the old settings; the move to \`${file}\` waits for: ${reason}`,
    )
  })
}
