import { expect, spyOn, test } from 'bun:test'
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import {
  getStickyRoutingStatePath,
  resetVaultHostAuthorityForTests,
  resolveNativePoolPaths,
} from '@cortexkit/anthropic-auth-core'
import {
  type AssistantMessage,
  createAssistantMessageEventStream,
} from '@earendil-works/pi-ai'
import {
  type AgentSession,
  createAgentSessionFromServices,
  createAgentSessionServices,
  type ExtensionContext,
  type ExtensionError,
  type ExtensionUIContext,
  SessionManager,
  SettingsManager,
} from '@earendil-works/pi-coding-agent'
import { resetVaultHostAuthorityForTests as resetSourceHostAuthority } from '../../../core/src/native-vault-host.ts'
import { NativeAuthorityError } from '../../../core/src/pool-authority.ts'
import { createTestLifetimeSuite } from '../../../core/src/tests/test-lifetime.ts'
import cortexKitPiAnthropicAuth from '../index.ts'
import { closePiNativeRuntime, PiNativeRuntime } from '../native.ts'
import * as paths from '../paths.ts'
import { PI_HOSTED_LOGIN_REFUSAL } from '../paths.ts'
import { saveNativePiFixture } from './native-fixture.ts'

const lifetime = createTestLifetimeSuite()

// The refusal Core gives every host when no migration journal exists. Built
// from Core's own error so this file never pins a copy of its wording.
const MIGRATION_REQUIRED = new NativeAuthorityError('migration-required')
  .message

const success = () =>
  new Response(
    'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":1,"output_tokens":0}}}\n\nevent: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n',
  )

interface PiFixture {
  root: string
  agentDir: string
  storagePath: string
  /** Every URL the code under test tried to fetch. */
  fetches: string[]
  sessions: AgentSession[]
  /** Answers a fetch; by default every request is refused. */
  respond: (url: string) => Response
}

/**
 * An isolated Pi agent directory. Cleanup first stops every session and the
 * plugin runtime, so nothing new can start, then restores globals, then
 * removes the files.
 */
async function createPiFixture(): Promise<PiFixture> {
  const root = await mkdtemp(join(tmpdir(), 'pi-unmigrated-upgrade-'))
  const agentDir = join(root, 'agent')
  await mkdir(join(root, 'project'), { recursive: true })
  await mkdir(agentDir, { recursive: true, mode: 0o700 })
  const fixture: PiFixture = {
    root,
    agentDir,
    storagePath: join(agentDir, 'anthropic-auth.json'),
    fetches: [],
    sessions: [],
    respond: () => {
      throw new Error('network is not available to this test')
    },
  }
  process.env.PI_CODING_AGENT_DIR = agentDir
  delete process.env.PI_ANTHROPIC_AUTH_FILE
  // Core resolves the old state sidecar from this variable when it is set;
  // keep it beside the old account file, where a 1.x install kept it.
  process.env.OPENCODE_ANTHROPIC_AUTH_STATE_FILE = join(
    agentDir,
    'anthropic-auth-state.json',
  )
  const originalFetch = globalThis.fetch
  globalThis.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0]) => {
      const url = input instanceof Request ? input.url : String(input)
      fixture.fetches.push(url)
      return fixture.respond(url)
    },
    { preconnect: originalFetch.preconnect },
  )
  lifetime.deferCleanup(async () => {
    for (const session of fixture.sessions) session.dispose()
    await closePiNativeRuntime(fixture.storagePath)
  })
  lifetime.deferCleanup(() => {
    globalThis.fetch = originalFetch
    delete process.env.PI_CODING_AGENT_DIR
    delete process.env.OPENCODE_ANTHROPIC_AUTH_STATE_FILE
  })
  lifetime.deferCleanup(() => rm(root, { recursive: true, force: true }))
  return fixture
}

/**
 * Files a Pi install running the 1.x extension leaves behind: Pi's own
 * auth.json (with the OAuth login 1.x stored through its OAuth handler when
 * `hostOAuth` is set), the old account sidecar and its credential state
 * sidecar, and the old sticky-routing file.
 */
async function writeLegacyPiInstall(fixture: PiFixture, hostOAuth: boolean) {
  const auth = {
    ...(hostOAuth && {
      anthropic: {
        type: 'oauth',
        access: 'sk-ant-oat01-synthetic-legacy-host-access',
        refresh: 'sk-ant-ort01-synthetic-legacy-host-refresh',
        // Long expired, as a stored login usually is after an upgrade: Pi
        // would refresh it if any OAuth handler were registered.
        expires: 1,
      },
    }),
    openai: { type: 'api_key', key: 'synthetic-other-provider-key' },
  }
  await writeFile(join(fixture.agentDir, 'auth.json'), JSON.stringify(auth), {
    mode: 0o600,
  })
  await writeFile(
    fixture.storagePath,
    JSON.stringify({
      version: 1,
      mainAccountId: 'main',
      main: { type: 'opencode', provider: 'anthropic' },
      routing: { mode: 'sticky-balanced' },
      fallbackOn: [429],
      accounts: [
        {
          id: 'fallback-1',
          type: 'oauth',
          enabled: true,
          label: 'Fallback account',
        },
      ],
    }),
    { mode: 0o600 },
  )
  await writeFile(
    join(fixture.agentDir, 'anthropic-auth-state.json'),
    JSON.stringify({
      version: 1,
      accounts: {
        'fallback-1': {
          access: 'sk-ant-oat01-synthetic-legacy-fallback-access',
          refresh: 'sk-ant-ort01-synthetic-legacy-fallback-refresh',
          expires: 1,
          lastUsed: 50,
        },
      },
    }),
    { mode: 0o600 },
  )
  await writeFile(
    getStickyRoutingStatePath(fixture.storagePath),
    JSON.stringify({ version: 1, updatedAt: 10, assignments: {} }),
    { mode: 0o600 },
  )
}

/** Every file under the agent directory, with its exact bytes. */
async function captureTree(fixture: PiFixture): Promise<Map<string, Buffer>> {
  const files = new Map<string, Buffer>()
  const walk = async (directory: string) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await walk(path)
      else files.set(relative(fixture.agentDir, path), await readFile(path))
    }
  }
  await walk(fixture.agentDir)
  return files
}

/**
 * Loads the extension through the installed Pi SDK's real loader and model
 * runtime, then opens a session on Claude Fable 5.1.
 */
async function startPi(fixture: PiFixture) {
  const services = await createAgentSessionServices({
    cwd: join(fixture.root, 'project'),
    agentDir: fixture.agentDir,
    settingsManager: SettingsManager.inMemory({
      retry: { enabled: false },
      cacheWarming: 'off',
    }),
    resourceLoaderOptions: {
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      extensionFactories: [
        { name: 'cortexkit-anthropic', factory: cortexKitPiAnthropicAuth },
      ],
    },
  })
  const extensions = services.resourceLoader.getExtensions()
  // The extension loads, so the CLI has no load error to exit on and the
  // /claude menu is registered.
  expect(extensions.errors).toEqual([])
  expect(
    services.diagnostics.filter((entry) => entry.type === 'error'),
  ).toEqual([])
  const extension = extensions.extensions.find((candidate) =>
    candidate.commands.has('claude'),
  )
  if (!extension) throw new Error('The /claude command was not registered')
  // Pi's startup availability pass ran this provider's auth check without
  // recording an error that the CLI would report.
  expect(services.modelRuntime.getError()).toBeUndefined()
  // Registering a provider also starts an availability pass that Pi does not
  // await, and a newer pass discards an older one's result. Run one more pass
  // and await it, so the model list read below is this pass's complete result.
  const available = await services.modelRuntime.getAvailable()
  expect(services.modelRuntime.getError()).toBeUndefined()
  const provider =
    services.modelRuntime.getRegisteredNativeProvider('anthropic')
  if (!provider) throw new Error('The extension registered no provider')
  const model = services.modelRuntime.getModel('anthropic', 'claude-fable-5-1')
  if (!model) throw new Error('The extension registered no Fable model')
  const { session } = await createAgentSessionFromServices({
    services,
    sessionManager: SessionManager.inMemory(join(fixture.root, 'project')),
    model,
  })
  fixture.sessions.push(session)
  // Watch, without replacing, every route a prompt could take to credentials
  // or the provider.
  const routes = {
    hasConfiguredAuth: spyOn(services.modelRuntime, 'hasConfiguredAuth'),
    checkAuth: spyOn(services.modelRuntime, 'checkAuth'),
    getAuth: spyOn(services.modelRuntime, 'getAuth'),
    runtimeStream: spyOn(services.modelRuntime, 'streamSimple'),
    providerStream: spyOn(provider, 'streamSimple'),
  }
  lifetime.deferCleanup(() => {
    for (const route of Object.values(routes)) route.mockRestore()
  })
  return { services, session, extension, routes, available }
}

async function expectNoLegacyWrites(
  fixture: PiFixture,
  before: Map<string, Buffer>,
) {
  const after = await captureTree(fixture)
  // Old files keep their exact bytes, and nothing new appears except Pi's
  // own model catalog store: no account pool, runtime, roster, journal, lock,
  // or rewritten Pi credential file.
  expect(
    [...after.keys()].filter(
      (path) => !before.has(path) && path !== 'models-store.json',
    ),
  ).toEqual([])
  for (const [path, bytes] of before)
    expect(after.get(path)?.equals(bytes)).toBe(true)
  const paths = await resolveNativePoolPaths(fixture.storagePath)
  for (const path of [
    paths.config,
    paths.state,
    paths.runtime,
    paths.roster,
    paths.journal,
  ])
    expect(after.has(relative(fixture.agentDir, path))).toBe(false)
  expect(fixture.fetches).toEqual([])
}

const scenarios = [
  {
    name: 'old Pi OAuth login still stored, interactive',
    hostOAuth: true,
    ui: true,
  },
  {
    name: 'only the old account sidecars, without a UI',
    hostOAuth: false,
    ui: false,
  },
]

test.each(scenarios)(
  'an unmigrated 1.x Pi install loads and refuses prompts with the migration message: $name',
  lifetime.wrapBody(async ({ hostOAuth, ui }) => {
    const fixture = await createPiFixture()
    await writeLegacyPiInstall(fixture, hostOAuth)
    const before = await captureTree(fixture)

    const { session, extension, routes, available } = await startPi(fixture)
    expect(extension.handlers.get('input')?.length).toBe(1)
    // A stored Pi login hides the Anthropic provider from Pi's availability
    // list; without one, the provider stays listed. Either way the session
    // model was chosen explicitly, so prompts on it reach the extension's
    // migration refusal.
    expect(available.some((model) => model.provider === 'anthropic')).toBe(
      !hostOAuth,
    )

    const notices: Array<{ message: string; type?: string }> = []
    const stderr: string[] = []
    const extensionErrors: ExtensionError[] = []
    const writeStderr = spyOn(process.stderr, 'write').mockImplementation(
      (chunk: string | Uint8Array) => {
        stderr.push(String(chunk))
        return true
      },
    )
    lifetime.deferCleanup(() => writeStderr.mockRestore())
    const uiContext: ExtensionUIContext | undefined = ui
      ? {
          ...session.extensionRunner.getUIContext(),
          notify: (message, type) => {
            notices.push({ message, type })
          },
        }
      : undefined
    await session.bindExtensions({
      ...(uiContext && { uiContext }),
      onError: (error) => {
        extensionErrors.push(error)
      },
    })

    await session.prompt('hello')
    writeStderr.mockRestore()

    if (ui) {
      expect(notices).toEqual([{ message: MIGRATION_REQUIRED, type: 'error' }])
      expect(stderr).toEqual([])
    } else {
      expect(notices).toEqual([])
      expect(stderr).toEqual([`${MIGRATION_REQUIRED}\n`])
    }
    expect(extensionErrors).toEqual([])
    // Nothing was sent: no user turn, no assistant reply, no credential
    // check, auth resolution, refresh or provider stream.
    expect(session.messages).toEqual([])
    for (const route of Object.values(routes))
      expect(route).toHaveBeenCalledTimes(0)

    if (ui) {
      // Extension commands run before input handlers, so /claude is still
      // reached. With an argument it only answers with usage guidance, which
      // reads no account state.
      await session.prompt('/claude status')
      expect(notices.slice(1)).toEqual([
        {
          message: expect.stringContaining('Use /claude to open the menu.'),
          type: 'warning',
        },
      ])
    }
    await expectNoLegacyWrites(fixture, before)
  }),
)

test(
  'a migrated Pi store registers no prompt refusal and keeps the normal auth path',
  lifetime.wrapBody(async () => {
    const fixture = await createPiFixture()
    await saveNativePiFixture(
      { version: 1, accounts: [] },
      fixture.storagePath,
      { mainAccess: 'sk-ant-oat01-synthetic-healthy-main-access' },
    )
    const sent: string[] = []
    fixture.respond = (url) => {
      if (url.includes('/v1/messages')) sent.push(url)
      return success()
    }
    const refusalProbe = spyOn(PiNativeRuntime.prototype, 'migrationRefusal')
    lifetime.deferCleanup(() => refusalProbe.mockRestore())

    const { session, extension, routes, available } = await startPi(fixture)
    // A healthy startup never asks whether migration is missing and adds no
    // input handler.
    expect(refusalProbe).toHaveBeenCalledTimes(0)
    expect(extension.handlers.has('input')).toBe(false)
    expect(session.extensionRunner.hasHandlers('input')).toBe(false)
    expect(available.some((model) => model.provider === 'anthropic')).toBe(true)

    await session.prompt('hello')
    expect(session.messages.at(-1)).toMatchObject({
      role: 'assistant',
      stopReason: 'stop',
    })
    expect(routes.getAuth).toHaveBeenCalled()
    expect(routes.providerStream).toHaveBeenCalledTimes(1)
    expect(sent.length).toBe(1)
  }),
)

function beginHostedHeadFixture() {
  // Each hosted fixture models a new process, not a live authority change.
  resetVaultHostAuthorityForTests()
  resetSourceHostAuthority()
  process.env.CORTEXKIT_VAULT_HOST = 'thalamus'
  lifetime.deferCleanup(() => {
    delete process.env.CORTEXKIT_VAULT_HOST
  })
}

test(
  'a Thalamus-hosted Pi head with its own login loads and refuses its first request without changing auth.json',
  lifetime.wrapBody(async () => {
    const fixture = await createPiFixture()
    beginHostedHeadFixture()
    await writeLegacyPiInstall(fixture, true)
    const before = await readFile(join(fixture.agentDir, 'auth.json'))
    const slotRead = spyOn(paths, 'requirePiNativeHostAuth')
    lifetime.deferCleanup(() => slotRead.mockRestore())
    const { session, extension, routes } = await startPi(fixture)
    expect(extension.commands.has('claude')).toBe(true)
    expect(slotRead).toHaveBeenCalledTimes(0)
    const notices: string[] = []
    const writeStderr = spyOn(process.stderr, 'write').mockImplementation(
      (chunk: string | Uint8Array) => {
        notices.push(String(chunk))
        return true
      },
    )
    lifetime.deferCleanup(() => writeStderr.mockRestore())
    await session.bindExtensions({
      onError: (error) => {
        throw error
      },
    })
    await session.prompt('hello')
    expect(notices).toEqual([`${PI_HOSTED_LOGIN_REFUSAL}\n`])
    expect(session.messages).toEqual([])
    expect(slotRead).toHaveBeenCalledTimes(1)
    for (const route of Object.values(routes))
      expect(route).toHaveBeenCalledTimes(0)
    expect(fixture.fetches).toEqual([])
    expect(await readFile(join(fixture.agentDir, 'auth.json'))).toEqual(before)
  }),
)

test(
  'a Thalamus-hosted Pi head with its own Claude login still serves prompts on another provider',
  lifetime.wrapBody(async () => {
    const fixture = await createPiFixture()
    beginHostedHeadFixture()
    await writeLegacyPiInstall(fixture, true)
    const before = await readFile(join(fixture.agentDir, 'auth.json'))
    const slotRead = spyOn(paths, 'requirePiNativeHostAuth')
    lifetime.deferCleanup(() => slotRead.mockRestore())
    const { session, extension, available, routes } = await startPi(fixture)
    const model = available.find((candidate) => candidate.provider === 'openai')
    if (!model) throw new Error('Fixture OpenAI provider unavailable')
    await session.setModel(model)
    const inputs = extension.handlers.get('input')
    expect(inputs).toHaveLength(1)
    // Background vault and CacheKeep restoration also inspect the slot.
    // Isolate the input handler's synchronous provider gate before awaiting.
    slotRead.mockClear()
    const input = inputs![0]!(
      { type: 'input', text: 'another provider', source: 'interactive' },
      { model } as ExtensionContext,
    )
    expect(slotRead).toHaveBeenCalledTimes(0)
    expect(await input).toEqual({ action: 'continue' })
    routes.runtimeStream.mockImplementation((selected) => {
      expect(selected.provider).toBe('openai')
      const stream = createAssistantMessageEventStream()
      const message: AssistantMessage = {
        role: 'assistant',
        content: [{ type: 'text', text: 'synthetic other-provider reply' }],
        api: selected.api,
        provider: selected.provider,
        model: selected.id,
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: 'stop',
        timestamp: Date.now(),
      }
      stream.push({ type: 'done', reason: 'stop', message })
      stream.end()
      return stream
    })
    await session.bindExtensions({
      onError: (error) => {
        throw error
      },
    })
    await session.prompt('hello from another provider')
    expect(session.messages.at(-1)).toMatchObject({
      role: 'assistant',
      stopReason: 'stop',
      provider: 'openai',
    })
    expect(routes.runtimeStream).toHaveBeenCalledTimes(1)
    expect(routes.providerStream).toHaveBeenCalledTimes(0)
    expect(fixture.fetches).toEqual([])
    expect(await readFile(join(fixture.agentDir, 'auth.json'))).toEqual(before)
  }),
)
