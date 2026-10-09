import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  requireDisjointNativeSetupPaths,
  resolveNativeSetupPaths,
} from './native-paths.ts'

async function fixture(body: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'native-setup-paths-'))
  try {
    await body(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

test('selected host paths use injected configuration, data and Pi overrides without ambient mutation', async () => {
  await fixture(async (root) => {
    const env = {
      OPENCODE_CONFIG_DIR: join(root, 'opencode'),
      XDG_DATA_HOME: join(root, 'data'),
      PI_AGENT_DIR: join(root, 'pi'),
    }
    const before = process.env.OPENCODE_CONFIG_DIR
    const opencode = await resolveNativeSetupPaths('opencode', env)
    const pi = await resolveNativeSetupPaths('pi', env)
    expect(opencode.legacyConfigPath).toBe(
      join(root, 'opencode', 'anthropic-auth.json'),
    )
    expect(opencode.hostAuthPath).toBe(
      join(root, 'data', 'opencode', 'auth.json'),
    )
    expect(pi.legacyConfigPath).toBe(join(root, 'pi', 'anthropic-auth.json'))
    expect(pi.hostAuthPath).toBe(join(root, 'pi', 'auth.json'))
    expect(opencode.routingSourcePath).not.toBe(opencode.routingDestinationPath)
    expect(process.env.OPENCODE_CONFIG_DIR).toBe(before)
    await expect(
      requireDisjointNativeSetupPaths([opencode, pi]),
    ).resolves.toBeUndefined()
  })
})

test('an explicit routing override remains same-path and shared legacy state refuses cross-host setup', async () => {
  await fixture(async (root) => {
    const route = join(root, 'routing.json')
    const env = {
      OPENCODE_CONFIG_DIR: join(root, 'opencode'),
      XDG_DATA_HOME: join(root, 'data'),
      PI_AGENT_DIR: join(root, 'pi'),
      OPENCODE_ANTHROPIC_AUTH_ROUTING_STATE_FILE: route,
      OPENCODE_ANTHROPIC_AUTH_STATE_FILE: join(root, 'shared-state.json'),
    }
    const opencode = await resolveNativeSetupPaths('opencode', env)
    const pi = await resolveNativeSetupPaths('pi', env)
    expect(opencode.routingSourcePath).toBe(route)
    expect(opencode.routingDestinationPath).toBe(route)
    await expect(
      requireDisjointNativeSetupPaths([opencode, pi]),
    ).rejects.toThrow('overlap')
  })
})
