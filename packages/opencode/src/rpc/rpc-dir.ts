import { createHash } from 'node:crypto'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { anthropicAuthStateRoot } from '@cortexkit/anthropic-auth-core'

const RPC_DIR_ENV = 'OPENCODE_ANTHROPIC_AUTH_RPC_DIR'

// Both processes must resolve the SAME dir from the SAME project directory.
export function getRpcDir(projectDirectory: string): string {
  const override = process.env[RPC_DIR_ENV]?.trim()
  if (override) return resolve(projectDirectory, override)
  const hash = createHash('sha256')
    .update(projectDirectory)
    .digest('hex')
    .slice(0, 16)
  return join(getRpcRoot(), hash)
}

export function getRpcRoot(): string {
  const root = anthropicAuthStateRoot({
    xdgStateHome: process.env.XDG_STATE_HOME,
    home: homedir(),
    acceptRelative: true,
  })
  return join(root, 'rpc')
}

export { tmpdir }
