import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getHostDataHome, getHostHome } from '@cortexkit/anthropic-auth-core'

export const OPENCODE_PACKAGE_NAME = '@cortexkit/opencode-anthropic-auth'
export const PI_PACKAGE_NAME = '@cortexkit/pi-anthropic-auth'

export { getHostHome }

export function getOpenCodeConfigDir(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const configured = env.OPENCODE_CONFIG_DIR?.trim()
  if (configured) return resolve(configured)
  return join(
    env.XDG_CONFIG_HOME || join(getHostHome(env, platform), '.config'),
    'opencode',
  )
}

export function getOpenCodeDataDir(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return join(getHostDataHome(env), 'opencode')
}

export function getOpenCodeAuthPath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return join(getOpenCodeDataDir(env), 'auth.json')
}

export function getPiAgentDir(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const configured = env.PI_CODING_AGENT_DIR?.trim() || env.PI_AGENT_DIR?.trim()
  if (configured) return resolve(configured)
  return join(getHostHome(env, platform), '.pi', 'agent')
}

export function getPiAuthPath(env: NodeJS.ProcessEnv = process.env): string {
  // Match Pi's SDK directory rule, not the extension's optional storage override.
  const configured = env.PI_CODING_AGENT_DIR
  const home = getHostHome(env)
  let agentDir = configured || join(home, '.pi', 'agent')
  if (agentDir === '~') agentDir = home
  else if (
    agentDir.startsWith('~/') ||
    (process.platform === 'win32' && agentDir.startsWith('~\\'))
  )
    agentDir = join(home, agentDir.slice(2))
  if (agentDir.startsWith('file://')) agentDir = fileURLToPath(agentDir)
  return join(agentDir, 'auth.json')
}

export function opencodePluginEntry(version: string): string {
  return `${OPENCODE_PACKAGE_NAME}@${version}`
}

export function opencodeTuiEntry(version: string): string {
  return `${OPENCODE_PACKAGE_NAME}@${version}`
}

export function piPluginEntry(version: string): string {
  return `npm:${PI_PACKAGE_NAME}@${version}`
}

/**
 * Robustly resolve the package version from both source (src/setup/paths.ts)
 * and bundled layouts (dist/cli.js, dist/index.js, etc.).
 */
export async function getSetupPackageVersion(): Promise<string> {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < 5; i++) {
    const candidate = join(dir, 'package.json')
    if (existsSync(candidate)) {
      try {
        const pkg = JSON.parse(readFileSync(candidate, 'utf8'))
        if (typeof pkg.version === 'string' && pkg.version.trim()) {
          return pkg.version.trim()
        }
      } catch {}
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return '1.22.0'
}
