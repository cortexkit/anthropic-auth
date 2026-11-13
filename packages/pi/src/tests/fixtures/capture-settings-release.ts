import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { snapshotSettings } from '../settings-snapshot-fixture.ts'
import { observeSettings } from '../settings-snapshot-observe.ts'

// Run this only in the tagged release tree, never to accept new behavior.
const output = process.argv[2]
if (!output) throw new Error('Pass the release snapshot output path')
const home = await mkdtemp(join(tmpdir(), 'pi-release-snapshots-'))
Object.assign(process.env, {
  HOME: home,
  USERPROFILE: home,
  XDG_CONFIG_HOME: join(home, '.config'),
  XDG_STATE_HOME: join(home, 'state'),
  PI_ANTHROPIC_AUTH_CACHEKEEP_REGISTRY_DIR: join(home, 'cachekeep'),
  PI_ANTHROPIC_AUTH_ROUTING_STATE_FILE: join(home, 'routing.json'),
})
delete process.env.ANTHROPIC_AUTH_SETTINGS_FILE
try {
  const outputs: Record<string, unknown> = {}
  for (const [name, absent] of [
    ['explicit', false],
    ['absent', true],
  ] as const) {
    const path = join(home, name, 'anthropic-auth.json')
    process.env.PI_ANTHROPIC_AUTH_FILE = path
    outputs[name] = await observeSettings(snapshotSettings(absent), path)
  }
  await Bun.write(output, `${JSON.stringify(outputs, null, 2)}\n`)
} finally {
  await rm(home, { recursive: true, force: true })
}
