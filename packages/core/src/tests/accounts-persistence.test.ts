import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createEmptyStorage, loadAccounts, saveAccounts } from '../accounts.ts'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

test('preserves the Claustrum mode when a save supplies only handlesFile', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'accounts-persistence-'))
  directories.push(directory)
  const path = join(directory, 'anthropic-auth.json')
  const storage = createEmptyStorage()

  await saveAccounts({ ...storage, claustrum: { mode: 'claustrum' } }, path)
  await saveAccounts({ ...storage, claustrum: { handlesFile: '/x' } }, path)

  await expect(loadAccounts(path)).resolves.toMatchObject({
    claustrum: { mode: 'claustrum', handlesFile: '/x' },
  })
})

test('saveAccounts cannot persist a Claustrum mode change', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'accounts-persistence-'))
  directories.push(directory)
  const path = join(directory, 'anthropic-auth.json')
  const storage = createEmptyStorage()

  await saveAccounts({ ...storage, claustrum: { mode: 'claustrum' } }, path)
  // @ts-expect-error Persistent custody mode changes have a private capability.
  await saveAccounts({ ...storage, claustrum: { mode: 'local' } }, path, {
    writeClaustrumMode: true,
  })

  await expect(loadAccounts(path)).resolves.toMatchObject({
    claustrum: { mode: 'claustrum' },
  })
})

test('drops a persisted non-string Claustrum handlesFile', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'accounts-persistence-'))
  directories.push(directory)
  const path = join(directory, 'anthropic-auth.json')

  await writeFile(
    path,
    JSON.stringify({
      version: 1,
      accounts: [],
      claustrum: { handlesFile: 42 },
    }),
  )

  await expect(loadAccounts(path)).resolves.not.toMatchObject({
    claustrum: expect.anything(),
  })
})

test('drops a persisted blank Claustrum handlesFile', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'accounts-persistence-'))
  directories.push(directory)
  const path = join(directory, 'anthropic-auth.json')

  await writeFile(
    path,
    JSON.stringify({
      version: 1,
      accounts: [],
      claustrum: { handlesFile: '   ' },
    }),
  )

  await expect(loadAccounts(path)).resolves.not.toMatchObject({
    claustrum: expect.anything(),
  })
})
