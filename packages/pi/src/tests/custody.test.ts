import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
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
  return {
    storagePath,
    tokenPath,
    authPath: join(dir, 'auth.json'),
    commands: createPiCustodyCommands(),
  }
}

test('custody mode commands give offline guidance without granting or changing authority', async () => {
  const f = await fixture()
  const before = await readFile(f.storagePath, 'utf8')
  const tokenBefore = await readFile(f.tokenPath, 'utf8')
  expect((await f.commands.transition('claustrum')).text).toContain(
    'offline setup',
  )
  expect(getClaustrumMode(await loadAccounts(f.storagePath))).toBe('local')
  expect((await f.commands.transition('local')).text).toContain('offline setup')
  expect(getClaustrumMode(await loadAccounts(f.storagePath))).toBe('local')
  expect(await readFile(f.storagePath, 'utf8')).toBe(before)
  expect(await readFile(f.tokenPath, 'utf8')).toBe(tokenBefore)
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
})

test('offline custody guidance does not need a live vault preflight or reconfigure the provider', async () => {
  const f = await fixture()
  await rm(f.tokenPath)
  const before = await readFile(f.storagePath, 'utf8')
  expect((await f.commands.transition('claustrum')).text).toContain(
    'offline setup',
  )
  expect(getClaustrumMode(await loadAccounts(f.storagePath))).toBe('local')
  expect(await readFile(f.storagePath, 'utf8')).toBe(before)
  await expect(readFile(f.tokenPath, 'utf8')).rejects.toMatchObject({
    code: 'ENOENT',
  })
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
})
