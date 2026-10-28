import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsPromises from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { basename, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isolatedEnvironment, sha256 } from './harness.mjs'
import { loadPackedRuntime } from './packed-readers.mjs'
import { fixtureRedactor } from './setup-evidence.mjs'

function fileKind(name) {
  if (name.endsWith('.lock')) return 'lock'
  if (name.startsWith('config-dir.json.')) return 'config-marker-stage'
  if (name.startsWith('layout.json.')) return 'layout-record-stage'
  if (name.includes('.relocating-')) return 'relocation-stage'
  if (name.includes('.moving-')) return 'set-aside-journal'
  if (name.includes('holders')) return 'holder-registry'
  return 'data-or-marker'
}

/** Observe real Node I/O without replacing the filesystem or changing its flags. */
export async function withOpenDiagnostics(action, failures) {
  const saved = []
  const record = (error, path, flags) => {
    if (error.syscall !== 'open') return
    const name = basename(String(error.path ?? path))
    failures.push({
      operation: error.syscall,
      flags: flags ?? null,
      basename: name,
      fileKind: fileKind(name),
      code: error.code,
    })
  }
  for (const [target, name, defaultFlags] of [
    [fsPromises, 'open', undefined],
    [fsPromises, 'readFile', 'r'],
    [fsPromises, 'writeFile', 'w'],
    [fsPromises, 'appendFile', 'a'],
    [fs, 'openSync', undefined],
    [fs, 'readFileSync', 'r'],
    [fs, 'writeFileSync', 'w'],
    [fs, 'appendFileSync', 'a'],
  ]) {
    const original = target[name]
    saved.push(() => {
      target[name] = original
    })
    target[name] = function (...args) {
      const options = name.startsWith('readFile') ? args[1] : args[2]
      const flags =
        defaultFlags === undefined ? args[1] : (options?.flag ?? defaultFlags)
      try {
        const result = Reflect.apply(original, this, args)
        return result?.catch
          ? result.catch((error) => {
              record(error, args[0], flags)
              throw error
            })
          : result
      } catch (error) {
        record(error, args[0], flags)
        throw error
      }
    }
  }
  const originalOpen = fs.open
  saved.push(() => {
    fs.open = originalOpen
  })
  fs.open = function (...args) {
    const callback = args.pop()
    return Reflect.apply(originalOpen, this, [
      ...args,
      (error, fd) => {
        if (error) record(error, args[0], args[1])
        callback(error, fd)
      },
    ])
  }
  syncBuiltinESMExports()
  try {
    return await action()
  } finally {
    for (const restore of saved.reverse()) restore()
    syncBuiltinESMExports()
  }
}

/** A separate process gives each move its own HOME, holder registry and layout cache. */
export async function probeRelocationMove(core, api, home, pathKind, evidence) {
  const env = isolatedEnvironment(home)
  const configDir = join(home, '.config', 'opencode')
  // Keep individual components short; only the complete path exceeds MAX_PATH.
  env.XDG_STATE_HOME =
    pathKind === 'long'
      ? join(
          home,
          ...Array.from(
            { length: 6 },
            (_, i) => `state-${i}-${'x'.repeat(48)}`,
          ),
        )
      : join(home, 'state')
  env.OPENCODE_CONFIG_DIR = configDir
  await fsPromises.mkdir(configDir, { recursive: true })
  const paths = await core.resolveNativePoolPaths(
    join(configDir, 'anthropic-auth.json'),
    join(configDir, 'anthropic-auth-state.json'),
    { kind: 'legacy' },
  )
  const runtime = `${JSON.stringify({ version: 1, storageId: paths.storageId, accounts: {} })}\n`
  const journal = `${JSON.stringify({ version: 5, kind: 'empty-init', storageId: paths.storageId, host: 'opencode', phase: 'committed' })}\n`
  for (const [path, bytes] of [
    [paths.runtime, runtime],
    [paths.journal, journal],
  ]) {
    if (process.platform === 'win32') await api.createPrivateFile(path, bytes)
    else await fsPromises.writeFile(path, bytes, { flag: 'wx', mode: 0o600 })
  }
  assert.equal(
    (await core.readNativeMigrationJournal(paths)).phase,
    'committed',
  )
  const steps = []
  evidence.pathKind = pathKind
  evidence.steps = steps
  evidence.destinationLength = join(
    env.XDG_STATE_HOME,
    'cortexkit',
    'anthropic-auth',
    'opencode',
    'anthropic-auth-native-state.json',
  ).length
  const decision = await core.decideOpenCodeStateLayout({
    role: 'opencode2',
    env,
    home,
    moveEnabled: true,
    artifacts: { rpcRoots: [], rpcDirs: [], cacheKeepDirs: [] },
    onStep: (step) => steps.push(step),
  })
  evidence.decision = decision.kind
  evidence.reasons =
    decision.kind === 'legacy'
      ? decision.reasons.map(fixtureRedactor({ fixtureRoots: [home] }))
      : []
  evidence.moved = decision.kind === 'state-home' && decision.moved
  assert.equal(decision.kind, 'state-home', JSON.stringify(evidence))
  assert.equal(decision.moved, true, 'The strict probe must perform the move')
  evidence.phase = decision.record.phase
  evidence.cleanup = decision.record.cleanup
  assert.equal(decision.record.phase, 'committed')
  assert.equal(decision.record.cleanup, 'done')
  evidence.files = []
  for (const [role, bytes] of [
    ['localRuntime', runtime],
    ['journal', journal],
  ]) {
    const file = decision.record.files.find(
      (candidate) => candidate.role === role,
    )
    assert(file, `The move must record ${role}`)
    if (pathKind === 'long') assert(file.to.length > 400)
    else assert(file.to.length < 260)
    const copied = await fsPromises.readFile(file.to, 'utf8')
    assert.equal(copied, bytes)
    if (process.platform === 'win32')
      assert.equal((await api.verifyOwnerOnly(file.to)).ok, true)
    evidence.files.push({
      role,
      basename: basename(file.to),
      length: file.to.length,
      sha256: sha256(copied),
    })
  }
  assert.equal(
    (await core.readRelocationPointer(paths.runtime)).attempt,
    decision.record.attempt,
  )
  await assert.rejects(fsPromises.readFile(paths.journal), { code: 'ENOENT' })
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const [consumer, home, pathKind] = process.argv.slice(2)
  assert(consumer && home && ['ordinary', 'long'].includes(pathKind))
  Object.assign(process.env, isolatedEnvironment(home))
  const evidence = { passed: false, openFailures: [] }
  try {
    await withOpenDiagnostics(async () => {
      const { core, api } = await loadPackedRuntime(consumer)
      try {
        await probeRelocationMove(core, api, home, pathKind, evidence)
        evidence.passed = true
      } finally {
        core.resetNativeHolderRegistryForTests()
      }
    }, evidence.openFailures)
  } catch (error) {
    evidence.error = fixtureRedactor({ fixtureRoots: [home] })(String(error))
  }
  console.log(JSON.stringify(evidence))
}
