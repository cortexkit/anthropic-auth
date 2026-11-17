import { expect } from 'bun:test'
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { getHostClaustrumEnrollmentPaths } from '../claustrum-enrollment.ts'
import { readNativeEnrollmentMode } from '../native-enrollment-authority.ts'
import {
  disconnectNativeVaultForHost,
  NativePiAuthSlotError,
  nativePiAuthSlotPaths,
  openNativePiAuthSlot,
} from '../native-vault-connection.ts'
import { createTestLifetimeSuite } from './test-lifetime.ts'

const { test, deferCleanup } = createTestLifetimeSuite()

async function fixture(host: 'pi' | 'opencode') {
  const root = await mkdtemp(join(tmpdir(), 'native-vault-disconnect-'))
  deferCleanup(() => rm(root, { recursive: true, force: true }))
  const env = {
    PI_CODING_AGENT_DIR: root,
    PI_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE: join(root, 'enrollment.json'),
    [`${host.toUpperCase()}_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE`]: join(
      root,
      'enrollment.json',
    ),
  }
  const enrollment = getHostClaustrumEnrollmentPaths(host, env)
  await writeFile(
    enrollment.tokenPath,
    JSON.stringify({ token: 'd'.repeat(64), token_generation: 1 }),
    { mode: 0o600 },
  )
  await writeFile(
    enrollment.statePath,
    JSON.stringify({
      version: 1,
      phase: 'approved',
      proposedName: `anthropic-auth-${host}`,
      tokenGeneration: 1,
      updatedAt: 1,
    }),
    { mode: 0o600 },
  )
  const localPaths = [
    'local-pool.json',
    'local-credentials.json',
    'local-runtime.json',
    'local-journal.json',
    'local-routing.json',
  ].map((name) => join(root, name))
  for (const path of localPaths)
    await writeFile(path, 'synthetic-local-recovery-bytes', { mode: 0o600 })
  const localBytes = () => Promise.all(localPaths.map((path) => readFile(path)))
  const beforeLocal = await localBytes()
  const { authPath, stashPath } = nativePiAuthSlotPaths({
    env,
    authPath: join(root, 'auth.json'),
  })
  const slot = openNativePiAuthSlot({ env, authPath })
  return {
    root,
    env,
    enrollment,
    authPath,
    stashPath,
    slot,
    localBytes,
    beforeLocal,
  }
}

for (const entry of [
  '{"type":"oauth", "access":"synthetic-access", "refresh":"synthetic-refresh", "expires":1}',
  '{ "type" : "api_key", "key" : "synthetic-key" }',
]) {
  test(`Pi disconnect clears the placeholder without restoring the discarded ${entry.includes('oauth') ? 'OAuth' : 'API-key'} sign-in`, async () => {
    const f = await fixture('pi')
    const original = `{\n  "other":{"type":"api_key","key":"synthetic-unrelated"},\n  "anthropic" : ${entry}\n}\n`
    await writeFile(f.authPath, original, { mode: 0o600 })
    await f.slot.enterVault()
    expect(await f.slot.inspect()).toEqual({
      slot: 'placeholder',
    })
    await expect(readFile(f.stashPath)).rejects.toMatchObject({
      code: 'ENOENT',
    })
    expect(await readNativeEnrollmentMode('pi', f.env)).toBe('claustrum')
    const modesAtClear: string[] = []
    expect(
      await disconnectNativeVaultForHost({
        host: 'pi',
        env: f.env,
        slot: {
          exitVault: async () => {
            modesAtClear.push(await readNativeEnrollmentMode('pi', f.env))
            return f.slot.exitVault()
          },
        },
      }),
    ).toBe('disconnected')
    expect(modesAtClear).toEqual(['claustrum'])
    expect(JSON.parse(await readFile(f.authPath, 'utf8'))).toEqual({
      other: { type: 'api_key', key: 'synthetic-unrelated' },
    })
    expect(await f.slot.inspect()).toEqual({ slot: 'empty' })
    expect(await readNativeEnrollmentMode('pi', f.env)).toBe('local')
    for (const path of [
      f.stashPath,
      f.enrollment.tokenPath,
      f.enrollment.statePath,
    ])
      await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await f.localBytes()).toEqual(f.beforeLocal)
  })
}

test('a new Pi sign-in survives disconnect while legacy stash and enrollment are removed', async () => {
  const f = await fixture('pi')
  await writeFile(
    f.authPath,
    '{"anthropic":{"type":"api_key","key":"synthetic-original"}}',
    { mode: 0o600 },
  )
  await f.slot.enterVault()
  await writeFile(
    f.authPath,
    '{"anthropic":{"type":"api_key","key":"synthetic-foreign"}}',
    { mode: 0o600 },
  )
  await mkdir(dirname(f.stashPath), { recursive: true, mode: 0o700 })
  await writeFile(f.stashPath, 'synthetic-unread-legacy-login', { mode: 0o600 })
  const before = await readFile(f.authPath)
  expect(await f.slot.inspect()).toEqual({ slot: 'original' })
  expect(
    await disconnectNativeVaultForHost({
      host: 'pi',
      env: f.env,
      slot: f.slot,
    }),
  ).toBe('disconnected')
  expect(await readFile(f.authPath)).toEqual(before)
  for (const path of [
    f.stashPath,
    f.enrollment.tokenPath,
    f.enrollment.statePath,
  ])
    await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await readNativeEnrollmentMode('pi', f.env)).toBe('local')
  expect(await f.localBytes()).toEqual(f.beforeLocal)
})

test('a malformed legacy Pi stash is deleted unread on disconnect', async () => {
  const f = await fixture('pi')
  await writeFile(
    f.authPath,
    '{"anthropic":{"type":"api_key","key":"synthetic-original"}}',
    { mode: 0o600 },
  )
  await f.slot.enterVault()
  await mkdir(dirname(f.stashPath), { recursive: true, mode: 0o700 })
  await writeFile(f.stashPath, 'synthetic-secret-invalid-json', { mode: 0o600 })
  expect(
    await disconnectNativeVaultForHost({
      host: 'pi',
      env: f.env,
      slot: f.slot,
    }),
  ).toBe('disconnected')
  expect(JSON.parse(await readFile(f.authPath, 'utf8'))).toEqual({})
  await expect(readFile(f.stashPath)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await f.localBytes()).toEqual(f.beforeLocal)
})

test('a Pi disconnect retry after clearing authentication still removes enrollment', async () => {
  const f = await fixture('pi')
  const original =
    '{"anthropic":{"type":"oauth","access":"synthetic-access","refresh":"synthetic-refresh","expires":1}}'
  await writeFile(f.authPath, original, { mode: 0o600 })
  await f.slot.enterVault()
  expect(await f.slot.exitVault()).toBe('cleared')
  expect(await f.slot.exitVault()).toBe('nothing-to-do')
  expect(
    await disconnectNativeVaultForHost({
      host: 'pi',
      env: f.env,
      slot: f.slot,
    }),
  ).toBe('disconnected')
  expect(JSON.parse(await readFile(f.authPath, 'utf8'))).toEqual({})
  expect(await readNativeEnrollmentMode('pi', f.env)).toBe('local')
  expect(await f.localBytes()).toEqual(f.beforeLocal)
})

test('Pi entry removes malformed legacy credentials even with an existing placeholder', async () => {
  const f = await fixture('pi')
  await f.slot.enterVault()
  const before = await readFile(f.authPath)
  await mkdir(dirname(f.stashPath), { recursive: true, mode: 0o700 })
  await writeFile(f.stashPath, 'synthetic-invalid-legacy-json', { mode: 0o600 })
  await f.slot.enterVault()
  expect(await readFile(f.authPath)).toEqual(before)
  await expect(readFile(f.stashPath)).rejects.toMatchObject({ code: 'ENOENT' })
})

test('Pi legacy stash symlink refusal retains enrollment after the placeholder was cleared', async () => {
  const f = await fixture('pi')
  await f.slot.enterVault()
  await mkdir(dirname(f.stashPath), { recursive: true, mode: 0o700 })
  const target = join(f.root, 'legacy-target')
  await writeFile(target, 'synthetic-untouched-legacy-secret', { mode: 0o600 })
  await symlink(target, f.stashPath)
  await expect(
    disconnectNativeVaultForHost({ host: 'pi', env: f.env, slot: f.slot }),
  ).rejects.toBeInstanceOf(NativePiAuthSlotError)
  expect(await readFile(target, 'utf8')).toBe(
    'synthetic-untouched-legacy-secret',
  )
  expect(JSON.parse(await readFile(f.authPath, 'utf8'))).toEqual({})
  expect(await readNativeEnrollmentMode('pi', f.env)).toBe('claustrum')
})

test('OpenCode disconnect never opens or changes host authentication or local recovery files', async () => {
  const f = await fixture('opencode')
  await mkdir(dirname(f.authPath), { recursive: true, mode: 0o700 })
  const original = 'synthetic-malformed-host-auth'
  await writeFile(f.authPath, original, { mode: 0o600 })
  expect(
    await disconnectNativeVaultForHost({ host: 'opencode', env: f.env }),
  ).toBe('disconnected')
  expect(await readFile(f.authPath, 'utf8')).toBe(original)
  expect(await readNativeEnrollmentMode('opencode', f.env)).toBe('local')
  expect(await f.localBytes()).toEqual(f.beforeLocal)
})

for (const host of ['opencode', 'pi'] as const) {
  test(`${host} explicit disconnect recovers malformed enrollment without reading or changing local account files`, async () => {
    const f = await fixture(host)
    const original =
      '{"anthropic":{"type":"api_key","key":"synthetic-original"}}'
    await writeFile(f.authPath, original, { mode: 0o600 })
    if (host === 'pi') await f.slot.enterVault()
    await writeFile(
      f.enrollment.tokenPath,
      'synthetic-corrupt-enrollment-token',
      { mode: 0o600 },
    )
    await writeFile(
      f.enrollment.statePath,
      'synthetic-corrupt-enrollment-state',
      { mode: 0o600 },
    )
    await expect(readNativeEnrollmentMode(host, f.env)).rejects.toMatchObject({
      code: 'invalid-token',
    })
    const result =
      host === 'pi'
        ? await disconnectNativeVaultForHost({ host, env: f.env, slot: f.slot })
        : await disconnectNativeVaultForHost({ host, env: f.env })
    expect(result).toBe('disconnected')
    if (host === 'pi')
      expect(JSON.parse(await readFile(f.authPath, 'utf8'))).toEqual({})
    else expect(await readFile(f.authPath, 'utf8')).toBe(original)
    expect(await readNativeEnrollmentMode(host, f.env)).toBe('local')
    expect(await f.localBytes()).toEqual(f.beforeLocal)
  })
}
