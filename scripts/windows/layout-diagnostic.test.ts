import { expect, test } from 'bun:test'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const repo = fileURLToPath(new URL('../../', import.meta.url))

test('layout diagnostic records path-free blocker kinds, preconditions and I/O details', async () => {
  const output = await run(
    'node',
    [
      '--input-type=module',
      '-e',
      String.raw`
    import assert from 'node:assert/strict';
    import { summarizeLayoutReason } from './scripts/windows/layout-diagnostic.mjs';
    const cases = [
      ['pid 418 of an older anthropic-auth (C:\\Users\\private name\\cachekeep\\418-uuid.json)', { kind: 'pre-n-artifact', artifactKind: 'cachekeep' }],
      ['pid 418 of an older anthropic-auth (/private/tmp/rpc/port-418.json)', { kind: 'pre-n-artifact', artifactKind: 'rpc' }],
      ["C:\\Users\\private name\\cachekeep can't be read (EACCES)", { kind: 'artifact-scan', artifactKind: 'cachekeep', detail: 'EACCES' }],
      ['/private/config/anthropic-auth-holders.json can\'t be read (invalid)', { kind: 'holder-file', artifactKind: 'unknown', detail: 'invalid' }],
      ['/private/state is the config folder itself', { kind: 'precondition', condition: 'config-folder-itself' }],
      ['/private/a and /private/b contain one another', { kind: 'precondition', condition: 'overlapping-folders' }],
      ['/private/config/file is not a regular file', { kind: 'precondition', condition: 'not-regular-file' }],
      ['/private/config/file belongs to another user', { kind: 'precondition', condition: 'other-owner' }],
      ['/private/config/file exists with no runtime and no journal', { kind: 'precondition', condition: 'missing-runtime-and-journal' }],
      ['the migration recorded in /private/journal is unfinished; run setup first', { kind: 'precondition', condition: 'unfinished-migration' }],
      ["EPERM: operation not permitted, rename 'C:\\private\\from' -> 'C:\\private\\to'", { kind: 'io-error', ioCode: 'EPERM', operation: 'rename' }],
      ['/private/unrecognized reason', { kind: 'other', ioCode: undefined, operation: undefined }],
    ];
    for (const [reason, expected] of cases) assert.deepEqual(summarizeLayoutReason(reason), expected);
    console.log(JSON.stringify({ checked: cases.length }));
  `,
    ],
    { cwd: repo },
  )
  expect(JSON.parse(output.stdout).checked).toBe(12)
})

test('layout diagnostic always passes its receipt step and captures refusals without paths', async () => {
  const scratch = join(repo, 'target', 'scratch')
  await mkdir(scratch, { recursive: true })
  const root = await mkdtemp(join(scratch, 'layout-diagnostic-'))
  try {
    const output = await run(
      'node',
      [
        '--input-type=module',
        '-e',
        String.raw`
      import assert from 'node:assert/strict';
      import { join } from 'node:path';
      import { captureStateHomeLayoutDiagnostic } from './scripts/windows/layout-diagnostic.mjs';
      import { withReceipt } from './scripts/windows/harness.mjs';
      let closed = 0;
      const env = { HOME: process.argv[1], USERPROFILE: process.argv[1] };
      const outcomes = [
        { kind: 'legacy', reasons: ['pid 418 of an older anthropic-auth (C:\\Users\\private\\418-uuid.json)'], registration: { close: async () => { closed++; } } },
        Object.assign(new Error("EPERM: operation not permitted, rename 'C:\\private\\from'"), { name: 'StateLayoutRefusalError', code: 'io-failed', cause: { code: 'EPERM' } }),
        { kind: 'state-home', registration: { close: async () => { closed++; } } },
      ];
      const evidence = [];
      for (const [i, outcome] of outcomes.entries()) {
        const result = { platform: process.platform, files: {}, dacls: {} };
        await withReceipt(join(process.argv[1], 'receipt-' + i + '.json'), result, async (step) => {
          await step('packed-long-state-home-layout-diagnostic', () => captureStateHomeLayoutDiagnostic({
            core: {
              resolveStateHomeTarget: () => ({ dir: 'x'.repeat(300) }),
              decideOpenCodeStateLayout: async (options) => {
                assert.equal(options.moveEnabled, true);
                assert.equal(options.home, env.HOME);
                options.onStep('fence-checked');
                options.onLockEvent({ type: 'acquired', name: 'state-layout', path: 'C:\\private\\lock' });
                if (outcome instanceof Error) throw outcome;
                return outcome;
              },
            }, env, root: process.argv[1],
          }));
        }, async () => {});
        assert.equal(result.steps[0].status, 'passed');
        evidence.push(result.steps[0].evidence);
      }
      assert.equal(closed, 2);
      assert.equal(evidence[0].reasons[0].artifactKind, 'cachekeep');
      assert.equal(evidence[1].error.code, 'io-failed');
      assert.equal(evidence[1].error.causeCode, 'EPERM');
      assert.equal(evidence[1].error.operation, 'rename');
      assert.equal(evidence[1].lastStep, 'fence-checked');
      assert.equal(evidence[2].outcome, 'state-home');
      assert(!JSON.stringify(evidence).includes('private'));
      assert(!JSON.stringify(evidence).includes(process.argv[1]));
      console.log(JSON.stringify({ checked: outcomes.length }));
    `,
        root,
      ],
      { cwd: repo },
    )
    expect(JSON.parse(output.stdout).checked).toBe(3)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
