import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import {
  isolatedPackedHostEnv,
  packedHostNpmCache,
} from '../../opencode/src/tests/support/packed-host-install'
import { fixtureSource, toolChunkTimeoutMs } from './mock-refusal'
import { spawnOpencode } from './opencode-runner'

export const repo = resolve(import.meta.dir, '../../..')
export const hosts = {
  oc1: { pkg: 'opencode-ai', version: '1.19.6', bin: 'opencode' },
  oc2: { pkg: '@opencode/cli', version: '2.3.2', bin: 'opencode' },
  pi: { pkg: '@earendil-works/pi-coding-agent', version: '1.6.0', bin: 'pi' },
} as const
export type Host = keyof typeof hosts
export type Env = Record<string, string>

export function requireHostEnv(env: Env, key: string) {
  const value = env[key]
  if (!value) throw new Error(`Missing isolated host setting: ${key}`)
  return value
}

export function hostEnv(root: string) {
  return isolatedPackedHostEnv(root, {
    path: process.env.PATH ?? '/usr/bin:/bin',
    password: 'refusal-local-server-only',
    npmCache: packedHostNpmCache(repo),
  })
}

export async function run(
  cmd: string[],
  cwd: string,
  env: Env,
  timeout = 60_000,
) {
  const child = Bun.spawn({
    cmd,
    cwd,
    env,
    stdout: 'pipe',
    stderr: 'pipe',
    timeout,
    killSignal: 'SIGKILL',
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return { stdout, stderr, code }
}

export async function mustRun(
  cmd: string[],
  cwd: string,
  env: Env,
  timeout?: number,
) {
  const result = await run(cmd, cwd, env, timeout)
  if (result.code !== 0)
    throw new Error(`${cmd.join(' ')} failed: ${JSON.stringify(result)}`)
  return result.stdout
}

export async function installHost(host: Host, root: string) {
  const { pkg, version, bin } = hosts[host]
  const dir = join(root, host)
  const env = await hostEnv(dir)
  await writeFile(join(dir, 'package.json'), JSON.stringify({ private: true }))
  await mustRun(
    ['npm', 'install', '--no-audit', '--no-fund', `${pkg}@${version}`],
    dir,
    env,
    120_000,
  )
  const executable = join(dir, 'node_modules/.bin', bin)
  const reported = (await mustRun([executable, '--version'], dir, env))
    .trim()
    .replace(/^opencode v/, '')
  if (reported !== version)
    throw new Error(`Expected ${pkg}@${version}, got ${reported}`)
  let configDependencies: string | undefined
  if (host === 'oc1') {
    configDependencies = join(root, 'oc1-config-deps')
    await mkdir(configDependencies)
    await writeFile(
      join(configDependencies, 'package.json'),
      JSON.stringify({
        private: true,
        dependencies: { '@opencode-ai/plugin': version },
      }),
    )
    await mustRun(
      ['npm', 'install', '--no-audit', '--no-fund', '--ignore-scripts'],
      configDependencies,
      env,
    )
  }
  return { executable, configDependencies }
}

// Allow test traffic only on the mock port and, for OC2's CLI, the daemon port.
// Refuse to start if the kernel cannot enforce the network restriction.
export async function writeNetworkFence(root: string) {
  const file = join(root, 'lock-network.py')
  await writeFile(
    file,
    `import ctypes, os, socket, sys
class Rules(ctypes.Structure):
    _fields_ = [('fs', ctypes.c_uint64), ('net', ctypes.c_uint64)]
class Port(ctypes.Structure):
    _fields_ = [('access', ctypes.c_uint64), ('port', ctypes.c_uint64)]
libc = ctypes.CDLL(None, use_errno=True)
assert os.uname().machine in ('x86_64', 'aarch64')
def checked(result):
    if result < 0:
        raise OSError(ctypes.get_errno(), os.strerror(ctypes.get_errno()))
    return result
rules = checked(libc.syscall(444, ctypes.byref(Rules(0, 2)), 16, 0))
for port in sys.argv[1].split(','):
    checked(libc.syscall(445, rules, 2, ctypes.byref(Port(2, int(port))), 0))
checked(libc.prctl(38, 1, 0, 0, 0))
checked(libc.syscall(446, rules, 0))
os.close(rules)
try:
    socket.create_connection(('127.0.0.1', 443), timeout=1)
except PermissionError:
    pass
else:
    sys.exit('HTTPS was not blocked by the sandbox')
os.execv(sys.argv[2], sys.argv[2:])
`,
  )
  return file
}

export function offlineEnv(env: Env): Env {
  return {
    ...env,
    NODE_USE_ENV_PROXY: '1',
    HTTP_PROXY: 'http://127.0.0.1:9',
    HTTPS_PROXY: 'http://127.0.0.1:9',
    NO_PROXY: '127.0.0.1,localhost',
    OPENCODE_DISABLE_MODELS_FETCH: '1',
    OPENCODE_DISABLE_AUTOUPDATE: '1',
    OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION: '1',
  }
}

export type HostFixture = {
  executable: string
  configDependencies?: string
  fence: string
  directory: string
  env: Env
  origin: string
  port: number
  shortTimeout: boolean
}

export type Outcome = {
  raw: unknown
  stored: unknown[]
  diagnostics: string
}

export type HostSession = {
  prompt: (text: string) => Promise<Outcome>
  close: () => Promise<void>
}

export async function startOc1(fixture: HostFixture): Promise<HostSession> {
  const {
    executable,
    fence,
    directory,
    env,
    origin,
    port,
    configDependencies,
    shortTimeout,
  } = fixture
  const launcher = join(directory, 'opencode')
  await writeFile(
    launcher,
    `#!/bin/sh\nexec python3 ${JSON.stringify(fence)} ${port} ${JSON.stringify(executable)} "$@"\n`,
  )
  await chmod(launcher, 0o700)
  const host = await spawnOpencode({
    executable: launcher,
    configDependencies,
    anthropicBaseURL: origin,
    refusalFallbackMode: 'client',
    childBaseEnv: env,
    childTmpDir: requireHostEnv(env, 'TMPDIR'),
    beforeSpawn: async ({ configDir }) => {
      const file = join(configDir, 'opencode.json')
      const config = JSON.parse(await readFile(file, 'utf8'))
      config.provider.anthropic.models[fixtureSource] = {
        status: 'active',
        name: 'Opus 5.5',
        limit: { context: 1_000_000, output: 4096 },
      }
      if (shortTimeout)
        config.provider.anthropic.options = { chunkTimeout: toolChunkTimeoutMs }
      await writeFile(file, JSON.stringify(config))
    },
  })
  const call = async (path: string, body?: unknown) => {
    const response = await fetch(`${host.url}${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(55_000),
    })
    const text = await response.text()
    if (!response.ok) throw new Error(`OC1 ${response.status} ${path}: ${text}`)
    return JSON.parse(text)
  }
  try {
    const { id } = await call('/session', { title: 'Refusal fixture' })
    if (!id) throw new Error('OC1 did not create a session')
    return {
      async prompt(text) {
        const raw = await call(`/session/${id}/message`, {
          model: { providerID: 'anthropic', modelID: fixtureSource },
          parts: [{ type: 'text', text }],
        })
        return {
          raw,
          stored: await call(`/session/${id}/message`),
          diagnostics: `${host.stdout()}\n${host.stderr()}\n${await readFile(join(host.env.tempDir, 'opencode-anthropic-auth.log'), 'utf8').catch(() => '')}`,
        }
      },
      close: host.kill,
    }
  } catch (error) {
    await host.kill()
    throw error
  }
}
