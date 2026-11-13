import { expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { relative, resolve } from 'node:path'
import { parse } from '@babel/parser'
import {
  type AccountSettingsReaderInput,
  createEmptyStorage,
  failClosedOnUnknownQuota,
  getQuotaNextRefreshAt,
  isCache1hPersistentlyEnabled,
  killswitchPassesPolicy,
  type OAuthQuotaSnapshot,
  quotaEnabled,
  quotaRefusalTiming,
  quotaSnapshotPassesPolicy,
} from '../accounts.ts'
import { isCacheKeepHybridActive } from '../cachekeep.ts'
import { SETTINGS_THREE_WAY_READERS } from '../settings-definition.ts'
import {
  readThreeWayBoolean,
  type ThreeWayBoolean,
} from '../settings-three-way.ts'

const inputs = [true, false, undefined, 'on', 'off', 'default'] as const
const now = Date.parse('2026-11-02T10:00:00Z')
const resetAt = now + 60_000
const quota: OAuthQuotaSnapshot = {
  accountIdentity: 'current',
  five_hour: {
    remainingPercent: 10,
    usedPercent: 90,
    checkedAt: now,
    resetsAt: new Date(resetAt).toISOString(),
  },
  seven_day: {
    remainingPercent: 90,
    usedPercent: 10,
    checkedAt: now,
    resetsAt: new Date(resetAt).toISOString(),
  },
}

type Key = keyof typeof SETTINGS_THREE_WAY_READERS
type ReaderCase = {
  path: string
  reader: string
  absent: boolean
  read: (storage: AccountSettingsReaderInput) => unknown
  on: unknown
  off: unknown
}

const accountsPath = 'packages/core/src/accounts.ts'
const readers: Record<Key, ReaderCase[]> = {
  claude_cache_enabled: [
    {
      path: accountsPath,
      reader: 'isCache1hPersistentlyEnabled',
      absent: false,
      read: isCache1hPersistentlyEnabled,
      on: true,
      off: false,
    },
    {
      path: 'packages/core/src/cachekeep.ts',
      reader: 'isCacheKeepHybridActive',
      absent: false,
      read: isCacheKeepHybridActive,
      on: true,
      off: false,
    },
  ],
  quota_enabled: [
    {
      path: accountsPath,
      reader: 'quotaEnabled',
      absent: true,
      read: quotaEnabled,
      on: true,
      off: false,
    },
    {
      path: accountsPath,
      reader: 'quotaSnapshotPassesPolicy (via quotaEnabled)',
      absent: true,
      read: (storage) => quotaSnapshotPassesPolicy(quota, storage),
      on: false,
      off: true,
    },
    {
      path: accountsPath,
      reader: 'quotaRefusalTiming (via quotaEnabled)',
      absent: true,
      read: (storage) =>
        quotaRefusalTiming({
          storage,
          readings: [{ quota, accountIdentity: 'current' }],
          now,
        }).resetAt,
      on: resetAt,
      off: undefined,
    },
    {
      path: accountsPath,
      reader: 'getQuotaNextRefreshAt (via quotaEnabled)',
      absent: true,
      read: (storage) => getQuotaNextRefreshAt(quota, storage, now),
      on: resetAt + 60_000,
      off: now + 300_000,
    },
  ],
  quota_fail_closed_on_unknown_quota: [
    {
      path: accountsPath,
      reader: 'failClosedOnUnknownQuota',
      absent: true,
      read: failClosedOnUnknownQuota,
      on: true,
      off: false,
    },
    {
      path: accountsPath,
      reader: 'quotaSnapshotPassesPolicy (via failClosedOnUnknownQuota)',
      absent: true,
      read: (storage) => quotaSnapshotPassesPolicy(undefined, storage),
      on: false,
      off: true,
    },
    {
      path: accountsPath,
      reader: 'killswitchPassesPolicy (via failClosedOnUnknownQuota)',
      absent: true,
      read: (storage) => killswitchPassesPolicy(undefined, storage),
      on: false,
      off: true,
    },
  ],
}

function storageFor(key: Key, value: ThreeWayBoolean | undefined) {
  const storage: AccountSettingsReaderInput = createEmptyStorage()
  if (key === 'claude_cache_enabled') {
    storage.claudeCache = {
      mode: 'hybrid',
      ...(value === undefined ? {} : { enabled: value }),
    }
    storage.cacheKeep = { enabled: true, always: true }
  } else if (key === 'quota_enabled') {
    storage.quota = {
      minimumRemaining: { five_hour: 20, seven_day: 0 },
      ...(value === undefined ? {} : { enabled: value }),
    }
  } else {
    storage.quota = {
      enabled: true,
      ...(value === undefined ? {} : { failClosedOnUnknownQuota: value }),
    }
    // Zero floors let unknown quota reach the fail-closed choice, not a floor refusal.
    storage.killswitch = {
      enabled: true,
      main: { five_hour: 0, seven_day: 0, scoped: 0 },
    }
  }
  return storage
}

test('readThreeWayBoolean preserves both choices of absence', () => {
  for (const absent of [true, false]) {
    expect(inputs.map((value) => readThreeWayBoolean(value, absent))).toEqual([
      true,
      false,
      absent,
      true,
      false,
      absent,
    ])
  }
})

for (const key of Object.keys(readers) as Key[]) {
  test(`${key} six-input tests cover exactly the named Core readers`, () => {
    expect(
      readers[key].map(({ path, reader, absent }) => ({
        path,
        reader,
        absent,
      })),
    ).toEqual(
      SETTINGS_THREE_WAY_READERS[key].filter(({ path }) =>
        path.startsWith('packages/core/'),
      ),
    )
  })
  for (const reader of readers[key]) {
    test(`${key}: ${reader.reader} preserves legacy inputs and reads on/off/default`, () => {
      const outputs = inputs.map((value) => reader.read(storageFor(key, value)))
      const absentOutput = reader.absent ? reader.on : reader.off
      expect(outputs).toEqual([
        reader.on,
        reader.off,
        absentOutput,
        reader.on,
        reader.off,
        absentOutput,
      ])
    })
  }
}

test('null stores keep the original Core defaults', () => {
  expect(isCache1hPersistentlyEnabled(null)).toBe(false)
  expect(isCacheKeepHybridActive(null)).toBe(false)
  expect(quotaEnabled(null)).toBe(true)
  expect(failClosedOnUnknownQuota(null)).toBe(true)
})

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

test('every Core three-way field read is inventoried and uses the shared helper', async () => {
  const coreRoot = resolve(import.meta.dir, '../..')
  const repoRoot = resolve(coreRoot, '../..')
  const fields = {
    claude_cache_enabled: ['claudeCache', 'enabled'],
    quota_enabled: ['quota', 'enabled'],
    quota_fail_closed_on_unknown_quota: ['quota', 'failClosedOnUnknownQuota'],
  } as const
  const found: Record<Key, string[]> = {
    claude_cache_enabled: [],
    quota_enabled: [],
    quota_fail_closed_on_unknown_quota: [],
  }
  for await (const file of new Bun.Glob('**/*.ts').scan({
    cwd: resolve(coreRoot, 'src'),
    absolute: true,
  })) {
    if (file.includes('/tests/')) continue
    const source = await readFile(file, 'utf8')
    const ast = parse(source, { sourceType: 'module', plugins: ['typescript'] })
    function checkRead(
      path: string[] | undefined,
      node: AstNode,
      parent: AstNode | undefined,
      owner: string | undefined,
    ) {
      const key = (Object.keys(fields) as Key[]).find(
        (key) => fields[key].join('.') === path?.slice(-2).join('.'),
      )
      if (!key) return
      const location = `${relative(repoRoot, file)}:${owner ?? '<unnamed>'}`
      found[key].push(location)
      expect(
        parent?.type === 'CallExpression' &&
          isNode(parent.callee) &&
          parent.callee.type === 'Identifier' &&
          parent.callee.name === 'readThreeWayBoolean' &&
          Array.isArray(parent.arguments) &&
          parent.arguments[0] === node,
        `${location} must read ${key} through readThreeWayBoolean`,
      ).toBe(true)
    }
    function bind(
      pattern: unknown,
      path: string[],
      aliases: Map<string, string[]>,
      owner: string | undefined,
    ) {
      if (!isNode(pattern)) return
      if (pattern.type === 'Identifier') aliases.set(String(pattern.name), path)
      if (
        pattern.type === 'ObjectPattern' &&
        Array.isArray(pattern.properties)
      ) {
        for (const property of pattern.properties) {
          if (!isNode(property) || property.type !== 'ObjectProperty') continue
          const name = propertyName(property.key)
          if (!name) continue
          const childPath = [...path, name]
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
      if (node.type === 'BlockStatement' || node.type.includes('Function'))
        aliases = new Map(aliases)
      if (Array.isArray(node.params)) {
        for (const param of node.params) {
          if (isNode(param) && param.type === 'Identifier')
            aliases.set(String(param.name), [String(param.name)])
        }
      }
      if (node.type === 'VariableDeclarator') {
        const path = accessPath(node.init, aliases)
        if (path) bind(node.id, path, aliases, owner)
      }
      if (
        node.type === 'MemberExpression' ||
        node.type === 'OptionalMemberExpression'
      )
        checkRead(accessPath(node, aliases), node, parent, owner)
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
  for (const key of Object.keys(found) as Key[]) {
    expect(found[key].sort()).toEqual(
      SETTINGS_THREE_WAY_READERS[key]
        .filter(
          ({ path, reader }) =>
            path.startsWith('packages/core/') && !reader.includes(' (via '),
        )
        .map(({ path, reader }) => `${path}:${reader}`)
        .sort(),
    )
  }
})
