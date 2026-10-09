import { afterEach, expect, test } from 'bun:test'
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { bundleCore } from './build.ts'
import {
  closeNativeTypeDeclarations,
  declarationFiles,
  moduleReferences,
  verifyNativeTypeClosure,
} from './check-native-type-closure.ts'

const workspace = resolve(import.meta.dir, '../../..')
const core = join(workspace, 'packages/core')
const roots: string[] = []

async function fixture() {
  // Consumer builds and package-manager writes stay in the isolated checkout.
  const parent = join(workspace, 'node_modules/.cache/native-closure')
  await mkdir(parent, { recursive: true })
  const root = await mkdtemp(join(parent, 'consumer-'))
  roots.push(root)
  return root
}

async function put(root: string, path: string, source: string) {
  const destination = join(root, path)
  await mkdir(resolve(destination, '..'), { recursive: true })
  await writeFile(destination, source)
}

async function run(command: string[], cwd: string): Promise<string> {
  const result = Bun.spawnSync(command, { cwd, stdout: 'pipe', stderr: 'pipe' })
  const output = result.stdout.toString() + result.stderr.toString()
  if (result.exitCode !== 0)
    throw new Error(
      `${command.join(' ')} exited ${result.exitCode}:\n${output}`,
    )
  return output
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

test('recognizes import, export, inline import types and reference edges without matching prose', () => {
  const source = `
    /// <reference path="./ambient.d.ts" />
    /// <reference types="node" />
    import type { A } from './a.js';
    export type { B } from './b.js';
    export * from './c.js';
    type D = import('./d.js').D;
    import E = require('./e.js');
    // import('./not-an-import.js')
    type Prose = "@cortexkit/common-auth/store";
  `
  expect(
    moduleReferences(source).map((edge) => [edge.kind, edge.specifier]),
  ).toEqual([
    ['module', './a.js'],
    ['module', './b.js'],
    ['module', './c.js'],
    ['module', './d.js'],
    ['module', './e.js'],
    ['path', './ambient.d.ts'],
    ['types', 'node'],
  ])
})

test('rejects unsupported published producer versions before copying declarations', async () => {
  const root = await fixture()
  const dist = join(root, 'dist')
  const producer = join(root, 'producer')
  await put(
    producer,
    'package.json',
    JSON.stringify({
      version: '0.9.0',
      exports: { './store': { types: './dist/store.d.ts' } },
    }),
  )
  await put(producer, 'LICENSE', 'Synthetic test license')
  await put(producer, 'dist/store.d.ts', 'export interface Store {}')
  await put(dist, 'index.js', 'export const ready = true;')
  await put(
    dist,
    'index.d.ts',
    `export type { Store } from '@cortexkit/common-auth/store';`,
  )

  await expect(closeNativeTypeDeclarations(dist, producer)).rejects.toThrow(
    'Expected published common-auth 0.11.7, got 0.9.0',
  )
  expect(await readdir(dist)).not.toContain('internal-types')
})

test('copies the complete published relative declaration graph including cycles and directives', async () => {
  const root = await fixture()
  const dist = join(root, 'dist')
  const producer = join(root, 'producer')
  await put(
    producer,
    'package.json',
    JSON.stringify({
      version: '0.11.7',
      exports: { './store': { types: './dist/store/index.d.ts' } },
    }),
  )
  await put(producer, 'LICENSE', 'Synthetic test license')
  await put(producer, 'dist/store/index.d.ts', `export * from './pool.js';`)
  await put(
    producer,
    'dist/store/pool.d.ts',
    `
    /// <reference path="../ambient.d.ts" />
    import type { Lock } from '../fs/lock.js';
    export type Store = Lock & import('./schema.js').Row;
  `,
  )
  await put(
    producer,
    'dist/fs/lock.d.ts',
    `export interface Lock { release(): void }`,
  )
  await put(
    producer,
    'dist/ambient.d.ts',
    `export {}; declare global { interface SyntheticAmbient { active: true } }`,
  )
  await put(
    producer,
    'dist/store/schema.d.ts',
    `import type { Store } from './pool.js'; export interface Row { previous?: Store }`,
  )
  await put(dist, 'index.js', 'export const ready = true;')
  await put(dist, 'index.d.ts', `export * from './facade.js';`)
  await put(
    dist,
    'facade.d.ts',
    `import type { Store } from '@cortexkit/common-auth/store'; export declare function open(): Store;`,
  )
  expect(await closeNativeTypeDeclarations(dist, producer)).toBe(5)
  expect(await readFile(join(dist, 'internal-types/LICENSE'), 'utf8')).toBe(
    'Synthetic test license',
  )
  expect(await declarationFiles(join(dist, 'internal-types'))).toHaveLength(5)
  expect(await verifyNativeTypeClosure(dist)).toContain(
    '7 relative declaration edges',
  )
  await rm(join(dist, 'internal-types/fs/lock.d.ts'))
  await expect(verifyNativeTypeClosure(dist)).rejects.toThrow(
    'missing declaration dependency ../fs/lock.js',
  )
})

test('closure refuses a producer dependency outside the public barrel and escaped specifiers', async () => {
  const root = await fixture()
  await put(root, 'index.js', 'export const ready = true;')
  await put(root, 'index.d.ts', 'export const ready: true;')
  await put(
    root,
    'nested/unused.d.ts',
    `export type Leaked = import('@cortexkit/common-auth/store').PoolStore;`,
  )
  await expect(verifyNativeTypeClosure(root)).rejects.toThrow(
    'nested/unused.d.ts: producer specifier',
  )
  await put(
    root,
    'nested/unused.d.ts',
    String.raw`export type Leaked = import('@cortexkit/comm\u006fn-auth/store').PoolStore;`,
  )
  await expect(verifyNativeTypeClosure(root)).rejects.toThrow(
    'producer specifier',
  )
})

test('closure refuses declaration dependencies escaping the packed tree', async () => {
  const root = await fixture()
  await put(root, 'outside.d.ts', 'export interface Outside {}')
  await put(root, 'dist/index.js', 'export const ready = true;')
  await put(root, 'dist/index.d.ts', `export * from '../outside.js';`)
  await expect(verifyNativeTypeClosure(join(root, 'dist'))).rejects.toThrow(
    'Declaration dependency escapes',
  )
})

test('Core bundles published preferences but keeps jsonc-parser external', async () => {
  const root = await fixture()
  const entrypoint = join(root, 'preferences.ts')
  const outfile = join(root, 'preferences.js')
  await writeFile(
    entrypoint,
    `export { readTuiPreferences } from '@cortexkit/common-auth/tui-prefs';`,
  )
  await bundleCore({ entrypoint, outfile })
  const source = await readFile(outfile, 'utf8')
  const specifiers = moduleReferences(source, false).map(
    (edge) => edge.specifier,
  )
  expect(specifiers).toContain('jsonc-parser')
  expect(
    specifiers.some((specifier) =>
      specifier.startsWith('@cortexkit/common-auth'),
    ),
  ).toBe(false)
  expect(
    specifiers.some(
      (specifier) =>
        specifier.startsWith('@opentui/') || specifier === 'solid-js',
    ),
  ).toBe(false)
})

test('packed Core types and Node runtime work in a fresh consumer without common-auth', async () => {
  const root = await fixture()
  console.log(`Packaging probe: Bun ${Bun.version}`)
  console.log(await run([process.execPath, 'run', 'build'], core))
  await run([process.execPath, 'pm', 'pack', '--destination', root], core)
  const archives = (await readdir(root)).filter((file) => file.endsWith('.tgz'))
  expect(archives).toHaveLength(1)
  const manifest = JSON.parse(
    await readFile(join(core, 'package.json'), 'utf8'),
  )
  expect(manifest.dependencies['jsonc-parser']).toBe('^3.3.1')
  expect(manifest.dependencies['@cortexkit/common-auth']).toBeUndefined()
  const consumer = join(root, 'prefix')
  await put(
    consumer,
    'package.json',
    JSON.stringify({
      private: true,
      type: 'module',
      dependencies: {
        '@cortexkit/anthropic-auth-core': `file:../${archives[0]}`,
        '@types/bun': '1.4.2',
        typescript: '7.0.2',
      },
    }),
  )
  console.log(
    await run(
      [process.execPath, 'install', '--production', '--ignore-scripts'],
      consumer,
    ),
  )
  const installed = join(
    consumer,
    'node_modules/@cortexkit/anthropic-auth-core',
  )
  const allInstalled = await readdir(join(consumer, 'node_modules'), {
    recursive: true,
  })
  expect(
    allInstalled.some((path) =>
      /(?:^|\/)@cortexkit\/common-auth(?:\/|$)/.test(path),
    ),
  ).toBe(false)
  console.log(await verifyNativeTypeClosure(join(installed, 'dist')))
  // Parse every published declaration, including ones not re-exported yet.
  const declarations = await declarationFiles(join(installed, 'dist'))
  await put(
    consumer,
    'tsconfig.json',
    JSON.stringify({
      compilerOptions: {
        strict: true,
        noEmit: true,
        skipLibCheck: false,
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        target: 'ESNext',
        allowImportingTsExtensions: true,
        types: ['bun'],
      },
      files: ['consumer.ts', ...declarations],
    }),
  )
  await put(
    consumer,
    'consumer.ts',
    `
    import { createNativePoolStore, resolveNativePoolPaths, type NativePoolStoreOptions, type NativeLockEvent } from '@cortexkit/anthropic-auth-core';
    import * as core from '@cortexkit/anthropic-auth-core';
    import type {
      NativeLocalCredentialService, NativeLocalCredentialServiceOptions, NativeRefreshRequest, NativeRefreshResult,
      NativeCustody, NativeCustodyOptions, NativeCustodyIdentity, NativeCustodyReceipt,
      NativeMenuExecutor, NativeMenuExecutorOptions, NativeMenuHost, NativeMenuModel,
    } from '@cortexkit/anthropic-auth-core';
    const localFactory: (options: NativeLocalCredentialServiceOptions) => NativeLocalCredentialService = core.createNativeLocalCredentialService;
    const custodyFactory: (options: NativeCustodyOptions) => NativeCustody = core.createNativeCustody;
    const menuFactory: (options: NativeMenuExecutorOptions) => NativeMenuExecutor = core.createNativeMenuExecutor;
    const menuModel: (host: NativeMenuHost) => NativeMenuModel = core.getNativeMenuModel;
    type LocalAuthorize = (request: NativeRefreshRequest) => Promise<NativeRefreshResult>;
    type CustodyAuthorize = (identity: NativeCustodyIdentity, signal?: AbortSignal) => Promise<NativeCustodyReceipt>;
    type NativeAuthorize = NativeLocalCredentialService['authorize'] extends LocalAuthorize ? true : false;
    type ScopedAuthorize = NativeCustody['authorize'] extends CustodyAuthorize ? true : false;
    const localContract: NativeAuthorize = true;
    const scopedContract: ScopedAuthorize = true;
    void [localFactory, custodyFactory, menuFactory, menuModel, localContract, scopedContract];
    const paths = await resolveNativePoolPaths('./account.json', './state.json');
    const options: NativePoolStoreOptions = {
      paths, quota: { validate: () => true, merge: (_, value) => value },
      onStep: async (step, info) => { const name: string = step; const id: string | undefined = info.rowId; void [name, id]; },
      hold: (point, id) => { const name: 'refresh-before-provider' | 'pull-before-request' = point; void [name, id]; },
      logger: { warn: (message) => { const text: string = message; void text; } },
      onLockEvent: (event) => {
        const phase: 'acquired' | 'released' | 'contended' = event.type;
        const diagnostic: NativeLockEvent = event;
        const fields: string[] = [event.name, event.path];
        void [phase, diagnostic, fields];
      },
      onLockStep: async (lock, step) => { const text: string = lock.path + step; void text; },
    };
    const store = createNativePoolStore(options);
    const wideObserver = (event: NativeLockEvent): void => { void event; };
    const compatible: NativePoolStoreOptions = { ...options, onLockEvent: wideObserver };
    const oldProducerRecord: { type: 'acquired' | 'released'; name: string; path: string } = { type: 'acquired', name: 'synthetic', path: paths.state };
    compatible.onLockEvent?.(oldProducerRecord);
    const contention: Parameters<NonNullable<NativePoolStoreOptions['onLockEvent']>>[0] = { type: 'contended', name: 'synthetic', path: paths.state };
    options.onLockEvent?.(contention);
    type ClosedEvent = NativeLockEvent['type'] extends 'acquired' | 'released' | 'contended' ? true : false;
    const closed: ClosedEvent = true;
    void closed;
    const roster: string = paths.roster;
    await store.add({ id: 'synthetic', credential: { type: 'oauth', access: 'synthetic-access', refresh: 'synthetic-refresh', expires: 4000000000000 } });
    const loaded = await store.read();
    if (loaded.status === 'ready') { const candidates: boolean[] = loaded.rows.map(row => row.candidate); void candidates; }
    void [core, roster];
  `,
  )
  const tsc = join(consumer, 'node_modules/.bin/tsc')
  console.log(await run([tsc, '--version'], consumer))
  const typeOutput = await run(
    [tsc, '-p', 'tsconfig.json', '--listFiles'],
    consumer,
  )
  const checked = typeOutput.trim().split('\n')
  // This prefix is in the worktree: reject accidental ancestor/hoisted type resolution.
  expect(checked.length).toBeGreaterThan(declarations.length)
  expect(checked.every((path) => path.startsWith(`${consumer}/`))).toBe(true)
  console.log(
    `Consumer tsc: ${checked.length} files checked, all within the fresh prefix`,
  )
  await put(
    consumer,
    'narrow.ts',
    `
    import type { NativePoolStoreOptions } from '@cortexkit/anthropic-auth-core';
    declare const options: NativePoolStoreOptions;
    const narrowObserver = (event: { type: 'acquired' | 'released'; name: string; path: string }): void => { void event; };
    const unsafe: NativePoolStoreOptions = { ...options, onLockEvent: narrowObserver };
    void unsafe;
    `,
  )
  const consumerConfig = JSON.parse(
    await readFile(join(consumer, 'tsconfig.json'), 'utf8'),
  )
  consumerConfig.files.push('narrow.ts')
  await put(consumer, 'tsconfig.json', JSON.stringify(consumerConfig))
  const negative = Bun.spawnSync([tsc, '-p', 'tsconfig.json'], {
    cwd: consumer,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const negativeOutput = negative.stdout.toString() + negative.stderr.toString()
  console.log(negativeOutput)
  expect(negative.exitCode).toBe(1)
  expect(negativeOutput).toContain('narrow.ts')
  expect(negativeOutput).toContain('TS2322')
  expect(negativeOutput).toContain('"contended"')
  console.log('Native observer strict boundary: narrow user callback rejected')
  await put(
    consumer,
    'runtime.mjs',
    `
    import { createNativePoolStore, resolveNativePoolPaths } from '@cortexkit/anthropic-auth-core';
    import * as core from '@cortexkit/anthropic-auth-core';
    import assert from 'node:assert/strict';
    const paths = await resolveNativePoolPaths('./account.json', './state.json');
    assert.equal(paths.roster.endsWith('state.json.roster.json'), true);
    const store = createNativePoolStore({ paths, quota: { validate: () => true, merge: (_, observation) => observation } });
    await store.add({ id: 'synthetic', credential: { type: 'oauth', access: 'synthetic-access', refresh: 'synthetic-refresh', expires: 4000000000000 } });
    const loaded = await store.read();
    assert.equal(loaded.status, 'ready');
    assert.equal(loaded.rows[0].stamp, 'bound');
    assert.equal(loaded.rows[0].credential.access, 'synthetic-access');
    for (const factory of ['createNativeLocalCredentialService', 'createNativeCustody', 'getNativeMenuModel', 'createNativeMenuExecutor', 'captureNativeLocalPoolBinding']) assert.equal(typeof core[factory], 'function', factory);
    for (const host of ['opencode', 'pi']) {
      const model = core.getNativeMenuModel(host);
      assert.equal(model.host, host);
      assert.ok(model.groups.length > 0);
    }
    for (const internal of ['updateNativeRuntime', 'publishNativeLocalSuccess', 'publishNativeLocalFailure', 'assertNativePoolAuthority', 'createNativeRefreshCoordinator']) assert.equal(Object.hasOwn(core, internal), false, internal);
    console.log('Node ' + process.version + ': 18 packed runtime assertions passed');
  `,
  )
  console.log(await run(['node', 'runtime.mjs'], consumer))
}, 120_000)
