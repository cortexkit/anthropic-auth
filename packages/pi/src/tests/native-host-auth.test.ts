import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { nativePiAuthSlotPaths } from '@cortexkit/anthropic-auth-core'
import { requirePiNativeHostAuth } from '../paths.ts'

let directory: string | undefined
const priorAgentDirectory = process.env.PI_CODING_AGENT_DIR
afterEach(async () => {
  delete process.env.CORTEXKIT_VAULT_HOST
  if (priorAgentDirectory === undefined) delete process.env.PI_CODING_AGENT_DIR
  else process.env.PI_CODING_AGENT_DIR = priorAgentDirectory
  if (directory) await rm(directory, { recursive: true, force: true })
  directory = undefined
})

test('hosted Pi accepts only the placeholder or an empty slot without writing auth.json', async () => {
  const path = await fixture({ type: 'api_key', key: 'temporary' })
  const placeholder = nativePiAuthSlotPaths({ authPath: path }).placeholderKey
  await writeFile(
    path,
    JSON.stringify({
      anthropic: { type: 'api_key', key: placeholder },
      other: { type: 'api_key', key: 'synthetic-other' },
    }),
  )
  process.env.CORTEXKIT_VAULT_HOST = 'thalamus'
  const before = await readFile(path, 'utf8')
  await requirePiNativeHostAuth()
  expect(await readFile(path, 'utf8')).toBe(before)
  await writeFile(
    path,
    JSON.stringify({
      anthropic: {
        type: 'api_key',
        key: placeholder,
        env: { ANTHROPIC_API_KEY: 'synthetic-extra-login' },
      },
    }),
  )
  const mixed = await readFile(path, 'utf8')
  await expect(requirePiNativeHostAuth()).rejects.toThrow(
    'This Thalamus-hosted head has its own Claude login.',
  )
  expect(await readFile(path, 'utf8')).toBe(mixed)
  await writeFile(path, '{"other":{"type":"api_key","key":"synthetic-other"}}')
  const empty = await readFile(path, 'utf8')
  await requirePiNativeHostAuth()
  expect(await readFile(path, 'utf8')).toBe(empty)
  await rm(path)
  await requirePiNativeHostAuth()
  await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' })
})

for (const entry of [
  {
    type: 'oauth',
    access: 'synthetic-host-access',
    refresh: 'synthetic-host-refresh',
    expires: 1,
  },
  { type: 'api_key', key: 'synthetic-real-key' },
]) {
  test(`hosted Pi refuses its own ${entry.type} login without stashing or rewriting it`, async () => {
    const path = await fixture(entry)
    process.env.CORTEXKIT_VAULT_HOST = 'thalamus'
    const before = await readFile(path, 'utf8')
    await expect(requirePiNativeHostAuth()).rejects.toThrow(
      'This Thalamus-hosted head has its own Claude login.',
    )
    expect(await readFile(path, 'utf8')).toBe(before)
    await expect(
      readFile(nativePiAuthSlotPaths({ authPath: path }).stashPath),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })
}

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
