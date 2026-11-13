import { afterEach, beforeEach } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

delete process.env.CORTEXKIT_VAULT_HOST

let testDir: string | undefined
let originalXdgStateHome: string | undefined
let originalHomePaths: [string, string | undefined][] = []
const activeBodies = new Set<Promise<unknown>>()

/** Bun deadlines do not cancel async bodies; keep their fixture alive until they settle. */
export function trackPiTestBody<T>(body: Promise<T>): Promise<T> {
  activeBodies.add(body)
  void body.then(
    () => activeBodies.delete(body),
    () => activeBodies.delete(body),
  )
  return body
}
const HOST_PATH_ENV_VARS = [
  'OPENCODE_CONFIG_DIR',
  'OPENCODE_ANTHROPIC_AUTH_FILE',
  'OPENCODE_ANTHROPIC_AUTH_STATE_FILE',
  'PI_AGENT_DIR',
  'PI_CODING_AGENT_DIR',
  'PI_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE',
  'PI_ANTHROPIC_AUTH_FILE',
  'PI_ANTHROPIC_AUTH_ROUTING_STATE_FILE',
  'PI_ANTHROPIC_AUTH_CACHEKEEP_REGISTRY_DIR',
] as const

beforeEach(async () => {
  delete process.env.CORTEXKIT_VAULT_HOST
  const core = await import('@cortexkit/anthropic-auth-core')
  core.resetVaultHostAuthorityForTests?.()
  const source = await import('../../../core/src/native-vault-host.ts')
  source.resetVaultHostAuthorityForTests?.()
  testDir = await mkdtemp(join(tmpdir(), 'anthropic-auth-pi-test-'))
  originalHomePaths = ['HOME', 'USERPROFILE', 'XDG_CONFIG_HOME'].map((key) => [
    key,
    process.env[key],
  ])
  // Settings paths honor inherited home variables before a caller's home argument.
  // Keep every test's default settings target inside its disposable sandbox.
  process.env.HOME = testDir
  process.env.USERPROFILE = testDir
  process.env.XDG_CONFIG_HOME = join(testDir, '.config')
  originalXdgStateHome = process.env.XDG_STATE_HOME
  for (const key of HOST_PATH_ENV_VARS) delete process.env[key]
  process.env.OPENCODE_CONFIG_DIR = join(testDir, 'opencode')
  process.env.OPENCODE_ANTHROPIC_AUTH_FILE = join(
    testDir,
    'anthropic-auth.json',
  )
  process.env.OPENCODE_ANTHROPIC_AUTH_STATE_FILE = join(
    testDir,
    'anthropic-auth-state.json',
  )
  process.env.PI_AGENT_DIR = join(testDir, '.pi-agent')
  process.env.XDG_STATE_HOME = join(testDir, 'xdg-state')
})

afterEach(async () => {
  const retiredDir = testDir
  const retiredBodies = [...activeBodies]
  testDir = undefined
  await Promise.allSettled(retiredBodies)
  for (const [key, value] of originalHomePaths) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  originalHomePaths = []
  if (originalXdgStateHome === undefined) {
    delete process.env.XDG_STATE_HOME
  } else {
    process.env.XDG_STATE_HOME = originalXdgStateHome
  }
  originalXdgStateHome = undefined
  if (retiredDir) await rm(retiredDir, { recursive: true, force: true })
})
