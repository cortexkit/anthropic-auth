import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { captureStateHomeLayoutDiagnostic } from './layout-diagnostic.mjs'
import { isolatedEnvironment, sha256, withReceipt } from './harness.mjs'
import {
  loadPackedRuntime,
  verifyLongStateHomeRuntimePublication,
  verifySetupReaders,
} from './packed-readers.mjs'

if (process.platform === 'win32') {
  console.error(
    'Use verify.mjs for native Windows qualification, not the portable reader proof.',
  )
  process.exit(77)
}
const [packs, receipt] = process.argv.slice(2)
assert(
  packs && receipt,
  'Usage: node --experimental-import-meta-resolve scripts/windows/prove-packed-readers.mjs <tarball-directory> <receipt.json>',
)
const exec = promisify(execFile)
const root = await mkdtemp(join(tmpdir(), 'anthropic-packed-readers-'))
const profile = join(root, 'profile')
const consumer = join(root, 'consumer')
const env = isolatedEnvironment(profile)
const token = 'a'.repeat(64)
const result = {
  platform: process.platform,
  node: process.version,
  profile,
  proof: 'portable-packed-readers',
  tarballs: {},
  files: {},
  dacls: {},
}
const ok = await withReceipt(
  receipt,
  result,
  async (step) => {
    await mkdir(consumer, { recursive: true })
    for (const path of [
      env.TEMP,
      env.APPDATA,
      env.LOCALAPPDATA,
      env.OPENCODE_CONFIG_DIR,
    ])
      await mkdir(path, { recursive: true })
    await writeFile(join(env.OPENCODE_CONFIG_DIR, 'opencode.json'), '{}\n')
    const names = [
      'anthropic-auth-core',
      'opencode-anthropic-auth',
      'pi-anthropic-auth',
    ]
    const files = await readdir(packs)
    const dependencies = {}
    for (const name of names) {
      const matches = files.filter(
        (file) =>
          file.startsWith(`cortexkit-${name}-`) && file.endsWith('.tgz'),
      )
      assert.equal(matches.length, 1, `Exactly one ${name} archive required`)
      const path = join(packs, matches[0])
      result.tarballs[matches[0]] = sha256(await readFile(path))
      dependencies[`@cortexkit/${name}`] = `file:${path}`
    }
    await writeFile(
      join(consumer, 'package.json'),
      JSON.stringify({
        private: true,
        type: 'module',
        dependencies,
        overrides: {
          '@cortexkit/anthropic-auth-core':
            dependencies['@cortexkit/anthropic-auth-core'],
        },
      }),
    )
    const installed = await step('npm-install-packed-tarballs', async () => {
      await exec(
        'npm',
        [
          'install',
          '--ignore-scripts',
          '--legacy-peer-deps',
          '--no-audit',
          '--no-fund',
        ],
        {
          cwd: consumer,
          timeout: 300_000,
          env: { ...env, npm_config_cache: join(root, 'npm-cache') },
        },
      )
      return { packages: Object.keys(dependencies) }
    })
    assert(installed, 'Packed install failed; no workspace/source fallback')
    const { cli, core, api } = await loadPackedRuntime(consumer)
    result.packedCoreExports = Object.keys(core).sort()
    await step('packed-long-state-home-runtime-publish-lock', () =>
      verifyLongStateHomeRuntimePublication({ core, api, env, root, result }),
    )
    const setup = await step(
      'setup-local-noninteractive',
      async () => ({
        ...(await exec(
          process.execPath,
          [cli, 'setup', '--yes', '--no-claustrum', '--opencode=1'],
          { cwd: consumer, env, timeout: 120_000 },
        )),
        exitCode: 0,
      }),
      { setupChild: true },
    )
    await step('setup-journal-and-owner-only-readers', async () => {
      assert(
        setup,
        'Actual packed setup must succeed before reading its artifacts',
      )
      return verifySetupReaders({
        core,
        api,
        env,
        profile,
        result,
        fixtureToken: token,
      })
    })
    await step('packed-long-state-home-layout-diagnostic', () =>
      captureStateHomeLayoutDiagnostic({ core, env, root }),
    )
  },
  () => rm(root, { recursive: true, force: true }),
  {
    fixtureRoots: [root, profile],
    secrets: [token],
    diagnosticsDirectory: join(
      env.XDG_STATE_HOME,
      'cortexkit',
      'anthropic-auth',
      'diagnostics',
    ),
  },
)
console.log(
  `Portable packed readers: ${result.steps.length} steps, ${result.status}; nativeWindowsQualified=${result.nativeWindowsQualified}; receipt=${receipt}`,
)
if (!ok) process.exitCode = 1
