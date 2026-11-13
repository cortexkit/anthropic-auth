import assert from 'node:assert/strict'
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { parse } from 'jsonc-parser'
import {
  LEGACY_STATE_LAYOUT,
  resolveNativePoolPaths,
  resolveSettingsPaths,
  runSettingsMoveAtStartup,
} from '../dist/index.js'

assert.equal(process.platform, 'win32', 'This proof must run on real Windows')
const root = await realpath(await mkdtemp(join(tmpdir(), 'settings-windows-')))
const receipt = []
try {
  for (const xdg of [false, true]) {
    const options = {
      host: 'opencode',
      home: root,
      env: {
        HOME: root,
        USERPROFILE: root,
        APPDATA: join(root, 'AppData', 'Roaming'),
        XDG_STATE_HOME: join(root, 'state'),
        ...(xdg ? { XDG_CONFIG_HOME: join(root, '.config') } : {}),
      },
      readMode: async () => 'local',
      log: { warn: (message) => console.error(message) },
      fence: {
        registration: { status: 'registered' },
        floor: '2.12.0',
        self: { pid: process.pid, incarnation: 'proof', instance: 'proof' },
        artifacts: { rpcRoots: [], rpcDirs: [], cacheKeepDirs: [] },
        readHolders: async () => undefined,
      },
    }
    const paths = await resolveSettingsPaths('opencode', options)
    assert.equal(paths.sourceRule, 'default')
    assert.ok(
      paths.target.startsWith(
        xdg ? join(root, '.config') : options.env.APPDATA,
      ),
    )
    const sources = []
    for (const host of ['opencode', 'pi']) {
      const store = await resolveNativePoolPaths(
        paths.defaults[host].account,
        paths.defaults[host].state,
        LEGACY_STATE_LAYOUT,
      )
      const bytes = JSON.stringify(
        host === 'opencode'
          ? { dump: { enabled: true } }
          : { prime: { enabled: true } },
      )
      await mkdir(dirname(store.config), { recursive: true })
      await writeFile(store.config, bytes)
      sources.push({ file: store.config, bytes })
    }
    // No replacement mover or filesystem operations: common-auth handles locking and publication.
    const moved = await runSettingsMoveAtStartup(options)
    assert.equal(moved.outcome, 'moved')
    const published = await readFile(paths.target, 'utf8')
    assert.equal(parse(published).dump_enabled, true)
    assert.equal(parse(published).prime_enabled, true)
    const marker = JSON.parse(await readFile(paths.marker, 'utf8'))
    assert.equal(marker.version, 1)
    assert.equal(marker.target, await realpath(paths.target))
    for (const source of sources)
      assert.equal(await readFile(source.file, 'utf8'), source.bytes)
    receipt.push({
      layout: xdg ? 'home-config' : 'APPDATA',
      file: paths.target,
      published,
      markerFile: paths.marker,
      marker,
    })
  }
  assert.notEqual(receipt[0].file, receipt[1].file)
  for (const entry of receipt) {
    assert.equal(await readFile(entry.file, 'utf8'), entry.published)
    assert.deepEqual(
      JSON.parse(await readFile(entry.markerFile, 'utf8')),
      entry.marker,
    )
  }
  console.log(
    JSON.stringify(
      { platform: process.platform, node: process.version, moves: receipt },
      null,
      2,
    ),
  )
  console.log(
    'WINDOWS_SETTINGS_MOVE_OK: 2 published files, 2 markers, real common-auth mover',
  )
} finally {
  await rm(root, { recursive: true, force: true })
}
