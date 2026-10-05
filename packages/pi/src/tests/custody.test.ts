import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type ClaustrumScopedClient,
  getClaustrumMode,
  getHostClaustrumEnrollmentPaths,
  loadAccounts,
  saveAccounts,
} from '@cortexkit/anthropic-auth-core'
import { createPiCustodyCommands } from '../custody.ts'

let dir: string | undefined
afterEach(async () => {
  delete process.env.PI_CODING_AGENT_DIR
  delete process.env.PI_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE
  if (dir) await rm(dir, { recursive: true, force: true })
  dir = undefined
})
async function fixture() {
  dir = await mkdtemp(join(tmpdir(), 'pi-custody-command-'))
  const storagePath = join(dir, 'accounts.json')
  const tokenPath = join(dir, 'token.json')
  process.env.PI_CODING_AGENT_DIR = dir
  process.env.PI_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE = tokenPath
  await saveAccounts({ version: 1, accounts: [] }, storagePath)
  await writeFile(
    tokenPath,
    JSON.stringify({ token: '01'.repeat(32), token_generation: 1 }),
    { mode: 0o600 },
  )
  let connections = 0,
    gets = 0,
    reconfigurations = 0
  const client: ClaustrumScopedClient = {
    listScoped: async () => ({
      view: 'v',
      rows: [
        {
          id: 'oauth:anthropic',
          accountId: 'provider-account',
          credentialType: 'oauth',
          categories: ['anthropic-native'],
          serves: ['anthropic'],
          providerIds: [],
          refreshAdapter: 'anthropic',
          state: 'active',
          operations: ['read'],
          recordVersion: 1,
          createdAtMs: null,
        },
      ],
    }),
    getScoped: async () => {
      gets++
      return {
        material: 'vault-test-access',
        credentialId: 'oauth:anthropic',
        accountId: 'provider-account',
        recordVersion: 1,
        expiresAtMs: Date.now() + 600_000,
      }
    },
    reportAuthFailureScoped: async () => {},
    close: () => {},
  }
  const commands = createPiCustodyCommands({
    storagePath,
    connect: async () => {
      connections++
      return client
    },
    reconfigure: async () => {
      reconfigurations++
    },
  })
  return {
    storagePath,
    tokenPath,
    authPath: join(dir, 'auth.json'),
    commands,
    client,
    counts: () => ({ connections, gets, reconfigurations }),
  }
}

test('a custody command verifies existing grants and credentials before changing mode', async () => {
  const f = await fixture()
  await f.commands.transition('claustrum')
  expect(getClaustrumMode(await loadAccounts(f.storagePath))).toBe('claustrum')
  expect(f.counts()).toEqual({ connections: 1, gets: 1, reconfigurations: 1 })
  await f.commands.transition('local')
  expect(getClaustrumMode(await loadAccounts(f.storagePath))).toBe('local')
  expect(f.counts()).toEqual({ connections: 1, gets: 1, reconfigurations: 2 })
})

test('local OAuth requires explicit setup consent; a slash command never deletes it', async () => {
  const f = await fixture()
  const auth = JSON.stringify({
    anthropic: {
      type: 'oauth',
      access: 'local-test-access',
      refresh: 'local-test-refresh',
      expires: 0,
    },
  })
  await writeFile(f.authPath, auth, { mode: 0o600 })
  const before = await readFile(f.storagePath, 'utf8')
  expect((await f.commands.transition('claustrum')).text).toContain('Refused:')
  expect(await readFile(f.authPath, 'utf8')).toBe(auth)
  expect(await readFile(f.storagePath, 'utf8')).toBe(before)
  expect(f.counts()).toEqual({ connections: 0, gets: 0, reconfigurations: 0 })
})

test('failed preflight does not commit mode or reconfigure the provider', async () => {
  const f = await fixture()
  f.client.getScoped = async () => ({
    material: 'vault-test-access',
    credentialId: 'oauth:anthropic',
    accountId: 'wrong-account',
    recordVersion: 1,
    expiresAtMs: Date.now() + 600_000,
  })
  await expect(f.commands.transition('claustrum')).rejects.toThrow('identity')
  expect(getClaustrumMode(await loadAccounts(f.storagePath))).toBe('local')
  expect(f.counts().reconfigurations).toBe(0)
})

test('terminal enrollment reset is local, locked and independent of daemon availability', async () => {
  const f = await fixture()
  await rm(f.tokenPath)
  const paths = getHostClaustrumEnrollmentPaths('pi')
  await writeFile(
    paths.statePath,
    JSON.stringify({
      version: 1,
      phase: 'denied',
      proposedName: 'anthropic-auth-pi',
      updatedAt: 1,
    }),
    { mode: 0o600 },
  )
  expect((await f.commands.reset()).text).toContain('cleared')
  expect(await f.commands.status()).toEqual({ state: 'idle' })
  expect(f.counts()).toEqual({ connections: 0, gets: 0, reconfigurations: 0 })
})
