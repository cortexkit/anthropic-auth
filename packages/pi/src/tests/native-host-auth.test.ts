import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { requirePiNativeHostAuth } from '../paths.ts'

let directory: string | undefined
const priorAgentDirectory = process.env.PI_CODING_AGENT_DIR
afterEach(async () => {
  if (priorAgentDirectory === undefined) delete process.env.PI_CODING_AGENT_DIR
  else process.env.PI_CODING_AGENT_DIR = priorAgentDirectory
  if (directory) await rm(directory, { recursive: true, force: true })
  directory = undefined
})

async function fixture(entry?: unknown) {
  directory = await mkdtemp(join(tmpdir(), 'pi-native-host-auth-'))
  process.env.PI_CODING_AGENT_DIR = directory
  const path = join(directory, 'auth.json')
  if (entry !== undefined)
    await writeFile(path, JSON.stringify({ anthropic: entry }), { mode: 0o600 })
  return path
}

test('native Pi admission refuses leftover host OAuth without changing its file', async () => {
  const path = await fixture({
    type: 'oauth',
    access: 'synthetic-host-access',
    refresh: 'synthetic-host-refresh',
    expires: 1,
  })
  const before = await readFile(path, 'utf8')
  await expect(requirePiNativeHostAuth()).rejects.toThrow('offline setup')
  expect(await readFile(path, 'utf8')).toBe(before)
})

test('native Pi admission permits an absent host auth slot without creating it', async () => {
  const path = await fixture()
  await requirePiNativeHostAuth()
  await expect(readFile(path, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
})

test('native Pi admission refuses malformed host metadata with a redacted error', async () => {
  await fixture({ type: 'unknown', secret: 'synthetic-secret' })
  await expect(requirePiNativeHostAuth()).rejects.toThrow(
    'Cannot safely inspect Pi authentication metadata',
  )
})
