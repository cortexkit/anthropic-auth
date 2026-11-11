import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { parse } from 'jsonc-parser'

const root = new URL('../../../../', import.meta.url)
const manifest = (path: string) =>
  readFile(new URL(path, root), 'utf8').then(JSON.parse)
const [workspace, opencode, e2e, lock] = await Promise.all([
  manifest('package.json'),
  manifest('packages/opencode/package.json'),
  manifest('packages/e2e-tests/package.json'),
  readFile(new URL('bun.lock', root), 'utf8').then((text) => parse(text)),
])

function singleLockedCopy(name: string, version: string) {
  expect(version).toMatch(/^\d+\.\d+\.\d+$/)
  expect(
    Object.keys(lock.packages).filter(
      (path) => path === name || path.endsWith(`/${name}`),
    ),
  ).toEqual([name])
  expect(lock.packages[name][0]).toBe(`${name}@${version}`)
}

describe('shared library dependency pins', () => {
  test('OpenTUI shares one core and Solid satisfies its peer range', () => {
    const core = opencode.dependencies['@opentui/core']
    const solid = opencode.dependencies['@opentui/solid']
    const solidJs = opencode.dependencies['solid-js']
    expect(core).toBe(solid)
    expect(
      lock.packages['@opentui/solid'][2].dependencies['@opentui/core'],
    ).toBe(core)
    expect(
      Bun.semver.satisfies(
        solidJs,
        lock.packages['@opentui/solid'][2].peerDependencies['solid-js'],
      ),
    ).toBe(true)
    for (const name of ['@opentui/core', '@opentui/solid', 'solid-js'])
      singleLockedCopy(name, opencode.dependencies[name])
  })

  test('OpenCode 2 SDK packages move together without nested copies', () => {
    const version = opencode.devDependencies['@opencode/plugin']
    for (const name of [
      '@opencode/ai',
      '@opencode/client',
      '@opencode/plugin',
      '@opencode/protocol',
      '@opencode/schema',
      '@opencode/util',
    ])
      singleLockedCopy(name, version)
  })

  test('OpenCode 1 host, plugin and SDK pins share one SDK copy', () => {
    const version = workspace.devDependencies['@opencode-ai/plugin']
    expect(workspace.devDependencies['opencode-ai']).toBe(version)
    expect(e2e.dependencies['@opencode-ai/sdk']).toBe(version)
    expect(
      lock.packages['@opencode-ai/plugin'][2].dependencies['@opencode-ai/sdk'],
    ).toBe(version)
    singleLockedCopy('@opencode-ai/plugin', version)
    singleLockedCopy('@opencode-ai/sdk', version)
  })
})
