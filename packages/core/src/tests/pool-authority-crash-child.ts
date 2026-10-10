import { join } from 'node:path'
import type {
  NativeMigrationInput,
  NativeMigrationPhase,
} from '../pool-authority.ts'
import { type NativePoolPaths, resolveNativePoolPaths } from '../pool-paths.ts'

async function checkWindowsPaths(): Promise<void> {
  const { mock } = await import('bun:test')
  const path = await import('node:path')
  const win = path.win32
  // Mock Windows absolute-path, normalization and parsing rules, plus the path
  // separator, only in this child. The parent's Node path module stays unchanged.
  mock.module('node:path', () => ({ ...path, ...win, default: win }))
  let lockCalls = 0
  let filesystemCalls = 0
  let writes = 0
  const reachedLock = new Error('Structural path boundary reached')
  mock.module('@cortexkit/common-auth/fs', () => ({
    withLock: async () => {
      lockCalls++
      throw reachedLock
    },
    writeJsonAtomic: async () => {
      writes++
      throw new Error('Unexpected journal write')
    },
  }))
  const fs = await import('node:fs/promises')
  mock.module('node:fs/promises', () =>
    Object.fromEntries(
      Object.keys(fs).map((key) => [
        key,
        async () => {
          filesystemCalls++
          throw new Error('Physical filesystem access is forbidden')
        },
      ]),
    ),
  )
  const { beginNativeMigration } = await import('../pool-authority.ts')
  const roots = [
    'C:\\Users\\synthetic\\AppData\\pool',
    '\\\\server\\share\\synthetic\\pool',
  ]
  let canonicalWindowsPaths = true
  let acceptedCaptures = 0
  let rejectedCaptures = 0
  for (const root of roots) {
    const paths: NativePoolPaths = {
      legacyConfig: win.join(root, 'legacy-config.json'),
      legacyState: win.join(root, 'legacy-state.json'),
      config: win.join(root, 'pool-config.json'),
      state: win.join(root, 'pool-state.json'),
      runtime: win.join(root, 'runtime.json'),
      roster: win.join(root, 'roster.json'),
      journal: win.join(root, 'journal.json'),
      storageId: 'f'.repeat(64),
    }
    const input: NativeMigrationInput = {
      host: 'opencode',
      sources: {
        config: null,
        state: null,
        hostAuth: 'absent',
        routing: 'c'.repeat(64),
      },
      routingPaths: {
        source: win.join(root, 'legacy-routing.json'),
        destination: win.join(root, 'native-routing.json'),
      },
      hostAuthPath: win.join(root, 'auth.json'),
    }
    canonicalWindowsPaths &&= [
      input.hostAuthPath,
      ...Object.values(input.routingPaths),
    ].every((value) => win.isAbsolute(value) && win.normalize(value) === value)
    try {
      await beginNativeMigration(paths, input)
    } catch (error) {
      if (error === reachedLock) acceptedCaptures++
    }
    if (root !== roots[0]) continue
    for (const invalidPath of [
      'relative\\auth.json',
      'C:auth.json',
      '\\auth.json',
      'C:\\',
      '\\\\server\\share\\',
      'C:\\tmp\\auth\\',
      'C:\\tmp\\\\auth.json',
      'C:\\tmp\\.\\auth.json',
      'C:\\tmp\\..\\auth.json',
      'C:/tmp/auth.json',
      'C:\\tmp\\auth\n.json',
    ]) {
      for (const invalid of [
        { ...input, hostAuthPath: invalidPath },
        {
          ...input,
          routingPaths: { ...input.routingPaths, source: invalidPath },
        },
        {
          ...input,
          routingPaths: { ...input.routingPaths, destination: invalidPath },
        },
      ]) {
        try {
          await beginNativeMigration(paths, invalid)
        } catch (error) {
          if (
            error instanceof Error &&
            'code' in error &&
            error.code === 'invalid-journal'
          )
            rejectedCaptures++
        }
      }
    }
  }
  console.log(
    JSON.stringify({
      canonicalWindowsPaths,
      acceptedCaptures,
      rejectedCaptures,
      lockCalls,
      filesystemCalls,
      writes,
    }),
  )
}

const root = process.argv[2]
const action = process.argv[3]
const point = process.argv[4]
if (
  !root ||
  !action ||
  !point ||
  (action !== 'native-controller' &&
    point !== 'before-write' &&
    point !== 'after-write')
)
  throw new Error('Invalid fixture arguments')
if (action === 'windows-paths') {
  await checkWindowsPaths()
  process.exit(0)
}
const {
  advanceNativeMigration,
  beginNativeMigration,
  recordNativeMigrationExpectations,
} = await import('../pool-authority.ts')
const paths = await resolveNativePoolPaths(
  join(root, 'anthropic-auth.json'),
  join(root, 'anthropic-auth-state.json'),
)
if (action === 'native-readd') {
  const { createNativePoolStore } = await import('../pool-store.ts')
  const { nativeQuotaCodec } = await import('../native-quota-codec.ts')
  await createNativePoolStore({ paths, quota: nativeQuotaCodec }).add({
    id: 'primary-route',
    credential: {
      type: 'oauth',
      access: 'synthetic-access-main',
      refresh: 'synthetic-refresh-main',
      expires: 2000,
    },
  })
  process.exit(0)
}
if (action === 'native-controller') {
  const { runNativeMigration } = await import('../native-migration.ts')
  const host = process.argv[5] === 'pi' ? 'pi' : 'opencode'
  await runNativeMigration(
    {
      paths,
      host,
      hostAuthPath: join(root, 'host-auth.json'),
      routingSourcePath: join(root, 'legacy-routing.json'),
      routingDestinationPath: join(root, 'native-routing.json'),
      env: {},
      removePiAnthropicAuth: true,
      processFence: async () => {},
    },
    {
      onStep: async (step) => {
        if (step === point) process.exit(19)
      },
      hostWrite: {
        beforeRename: async () => {
          if (point === 'host:before-rename') process.exit(19)
        },
        afterRename: async () => {
          if (point === 'host:after-rename') process.exit(19)
        },
        afterUnlink: async () => {
          if (point === 'host:after-unlink') process.exit(19)
        },
      },
    },
  )
  throw new Error('Expected controller fixture exit')
}
const hooks = {
  onWriteStep: async (step: 'before-write' | 'after-write') => {
    if (step === point) process.exit(19)
  },
}
if (action === 'building') {
  await beginNativeMigration(
    paths,
    {
      host: 'opencode',
      sources: {
        config: 'a'.repeat(64),
        state: 'b'.repeat(64),
        hostAuth: 'absent',
        routing: 'c'.repeat(64),
      },
      routingPaths: {
        source: join(root, 'legacy-routing.json'),
        destination: join(root, 'native-routing.json'),
      },
      hostAuthPath: join(root, 'host-auth.json'),
    },
    hooks,
  )
} else if (action === 'expectations') {
  await recordNativeMigrationExpectations(
    paths,
    {
      expectedHostAuth: 'd'.repeat(64),
      expectedRouting: 'e'.repeat(64),
      preparedProof: { version: 1, rows: [], runtimeDigest: 'f'.repeat(64) },
    },
    hooks,
  )
} else {
  const transitions = new Map<
    string,
    [NativeMigrationPhase, NativeMigrationPhase]
  >([
    ['verified', ['building', 'verified']],
    ['activation-installed', ['verified', 'activation-installed']],
    ['committed', ['activation-installed', 'committed']],
    ['retired', ['committed', 'retired']],
  ])
  const transition = transitions.get(action)
  if (!transition) throw new Error('Invalid fixture transition')
  await advanceNativeMigration(paths, transition[0], transition[1], hooks)
}
throw new Error('Expected fixture exit')
