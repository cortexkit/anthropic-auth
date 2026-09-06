import { afterEach, describe, expect, test } from 'bun:test'
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  acknowledgeLocalOAuthLogin,
  acknowledgeLocalOAuthLoginFromStorage,
  assertLocalLoginObservationAvailable,
  type CompletedLocalLogin,
  CustodyLoginObservationUnavailableError,
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

const tempDirs = new Set<string>()
afterEach(async () => {
  await Promise.all(
    [...tempDirs].map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  )
  tempDirs.clear()
})

async function seedStorage(access: string, refresh: string) {
  const tempDir = await mkdtemp(join(tmpdir(), 'local-login-test-'))
  tempDirs.add(tempDir)
  const accountPath = join(tempDir, 'anthropic-auth.json')
  const statePath = join(tempDir, 'anthropic-auth-state.json')
  const manifestPath = join(tempDir, 'handles.json')
  await writeFile(
    accountPath,
    JSON.stringify({
      version: 1,
      accounts: [{ id: 'main', label: 'main', type: 'oauth', enabled: true }],
    }),
  )
  await writeFile(
    statePath,
    JSON.stringify({
      version: 1,
      accounts: { main: { access, refresh } },
    }),
  )
  await mkdir(join(tempDir, 'manifest'), { recursive: true })
  await writeFile(
    manifestPath,
    JSON.stringify({
      version: 1,
      providers: [
        {
          provider: 'anthropic',
          serve: 'anthropic-auth',
          accounts: [
            {
              label: 'main',
              handle: `ckh_${'D'.repeat(43)}`,
              credential_id: entry.credentialId,
            },
          ],
        },
      ],
    }),
  )
  await chmod(manifestPath, 0o600)
  return { accountPath, manifestPath }
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

test('fixed auth content rejects local login before OAuth', () => {
  expect(() =>
    assertLocalLoginObservationAvailable({ OPENCODE_AUTH_CONTENT: '{}' }),
  ).toThrow(CustodyLoginObservationUnavailableError)
  try {
    assertLocalLoginObservationAvailable({ OPENCODE_AUTH_CONTENT: '{}' })
  } catch (error) {
    expect(error).toMatchObject({
      code: 'custody_login_observation_unavailable',
    })
  }
})

test.serial(
  'authoritative storage read-back blocks a CLI/TUI clear on mismatched credentials',
  async () => {
    const paths = await seedStorage('old-access', 'old-refresh')
    const calls: unknown[] = []
    await expect(
      acknowledgeLocalOAuthLoginFromStorage(completion, {
        accountStoragePath: paths.accountPath,
        manifestPath: paths.manifestPath,
        remove: async (input) => {
          calls.push(input)
          return 'removed'
        },
      }),
    ).resolves.toBe('not-cleared')
    expect(calls).toHaveLength(0)
  },
)

test.serial(
  'authoritative storage read-back clears a matching CLI/TUI login',
  async () => {
    const paths = await seedStorage('access-new', 'refresh-new')
    await expect(
      acknowledgeLocalOAuthLoginFromStorage(completion, {
        accountStoragePath: paths.accountPath,
        manifestPath: paths.manifestPath,
      }),
    ).resolves.toBe('cleared')
    const manifest = JSON.parse(await readFile(paths.manifestPath, 'utf8'))
    expect(manifest.providers[0].accounts).toEqual([])
  },
)
