import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { delimiter, dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { isolatedEnvironment } from '../../../scripts/windows/harness.mjs'

const exec = promisify(execFile)
const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'))

export async function verifyWindowsOpenCode2Setup({
  cli,
  consumer,
  core,
  root,
  step,
}) {
  const bin = join(root, 'opencode2-bin')
  const temp = join(root, 'opencode2-tmp')
  await mkdir(bin)
  await mkdir(temp)
  // The explicit generation flag doesn't select a host on an empty machine.
  // An on-PATH launcher makes OpenCode discoverable without starting the host.
  await writeFile(join(bin, 'opencode2.cmd'), '@echo off\r\necho 2.3.0\r\n')
  const { name, version } = await readJson(
    join(dirname(cli), '..', 'package.json'),
  )

  for (const [scenario, precreateConfig] of [
    ['fresh-profile', false],
    ['existing-config', true],
  ]) {
    const profile = join(root, `opencode2-${scenario}`)
    const config = join(profile, '.config', 'opencode')
    const state = join(
      profile,
      '.local',
      'state',
      'cortexkit',
      'anthropic-auth',
      'opencode',
    )
    const env = isolatedEnvironment(profile)
    // Exercise Windows home defaults, not the directory overrides the OpenCode
    // 1 fixture needs. Keep temp files outside the initially empty profile.
    for (const key of Object.keys(env)) {
      if (key.startsWith('XDG_') || key === 'OPENCODE_CONFIG_DIR')
        delete env[key]
    }
    env.TEMP = temp
    env.TMP = temp
    env.OPENCODE_ANTHROPIC_AUTH_LOG_FILE = join(temp, `${scenario}.log`)
    const pathKey =
      Object.keys(env).find((key) => /^path$/i.test(key)) ?? 'Path'
    env[pathKey] = [bin, env[pathKey]].filter(Boolean).join(delimiter)
    await mkdir(profile)
    if (precreateConfig) await mkdir(config, { recursive: true })

    const setup = await step(
      `opencode2-${scenario}-setup`,
      async () => ({
        ...(await exec(
          process.execPath,
          [cli, 'setup', '--yes', '--opencode=2'],
          {
            cwd: consumer,
            env,
            timeout: 120_000,
          },
        )),
        exitCode: 0,
      }),
      { setupChild: true },
    )
    if (!setup) continue

    await step(`opencode2-${scenario}-writes`, async () => {
      const registered = await readJson(join(config, 'opencode.jsonc'))
      assert.deepEqual(registered.plugins, [`${name}@${version}`])
      const marker = await core.readStateLayoutMarker(state)
      // Setup stays legacy only if the config folder was absent at entry.
      assert.equal(marker?.phase, precreateConfig ? 'committed' : undefined)
      const dir = precreateConfig ? state : config
      const paths = await core.resolveNativePoolPaths(
        join(config, 'anthropic-auth.json'),
        join(config, 'anthropic-auth-state.json'),
        precreateConfig ? { kind: 'state-home', dir } : { kind: 'legacy' },
      )
      const holders = await readJson(join(dir, core.HOLDER_FILE_NAME))
      assert.equal(holders.version, 1)
      const journal = await core.readNativeMigrationJournal(paths)
      assert.equal(journal?.version, 5)
      assert.equal(journal?.kind, 'empty-init')
      assert.equal(journal?.phase, 'committed')
      assert.equal(journal?.host, 'opencode')
      return {
        config: 'opencode.jsonc',
        plugin: registered.plugins[0],
        layout: precreateConfig ? 'state-home' : 'legacy',
        holderRegistry: core.HOLDER_FILE_NAME,
        journal: 'committed empty-init',
      }
    })
  }
}
