import { expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { getHostClaustrumEnrollmentPaths } from '../claustrum-enrollment.ts'
import {
  __setLogTestSink,
  getLogLevel,
  type LogTestRecord,
  setLogLevel,
} from '../logger.ts'
import {
  __resetEnrollmentModeLogForTests,
  readNativeEnrollmentMode,
} from '../native-enrollment-authority.ts'
import { resetVaultHostAuthorityForTests } from '../native-vault-host.ts'

function capture() {
  const records: LogTestRecord[] = []
  const previous = getLogLevel()
  setLogLevel('trace')
  __setLogTestSink((record) => records.push(record))
  return {
    records,
    restore() {
      __setLogTestSink(null)
      setLogLevel(previous)
    },
  }
}

test('hosted custody logs exactly once per host across two resolutions and never outside hosted mode', async () => {
  __resetEnrollmentModeLogForTests()
  resetVaultHostAuthorityForTests()
  const previousHost = process.env.CORTEXKIT_VAULT_HOST
  const root = await mkdtemp(join(tmpdir(), 'hosted-mode-log-'))
  const captureLogs = capture()
  setLogLevel('info')
  try {
    delete process.env.CORTEXKIT_VAULT_HOST
    const hosts = ['opencode', 'pi'] as const
    for (const host of hosts) {
      const env = {
        [`${host.toUpperCase()}_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE`]:
          join(root, `${host}.json`),
      }
      expect(await readNativeEnrollmentMode(host, env)).toBe('local')
      expect(await readNativeEnrollmentMode(host, env)).toBe('local')
    }
    expect(
      captureLogs.records.filter((record) => record.payload?.mode === 'hosted'),
    ).toEqual([])
    captureLogs.records.length = 0

    // Reset the cached vault-host authority after changing CORTEXKIT_VAULT_HOST
    // to simulate a process restart.
    process.env.CORTEXKIT_VAULT_HOST = 'thalamus'
    resetVaultHostAuthorityForTests()
    for (const host of hosts) {
      for (const suffix of ['first', 'second']) {
        const env = {
          [`${host.toUpperCase()}_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE`]:
            join(root, `${host}-${suffix}.json`),
        }
        expect(await readNativeEnrollmentMode(host, env)).toBe('claustrum')
      }
    }
    expect(captureLogs.records).toEqual(
      hosts.map((host) => ({
        level: 'info',
        channel: 'enrollment',
        message: 'Native enrollment mode',
        payload: { host, mode: 'hosted', source: 'thalamus' },
      })),
    )
  } finally {
    captureLogs.restore()
    if (previousHost === undefined) delete process.env.CORTEXKIT_VAULT_HOST
    else process.env.CORTEXKIT_VAULT_HOST = previousHost
    resetVaultHostAuthorityForTests()
    __resetEnrollmentModeLogForTests()
    await rm(root, { recursive: true, force: true })
  }
})

test('enrollment mode logs once per token path and again on a mode change without token bytes', async () => {
  __resetEnrollmentModeLogForTests()
  const root = await mkdtemp(join(tmpdir(), 'enrollment-mode-log-'))
  try {
    const host = 'opencode' as const
    const tokenPath = join(root, `${host}-enrollment.json`)
    const env = {
      [`${host.toUpperCase()}_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE`]:
        tokenPath,
    }
    const captureLogs = capture()
    try {
      // No enrollment files: local mode.
      expect(await readNativeEnrollmentMode(host, env)).toBe('local')
      expect(await readNativeEnrollmentMode(host, env)).toBe('local')

      // A durable token flips the same path to vault mode.
      const token = 'ab'.repeat(32)
      await writeFile(
        tokenPath,
        JSON.stringify({ token, token_generation: 7 }),
        { mode: 0o600 },
      )
      await writeFile(
        getHostClaustrumEnrollmentPaths(host, env).statePath,
        JSON.stringify({
          version: 1,
          phase: 'approved',
          proposedName: `anthropic-auth-${host}`,
          approvedName: 'synthetic-approved-name',
          tokenGeneration: 7,
          updatedAt: 1,
        }),
        { mode: 0o600 },
      )
      expect(await readNativeEnrollmentMode(host, env)).toBe('claustrum')
      expect(await readNativeEnrollmentMode(host, env)).toBe('claustrum')

      const modeLogs = captureLogs.records.filter(
        (record) =>
          record.channel === 'enrollment' &&
          record.message === 'Native enrollment mode',
      )
      expect(modeLogs).toHaveLength(2)
      expect(modeLogs[0]).toMatchObject({
        level: 'info',
        payload: {
          host,
          tokenPath,
          source: 'env',
          mode: 'local',
        },
      })
      expect(modeLogs[1]).toMatchObject({
        level: 'info',
        payload: {
          host,
          tokenPath,
          source: 'env',
          proposedName: `anthropic-auth-${host}`,
          approvedName: 'synthetic-approved-name',
          mode: 'claustrum',
        },
      })
      // The token itself never reaches the log; only its path does.
      expect(JSON.stringify(captureLogs.records)).not.toContain(token)
      expect(JSON.stringify(captureLogs.records)).toContain(tokenPath)
    } finally {
      captureLogs.restore()
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('enrollment mode reports a default token path with source default', async () => {
  __resetEnrollmentModeLogForTests()
  const captureLogs = capture()
  try {
    const mode = await readNativeEnrollmentMode(
      'pi',
      {},
      {
        enrollmentAuthority: async () => 'local',
        readClaustrumEnrollmentStatus: async () => ({ state: 'idle' }),
      },
    )
    expect(mode).toBe('local')
    expect(mode).toBe('local')
    const modeLogs = captureLogs.records.filter(
      (record) =>
        record.channel === 'enrollment' &&
        record.message === 'Native enrollment mode',
    )
    expect(modeLogs).toHaveLength(1)
    expect(modeLogs[0]?.payload).toMatchObject({
      host: 'pi',
      source: 'default',
      mode: 'local',
    })
    expect(typeof modeLogs[0]?.payload?.tokenPath).toBe('string')
  } finally {
    captureLogs.restore()
  }
})
