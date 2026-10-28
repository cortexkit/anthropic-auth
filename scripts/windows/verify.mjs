import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import {
  assertHealthySetupPublication,
  isolatedEnvironment,
  sha256,
  snapshot,
  withReceipt,
} from './harness.mjs'
import { loadPackedRuntime, verifySetupReaders } from './packed-readers.mjs'
import { cleanupFixture } from './setup-evidence.mjs'

const exec = promisify(execFile)
if (process.platform !== 'win32') {
  console.error(
    'Native Windows packed setup proof requires Windows; not qualified.',
  )
  process.exit(77)
}
const [packs, receipt] = process.argv.slice(2)
assert(
  packs && receipt,
  'Usage: node scripts/windows/verify.mjs <tarball-directory> <receipt.json>',
)
const root = await mkdtemp(join(homedir(), 'anthropic-windows-'))
const profile = join(root, 'profile')
const consumer = join(root, 'consumer')
const env = isolatedEnvironment(profile)
const fixtureToken = 'a'.repeat(64)
const result = {
  platform: process.platform,
  arch: process.arch,
  node: process.version,
  profile,
  tarballs: {},
  files: {},
  dacls: {},
  steps: [],
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
    const archives = await readdir(packs)
    const archive = (prefix) => {
      const matches = archives.filter(
        (name) => name.startsWith(prefix) && name.endsWith('.tgz'),
      )
      assert.equal(matches.length, 1, `Exactly one ${prefix} tarball required`)
      return join(packs, matches[0])
    }
    const coreArchive = archive('cortexkit-anthropic-auth-core-')
    const opencodeArchive = archive('cortexkit-opencode-anthropic-auth-')
    const piArchive = archive('cortexkit-pi-anthropic-auth-')
    for (const path of [coreArchive, opencodeArchive, piArchive])
      result.tarballs[path.split(/[\\/]/).pop()] = sha256(await readFile(path))
    const coreName = '@cortexkit/anthropic-auth-core'
    const opencodeName = '@cortexkit/opencode-anthropic-auth'
    const piName = '@cortexkit/pi-anthropic-auth'
    await writeFile(
      join(consumer, 'package.json'),
      JSON.stringify({
        private: true,
        type: 'module',
        dependencies: {
          [coreName]: `file:${coreArchive}`,
          [opencodeName]: `file:${opencodeArchive}`,
          [piName]: `file:${piArchive}`,
        },
        overrides: { [coreName]: `file:${coreArchive}` },
      }),
    )
    const installed = await step('npm-install-packed-tarballs', async () => {
      assert(
        process.env.ANTHROPIC_NPM_CLI,
        'Workflow must supply the installed npm CLI path',
      )
      await exec(
        process.execPath,
        [
          process.env.ANTHROPIC_NPM_CLI,
          'install',
          '--ignore-scripts',
          '--legacy-peer-deps',
          '--no-audit',
          '--no-fund',
        ],
        { cwd: consumer, timeout: 300_000 },
      )
      return { packages: [coreName, opencodeName, piName] }
    })
    if (!installed)
      throw new Error(
        'Packed installation failed; no source fallback is allowed',
      )
    const packageRoot = (name) =>
      join(consumer, 'node_modules', ...name.split('/'))
    const { cli, privateEntry, api, core } = await loadPackedRuntime(consumer)
    await step('installed-runtime-loader-and-prebuild', async () => {
      assert(privateEntry.startsWith(join(consumer, 'node_modules')))
      for (const arch of ['x64', 'arm64']) {
        const binary = join(
          dirname(privateEntry),
          '..',
          'prebuilds',
          `private-files-win32-${arch}.node`,
        )
        result.files[`private-files-win32-${arch}.node`] = sha256(
          await readFile(binary),
        )
      }
      const dist = join(packageRoot(opencodeName), 'dist')
      const scripts = (await readdir(dist, { recursive: true })).filter(
        (name) => name.endsWith('.js'),
      )
      const code = (
        await Promise.all(
          scripts.map((name) => readFile(join(dist, name), 'utf8')),
        )
      ).join('\n')
      assert(
        !code.includes('private-files-win32-'),
        'Native loader must not be inlined',
      )
      assert(
        !code.includes('loadPrivateFilesNative'),
        'Private-files implementation must not be inlined',
      )
      assert(
        code.includes(coreName),
        'OpenCode must resolve installed Core dist',
      )
      assert(
        code.includes('@cortexkit/private-files'),
        'Shared runner must keep the runtime import',
      )
      for (const name of [coreName, opencodeName, piName])
        result.files[`${name}/dist/index.js`] = sha256(
          await readFile(join(packageRoot(name), 'dist/index.js')),
        )
      const probe = join(profile, 'native-prebuild-probe')
      await api.createPrivateFile(probe, 'synthetic non-credential bytes')
      const verdict = await api.verifyOwnerOnly(probe)
      assert.equal(
        verdict.ok,
        true,
        'Native DACL verifier must load and accept the native-created file',
      )
      result.dacls['native-prebuild-probe'] = verdict
      // Keep this probe separate so it cannot pre-create the CLI diagnostics directory.
      const directoryProbe = join(profile, 'diagnostics-helper-probe', 'nested')
      assert.equal(
        await core.ensureWindowsOwnerOnlyDirectory(directoryProbe),
        true,
      )
      const diagnosticProbe = join(directoryProbe, 'synthetic.log')
      assert.equal(
        await core.createWindowsOwnerOnly(
          diagnosticProbe,
          'synthetic diagnostic; no credentials',
        ),
        true,
      )
      for (const [label, path] of [
        ['diagnostics-helper-directory', directoryProbe],
        ['diagnostics-helper-file', diagnosticProbe],
      ]) {
        result.dacls[label] = await api.verifyOwnerOnly(path)
        assert.equal(result.dacls[label].ok, true)
      }
      result.files['diagnostics-helper-file'] = sha256(
        await readFile(diagnosticProbe),
      )
      return { nativeAddonLoaded: true, arch: process.arch }
    })
    await step('tasklist-preflight', async () => {
      // Use tasklist to check process discovery without populating the isolated
      // profile: PowerShell can write a LOCALAPPDATA cache even with -NoProfile.
      await exec('tasklist.exe', ['/fo', 'csv', '/nh'], {
        env,
        timeout: 15_000,
      })
      return { command: 'tasklist.exe /fo csv /nh' }
    })
    for (const pathKind of ['ordinary', 'long']) {
      await step(`state-relocation-${pathKind}-path-strict`, async () => {
        const home = join(root, `relocation-${pathKind}`)
        const output = await exec(
          process.execPath,
          [
            '--experimental-import-meta-resolve',
            fileURLToPath(new URL('./relocation-move.mjs', import.meta.url)),
            consumer,
            home,
            pathKind,
          ],
          { cwd: consumer, env: isolatedEnvironment(home), timeout: 120_000 },
        )
        const evidence = JSON.parse(output.stdout.trim().split('\n').at(-1))
        console.log(
          JSON.stringify({ name: `state-relocation-${pathKind}`, evidence }),
        )
        assert.equal(evidence.passed, true, JSON.stringify(evidence))
        return evidence
      })
    }
    const args = [cli, 'setup', '--yes', '--no-claustrum', '--opencode=1']
    await step(
      'setup-dry-run-no-writes',
      async () => {
        const before = await snapshot(profile)
        result.files.dryRunBefore = before
        let output
        try {
          output = await exec(process.execPath, [...args, '--dry-run'], {
            cwd: consumer,
            env,
            timeout: 60_000,
          })
          assert.deepEqual(
            await snapshot(profile),
            before,
            'Dry-run changed the isolated profile',
          )
        } catch (error) {
          if (output) Object.assign(error, output, { exitCode: 0 })
          throw error
        }
        return { ...output, exitCode: 0 }
      },
      { setupChild: true },
    )
    const setup = await step(
      'setup-local-noninteractive',
      async () => ({
        ...(await exec(process.execPath, args, {
          cwd: consumer,
          env,
          timeout: 120_000,
        })),
        exitCode: 0,
      }),
      { setupChild: true },
    )
    const setupRecord = result.steps.find(
      (entry) => entry.name === 'setup-local-noninteractive',
    ).evidence
    await step('publication-deadline', async () =>
      assertHealthySetupPublication(setupRecord, Boolean(setup)),
    )
    await step('setup-journal-and-owner-only-readers', async () => {
      assert(setup, 'Successful setup is required to qualify its files')
      return verifySetupReaders({
        core,
        api,
        env,
        profile,
        result,
        fixtureToken,
      })
    })
  },
  async () => {
    const evidence = await cleanupFixture(root, { secrets: [fixtureToken] })
    console.log(JSON.stringify({ name: 'cleanup', evidence }))
    return evidence
  },
  {
    fixtureRoots: [root, profile],
    secrets: [fixtureToken],
    diagnosticsDirectory: join(
      env.XDG_STATE_HOME,
      'cortexkit',
      'anthropic-auth',
      'diagnostics',
    ),
  },
)
console.log(
  `Windows packed setup: ${result.steps.length} steps, ${result.status}; receipt: ${receipt}`,
)
if (!ok) process.exitCode = 1
