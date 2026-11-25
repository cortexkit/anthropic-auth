import { Database } from 'bun:sqlite'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  createNativeAccountRuntime,
  getStickyRoutingStatePath,
  type ProviderAccountUuid,
  resolveNativePoolPaths,
  runNativeMigration,
} from '@cortexkit/anthropic-auth-core'
import {
  placeholderCredential,
  placeholderSecret,
} from '@cortexkit/common-auth/opencode2'
import { fixtureSource, toolChunkTimeoutMs } from './mock-refusal'
import {
  type Env,
  type HostFixture,
  type HostSession,
  mustRun,
  repo,
  requireHostEnv,
  run,
} from './refusal-hosts'

const oc2Token = 'sk-ant-oat01-oc2-fixture-only'
const oc2Identity =
  '11111111-2222-4333-8444-555555555555' as ProviderAccountUuid

async function writeClientSettings(directory: string) {
  const path = join(directory, 'anthropic-auth-settings.jsonc')
  await writeFile(
    path,
    JSON.stringify({
      refusal_fallback: 'client',
      quota_enabled: 'off',
      refresh_enabled: false,
    }),
  )
  return path
}

async function seedOc2(env: Env, configDir: string) {
  const config = join(configDir, 'anthropic-auth.json')
  const state = join(configDir, 'anthropic-auth-state.json')
  const paths = await resolveNativePoolPaths(config, state)
  await writeFile(config, '{"version":1,"accounts":[]}')
  await writeFile(state, '{"version":1,"accounts":{}}')
  await runNativeMigration({
    paths,
    host: 'opencode',
    hostAuthPath: join(
      requireHostEnv(env, 'XDG_DATA_HOME'),
      'opencode/auth.json',
    ),
    legacyConfigPath: config,
    legacyStatePath: state,
    routingSourcePath: getStickyRoutingStatePath(config),
    routingDestinationPath: getStickyRoutingStatePath(paths.config),
    env,
    // The test exclusively owns these directories and has not started the host.
    processFence: async () => {},
    removePiAnthropicAuth: false,
  })
  const runtime = createNativeAccountRuntime({
    paths,
    host: 'opencode',
    local: {
      refreshToken: async () => {
        throw new Error('Unexpected credential refresh')
      },
      resolveIdentity: async () => ({
        accountUuid: oc2Identity,
        deviceId: 'fixture',
        sessionId: 'fixture',
      }),
    },
  })
  try {
    await runtime.loginOAuth({
      routeId: 'main',
      accountIdentity: oc2Identity,
      replace: true,
      credential: {
        access: oc2Token,
        refresh: 'fixture-refresh',
        expires: Date.now() + 3600_000,
      },
    })
    const admission = await runtime.authorizeLocal('main', { intent: 'serve' })
    if (admission.status !== 'usable')
      throw new Error(`Fixture admission ${admission.status}`)
  } finally {
    runtime.close()
  }
  return paths
}

export async function startOc2(fixture: HostFixture): Promise<HostSession> {
  const { executable, fence, directory, origin, port, shortTimeout } = fixture
  const env: Env = { ...fixture.env }
  const configDir = join(requireHostEnv(env, 'XDG_CONFIG_HOME'), 'opencode')
  const project = join(directory, 'project')
  const plugin = join(project, 'fixture-plugin')
  const methodID = 'fixture-placeholder'
  const placeholder = placeholderCredential({
    integrationID: 'anthropic',
    methodID,
    now: Date.now(),
  })
  await mkdir(configDir, { recursive: true })
  await mkdir(plugin, { recursive: true })
  await mustRun(['git', 'init', '-q'], project, env)
  env.ANTHROPIC_AUTH_SETTINGS_FILE = await writeClientSettings(configDir)
  const paths = await seedOc2(env, configDir)
  const native = pathToFileURL(
    join(repo, 'packages/opencode/dist/v2/server.js'),
  ).href
  await writeFile(
    join(plugin, 'package.json'),
    JSON.stringify({
      name: 'refusal-fixture-plugin',
      version: '0.0.0',
      type: 'module',
      exports: { './server': './server.js' },
    }),
  )
  await writeFile(
    join(plugin, 'server.js'),
    `import native, { setupAnthropicAuth } from ${JSON.stringify(native)};
globalThis[Symbol.for('cortexkit.anthropic-auth.test-oauth-loopback-origin')] = ${JSON.stringify(origin)};
export default { ...native, async setup(ctx) {
  const cleanup = await setupAnthropicAuth(ctx, {
    paths: ${JSON.stringify(paths)},
    local: {
      refreshToken: async () => { throw new Error('Unexpected fixture refresh'); },
      resolveIdentity: async token => {
        if (token !== ${JSON.stringify(oc2Token)}) throw new Error('Unexpected fixture token');
        return { accountUuid: ${JSON.stringify(oc2Identity)}, deviceId: 'fixture', sessionId: 'fixture' };
      },
    },
  });
  const activation = await ctx.integration.transform(editor => {
    editor.method.update({
      integrationID: 'anthropic',
      method: { id: ${JSON.stringify(methodID)}, type: 'oauth', label: 'Disposable fixture' },
      authorize: async () => ({ url: '', instructions: 'Synthetic fixture only', mode: 'auto', callback: Promise.resolve(${JSON.stringify(placeholder)}) }),
    });
  });
  return async () => { await activation.dispose(); await cleanup(); };
} };
`,
  )
  await writeFile(
    join(configDir, 'opencode.json'),
    JSON.stringify({
      plugins: [pathToFileURL(plugin).href],
      providers: {
        anthropic: {
          settings: {
            apiKey: placeholderSecret('anthropic'),
            baseURL: `${origin}/v1`,
            ...(shortTimeout && { chunkTimeout: toolChunkTimeoutMs }),
          },
          models: { [fixtureSource]: { name: 'Opus 5.5' } },
        },
      },
    }),
  )
  env.OPENCODE_ANTHROPIC_AUTH_FILE = join(configDir, 'anthropic-auth.json')
  env.ANTHROPIC_BASE_URL = origin
  // Reserve a port to build the CLI and daemon's common network allowlist.
  const reservation = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () => new Response(),
  })
  const hostPort = reservation.port
  await reservation.stop(true)
  const hostUrl = `http://127.0.0.1:${hostPort}`
  const locked = ['python3', fence, `${port},${hostPort}`, executable]
  const server = Bun.spawn({
    cmd: [
      ...locked,
      'serve',
      '--hostname',
      '127.0.0.1',
      '--port',
      String(hostPort),
    ],
    cwd: project,
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const logs = Promise.all([
    new Response(server.stdout).text(),
    new Response(server.stderr).text(),
  ])
  const close = async () => {
    server.kill('SIGKILL')
    await server.exited
  }
  try {
    const deadline = Date.now() + 10_000
    while (true) {
      if (Date.now() >= deadline || server.exitCode !== null)
        throw new Error('OC2 did not become ready')
      const health = await fetch(`${hostUrl}/global/health`, {
        headers: {
          authorization: `Basic ${btoa(`opencode:${env.OPENCODE_SERVER_PASSWORD}`)}`,
        },
        signal: AbortSignal.timeout(300),
      }).catch(() => undefined)
      if (health?.ok) break
      await Bun.sleep(100)
    }
    await mustRun(
      [
        ...locked,
        'auth',
        'login',
        'anthropic',
        '--method',
        methodID,
        '--server',
        hostUrl,
      ],
      project,
      env,
      12_000,
    )
    let id: string | undefined
    return {
      async prompt(text) {
        const raw = await run(
          [
            ...locked,
            'run',
            '--server',
            hostUrl,
            '--auto',
            '--format',
            'json',
            '--model',
            `anthropic/${fixtureSource}`,
            ...(id ? ['--session', id] : ['--title', 'Refusal fixture']),
            text,
          ],
          project,
          env,
          55_000,
        )
        const db = new Database(requireHostEnv(env, 'OPENCODE_DB'), {
          readonly: true,
        })
        try {
          id ??= raw.stdout.match(/"sessionID":"(ses_[^"]+)"/)?.[1]
          if (!id)
            throw new Error(
              `OC2 did not create a session: ${JSON.stringify(raw)}`,
            )
          return {
            raw,
            stored: db
              .query(
                'SELECT type, data FROM session_message WHERE session_id = ? ORDER BY seq',
              )
              .all(id),
            diagnostics: await readFile(
              requireHostEnv(env, 'OPENCODE_ANTHROPIC_AUTH_LOG_FILE'),
              'utf8',
            ).catch(() => ''),
          }
        } finally {
          db.close()
        }
      },
      close,
    }
  } catch (error) {
    await close()
    throw new Error(
      `${String(error)}; OC2 daemon logs: ${(await logs).join('\n')}`,
    )
  }
}

export async function startPi(fixture: HostFixture): Promise<HostSession> {
  const { executable, fence, directory, origin, port } = fixture
  const agent = join(directory, 'agent')
  const project = join(directory, 'project')
  const session = join(directory, 'session.jsonl')
  const bridge = join(directory, 'mock-upstream.mjs')
  await mkdir(agent)
  await mkdir(project)
  const env = {
    ...fixture.env,
    ANTHROPIC_AUTH_SETTINGS_FILE: await writeClientSettings(agent),
    PI_CODING_AGENT_DIR: agent,
    PI_ANTHROPIC_AUTH_FILE: join(agent, 'anthropic-auth.json'),
    PI_OFFLINE: '1',
    PI_SKIP_VERSION_CHECK: '1',
    PI_TELEMETRY: '0',
    ANTHROPIC_API_KEY: 'pi-local-mock-key',
  }
  // The real OAuth transport still validates the official destination. Route
  // only the synthetic credential's message sends to the local test server.
  await writeFile(
    bridge,
    `export default function () {
  const send = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.origin !== 'https://api.anthropic.com' || url.pathname !== '/v1/messages' ||
        new Headers(init?.headers).get('authorization') !== 'Bearer sk-ant-oat01-pi-host-fixture-access')
      throw new Error('Unexpected non-fixture Pi fetch: ' + url.href);
    return send(new URL(url.pathname + url.search, ${JSON.stringify(origin)}), init);
  };
}
`,
  )
  const locked = ['python3', fence, String(port)]
  await mustRun(
    [
      ...locked,
      process.execPath,
      join(repo, 'scripts/check-pi-tool-mapping.ts'),
      '--prepare-native-pool',
    ],
    project,
    env,
  )
  return {
    async prompt(text) {
      const raw = await run(
        [
          ...locked,
          executable,
          '-p',
          '--mode',
          'json',
          '--session',
          session,
          '--no-extensions',
          '--no-skills',
          '--no-prompt-templates',
          '--no-context-files',
          '--no-approve',
          '-e',
          bridge,
          '-e',
          join(repo, 'packages/pi/dist/index.js'),
          '--provider',
          'anthropic',
          '--model',
          fixtureSource,
          '--api-key',
          env.ANTHROPIC_API_KEY,
          '--tools',
          'bash',
          '--system-prompt',
          'You are the refusal fixture agent.',
          text,
        ],
        project,
        env,
        55_000,
      )
      const stored = await readFile(session, 'utf8').catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error
          throw new Error(`Pi did not create a session: ${JSON.stringify(raw)}`)
        },
      )
      return {
        raw,
        stored: stored
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line)),
        diagnostics: '',
      }
    },
    close: async () => {},
  }
}
