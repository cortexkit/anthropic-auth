import { expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { relative, resolve } from 'node:path'
import { parse } from '@babel/parser'
import { SETTINGS_THREE_WAY_READERS } from '@cortexkit/anthropic-auth-core'

type Key = keyof typeof SETTINGS_THREE_WAY_READERS
type AstNode = { type: string; [key: string]: unknown }
type ReadSite = {
  key: Key
  path: string
  reader: string
  helper?: string
  absent?: unknown
}
const fields = {
  claude_cache_enabled: ['claudeCache', 'enabled'],
  quota_enabled: ['quota', 'enabled'],
  quota_fail_closed_on_unknown_quota: ['quota', 'failClosedOnUnknownQuota'],
} as const
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
  if (node.type === 'TSAsExpression' || node.type === 'TSNonNullExpression')
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

function readerName(path: string, owner: string | undefined) {
  if (path === 'packages/opencode/src/v2/wire.ts' && owner === 'requestOptions')
    return 'createNativeWirePolicy transformOptions'
  if (
    path === 'packages/opencode/src/v2/source.ts' &&
    owner === 'chooseAccount'
  )
    return 'createNativeAnthropicSource chooseAccount'
  if (path === 'packages/opencode/src/v2/lifecycle.ts' && owner === 'run')
    return 'startNativeAnthropicLifecycle run'
  if (path === 'packages/opencode/src/index.ts' && owner === 'fetch')
    return 'AnthropicAuthPlugin authTransport.fetch main quota backoff check'
  return owner ?? '<unnamed>'
}

async function readSites() {
  const repoRoot = resolve(import.meta.dir, '../../../..')
  const sites: ReadSite[] = []
  for await (const file of new Bun.Glob('**/*.{ts,tsx,js,mjs}').scan({
    cwd: resolve(repoRoot, 'packages/opencode/src'),
    absolute: true,
  })) {
    if (file.includes('/tests/')) continue
    const path = relative(repoRoot, file)
    const ast = parse(await readFile(file, 'utf8'), {
      sourceType: 'module',
      plugins: ['typescript', 'jsx'],
    })
    function checkRead(
      access: string[] | undefined,
      node: AstNode,
      parent: AstNode | undefined,
      owner: string | undefined,
    ) {
      const key = (Object.keys(fields) as Key[]).find(
        (key) => fields[key].join('.') === access?.slice(-2).join('.'),
      )
      if (!key) return
      const args = parent?.arguments
      const helper =
        parent?.type === 'CallExpression' &&
        Array.isArray(args) &&
        args[0] === node
          ? propertyName(parent.callee)
          : undefined
      sites.push({
        key,
        path,
        reader: readerName(path, owner),
        helper,
        absent:
          helper && Array.isArray(args) && isNode(args[1])
            ? args[1].value
            : undefined,
      })
    }
    function bind(
      pattern: unknown,
      access: string[],
      aliases: Map<string, string[]>,
      owner: string | undefined,
    ) {
      if (!isNode(pattern)) return
      if (pattern.type === 'Identifier')
        aliases.set(String(pattern.name), access)
      if (
        pattern.type === 'ObjectPattern' &&
        Array.isArray(pattern.properties)
      ) {
        for (const property of pattern.properties) {
          if (!isNode(property) || property.type !== 'ObjectProperty') continue
          const name = propertyName(property.key)
          if (!name) continue
          const childPath = [...access, name]
          checkRead(childPath, property, undefined, owner)
          bind(property.value, childPath, aliases, owner)
        }
      }
    }
    function visit(
      node: AstNode,
      parent: AstNode | undefined,
      owner: string | undefined,
      aliases: Map<string, string[]>,
    ) {
      if (node.type === 'FunctionDeclaration') owner = propertyName(node.id)
      if (node.type === 'ObjectMethod') owner = propertyName(node.key)
      if (
        node.type === 'ArrowFunctionExpression' ||
        node.type === 'FunctionExpression'
      ) {
        if (parent?.type === 'VariableDeclarator')
          owner = propertyName(parent.id)
        if (parent?.type === 'ObjectProperty') owner = propertyName(parent.key)
      }
      if (node.type === 'BlockStatement' || node.type.includes('Function'))
        aliases = new Map(aliases)
      if (Array.isArray(node.params)) {
        for (const param of node.params) {
          if (isNode(param) && param.type === 'Identifier')
            aliases.set(String(param.name), [String(param.name)])
        }
      }
      if (node.type === 'VariableDeclarator') {
        const access = accessPath(node.init, aliases)
        if (access) bind(node.id, access, aliases, owner)
      }
      if (
        node.type === 'MemberExpression' ||
        node.type === 'OptionalMemberExpression'
      )
        checkRead(accessPath(node, aliases), node, parent, owner)
      // The OpenCode 1 cache latch and status readers delegate to Core rather
      // than reading the field directly; keep those entry points inventoried too.
      if (
        node.type === 'CallExpression' &&
        propertyName(node.callee) === 'isCache1hPersistentlyEnabled'
      )
        sites.push({
          key: 'claude_cache_enabled',
          path,
          reader:
            'AnthropicAuthPlugin (persistent cache latch via isCache1hPersistentlyEnabled)',
          helper: 'isCache1hPersistentlyEnabled',
          absent: false,
        })
      for (const value of Object.values(node)) {
        if (isNode(value)) visit(value, node, owner, aliases)
        else if (Array.isArray(value)) {
          for (const child of value)
            if (isNode(child)) visit(child, node, owner, aliases)
        }
      }
    }
    visit(ast.program as unknown as AstNode, undefined, undefined, new Map())
  }
  return sites
}

const sites = await readSites()
for (const key of Object.keys(fields) as Key[]) {
  const inventory = SETTINGS_THREE_WAY_READERS[key].filter(({ path }) =>
    path.startsWith('packages/opencode/'),
  )
  test(`${key}: every OpenCode reader is named in the schema inventory`, () => {
    expect(
      [
        ...new Set(
          sites
            .filter((site) => site.key === key)
            .map(({ path, reader }) => `${path}:${reader}`),
        ),
      ].sort(),
    ).toEqual(inventory.map(({ path, reader }) => `${path}:${reader}`).sort())
  })
  for (const reader of inventory) {
    test(`${key}: ${reader.reader} uses the shared six-input reader with its own absence default`, () => {
      const reads = sites.filter(
        (site) =>
          site.key === key &&
          site.path === reader.path &&
          site.reader === reader.reader,
      )
      expect(reads.length).toBeGreaterThan(0)
      for (const read of reads) {
        expect(read.helper).toBe(
          key === 'claude_cache_enabled' && reader.path.endsWith('/index.ts')
            ? 'isCache1hPersistentlyEnabled'
            : 'readThreeWayBoolean',
        )
        expect(read.absent).toBe(reader.absent)
      }
    })
  }
}
