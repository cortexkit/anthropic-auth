import { Database } from 'bun:sqlite'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { Readable } from 'node:stream'
import { pathToFileURL } from 'node:url'
import {
  ACCOUNT_STATE_FILE_NAME,
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
  fixturePolicy,
  replacementFixtureToken,
} from './refusal-fixture-policy'
import {
  type Env,
  type HostFixture,
  type HostSession,
  mustRun,
  readFixtureDumps,
  repo,
  requireHostEnv,
  run,
} from './refusal-hosts'
import { newerPrimaryControl } from './refusal-newer-primary'

const oc2Token = 'sk-ant-oat01-oc2-fixture-only'
const oc2Identity =
  '11111111-2222-4333-8444-555555555555' as ProviderAccountUuid

async function writeClientSettings(directory: string, fixture: HostFixture) {
  const path = join(directory, 'anthropic-auth-settings.jsonc')
  await writeFile(
    path,
    JSON.stringify({
      refusal_fallback: fixture.mode ?? 'client',
      quota_enabled: 'off',
      refresh_enabled: false,
      ...(fixture.dump && { dump_enabled: true }),
      ...(fixture.hybridCache && {
        claude_cache_enabled: 'on',
        claude_cache_mode: 'hybrid',
        cache_keep_enabled: true,
        cache_keep_always: true,
      }),
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
  env.OPENCODE_ANTHROPIC_AUTH_DUMP_DIR = join(directory, 'dumps')
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
  env.ANTHROPIC_AUTH_SETTINGS_FILE = await writeClientSettings(
    configDir,
    fixture,
  )
  const model = fixture.model ?? fixtureSource
  const paths = await seedOc2(env, configDir)
  const policy = fixturePolicy(
    paths,
    'opencode',
    env.ANTHROPIC_AUTH_SETTINGS_FILE,
  )
  if (fixture.relay) await policy.relay(fixture.relay)
  const newer = fixture.overlap ? newerPrimaryControl(directory) : undefined
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
${newer?.source ?? ''}
 globalThis[Symbol.for('cortexkit.anthropic-auth.test-oauth-loopback-origin')] = ${JSON.stringify(origin)};
 globalThis[Symbol.for('cortexkit.anthropic-auth.test-only.relay-account-home')] = 'unchecked';
 export default { ...native, async setup(ctx) {
   ${
     newer
       ? `
   let onResponse;
   const original = ctx.session.hook.bind(ctx.session);
   const wrapped = { ...ctx, session: { ...ctx.session, hook(name, handler, options) {
     if (name === 'http.response') onResponse = handler;
     if (name === 'http.request') {
       return original(name, async draft => {
         if (draft.kind === 'primary') {
           const request = draft.request.clone();
           const scope = { ...draft };
           sendNewer = async (text, edit) => {
             const body = await request.json();
             body.messages = editHistory(body.messages, edit);
             body.messages.push({ role: 'user', content: text });
             const headers = new Headers(request.headers);
             headers.delete('content-length');
             const next = { ...scope, request: new Request(request.url, {
               method: request.method, headers, body: JSON.stringify(body),
             }) };
             await handler(next);
             next.response = await fetch(next.request);
             await onResponse(next);
             return { status: next.response.status, stream: await next.response.text() };
           };
         }
         return handler(draft);
       }, options);
     }
     return original(name, handler, options);
   } } };
   `
       : ''
   }
   const cleanup = await setupAnthropicAuth(${newer ? 'wrapped' : 'ctx'}, {
    paths: ${JSON.stringify(paths)},
    local: {
      refreshToken: async () => { throw new Error('Unexpected fixture refresh'); },
      resolveIdentity: async token => {
         if (!${JSON.stringify([oc2Token, replacementFixtureToken])}.includes(token)) throw new Error('Unexpected fixture token');
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
      compaction: { auto: false },
      providers: {
        anthropic: {
          settings: {
            apiKey: placeholderSecret('anthropic'),
            baseURL: `${origin}/v1`,
            ...(shortTimeout && { chunkTimeout: toolChunkTimeoutMs }),
          },
          models: {
            [model]: {
              name: model,
              limit: { context: 2_000_000, output: 4096 },
            },
          },
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
  const locked = [
    'python3',
    fence,
    [port, hostPort, fixture.relay?.port].filter(Boolean).join(','),
    executable,
  ]
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
    const readDiagnostics = () =>
      readFile(
        requireHostEnv(env, 'OPENCODE_ANTHROPIC_AUTH_LOG_FILE'),
        'utf8',
      ).catch(() => '')
    return {
      readDiagnostics,
      readDumps: () =>
        readFixtureDumps(
          requireHostEnv(env, 'OPENCODE_ANTHROPIC_AUTH_DUMP_DIR'),
        ),
      newerPrimary: newer?.send,
      policy,
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
            `anthropic/${model}`,
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
            diagnostics: await readDiagnostics(),
          }
        } finally {
          db.close()
        }
      },
      async editReply(from, to) {
        if (!id) throw new Error('OpenCode 2 fixture has no session yet')
        const db = new Database(requireHostEnv(env, 'OPENCODE_DB'))
        try {
          const latest = db
            .query<{ seq: number; data: string }, [string]>(
              `SELECT seq, data FROM session_message WHERE session_id = ? AND type = 'assistant' ORDER BY seq DESC LIMIT 1`,
            )
            .get(id)
          if (!latest) throw new Error('Fixture reply not found in OpenCode 2')
          const data = JSON.parse(latest.data) as {
            content: { type: string; text?: string }[]
          }
          const part = data.content.find(
            ({ type, text }) => type === 'text' && text === from,
          )
          if (!part)
            throw new Error('Fixture reply part not found in OpenCode 2')
          part.text = to
          db.run(
            'UPDATE session_message SET data = ? WHERE session_id = ? AND seq = ?',
            [JSON.stringify(data), id, latest.seq],
          )
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
  const edit = join(directory, 'edit-context.json')
  const newer = fixture.overlap ? newerPrimaryControl(directory) : undefined
  const extension = join(repo, 'packages/pi/dist/index.js')
  await mkdir(agent)
  await mkdir(project)
  const env = {
    ...fixture.env,
    ANTHROPIC_AUTH_SETTINGS_FILE: await writeClientSettings(agent, fixture),
    PI_CODING_AGENT_DIR: agent,
    PI_ANTHROPIC_AUTH_FILE: join(agent, 'anthropic-auth.json'),
    PI_OFFLINE: '1',
    PI_SKIP_VERSION_CHECK: '1',
    PI_TELEMETRY: '0',
    ANTHROPIC_API_KEY: 'pi-local-mock-key',
    OPENCODE_ANTHROPIC_AUTH_DUMP_DIR: join(directory, 'dumps'),
  }
  // The real OAuth transport still validates the official destination. Route
  // only the synthetic credential's message sends to the local test server.
  await writeFile(
    bridge,
    `${
      newer
        ? `${newer.source}
import auth from ${JSON.stringify(pathToFileURL(extension).href)};
`
        : "import { existsSync, readFileSync, unlinkSync } from 'node:fs';"
    }
 export default async function (pi) {
   globalThis[Symbol.for('cortexkit.anthropic-auth.test-only.relay-account-home')] = 'unchecked';
   const file = ${JSON.stringify(edit)};
   pi.on('context', (event) => {
     if (!existsSync(file)) return;
     const [from, to] = JSON.parse(readFileSync(file, 'utf8'));
     unlinkSync(file);
     const last = event.messages.findLast(message => message.role === 'assistant');
     const part = last?.content.find(part => part.type === 'text' && part.text === from);
     if (!part) throw new Error('Fixture reply part not found in Pi');
     part.text = to;
     return { messages: event.messages };
   });
  const send = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const mock = ${JSON.stringify(origin)};
    const headers = new Headers(input instanceof Request ? input.headers : init?.headers);
    ${fixture.relay ? `if (url.origin === ${JSON.stringify(fixture.relay.url)} && url.pathname === '/' && headers.get('x-relay-token') === ${JSON.stringify(fixture.relay.token)}) return send(input, init);` : ''}
    const official = url.origin === 'https://api.anthropic.com' && url.pathname === '/v1/messages';
    const auth = headers.get('authorization');
    if (!official || !${JSON.stringify(['Bearer sk-ant-oat01-pi-host-fixture-access', `Bearer ${replacementFixtureToken}`])}.includes(auth))
      throw new Error('Unexpected non-fixture Pi fetch: ' + url.href);
    return send(new URL(url.pathname + url.search, mock), init);
  };
  ${
    newer
      ? `await auth(new Proxy(pi, { get(target, key) {
    if (key !== 'registerProvider') return target[key];
    return (provider) => target.registerProvider({ ...provider, streamSimple(model, context, options, origin) {
      if (options?.sessionId && origin !== 'direct') {
        sendNewer = async (text, edit) => {
          const history = editHistory(context.messages, edit);
          const messages = [...history, { role: 'user', content: [{ type: 'text', text }], timestamp: Date.now() }];
          const events = [];
          for await (const event of provider.streamSimple(model, { ...context, messages }, options, 'agent-loop')) events.push(event);
          return events;
        };
      }
      return provider.streamSimple(model, context, options, origin);
    } });
  } }));`
      : ''
  }
}
`,
  )
  const locked = [
    'python3',
    fence,
    [port, fixture.relay?.port].filter(Boolean).join(','),
  ]
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
  const paths = await resolveNativePoolPaths(
    env.PI_ANTHROPIC_AUTH_FILE,
    join(agent, ACCOUNT_STATE_FILE_NAME),
  )
  const policy = fixturePolicy(paths, 'pi', env.ANTHROPIC_AUTH_SETTINGS_FILE)
  if (fixture.relay) await policy.relay(fixture.relay)
  const args = (mode: 'json' | 'rpc') => [
    ...locked,
    executable,
    ...(mode === 'json' ? ['-p'] : []),
    '--mode',
    mode,
    '--session',
    session,
    '--no-extensions',
    '--no-skills',
    '--no-prompt-templates',
    '--no-context-files',
    '--no-approve',
    '-e',
    bridge,
    ...(newer ? [] : ['-e', extension]),
    '--provider',
    'anthropic',
    '--model',
    fixture.model ?? fixtureSource,
    '--api-key',
    env.ANTHROPIC_API_KEY,
    '--tools',
    'bash',
    '--system-prompt',
    'You are the refusal fixture agent.',
  ]
  const readDiagnostics = () =>
    readFile(
      requireHostEnv(env, 'OPENCODE_ANTHROPIC_AUTH_LOG_FILE'),
      'utf8',
    ).catch(() => '')
  const readOutcome = async (raw: unknown) => {
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
      diagnostics: await readDiagnostics(),
    }
  }
  if (!fixture.persistent)
    return {
      policy,
      readDiagnostics,
      async prompt(text) {
        return readOutcome(
          await run([...args('json'), text], project, env, 55_000),
        )
      },
      close: async () => {},
    }

  function spawnRpc() {
    const child = Bun.spawn({
      cmd: args('rpc'),
      cwd: project,
      env,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const stderr = new Response(child.stderr).text()
    const output = createInterface({ input: Readable.fromWeb(child.stdout) })
    const lines = output[Symbol.asyncIterator]()
    const close = async () => {
      child.stdin.end()
      const force = setTimeout(() => child.kill('SIGKILL'), 5_000)
      try {
        await child.exited
      } finally {
        clearTimeout(force)
        output.close()
      }
    }
    return {
      async prompt(message: string) {
        await child.stdin.write(
          `${JSON.stringify({ type: 'prompt', message })}\n`,
        )
        await child.stdin.flush()
        const events: unknown[] = []
        while (true) {
          const line = await lines.next()
          if (line.done) throw new Error(`Pi RPC exited: ${await stderr}`)
          const event = JSON.parse(line.value)
          events.push(event)
          if (event.type === 'response' && !event.success)
            throw new Error(`Pi RPC command failed: ${JSON.stringify(event)}`)
          if (event.type === 'agent_end') return readOutcome(events)
        }
      },
      close,
    }
  }
  let rpc = spawnRpc()
  return {
    policy,
    readDiagnostics,
    readDumps: () => readFixtureDumps(env.OPENCODE_ANTHROPIC_AUTH_DUMP_DIR),
    newerPrimary: newer?.send,
    async editReply(from, to) {
      await writeFile(edit, JSON.stringify([from, to]))
    },
    prompt: (text) => rpc.prompt(text),
    close: () => rpc.close(),
    async restart() {
      await rpc.close()
      rpc = spawnRpc()
    },
  }
}
