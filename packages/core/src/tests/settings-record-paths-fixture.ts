import { dirname } from 'node:path'

import {
  prepareSettingsRecordPaths,
  resolveSettingsPaths,
  type SettingsPathOptions,
} from '../settings-paths.ts'

/** An isolated target for tests that open the settings service without startup. */
export async function settingsTestPaths(
  file: string,
  input: SettingsPathOptions = {},
) {
  const options = {
    home: dirname(file),
    ...input,
    env: { ...input.env, ANTHROPIC_AUTH_SETTINGS_FILE: file },
  }
  return prepareSettingsRecordPaths(
    await resolveSettingsPaths('opencode', options),
    options,
  )
}
