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
    // npm 11 prints an array of records, npm 12 an object keyed by package name.
    const parsed = JSON.parse(packed.stdout)
    const [{ filename }] = Array.isArray(parsed)
      ? parsed
      : Object.values(parsed as Record<string, { filename: string }>)
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
