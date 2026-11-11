import * as sqlite from 'bun:sqlite'
import { describe, expect, spyOn } from 'bun:test'
import { EventEmitter } from 'node:events'
import * as fsSync from 'node:fs'
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import * as fsPromises from 'node:fs/promises'
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import * as core from '@cortexkit/anthropic-auth-core'
import {
  createNativeAccountRuntime,
  createNativePoolStore,
  custodyTombstoneOAuth,
  getHostClaustrumEnrollmentPaths,
  inspectNativeHostAuthEntry,
  type NativeCustodyInventory,
  NativeMigrationError,
  nativePiAuthSlotPaths,
  type ProviderAccountUuid,
  readNativeEnrollmentMode,
  readNativeMigrationJournal,
  resetClaudeCodeIdentityCachesForTest,
  resolveLocalRoutingDestination,
  runNativeMigration,
  type SetupIO,
} from '@cortexkit/anthropic-auth-core'
import type { ScopedInventoryRow } from '@cortexkit/claustrum-client'
import { ClaustrumCredentialError } from '@cortexkit/claustrum-client'
import {
  ClaustrumEnrollmentManager,
  readClaustrumEnrollmentStatus,
} from '@cortexkit/common-auth/claustrum'
import { lockPathFor, withLock } from '@cortexkit/common-auth/fs'
import type {
  AccountHeadersResult,
  RequestScope,
} from '@cortexkit/common-auth/opencode2'
import { registerOpenCode2AuthMethods } from '@cortexkit/common-auth/opencode2'
import * as commonAuthSetup from '@cortexkit/common-auth/setup'
import type { IntegrationOAuthMethodRegistration } from '@opencode/plugin/promise/integration'
import { createOpencodeClient } from '@opencode-ai/sdk'
import { $ } from 'bun'
import { NativeCustodyError } from '../../../core/src/native-custody.ts'
import { NativePrivateFilesUnavailableError } from '../../../core/src/native-enrollment-authority.ts'
import {
  nativeQuotaCodec,
  toNativeQuotaMap,
} from '../../../core/src/native-quota-codec.ts'
import { createTestLifetimeSuite } from '../../../core/src/tests/test-lifetime.ts'
import { cliDiagnosticsDirectory } from '../cli-failure.ts'
import { AnthropicAuthPlugin } from '../index.ts'
import { runSetupCommand } from '../setup/command.ts'
import {
  completeNativeVaultActivation,
  NativeVaultActivationError,
  preflightNativeVaultForHost,
} from '../setup/native-activation.ts'
import {
  migrateNativeLocalForHost,
  SEPARATE_HOST_LOGIN_NOTICE,
} from '../setup/native-local.ts'
import { resolveNativeSetupPaths } from '../setup/native-paths.ts'
import { getOpenCodeAuthPath, getPiAuthPath } from '../setup/paths.ts'
import { ProcessFenceViolationError } from '../setup/process-fence.ts'
import {
  type CommandRunner,
  type CommandRunnerResult,
  type ProcessFence,
  SetupRefusal,
} from '../setup/types.ts'
import { CLAUDE_POOL_LOGIN_STEP } from '../v2/activation.ts'
import {
  createNativeAnthropicAdapter,
  type NativeAnthropicAttemptData,
} from '../v2/adapter.ts'
import { claudeLoginMethods } from '../v2/setup.ts'
import {
  createNativeAnthropicSource,
  type NativeSourceProvenance,
} from '../v2/source.ts'
import { extractUrl } from './test-fetch'

const lifetimes = createTestLifetimeSuite()

function createTestFence(
  running: Array<{ pid: number; command: string }> = [],
): ProcessFence {
  return {
    async listRunningHosts() {
      return running
    },
  }
}

function createMockRunner(
  handlers: Record<string, (args: string[]) => CommandRunnerResult> = {},
): CommandRunner {
  return {
    async run(command, args) {
      const handler = handlers[command] ?? handlers[basename(command)]
      if (handler) return handler(args)
      return { exitCode: 0, stdout: '', stderr: '' }
    },
  }
}

function observeSetupArguments() {
  const original = core.runSetup
  const calls: string[][] = []
  const spy = spyOn(core, 'runSetup').mockImplementation((plugin, argv, io) => {
    calls.push([...(argv ?? [])])
    return original(plugin, argv, io)
  })
  lifetimes.deferCleanup(() => spy.mockRestore())
  return calls
}

/** Record the host and the selected hosts each of our setup callbacks receives. */
function observeSetupCallbackHosts() {
  const original = core.runSetup
  const seen: Array<{ callback: string; host: string; hosts: string[] }> = []
  const spy = spyOn(core, 'runSetup').mockImplementation((plugin, argv, io) => {
    const { beforeSignIn, migrate } = plugin
    if (beforeSignIn)
      plugin.beforeSignIn = async (host, context) => {
        seen.push({ callback: 'beforeSignIn', host, hosts: [...context.hosts] })
        return beforeSignIn(host, context)
      }
    if (migrate)
      plugin.migrate = async (host, context) => {
        seen.push({ callback: 'migrate', host, hosts: [...context.hosts] })
        return migrate(host, context)
      }
    return original(plugin, argv, io)
  })
  lifetimes.deferCleanup(() => spy.mockRestore())
  return seen
}

function ambiguousSetupIO(io: SetupIO): SetupIO {
  const fs = io.fs!
  const second = join(io.env!.HOME!, 'fixture-bin', 'opencode2')
  return {
    ...io,
    fs: {
      ...fs,
      isFile: (path) => path === second || fs.isFile(path),
      isExecutable: (path) => path === second || fs.isExecutable(path),
    },
  }
}

/** Supply keys only after each expected prompt is rendered, and cancel pending reads before teardown joins. */
function scriptedSetupTerminal(
  output: Writable,
  script: Array<[string, string]>,
) {
  const input = Object.assign(new PassThrough(), {
    isTTY: true,
    isRaw: false,
    setRawMode(raw: boolean) {
      this.isRaw = raw
      return this
    },
  })
  const signals = new EventEmitter()
  const remaining = [...script]
  const prompts: string[] = []
  const terminal = {
    input,
    signals,
    output: Object.assign(
      new Writable({
        write(chunk, _encoding, done) {
          output.write(chunk)
          const next = remaining[0]
          if (next && String(chunk).includes(next[0])) {
            remaining.shift()
            prompts.push(next[0])
            queueMicrotask(() => input.write(next[1]))
          }
          done()
        },
      }),
      { columns: 160 },
    ),
  }
  const cancel = lifetimes.gate()
  lifetimes.trackDetached(
    cancel.wait.then(() => {
      input.isTTY = false
      signals.emit('SIGTERM')
      input.destroy()
    }),
  )
  return { terminal, prompts, remaining, close: cancel.open }
}

function detectionIO(
  env: NodeJS.ProcessEnv,
  hosts = { opencode: true, pi: false, claustrum: false },
): SetupIO {
  const bin = join(env.HOME!, 'fixture-bin')
  const executable = (path: string) =>
    Object.entries(hosts).some(
      ([name, found]) =>
        found && path === join(bin, name === 'claustrum' ? 'ck' : name),
    )
  return {
    env: { ...env, PATH: bin },
    platform: 'linux',
    fs: {
      exists: (path) =>
        (hosts.claustrum &&
          path === env.OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_CONNECTION_FILE) ||
        existsSync(path),
      isDirectory: (path) => {
        try {
          return statSync(path).isDirectory()
        } catch {
          return false
        }
      },
      isFile: executable,
      isExecutable: executable,
      readText: (path) => readFileSync(path, 'utf8'),
      realpath: realpathSync,
    },
    connect: async () => {
      let name = ''
      return {
        close() {},
        enrollPropose: async (input) => {
          name = input.name
          return { requestId: 'fixture-request' }
        },
        enrollPoll: async () => ({
          status: 'approved',
          name,
          token: 'c'.repeat(64),
          tokenGeneration: 1,
        }),
      }
    },
  }
}

describe('setup wizard command', () => {
  lifetimes.test(
    'aborts with error when OpenCode or Pi processes are running',
    async () => {
      const fence = createTestFence([{ pid: 1234, command: 'opencode serve' }])
      const runner = createMockRunner({
        opencode: () => ({ exitCode: 0, stdout: '1.18.30\n', stderr: '' }),
        pi: () => ({ exitCode: 0, stdout: '0.86.1\n', stderr: '' }),
        ck: () => ({ exitCode: 0, stdout: '0.20.8\n', stderr: '' }),
      })

      const fixture = await setupFailureFixture()
      const code = await runSetupCommand(['--yes'], {
        ...detectionIO(fixture.env),
        fence,
        runner,
      })
      expect(code).toBe(1)
    },
  )

  lifetimes.test(
    'dry run reports planned actions and does not modify disk',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'setup-dry-run-'))
      lifetimes.deferCleanup(() => rm(root, { recursive: true, force: true }))
      const bin = join(root, 'bin')
      await mkdir(bin)
      for (const host of ['opencode', 'pi', 'ck']) {
        await writeFile(join(bin, host), '', { mode: 0o755 })
      }

      const env: NodeJS.ProcessEnv = {
        HOME: root,
        PATH: bin,
        OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_CONNECTION_FILE: join(
          root,
          'unavailable-subc-connection.json',
        ),
        XDG_CONFIG_HOME: join(root, '.config'),
        XDG_DATA_HOME: join(root, '.local', 'share'),
        PI_CODING_AGENT_DIR: join(root, '.pi', 'agent'),
      }

      const fence = createTestFence([])
      const runner = createMockRunner({
        opencode: () => ({ exitCode: 0, stdout: '1.18.30\n', stderr: '' }),
        pi: () => ({ exitCode: 0, stdout: '0.86.1\n', stderr: '' }),
        ck: () => ({ exitCode: 0, stdout: '0.20.8\n', stderr: '' }),
      })

      const code = await runSetupCommand(
        ['--yes', '--dry-run', '--no-claustrum'],
        { fence, runner, env },
      )
      expect(code).toBe(0)

      // Verify no files were created
      const fs = await import('node:fs')
      expect(
        fs.existsSync(join(root, '.config', 'opencode', 'opencode.jsonc')),
      ).toBe(false)
      expect(
        fs.existsSync(join(root, '.local', 'share', 'opencode', 'auth.json')),
      ).toBe(false)
    },
  )

  lifetimes.test(
    'shared runner reports no selected hosts when neither OpenCode nor Pi is installed',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'setup-no-hosts-'))
      lifetimes.deferCleanup(() => rm(root, { recursive: true, force: true }))

      const env: NodeJS.ProcessEnv = {
        HOME: root,
        OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_CONNECTION_FILE: join(
          root,
          'unavailable-subc-connection.json',
        ),
        XDG_CONFIG_HOME: join(root, '.config'),
        XDG_DATA_HOME: join(root, '.local', 'share'),
        PI_CODING_AGENT_DIR: join(root, 'nonexistent-pi'),
      }

      const fence = createTestFence([])
      const runner = createMockRunner({
        opencode: () => ({ exitCode: 1, stdout: '', stderr: 'not found' }),
        pi: () => ({ exitCode: 1, stdout: '', stderr: 'not found' }),
        ck: () => ({ exitCode: 0, stdout: '0.20.8\n', stderr: '' }),
      })

      const code = await runSetupCommand(['--yes'], { fence, runner, env })
      expect(code).toBe(0)
    },
  )

  lifetimes.test(
    'configures OpenCode with pinned plugin and TUI entry',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'setup-opencode-'))
      lifetimes.deferCleanup(() => rm(root, { recursive: true, force: true }))

      const env: NodeJS.ProcessEnv = {
        HOME: root,
        OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_CONNECTION_FILE: join(
          root,
          'unavailable-subc-connection.json',
        ),
        XDG_CONFIG_HOME: join(root, '.config'),
        XDG_DATA_HOME: join(root, '.local', 'share'),
        PI_CODING_AGENT_DIR: join(root, 'nonexistent-pi'),
      }

      const configDir = join(root, '.config', 'opencode')
      await mkdir(configDir, { recursive: true })
      await writeFile(
        join(configDir, 'opencode.jsonc'),
        '{\n  "plugin": []\n}\n',
        'utf8',
      )

      const fence = createTestFence([])
      const runner = createMockRunner({
        opencode: () => ({ exitCode: 0, stdout: '1.18.30\n', stderr: '' }),
        pi: () => ({ exitCode: 1, stdout: '', stderr: 'not found' }),
        ck: () => ({ exitCode: 1, stdout: '', stderr: 'not found' }),
      })

      const code = await runSetupCommand(['--yes', '--no-claustrum'], {
        fence,
        runner,
        env,
        ...detectionIO(env),
      })
      expect(code).toBe(0)

      const updatedConfig = await readFile(
        join(configDir, 'opencode.jsonc'),
        'utf8',
      )
      expect(updatedConfig).toContain('@cortexkit/opencode-anthropic-auth@')

      const tuiConfig = await readFile(join(configDir, 'tui.jsonc'), 'utf8')
      expect(tuiConfig).toContain('@cortexkit/opencode-anthropic-auth@')
      const plan = await resolveNativeSetupPaths('opencode', env)
      const journal = await readNativeMigrationJournal(plan.paths)
      expect(journal?.phase).toBe('retired')
    },
  )
})

lifetimes.test(
  'explicit offline recovery login is performed before setup reports completion',
  async () => {
    const FRESH_ACCESS = 'sk-ant-oat01-fresh-main'
    const FRESH_UUID = 'aabbccdd-1122-3344-5566-778899001122'
    const root = await mkdtemp(join(tmpdir(), 'setup-offline-login-'))
    lifetimes.deferCleanup(() => rm(root, { recursive: true, force: true }))
    // Setup saves the sign-in only after the account's identity is looked up
    // for the exchanged token itself; the UUID the sign-in step reports is not
    // proof. Setup has no identity-lookup override, so answer the real lookup
    // (Claude Code's bootstrap request) for exactly the fresh synthetic token.
    // Any other token is refused, and any other request fails the test.
    const savedFetch = globalThis.fetch
    const identityLookups: string[] = []
    lifetimes.deferCleanup(() => {
      globalThis.fetch = savedFetch
      resetClaudeCodeIdentityCachesForTest()
    })
    resetClaudeCodeIdentityCachesForTest()
    globalThis.fetch = Object.assign(
      async (
        input: Parameters<typeof fetch>[0],
        init?: Parameters<typeof fetch>[1],
      ): Promise<Response> => {
        const url = new URL(extractUrl(input))
        if (
          url.origin !== 'https://api.anthropic.com' ||
          url.pathname !== '/api/claude_cli/bootstrap'
        )
          throw new Error(`Unexpected setup fetch: ${url.href}`)
        const authorization =
          new Headers(
            init?.headers ??
              (input instanceof Request ? input.headers : undefined),
          ).get('authorization') ?? ''
        identityLookups.push(authorization.replace(/^Bearer /, ''))
        if (authorization !== `Bearer ${FRESH_ACCESS}`)
          return new Response('unauthorized', { status: 401 })
        return Response.json({ oauth_account: { account_uuid: FRESH_UUID } })
      },
      { preconnect: savedFetch.preconnect },
    )
    const env: NodeJS.ProcessEnv = {
      HOME: root,
      XDG_CONFIG_HOME: join(root, '.config'),
      XDG_DATA_HOME: join(root, '.local', 'share'),
      PI_CODING_AGENT_DIR: join(root, 'absent-pi'),
      XDG_STATE_HOME: join(root, '.local', 'state'),
      OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_CONNECTION_FILE: join(
        root,
        'absent-connection',
      ),
    }
    const plan = await resolveNativeSetupPaths('opencode', env)
    await mkdir(dirname(plan.hostAuthPath), { recursive: true, mode: 0o700 })
    const oldAuth = JSON.stringify({
      anthropic: {
        type: 'oauth',
        access: 'sk-ant-oat01-old-unidentified',
        refresh: 'old-refresh',
        expires: Date.now() + 24 * 60 * 60_000,
      },
    })
    await writeFile(plan.hostAuthPath, oldAuth, { mode: 0o600 })
    await expect(
      runNativeMigration({
        ...plan,
        env,
        processFence: async () => {},
        requestVaultActivation: true,
        removePiAnthropicAuth: false,
      }),
    ).rejects.toThrow('setup --login --no-claustrum')
    expect(await readFile(plan.hostAuthPath, 'utf8')).toBe(oldAuth)
    expect(await readNativeMigrationJournal(plan.paths)).toBeUndefined()
    let logins = 0
    const options = {
      env,
      ...detectionIO(env),
      fence: createTestFence(),
      runner: createMockRunner({
        opencode: () => ({ exitCode: 0, stdout: '1.18.30\n', stderr: '' }),
        pi: () => ({ exitCode: 1, stdout: '', stderr: '' }),
        ck: () => ({ exitCode: 1, stdout: '', stderr: '' }),
      }),
      localLogin: async () => {
        logins++
        return {
          accountIdentity: FRESH_UUID,
          credential: {
            type: 'oauth' as const,
            access: FRESH_ACCESS,
            refresh: 'fresh-refresh',
            expires: Date.now() + 24 * 60 * 60_000,
          },
        }
      },
    }
    expect(
      await runSetupCommand(['--yes', '--no-claustrum', '--login'], options),
    ).toBe(0)
    expect(logins).toBe(1)
    // The fresh token's identity was looked up while setup ran, before it
    // reported completion. The offline migration itself sent no token anywhere,
    // so the old unidentified login was never presented for lookup.
    expect(identityLookups).toEqual([FRESH_ACCESS])
    // Setup decided the layout after the initial import probe. A reader opened
    // after setup must use that decision, not the probe's legacy paths.
    const completed = await resolveNativeSetupPaths('opencode', env)
    expect(completed.paths.storageId).toBe(plan.paths.storageId)
    expect(dirname(completed.paths.journal)).not.toBe(
      dirname(plan.paths.journal),
    )
    const target = core.resolveStateHomeTarget({ env })
    expect(target).toBeDefined()
    expect(dirname(completed.paths.journal)).toBe(await realpath(target!.dir))
    const marker = await core.readStateLayoutMarker(target!.dir)
    expect(marker?.phase).toBe('committed')
    expect(existsSync(plan.paths.journal)).toBe(false)
    const legacyPointer = await core.readRelocationPointer(plan.paths.runtime)
    expect(legacyPointer).toMatchObject({
      relocatedTo: await realpath(target!.dir),
      stateRoot: marker!.stateRoot,
      identity: marker!.identity,
      attempt: marker!.attempt,
    })
    expect(JSON.parse(await readFile(plan.paths.runtime, 'utf8'))).toEqual({
      version: 0,
      ...legacyPointer,
    })
    const runtime = createNativeAccountRuntime({
      paths: completed.paths,
      host: 'opencode',
      local: {
        refreshToken: async () => {
          throw new Error('Unexpected token refresh after fresh sign-in')
        },
        resolveIdentity: async (access) => {
          expect(access).toBe(FRESH_ACCESS)
          return {
            deviceId: 'synthetic-device',
            sessionId: 'synthetic-session',
            accountUuid: FRESH_UUID as ProviderAccountUuid,
          }
        },
      },
    })
    try {
      const snapshot = await runtime.read()
      expect(
        snapshot.accounts.find((account) => account.id === 'main')
          ?.accountIdentity,
      ).toBe(FRESH_UUID)
      expect((await readNativeMigrationJournal(completed.paths))?.phase).toBe(
        'retired',
      )
      const authorized = await runtime.authorizeLocal('main')
      expect(authorized).toMatchObject({ status: 'usable' })
      if (authorized.status !== 'usable')
        throw new Error('Fresh login did not authorize')
      expect(authorized.access).toBe(FRESH_ACCESS)
      expect(authorized.subject.binding.identity).toBe(FRESH_UUID)
    } finally {
      runtime.close()
    }
  },
)

// Synthetic credential shapes echoed by failing setup steps. The opaque and
// short values match no built-in pattern, so only exact-value redaction can
// remove them. The short value also occurs inside ECHO_JWT, so replacing it
// before the JWT pattern runs would split the token into unredacted pieces.
const ECHO_BEARER = 'Bearer synthBearerValue0123456789abcdefXYZ'
const ECHO_JWT =
  'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzeW50aGV0aWMtc2V0dXAifQ.c3ludGhldGljLXNldHVwLXNpZ25hdHVyZQ'
const ECHO_SK = 'sk-ant-synthetic0123456789abcdefSETUP'
const ECHO_OPAQUE = 'OPAQUE-synthetic-Zq7Xw2Vt9Lm4Hd8Rc'
const ECHO_SHORT = 'J9'
const ECHO_SECRETS = [
  'synthBearerValue0123456789abcdefXYZ',
  ECHO_JWT,
  ECHO_SK,
  ECHO_OPAQUE,
]

/** A substring of every long echoed secret, long enough to identify it. */
function secretFragments(): string[] {
  const fragments: string[] = []
  for (const secret of ECHO_SECRETS)
    for (let start = 0; start + 8 <= secret.length; start += 4)
      fragments.push(secret.slice(start, start + 8))
  return fragments
}

function expectNoSecretFragments(text: string) {
  for (const fragment of secretFragments())
    expect(text.includes(fragment) ? fragment : '').toBe('')
}

interface SetupFailureFixture {
  env: NodeJS.ProcessEnv
  screen: () => string
  output: Writable
  diagnostics: string
}

/**
 * A temporary home directory and a captured screen. The directory is removed
 * during the current test's lifetime cleanup.
 */
async function setupFailureFixture(): Promise<SetupFailureFixture> {
  const root = await mkdtemp(join(tmpdir(), 'setup-failure-'))
  lifetimes.deferCleanup(() => rm(root, { recursive: true, force: true }))
  const chunks: string[] = []
  const output = new Writable({
    write(chunk, _encoding, done) {
      chunks.push(String(chunk))
      done()
    },
  })
  const env: NodeJS.ProcessEnv = {
    HOME: root,
    XDG_CONFIG_HOME: join(root, '.config'),
    XDG_DATA_HOME: join(root, '.local', 'share'),
    XDG_STATE_HOME: join(root, '.local', 'state'),
    PI_CODING_AGENT_DIR: join(root, '.pi', 'agent'),
    OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_CONNECTION_FILE: join(
      root,
      'absent-connection.json',
    ),
    // Child processes inherit this environment, so its secret-named values
    // are known credentials for redaction.
    SYNTHETIC_SERVICE_TOKEN: ECHO_OPAQUE,
    SYNTHETIC_SHORT_API_KEY: ECHO_SHORT,
  }
  const diagnostics = cliDiagnosticsDirectory(env)
  if (diagnostics === undefined) throw new Error('No diagnostics directory')
  return {
    env,
    // biome-ignore lint/suspicious/noControlCharactersInRegex: strips terminal control codes
    screen: () => chunks.join('').replace(/\u001b\[[0-9;?]*[a-zA-Z]/g, ''),
    output,
    diagnostics,
  }
}

interface DiagnosticRecord {
  path: string
  text: string
  /** Fixed fields from the Core-formatted header line. */
  payload: Record<string, unknown>
  /** The redacted, bounded detail lines written after the header. */
  detail: string[]
}

/**
 * The diagnostics file the screen points at: it must be the only file in the
 * owner-only directory, and itself owner-only. Its first line is the header;
 * the rest is the detail.
 */
async function screenDiagnostic(
  fixture: SetupFailureFixture,
  screenLine: string,
): Promise<DiagnosticRecord> {
  const prefix = `${screenLine} Details were written to `
  const screen = fixture.screen()
  const start = screen.indexOf(prefix)
  expect(start).toBeGreaterThanOrEqual(0)
  const path = screen.slice(start + prefix.length).split('\n')[0] ?? ''
  expect(dirname(path)).toBe(fixture.diagnostics)
  expect(await readdir(fixture.diagnostics)).toEqual([
    path.slice(fixture.diagnostics.length + 1),
  ])
  expect((await stat(fixture.diagnostics)).mode & 0o777).toBe(0o700)
  expect((await stat(path)).mode & 0o777).toBe(0o600)
  const text = await readFile(path, 'utf8')
  expect(text.endsWith('\n')).toBe(true)
  const [header = '', ...detail] = text.slice(0, -1).split('\n')
  return {
    path,
    text,
    payload: JSON.parse(header.slice(header.indexOf(' {') + 1)),
    detail,
  }
}

async function expectNoDiagnostics(fixture: SetupFailureFixture) {
  await expect(stat(fixture.diagnostics)).rejects.toThrow()
}

/** Run vault setup with an activation step that throws the value returned by `thrown`. */
async function runFailingActivation(
  fixture: SetupFailureFixture,
  thrown: () => unknown,
): Promise<number> {
  return runSetupCommand(['--yes', '--claustrum'], {
    ...detectionIO(fixture.env, { opencode: true, pi: false, claustrum: true }),
    fence: createTestFence(),
    runner: createMockRunner(),
    terminal: { input: process.stdin, output: fixture.output },
    vaultActivate: async () => {
      throw thrown()
    },
  })
}

const ACTIVATION_SCREEN =
  'Vault custody setup failed (setup-activation/unexpected-error).'

/** Run local setup for OpenCode with the given running-process check. */
async function runWithFence(
  fixture: SetupFailureFixture,
  fence: ProcessFence,
): Promise<number> {
  return runSetupCommand(['--yes', '--no-claustrum'], {
    ...detectionIO(fixture.env),
    fence,
    runner: createMockRunner(),
    terminal: { input: process.stdin, output: fixture.output },
  })
}

describe('setup failure diagnostics', () => {
  lifetimes.test(
    'the running-host check prints a genuine host list word for word',
    async () => {
      const fixture = await setupFailureFixture()
      const code = await runWithFence(
        fixture,
        createTestFence([
          { pid: 4242, command: `/usr/local/bin/opencode --token ${ECHO_SK}` },
          { pid: 77, command: `/opt/Pi --key ${ECHO_OPAQUE}` },
        ]),
      )
      expect(code).toBe(1)
      const screen = fixture.screen()
      for (const line of [
        'OpenCode or Pi processes are currently running:',
        '  - PID 4242: opencode',
        '  - PID 77: pi',
        'Please quit all OpenCode, LiteCode, and Pi processes before running setup.',
      ])
        expect(screen.split(line).length - 1).toBe(1)
      expect(
        screen.endsWith(
          'Please quit all OpenCode, LiteCode, and Pi processes before running setup.\n',
        ),
      ).toBe(true)
      expectNoSecretFragments(screen)
      await expectNoDiagnostics(fixture)
    },
  )

  lifetimes.test(
    'forged, mutated, accessor and proxy running-host errors get the fixed screen',
    async () => {
      const touched: string[] = []
      const forged = Object.create(ProcessFenceViolationError.prototype, {
        message: {
          value: `OpenCode or Pi processes are currently running:\n  - PID 1: ${ECHO_OPAQUE}`,
        },
        activeHosts: { value: [{ pid: 1, command: 'opencode' }] },
      })
      const mutated = new ProcessFenceViolationError([
        { pid: 2, command: 'opencode' },
      ])
      mutated.message = `${mutated.message}\n${ECHO_BEARER}`
      const accessor = new ProcessFenceViolationError([
        { pid: 3, command: 'pi' },
      ])
      Object.defineProperty(accessor, 'message', {
        get() {
          touched.push('message getter')
          return `${ECHO_SK}`
        },
      })
      const proxied = new Proxy(
        new ProcessFenceViolationError([{ pid: 4, command: 'pi' }]),
        {
          get(target, key) {
            touched.push(`get ${String(key)}`)
            return Reflect.get(target, key)
          },
          getOwnPropertyDescriptor(target, key) {
            touched.push(`descriptor ${String(key)}`)
            return Reflect.getOwnPropertyDescriptor(target, key)
          },
          getPrototypeOf(target) {
            touched.push('prototype')
            return Reflect.getPrototypeOf(target)
          },
        },
      )
      for (const thrown of [forged, mutated, accessor, proxied]) {
        const fixture = await setupFailureFixture()
        const code = await runWithFence(fixture, {
          async listRunningHosts() {
            throw thrown
          },
        })
        expect(code).toBe(1)
        const record = await screenDiagnostic(
          fixture,
          'Host process check failed (setup-process-check/unexpected-error).',
        )
        expect(fixture.screen()).not.toContain('currently running')
        expectNoSecretFragments(fixture.screen())
        expectNoSecretFragments(record.text)
      }
      // runSetup's instanceof ProcessInspectionError check touches this proxy's prototype once.
      // This assertion permits that prototype check, but no credential-bearing getters may be read.
      expect(touched).toEqual(['prototype'])
    },
  )
  lifetimes.test(
    'activation failure shows only stage, code and a private file holding the scrubbed detail',
    async () => {
      const fixture = await setupFailureFixture()
      const message = [
        'vault refused enrollment',
        `auth header: ${ECHO_BEARER}`,
        `jwt echo: ${ECHO_JWT}`,
        `key echo: ${ECHO_SK}`,
        `install token rejected: ${ECHO_OPAQUE}`,
        `short key echo: ${ECHO_SHORT}`,
      ].join('\n')
      const code = await runFailingActivation(fixture, () => new Error(message))
      expect(code).toBe(1)

      const screen = fixture.screen()
      expect(screen).not.toContain('vault refused enrollment')
      expect(screen).not.toContain(`: ${ECHO_SHORT}`)
      expectNoSecretFragments(screen)

      const record = await screenDiagnostic(fixture, ACTIVATION_SCREEN)
      expect(record.text).toContain(' ERROR [cli] Vault custody setup failed ')
      expect(record.payload.stage).toBe('setup-activation')
      expect(record.payload.code).toBe('setup-activation/unexpected-error')
      const detail = record.detail
      expect(detail[0]).toBe('Error: vault refused enrollment')
      expect(detail).toContain('auth header: Bearer [REDACTED]')
      expect(detail).toContain('jwt echo: [REDACTED]')
      expect(detail).toContain('key echo: [REDACTED]')
      // ECHO_OPAQUE and ECHO_SHORT match no built-in pattern; they are redacted
      // only because the fixture environment passes them under secret names.
      expect(detail).toContain('install token rejected: [REDACTED]')
      expect(detail).toContain('short key echo: [REDACTED]')
      expect(detail.some((line) => String(line).startsWith('    at '))).toBe(
        true,
      )
      expectNoSecretFragments(record.text)
    },
  )

  lifetimes.test(
    'known remedies, custody codes and the process-fence list stay word for word',
    async () => {
      const remedies: Array<[unknown, string[]]> = [
        [
          new NativeVaultActivationError('primary-conflict'),
          [
            'Pi has a stored Anthropic API key, which would take precedence over the vault account. Remove it in Pi, then rerun setup.',
          ],
        ],
        [
          new NativeMigrationError('primary-unverified'),
          [
            'Stop OpenCode and Pi, then run npx @cortexkit/opencode-anthropic-auth setup --login --no-claustrum. Existing credentials have not been changed.',
          ],
        ],
        [
          new NativeCustodyError('invalid-token'),
          ['Native custody refused: invalid-token'],
        ],
        [
          new NativeCustodyError('host-slot-placeholder'),
          ['Native custody refused: host-slot-placeholder'],
        ],
        [
          new NativePrivateFilesUnavailableError(),
          [
            "Private file support didn't load on this machine (@cortexkit/private-files). Reinstall the plugin; if this persists, report it with your OS and Node version.",
          ],
        ],
        [
          // common-auth 0.24.0 and later refuse a Windows private-file
          // operation like this when the native addon did not load; its own
          // message names the file, so only the fixed remedy is shown.
          Object.assign(
            new Error(
              `Private file refused at directory: /private/${ECHO_OPAQUE}/state (native-addon-unavailable).`,
            ),
            {
              name: 'PrivateFileError',
              stage: 'directory',
              code: 'ERR_PRIVATE_FILES_UNAVAILABLE',
              reason: 'native-addon-unavailable',
            },
          ),
          [
            "Private file support didn't load on this machine (@cortexkit/private-files). Reinstall the plugin; if this persists, report it with your OS and Node version.",
          ],
        ],
        [
          new ProcessFenceViolationError([
            {
              pid: 4242,
              command: `/usr/local/bin/opencode --token ${ECHO_SK}`,
            },
            { pid: 77, command: `/opt/Pi --key ${ECHO_OPAQUE}` },
          ]),
          [
            'OpenCode or Pi processes are currently running:',
            '  - PID 4242: opencode',
            '  - PID 77: Pi',
            'Please quit all OpenCode, LiteCode, and Pi processes before running setup.',
          ],
        ],
      ]
      for (const [thrown, expected] of remedies) {
        const fixture = await setupFailureFixture()
        expect(await runFailingActivation(fixture, () => thrown)).toBe(1)
        for (const line of expected) expect(fixture.screen()).toContain(line)
        expect(fixture.screen()).not.toContain(ACTIVATION_SCREEN)
        expectNoSecretFragments(fixture.screen())
        await expectNoDiagnostics(fixture)
      }
    },
  )

  lifetimes.test(
    'forged and mutated closed errors fall back to the fixed screen',
    async () => {
      const forged = Object.create(NativeMigrationError.prototype, {
        message: { value: `Native migration: ${ECHO_OPAQUE}` },
        code: { value: 'migration-busy' },
      })
      const mutatedMigration = new NativeMigrationError('migration-busy')
      mutatedMigration.message = `Native migration: ${ECHO_SK}`
      const mutatedActivation = new NativeVaultActivationError(
        'consent-required',
      )
      Object.defineProperty(mutatedActivation, 'message', {
        value: `${mutatedActivation.message} ${ECHO_OPAQUE}`,
      })
      const mutatedFence = new ProcessFenceViolationError([
        { pid: 9, command: 'opencode' },
      ])
      mutatedFence.message = `${mutatedFence.message}\n${ECHO_BEARER}`
      // activeHosts is changed after construction, so the message no longer
      // matches what ProcessFenceViolationError builds from the current list.
      const inconsistentFence = new ProcessFenceViolationError([
        { pid: 9, command: 'opencode' },
      ])
      inconsistentFence.activeHosts[0] = { pid: 9, command: ECHO_SK }
      for (const thrown of [
        forged,
        mutatedMigration,
        mutatedActivation,
        mutatedFence,
        inconsistentFence,
      ]) {
        const fixture = await setupFailureFixture()
        expect(await runFailingActivation(fixture, () => thrown)).toBe(1)
        const record = await screenDiagnostic(fixture, ACTIVATION_SCREEN)
        expectNoSecretFragments(fixture.screen())
        expectNoSecretFragments(record.text)
      }
    },
  )

  lifetimes.test(
    'malformed, proxy and getter throws are never inspected through code',
    async () => {
      const touched: string[] = []
      const trapped = new Proxy(new Error(ECHO_SK), {
        get(target, key) {
          touched.push(`get ${String(key)}`)
          return Reflect.get(target, key)
        },
        getOwnPropertyDescriptor(target, key) {
          touched.push(`descriptor ${String(key)}`)
          return Reflect.getOwnPropertyDescriptor(target, key)
        },
        getPrototypeOf(target) {
          touched.push('prototype')
          return Reflect.getPrototypeOf(target)
        },
        has(target, key) {
          touched.push(`has ${String(key)}`)
          return Reflect.has(target, key)
        },
        ownKeys(target) {
          touched.push('keys')
          return Reflect.ownKeys(target)
        },
      })
      const getterError = new Error('placeholder')
      Object.defineProperty(getterError, 'message', {
        get() {
          touched.push('message getter')
          return 'Disconnect from the vault first.'
        },
      })
      Object.defineProperty(getterError, 'stack', {
        get() {
          touched.push('stack getter')
          return ECHO_JWT
        },
      })
      const jsonish = {
        toJSON() {
          touched.push('toJSON')
          return ECHO_OPAQUE
        },
        toString() {
          touched.push('toString')
          return ECHO_OPAQUE
        },
        get name() {
          touched.push('name getter')
          return 'NativeVaultActivationError'
        },
      }
      // Has the name and Error type of ProcessFenceViolationError but was not
      // created by that class, and its message is not a fixed text.
      const impostor = Object.assign(new Error(`${ECHO_BEARER}`), {
        name: 'ProcessFenceViolationError',
      })
      const cases: Array<[string, unknown]> = [
        ['proxy', trapped],
        ['getter', getterError],
        ['toJSON', jsonish],
        ['impostor', impostor],
        ['string', `raw ${ECHO_BEARER} ${ECHO_OPAQUE}`],
        ['null', null],
      ]
      for (const [label, thrown] of cases) {
        const fixture = await setupFailureFixture()
        expect([
          label,
          await runFailingActivation(fixture, () => thrown),
        ]).toEqual([label, 1])
        const record = await screenDiagnostic(fixture, ACTIVATION_SCREEN)
        expectNoSecretFragments(fixture.screen())
        expectNoSecretFragments(record.text)
      }
      expect(touched).toEqual([])
    },
  )

  lifetimes.test(
    'an existing diagnostics directory that is not owner-only is refused, not repaired',
    async () => {
      const fixture = await setupFailureFixture()
      await mkdir(fixture.diagnostics, { recursive: true, mode: 0o755 })
      await writeFile(join(fixture.diagnostics, 'operator.log'), 'kept\n')
      expect(
        await runFailingActivation(fixture, () => new Error(ECHO_OPAQUE)),
      ).toBe(1)
      expect(fixture.screen()).toContain(
        `${ACTIVATION_SCREEN} Details could not be saved to a private diagnostics file.`,
      )
      expectNoSecretFragments(fixture.screen())
      expect((await stat(fixture.diagnostics)).mode & 0o777).toBe(0o755)
      expect(await readdir(fixture.diagnostics)).toEqual(['operator.log'])
      expect(
        await readFile(join(fixture.diagnostics, 'operator.log'), 'utf8'),
      ).toBe('kept\n')
    },
  )

  lifetimes.test(
    'shared Pi installer failure keeps only safe command details in private diagnostics',
    async () => {
      const fixture = await setupFailureFixture()
      const noise = Array.from(
        { length: 4000 },
        (_, index) => `npm notice line ${index} résumé ✓ 漢字`,
      )
      // These lines sit around the point where the kept tail begins, so a tail
      // cut before redaction would keep only part of a credential.
      const straddling = [
        `token echo: ${ECHO_OPAQUE}${ECHO_OPAQUE}`,
        `authorization: ${ECHO_BEARER}`,
        `jwt: ${ECHO_JWT}`,
        `key: ${ECHO_SK}`,
      ]
      const lastLines = Array.from(
        { length: 90 },
        (_, index) =>
          `${straddling[index % straddling.length]} trailing ${index} ✓`,
      )
      const stderr = `${[...noise, ...lastLines, 'npm error final line ✓'].join('\n')}\n`
      expect(new TextEncoder().encode(stderr).length).toBeGreaterThan(64 * 1024)
      const installs: string[][] = []
      const code = await runSetupCommand(['--yes', '--no-claustrum'], {
        ...detectionIO(fixture.env, {
          opencode: false,
          pi: true,
          claustrum: false,
        }),
        fence: createTestFence(),
        terminal: { input: process.stdin, output: fixture.output },
        runner: createMockRunner({
          pi: (args) => {
            if (args.includes('--version'))
              return { exitCode: 0, stdout: '1.0.0', stderr: '' }
            installs.push(args)
            return { exitCode: 7, stdout: 'private install stdout', stderr }
          },
        }),
      })
      expect(code).toBe(1)
      expect(installs).toHaveLength(1)
      expect(installs[0]?.[0]).toBe('install')

      const screen = fixture.screen()
      expectNoSecretFragments(screen)
      expect(screen).not.toContain('npm error final line')
      expect(screen).not.toContain('trailing 85')
      expect(screen).not.toContain('private install stdout')
      const record = await screenDiagnostic(
        fixture,
        'Setup failed (cli-setup/unexpected-error).',
      )
      expectNoSecretFragments(record.text)
      expect(record.payload.code).toBe('cli-setup/unexpected-error')
      expect(record.detail).toContain('step: pi-install')
      expect(record.detail).toContain('exitCode: 7')
      expect(record.detail).toContain('signal: null')
      expect(record.text).toContain(
        'Pi install failed; run pi install after checking your npm connection.',
      )
      expect(record.text).toContain('stderrTail:\n')
      expect(record.text).toContain('npm error final line ✓')
      expect(record.text).toContain('trailing 85')
      expect(record.text).not.toContain('npm notice line 0')
      expect(record.text).not.toContain('private install stdout')
      const tail = record.text.split('stderrTail:\n')[1] ?? ''
      expect(new TextEncoder().encode(tail).length).toBeLessThanOrEqual(4097)
    },
  )

  lifetimes.test(
    'shared Pi installer command that never starts reports ENOENT without hanging',
    async () => {
      const fixture = await setupFailureFixture()
      const installs: string[][] = []
      const code = await runSetupCommand(['--yes', '--no-claustrum'], {
        ...detectionIO(fixture.env, {
          opencode: false,
          pi: true,
          claustrum: false,
        }),
        fence: createTestFence(),
        terminal: { input: process.stdin, output: fixture.output },
        runner: createMockRunner({
          pi: (args) => {
            if (args.includes('--version'))
              return { exitCode: 0, stdout: '1.0.0', stderr: '' }
            installs.push(args)
            return {
              exitCode: 1,
              spawnError: true,
              signal: null,
              stdout: '',
              stderr: 'spawn pi ENOENT',
            }
          },
        }),
      })
      expect(code).toBe(1)
      expect(installs).toHaveLength(1)
      expect(installs[0]?.[0]).toBe('install')
      const record = await screenDiagnostic(
        fixture,
        'Setup failed (cli-setup/unexpected-error).',
      )
      expect(record.detail).toContain('step: pi-install')
      expect(record.detail).toContain('exitCode: null')
      expect(record.detail).toContain('signal: null')
      expect(record.text).toContain('stderrTail:\nspawn pi ENOENT')
      expect(fixture.screen()).not.toContain('ENOENT')
      expect(fixture.screen()).not.toContain('spawn pi')
    },
  )

  for (const failure of [
    { name: 'termination', signal: 'SIGTERM', spawnError: false, exitCode: 1 },
    { name: 'spawn failure', signal: null, spawnError: true, exitCode: null },
  ] as const) {
    lifetimes.test(
      `shared Pi installer ${failure.name} records process metadata privately`,
      async () => {
        const fixture = await setupFailureFixture()
        const code = await runSetupCommand(['--yes', '--no-claustrum'], {
          ...detectionIO(fixture.env, {
            opencode: false,
            pi: true,
            claustrum: false,
          }),
          fence: createTestFence(),
          terminal: { input: process.stdin, output: fixture.output },
          runner: createMockRunner({
            pi: (args) =>
              args.includes('--version')
                ? { exitCode: 0, stdout: '1.0.0', stderr: '' }
                : {
                    exitCode: 1,
                    signal: failure.signal,
                    spawnError: failure.spawnError,
                    stdout: '',
                    stderr: 'npm install terminated',
                  },
          }),
        })
        expect(code).toBe(1)
        const record = await screenDiagnostic(
          fixture,
          'Setup failed (cli-setup/unexpected-error).',
        )
        expect(record.detail).toContain('step: pi-install')
        expect(record.detail).toContain(`exitCode: ${failure.exitCode}`)
        expect(record.detail).toContain(`signal: ${failure.signal}`)
        expect(record.text).toContain('stderrTail:\nnpm install terminated')
        expect(fixture.screen()).not.toContain('npm install terminated')
        expect(fixture.screen()).not.toContain('SIGTERM')
      },
    )
  }
})

const SETUP_UUID = '11111111-2222-4333-8444-555555555555' as ProviderAccountUuid
const SETUP_ACCESS = 'sk-ant-oat01-setup-fixture-native'
const SETUP_HOST_LOGIN = {
  type: 'oauth' as const,
  access: 'sk-ant-oat01-host-must-not-send',
  refresh: 'host-must-not-refresh',
  expires: 0,
}

async function callbackFixture(
  hosts = { opencode: true, pi: false, claustrum: false },
) {
  const f = await setupFailureFixture()
  f.env.OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE = join(
    f.env.HOME!,
    'enroll-opencode.json',
  )
  f.env.PI_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE = join(
    f.env.HOME!,
    'enroll-pi.json',
  )
  f.env.PI_ANTHROPIC_AUTH_CLAUSTRUM_CONNECTION_FILE =
    f.env.OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_CONNECTION_FILE
  const plan = await resolveNativeSetupPaths('opencode', f.env)
  const io = {
    ...detectionIO(f.env, hosts),
    runner: createMockRunner(),
    fence: createTestFence(),
    terminal: { input: process.stdin, output: f.output },
  }
  return { ...f, plan, io }
}

async function writeSetupJson(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await writeFile(path, JSON.stringify(value), { mode: 0o600 })
}

for (const host of ['opencode', 'pi'] as const) {
  lifetimes.test(
    `${host} failed activation names retained vault enrollment and both recovery steps`,
    async () => {
      const f = await callbackFixture({
        opencode: host === 'opencode',
        pi: host === 'pi',
        claustrum: true,
      })
      const label = host === 'opencode' ? 'OpenCode' : 'Pi'
      expect(
        await runSetupCommand(['--yes', '--claustrum', '--opencode=2'], {
          ...f.io,
          vaultActivate: async () => {
            throw new Error(ECHO_SK)
          },
        }),
      ).toBe(1)
      expect(f.screen()).toContain(
        `${label} stays connected to the vault. In ${label}, run /claude → Accounts → Disconnect from the vault to undo it. Or run setup again to finish connecting.`,
      )
      expect(f.screen()).not.toContain(ECHO_SK)
      expect(await readNativeEnrollmentMode(host, f.env)).toBe('claustrum')
    },
  )
}

const STAYS_CONNECTED =
  'OpenCode stays connected to the vault. In OpenCode, run /claude → Accounts → Disconnect from the vault to undo it. Or run setup again to finish connecting.'
// The status lines runSetup itself prints, once per host, when it fails after
// vault enrollment began.
const OPENCODE_CONNECTED = 'OpenCode: connected to the vault'
const OPENCODE_UNKNOWN = 'OpenCode: unknown, check with ck auth status'

function occurrences(screen: string, text: string) {
  return screen.split(text).length - 1
}

lifetimes.test(
  'a failed vault setup trusts its own enrollment record over the files left on disk',
  async () => {
    const f = await callbackFixture({
      opencode: true,
      pi: false,
      claustrum: true,
    })
    const enrollment = getHostClaustrumEnrollmentPaths('opencode', f.env)
    expect(
      await runSetupCommand(['--yes', '--claustrum', '--opencode=2'], {
        ...f.io,
        vaultActivate: async () => {
          // Approval landed, so the host is enrolled with the vault even
          // though its local enrollment files are gone by the time setup fails.
          await rm(enrollment.tokenPath, { force: true })
          await rm(enrollment.statePath, { force: true })
          throw new NativeVaultActivationError('primary-unverified')
        },
      }),
    ).toBe(1)
    const screen = f.screen()
    expect(screen).toContain(
      'The vault has no verified default Claude account. Sign in through the vault and rerun setup.',
    )
    expect(occurrences(screen, STAYS_CONNECTED)).toBe(1)
    // runSetup prints the status line; the command does not repeat it.
    expect(occurrences(screen, OPENCODE_CONNECTED)).toBe(1)
    expect(screen).not.toContain(OPENCODE_UNKNOWN)
    expect(screen).not.toContain('unexpected-error')
    await expectNoDiagnostics(f)
  },
)

lifetimes.test(
  'a vault setup that fails mid-enrollment says the connection is unknown instead of claiming either way',
  async () => {
    const f = await callbackFixture({
      opencode: true,
      pi: false,
      claustrum: true,
    })
    const enrollment = getHostClaustrumEnrollmentPaths('opencode', f.env)
    expect(
      await runSetupCommand(['--yes', '--claustrum', '--opencode=2'], {
        ...f.io,
        connect: async () => ({
          close() {},
          enrollPropose: async () => ({ requestId: 'fixture-request' }),
          enrollPoll: async () => {
            // The vault call fails after the request was recorded, and the
            // recorded state can no longer be read, so nothing settles it.
            await writeFile(enrollment.statePath, '{', { mode: 0o600 })
            throw new Error(ECHO_SK)
          },
        }),
      }),
    ).toBe(1)
    const screen = f.screen()
    if ('UNSUPPORTED_VAULT_MESSAGE' in commonAuthSetup) {
      expect(occurrences(screen, 'OpenCode: not connected')).toBe(1)
      expect(screen).toContain(
        'Claustrum enrollment did not complete. Inspect and approve with ck, then rerun setup.',
      )
      expect(screen).not.toContain(OPENCODE_UNKNOWN)
      await expectNoDiagnostics(f)
    } else {
      // Earlier common-auth releases cannot classify this catch-all failure.
      // They leave the host's outcome unknown because the state is unreadable.
      expect(occurrences(screen, OPENCODE_UNKNOWN)).toBe(1)
    }
    expect(screen).not.toContain('may be connected to the vault')
    expect(screen).not.toContain(OPENCODE_CONNECTED)
    expect(screen).not.toContain(STAYS_CONNECTED)
    expect(screen).not.toContain(ECHO_SK)
  },
)

// common-auth 0.24.0 and later throw a specific HostNotEnrolledError for each
// way enrollment can end without a token, where earlier releases threw one
// generic message. These cases drive the real shared runner, so they run only
// when the installed common-auth (the copy Core bundles) has that behavior.
if ('UNSUPPORTED_VAULT_MESSAGE' in commonAuthSetup) {
  const enrollmentEndings: Array<{
    name: string
    client: () => {
      close(): void
      enrollPropose(input: { name: string }): Promise<{ requestId: string }>
      enrollPoll(): Promise<{ status: 'pending' }>
    }
    screen: string
    progress?: string
  }> = [
    {
      name: 'a vault without the enrollment ceremony',
      client: () => ({
        close() {},
        // How claustrum-client before 0.13.0 reports the daemon's answer to
        // an operation it does not implement.
        enrollPropose: async () => {
          throw new ClaustrumCredentialError(
            'unknown_method',
            'transient',
            'retry',
          )
        },
        enrollPoll: async () => ({ status: 'pending' }),
      }),
      screen: commonAuthSetup.UNSUPPORTED_VAULT_MESSAGE,
    },
    {
      name: 'a vault that never creates the request',
      client: () => ({
        close() {},
        enrollPropose: async () => {
          throw new ClaustrumCredentialError(
            'pending_queue_full',
            'transient',
            'retry',
          )
        },
        enrollPoll: async () => ({ status: 'pending' }),
      }),
      screen:
        'The vault never created the enrollment request (last error: pending_queue_full). Check that ck is running, then rerun setup.',
      progress:
        'The vault has not created the request yet (pending_queue_full); retrying.',
    },
    {
      name: 'an enrollment failure after a vetted transport error',
      client: () => ({
        close() {},
        enrollPropose: async () => {
          throw Object.assign(new Error(ECHO_SK), {
            code: 'transport_error',
          })
        },
        enrollPoll: async () => ({ status: 'pending' }),
      }),
      screen:
        'Claustrum enrollment did not complete. Inspect and approve with ck, then rerun setup.',
    },
    {
      name: 'a request nobody approves',
      client: () => ({
        close() {},
        enrollPropose: async () => ({ requestId: 'fixture-request' }),
        enrollPoll: async () => ({ status: 'pending' }),
      }),
      screen:
        'Claustrum approval is still pending. In another terminal, run: ck auth enroll approve --request-id fixture-request --name anthropic-auth-opencode and then rerun setup.',
    },
  ]
  for (const ending of enrollmentEndings)
    lifetimes.test(
      `vault setup against ${ending.name} shows the shared refusal word for word`,
      async () => {
        const f = await callbackFixture({
          opencode: true,
          pi: false,
          claustrum: true,
        })
        // A fake clock: each wait moves it forward, so the enrollment wait
        // runs out without real time passing.
        let clock = 0
        const clockIO = {
          now: () => clock,
          wait: async (ms: number) => {
            clock += ms
          },
        }
        expect(
          await runSetupCommand(['--yes', '--claustrum', '--opencode=2'], {
            ...f.io,
            ...clockIO,
            connect: async () => ending.client(),
          }),
        ).toBe(1)
        const screen = f.screen()
        expect(occurrences(screen, ending.screen)).toBe(1)
        if (ending.progress)
          expect(occurrences(screen, ending.progress)).toBe(1)
        expect(occurrences(screen, 'OpenCode: not connected')).toBe(1)
        expect(screen).not.toContain('unexpected-error')
        expect(screen).not.toContain(STAYS_CONNECTED)
        if (
          ending.name === 'an enrollment failure after a vetted transport error'
        )
          expect(screen).not.toContain('transport_error')
        // A known refusal is shown, not recorded.
        await expectNoDiagnostics(f)
        expect(await readNativeEnrollmentMode('opencode', f.env)).toBe('local')
      },
    )
}

lifetimes.test(
  'a failed two-host vault setup prints each host status once, then the undo steps for the connected host',
  async () => {
    const f = await callbackFixture({
      opencode: true,
      pi: true,
      claustrum: true,
    })
    expect(
      await runSetupCommand(['--yes', '--claustrum', '--opencode=2'], {
        ...f.io,
        // OpenCode enrolls, then its activation fails, so Pi is never reached.
        vaultActivate: async () => {
          throw new NativeVaultActivationError('primary-unverified')
        },
      }),
    ).toBe(1)
    const lines = f.screen().trimEnd().split('\n')
    const connected = `${OPENCODE_CONNECTED} — Approved, but access could not be confirmed; check ck auth status or run:`
    expect(lines.slice(lines.indexOf(connected))).toEqual([
      connected,
      '  ck auth grant --principal enrolled:anthropic-auth-opencode --selector-kind category --selector anthropic-native --operation read',
      'Pi: not connected',
      'The vault has no verified default Claude account. Sign in through the vault and rerun setup.',
      STAYS_CONNECTED,
    ])
    expect(occurrences(f.screen(), OPENCODE_CONNECTED)).toBe(1)
    expect(f.screen()).not.toContain('Pi stays connected')
    await expectNoDiagnostics(f)
  },
)

lifetimes.test(
  'all-host local setup names both enrollments despite legacy local settings and preserves every file',
  async () => {
    const f = await callbackFixture({
      opencode: true,
      pi: true,
      claustrum: false,
    })
    const files: string[] = []
    for (const host of ['opencode', 'pi'] as const) {
      const plan = await resolveNativeSetupPaths(host, f.env)
      const enrollment = getHostClaustrumEnrollmentPaths(host, f.env)
      await writeSetupJson(enrollment.tokenPath, {
        token: 'c'.repeat(64),
        token_generation: 1,
      })
      await writeSetupJson(plan.paths.legacyConfig, {
        claustrum: { mode: 'local' },
      })
      files.push(enrollment.tokenPath, plan.paths.legacyConfig)
    }
    const before = await Promise.all(files.map((path) => readFile(path)))
    let migrations = 0
    expect(
      await runSetupCommand(['--yes', '--no-claustrum', '--opencode=2'], {
        ...f.io,
        migrateLocal: async () => {
          migrations++
        },
      }),
    ).toBe(1)
    for (const label of ['OpenCode', 'Pi']) {
      expect(f.screen()).toContain(
        `${label} is still connected to the vault. Old local settings do not disconnect it. In ${label}, run /claude → Accounts → Disconnect from the vault. Then run local setup again.`,
      )
    }
    expect(migrations).toBe(0)
    expect(await Promise.all(files.map((path) => readFile(path)))).toEqual(
      before,
    )
    for (const host of ['opencode', 'pi'] as const)
      expect(await readNativeEnrollmentMode(host, f.env)).toBe('claustrum')
  },
)

async function settleSetupSiblings<Value>(
  work: Promise<Value>[],
): Promise<Value[]> {
  const results = await Promise.allSettled(work)
  return results.map((result) => {
    if (result.status === 'rejected') throw result.reason
    return result.value
  })
}

async function setupBytes(
  plan: Awaited<ReturnType<typeof resolveNativeSetupPaths>>,
) {
  const names = [
    ...new Set([
      ...Object.values(plan.paths).filter(
        (path) => path !== plan.paths.storageId,
      ),
      plan.hostAuthPath,
      plan.routingSourcePath,
      plan.routingDestinationPath,
    ]),
  ]
  return settleSetupSiblings(
    names.map(async (path) => {
      try {
        return [path, await readFile(path, 'utf8')]
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT')
          return [path, null]
        throw error
      }
    }),
  )
}

function setupRuntime(f: Awaited<ReturnType<typeof callbackFixture>>) {
  return createNativeAccountRuntime({
    paths: f.plan.paths,
    host: 'opencode',
    vault: { env: f.env },
    local: {
      resolveIdentity: async () => ({
        accountUuid: SETUP_UUID,
        deviceId: 'fixture-device',
        sessionId: 'fixture-session',
      }),
    },
  })
}

async function poolMethodLogin(runtime: ReturnType<typeof setupRuntime>) {
  let registration: IntegrationOAuthMethodRegistration | undefined
  let exchanges = 0
  const methods = claudeLoginMethods({
    isActive: () => true,
    readMode: async () => 'local',
    runtime,
    authorize: async () => ({
      url: 'https://fixture.invalid/oauth',
      verifier: 'fixture-verifier',
      redirectUri: 'https://fixture.invalid/callback',
      state: 'fixture-state',
    }),
    exchange: async () => {
      exchanges++
      return {
        type: 'success',
        access: SETUP_ACCESS,
        refresh: 'native-fixture-refresh',
        expires: Date.now() + 28_800_000,
      }
    },
  })
  const installed = await registerOpenCode2AuthMethods(
    {
      integration: {
        transform: async (callback) => {
          callback({
            list: () => [],
            get: () => undefined,
            update() {},
            remove() {},
            method: {
              list: () => [],
              remove() {},
              update(method) {
                if (
                  'authorize' in method &&
                  method.method.id === methods.methods[0]!.method.id
                )
                  registration = method
              },
            },
          })
          return { dispose: async () => {} }
        },
      },
    },
    methods,
  )
  try {
    if (!registration)
      throw new Error('Fixture login method was not registered')
    const flow = await registration.authorize({})
    if (flow.mode !== 'code') throw new Error('Expected code flow')
    await flow.callback('fixture-code')
    expect(exchanges).toBe(1)
  } finally {
    await installed.dispose()
  }
}

const setupScope: RequestScope = {
  sessionID: 'fixture-setup-session',
  providerID: 'anthropic',
  modelID: 'claude-sonnet-4-6',
  agent: 'build',
  kind: 'primary',
}

async function sendSetupOc2(
  f: Awaited<ReturnType<typeof callbackFixture>>,
  runtime: ReturnType<typeof setupRuntime>,
  sent: Request[],
) {
  const source = createNativeAnthropicSource({
    runtime,
    paths: f.plan.paths,
    requestOptions: () => ({}),
  })
  const adapter = createNativeAnthropicAdapter({ source })
  try {
    const input = { ...setupScope, phase: 'request' as const }
    const accountId = await adapter.adapter.chooseAccount(input)
    if (typeof accountId !== 'string') throw new Error('fixture: no account')
    const headers = await adapter.adapter.accountHeaders({
      ...setupScope,
      accountId,
    })
    const result = headers as AccountHeadersResult<
      NativeAnthropicAttemptData<NativeSourceProvenance>
    >
    const attempt = {
      ...setupScope,
      accountId,
      attemptId: 'fixture-attempt',
      transport: 'http' as const,
      data: result.attempt,
    }
    const request = new Request('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: setupScope.modelID,
        max_tokens: 8,
        messages: [{ role: 'user', content: 'fixture' }],
      }),
    })
    const rewritten =
      (await adapter.adapter.rewriteRequest?.({
        ...attempt,
        request,
        attempt,
      })) ?? request
    const outgoing = new Headers(rewritten.headers)
    for (const [name, value] of Object.entries(result.headers)) {
      if (value === null) outgoing.delete(name)
      else outgoing.set(name, value)
    }
    const upstream = async (request: Request) => {
      sent.push(request)
      return Response.json({ id: 'fixture-response' })
    }
    return upstream(new Request(rewritten, { headers: outgoing }))
  } finally {
    adapter.dispose()
    await source.close()
  }
}

function watchDataDirectory(directory: string, allowedPaths: string[] = []) {
  const hits: string[] = []
  const accesses: string[] = []
  const restores: Array<() => void> = []
  for (const [module, names] of [
    [
      fsPromises,
      [
        'open',
        'readFile',
        'writeFile',
        'appendFile',
        'mkdir',
        'rename',
        'unlink',
        'rm',
        'copyFile',
      ],
    ],
    [
      fsSync,
      [
        'openSync',
        'readFileSync',
        'writeFileSync',
        'appendFileSync',
        'mkdirSync',
        'renameSync',
        'unlinkSync',
        'rmSync',
        'copyFileSync',
        'createReadStream',
        'createWriteStream',
      ],
    ],
  ] as const) {
    const target = module as unknown as Record<
      string,
      (...args: unknown[]) => unknown
    >
    for (const name of names) {
      const original = target[name]!
      const spy = spyOn(target, name).mockImplementation(
        (...args: unknown[]) => {
          const accessed = args
            .slice(
              0,
              name.includes('rename') || name.includes('copyFile') ? 2 : 1,
            )
            .filter(
              (arg) =>
                typeof arg === 'string' &&
                (arg === directory || arg.startsWith(`${directory}/`)),
            ) as string[]
          // Migration from OpenCode 1 ensures the auth directory exists even when its API-key slot is unchanged.
          const authDirectory =
            name === 'mkdir' &&
            args[0] === directory &&
            allowedPaths.includes(join(directory, 'auth.json')) &&
            (args[1] as { recursive?: boolean; mode?: number } | undefined)
              ?.recursive === true &&
            (args[1] as { mode?: number } | undefined)?.mode === 0o700
          if (!authDirectory) accesses.push(...accessed)
          if (
            !authDirectory &&
            accessed.some((path) => !allowedPaths.includes(path))
          ) {
            hits.push(`${name}:${String(args[0])}`)
            throw new Error(
              'Data-directory I/O is forbidden in generation-2 setup',
            )
          }
          return original(...args)
        },
      )
      restores.push(() => spy.mockRestore())
    }
  }
  const databases = sqlite as unknown as Record<
    string,
    (...args: unknown[]) => unknown
  >
  const Database = sqlite.Database
  const checkDatabase = (path: unknown) => {
    const filename = String(path)
    if (filename === directory || filename.startsWith(`${directory}/`)) {
      hits.push(`Database:${filename}`)
      throw new Error('Setup must not open an OpenCode database')
    }
  }
  const open = Database.open
  const openSpy = spyOn(Database, 'open').mockImplementation((...args) => {
    checkDatabase(args[0])
    return Reflect.apply(open, Database, args)
  })
  const databaseSpy = spyOn(databases, 'Database').mockImplementation(
    (...args: unknown[]) => {
      checkDatabase(args[0])
      return Reflect.construct(Database, args)
    },
  )
  Object.assign(databaseSpy, { open: openSpy })
  restores.push(() => openSpy.mockRestore())
  restores.push(() => databaseSpy.mockRestore())
  return {
    hits,
    accesses,
    restore: () => {
      for (const restore of restores.splice(0)) restore()
    },
  }
}

function forbidSetupReads(paths: string[]) {
  const hits: string[] = []
  const restores: Array<() => void> = []
  for (const [module, name] of [
    [fsPromises, 'readFile'],
    [fsSync, 'readFileSync'],
  ] as const) {
    const target = module as unknown as Record<
      string,
      (...args: unknown[]) => unknown
    >
    const original = target[name]!
    const spy = spyOn(target, name).mockImplementation((...args: unknown[]) => {
      if (paths.includes(String(args[0]))) {
        hits.push(String(args[0]))
        throw new Error('Local authority must not be read during vault setup')
      }
      return original(...args)
    })
    restores.push(() => spy.mockRestore())
  }
  return {
    hits,
    restore: () => {
      for (const restore of restores.splice(0)) restore()
    },
  }
}

function verifiedSetupInventory() {
  return {
    view: 'fixture',
    skipped: [],
    credentials: [
      {
        credentialId: 'oauth:anthropic',
        credentialType: 'oauth' as const,
        accountIdentity: SETUP_UUID,
        state: 'active' as const,
      },
    ],
  }
}

function fenceCompletedSetupWrites() {
  const protectedPaths = new Set<string>()
  const hits: string[] = []
  const restores: Array<() => void> = []
  const target = fsPromises as unknown as Record<
    string,
    (...args: unknown[]) => unknown
  >
  for (const name of [
    'writeFile',
    'appendFile',
    'rename',
    'unlink',
    'rm',
    'copyFile',
  ]) {
    const original = target[name]!
    const spy = spyOn(target, name).mockImplementation((...args: unknown[]) => {
      const paths = args.slice(
        0,
        name === 'rename' || name === 'copyFile' ? 2 : 1,
      )
      if (paths.some((path) => protectedPaths.has(String(path)))) {
        hits.push(`${name}:${paths.map(String).join(' -> ')}`)
        throw new Error(
          'Completed setup provider files must not be written again',
        )
      }
      return original(...args)
    })
    restores.push(() => spy.mockRestore())
  }
  return {
    hits,
    protect: (paths: string[]) => {
      for (const path of paths) protectedPaths.add(path)
    },
    restore: () => {
      for (const restore of restores.splice(0)) restore()
    },
  }
}

lifetimes.test(
  'the data-directory spy records caught SQLite constructor and static opens',
  async () => {
    const f = await callbackFixture()
    const path = join(dirname(f.plan.hostAuthPath), 'unexpected.sqlite')
    const data = watchDataDirectory(dirname(f.plan.hostAuthPath))
    try {
      for (const open of [
        () => new sqlite.Database(path),
        () => sqlite.Database.open(path),
      ]) {
        try {
          open().close()
        } catch {}
      }
      expect(data.hits).toEqual([`Database:${path}`, `Database:${path}`])
    } finally {
      data.restore()
    }
    expect(existsSync(path)).toBe(false)
  },
)

lifetimes.test(
  'acceptance 1: offline OC2 setup, registered fixture login and first native Bearer request',
  async () => {
    const f = await callbackFixture()
    await writeSetupJson(f.plan.hostAuthPath, { anthropic: SETUP_HOST_LOGIN })
    await fsPromises.chmod(f.plan.hostAuthPath, 0)
    const before = await stat(f.plan.hostAuthPath)
    const originalFetch = globalThis.fetch
    let outbound = 0
    globalThis.fetch = Object.assign(
      async () => {
        outbound++
        throw new Error('No outbound fetch is allowed during fixture login')
      },
      { preconnect: originalFetch.preconnect },
    )
    const data = watchDataDirectory(dirname(f.plan.hostAuthPath))
    try {
      expect(await runSetupCommand(['--yes', '--opencode=2'], f.io)).toBe(0)
      expect(data.hits).toEqual([])
      expect(f.screen().split(CLAUDE_POOL_LOGIN_STEP).length - 1).toBe(1)
      const runtime = setupRuntime(f)
      try {
        await expect(poolMethodLogin(runtime)).resolves.toBeUndefined()
        expect(outbound).toBe(0)
        await runtime.updateSettings((settings) => ({
          ...settings,
          quota: { enabled: false },
          refresh: { enabled: false },
        }))
        const sent: Request[] = []
        expect((await sendSetupOc2(f, runtime, sent)).status).toBe(200)
        expect(sent).toHaveLength(1)
        expect(sent[0]!.headers.get('authorization')).toBe(
          `Bearer ${SETUP_ACCESS}`,
        )
        expect(sent[0]!.headers.has('x-api-key')).toBe(false)
        expect(f.plan.routingDestinationPath).toBe(
          resolveLocalRoutingDestination('opencode', f.plan.paths, f.env),
        )
        expect((await runtime.read()).routingPath).toBe(
          f.plan.routingDestinationPath,
        )
        await runtime.remove('main')
        await expect(sendSetupOc2(f, runtime, sent)).rejects.toThrow()
        expect(sent).toHaveLength(1)
        expect(data.hits).toEqual([])
      } finally {
        runtime.close()
      }
    } finally {
      data.restore()
      globalThis.fetch = originalFetch
      await fsPromises.chmod(f.plan.hostAuthPath, 0o600)
    }
    expect((await stat(f.plan.hostAuthPath)).mtimeMs).toBe(before.mtimeMs)
    expect(await readFile(f.plan.hostAuthPath, 'utf8')).toBe(
      JSON.stringify({ anthropic: SETUP_HOST_LOGIN }),
    )
    expect((await readNativeMigrationJournal(f.plan.paths))?.kind).toBe(
      'empty-init',
    )
  },
)

async function populateSetupPool(
  f: Awaited<ReturnType<typeof callbackFixture>>,
) {
  expect(await runSetupCommand(['--yes', '--opencode=2'], f.io)).toBe(0)
  const runtime = setupRuntime(f)
  try {
    await poolMethodLogin(runtime)
    await runtime.updateSettings((settings) => ({
      ...settings,
      quota: { enabled: false },
      refresh: { enabled: false },
    }))
  } finally {
    runtime.close()
  }
}

for (const slot of ['oauth', 'absent', 'api', 'placeholder'] as const) {
  lifetimes.test(
    `S1 populated pool preserves ${slot} slot and legacy bytes`,
    async () => {
      const f = await callbackFixture()
      await populateSetupPool(f)
      if (slot !== 'absent')
        await writeSetupJson(f.plan.hostAuthPath, {
          anthropic:
            slot === 'oauth'
              ? SETUP_HOST_LOGIN
              : slot === 'api'
                ? { type: 'api', key: 'host-api-key' }
                : custodyTombstoneOAuth('anthropic'),
        })
      for (const path of [
        f.plan.legacyConfigPath,
        f.plan.legacyStatePath,
        f.plan.routingSourcePath,
      ])
        await writeSetupJson(path, { legacy: 'must remain byte-identical' })
      const before = await setupBytes(f.plan)
      expect(await runSetupCommand(['--yes', '--opencode=1'], f.io)).toBe(0)
      const after = await setupBytes(f.plan)
      if (slot !== 'absent') expect(after).toEqual(before)
      else {
        expect(after.filter(([path]) => path !== f.plan.hostAuthPath)).toEqual(
          before.filter(([path]) => path !== f.plan.hostAuthPath),
        )
        expect(
          inspectNativeHostAuthEntry(
            'opencode',
            JSON.parse(await readFile(f.plan.hostAuthPath, 'utf8')),
          ).kind,
        ).toBe('activation')
      }
      expect(f.screen().split(SEPARATE_HOST_LOGIN_NOTICE).length - 1).toBe(
        slot === 'oauth' ? 1 : 0,
      )
      await expect(
        migrateNativeLocalForHost('opencode', {
          env: f.env,
          paths: f.plan,
          fence: createTestFence(),
          removePiAnthropicAuth: false,
        }),
      ).rejects.toMatchObject({ code: 'pool-populated' })
      expect(await setupBytes(f.plan)).toEqual(after)
    },
  )
}

lifetimes.test(
  'S2 populated rerun opens no OC1 file and reuses authority byte for byte',
  async () => {
    const f = await callbackFixture()
    await populateSetupPool(f)
    await writeSetupJson(f.plan.hostAuthPath, { anthropic: SETUP_HOST_LOGIN })
    const before = await setupBytes(f.plan)
    await fsPromises.chmod(f.plan.hostAuthPath, 0)
    const data = watchDataDirectory(dirname(f.plan.hostAuthPath))
    try {
      expect(await runSetupCommand(['--yes', '--opencode=2'], f.io)).toBe(0)
      expect(data.hits).toEqual([])
    } finally {
      data.restore()
      await fsPromises.chmod(f.plan.hostAuthPath, 0o600)
    }
    expect(await setupBytes(f.plan)).toEqual(before)
    expect(f.screen()).not.toContain(SEPARATE_HOST_LOGIN_NOTICE)
  },
)

async function sendSetupOc1(
  f: Awaited<ReturnType<typeof callbackFixture>>,
  sent: Request[],
) {
  const overrides: NodeJS.ProcessEnv = {
    ...f.env,
    OPENCODE_ANTHROPIC_AUTH_FILE: f.plan.legacyConfigPath,
    OPENCODE_ANTHROPIC_AUTH_STATE_FILE: f.plan.legacyStatePath,
    OPENCODE_ANTHROPIC_AUTH_ROUTING_STATE_FILE: undefined,
    OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION: '1',
    OPENCODE_ANTHROPIC_AUTH_RPC_DIR: join(f.env.HOME!, 'rpc'),
    OPENCODE_ANTHROPIC_AUTH_SIDEBAR_STATE_FILE: join(
      f.env.HOME!,
      'sidebar.json',
    ),
    OPENCODE_ANTHROPIC_AUTH_QUOTA_FEED_DIR: join(f.env.HOME!, 'quota-feed'),
    OPENCODE_ANTHROPIC_AUTH_CACHEKEEP_REGISTRY_DIR: join(
      f.env.HOME!,
      'cachekeep',
    ),
    OPENCODE_AUTH_CONTENT: undefined,
    CLAUDE_CONFIG_DIR: join(f.env.HOME!, 'claude'),
  }
  const savedEnv = new Map(
    Object.keys(overrides).map((key) => [key, process.env[key]]),
  )
  const savedFetch = globalThis.fetch
  let plugin: Awaited<ReturnType<typeof AnthropicAuthPlugin>> | undefined
  try {
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    const fetchFixture = Object.assign(
      async (
        input: Parameters<typeof fetch>[0],
        init?: Parameters<typeof fetch>[1],
      ) => {
        const request =
          input instanceof Request
            ? new Request(input, init)
            : new Request(String(input), init)
        if (new URL(request.url).pathname !== '/v1/messages')
          throw new Error('Unexpected provider fetch in setup fixture')
        sent.push(request)
        return Response.json({
          id: 'fixture',
          type: 'message',
          role: 'assistant',
          content: [],
          stop_reason: 'end_turn',
          usage: { input_tokens: 1, output_tokens: 1 },
        })
      },
      { preconnect: savedFetch.preconnect },
    )
    globalThis.fetch = fetchFixture
    plugin = await AnthropicAuthPlugin(
      {
        client: createOpencodeClient({
          baseUrl: 'http://127.0.0.1:9',
          fetch: async () => Response.json({}),
        }),
        project: {
          id: 'setup-fixture',
          worktree: f.env.HOME!,
          time: { created: 1 },
        },
        directory: f.env.HOME!,
        worktree: f.env.HOME!,
        serverUrl: new URL('http://127.0.0.1:9'),
        experimental_workspace: { register() {} },
        $,
      },
      {
        scopedRosterPollIntervalMs: 0,
        cacheKeepAggregateRefreshIntervalMs: 0,
        nativeLocal: {
          resolveIdentity: async () => ({
            accountUuid: SETUP_UUID,
            deviceId: 'fixture-device',
            sessionId: 'fixture-session',
          }),
          refreshToken: async () => {
            throw new Error('Host tokens must not reach a refresher')
          },
        },
      },
    )
    const loader = plugin.auth?.loader
    if (!loader) throw new Error('Missing OC1 auth loader')
    const auth = JSON.parse(
      await readFile(f.plan.hostAuthPath, 'utf8'),
    ).anthropic
    const options = await loader(async () => auth, {
      id: 'anthropic',
      name: 'Anthropic',
      source: 'custom',
      env: [],
      options: {},
      models: {},
    })
    if (typeof options.fetch !== 'function')
      throw new Error('Missing OC1 fetch')
    const response: unknown = await options.fetch(
      'https://api.anthropic.com/v1/messages',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 8,
          messages: [{ role: 'user', content: 'fixture request' }],
        }),
      },
    )
    if (!(response instanceof Response)) throw new Error('Missing OC1 response')
    await response.text()
    return response
  } finally {
    try {
      await plugin?.dispose?.()
    } finally {
      globalThis.fetch = savedFetch
      for (const [key, value] of savedEnv) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      resetClaudeCodeIdentityCachesForTest()
    }
  }
}

for (const accountIdentity of [
  SETUP_UUID,
  'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
]) {
  lifetimes.test(
    `S1 populated real-login request uses native pool (${accountIdentity === SETUP_UUID ? 'same UUID' : 'unrelated account'})`,
    async () => {
      const f = await callbackFixture()
      await populateSetupPool(f)
      await writeSetupJson(f.plan.hostAuthPath, { anthropic: SETUP_HOST_LOGIN })
      await writeSetupJson(f.plan.legacyConfigPath, {
        main: { profile: { accountUuid: accountIdentity } },
      })
      await writeSetupJson(f.plan.legacyStatePath, {
        access: 'different-lineage-access',
        refresh: 'different-lineage-refresh',
      })
      const before = await setupBytes(f.plan)
      expect(await runSetupCommand(['--yes', '--opencode=1'], f.io)).toBe(0)
      expect(await setupBytes(f.plan)).toEqual(before)
      expect(f.screen().split(SEPARATE_HOST_LOGIN_NOTICE).length - 1).toBe(1)
      const sent: Request[] = []
      await expect(sendSetupOc1(f, sent)).resolves.toMatchObject({
        status: 200,
      })
      expect(sent).toHaveLength(1)
      expect(sent[0]!.headers.get('authorization')).toBe(
        `Bearer ${SETUP_ACCESS}`,
      )
      expect(sent[0]!.headers.has('x-api-key')).toBe(false)
      expect(JSON.stringify([...sent[0]!.headers])).not.toContain(
        SETUP_HOST_LOGIN.access,
      )
      await expect(
        migrateNativeLocalForHost('opencode', {
          env: f.env,
          fence: createTestFence(),
          paths: f.plan,
          removePiAnthropicAuth: false,
        }),
      ).rejects.toMatchObject({ code: 'pool-populated' })
    },
  )
}

for (const kind of ['orphan', 'quota-only'] as const) {
  lifetimes.test(
    `S1 ${kind} skips but the OC1 request remains inert`,
    async () => {
      const f = await callbackFixture()
      expect(await runSetupCommand(['--yes', '--opencode=2'], f.io)).toBe(0)
      if (kind === 'orphan')
        await writeSetupJson(f.plan.paths.runtime, {
          version: 1,
          storageId: f.plan.paths.storageId,
          accounts: {
            orphan: {
              binding: {
                kind: 'local',
                storageId: f.plan.paths.storageId,
                rowId: 'orphan',
                credentialEpoch: 1,
              },
              lastUsed: 1,
            },
          },
        })
      else {
        const store = createNativePoolStore({
          paths: f.plan.paths,
          quota: nativeQuotaCodec,
        })
        await store.updateSettings(() => ({ quota: { enabled: false } }))
        const config = JSON.parse(await readFile(f.plan.paths.config, 'utf8'))
        config.commonAuthPool = {
          schemaVersion: 1,
          rows: {
            orphan: {
              quota: toNativeQuotaMap({
                checkedAt: 1,
                five_hour: {
                  usedPercent: 10,
                  remainingPercent: 90,
                  checkedAt: 1,
                },
              }),
            },
          },
        }
        await writeSetupJson(f.plan.paths.config, config)
      }
      await writeSetupJson(f.plan.hostAuthPath, { anthropic: SETUP_HOST_LOGIN })
      const before = await setupBytes(f.plan)
      expect(await runSetupCommand(['--yes', '--opencode=1'], f.io)).toBe(0)
      expect(await setupBytes(f.plan)).toEqual(before)
      const sent: Request[] = []
      await expect(sendSetupOc1(f, sent)).rejects.toThrow(
        'Native OAuth requires inert OpenCode activation; run offline setup',
      )
      expect(sent).toEqual([])
      await expect(
        migrateNativeLocalForHost('opencode', {
          env: f.env,
          fence: createTestFence(),
          paths: f.plan,
          removePiAnthropicAuth: false,
        }),
      ).rejects.toMatchObject({ code: 'pool-populated' })
    },
  )
}

for (const change of ['slot', 'pool', 'custody', 'enrollment'] as const) {
  lifetimes.test(
    `OAuth exchange rejects an external ${change} change without further provider writes`,
    async () => {
      const f = await callbackFixture()
      await populateSetupPool(f)
      await writeSetupJson(f.plan.hostAuthPath, { anthropic: SETUP_HOST_LOGIN })
      let changed: Awaited<ReturnType<typeof setupBytes>> | undefined
      let exchanges = 0
      expect(
        await runSetupCommand(['--yes', '--login', '--opencode=1'], {
          ...f.io,
          localLogin: async () => {
            exchanges++
            if (change === 'slot')
              await writeSetupJson(f.plan.hostAuthPath, {
                anthropic: {
                  ...SETUP_HOST_LOGIN,
                  access: 'external-same-kind-access',
                },
              })
            else if (change === 'enrollment')
              await writeSetupJson(
                getHostClaustrumEnrollmentPaths('opencode', f.env).tokenPath,
                { token: 'c'.repeat(64), token_generation: 1 },
              )
            else {
              const path =
                change === 'pool' ? f.plan.paths.state : f.plan.paths.config
              const value = JSON.parse(await readFile(path, 'utf8'))
              if (change === 'pool') value.externalSamePopulationEdit = true
              else value.claustrum = { mode: 'claustrum' }
              await writeSetupJson(path, value)
            }
            changed = await setupBytes(f.plan)
            return {
              accountIdentity: SETUP_UUID,
              credential: {
                type: 'oauth',
                access: 'must-not-commit',
                refresh: 'must-not-commit',
                expires: Date.now() + 28_800_000,
              },
            }
          },
        }),
      ).toBe(1)
      expect(exchanges).toBe(1)
      expect(changed).toBeDefined()
      expect(await setupBytes(f.plan)).toEqual(changed!)
      if (change === 'enrollment')
        expect(f.screen()).toContain(
          'OpenCode is still connected to the vault.',
        )
    },
  )
}

lifetimes.test(
  'first preflight refuses Pi consent before any OpenCode registration or authority write',
  async () => {
    const f = await callbackFixture({
      opencode: true,
      pi: true,
      claustrum: false,
    })
    const pi = await resolveNativeSetupPaths('pi', f.env)
    await writeSetupJson(pi.hostAuthPath, { anthropic: SETUP_HOST_LOGIN })
    const before = await setupBytes(pi)
    let exchanges = 0
    expect(
      await runSetupCommand(['--yes', '--login'], {
        ...f.io,
        localLogin: async () => {
          exchanges++
          throw new Error('Must not exchange')
        },
      }),
    ).toBe(1)
    expect(exchanges).toBe(0)
    expect(await setupBytes(pi)).toEqual(before)
    expect(await readNativeMigrationJournal(f.plan.paths)).toBeUndefined()
    await expect(
      stat(join(dirname(f.plan.legacyConfigPath), 'opencode.jsonc')),
    ).rejects.toThrow()
    expect(f.screen()).toContain(
      'Pi has a stored Anthropic login. Rerun with --remove-pi-auth to move it into the native account pool.',
    )
  },
)

lifetimes.test(
  'generation 2 plus Pi initializes only OpenCode and migrates Pi normally',
  async () => {
    const f = await callbackFixture({
      opencode: true,
      pi: true,
      claustrum: false,
    })
    const pi = await resolveNativeSetupPaths('pi', f.env)
    const calls: string[] = []
    expect(
      await runSetupCommand(['--yes', '--opencode=2'], {
        ...f.io,
        migrateLocal: async (host, options) => {
          calls.push(host)
          await migrateNativeLocalForHost(host, options)
        },
      }),
    ).toBe(0)
    expect(calls).toEqual(['pi'])
    expect((await readNativeMigrationJournal(f.plan.paths))?.kind).toBe(
      'empty-init',
    )
    expect((await readNativeMigrationJournal(pi.paths))?.phase).toBe('retired')
    expect((await readNativeMigrationJournal(pi.paths))?.kind).not.toBe(
      'empty-init',
    )
    expect(f.screen().split(CLAUDE_POOL_LOGIN_STEP).length - 1).toBe(1)
    await expect(stat(f.plan.hostAuthPath)).rejects.toThrow()
  },
)

for (const refusal of [
  'destination',
  'cross-host-alias',
  'generation-2-login',
  'pre-commit',
] as const) {
  lifetimes.test(
    `first preflight ${refusal} leaves every host unchanged`,
    async () => {
      const f = await callbackFixture({
        opencode: true,
        pi: true,
        claustrum: false,
      })
      if (refusal === 'destination')
        await writeSetupJson(f.plan.paths.state, { occupied: true })
      if (refusal === 'cross-host-alias') {
        f.env.PI_ANTHROPIC_AUTH_FILE = f.plan.legacyConfigPath
        f.io.env = {
          ...f.io.env,
          PI_ANTHROPIC_AUTH_FILE: f.plan.legacyConfigPath,
        }
      }
      if (refusal === 'pre-commit') {
        expect(await runSetupCommand(['--yes', '--opencode=1'], f.io)).toBe(0)
        const journal = JSON.parse(await readFile(f.plan.paths.journal, 'utf8'))
        await writeSetupJson(f.plan.paths.journal, {
          ...journal,
          phase: 'building',
          expectedHostAuth: 'unprepared',
          expectedRouting: 'unprepared',
          preparedProof: null,
        })
      }
      const pi = await resolveNativeSetupPaths('pi', f.env)
      const before = await settleSetupSiblings([
        setupBytes(f.plan),
        setupBytes(pi),
      ])
      let exchanges = 0
      const args = [
        '--yes',
        '--opencode=2',
        ...(refusal === 'generation-2-login' ? ['--login'] : []),
      ]
      expect(
        await runSetupCommand(args, {
          ...f.io,
          localLogin: async () => {
            exchanges++
            throw new Error('Must not exchange')
          },
        }),
      ).toBe(1)
      expect(exchanges).toBe(0)
      expect(
        await settleSetupSiblings([setupBytes(f.plan), setupBytes(pi)]),
      ).toEqual(before)
      if (refusal !== 'pre-commit')
        await expect(
          stat(join(dirname(f.plan.legacyConfigPath), 'opencode.jsonc')),
        ).rejects.toThrow()
    },
  )
}

lifetimes.test(
  'a failed exchange on a completed pool leaves an absent host slot absent',
  async () => {
    const f = await callbackFixture()
    await populateSetupPool(f)
    const before = await setupBytes(f.plan)
    expect(
      await runSetupCommand(['--yes', '--login', '--opencode=1'], {
        ...f.io,
        localLogin: async () => {
          throw new Error('Fixture exchange refused')
        },
      }),
    ).toBe(1)
    expect(await setupBytes(f.plan)).toEqual(before)
    await expect(stat(f.plan.hostAuthPath)).rejects.toThrow()
  },
)

lifetimes.test(
  'dry setup with overlapping storage and running hosts remains a write-free preview',
  async () => {
    const f = await callbackFixture({
      opencode: true,
      pi: true,
      claustrum: false,
    })
    const pi = await resolveNativeSetupPaths('pi', f.env)
    const before = await settleSetupSiblings([
      setupBytes(f.plan),
      setupBytes(pi),
    ])
    expect(
      await runSetupCommand(['--yes', '--dry-run', '--opencode=2'], {
        ...f.io,
        env: { ...f.io.env, PI_ANTHROPIC_AUTH_FILE: f.plan.legacyConfigPath },
        fence: createTestFence([{ pid: 9, command: 'opencode' }]),
        migrateLocal: async () => {
          throw new Error('No callbacks in dry runs')
        },
      }),
    ).toBe(0)
    expect(f.screen()).toContain(
      'Dry run: no registrations, enrollment, sign-in or migration will be performed.',
    )
    expect(f.screen()).toContain(
      'OpenCode is running; setup will ask you to quit it.',
    )
    expect(f.screen()).toContain(
      'Would migrate opencode using the plugin callback (provider-specific writes).',
    )
    expect(f.screen()).toContain(
      'Would migrate pi using the plugin callback (provider-specific writes).',
    )
    expect(f.screen()).not.toContain(CLAUDE_POOL_LOGIN_STEP)
    expect(
      await settleSetupSiblings([setupBytes(f.plan), setupBytes(pi)]),
    ).toEqual(before)
    expect(await readNativeMigrationJournal(f.plan.paths)).toBeUndefined()
    await expect(
      stat(join(dirname(f.plan.legacyConfigPath), 'opencode.jsonc')),
    ).rejects.toThrow()
  },
)

async function withSetupBootstrap<T>(
  body: (lookups: string[]) => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch
  const lookups: string[] = []
  resetClaudeCodeIdentityCachesForTest()
  globalThis.fetch = Object.assign(
    async (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const url = new URL(extractUrl(input))
      if (
        url.origin !== 'https://api.anthropic.com' ||
        url.pathname !== '/api/claude_cli/bootstrap'
      )
        throw new Error('Unexpected fetch during setup login')
      const auth =
        new Headers(
          init?.headers ??
            (input instanceof Request ? input.headers : undefined),
        ).get('authorization') ?? ''
      lookups.push(auth)
      return Response.json({ oauth_account: { account_uuid: SETUP_UUID } })
    },
    { preconnect: original.preconnect },
  )
  try {
    return await body(lookups)
  } finally {
    globalThis.fetch = original
    resetClaudeCodeIdentityCachesForTest()
  }
}

for (const generation of ['1', 'both'] as const) {
  lifetimes.test(
    `--login ${generation} commits once then migrate is write-free, with an absent-slot placeholder`,
    async () => {
      const f = await callbackFixture()
      await populateSetupPool(f)
      const calls: string[] = []
      await withSetupBootstrap(async (lookups) => {
        expect(
          await runSetupCommand(
            ['--yes', '--login', `--opencode=${generation}`],
            {
              ...f.io,
              localLogin: async (host) => {
                calls.push(`exchange:${host}`)
                return {
                  accountIdentity: SETUP_UUID,
                  credential: {
                    type: 'oauth',
                    access: 'sk-ant-oat01-fresh-setup',
                    refresh: 'fresh-refresh',
                    expires: Date.now() + 28_800_000,
                  },
                }
              },
              migrateLocal: async (host, options) => {
                calls.push(`local:${host}`)
                expect(options.skipMigration).toBe(true)
                await migrateNativeLocalForHost(host, options)
              },
            },
          ),
        ).toBe(0)
        expect(lookups).toEqual(['Bearer sk-ant-oat01-fresh-setup'])
      })
      expect(calls).toEqual(['local:opencode', 'exchange:opencode'])
      expect(
        inspectNativeHostAuthEntry(
          'opencode',
          JSON.parse(await readFile(f.plan.hostAuthPath, 'utf8')),
        ).kind,
      ).toBe('activation')
      expect((await readNativeMigrationJournal(f.plan.paths))?.kind).toBe(
        'empty-init',
      )
      expect(f.screen().split(CLAUDE_POOL_LOGIN_STEP).length - 1).toBe(1)
      const runtime = setupRuntime(f)
      try {
        const credential = await runtime.authorizeLocal('main')
        expect(credential.status).toBe('usable')
        if (credential.status === 'usable')
          expect(credential.access).toBe('sk-ant-oat01-fresh-setup')
      } finally {
        runtime.close()
      }
    },
  )
}

for (const authority of [
  'empty-init-with-legacy',
  'completed-absent-slot',
] as const) {
  for (const exchange of ['success', 'failure'] as const) {
    lifetimes.test(
      `--login ${authority} ${exchange} preserves callback ownership and absent-slot safety`,
      async () => {
        const f = await callbackFixture()
        if (authority === 'empty-init-with-legacy') {
          expect(await runSetupCommand(['--yes', '--opencode=2'], f.io)).toBe(0)
          await writeSetupJson(f.plan.legacyConfigPath, {
            version: 1,
            refresh: { enabled: false },
          })
          await writeSetupJson(f.plan.legacyStatePath, {})
        } else {
          await migrateNativeLocalForHost('opencode', {
            env: f.env,
            fence: f.io.fence,
            paths: f.plan,
            removePiAnthropicAuth: false,
          })
          const journal = await readNativeMigrationJournal(f.plan.paths)
          await writeSetupJson(f.plan.paths.journal, {
            ...journal,
            phase: 'committed',
          })
          await rm(f.plan.hostAuthPath)
        }
        const before = await setupBytes(f.plan)
        let committed: typeof before | undefined
        const writes = fenceCompletedSetupWrites()
        lifetimes.deferCleanup(writes.restore)
        let exchanges = 0
        let migrations = 0
        await withSetupBootstrap(async (lookups) => {
          expect(
            await runSetupCommand(['--yes', '--login', '--opencode=1'], {
              ...f.io,
              localLogin: async () => {
                exchanges++
                if (exchange === 'failure')
                  throw new Error('Fixture exchange refused')
                return {
                  accountIdentity: SETUP_UUID,
                  credential: {
                    type: 'oauth',
                    access: SETUP_ACCESS,
                    refresh: 'fixture-refresh',
                    expires: Date.now() + 28_800_000,
                  },
                }
              },
              migrateLocal: async (host, options) => {
                migrations++
                expect(options.login).toBeDefined()
                await migrateNativeLocalForHost(host, options)
                committed = await setupBytes(f.plan)
                writes.protect(committed.map(([path]) => String(path)))
              },
            }),
          ).toBe(exchange === 'success' ? 0 : 1)
          expect(lookups).toEqual(
            exchange === 'success' ? [`Bearer ${SETUP_ACCESS}`] : [],
          )
        })
        expect(exchanges).toBe(1)
        expect(migrations).toBe(1)
        expect(writes.hits).toEqual([])
        if (exchange === 'failure') {
          expect(await setupBytes(f.plan)).toEqual(before)
          expect(existsSync(f.plan.hostAuthPath)).toBe(false)
          return
        }
        expect(committed).toBeDefined()
        expect(await setupBytes(f.plan)).toEqual(committed!)
        expect(await readNativeMigrationJournal(f.plan.paths)).toMatchObject({
          phase: 'retired',
          ...(authority === 'empty-init-with-legacy'
            ? { version: 5, kind: 'legacy-import' }
            : { version: 4 }),
        })
        expect(
          inspectNativeHostAuthEntry(
            'opencode',
            JSON.parse(await readFile(f.plan.hostAuthPath, 'utf8')),
          ).kind,
        ).toBe('activation')
        const pool = await createNativePoolStore({
          paths: f.plan.paths,
          quota: nativeQuotaCodec,
        }).read()
        expect(pool.status).toBe('ready')
        if (pool.status !== 'ready')
          throw new Error('Fixture login pool is not ready')
        expect(pool.rows).toHaveLength(1)
        expect(pool.rows[0]?.credentialEpoch).toBe(1)
      },
    )
  }
}

lifetimes.test(
  'OpenCode login stays committed when Pi exchange fails later in the shared run',
  async () => {
    const f = await callbackFixture({
      opencode: true,
      pi: true,
      claustrum: false,
    })
    const pi = await resolveNativeSetupPaths('pi', f.env)
    const beforePi = await setupBytes(pi)
    let committedOpenCode: Awaited<ReturnType<typeof setupBytes>> | undefined
    const calls: string[] = []
    await withSetupBootstrap(async (lookups) => {
      expect(
        await runSetupCommand(['--yes', '--login', '--opencode=both'], {
          ...f.io,
          localLogin: async (host) => {
            calls.push(host)
            if (host === 'pi') {
              committedOpenCode = await setupBytes(f.plan)
              throw new Error('Fixture Pi exchange failed')
            }
            return {
              accountIdentity: SETUP_UUID,
              credential: {
                type: 'oauth',
                access: SETUP_ACCESS,
                refresh: 'native-fixture-refresh',
                expires: Date.now() + 28_800_000,
              },
            }
          },
        }),
      ).toBe(1)
      expect(lookups).toEqual([`Bearer ${SETUP_ACCESS}`])
    })
    expect(calls).toEqual(['opencode', 'pi'])
    expect(committedOpenCode).toBeDefined()
    expect(await setupBytes(f.plan)).toEqual(committedOpenCode!)
    expect((await readNativeMigrationJournal(f.plan.paths))?.phase).toBe(
      'retired',
    )
    expect(await setupBytes(pi)).toEqual(beforePi)
  },
)

lifetimes.test(
  'shared setup passes host display names and delegates the legacy-vault retry to common-auth',
  async () => {
    const f = await callbackFixture({
      opencode: true,
      pi: true,
      claustrum: true,
    })
    const proposals: {
      name: string
      displayName?: string
      requestSecretHash: string
    }[] = []
    expect(
      await runSetupCommand(['--yes', '--enroll-only', '--opencode=2'], {
        ...f.io,
        connect: async () => {
          let name = ''
          return {
            close() {},
            enrollPropose: async (input) => {
              proposals.push(input)
              name = input.name
              if (input.displayName !== undefined)
                throw new ClaustrumCredentialError(
                  'invalid_params',
                  'permanent',
                  'gone',
                )
              return { requestId: name }
            },
            enrollPoll: async () => ({
              status: 'approved',
              name,
              token: 'c'.repeat(64),
              tokenGeneration: 1,
            }),
          }
        },
      }),
    ).toBe(0)
    expect(proposals).toHaveLength(4)
    for (const [index, host, displayName] of [
      [0, 'opencode', 'Claude sign-in for OpenCode'],
      [2, 'pi', 'Claude sign-in for Pi'],
    ] as const) {
      expect(proposals[index]).toMatchObject({
        name: `anthropic-auth-${host}`,
        displayName,
      })
      expect(proposals[index]!.requestSecretHash).toMatch(/^[0-9a-f]{64}$/)
      expect(proposals[index + 1]).toEqual({
        name: `anthropic-auth-${host}`,
        requestSecretHash: proposals[index]!.requestSecretHash,
      })
      expect(await readNativeEnrollmentMode(host, f.env)).toBe('claustrum')
    }
  },
)

lifetimes.test(
  'shared legacy-vault ceremony enrolls once per host between preflight and fallback activation, without local classification',
  async () => {
    const f = await callbackFixture({
      opencode: true,
      pi: true,
      claustrum: true,
    })
    const pi = await resolveNativeSetupPaths('pi', f.env)
    const events: string[] = []
    const granted = new Set<string>()
    const protectedPaths = []
    for (const plan of [f.plan, pi])
      for (const path of [
        plan.paths.config,
        plan.paths.state,
        plan.paths.runtime,
        plan.paths.journal,
      ]) {
        protectedPaths.push(path)
        await mkdir(dirname(path), { recursive: true })
        await writeFile(path, '{malformed-local-file', { mode: 0o600 })
      }
    const before = await settleSetupSiblings([
      setupBytes(f.plan),
      setupBytes(pi),
    ])
    const reads = forbidSetupReads(protectedPaths)
    lifetimes.deferCleanup(reads.restore)
    expect(
      await runSetupCommand(['--yes', '--claustrum', '--opencode=2'], {
        ...f.io,
        connect: async () => {
          events.push('connect')
          let name = ''
          return {
            close() {},
            enrollPropose: async (input) => {
              // This vault cannot apply proposal grants, so activation must grant access.
              if ('requestedGrants' in input)
                throw new ClaustrumCredentialError(
                  'invalid_params',
                  'permanent',
                  'gone',
                )
              name = input.name
              events.push(`enroll:${name}`)
              return { requestId: name }
            },
            enrollPoll: async () => ({
              status: 'approved',
              name,
              token: 'c'.repeat(64),
              tokenGeneration: 1,
            }),
          }
        },
        runner: {
          run: async (_file, args) => {
            expect(args).not.toContain('--remove-pi-auth')
            if (args[0] === 'install') events.push('register:pi')
            if (args.includes('grant')) {
              const principal = args[args.indexOf('--principal') + 1]!
              expect(args).toEqual([
                'auth',
                'grant',
                '--principal',
                principal,
                '--selector-kind',
                'category',
                '--selector',
                'anthropic-native',
                '--operation',
                'read',
              ])
              granted.add(principal)
              events.push(`grant:${principal}`)
            }
            return { exitCode: 0, stdout: '1.0.0', stderr: '' }
          },
        },
        vaultPreflight: async (host, options) => {
          events.push(`preflight:${host}`)
          return preflightNativeVaultForHost(host, options)
        },
        vaultActivate: async (host, options, preflight) => {
          events.push(`activate:${host}`)
          expect(await readNativeEnrollmentMode(host, f.env)).toBe('claustrum')
          const enrollment = getHostClaustrumEnrollmentPaths(host, f.env)
          expect(
            JSON.parse(await readFile(enrollment.statePath, 'utf8')),
          ).toMatchObject({
            phase: 'approved',
            proposedName: `anthropic-auth-${host}`,
          })
          expect(
            JSON.parse(await readFile(enrollment.tokenPath, 'utf8')),
          ).toEqual({
            token: 'c'.repeat(64),
            token_generation: 1,
          })
          if (host === 'opencode')
            await expect(
              stat(join(dirname(f.plan.legacyConfigPath), 'opencode.jsonc')),
            ).rejects.toThrow()
          else
            expect(
              await readFile(
                join(dirname(f.plan.legacyConfigPath), 'opencode.jsonc'),
                'utf8',
              ),
            ).toContain('plugins')
          return completeNativeVaultActivation(
            host,
            {
              ...options,
              discover: async () => {
                if (!granted.has(`enrolled:anthropic-auth-${host}`))
                  throw new Error(
                    'Fixture vault refuses inventory without the provider grant',
                  )
                events.push(`discover:${host}`)
                return {
                  view: 'fixture',
                  skipped: [],
                  credentials: [
                    {
                      credentialId: 'oauth:anthropic',
                      credentialType: 'oauth',
                      accountIdentity: SETUP_UUID,
                      state: 'active',
                    },
                  ],
                }
              },
            },
            preflight,
          )
        },
      }),
    ).toBe(0)
    expect(events).toEqual([
      'connect',
      'preflight:opencode',
      'preflight:pi',
      'connect',
      'enroll:anthropic-auth-opencode',
      'activate:opencode',
      'grant:enrolled:anthropic-auth-opencode',
      'discover:opencode',
      'connect',
      'enroll:anthropic-auth-pi',
      'activate:pi',
      'grant:enrolled:anthropic-auth-pi',
      'discover:pi',
      'register:pi',
    ])
    expect(reads.hits).toEqual([])
    reads.restore()
    expect(await setupBytes(f.plan)).toEqual(before[0]!)
    expect(
      (await setupBytes(pi)).filter(([path]) => path !== pi.hostAuthPath),
    ).toEqual(before[1]!.filter(([path]) => path !== pi.hostAuthPath))
    expect(
      inspectNativeHostAuthEntry(
        'pi',
        JSON.parse(await readFile(pi.hostAuthPath, 'utf8')),
      ).kind,
    ).toBe('api_key')
  },
)

lifetimes.test(
  'vault generation 2 never opens OC1 data and fallback grant failure prevents activation',
  async () => {
    const f = await callbackFixture({
      opencode: true,
      pi: false,
      claustrum: true,
    })
    await writeSetupJson(f.plan.hostAuthPath, { anthropic: SETUP_HOST_LOGIN })
    await fsPromises.chmod(f.plan.hostAuthPath, 0)
    let discoveries = 0
    const { completeNativeVaultActivation } = await import(
      '../setup/native-activation.ts'
    )
    const data = watchDataDirectory(dirname(f.plan.hostAuthPath))
    try {
      expect(
        await runSetupCommand(['--yes', '--claustrum', '--opencode=2'], {
          ...f.io,
          connect: async (options) => {
            const client = await f.io.connect!(options)
            return {
              ...client,
              enrollPropose: async (input) => {
                if ('requestedGrants' in input)
                  throw new ClaustrumCredentialError(
                    'invalid_params',
                    'permanent',
                    'gone',
                  )
                return client.enrollPropose(input)
              },
            }
          },
          runner: {
            run: async (_file, args) => ({
              exitCode: args.includes('grant') ? 1 : 0,
              stdout: '',
              stderr: ECHO_SK,
            }),
          },
          vaultActivate: (host, options, preflight) =>
            completeNativeVaultActivation(
              host,
              {
                ...options,
                discover: async () => {
                  discoveries++
                  throw new Error('Must not discover before the grant')
                },
              },
              preflight,
            ),
        }),
      ).toBe(1)
      expect(discoveries).toBe(0)
      expect(data.hits).toEqual([])
      expect(f.screen()).not.toContain(ECHO_SK)
      expect(f.screen()).toContain('permission-refused')
      expect(f.screen()).toContain(
        'Native vault setup: permission-refused. Could not grant this host read access to native Claude accounts. An older ck may refuse a grant that already exists. Update CortexKit tools and run setup again.',
      )
    } finally {
      data.restore()
      await fsPromises.chmod(f.plan.hostAuthPath, 0o600)
    }
    expect(await readFile(f.plan.hostAuthPath, 'utf8')).toBe(
      JSON.stringify({ anthropic: SETUP_HOST_LOGIN }),
    )
    expect(await readNativeMigrationJournal(f.plan.paths)).toBeUndefined()
  },
)

lifetimes.test(
  'Pi-only vault setup uses the Pi connection override and preserves consented stored auth',
  async () => {
    const f = await callbackFixture({
      opencode: false,
      pi: true,
      claustrum: true,
    })
    delete f.env.OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_CONNECTION_FILE
    f.env.PI_ANTHROPIC_AUTH_CLAUSTRUM_CONNECTION_FILE = join(
      f.env.HOME!,
      'pi-only-connection',
    )
    await writeSetupJson(f.env.PI_ANTHROPIC_AUTH_CLAUSTRUM_CONNECTION_FILE, {})
    const pi = await resolveNativeSetupPaths('pi', f.env)
    await writeSetupJson(pi.hostAuthPath, { anthropic: SETUP_HOST_LOGIN })
    const io = detectionIO(f.env, {
      opencode: false,
      pi: true,
      claustrum: true,
    })
    const connect = io.connect!
    let registered = 0
    let activated: Awaited<ReturnType<typeof setupBytes>> | undefined
    const writes = fenceCompletedSetupWrites()
    lifetimes.deferCleanup(writes.restore)
    const { stashPath, placeholderKey } = nativePiAuthSlotPaths({
      env: f.env,
      authPath: pi.hostAuthPath,
    })
    expect(
      await runSetupCommand(['-y', '--claustrum', '--remove-pi-auth'], {
        ...io,
        terminal: f.io.terminal,
        runner: {
          run: async (_file, args) => {
            expect(args).not.toContain('--remove-pi-auth')
            if (args[0] === 'install') {
              registered++
              expect(
                JSON.parse(await readFile(pi.hostAuthPath, 'utf8')).anthropic,
              ).toEqual({ type: 'api_key', key: placeholderKey })
              activated = await setupBytes(pi)
              writes.protect([
                ...activated.map(([path]) => String(path)),
                stashPath,
              ])
            }
            return { exitCode: 0, stdout: '1.0.0', stderr: '' }
          },
        },
        fence: f.io.fence,
        connect: async (input) => {
          expect(input.connectionFile).toBe(
            f.env.PI_ANTHROPIC_AUTH_CLAUSTRUM_CONNECTION_FILE!,
          )
          return connect(input)
        },
        vaultActivate: (host, options, preflight) =>
          completeNativeVaultActivation(
            host,
            {
              ...options,
              discover: async () => ({
                view: 'fixture',
                skipped: [],
                credentials: [
                  {
                    credentialId: 'oauth:anthropic',
                    credentialType: 'oauth',
                    accountIdentity: SETUP_UUID,
                    state: 'active',
                  },
                ],
              }),
            },
            preflight,
          ),
      }),
    ).toBe(0)
    expect(registered).toBe(1)
    expect(writes.hits).toEqual([])
    expect(activated).toBeDefined()
    expect(await setupBytes(pi)).toEqual(activated!)
    expect(await readFile(stashPath, 'utf8')).toContain(
      SETUP_HOST_LOGIN.refresh,
    )
    expect(await readNativeEnrollmentMode('pi', f.env)).toBe('claustrum')
    expect(await readNativeMigrationJournal(pi.paths)).toBeUndefined()
    expect(
      inspectNativeHostAuthEntry(
        'pi',
        JSON.parse(await readFile(pi.hostAuthPath, 'utf8')),
      ).kind,
    ).toBe('api_key')
  },
)

for (const login of [false, true]) {
  lifetimes.test(
    `S1 empty-init with no account data imports absent legacy sources${login ? ' before one explicit login' : ''}`,
    async () => {
      const f = await callbackFixture()
      expect(await runSetupCommand(['--yes', '--opencode=2'], f.io)).toBe(0)
      let migrations = 0
      const run = () =>
        runSetupCommand(
          ['--yes', '--opencode=1', ...(login ? ['--login'] : [])],
          {
            ...f.io,
            localLogin: async () => ({
              accountIdentity: SETUP_UUID,
              credential: {
                type: 'oauth',
                access: SETUP_ACCESS,
                refresh: 'native-fixture-refresh',
                expires: Date.now() + 28_800_000,
              },
            }),
            migrateLocal: async (host, options) => {
              migrations++
              await migrateNativeLocalForHost(host, options)
            },
          },
        )
      if (login)
        await withSetupBootstrap(async (lookups) => {
          expect(await run()).toBe(0)
          expect(lookups).toEqual([`Bearer ${SETUP_ACCESS}`])
        })
      else expect(await run()).toBe(0)
      expect(migrations).toBe(1)
      expect(await readNativeMigrationJournal(f.plan.paths)).toMatchObject({
        version: 5,
        kind: 'legacy-import',
        phase: 'retired',
      })
      expect(
        inspectNativeHostAuthEntry(
          'opencode',
          JSON.parse(await readFile(f.plan.hostAuthPath, 'utf8')),
        ).kind,
      ).toBe('activation')
    },
  )
}

// An OpenCode 1 login added after a first setup that found no login. Setups
// first run on 2.0.2 or earlier left a retired v4 legacy journal; later ones
// leave empty-init. Either way the rerun imports the login while the pool holds
// no account data.
const LATER_HOST_LOGIN = {
  type: 'oauth' as const,
  access: 'sk-ant-oat01-later-host-login',
  refresh: 'later-host-login-refresh',
  expires: Date.now() + 28_800_000,
}

async function hostSlotKind(f: Awaited<ReturnType<typeof callbackFixture>>) {
  return inspectNativeHostAuthEntry(
    'opencode',
    JSON.parse(await readFile(f.plan.hostAuthPath, 'utf8')),
  ).kind
}

async function setupPoolRows(f: Awaited<ReturnType<typeof callbackFixture>>) {
  const pool = await createNativePoolStore({
    paths: f.plan.paths,
    quota: nativeQuotaCodec,
  }).read()
  if (pool.status !== 'ready') throw new Error('Fixture pool is not ready')
  return pool.rows
}

for (const authority of ['retired-legacy', 'empty-init'] as const) {
  lifetimes.test(
    `S1 ${authority} with no account data imports a later OpenCode login on rerun`,
    async () => {
      const f = await callbackFixture()
      expect(
        await runSetupCommand(
          ['--yes', `--opencode=${authority === 'empty-init' ? '2' : '1'}`],
          f.io,
        ),
      ).toBe(0)
      expect(await readNativeMigrationJournal(f.plan.paths)).toMatchObject(
        authority === 'empty-init'
          ? { version: 5, kind: 'empty-init' }
          : { version: 4, phase: 'retired', activation: null },
      )
      expect(await core.nativePoolHoldsAccountData(f.plan)).toBe(false)
      await writeSetupJson(f.plan.hostAuthPath, { anthropic: LATER_HOST_LOGIN })
      let migrations = 0
      expect(
        await runSetupCommand(['--yes', '--opencode=1'], {
          ...f.io,
          migrateLocal: async (host, options) => {
            migrations++
            // The login stays in the host slot until the import replaces it.
            expect(await hostSlotKind(f)).toBe('oauth')
            await migrateNativeLocalForHost(host, options)
          },
        }),
      ).toBe(0)
      expect(migrations).toBe(1)
      expect(await readNativeMigrationJournal(f.plan.paths)).toMatchObject({
        version: 5,
        kind: 'legacy-import',
        phase: 'retired',
        activation: null,
      })
      const rows = await setupPoolRows(f)
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({
        type: 'oauth',
        enabled: true,
        credential: {
          type: 'oauth',
          access: LATER_HOST_LOGIN.access,
          refresh: LATER_HOST_LOGIN.refresh,
        },
      })
      expect(await hostSlotKind(f)).toBe('activation')
      // Moved, not copied: no live token is left in OpenCode's auth file.
      const host = await readFile(f.plan.hostAuthPath, 'utf8')
      expect(host).not.toContain(LATER_HOST_LOGIN.refresh)
      expect(host).not.toContain(LATER_HOST_LOGIN.access)
      expect(f.screen()).not.toContain(SEPARATE_HOST_LOGIN_NOTICE)
    },
  )
}

lifetimes.test(
  'S1 retired-legacy empty pool on a vault-enrolled host neither reads nor imports a later OpenCode login',
  async () => {
    const f = await callbackFixture()
    expect(await runSetupCommand(['--yes', '--opencode=1'], f.io)).toBe(0)
    expect(await core.nativePoolHoldsAccountData(f.plan)).toBe(false)
    await writeSetupJson(f.plan.hostAuthPath, { anthropic: LATER_HOST_LOGIN })
    await writeSetupJson(
      getHostClaustrumEnrollmentPaths('opencode', f.env).tokenPath,
      { token: 'c'.repeat(64), token_generation: 1 },
    )
    expect(await readNativeEnrollmentMode('opencode', f.env)).toBe('claustrum')
    const before = await setupBytes(f.plan)
    let migrations = 0
    const data = watchDataDirectory(dirname(f.plan.hostAuthPath))
    try {
      expect(
        await runSetupCommand(['--yes', '--no-claustrum', '--opencode=1'], {
          ...f.io,
          migrateLocal: async () => {
            migrations++
          },
        }),
      ).toBe(1)
      // A direct import call on the enrolled host refuses at its first fence.
      await expect(
        migrateNativeLocalForHost('opencode', {
          env: f.env,
          paths: f.plan,
          fence: createTestFence(),
          removePiAnthropicAuth: false,
        }),
      ).rejects.toBeInstanceOf(SetupRefusal)
      expect(data.accesses).toEqual([])
    } finally {
      data.restore()
    }
    expect(migrations).toBe(0)
    expect(f.screen()).toContain('OpenCode is still connected to the vault.')
    expect(await setupBytes(f.plan)).toEqual(before)
    expect(await hostSlotKind(f)).toBe('oauth')
    expect(await readNativeMigrationJournal(f.plan.paths)).toMatchObject({
      version: 4,
      phase: 'retired',
    })
  },
)

lifetimes.test(
  'S1 retired-legacy pool with accounts keeps a later OpenCode login unimported',
  async () => {
    const f = await callbackFixture()
    expect(await runSetupCommand(['--yes', '--opencode=1'], f.io)).toBe(0)
    const runtime = setupRuntime(f)
    try {
      await poolMethodLogin(runtime)
    } finally {
      runtime.close()
    }
    expect(await core.nativePoolHoldsAccountData(f.plan)).toBe(true)
    await writeSetupJson(f.plan.hostAuthPath, { anthropic: LATER_HOST_LOGIN })
    const before = await setupBytes(f.plan)
    let migrations = 0
    expect(
      await runSetupCommand(['--yes', '--opencode=1'], {
        ...f.io,
        migrateLocal: async () => {
          migrations++
        },
      }),
    ).toBe(0)
    expect(migrations).toBe(0)
    expect(await setupBytes(f.plan)).toEqual(before)
    expect(f.screen().split(SEPARATE_HOST_LOGIN_NOTICE).length - 1).toBe(1)
    await expect(
      migrateNativeLocalForHost('opencode', {
        env: f.env,
        paths: f.plan,
        fence: createTestFence(),
        removePiAnthropicAuth: false,
      }),
    ).rejects.toMatchObject({ code: 'host-login-present' })
    expect(await setupBytes(f.plan)).toEqual(before)
    expect(await readNativeMigrationJournal(f.plan.paths)).toMatchObject({
      version: 4,
      phase: 'retired',
    })
  },
)

lifetimes.test(
  'Pi SDK auth path ignores PI_AGENT_DIR while native pool paths keep it',
  async () => {
    const f = await callbackFixture({
      opencode: false,
      pi: true,
      claustrum: false,
    })
    delete f.env.PI_CODING_AGENT_DIR
    f.env.PI_AGENT_DIR = join(f.env.HOME!, 'pool-override')
    const pi = await resolveNativeSetupPaths('pi', f.env)
    expect(pi.hostAuthPath).toBe(join(f.env.HOME!, '.pi', 'agent', 'auth.json'))
    expect(pi.legacyConfigPath).toBe(
      join(f.env.HOME!, 'pool-override', 'anthropic-auth.json'),
    )
    expect(
      await runSetupCommand(['--yes'], {
        ...detectionIO(f.env, { opencode: false, pi: true, claustrum: false }),
        fence: f.io.fence,
        runner: f.io.runner,
        terminal: f.io.terminal,
      }),
    ).toBe(0)
    expect((await readNativeMigrationJournal(pi.paths))?.phase).toBe('retired')
  },
)

for (const generation of ['1', '2', 'both'] as const) {
  lifetimes.test(
    `shared registration ${generation} owns config writes and opens only the permitted OpenCode data file`,
    async () => {
      const f = await callbackFixture()
      await writeSetupJson(f.plan.hostAuthPath, {
        anthropic: { type: 'api', key: 'fixture-key' },
      })
      const data = watchDataDirectory(
        dirname(f.plan.hostAuthPath),
        generation === '2' ? [] : [getOpenCodeAuthPath(f.env)],
      )
      let migrations = 0
      try {
        expect(
          await runSetupCommand(['--yes', `--opencode=${generation}`], {
            ...f.io,
            migrateLocal: async (host, options) => {
              expect(host).toBe('opencode')
              migrations++
              await migrateNativeLocalForHost(host, options)
            },
          }),
        ).toBe(0)
        expect(data.hits).toEqual([])
        expect([...new Set(data.accesses)]).toEqual(
          generation === '2' ? [] : [f.plan.hostAuthPath],
        )
      } finally {
        data.restore()
      }
      const config = dirname(f.plan.legacyConfigPath)
      expect(await readFile(join(config, 'opencode.jsonc'), 'utf8')).toContain(
        '@cortexkit/opencode-anthropic-auth@',
      )
      if (generation === '2') {
        expect(existsSync(join(config, 'tui.jsonc'))).toBe(false)
        expect(migrations).toBe(0)
      } else {
        expect(await readFile(join(config, 'tui.jsonc'), 'utf8')).toContain(
          '@cortexkit/opencode-anthropic-auth@',
        )
        expect(migrations).toBe(1)
        expect((await readNativeMigrationJournal(f.plan.paths))?.kind).not.toBe(
          'empty-init',
        )
        expect(f.screen()).not.toContain(CLAUDE_POOL_LOGIN_STEP)
      }
      expect(await readNativeEnrollmentMode('opencode', f.env)).toBe('local')
    },
  )
}

lifetimes.test(
  'OpenCode both plus Pi login commits one credential epoch and one authority per host before write-free migrate',
  async () => {
    const f = await callbackFixture({
      opencode: true,
      pi: true,
      claustrum: false,
    })
    const pi = await resolveNativeSetupPaths('pi', f.env)
    const committed = new Map<string, Awaited<ReturnType<typeof setupBytes>>>()
    const writes = fenceCompletedSetupWrites()
    lifetimes.deferCleanup(writes.restore)
    const calls: string[] = []
    await withSetupBootstrap(async (lookups) => {
      expect(
        await runSetupCommand(['--yes', '--login', '--opencode=both'], {
          ...f.io,
          localLogin: async (host) => {
            calls.push(`exchange:${host}`)
            if (host === 'pi')
              expect(await setupBytes(f.plan)).toEqual(
                committed.get('opencode')!,
              )
            return {
              accountIdentity: SETUP_UUID,
              credential: {
                type: 'oauth',
                access: `${SETUP_ACCESS}-${host}`,
                refresh: `fixture-${host}`,
                expires: Date.now() + 28_800_000,
              },
            }
          },
          migrateLocal: async (host, options) => {
            calls.push(`signInLocal:${host}`)
            expect(options.login).toBeDefined()
            await migrateNativeLocalForHost(host, options)
            const plan = host === 'pi' ? pi : f.plan
            committed.set(host, await setupBytes(plan))
            writes.protect(committed.get(host)!.map(([path]) => String(path)))
          },
        }),
      ).toBe(0)
      expect(lookups).toEqual([
        `Bearer ${SETUP_ACCESS}-opencode`,
        `Bearer ${SETUP_ACCESS}-pi`,
      ])
    })
    expect(calls).toEqual([
      'signInLocal:opencode',
      'exchange:opencode',
      'signInLocal:pi',
      'exchange:pi',
    ])
    expect(committed.size).toBe(2)
    expect(writes.hits).toEqual([])
    expect(f.plan.paths.journal).not.toBe(pi.paths.journal)
    for (const plan of [f.plan, pi]) {
      expect(await setupBytes(plan)).toEqual(committed.get(plan.host)!)
      expect(await readNativeMigrationJournal(plan.paths)).toMatchObject({
        host: plan.host,
        version: 4,
        phase: 'retired',
      })
      const pool = await createNativePoolStore({
        paths: plan.paths,
        quota: nativeQuotaCodec,
      }).read()
      expect(pool.status).toBe('ready')
      if (pool.status !== 'ready')
        throw new Error('Fixture login pool is not ready')
      expect(pool.rows).toHaveLength(1)
      expect(pool.rows[0]?.credentialEpoch).toBe(1)
      expect(await readNativeEnrollmentMode(plan.host, f.env)).toBe('local')
    }
    expect(f.screen()).not.toContain(CLAUDE_POOL_LOGIN_STEP)
  },
)

lifetimes.test(
  'default shared process fence prints a failing inspection refusal exactly once',
  async () => {
    const f = await callbackFixture()
    const { fence: _injectedFence, ...io } = f.io
    const commands: string[] = []
    expect(
      await runSetupCommand(['--yes'], {
        ...io,
        runner: {
          run: async (file) => {
            commands.push(file)
            return {
              exitCode: file === 'ps' ? 7 : 0,
              stdout: '',
              stderr: ECHO_SK,
            }
          },
        },
      }),
    ).toBe(1)
    expect(commands).toContain('ps')
    const message =
      'Process inspection failed; setup cannot prove hosts are stopped.'
    expect(f.screen().split(message).length - 1).toBe(1)
    expect(f.screen()).toMatch(/ps: exit code 7 after \d+ ms\./)
    expect(f.screen()).toMatch(/ps: exit code 7 after \d+ ms\.\n$/)
    expect(f.screen()).not.toContain(ECHO_SK)
    expect(f.screen()).not.toContain('Details were written')
    await expectNoDiagnostics(f)
    expect(await readNativeMigrationJournal(f.plan.paths)).toBeUndefined()
  },
)

for (const mode of ['local', 'claustrum'] as const) {
  lifetimes.test(
    `callback process inspection failure prints once in ${mode} mode`,
    async () => {
      const f = await callbackFixture({
        opencode: true,
        pi: false,
        claustrum: mode === 'claustrum',
      })
      const { fence: _injectedFence, ...io } = f.io
      let inspections = 0
      expect(
        await runSetupCommand(
          ['--yes', ...(mode === 'claustrum' ? ['--claustrum'] : [])],
          {
            ...io,
            runner: {
              run: async (file) => {
                if (file === 'ps') {
                  inspections++
                  return {
                    exitCode: inspections >= 3 ? 7 : 0,
                    stdout: '1 /sbin/init\n',
                    stderr: ECHO_SK,
                  }
                }
                return { exitCode: 0, stdout: '', stderr: '' }
              },
            },
          },
        ),
      ).toBe(1)
      expect(inspections).toBe(3)
      expect(
        f
          .screen()
          .split(
            'Process inspection failed; setup cannot prove hosts are stopped.',
          ).length - 1,
      ).toBe(1)
      expect(f.screen()).not.toContain(ECHO_SK)
      expect(f.screen()).not.toContain('Details were written')
      expect(await readNativeMigrationJournal(f.plan.paths)).toBeUndefined()
    },
  )
}

for (const [slot, anthropic] of [
  ['absent', undefined],
  ['plugin placeholder', custodyTombstoneOAuth('anthropic')],
  ['separate OAuth login', SETUP_HOST_LOGIN],
  ['API key', { type: 'api', key: 'synthetic-host-api-key' }],
] as const) {
  lifetimes.test(
    `vault setup ${slot}: gives only necessary login guidance without changing or printing host credentials`,
    async () => {
      const f = await callbackFixture({
        opencode: true,
        pi: false,
        claustrum: true,
      })
      await writeSetupJson(f.plan.hostAuthPath, {
        ...(anthropic ? { anthropic } : {}),
        unrelated: { type: 'api', key: 'synthetic-unrelated-api-key' },
      })
      const before = await readFile(f.plan.hostAuthPath, 'utf8')
      const warning =
        'Warning: OpenCode holds a separate Anthropic OAuth login. Remove the separate OpenCode Anthropic login, then choose "Claude via credential vault". Setup has left that login unchanged.'
      let activated = false
      const callbackScreens: string[] = []
      expect(
        await runSetupCommand(['--yes', '--claustrum', '--opencode=1'], {
          ...f.io,
          connect: async (options) => {
            const client = await f.io.connect!(options)
            return {
              ...client,
              enrollPropose: async (input) => {
                callbackScreens.push(f.screen())
                return client.enrollPropose(input)
              },
            }
          },
          vaultActivate: (host, options, preflight) => {
            activated = true
            callbackScreens.push(f.screen())
            return completeNativeVaultActivation(
              host,
              {
                ...options,
                discover: async () => verifiedSetupInventory(),
              },
              preflight,
            )
          },
        }),
      ).toBe(0)
      expect(activated).toBe(true)
      expect(callbackScreens).toHaveLength(2)
      for (const screen of callbackScreens)
        expect(screen.split(warning).length - 1).toBe(
          slot === 'separate OAuth login' ? 1 : 0,
        )
      expect(f.screen().split(warning).length - 1).toBe(
        slot === 'separate OAuth login' ? 2 : 0,
      )
      for (const secret of [
        SETUP_HOST_LOGIN.access,
        SETUP_HOST_LOGIN.refresh,
        'synthetic-host-api-key',
        'synthetic-unrelated-api-key',
        'claustrum-tombstone:',
      ])
        expect(f.screen()).not.toContain(secret)
      expect(await readFile(f.plan.hostAuthPath, 'utf8')).toBe(before)
    },
  )
}

lifetimes.test(
  'verified vault generation 2 succeeds without any OpenCode data-directory I/O',
  async () => {
    const f = await callbackFixture({
      opencode: true,
      pi: false,
      claustrum: true,
    })
    await writeSetupJson(f.plan.hostAuthPath, { anthropic: SETUP_HOST_LOGIN })
    const before = await readFile(f.plan.hostAuthPath, 'utf8')
    await fsPromises.chmod(f.plan.hostAuthPath, 0)
    const data = watchDataDirectory(dirname(f.plan.hostAuthPath))
    try {
      expect(
        await runSetupCommand(['--yes', '--claustrum', '--opencode=2'], {
          ...f.io,
          vaultActivate: (host, options, preflight) =>
            completeNativeVaultActivation(
              host,
              { ...options, discover: async () => verifiedSetupInventory() },
              preflight,
            ),
        }),
      ).toBe(0)
      expect(data.hits).toEqual([])
      expect(data.accesses).toEqual([])
    } finally {
      data.restore()
      await fsPromises.chmod(f.plan.hostAuthPath, 0o600)
    }
    expect(await readFile(f.plan.hostAuthPath, 'utf8')).toBe(before)
    expect(await readNativeEnrollmentMode('opencode', f.env)).toBe('claustrum')
    expect(await readNativeMigrationJournal(f.plan.paths)).toBeUndefined()
  },
)

lifetimes.test(
  'vault primary-unverified refuses without changing the OpenCode host auth bytes',
  async () => {
    const f = await callbackFixture({
      opencode: true,
      pi: false,
      claustrum: true,
    })
    await writeSetupJson(f.plan.hostAuthPath, {
      anthropic: SETUP_HOST_LOGIN,
      unrelated: { type: 'api', key: 'fixture-key' },
    })
    const before = await setupBytes(f.plan)
    let refusal: unknown
    expect(
      await runSetupCommand(['--yes', '--claustrum', '--opencode=1'], {
        ...f.io,
        vaultActivate: async (host, options, preflight) => {
          try {
            return await completeNativeVaultActivation(
              host,
              {
                ...options,
                discover: async () => ({
                  view: 'fixture',
                  skipped: [],
                  credentials: [],
                }),
              },
              preflight,
            )
          } catch (error) {
            refusal = error
            throw error
          }
        },
      }),
    ).toBe(1)
    expect(refusal).toMatchObject({
      name: 'NativeVaultActivationError',
      code: 'primary-unverified',
    })
    expect(f.screen()).toContain(
      'The vault has no verified default Claude account.',
    )
    expect(await setupBytes(f.plan)).toEqual(before)
    expect(
      existsSync(join(dirname(f.plan.legacyConfigPath), 'opencode.jsonc')),
    ).toBe(false)
  },
)

type GrantSetupClient = Awaited<ReturnType<NonNullable<SetupIO['connect']>>>
type GrantSetupProposal = Parameters<GrantSetupClient['enrollPropose']>[0]
const NATIVE_READ_GRANTS = [
  { selector: { category: 'anthropic-native' }, operation: 'read' as const },
]
const GRANT_SETUP_ROW: ScopedInventoryRow = {
  id: 'oauth:anthropic',
  accountId: SETUP_UUID,
  credentialType: 'oauth',
  categories: ['anthropic-native'],
  refreshAdapter: 'anthropic',
  serves: ['anthropic'],
  providerIds: [],
  state: 'active',
  operations: ['read'],
  recordVersion: 1,
  createdAtMs: null,
}

async function grantSetupFixture(
  host: 'opencode' | 'pi',
  mode: 'sent' | 'dropped' | 'legacy' | 'resumed' = 'sent',
) {
  const f = await callbackFixture({
    opencode: host === 'opencode',
    pi: host === 'pi',
    claustrum: true,
  })
  const paths = getHostClaustrumEnrollmentPaths(host, f.env)
  const name = `anthropic-auth-${host}`
  const proposals: GrantSetupProposal[] = []
  const events: string[] = []
  const state = {
    rows: [GRANT_SETUP_ROW] as readonly ScopedInventoryRow[],
    listFailure: false,
    approved: mode !== 'resumed',
    grants: 0,
    screenAtGrant: '',
    inventory: verifiedSetupInventory() as NativeCustodyInventory,
  }
  const client: GrantSetupClient = {
    close() {},
    enrollPropose: async (input) => {
      proposals.push(input)
      if (mode === 'dropped' && proposals.length === 1)
        throw new ClaustrumCredentialError(
          'invalid_params',
          'permanent',
          'gone',
        )
      return { requestId: 'grant-setup-request' }
    },
    enrollPoll: async () =>
      state.approved
        ? {
            status: 'approved',
            name,
            token: 'c'.repeat(64),
            tokenGeneration: 1,
          }
        : { status: 'pending' },
    listScoped: async (token) => {
      expect(token).toBe('c'.repeat(64))
      events.push('confirmation')
      if (state.listFailure) throw new Error(ECHO_SK)
      return {
        view: 'grant-setup',
        rows: state.rows,
        grants: undefined,
        grantTuples: undefined,
      }
    },
  }
  if (mode === 'legacy' || mode === 'resumed') {
    const manager = new ClaustrumEnrollmentManager({
      paths,
      proposedName: name,
      ...(mode === 'resumed' && { requestedGrants: NATIVE_READ_GRANTS }),
      client,
    })
    await manager.reconcile()
    state.approved = true
  }
  const run = () =>
    runSetupCommand(
      [
        '--yes',
        '--claustrum',
        ...(host === 'opencode' ? ['--opencode=2'] : []),
      ],
      {
        ...f.io,
        connect: async () => client,
        runner: {
          run: async (_file, args) => {
            if (args.includes('grant')) {
              state.grants++
              state.screenAtGrant = f.screen()
              events.push('fallback')
            }
            return { exitCode: 0, stdout: '', stderr: '' }
          },
        },
        vaultActivate: (selected, options, preflight) =>
          completeNativeVaultActivation(
            selected,
            {
              ...options,
              discover: async () => {
                events.push('default-account')
                if (mode === 'dropped' || mode === 'legacy')
                  expect(state.grants).toBe(1)
                return state.inventory
              },
            },
            preflight,
          ),
      },
    )
  return { ...f, run, state, paths, name, proposals, events }
}

describe('approval-time native read grants', () => {
  for (const host of ['opencode', 'pi'] as const) {
    lifetimes.test(
      `${host} proposes account read access and confirms approval before activation without another grant`,
      async () => {
        const f = await grantSetupFixture(host)
        expect(await f.run()).toBe(0)
        expect(f.proposals).toMatchObject([
          {
            name: f.name,
            displayName:
              host === 'opencode'
                ? 'Claude sign-in for OpenCode'
                : 'Claude sign-in for Pi',
            requestedGrants: NATIVE_READ_GRANTS,
          },
        ])
        expect(f.state.grants).toBe(0)
        expect(f.events).toEqual(['confirmation', 'default-account'])
        expect(f.screen()).toContain(
          'Confirmed read access to the vault\'s "anthropic-native" accounts (1 reachable login).',
        )
        expect(f.screen()).not.toContain('Approved, but')
        expect(
          await readClaustrumEnrollmentStatus(f.paths, f.name),
        ).toMatchObject({
          state: 'approved',
          requestedGrantsStatus: 'sent',
        })
      },
    )
  }

  lifetimes.test(
    'a sent proposal with zero reachable logins refuses activation without overriding the approval decision',
    async () => {
      const f = await grantSetupFixture('opencode')
      f.state.rows = []
      f.state.inventory = { view: 'empty', skipped: [], credentials: [] }
      expect(await f.run()).toBe(1)
      expect(f.state.grants).toBe(0)
      expect(f.events).toEqual(['confirmation', 'default-account'])
      expect(f.screen()).toContain(
        'Approved, but no logins are reachable yet; run:',
      )
      expect(f.screen()).toContain(UNVERIFIED_TEXT)
      expect(f.screen()).not.toContain('Configured CortexKit')
    },
  )

  lifetimes.test(
    'a partial inventory counts only category read matches and still requires an account identity',
    async () => {
      const f = await grantSetupFixture('opencode')
      f.state.rows = [
        GRANT_SETUP_ROW,
        { ...GRANT_SETUP_ROW, id: 'list-only', operations: ['list'] },
        { ...GRANT_SETUP_ROW, id: 'other-category', categories: ['other'] },
      ]
      f.state.inventory = {
        view: 'unverified',
        skipped: [],
        credentials: [
          {
            credentialId: 'oauth:anthropic',
            credentialType: 'oauth',
            state: 'active',
          },
        ],
      }
      expect(await f.run()).toBe(1)
      expect(f.state.grants).toBe(0)
      expect(f.screen()).toContain('(1 reachable login).')
      expect(f.screen()).toContain(UNVERIFIED_TEXT)
    },
  )

  lifetimes.test(
    'a listScoped failure reports unconfirmed access without leaking its error or issuing a grant',
    async () => {
      const f = await grantSetupFixture('opencode')
      f.state.listFailure = true
      expect(await f.run()).toBe(0)
      expect(f.state.grants).toBe(0)
      expect(f.events).toEqual(['confirmation', 'default-account'])
      expect(f.screen()).toContain(
        'Approved, but access could not be confirmed;',
      )
      expect(f.screen()).not.toContain(ECHO_SK)
    },
  )

  lifetimes.test(
    'old-vault invalid_params retries once without name metadata or grants and falls back after approval',
    async () => {
      const f = await grantSetupFixture('opencode', 'dropped')
      expect(await f.run()).toBe(0)
      expect(f.proposals).toHaveLength(2)
      expect(f.proposals[0]).toMatchObject({
        displayName: 'Claude sign-in for OpenCode',
        requestedGrants: NATIVE_READ_GRANTS,
      })
      expect(f.proposals[1]).toEqual({
        name: f.name,
        requestSecretHash: f.proposals[0]!.requestSecretHash,
      })
      expect(f.events).toEqual(['fallback', 'default-account'])
      expect(f.state.grants).toBe(1)
      // common-auth 0.44 prints the remedy before our fallback; 0.45 will let us defer it.
      expect(f.state.screenAtGrant).toContain(
        'Approved. This vault is too old to grant access with the approval; run:',
      )
      expect(f.screen()).not.toContain(
        'Approved, but no logins are reachable yet',
      )
      expect(f.screen()).toContain('Configured CortexKit Anthropic Auth')
      expect(
        await readClaustrumEnrollmentStatus(f.paths, f.name),
      ).toMatchObject({
        state: 'approved',
        requestedGrantsStatus: 'dropped',
      })
    },
  )

  lifetimes.test(
    'a resumed grant proposal confirms approval without proposing again or issuing a separate grant',
    async () => {
      const f = await grantSetupFixture('pi', 'resumed')
      expect(f.proposals).toHaveLength(1)
      expect(await f.run()).toBe(0)
      expect(f.proposals).toHaveLength(1)
      expect(f.proposals[0]).toMatchObject({
        requestedGrants: NATIVE_READ_GRANTS,
      })
      expect(f.state.grants).toBe(0)
      expect(f.events).toEqual(['confirmation', 'default-account'])
      expect(f.screen()).toContain('(1 reachable login).')
    },
  )

  lifetimes.test(
    'an existing 0.43 enrollment keeps its grant fallback after the shared access report',
    async () => {
      const f = await grantSetupFixture('opencode', 'legacy')
      f.state.rows = []
      const before = await readFile(f.paths.tokenPath, 'utf8')
      expect(await f.run()).toBe(0)
      expect(f.proposals).toHaveLength(1)
      expect(f.proposals[0]).not.toHaveProperty('requestedGrants')
      expect(f.state.grants).toBe(1)
      expect(f.events).toEqual(['confirmation', 'fallback', 'default-account'])
      // With no recorded proposal, 0.44 also reports before fallback; deferred output awaits 0.45.
      expect(f.state.screenAtGrant).toContain(
        'Approved, but no logins are reachable yet; run:',
      )
      expect(f.screen()).toContain(`Already connected as ${f.name}.`)
      expect(f.screen()).toContain('Configured CortexKit Anthropic Auth')
      expect(await readFile(f.paths.tokenPath, 'utf8')).toBe(before)
      expect(
        await readClaustrumEnrollmentStatus(f.paths, f.name),
      ).not.toHaveProperty('requestedGrantsStatus')
    },
  )
})

// An empty vault listing is explained by the grants it reports: none at all
// needs a grant, a grant that reaches nothing needs the logins categorized,
// and an older vault that reports no grants keeps the generic message.
const READ_TUPLE = {
  selectorKind: 'category',
  selector: 'anthropic-native',
  operation: 'read',
}
const NO_GRANT_TEXT =
  'OpenCode has no read grant in the vault, so setup cannot see any Claude login. Run ck auth grant --principal enrolled:anthropic-auth-opencode --selector-kind category --selector anthropic-native --operation read, then rerun setup.'
const UNREACHED_TEXT =
  "OpenCode's vault read grant reaches no Claude login: no vault login carries the anthropic-native category, which logins saved before vault categories existed lack. Run ck auth reclassify --from-registry, check the logins with ck auth status, then rerun setup."
const UNVERIFIED_TEXT =
  'The vault has no verified default Claude account. Sign in through the vault and rerun setup.'
for (const scenario of [
  {
    name: 'no grant at all',
    inventory: { grantReach: { grants: 0, tuples: [] }, credentials: [] },
    code: 'no-read-grant',
    text: NO_GRANT_TEXT,
  },
  {
    name: 'no grant for an enrollment approved under a different name',
    approvedName: 'anthropic-auth-opencode-v2',
    inventory: { grantReach: { grants: 0, tuples: [] }, credentials: [] },
    code: 'no-read-grant',
    text: 'OpenCode has no read grant in the vault, so setup cannot see any Claude login. Run ck auth grant --principal enrolled:anthropic-auth-opencode-v2 --selector-kind category --selector anthropic-native --operation read, then rerun setup.',
  },
  {
    name: 'a grant that reaches no login',
    inventory: {
      grantReach: { grants: 1, tuples: [READ_TUPLE] },
      credentials: [],
    },
    code: 'grant-reaches-nothing',
    text: UNREACHED_TEXT,
  },
  {
    name: 'a reached login without a verified identity',
    inventory: {
      grantReach: { grants: 1, tuples: [READ_TUPLE] },
      credentials: [
        {
          credentialId: 'oauth:anthropic',
          credentialType: 'oauth' as const,
          state: 'active',
        },
      ],
    },
    code: 'primary-unverified',
    text: UNVERIFIED_TEXT,
  },
  {
    name: 'a vault too old to report grants',
    inventory: { credentials: [] },
    code: 'primary-unverified',
    text: UNVERIFIED_TEXT,
  },
]) {
  const { name, inventory, code, text } = scenario
  lifetimes.test(
    `vault setup with ${name} explains the empty listing with one fixed remedy`,
    async () => {
      const f = await callbackFixture({
        opencode: true,
        pi: false,
        claustrum: true,
      })
      let refusal: unknown
      expect(
        await runSetupCommand(['--yes', '--claustrum', '--opencode=2'], {
          ...f.io,
          vaultActivate: async (host, options, preflight) => {
            if ('approvedName' in scenario) {
              const { statePath } = getHostClaustrumEnrollmentPaths(host, f.env)
              const state = JSON.parse(await readFile(statePath, 'utf8'))
              await writeFile(
                statePath,
                JSON.stringify({
                  ...state,
                  approvedName: scenario.approvedName,
                }),
                { mode: 0o600 },
              )
            }
            try {
              return await completeNativeVaultActivation(
                host,
                {
                  ...options,
                  discover: async () => ({
                    view: 'fixture',
                    skipped: [],
                    ...inventory,
                  }),
                },
                preflight,
              )
            } catch (error) {
              refusal = error
              throw error
            }
          },
        }),
      ).toBe(1)
      expect(refusal).toMatchObject({
        name: 'NativeVaultActivationError',
        code,
      })
      const screen = f.screen()
      expect(screen).toContain(text)
      for (const other of [NO_GRANT_TEXT, UNREACHED_TEXT, UNVERIFIED_TEXT])
        if (other !== text) expect(screen).not.toContain(other)
      expect(screen).not.toContain('unexpected-error')
      await expectNoDiagnostics(f)
    },
  )
}

for (const failure of [
  'missing-stash',
  'consent-required',
  'connection-file',
] as const) {
  lifetimes.test(
    `first vault preflight refuses Pi ${failure} before enrollment or OpenCode effects`,
    async () => {
      const f = await callbackFixture({
        opencode: true,
        pi: true,
        claustrum: true,
      })
      const pi = await resolveNativeSetupPaths('pi', f.env)
      if (failure === 'missing-stash') {
        const slot = nativePiAuthSlotPaths({
          env: f.env,
          authPath: pi.hostAuthPath,
        })
        await writeSetupJson(pi.hostAuthPath, {
          anthropic: { type: 'api_key', key: slot.placeholderKey },
        })
      } else if (failure === 'consent-required') {
        await writeSetupJson(pi.hostAuthPath, { anthropic: SETUP_HOST_LOGIN })
      } else {
        f.env.PI_ANTHROPIC_AUTH_CLAUSTRUM_CONNECTION_FILE = join(
          f.env.HOME!,
          'different-pi-connection',
        )
      }
      const before = await settleSetupSiblings([
        setupBytes(f.plan),
        setupBytes(pi),
      ])
      let connects = 0
      let proposals = 0
      const effects: Array<readonly string[]> = []
      expect(
        await runSetupCommand(['--yes', '--claustrum', '--opencode=both'], {
          ...f.io,
          env: { ...f.io.env, ...f.env },
          runner: {
            run: async (_file, args) => {
              if (!args.includes('--version')) effects.push(args)
              return { exitCode: 0, stdout: '1.0.0', stderr: '' }
            },
          },
          connect: async (input) => {
            connects++
            const client = await f.io.connect!(input)
            return {
              ...client,
              enrollPropose: async (proposal) => {
                proposals++
                return client.enrollPropose(proposal)
              },
            }
          },
        }),
      ).toBe(1)
      // The shared setup runner probes Claustrum availability before callbacks; refusal prevents subsequent host-enrollment connections.
      expect(connects).toBe(1)
      expect(proposals).toBe(0)
      expect(effects).toEqual([])
      expect(f.screen()).toContain(
        {
          'missing-stash': 'missing-stash',
          'consent-required':
            'Pi has stored Anthropic authentication. Rerun with --remove-pi-auth',
          'connection-file':
            'Selected hosts use different vault connection files.',
        }[failure],
      )
      expect(
        await settleSetupSiblings([setupBytes(f.plan), setupBytes(pi)]),
      ).toEqual(before)
      for (const host of ['opencode', 'pi'] as const) {
        const enrollment = getHostClaustrumEnrollmentPaths(host, f.env)
        expect(existsSync(enrollment.tokenPath)).toBe(false)
        expect(existsSync(enrollment.statePath)).toBe(false)
      }
      expect(
        existsSync(join(dirname(f.plan.legacyConfigPath), 'opencode.jsonc')),
      ).toBe(false)
    },
  )
}

for (const change of ['slot', 'stash', 'enrollment'] as const) {
  lifetimes.test(
    `vault migrate refuses an external Pi ${change} change after beforeRegister without further provider writes`,
    async () => {
      const f = await callbackFixture({
        opencode: true,
        pi: true,
        claustrum: true,
      })
      const pi = await resolveNativeSetupPaths('pi', f.env)
      await writeSetupJson(pi.hostAuthPath, { anthropic: SETUP_HOST_LOGIN })
      const slot = nativePiAuthSlotPaths({
        env: f.env,
        authPath: getPiAuthPath(f.env),
      })
      let changed: Awaited<ReturnType<typeof setupBytes>>[] | undefined
      let stashBytes: string | undefined
      expect(
        await runSetupCommand(
          ['--yes', '--claustrum', '--remove-pi-auth', '--opencode=both'],
          {
            ...f.io,
            vaultActivate: (host, options, preflight) =>
              completeNativeVaultActivation(
                host,
                {
                  ...options,
                  discover: async () => verifiedSetupInventory(),
                },
                preflight,
              ),
            runner: {
              run: async (_file, args) => {
                expect(args).not.toContain('--remove-pi-auth')
                if (args[0] === 'install') {
                  expect(
                    JSON.parse(await readFile(pi.hostAuthPath, 'utf8'))
                      .anthropic.key,
                  ).toBe(slot.placeholderKey)
                  if (change === 'slot')
                    await writeSetupJson(pi.hostAuthPath, {
                      anthropic: {
                        type: 'api_key',
                        key: 'external-replacement',
                      },
                    })
                  else if (change === 'stash')
                    await writeFile(
                      slot.stashPath,
                      `${await readFile(slot.stashPath, 'utf8')}\n`,
                    )
                  else {
                    const enrollment = getHostClaustrumEnrollmentPaths(
                      'pi',
                      f.env,
                    )
                    await rm(enrollment.tokenPath)
                    await rm(enrollment.statePath)
                  }
                  changed = await settleSetupSiblings([
                    setupBytes(f.plan),
                    setupBytes(pi),
                  ])
                  stashBytes = await readFile(slot.stashPath, 'utf8')
                }
                return { exitCode: 0, stdout: '1.0.0', stderr: '' }
              },
            },
          },
        ),
      ).toBe(1)
      expect(changed).toBeDefined()
      expect(f.screen()).toContain(
        'Setup inputs changed. Rerun setup with all hosts stopped.',
      )
      expect(
        await settleSetupSiblings([setupBytes(f.plan), setupBytes(pi)]),
      ).toEqual(changed!)
      expect(await readFile(slot.stashPath, 'utf8')).toBe(stashBytes!)
    },
  )
}

for (const mode of ['local', 'claustrum'] as const) {
  lifetimes.test(
    `${mode} setup records the authoritative enrollment mode at default enrollment paths`,
    async () => {
      const f = await callbackFixture({
        opencode: true,
        pi: true,
        claustrum: true,
      })
      delete f.env.OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE
      delete f.env.PI_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE
      delete f.io.env!.OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE
      delete f.io.env!.PI_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE
      expect(
        await runSetupCommand(
          [
            '--yes',
            '--opencode=both',
            ...(mode === 'claustrum' ? ['--claustrum'] : []),
          ],
          {
            ...f.io,
            env: { ...f.io.env, ...f.env },
            vaultActivate: (host, options, preflight) =>
              completeNativeVaultActivation(
                host,
                {
                  ...options,
                  discover: async () => verifiedSetupInventory(),
                },
                preflight,
              ),
          },
        ),
      ).toBe(0)
      expect(f.screen()).toContain(
        `Configured CortexKit Anthropic Auth for opencode, pi (${mode}).`,
      )
      for (const host of ['opencode', 'pi'] as const)
        expect(await readNativeEnrollmentMode(host, f.env)).toBe(mode)
    },
  )
}

lifetimes.test(
  'OpenCode-only vault setup never compares an unselected Pi connection file',
  async () => {
    const f = await callbackFixture({
      opencode: true,
      pi: false,
      claustrum: true,
    })
    f.env.PI_ANTHROPIC_AUTH_CLAUSTRUM_CONNECTION_FILE = join(
      f.env.HOME!,
      'unselected-pi-connection',
    )
    const connections: string[] = []
    expect(
      await runSetupCommand(['--yes', '--claustrum', '--opencode=both'], {
        ...f.io,
        env: { ...f.io.env, ...f.env },
        connect: async (input) => {
          connections.push(input.connectionFile!)
          return f.io.connect!(input)
        },
        vaultActivate: (host, options, preflight) =>
          completeNativeVaultActivation(
            host,
            {
              ...options,
              discover: async () => verifiedSetupInventory(),
            },
            preflight,
          ),
      }),
    ).toBe(0)
    expect(connections).toEqual(
      Array(2).fill(f.env.OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_CONNECTION_FILE),
    )
    expect(await readNativeEnrollmentMode('opencode', f.env)).toBe('claustrum')
    expect(await readNativeEnrollmentMode('pi', f.env)).toBe('local')
  },
)

lifetimes.test(
  'OpenCode both refuses a canonical Pi alias in first beforeSignIn before either owner writes',
  async () => {
    const f = await callbackFixture({
      opencode: true,
      pi: true,
      claustrum: false,
    })
    const alias = join(f.env.HOME!, 'pi-alias')
    await mkdir(dirname(f.plan.legacyConfigPath), { recursive: true })
    await fsPromises.symlink(dirname(f.plan.legacyConfigPath), alias, 'dir')
    f.env.PI_ANTHROPIC_AUTH_FILE = join(
      alias,
      basename(f.plan.legacyConfigPath),
    )
    const pi = await resolveNativeSetupPaths('pi', f.env)
    const before = await settleSetupSiblings([
      setupBytes(f.plan),
      setupBytes(pi),
    ])
    let exchanges = 0
    const registrations: Array<readonly string[]> = []
    expect(
      await runSetupCommand(['--yes', '--login', '--opencode=both'], {
        ...f.io,
        env: { ...f.io.env, ...f.env },
        localLogin: async () => {
          exchanges++
          throw new Error('Must not exchange before alias validation')
        },
        runner: {
          run: async (_file, args) => {
            if (!args.includes('--version')) registrations.push(args)
            return { exitCode: 0, stdout: '1.0.0', stderr: '' }
          },
        },
      }),
    ).toBe(1)
    expect(exchanges).toBe(0)
    expect(registrations).toEqual([])
    expect(
      await settleSetupSiblings([setupBytes(f.plan), setupBytes(pi)]),
    ).toEqual(before)
    expect(
      existsSync(join(dirname(f.plan.legacyConfigPath), 'opencode.jsonc')),
    ).toBe(false)
  },
)

describe('setup CLI boundary', () => {
  lifetimes.test(
    'consumes Pi consent, normalizes -y and forwards every other argument unchanged',
    async () => {
      const f = await callbackFixture()
      const calls = observeSetupArguments()
      const argv = [
        '--remove-pi-auth',
        '-y',
        '--dry-run',
        '--no-claustrum',
        '--opencode=both',
        '--login',
        '--yes',
        '--unknown=kept',
        '--remove-pi-auth',
      ]
      const before = [...argv]
      expect(await runSetupCommand(argv, f.io)).toBe(1)
      expect(argv).toEqual(before)
      expect(calls).toEqual([
        [
          '--yes',
          '--dry-run',
          '--no-claustrum',
          '--opencode=both',
          '--login',
          '--yes',
          '--unknown=kept',
        ],
      ])
      expect(f.screen()).toBe(
        "Unknown setup argument: --unknown=kept. Run the plugin's own setup --help to list the flags setup accepts.\n",
      )
      await expectNoDiagnostics(f)
    },
  )

  for (const flag of ['--help', '-h']) {
    lifetimes.test(
      `setup ${flag} prints the shared flag list and this command's own flags, then exits 0`,
      async () => {
        const f = await callbackFixture()
        const calls = observeSetupArguments()
        const before = await setupBytes(f.plan)
        expect(await runSetupCommand([flag], f.io)).toBe(0)
        expect(calls).toEqual([])
        const screen = f.screen()
        // The shared parser's own help text comes first, verbatim.
        expect(
          screen.startsWith(
            `${commonAuthSetup.setupUsage({ command: 'npx @cortexkit/opencode-anthropic-auth setup' })}\n`,
          ),
        ).toBe(true)
        // Every flag the shared parser accepts, named independently of its
        // help text so a help that dropped one would fail here.
        for (const shared of [
          /^ {2}--yes {2,}\S/m,
          /^ {2}--dry-run {2,}\S/m,
          /^ {2}--host opencode\|pi {2,}\S/m,
          /^ {2}--opencode=1\|2\|both {2,}\S/m,
          /^ {2}--claustrum {2,}\S/m,
          /^ {2}--no-claustrum {2,}\S/m,
          /^ {2}--login {2,}\S/m,
          /^ {2}--enroll-only {2,}\S/m,
        ])
          expect(screen).toMatch(shared)
        // Then the flags only this command handles.
        expect(screen).toMatch(/^ {2}--remove-pi-auth {2,}\S/m)
        expect(screen).toMatch(/^ {2}-y {2,}Same as --yes\.$/m)
        expect(screen).toMatch(/^ {2}--help, -h {2,}Show this help\.$/m)
        expect(await setupBytes(f.plan)).toEqual(before)
        await expectNoDiagnostics(f)
      },
    )
  }

  for (const argv of [
    ['--yes', '--host', 'pi'],
    ['--yes', '--host=pi'],
  ]) {
    lifetimes.test(
      `${argv.slice(1).join(' ')} selects only Pi in every setup callback`,
      async () => {
        const f = await callbackFixture({
          opencode: true,
          pi: true,
          claustrum: false,
        })
        const seen = observeSetupCallbackHosts()
        expect(await runSetupCommand(argv, f.io)).toBe(0)
        expect(seen.map(({ callback }) => callback)).toContain('beforeSignIn')
        expect(seen.map(({ callback }) => callback)).toContain('migrate')
        for (const call of seen)
          expect(call).toEqual({
            callback: call.callback,
            host: 'pi',
            hosts: ['pi'],
          })
        await expectNoDiagnostics(f)
      },
    )
  }

  for (const dry of [false, true]) {
    for (const choice of ['--claustrum', '--opencode=2']) {
      lifetimes.test(
        `argument-level --login ${choice} refuses before runSetup (${dry ? 'dry' : 'real'})`,
        async () => {
          const f = await callbackFixture()
          const calls = observeSetupArguments()
          const before = await setupBytes(f.plan)
          expect(
            await runSetupCommand(
              ['--yes', '--login', choice, ...(dry ? ['--dry-run'] : [])],
              f.io,
            ),
          ).toBe(1)
          expect(calls).toEqual([])
          expect(f.screen()).toBe(
            `${choice === '--claustrum' ? 'Local sign-in and vault setup are two separate choices. Use --login or --claustrum, not both.' : CLAUDE_POOL_LOGIN_STEP}\n`,
          )
          expect(await setupBytes(f.plan)).toEqual(before)
          await expectNoDiagnostics(f)
        },
      )
    }
  }

  for (const dry of [false, true]) {
    lifetimes.test(
      `detected generation 2 --login ${dry ? 'previews without the pool step' : 'refuses with the pool step once'}`,
      async () => {
        const f = await callbackFixture()
        await writeSetupJson(join(f.env.HOME!, 'fixture-bin', 'package.json'), {
          name: '@opencode/cli',
          version: '2.0.21',
        })
        const before = await setupBytes(f.plan)
        let exchanges = 0
        expect(
          await runSetupCommand(
            ['--yes', '--login', ...(dry ? ['--dry-run'] : [])],
            {
              ...f.io,
              runner: createMockRunner({
                opencode: () => ({
                  exitCode: 0,
                  stdout: '2.0.21\n',
                  stderr: '',
                }),
              }),
              localLogin: async () => {
                exchanges++
                throw new Error('Must not exchange')
              },
            },
          ),
        ).toBe(dry ? 0 : 1)
        expect(exchanges).toBe(0)
        expect(await setupBytes(f.plan)).toEqual(before)
        expect(f.screen().split(CLAUDE_POOL_LOGIN_STEP).length - 1).toBe(
          dry ? 0 : 1,
        )
        if (dry)
          expect(f.screen()).toContain('Would sign in locally for opencode.\n')
        else
          expect(f.screen().endsWith(`${CLAUDE_POOL_LOGIN_STEP}\n`)).toBe(true)
        await expectNoDiagnostics(f)
      },
    )
  }

  for (const [label, argv, message] of [
    [
      'unknown argument',
      ['--yes', '--unknown'],
      "Unknown setup argument: --unknown. Run the plugin's own setup --help to list the flags setup accepts.",
    ],
    [
      'conflicting vault flags',
      ['--yes', '--claustrum', '--no-claustrum'],
      '--claustrum and --no-claustrum cannot be used together.',
    ],
    ['noninteractive without --yes', [], 'Setup requires a TTY or --yes.'],
    [
      'unavailable Claustrum',
      ['--yes', '--claustrum'],
      'Claustrum is not available. Start ck, or omit vault-only flags and use --no-claustrum for local sign-in.',
    ],
  ] as const) {
    lifetimes.test(
      `runner plain error: ${label} prints once and exits 1`,
      async () => {
        const f = await callbackFixture()
        const before = await setupBytes(f.plan)
        expect(await runSetupCommand([...argv], f.io)).toBe(1)
        expect(f.screen().split(message).length - 1).toBe(1)
        expect(f.screen().endsWith(`${message}\n`)).toBe(true)
        expect(await setupBytes(f.plan)).toEqual(before)
        await expectNoDiagnostics(f)
      },
    )
  }

  lifetimes.test(
    'a callback SetupRefusal prints exactly once without diagnostics',
    async () => {
      const f = await callbackFixture()
      const message = 'Fixture setup was refused safely.'
      expect(
        await runSetupCommand(['--yes', '--opencode=1'], {
          ...f.io,
          migrateLocal: async () => {
            throw new SetupRefusal(message)
          },
        }),
      ).toBe(1)
      expect(f.screen().split(message).length - 1).toBe(1)
      expect(f.screen().endsWith(`${message}\n`)).toBe(true)
      await expectNoDiagnostics(f)
    },
  )

  lifetimes.test(
    'a migrate error hides its unique path and stack from the terminal',
    async () => {
      const f = await callbackFixture()
      const path = join(f.env.HOME!, 'private-migration-source.json')
      const stack = 'at uniqueMigrationStackFrame (private-module.ts:123:4)'
      const error = new Error(`Cannot migrate ${path}`)
      error.stack = `${error.message}\n${stack}`
      expect(
        await runSetupCommand(['--yes', '--opencode=1'], {
          ...f.io,
          migrateLocal: async () => {
            throw error
          },
        }),
      ).toBe(1)
      const record = await screenDiagnostic(
        f,
        'Setup failed (cli-setup/unexpected-error).',
      )
      expect(record.text).toContain(path)
      expect(record.text).toContain(stack)
      expect(f.screen()).not.toContain(path)
      expect(f.screen()).not.toContain(stack)
      expect(f.screen()).not.toContain('Cannot migrate')
      expect(
        f.screen().split('Setup failed (cli-setup/unexpected-error).').length -
          1,
      ).toBe(1)
    },
  )

  lifetimes.test(
    'all-absent native sources with --yes --opencode=2 publish empty-init',
    async () => {
      const f = await callbackFixture()
      expect(
        (await setupBytes(f.plan)).every(([, bytes]) => bytes === null),
      ).toBe(true)
      expect(await runSetupCommand(['--yes', '--opencode=2'], f.io)).toBe(0)
      expect(await readNativeMigrationJournal(f.plan.paths)).toMatchObject({
        version: 5,
        kind: 'empty-init',
        phase: 'committed',
        host: 'opencode',
        storageId: f.plan.paths.storageId,
      })
      expect(f.screen().split(CLAUDE_POOL_LOGIN_STEP).length - 1).toBe(1)
      await expect(stat(f.plan.hostAuthPath)).rejects.toThrow()
    },
  )
})

lifetimes.test(
  'ambiguous generation without a TTY prints the runner remedy once',
  async () => {
    const f = await callbackFixture()
    const message =
      'Multiple OpenCode generations found. Choose --opencode=1|2|both before running noninteractive setup.'
    const before = await setupBytes(f.plan)
    expect(await runSetupCommand(['--yes'], ambiguousSetupIO(f.io))).toBe(1)
    expect(f.screen().split(message).length - 1).toBe(1)
    expect(f.screen().endsWith(`${message}\n`)).toBe(true)
    expect(await setupBytes(f.plan)).toEqual(before)
    await expectNoDiagnostics(f)
  },
)

for (const dry of [false, true]) {
  lifetimes.test(
    `interactively chosen generation 2 --login ${dry ? 'previews' : 'refuses once'}`,
    async () => {
      const f = await callbackFixture()
      const before = await setupBytes(f.plan)
      const script: Array<[string, string]> = [
        ['Select hosts to set up', '\x1b[A\r'],
        ['Which OpenCode generation should be registered?', '\x1b[B\r'],
      ]
      const session = scriptedSetupTerminal(f.output, script)
      try {
        expect(
          await runSetupCommand(['--login', ...(dry ? ['--dry-run'] : [])], {
            ...ambiguousSetupIO(f.io),
            terminal: session.terminal,
          }),
        ).toBe(dry ? 0 : 1)
        expect(session.prompts).toEqual(script.map(([prompt]) => prompt))
        expect(session.remaining).toEqual([])
        expect(f.screen().split(CLAUDE_POOL_LOGIN_STEP).length - 1).toBe(
          dry ? 0 : 1,
        )
        if (dry)
          expect(f.screen()).toContain('Would sign in locally for opencode.')
        else
          expect(f.screen().endsWith(`${CLAUDE_POOL_LOGIN_STEP}\n`)).toBe(true)
        expect(await setupBytes(f.plan)).toEqual(before)
        await expectNoDiagnostics(f)
      } finally {
        session.close()
      }
    },
  )
}

for (const mode of ['local', 'claustrum'] as const) {
  lifetimes.test(
    `Pi consent ${mode}: noninteractive refusal and dry-run bypass`,
    async () => {
      for (const dry of [false, true]) {
        const f = await callbackFixture({
          opencode: false,
          pi: true,
          claustrum: mode === 'claustrum',
        })
        const pi = await resolveNativeSetupPaths('pi', f.env)
        await writeSetupJson(pi.hostAuthPath, { anthropic: SETUP_HOST_LOGIN })
        const before = await setupBytes(pi)
        const message =
          mode === 'local'
            ? 'Pi has a stored Anthropic login. Rerun with --remove-pi-auth to move it into the native account pool.'
            : 'Pi has stored Anthropic authentication. Rerun with --remove-pi-auth to preserve it privately during vault use and restore it on disconnect.'
        expect(
          await runSetupCommand(
            [
              '--yes',
              mode === 'local' ? '--no-claustrum' : '--claustrum',
              ...(dry ? ['--dry-run'] : []),
            ],
            f.io,
          ),
        ).toBe(dry ? 0 : 1)
        expect(f.screen().split(message).length - 1).toBe(dry ? 0 : 1)
        if (dry)
          expect(f.screen()).toContain(
            'Dry run: no registrations, enrollment, sign-in or migration will be performed.',
          )
        else expect(f.screen().endsWith(`${message}\n`)).toBe(true)
        expect(await setupBytes(pi)).toEqual(before)
        await expectNoDiagnostics(f)
      }
    },
  )
}

for (const answer of ['yes', 'no'] as const) {
  lifetimes.test(
    `interactive Pi consent asks on the injected terminal and honors ${answer}`,
    async () => {
      const f = await callbackFixture({
        opencode: false,
        pi: true,
        claustrum: false,
      })
      const pi = await resolveNativeSetupPaths('pi', f.env)
      await writeSetupJson(pi.hostAuthPath, { anthropic: SETUP_HOST_LOGIN })
      const before = await setupBytes(pi)
      const script: Array<[string, string]> = [
        ['Select hosts to set up', '\x1b[A\r'],
        [
          'Move the Pi Anthropic OAuth login into the native account pool and remove its stored copy?',
          answer === 'yes' ? '\x1b[B\r' : '\r',
        ],
      ]
      const session = scriptedSetupTerminal(f.output, script)
      const migrations: boolean[] = []
      try {
        expect(
          await runSetupCommand(['--no-claustrum'], {
            ...f.io,
            terminal: session.terminal,
            migrateLocal: async (host, options) => {
              expect(host).toBe('pi')
              migrations.push(options.removePiAnthropicAuth ?? false)
            },
          }),
        ).toBe(answer === 'yes' ? 0 : 1)
        expect(session.prompts).toEqual(script.map(([prompt]) => prompt))
        expect(session.remaining).toEqual([])
        expect(migrations).toEqual(answer === 'yes' ? [true] : [])
        if (answer === 'no')
          expect(f.screen()).toContain(
            'Native account-pool setup cannot finish while the stored Pi OAuth token takes precedence.',
          )
        expect(await setupBytes(pi)).toEqual(before)
        await expectNoDiagnostics(f)
      } finally {
        session.close()
      }
    },
  )
}

for (const name of ['native-migration', 'migration-journal']) {
  lifetimes.test(
    `empty-init held ${name} lease exits 1 without leaking its path or stack`,
    async () => {
      const f = await callbackFixture()
      const before = await setupBytes(f.plan)
      const original = core.publishNativeEmptyInit
      let caught: unknown
      const spy = spyOn(core, 'publishNativeEmptyInit').mockImplementation(
        async (input) => {
          try {
            return await original(input, {
              lockOptions: { ttlMs: 30_000, timeoutMs: 30 },
            })
          } catch (error) {
            caught = error
            throw error
          }
        },
      )
      lifetimes.deferCleanup(() => spy.mockRestore())
      const ready = lifetimes.gate()
      const release = lifetimes.gate()
      const holder = withLock(
        f.plan.paths.journal,
        { name, ttlMs: 30_000, timeoutMs: 100, renew: true },
        async () => {
          ready.open()
          await release.wait
        },
      )
      lifetimes.trackDetached(holder)
      try {
        await ready.wait
        expect(await runSetupCommand(['--yes', '--opencode=2'], f.io)).toBe(1)
        expect(spy).toHaveBeenCalledTimes(1)
        expect(caught).toMatchObject({
          name: 'LockContentionError',
          details: { target: f.plan.paths.journal, name, timeoutMs: 30 },
        })
        expect(await setupBytes(f.plan)).toEqual(before)
        expect(f.screen()).not.toContain(f.plan.paths.journal)
        expect(f.screen()).not.toContain('LockContentionError')
        expect(f.screen()).not.toMatch(/\n\s+at /)
        await screenDiagnostic(f, 'Setup failed (cli-setup/unexpected-error).')
      } finally {
        release.open()
        await Promise.allSettled([holder])
      }
    },
  )
}

for (const key of [
  'config',
  'state',
  'runtime',
  'roster',
  'routing',
] as const) {
  lifetimes.test(
    `empty-init occupied ${key} destination exits 1 without stack or source path text`,
    async () => {
      const f = await callbackFixture()
      const path =
        key === 'routing' ? f.plan.routingDestinationPath : f.plan.paths[key]
      await writeSetupJson(path, { occupied: true })
      const before = await setupBytes(f.plan)
      expect(await runSetupCommand(['--yes', '--opencode=2'], f.io)).toBe(1)
      expect(await setupBytes(f.plan)).toEqual(before)
      expect(f.screen()).not.toContain(path)
      expect(f.screen()).not.toContain('NativeMigrationError')
      expect(f.screen()).not.toMatch(/\n\s+at /)
      expect(f.screen().endsWith('Native migration: invalid-source\n')).toBe(
        true,
      )
      await expectNoDiagnostics(f)
    },
  )
}

for (const [key, value] of [
  ['storageId', '0'.repeat(64)],
  ['kind', 'legacy-import'],
  ['host', 'pi'],
  ['phase', 'building'],
  ['extra', true],
] as const) {
  lifetimes.test(
    `empty-init conflicting journal ${key} exits 1 without stack or source path text`,
    async () => {
      const f = await callbackFixture()
      const journal = await core.publishNativeEmptyInit({
        paths: f.plan.paths,
        routingDestinationPath: f.plan.routingDestinationPath,
        env: f.env,
        processFence: async () => {},
      })
      await writeSetupJson(f.plan.paths.journal, { ...journal, [key]: value })
      const before = await setupBytes(f.plan)
      expect(await runSetupCommand(['--yes', '--opencode=2'], f.io)).toBe(1)
      expect(await setupBytes(f.plan)).toEqual(before)
      expect(f.screen()).not.toContain(f.plan.paths.journal)
      expect(f.screen()).not.toContain('NativeAuthorityError')
      expect(f.screen()).not.toMatch(/\n\s+at /)
      const message = 'Anthropic account migration journal is invalid'
      expect(f.screen().split(message).length - 1).toBe(1)
      expect(f.screen().endsWith(`${message}\n`)).toBe(true)
      await expectNoDiagnostics(f)
    },
  )
}

for (const fault of [
  'ownership-lost',
  'destination-race',
  'unsafe-source',
  'enrollment-flip',
] as const) {
  lifetimes.test(
    `empty-init ${fault} before rename exits 1 without leaking paths or stack`,
    async () => {
      const f = await callbackFixture()
      const before = await setupBytes(f.plan)
      const original = core.publishNativeEmptyInit
      let injected = false
      let caught: unknown
      let restoreStat: (() => void) | undefined
      const spy = spyOn(core, 'publishNativeEmptyInit').mockImplementation(
        async (input) => {
          try {
            return await original(input, {
              onStep: async (step) => {
                if (step !== 'before-write:journal:committed') return
                injected = true
                if (fault === 'ownership-lost') {
                  const path = lockPathFor(
                    f.plan.paths.journal,
                    'native-migration',
                  )
                  const lease = JSON.parse(await readFile(path, 'utf8'))
                  await writeSetupJson(path, {
                    ...lease,
                    ownerId: 'other-owner',
                  })
                } else if (fault === 'destination-race') {
                  await writeSetupJson(f.plan.paths.runtime, { external: true })
                } else if (fault === 'unsafe-source') {
                  const originalStat = fsPromises.lstat
                  const statSpy = spyOn(fsPromises, 'lstat').mockImplementation(
                    new Proxy(originalStat, {
                      apply(target, receiver, args) {
                        if (String(args[0]) === f.plan.paths.runtime)
                          return Promise.reject(
                            Object.assign(
                              new Error('Private destination is unreadable'),
                              { code: 'EACCES' },
                            ),
                          )
                        return Reflect.apply(target, receiver, args)
                      },
                    }),
                  )
                  restoreStat = () => statSpy.mockRestore()
                } else {
                  await writeSetupJson(
                    getHostClaustrumEnrollmentPaths('opencode', f.env)
                      .tokenPath,
                    { token: 'c'.repeat(64), token_generation: 1 },
                  )
                }
              },
            })
          } catch (error) {
            caught = error
            throw error
          }
        },
      )
      lifetimes.deferCleanup(() => spy.mockRestore())
      try {
        expect(await runSetupCommand(['--yes', '--opencode=2'], f.io)).toBe(1)
      } finally {
        restoreStat?.()
      }
      expect(injected).toBe(true)
      expect(spy).toHaveBeenCalledTimes(1)
      if (fault === 'enrollment-flip') {
        const message =
          'OpenCode is still connected to the vault. Old local settings do not disconnect it. In OpenCode, run /claude → Accounts → Disconnect from the vault. Then run local setup again.'
        expect(f.screen().split(message).length - 1).toBe(1)
        expect(f.screen().endsWith(`${message}\n`)).toBe(true)
        await expectNoDiagnostics(f)
      } else {
        expect(caught).toMatchObject({
          code: fault === 'destination-race' ? 'invalid-source' : fault,
        })
        const message = `Native migration: ${fault === 'destination-race' ? 'invalid-source' : fault}`
        expect(f.screen().split(message).length - 1).toBe(1)
        expect(f.screen().endsWith(`${message}\n`)).toBe(true)
        await expectNoDiagnostics(f)
      }
      const expected = before.map(([path, bytes]) => [
        path,
        fault === 'destination-race' && path === f.plan.paths.runtime
          ? JSON.stringify({ external: true })
          : bytes,
      ])
      expect(await setupBytes(f.plan)).toEqual(expected)
      for (const path of [f.plan.paths.journal, f.plan.paths.runtime])
        expect(f.screen()).not.toContain(path)
      expect(f.screen()).not.toMatch(/\n\s+at /)
      expect(f.screen()).not.toContain('NativeMigrationError')
      if (process.platform !== 'win32')
        expect(
          (await readdir(dirname(f.plan.paths.journal))).filter((name) =>
            name.endsWith('.tmp'),
          ),
        ).toEqual([])
    },
  )
}
