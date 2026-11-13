import { expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { relative, resolve } from 'node:path'
import { parse } from '@babel/parser'

type AstNode = { type: string; [key: string]: unknown }
const isNode = (value: unknown): value is AstNode =>
  value !== null && typeof value === 'object' && 'type' in value

function propertyName(node: unknown): string | undefined {
  if (!isNode(node)) return undefined
  if (node.type === 'Identifier') return String(node.name)
  if (node.type === 'StringLiteral') return String(node.value)
  return undefined
}

function accessPath(
  node: unknown,
  aliases: Map<string, string[]>,
): string[] | undefined {
  if (!isNode(node)) return undefined
  if (node.type === 'Identifier')
    return aliases.get(String(node.name)) ?? [String(node.name)]
  if (
    node.type === 'TSAsExpression' ||
    node.type === 'TSNonNullExpression' ||
    node.type === 'TSSatisfiesExpression'
  )
    return accessPath(node.expression, aliases)
  if (node.type === 'LogicalExpression') return accessPath(node.left, aliases)
  if (
    node.type !== 'MemberExpression' &&
    node.type !== 'OptionalMemberExpression'
  )
    return undefined
  const object = accessPath(node.object, aliases)
  const property = propertyName(node.property)
  if (!object || !property) return undefined
  if (
    node.computed &&
    isNode(node.property) &&
    node.property.type !== 'StringLiteral'
  )
    return undefined
  return [...object, property]
}

function directReads(source: string): string[] {
  const ast = parse(source, { sourceType: 'module', plugins: ['typescript'] })
  const found: string[] = []
  function check(path: string[] | undefined) {
    const field = path?.slice(-2).join('.')
    if (
      field === 'claudeCache.enabled' ||
      field === 'quota.enabled' ||
      field === 'quota.failClosedOnUnknownQuota'
    )
      found.push(field)
  }
  function bind(
    pattern: unknown,
    path: string[],
    aliases: Map<string, string[]>,
  ) {
    if (!isNode(pattern)) return
    if (pattern.type === 'Identifier') aliases.set(String(pattern.name), path)
    if (pattern.type === 'AssignmentPattern') bind(pattern.left, path, aliases)
    if (pattern.type !== 'ObjectPattern' || !Array.isArray(pattern.properties))
      return
    for (const property of pattern.properties) {
      if (!isNode(property) || property.type !== 'ObjectProperty') continue
      const name = propertyName(property.key)
      if (!name) continue
      const childPath = [...path, name]
      check(childPath)
      bind(property.value, childPath, aliases)
    }
  }
  function visit(
    node: AstNode,
    parent: AstNode | undefined,
    aliases: Map<string, string[]>,
  ) {
    if (node.type === 'BlockStatement' || node.type.includes('Function'))
      aliases = new Map(aliases)
    if (Array.isArray(node.params)) {
      for (const param of node.params) {
        if (!isNode(param)) continue
        bind(
          param,
          param.type === 'Identifier' ? [String(param.name)] : [],
          aliases,
        )
      }
    }
    if (node.type === 'VariableDeclarator') {
      const path = accessPath(node.init, aliases)
      if (path) bind(node.id, path, aliases)
    }
    if (node.type === 'AssignmentExpression' && node.operator === '=') {
      const path = accessPath(node.right, aliases)
      if (path) bind(node.left, path, aliases)
    }
    if (
      (node.type === 'MemberExpression' ||
        node.type === 'OptionalMemberExpression') &&
      !(
        parent?.type === 'AssignmentExpression' &&
        parent.left === node &&
        parent.operator === '='
      )
    )
      check(accessPath(node, aliases))
    for (const value of Object.values(node)) {
      if (isNode(value)) visit(value, node, aliases)
      else if (Array.isArray(value)) {
        for (const child of value)
          if (isNode(child)) visit(child, node, aliases)
      }
    }
  }
  visit(ast.program as unknown as AstNode, undefined, new Map())
  return found
}

test.each([
  ['storage.claudeCache?.enabled', 'claudeCache.enabled'],
  ['storage["quota"]["enabled"]', 'quota.enabled'],
  ['storage.quota?.failClosedOnUnknownQuota', 'quota.failClosedOnUnknownQuota'],
  ['const { quota: { enabled } } = storage', 'quota.enabled'],
  [
    'const { claudeCache: cache } = storage; cache.enabled',
    'claudeCache.enabled',
  ],
  [
    'const q = storage.quota ?? {}; const alias = q; alias.enabled',
    'quota.enabled',
  ],
  [
    'let q; q = storage.quota; q.failClosedOnUnknownQuota',
    'quota.failClosedOnUnknownQuota',
  ],
  ['function reader({ quota: { enabled = true } }) {}', 'quota.enabled'],
])('the Pi reader guard detects %s', (source, field) => {
  expect(directReads(source)).toContain(field)
})

test('the Pi reader guard permits shared Core readers and unrelated enabled fields', () => {
  expect(
    directReads(`
      isCache1hPersistentlyEnabled(storage);
      quotaSnapshotPassesPolicy(quota, storage);
      killswitchPassesPolicy(quota, storage);
      isCacheKeepHybridActive(storage);
      storage.cacheKeep.enabled;
      storage.quota.enabled = true;
    `),
  ).toEqual([])
})

test('Pi has no direct three-way setting reads outside the shared Core readers', async () => {
  const root = resolve(import.meta.dir, '..')
  const found: string[] = []
  let scanned = 0
  for await (const file of new Bun.Glob('**/*.ts').scan({
    cwd: root,
    absolute: true,
  })) {
    if (file.includes('/tests/')) continue
    scanned++
    for (const field of directReads(await readFile(file, 'utf8')))
      found.push(`${relative(root, file)}: ${field}`)
  }
  expect(scanned).toBeGreaterThan(0)
  // Pi delegates these fields to Core so each reader keeps its own unset default.
  expect(found).toEqual([])
})
