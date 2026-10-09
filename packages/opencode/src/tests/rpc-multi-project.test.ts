import { describe, expect, mock } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createEmptyStorage,
  QuotaHeaderFeedRegistry,
} from '@cortexkit/anthropic-auth-core'
import type { Hooks, PluginInput } from '@opencode-ai/plugin'
import { createOpencodeClient } from '@opencode-ai/sdk'
import { $ } from 'bun'
import { createTestLifetimeSuite } from '../../../core/src/tests/test-lifetime.ts'
import { AnthropicAuthPlugin } from '../index'
import { resetNotificationsForTest } from '../rpc/notifications'
import { discoverPortFile } from '../rpc/port-file'
import { getRpcDir } from '../rpc/rpc-dir'
import type { RpcServerHandle } from '../rpc/rpc-server'
import { drainSidebarWrites } from '../sidebar-state.ts'
import { migrateNativeOpencodeFixture } from './native-fixture.ts'
import { createTimerTracking } from './timer-tracking'

type RpcGlobal = typeof globalThis & {
  __anthropicAuthRpcServers?: Map<string, RpcServerHandle>
}

const lifetimes = createTestLifetimeSuite()
const test = lifetimes.test
// getPlugin supplies timer mocks to each project's plugin instance. They
// start no intervals, so background timers cannot outlive these RPC tests.
const { disabledPluginTimerOverrides } = createTimerTracking()

// Saved before each test and restored after it: every path variable that
// migrateNativeOpencodeFixture returns in its env, plus the profile-hydration
// switch and OPENCODE_AUTH_CONTENT, which this file sets or clears.
const envKeys = [
  'OPENCODE_ANTHROPIC_AUTH_FILE',
  'OPENCODE_ANTHROPIC_AUTH_STATE_FILE',
  'OPENCODE_ANTHROPIC_AUTH_ROUTING_STATE_FILE',
  'OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE',
  'OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_CONNECTION_FILE',
  'OPENCODE_ANTHROPIC_AUTH_SIDEBAR_STATE_FILE',
  'OPENCODE_ANTHROPIC_AUTH_CACHEKEEP_REGISTRY_DIR',
  'OPENCODE_ANTHROPIC_AUTH_QUOTA_FEED_DIR',
  'OPENCODE_ANTHROPIC_AUTH_RPC_DIR',
  'CLAUDE_CONFIG_DIR',
  'OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION',
  'OPENCODE_AUTH_CONTENT',
] as const

let testRoot: string
let startedRpcDirs: Set<string>
let createdPlugins: Hooks[]

/**
 * Supply one project's plugin with the same input shape as OpenCode, using a
 * real SDK client whose HTTP requests are answered inside the test process.
 * Record each prompted session ID. A configured prompt failure appears in the
 * command's RPC reply, identifying which project's client handled the action.
 */
function createHost(directory: string, rejectPromptsWith?: string) {
  const prompts: string[] = []
  const client = createOpencodeClient({
    baseUrl: 'http://opencode.invalid',
    fetch: async (request) => {
      const path = new URL(request.url).pathname
      if (request.method === 'GET' && /^\/session\/[^/]+\/message$/.test(path))
        return Response.json([])
      const prompt = /^\/session\/([^/]+)\/prompt_async$/.exec(path)
      if (request.method === 'POST' && prompt) {
        prompts.push(decodeURIComponent(prompt[1] ?? ''))
        if (rejectPromptsWith) throw new Error(rejectPromptsWith)
        return new Response(null, { status: 204 })
      }
      return Response.json({ name: 'NotFound' }, { status: 404 })
    },
  })
  const context: PluginInput = {
    client,
    project: {
      id: 'rpc-multi-project-fixture',
      worktree: directory,
      time: { created: Date.now() },
    },
    directory,
    worktree: directory,
    serverUrl: new URL('http://opencode.invalid'),
    experimental_workspace: { register() {} },
    $,
  }
  return { context, prompts }
}

/** Plugin construction starts a fallback-account refresh and exposes its promise for tests. */
function fallbackRefreshReady(hooks: Hooks): Promise<unknown> {
  const ready =
    '__fallbackRefreshReady' in hooks ? hooks.__fallbackRefreshReady : undefined
  if (!(ready instanceof Promise))
    throw new Error('Plugin did not expose its startup fallback refresh')
  return ready
}

async function getPlugin(
  directory: string,
  host = createHost(directory),
): Promise<Hooks> {
  startedRpcDirs.add(getRpcDir(directory))
  const creation = AnthropicAuthPlugin(
    host.context,
    disabledPluginTimerOverrides(),
  )
  lifetimes.trackDetached(creation)
  const hooks = await creation
  createdPlugins.push(hooks)
  // Plugin construction starts a background refresh of fallback accounts
  // without awaiting it. Track that promise so teardown waits for it before
  // deleting the files.
  lifetimes.trackDetached(fallbackRefreshReady(hooks))
  return hooks
}

async function postRpc(
  entry: { port: number; token: string },
  method: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  const response = await fetch(`http://127.0.0.1:${entry.port}/rpc/${method}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${entry.token}`,
    },
    body: JSON.stringify(body),
  })
  expect(response.status).toBe(200)
  return response.json()
}

/**
 * Ask one project's RPC server, through the /claude menu action the TUI sends,
 * to fire a lane start: a single automated cache-warm message posted to the
 * given session, to which no response is expected.
 */
async function fireLaneStartViaRpc(
  entry: { port: number; token: string },
  sessionId: string,
): Promise<{ ok: boolean; text: string }> {
  const result = await postRpc(entry, 'apply-menu', {
    command: 'claude',
    sectionId: 'Extras',
    actionId: 'start-fire',
    sessionId,
  })
  if (
    typeof result !== 'object' ||
    result === null ||
    !('ok' in result) ||
    typeof result.ok !== 'boolean' ||
    !('text' in result) ||
    typeof result.text !== 'string'
  )
    throw new Error('Menu RPC returned no apply result')
  return { ok: result.ok, text: result.text }
}

async function stopRpcServers() {
  const rpcGlobal = globalThis as RpcGlobal
  const servers = rpcGlobal.__anthropicAuthRpcServers
  const handles = new Set<RpcServerHandle>(servers?.values() ?? [])
  await Promise.all([...handles].map((server) => server.stop()))
  if (servers) {
    servers.clear()
    rpcGlobal.__anthropicAuthRpcServers = undefined
  }
}

/**
 * Every project directory shares one set of native credential and
 * configuration files, created by running the real offline migration on
 * synthetic legacy fixtures, as separate OpenCode projects on one machine do.
 *
 * Lifetime cleanups run in registration order, and the migration fixture
 * registers removal of its root only when it is called. The teardown below is
 * registered first, so it stops every plugin and RPC server and waits for all
 * queued sidebar writes before any fixture root or project directory is
 * removed.
 */
async function migratedProjects(
  legacyConfig: Record<string, unknown> = { ...createEmptyStorage() },
) {
  const savedEnv = new Map(envKeys.map((key) => [key, process.env[key]]))
  const projectsRoot = await mkdtemp(join(tmpdir(), 'aa-rpc-multi-project-'))
  const plugins: Hooks[] = []
  const rpcDirs = new Set<string>()
  testRoot = projectsRoot
  createdPlugins = plugins
  startedRpcDirs = rpcDirs
  lifetimes.deferCleanup(async () => {
    try {
      for (const plugin of plugins.reverse()) await plugin.dispose?.()
      for (const rpcDir of rpcDirs) {
        expect(
          (globalThis as RpcGlobal).__anthropicAuthRpcServers?.get(rpcDir),
        ).toBeUndefined()
        expect(await discoverPortFile(rpcDir)).toBeNull()
      }
    } finally {
      await stopRpcServers()
      await drainSidebarWrites()
      for (const key of envKeys) {
        const value = savedEnv.get(key)
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      await rm(projectsRoot, { recursive: true, force: true })
      resetNotificationsForTest()
    }
  })
  await stopRpcServers()
  const root = await mkdtemp(join(tmpdir(), 'aa-rpc-multi-project-pool-'))
  // migrateNativeOpencodeFixture registers deletion of the directory only
  // after it accepts it. This separate cleanup also removes the directory if
  // the fixture fails before accepting it.
  lifetimes.deferCleanup(() => rm(root, { recursive: true, force: true }))
  const fixture = await migrateNativeOpencodeFixture({
    root,
    lifetime: lifetimes,
    legacyConfig,
  })
  for (const [key, value] of Object.entries(fixture.env))
    process.env[key] = value
  // A relative RPC directory resolves inside each project directory. The
  // fixture's absolute RPC path would put every project's server in one
  // directory and hide the per-project separation these tests check.
  process.env.OPENCODE_ANTHROPIC_AUTH_RPC_DIR = '.rpc'
  // Startup otherwise fetches each OAuth account's profile in the background
  // without awaiting it. That request is unrelated to these tests and could
  // still be running when the temporary files are removed.
  process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION = '1'
  delete process.env.OPENCODE_AUTH_CONTENT
  return fixture
}

describe('RPC server lifecycle', () => {
  test('dispose stops and removes its server when feed cleanup rejects', async () => {
    // The migrated settings enable the quota header feed, so the plugin builds
    // the registry whose disposal is made to fail here.
    await migratedProjects({
      ...createEmptyStorage(),
      quotaHeaderFeed: { enabled: true },
    })
    const originalDispose = QuotaHeaderFeedRegistry.prototype.dispose
    let feedDisposals = 0
    QuotaHeaderFeedRegistry.prototype.dispose = async () => {
      feedDisposals++
      throw new Error('feed disposal failed')
    }
    try {
      const directory = join(testRoot, 'project')
      const plugin = await getPlugin(directory)
      const rpcDir = getRpcDir(directory)
      const entry = await discoverPortFile(rpcDir)

      expect(entry).not.toBeNull()
      await plugin.dispose?.()

      // Quota-feed disposal threw as configured. The assertions below prove
      // that this failure did not prevent RPC server cleanup.
      expect(feedDisposals).toBe(1)
      expect(await discoverPortFile(rpcDir)).toBeNull()
      expect(
        (globalThis as RpcGlobal).__anthropicAuthRpcServers?.get(rpcDir),
      ).toBeUndefined()
      await expect(
        fetch(`http://127.0.0.1:${entry?.port}/health`),
      ).rejects.toThrow()
    } finally {
      QuotaHeaderFeedRegistry.prototype.dispose = originalDispose
    }
  })

  test('keeps RPC servers live for distinct project directories', async () => {
    await migratedProjects()
    const directoryA = join(testRoot, 'project-a')
    const directoryB = join(testRoot, 'project-b')

    await getPlugin(directoryA)
    await getPlugin(directoryB)

    const entryA = await discoverPortFile(getRpcDir(directoryA))
    const entryB = await discoverPortFile(getRpcDir(directoryB))

    expect(entryA).not.toBeNull()
    expect(entryB).not.toBeNull()
    expect(entryA?.port).not.toBe(entryB?.port)
  })

  test('each project RPC server applies through its own plugin instance', async () => {
    await migratedProjects()
    const directoryA = join(testRoot, 'project-a')
    const directoryB = join(testRoot, 'project-b')
    const hostA = createHost(directoryA, 'applied by project-a')
    const hostB = createHost(directoryB, 'applied by project-b')
    await getPlugin(directoryA, hostA)
    await getPlugin(directoryB, hostB)

    const entryA = await discoverPortFile(getRpcDir(directoryA))
    const entryB = await discoverPortFile(getRpcDir(directoryB))

    expect(entryA).not.toBeNull()
    expect(entryB).not.toBeNull()
    if (!entryA || !entryB) return
    expect(
      JSON.parse(
        await readFile(
          join(getRpcDir(directoryA), `port-${process.pid}.json`),
          'utf8',
        ),
      ),
    ).toMatchObject({ port: entryA.port, token: entryA.token })
    expect(
      JSON.parse(
        await readFile(
          join(getRpcDir(directoryB), `port-${process.pid}.json`),
          'utf8',
        ),
      ),
    ).toMatchObject({ port: entryB.port, token: entryB.token })

    // The retired text apply endpoint only points at /claude; it must not
    // reach either project's session client.
    expect(
      await postRpc(entryA, 'apply', {
        command: 'claude-start',
        arguments: '',
        sessionId: 'session-a',
      }),
    ).toEqual({
      text: 'Open /claude to manage native Claude settings.',
      knobs: {},
    })
    expect(hostA.prompts).toHaveLength(0)
    expect(hostB.prompts).toHaveLength(0)

    // Lane start from the /claude menu prompts through the session client
    // of the plugin that owns the RPC server, for the requesting session only.
    const resultA = await fireLaneStartViaRpc(entryA, 'session-a')
    expect(resultA.text).toContain('applied by project-a')
    expect(resultA.text).not.toContain('applied by project-b')
    expect(hostA.prompts).toHaveLength(1)
    expect(hostA.prompts[0]).toBe('session-a')
    expect(hostB.prompts).toHaveLength(0)

    const resultB = await fireLaneStartViaRpc(entryB, 'session-b')
    expect(resultB.text).toContain('applied by project-b')
    expect(resultB.text).not.toContain('applied by project-a')
    expect(hostB.prompts).toHaveLength(1)
    expect(hostB.prompts[0]).toBe('session-b')
    expect(hostA.prompts).toHaveLength(1)
  })

  test('dispose stops its directory while another project remains live', async () => {
    await migratedProjects()
    const directoryA = join(testRoot, 'project-a')
    const directoryB = join(testRoot, 'project-b')
    const pluginA = await getPlugin(directoryA)
    const pluginB = await getPlugin(directoryB)
    const entryB = await discoverPortFile(getRpcDir(directoryB))

    expect(entryB).not.toBeNull()
    expect(pluginA.dispose).toBeFunction()
    await pluginA.dispose?.()

    expect(await discoverPortFile(getRpcDir(directoryA))).toBeNull()
    expect((await discoverPortFile(getRpcDir(directoryB)))?.port).toBe(
      entryB?.port,
    )
    expect(
      (await fetch(`http://127.0.0.1:${entryB?.port}/health`)).status,
    ).toBe(200)
    await pluginB.dispose?.()
  })

  test('late disposal cannot remove a same-directory successor port file', async () => {
    await migratedProjects()
    const directory = join(testRoot, 'project')
    const first = await getPlugin(directory)
    const second = await getPlugin(directory)
    const successor = await discoverPortFile(getRpcDir(directory))
    const successorHandle = (
      globalThis as RpcGlobal
    ).__anthropicAuthRpcServers?.get(getRpcDir(directory))

    expect(successor).not.toBeNull()
    expect(successorHandle).toBeDefined()
    await first.dispose?.()

    expect(
      (globalThis as RpcGlobal).__anthropicAuthRpcServers?.get(
        getRpcDir(directory),
      ),
    ).toBe(successorHandle)
    expect((await discoverPortFile(getRpcDir(directory)))?.port).toBe(
      successor?.port,
    )
    await second.dispose?.()
  })

  test('a dispose whose entry was replaced does not stop the successor server', async () => {
    await migratedProjects()
    const directory = join(testRoot, 'project')
    const first = await getPlugin(directory)
    const rpcGlobal = globalThis as RpcGlobal
    const rpcDir = getRpcDir(directory)
    const firstHandle = rpcGlobal.__anthropicAuthRpcServers?.get(rpcDir)
    const successorHandle: RpcServerHandle = {
      port: firstHandle?.port ?? 0,
      token: firstHandle?.token ?? '',
      stop: mock(async () => {}),
    }

    expect(firstHandle).toBeDefined()
    if (!firstHandle) return
    const stopSpy = mock(firstHandle.stop)
    firstHandle.stop = stopSpy
    rpcGlobal.__anthropicAuthRpcServers?.set(rpcDir, successorHandle)

    await first.dispose?.()

    // Both registry entries use the same port. Port-file checks alone cannot
    // detect an unintended call to stop the original server.
    expect(stopSpy).not.toHaveBeenCalled()
    expect(rpcGlobal.__anthropicAuthRpcServers?.get(rpcDir)).toBe(
      successorHandle,
    )
    // The registry no longer names the original server, so its plugin must
    // leave it running. Stop it explicitly for cleanup; the spy calls the real
    // stop function, which also removes its port file.
    await stopSpy()
    rpcGlobal.__anthropicAuthRpcServers?.delete(rpcDir)
  })

  test('a disposed project can start a discoverable RPC server again', async () => {
    await migratedProjects()
    const directory = join(testRoot, 'project')
    const first = await getPlugin(directory)

    await first.dispose?.()

    const replacement = await getPlugin(directory)
    const entry = await discoverPortFile(getRpcDir(directory))
    expect(entry).not.toBeNull()
    expect((await fetch(`http://127.0.0.1:${entry?.port}/health`)).status).toBe(
      200,
    )
    await replacement.dispose?.()
  })
})
