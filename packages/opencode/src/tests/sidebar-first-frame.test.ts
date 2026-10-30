import { expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'
import { createTestLifetimeSuite } from '../../../core/src/tests/test-lifetime.ts'

const lifetimes = createTestLifetimeSuite()

test.todo(
  'common-auth 0.32.0 first-render bars are missing: enable with the 0.32.1 fix',
  lifetimes.wrapBody(async () => {
    const probe = `
import { createTestRenderer } from '@opentui/core/testing';
import { render } from '@opentui/solid';
import { ensureRuntimePluginSupport } from '@opentui/solid/runtime-plugin-support/configure';
import { quotaDisplayProjection, quotaWindowParts } from '@cortexkit/anthropic-auth-core';
ensureRuntimePluginSupport();
const { SidebarFrame } = await import('./src/tui-compiled/quota-sidebar.js');
const now = Date.now();
const quota = quotaDisplayProjection({ five_hour: { usedPercent: 40, remainingPercent: 60, checkedAt: now } }, now);
let destroyed;
const teardown = new Promise(resolve => { destroyed = resolve; });
const setup = await createTestRenderer({ width: 42, height: 10, exitSignals: [], onDestroy() { destroyed(); } });
try {
  await render(() => SidebarFrame({
    header: { badge: 'CLAUDE' },
    accounts: [{ id: 'main', label: 'main', quota, status: { text: 'active', tone: 'success' }, blocked: false, indicatorTone: 'success',
      groups: [{ rows: quotaWindowParts(quota, { now }).windows.map(part => ({ part })) }] }],
    appearance: { barWidth: 10, barFilledChar: '█', barEmptyChar: '░', warnThreshold: 80, errorThreshold: 95 },
    showQuota: true, now, collapsed: false, onToggle() {},
  }), setup.renderer);
  // Deliberately capture the first layout, without the settled-frame harness.
  await setup.renderOnce();
  console.log(setup.captureCharFrame());
} finally {
  setup.renderer.destroy();
  await teardown;
}
process.exit(0);
`
    const child = Bun.spawn(
      [process.execPath, '--preload', '@opentui/solid/preload', '-e', probe],
      {
        cwd: fileURLToPath(new URL('../../', import.meta.url)),
        stdout: 'pipe',
        stderr: 'pipe',
        stdin: 'ignore',
      },
    )
    lifetimes.deferCleanup(() => {
      if (child.exitCode === null) child.kill('SIGKILL')
    })
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: '' })
    expect(stdout).toContain('5h ████░░░░░░ 60% left')
  }),
)
