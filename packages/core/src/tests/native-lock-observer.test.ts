import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { nativeLockObserver } from '../native-lock-observer.ts'

test('absent native observer stays absent', () => {
  expect(nativeLockObserver(undefined)).toBeUndefined()
})

test('native diagnostics isolate throwing then accessors and preserve event fields', () => {
  const event = {
    type: 'contended' as const,
    name: 'synthetic',
    path: '/synthetic',
  }
  let received: unknown
  let inspected = 0
  const notify = nativeLockObserver((value) => {
    received = value
    return Object.defineProperty({}, 'then', {
      get() {
        inspected++
        throw new Error('diagnostic accessor')
      },
    })
  })
  expect(() => notify?.(event)).not.toThrow()
  expect(received).toBe(event)
  expect(inspected).toBe(1)
})

// Rejections must be observed by the runtime, not hidden by the test runner's
// rejection handling. Each child exercises the real store and native handoff.
const childSource = `
  import assert from 'node:assert/strict';
  import { setImmediate } from 'node:timers/promises';
  import { resolveNativePoolPaths } from './packages/core/src/pool-paths.ts';
  import { createNativePoolStore } from './packages/core/src/pool-store.ts';
  import { captureNativeLocalPoolBinding } from './packages/core/src/pool-binding.ts';
  import { createNativeRefreshCoordinator, nativeAccountProviderLock } from './packages/core/src/native-refresh-coordinator.ts';
  import { tokenFingerprint } from './packages/core/src/token-fingerprint.ts';
  import { fingerprintOf } from '@cortexkit/common-auth/store';
  const { root, target, mode } = JSON.parse(process.env.NATIVE_OBSERVER_PROBE);
  process.on('unhandledRejection', (error) => {
    console.error('ESCAPED DIAGNOSTIC REJECTION', error);
    process.exitCode = 1;
  });
  const paths = await resolveNativePoolPaths(root + '/account.json', root + '/state.json');
  const quota = { validate: () => true, merge: (_, value) => value };
  const store = createNativePoolStore({ paths, quota });
  await store.initialize();
  await store.add({ id: 'a', credential: { type: 'oauth', access: 'old', refresh: 'old-refresh', expires: 4000000000000 } });
  const read = await store.read();
  assert.equal(read.status, 'ready');
  const binding = captureNativeLocalPoolBinding(paths, read.rows[0]);
  const handoff = nativeAccountProviderLock(paths, 'A');
  const events = [];
  let bootstraps = 0;
  let providers = 0;
  let persisted;
  const coordinator = createNativeRefreshCoordinator({
    paths, quota,
    onLockEvent: (event) => {
      if (target === 'handoff' && event.name !== handoff.name) return;
      if (target === 'store' && event.name !== 'pool-state') return;
      assert.equal(event.path, paths.state);
      events.push(event.type);
      if (mode === 'throw') throw new Error('diagnostic throw');
      if (mode === 'reject') return Promise.reject(new Error('diagnostic rejection'));
      if (mode === 'thenable') return { then: (_, reject) => reject(new Error('diagnostic thenable rejection')) };
      if (mode === 'never') return new Promise(() => {});
      throw new Error('unknown probe mode');
    },
    refreshToken: async () => {
      providers++;
      return { type: 'oauth', access: 'new', refresh: 'new-refresh', expires: 4000000000000, expiresIn: 3600 };
    },
    resolveIdentity: async () => {
      bootstraps++;
      return { deviceId: 'd', sessionId: 's', accountUuid: 'A' };
    },
    readRestrictions: async (subject) => ({
      restriction: { status: 'allowed' },
      context: { subject, runtimeBinding: subject.binding, refreshErrorClearedAt: null, quotaErrorClearedAt: null, quotaErrorGeneration: null },
    }),
    reconcile: async (event) => { if (event.status === 'persisted') persisted = event; },
    readAdmission: async (subject) => ({ status: 'proven', validation: subject }),
  });
  const result = await coordinator.authorize({ mode: 'local', intent: 'refresh', binding });
  assert.equal(result.status, 'usable');
  assert.equal(result.access, 'new');
  assert.equal(bootstraps, 1);
  assert.equal(providers, 1);
  assert.equal(persisted.handoff, 'acquired');
  assert.equal(persisted.bootstrap, 'resolved');
  assert.equal(persisted.identity, 'A');
  assert.equal(persisted.committed.version.accessFingerprint, tokenFingerprint('new'));
  const loaded = await store.read();
  assert.equal(loaded.rows[0].credential.access, 'new');
  assert.equal(loaded.rows[0].identity, 'A');
  assert.equal(loaded.rows[0].fingerprint, fingerprintOf(loaded.rows[0].credential));
  assert.ok(events.includes('acquired'));
  assert.ok(events.includes('released'));
  assert.equal(events.includes('contended'), false);
  if (target === 'handoff') assert.deepEqual(events, ['acquired', 'released']);
  await setImmediate();
  await setImmediate();
  console.log('native diagnostic probe passed: ' + target + '/' + mode);
`

for (const target of ['store', 'handoff']) {
  for (const mode of ['throw', 'reject', 'thenable', 'never']) {
    test(`native ${target} diagnostics isolate ${mode} returns in a child`, () => {
      const workspace = resolve(import.meta.dir, '../../../..')
      const parent = join(
        workspace,
        'node_modules/.cache/native-observer-children',
      )
      mkdirSync(parent, { recursive: true })
      const root = mkdtempSync(join(parent, 'probe-'))
      try {
        const child = Bun.spawnSync([process.execPath, '--eval', childSource], {
          cwd: workspace,
          env: {
            ...process.env,
            NATIVE_OBSERVER_PROBE: JSON.stringify({ root, target, mode }),
          },
          stdout: 'pipe',
          stderr: 'pipe',
          timeout: 10_000,
        })
        const output = child.stdout.toString() + child.stderr.toString()
        expect({
          exitCode: child.exitCode,
          stderr: child.stderr.toString(),
        }).toEqual({
          exitCode: 0,
          stderr: '',
        })
        expect(output).toContain(
          `native diagnostic probe passed: ${target}/${mode}`,
        )
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }, 15_000)
  }
}
