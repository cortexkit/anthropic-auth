import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CacheKeepSessionRegistry,
  createNativeMenuExecutor,
  type NativeMenuRequest,
  resolveNativePoolPaths,
  StickySessionRouter,
} from '@cortexkit/anthropic-auth-core'
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from '@earendil-works/pi-coding-agent'
import { registerCommands } from '../commands.ts'
import { closePiNativeRuntime, getPiNativeRuntime } from '../native.ts'
import { createPiNativeCommands } from '../native-commands.ts'
import { readNativePiFixture, saveNativePiFixture } from './native-fixture.ts'

let directory: string
let storagePath: string
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'pi-native-commands-'))
  storagePath = join(directory, 'anthropic-auth.json')
  process.env.PI_ANTHROPIC_AUTH_FILE = storagePath
  process.env.PI_CODING_AGENT_DIR = directory
  process.env.PI_ANTHROPIC_AUTH_CACHEKEEP_REGISTRY_DIR = join(
    directory,
    'cachekeep',
  )
  process.env.PI_ANTHROPIC_AUTH_ROUTING_STATE_FILE = join(
    directory,
    'captured-routing.json',
  )
  await saveNativePiFixture(
    {
      version: 1,
      accounts: [
        {
          id: 'fallback',
          type: 'oauth',
          refresh: 'fixture-fallback-refresh',
          access: 'fixture-fallback-access',
          expires: Date.now() + 3_600_000,
        },
      ],
    },
    storagePath,
  )
})
afterEach(async () => {
  closePiNativeRuntime(storagePath)
  delete process.env.PI_ANTHROPIC_AUTH_FILE
  delete process.env.PI_CODING_AGENT_DIR
  delete process.env.PI_ANTHROPIC_AUTH_CACHEKEEP_REGISTRY_DIR
  delete process.env.PI_ANTHROPIC_AUTH_ROUTING_STATE_FILE
  await rm(directory, { recursive: true, force: true })
})

async function bytes() {
  const paths = await resolveNativePoolPaths(storagePath)
  return Promise.all(
    [paths.config, paths.state, paths.runtime, paths.journal].map((path) =>
      readFile(path, 'utf8'),
    ),
  )
}
function controller() {
  const backend = createPiNativeCommands(storagePath)
  const executor = createNativeMenuExecutor({
    host: 'pi',
    dispatch: backend.dispatch,
  })
  return {
    backend,
    execute: (request: NativeMenuRequest) =>
      executor.execute(request, {
        interactive: true,
        confirmed: true,
        sessionId: 'command-session',
      }),
  }
}
function registration() {
  const commands = new Map<
    string,
    Parameters<ExtensionAPI['registerCommand']>[1]
  >()
  const pi = {
    registerCommand: (
      name: string,
      definition: Parameters<ExtensionAPI['registerCommand']>[1],
    ) => commands.set(name, definition),
  } as unknown as ExtensionAPI
  const notified: string[] = []
  const ctx = {
    hasUI: false,
    ui: { notify: (message: string) => notified.push(message) },
    sessionManager: { getSessionId: () => 'command-session' },
  } as unknown as ExtensionCommandContext
  registerCommands(pi, createPiNativeCommands(storagePath))
  return { commands, ctx, notified }
}

describe('native account command persistence', () => {
  test('custody changes give offline guidance and preserve native config and state', async () => {
    const before = await bytes()
    const result = await controller().execute({
      action: 'custody-mode',
      values: { mode: 'claustrum' },
    })
    expect(result.status).toBe('guidance')
    expect(await bytes()).toEqual(before)
    expect(
      (await readNativePiFixture(storagePath)).claustrum?.mode ?? 'local',
    ).toBe('local')
  })
  test('disable persists to native storage without writing legacy files', async () => {
    expect(
      (
        await controller().execute({
          action: 'disable',
          values: { id: 'fallback' },
        })
      ).status,
    ).toBe('executed')
    expect(
      (await readNativePiFixture(storagePath)).accounts.find(
        (account) => account.id === 'fallback',
      )?.enabled,
    ).toBe(false)
    await expect(readFile(storagePath, 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })
  test('remove persists to native storage', async () => {
    expect(
      (
        await controller().execute({
          action: 'remove',
          values: { id: 'fallback' },
        })
      ).status,
    ).toBe('executed')
    expect(
      (await readNativePiFixture(storagePath)).accounts.find(
        (account) => account.id === 'fallback',
      ),
    ).toBeUndefined()
  })
  test('enable persists to native storage', async () => {
    const c = controller()
    await c.execute({ action: 'disable', values: { id: 'fallback' } })
    await c.execute({ action: 'enable', values: { id: 'fallback' } })
    expect(
      (await readNativePiFixture(storagePath)).accounts.find(
        (account) => account.id === 'fallback',
      )?.enabled,
    ).not.toBe(false)
  })
  test('reset-backoff clears native main refresh and quota errors with a lineage fence', async () => {
    await saveNativePiFixture(
      {
        version: 1,
        accounts: [],
        refresh: {
          mainLastRefreshError: {
            message: 'invalid_grant',
            checkedAt: Date.now(),
            permanent: true,
          },
        },
        quota: {
          mainLastQuotaApiError: {
            message: 'quota unavailable',
            checkedAt: Date.now(),
          },
        },
      },
      storagePath,
    )
    const before = await readNativePiFixture(storagePath)
    expect(before.refresh?.mainLastRefreshError).toBeDefined()
    expect(before.quota?.mainLastQuotaApiError).toBeDefined()
    const result = await controller().execute({ action: 'reset-backoff' })
    expect(result).toMatchObject({ status: 'executed', ok: true })
    const after = await readNativePiFixture(storagePath)
    expect(after.refresh?.mainLastRefreshError).toBeUndefined()
    expect(after.quota?.mainLastQuotaApiError).toBeUndefined()
  })
  test('account status is display-only and contains no credential material', async () => {
    const before = await bytes()
    const text = await controller().backend.readStatus('account', {})
    expect(text).toContain('fallback')
    expect(text).not.toContain('fixture-fallback-access')
    expect(text).not.toContain('fixture-fallback-refresh')
    expect(await bytes()).toEqual(before)
  })
})

describe('native diagnostics persistence', () => {
  test('sets log level and persists in native settings', async () => {
    await controller().execute({
      action: 'logging-level',
      values: { level: 'debug' },
    })
    expect((await readNativePiFixture(storagePath)).logging?.level).toBe(
      'debug',
    )
  })
  test('logging status shows current level without mutating', async () => {
    await controller().execute({
      action: 'logging-level',
      values: { level: 'warn' },
    })
    const before = await bytes()
    expect(await controller().backend.readStatus('logging', {})).toContain(
      'warn',
    )
    expect(await bytes()).toEqual(before)
  })
})

describe('native CacheKeep and routing commands', () => {
  test('lists tracked sessions from all live Pi instances', async () => {
    const registry = new CacheKeepSessionRegistry({
      directory: join(directory, 'cachekeep'),
      instanceId: 'other-pi-instance',
    })
    const cacheExpiresAt = Date.now() + 60 * 60_000
    await registry.publish([
      {
        id: 'pi-session-1',
        cacheExpiresAt,
        nextPrewarmAt: cacheExpiresAt - 5 * 60_000,
      },
    ])
    const text = await controller().backend.readStatus('cachekeep', {})
    expect(text).toContain('Tracked sessions: 1')
    expect(text).toContain('Sessions:\n- pi-session-1')
  })
  test('persists and reports the always schedule in native settings', async () => {
    await controller().execute({ action: 'cachekeep-always' })
    expect((await readNativePiFixture(storagePath)).cacheKeep).toMatchObject({
      enabled: true,
      always: true,
    })
    expect(await controller().backend.readStatus('cachekeep', {})).toContain(
      'Schedule: always (while this process is running)',
    )
  })
  test('reset clears only the current session assignment at the journal destination without changing mode', async () => {
    const path = await getPiNativeRuntime(storagePath).routingPath()
    const router = new StickySessionRouter({ path })
    for (const sessionId of ['command-session', 'other-session'])
      await router.resolve({
        sessionId,
        family: 'opus',
        modelId: 'claude-opus-5-5',
        inputBytes: 1,
        candidates: [
          { accountId: 'main', order: 0, quota: { kind: 'unknown' } },
        ],
        retainAccountIds: new Set(['main']),
        storage: await readNativePiFixture(storagePath),
      })
    const before = await readNativePiFixture(storagePath)
    await controller().execute({ action: 'routing-reset' })
    const cleared = await router.resolve({
      sessionId: 'command-session',
      family: 'opus',
      modelId: 'claude-opus-5-5',
      inputBytes: 1,
      candidates: [],
      retainAccountIds: new Set(['main']),
      storage: before,
    })
    expect(cleared).toBeNull()
    const other = await router.resolve({
      sessionId: 'other-session',
      family: 'opus',
      modelId: 'claude-opus-5-5',
      inputBytes: 1,
      candidates: [],
      retainAccountIds: new Set(['main']),
      storage: before,
    })
    expect(other?.accountId).toBe('main')
    expect((await readNativePiFixture(storagePath)).routing).toEqual(
      before.routing,
    )
  })
})

describe('single /claude menu and Pi Prime status', () => {
  test('registers only claude, not a legacy claude-prime alias', () => {
    expect([...registration().commands.keys()]).toEqual(['claude'])
  })
  test('Prime status leaves native config and state bytes unchanged', async () => {
    const before = await bytes()
    expect(await controller().backend.readStatus('prime', {})).toContain(
      'Prime',
    )
    expect(await bytes()).toEqual(before)
  })
  test('Prime on is unsupported in Pi and never toggles the persistent setting', async () => {
    const before = await bytes()
    expect(await controller().execute({ action: 'prime-on' })).toMatchObject({
      status: 'refused',
      code: 'unsupported-action',
    })
    expect(await bytes()).toEqual(before)
  })
  test('Prime off is unsupported in Pi and never toggles the persistent setting', async () => {
    const before = await bytes()
    expect(await controller().execute({ action: 'prime-off' })).toMatchObject({
      status: 'refused',
      code: 'unsupported-action',
    })
    expect(await bytes()).toEqual(before)
  })
  test('empty headless claude invocation shows status without mutating native storage', async () => {
    const before = await bytes()
    const { commands, ctx, notified } = registration()
    await commands.get('claude')?.handler('', ctx)
    expect(notified.join('\n')).toContain('Prime')
    expect(notified.join('\n')).not.toContain('fixture-fallback-access')
    expect(await bytes()).toEqual(before)
  })
})
