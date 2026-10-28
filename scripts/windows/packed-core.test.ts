import { expect, test } from 'bun:test'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { parse } from '@babel/parser'

const run = promisify(execFile)
const repo = fileURLToPath(new URL('../../', import.meta.url))

async function requiredCoreFunctions(entry: URL): Promise<string[]> {
  const seen = new Set<string>()
  const names = new Set<string>()
  async function visit(url: URL) {
    if (seen.has(url.href)) return
    seen.add(url.href)
    const ast = parse(await readFile(url, 'utf8'), { sourceType: 'module' })
    const imports: string[] = []
    function walk(value: unknown) {
      if (!value || typeof value !== 'object') return
      if (Array.isArray(value)) {
        for (const item of value) walk(item)
        return
      }
      const node = value as Record<string, any>
      if (
        (node.type === 'MemberExpression' ||
          node.type === 'OptionalMemberExpression') &&
        node.object?.type === 'Identifier' &&
        node.object.name === 'core'
      ) {
        if (!node.computed && node.property.type === 'Identifier')
          names.add(node.property.name)
        else if (node.computed && node.property.type === 'StringLiteral')
          names.add(node.property.value)
        else
          throw new Error(
            `Dynamic Core export access cannot be checked in ${url.pathname}`,
          )
      }
      if (
        (node.type === 'ImportDeclaration' ||
          node.type === 'ExportNamedDeclaration' ||
          node.type === 'ExportAllDeclaration' ||
          node.type === 'ImportExpression') &&
        node.source?.type === 'StringLiteral'
      )
        imports.push(node.source.value)
      for (const child of Object.values(node)) walk(child)
    }
    walk(ast)
    for (const path of imports.filter((path) => path.startsWith('.')))
      await visit(new URL(path, url))
  }
  await visit(entry)
  return [...names].sort()
}

test('packed Core exports every function referenced by the Windows verifier and its local helpers', async () => {
  const scratch = join(repo, 'tmp')
  await mkdir(scratch, { recursive: true })
  const root = await mkdtemp(join(scratch, 'windows-packed-core-'))
  try {
    const required = await requiredCoreFunctions(
      new URL('verify.mjs', import.meta.url),
    )
    expect(required).toContain('readNativeMigrationJournal')
    expect(required).toContain('ensureWindowsOwnerOnlyDirectory')
    const packed = await run(
      'npm',
      ['pack', '--json', '--ignore-scripts', '--pack-destination', root],
      { cwd: join(repo, 'packages/core') },
    )
    const [{ filename }] = JSON.parse(packed.stdout)
    const extracted = join(root, 'extracted')
    await mkdir(extracted)
    await run('tar', ['-xzf', join(root, filename), '-C', extracted])
    const output = await run('node', [
      '--input-type=module',
      '-e',
      `
      import assert from 'node:assert/strict';
      import { pathToFileURL } from 'node:url';
      const namespace = await import(pathToFileURL(process.argv[1]).href);
      const required = JSON.parse(process.argv[2]);
      const missing = required.filter(name => typeof namespace[name] !== 'function');
      assert.deepEqual(missing, [], 'Missing packed Core functions: ' + missing.join(', '));
      console.log(JSON.stringify({ checked: required.length, required, exports: Object.keys(namespace).length }));
    `,
      join(extracted, 'package/dist/index.js'),
      JSON.stringify(required),
    ])
    const checked = JSON.parse(output.stdout)
    expect(checked.checked).toBe(required.length)
    expect(checked.required).toEqual(required)
    expect(checked.exports).toBeGreaterThanOrEqual(required.length)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('long state-home publication reuses its runtime lock without depending on relocation admission', async () => {
  const scratch = join(repo, 'target', 'scratch')
  await mkdir(scratch, { recursive: true })
  const root = await mkdtemp(join(scratch, 'long-state-home-'))
  try {
    const output = await run(
      'node',
      [
        '--input-type=module',
        '-e',
        `
      import assert from 'node:assert/strict';
      import { join } from 'node:path';
      import * as core from './packages/core/dist/index.js';
      import * as api from '@cortexkit/private-files';
      import { isolatedEnvironment } from './scripts/windows/harness.mjs';
      import { verifyLongStateHomeRuntimePublication } from './scripts/windows/packed-readers.mjs';
      const result = { files: {}, dacls: {} };
      const evidence = await verifyLongStateHomeRuntimePublication({
        core: {
          ...core,
          decideOpenCodeStateLayout() {
            throw new Error('Publication must not depend on relocation admission');
          },
        },
        api,
        env: isolatedEnvironment(process.argv[1]),
        root: process.argv[1],
        result,
      });
      assert(evidence.runtimePathLength > 260);
      assert.equal(evidence.runtimeLockCycles, 2);
      assert.equal(result.dacls['long-state-home-runtime'].ok, true);
      assert.match(result.files['long-state-home-runtime'], /^[a-f0-9]{64}$/);
      const admitted = await core.decideOpenCodeStateLayout({
        role: 'opencode1',
        home: process.argv[1],
        moveEnabled: false,
        env: {
          ...isolatedEnvironment(process.argv[1]),
          OPENCODE_CONFIG_DIR: join(process.argv[1], 'long-state-home-config'),
          XDG_STATE_HOME: join(process.argv[1], 'long-state-base', ...Array.from({ length: 8 }, (_, i) => 'segment-' + i + '-' + 'x'.repeat(28))),
        },
      });
      assert.equal(admitted.kind, 'state-home', 'The fixture must pass real committed-layout admission');
      console.log(JSON.stringify(evidence));
      `,
        root,
      ],
      { cwd: repo },
    )
    const evidence = JSON.parse(output.stdout)
    expect(evidence.runtimePathLength).toBeGreaterThan(260)
    expect(evidence.runtimeLockCycles).toBe(2)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
