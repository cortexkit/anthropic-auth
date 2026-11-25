import type { SettingsMode } from './settings-mode.ts'
import type { SettingsMoveFenceBlocker } from './settings-move-fence.ts'
import type { SettingsMoveStartupResult } from './settings-move-run.ts'
import type { SettingsMoveSourcesResult } from './settings-move-sources.ts'

/** Only blocker identities are exposed; reasons can contain filesystem errors. */
export interface SettingsMoveBlockerIdentity {
  kind: SettingsMoveFenceBlocker['kind']
  path?: string
  pid?: number | null
  release?: string | null
}

export interface SettingsMoveDiagnostic {
  records?: SettingsRecordPaths
  outcome:
    | SettingsMoveStartupResult['outcome']
    | 'authority-refused'
    | 'startup-failed'
  blockers?: readonly SettingsMoveBlockerIdentity[]
  sourceReason?: Extract<
    SettingsMoveSourcesResult,
    { status: 'unavailable' }
  >['reason']
}

export function settingsMoveBlockerIdentity(
  blocker: SettingsMoveFenceBlocker,
): SettingsMoveBlockerIdentity {
  switch (blocker.kind) {
    case 'registration':
      return { kind: blocker.kind }
    case 'floor':
      return { kind: blocker.kind, release: blocker.release }
    case 'settings-holder':
      return {
        kind: blocker.kind,
        path: blocker.holderFile,
        pid: blocker.pid,
        release: blocker.release,
      }
    case 'holder-file':
      return { kind: blocker.kind, path: blocker.holderFile }
    case 'pre-n-artifact':
      return { kind: blocker.kind, path: blocker.artifact, pid: blocker.pid }
    case 'artifact-scan':
      return { kind: blocker.kind, path: blocker.path }
  }
}

const blockerWords: Record<SettingsMoveBlockerIdentity['kind'], string> = {
  registration: 'this process to register as a settings holder',
  floor: 'a valid minimum plugin release',
  'holder-file': 'a settings holder registry that could not be read',
  'settings-holder': 'an older or unrecognized settings holder',
  'pre-n-artifact': 'an older plugin process that may still be running',
  'artifact-scan':
    'an old plugin file that could not be read (the log names it)',
}

const outcomeWords: Record<SettingsMoveDiagnostic['outcome'], string> = {
  'fence-closed': 'a safe settings-holder check',
  'separate-install': 'this separate install, which keeps its own settings',
  'source-unavailable': 'the old settings stores to become readable and ready',
  'import-refused': "this host's protection settings to be safely imported",
  'import-unknown': "this host's old protection settings to become readable",
  'import-pending':
    "the shared file to become usable so this host's protection settings can be checked",
  'authority-refused':
    'account enrollment or credential migration to allow settings access',
  'startup-failed': 'settings startup to succeed',
  busy: 'another settings operation to finish; restart to try the move again',
  failed: 'the settings move to succeed; restart to try again',
  'aborted-target-appeared':
    'a settings file published by another process to be checked',
  'done-already': 'the existing settings file to be checked',
  'marker-present': 'the previously moved settings file to be checked',
  moved: 'the moved settings file to be opened',
}

const sourceWords: Record<
  NonNullable<SettingsMoveDiagnostic['sourceReason']>,
  string
> = {
  'custody-unreadable': 'account enrollment to become readable',
  'seeding-failed': 'the vault settings to be initialized',
  'paths-unreadable': 'the old settings store paths to become readable',
  'vault-unseeded': 'the vault settings to be ready',
}

/** Shared by every host, using only the runtime's cached settings mode and move result. */
export function formatSettingsModeStatus(options: {
  mode: SettingsMode
  file: string
  records?: SettingsRecordPaths
  diagnostic?: SettingsMoveDiagnostic
}): string {
  const target = options.file
    ? `\`${options.file}\``
    : 'the shared settings file'
  if (options.mode === 'separate')
    return 'Settings: using the old settings; this separate install keeps its own settings and does not move them to the shared file'
  const diagnostic = options.diagnostic
  const records = options.records ?? diagnostic?.records
  const locations = records
    ? `\nSettings records: ${settingsRecordLocations(records)}`
    : ''
  if (options.mode === 'user-file')
    return `Settings: shared file ${target}${locations}`
  const kinds = [...new Set(diagnostic?.blockers?.map(({ kind }) => kind))]
  const reason = kinds.length
    ? kinds.map((kind) => blockerWords[kind]).join('; ')
    : diagnostic?.outcome === 'source-unavailable' && diagnostic.sourceReason
      ? sourceWords[diagnostic.sourceReason]
      : diagnostic
        ? outcomeWords[diagnostic.outcome]
        : 'the settings move to complete at a later start'
  return `Settings: using the old settings; the move to ${target} waits for: ${reason}${locations}`
}

import {
  type SettingsRecordPaths,
  settingsRecordLocations,
} from './settings-paths.ts'
