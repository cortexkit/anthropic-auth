import { expect, test } from 'bun:test'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)
const helper = new URL('relocation-move.mjs', import.meta.url).href
const core = new URL('../../packages/core/dist/index.js', import.meta.url).href
const harness = new URL('harness.mjs', import.meta.url).href

test('open diagnostics retain real operation, flags and basename without fixture paths, then restore Node exports', async () => {
  const root = await mkdtemp(join(tmpdir(), 'relocation-opens-'))
  try {
    const output = await run('node', [
      '--input-type=module',
      '-e',
      `
      import assert from 'node:assert/strict';
      import fs from 'node:fs';
      import fsPromises, { open } from 'node:fs/promises';
      import { join } from 'node:path';
      import { withOpenDiagnostics } from ${JSON.stringify(helper)};
      const before = { open, sync: fs.openSync, callback: fs.open };
      const failures = [];
      const path = join(process.argv[1], 'config-dir.json.11111111-1111-4111-8111-111111111111.tmp');
      await withOpenDiagnostics(async () => {
        await assert.rejects(open(path, 'r+'), { code: 'ENOENT' });
        assert.throws(() => fs.openSync(path, fs.constants.O_RDWR), { code: 'ENOENT' });
        await new Promise(resolve => fs.open(path, 'r', error => { assert.equal(error.code, 'ENOENT'); resolve(); }));
      }, failures);
      assert.equal(open, before.open);
      assert.equal(fsPromises.open, before.open);
      assert.equal(fs.openSync, before.sync);
      assert.equal(fs.open, before.callback);
      assert.deepEqual(failures.map(item => item.flags), ['r+', fs.constants.O_RDWR, 'r']);
      assert.equal(failures.length, 3);
      for (const entry of failures) {
        assert.equal(entry.operation, 'open');
        assert.equal(entry.basename, 'config-dir.json.11111111-1111-4111-8111-111111111111.tmp');
        assert.equal(entry.fileKind, 'config-marker-stage');
        assert(!JSON.stringify(entry).includes(process.argv[1]));
      }
      console.log(JSON.stringify({ checks: 3 }));
      `,
      root,
    ])
    expect(JSON.parse(output.stdout)).toEqual({ checks: 3 })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a failed real open retains its basename and flags in a failed, unqualified receipt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'relocation-receipt-'))
  try {
    await run('node', [
      '--input-type=module',
      '-e',
      `
      import assert from 'node:assert/strict';
      import { open } from 'node:fs/promises';
      import { join } from 'node:path';
      import { withOpenDiagnostics } from ${JSON.stringify(helper)};
      import { withReceipt } from ${JSON.stringify(harness)};
      const result = { platform: 'win32', profile: process.argv[1] };
      await withReceipt(join(process.argv[1], 'receipt.json'), result, async step => {
        await step('state-relocation-ordinary-path-strict', async () => {
          const failures = [];
          try { await withOpenDiagnostics(() => open(join(process.argv[1], 'config-dir.json.fixture.tmp'), 'r+'), failures); }
          catch { throw new Error(JSON.stringify({ openFailures: failures })); }
        });
      });
      assert.equal(result.status, 'failed');
      assert.equal(result.nativeWindowsQualified, false);
      console.log('failed open recorded');
      `,
      root,
    ])
    const receipt = JSON.parse(
      await readFile(join(root, 'receipt.json'), 'utf8'),
    )
    expect(receipt.steps[0].error).toContain('config-dir.json.fixture.tmp')
    expect(receipt.steps[0].error).toContain('"operation":"open"')
    expect(receipt.steps[0].error).toContain('"flags":"r+"')
    expect(JSON.stringify(receipt)).not.toContain(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

for (const pathKind of ['ordinary', 'long']) {
  test(`strict ${pathKind} relocation probe moves real files with the built Core API`, async () => {
    const root = await mkdtemp(join(tmpdir(), `relocation-${pathKind}-`))
    try {
      const output = await run('node', [
        '--input-type=module',
        '-e',
        `
        import { probeRelocationMove, withOpenDiagnostics } from ${JSON.stringify(helper)};
        const evidence = { openFailures: [] };
        await withOpenDiagnostics(async () => {
          const core = await import(${JSON.stringify(core)});
          const api = await import('@cortexkit/private-files');
          try { await probeRelocationMove(core, api, process.argv[1], ${JSON.stringify(pathKind)}, evidence); }
          finally { core.resetNativeHolderRegistryForTests(); }
        }, evidence.openFailures);
        console.log(JSON.stringify(evidence));
        `,
        root,
      ])
      const evidence = JSON.parse(output.stdout.trim().split('\n').at(-1)!)
      expect(evidence.decision).toBe('state-home')
      expect(evidence.moved).toBe(true)
      expect(evidence.reasons).toEqual([])
      expect(evidence.steps).toContain('locks-held')
      expect(evidence.steps).toContain('committed')
      expect(evidence.files.map((file: { role: string }) => file.role)).toEqual(
        ['localRuntime', 'journal'],
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
}

test('the strict probe rejects a legacy fallback and retains its reasons', async () => {
  const root = await mkdtemp(join(tmpdir(), 'relocation-fallback-'))
  try {
    const output = await run('node', [
      '--input-type=module',
      '-e',
      `
      import assert from 'node:assert/strict';
      import { probeRelocationMove } from ${JSON.stringify(helper)};
      const core = await import(${JSON.stringify(core)});
      const api = await import('@cortexkit/private-files');
      const evidence = {};
      await assert.rejects(probeRelocationMove({ ...core, decideOpenCodeStateLayout: async () => ({ kind: 'legacy', reasons: ['injected move refusal'] }) }, api, process.argv[1], 'ordinary', evidence));
      assert.equal(evidence.decision, 'legacy');
      assert.equal(evidence.moved, false);
      assert.deepEqual(evidence.reasons, ['injected move refusal']);
      console.log(JSON.stringify(evidence));
      `,
      root,
    ])
    expect(JSON.parse(output.stdout).reasons).toEqual(['injected move refusal'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('native verifier runs both strict probes with isolated child profiles and retains their evidence', async () => {
  const verifier = await readFile(
    new URL('verify.mjs', import.meta.url),
    'utf8',
  )
  expect(verifier).toContain("for (const pathKind of ['ordinary', 'long'])")
  expect(verifier).toMatch(/state-relocation-\$\{pathKind\}-path-strict/)
  expect(verifier).toContain(
    "new URL('./relocation-move.mjs', import.meta.url)",
  )
  expect(verifier).toContain('env: isolatedEnvironment(home)')
  expect(verifier).toContain('assert.equal(evidence.passed, true')
})
