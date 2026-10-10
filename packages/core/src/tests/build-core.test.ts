import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { bundleCore } from '../../scripts/build.ts'

const roots: string[] = []

afterEach(async () => {
  const owned = roots.splice(0)
  await Promise.all(
    owned.map((root) => rm(root, { recursive: true, force: true })),
  )
})

test('bundles shared store and file primitives into an independent Node entrypoint', async () => {
  const sourceRoot = await mkdtemp(
    fileURLToPath(new URL('../../.bundle-test-', import.meta.url)),
  )
  const outputRoot = await mkdtemp(join(tmpdir(), 'anthropic-core-bundle-'))
  roots.push(sourceRoot, outputRoot)
  const source = join(sourceRoot, 'entry with spaces.ts')
  const outfile = join(outputRoot, 'entry with spaces.mjs')
  await writeFile(
    source,
    `
    import { openPoolStore } from '@cortexkit/common-auth/store'
    import { writeJsonAtomic } from '@cortexkit/common-auth/fs'
    if (typeof openPoolStore !== 'function' || typeof writeJsonAtomic !== 'function') throw new Error('missing functions')
    const root = process.argv[2]
    const store = openPoolStore({
      provider: 'anthropic', configPath: root + '/pool.json', statePath: root + '/pool-state.json',
      requireCredentialStamps: true,
      quota: { validate: x => typeof x === 'number', merge: (_, x) => x },
    })
    await store.add({ id: 'a', credential: { type: 'oauth', access: 'synthetic-access', refresh: 'synthetic-refresh', expires: 4000000000000 } })
    const loaded = await store.read()
    if (loaded.status !== 'ready' || loaded.rows.length !== 1 || loaded.rows[0].stamp !== 'bound') throw new Error('store did not bind')
    await writeJsonAtomic(root + '/result.json', { bound: true })
  `,
  )
  await bundleCore({ entrypoint: source, outfile })
  const emitted = await readFile(outfile, 'utf8')
  expect(emitted).not.toMatch(
    /\b(?:from\s*|import\s*\(|require\s*\()\s*['"]@cortexkit\/common-auth/,
  )
  const child = Bun.spawn(['node', outfile, outputRoot], {
    cwd: outputRoot,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, NODE_PATH: '' },
  })
  const stderr = await new Response(child.stderr).text()
  expect(await child.exited, stderr).toBe(0)
  expect(
    JSON.parse(await readFile(join(outputRoot, 'result.json'), 'utf8')),
  ).toEqual({ bound: true })
})
