import { expect } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createTestLifetimeSuite } from '../../../core/src/tests/test-lifetime.ts'
import {
  expectOneLineQuotaRows,
  fiveAccountSidebarState,
} from './fixtures/sidebar-five-accounts'
import {
  captureSharedSidebarFrame,
  expectCollapsedStyle,
  expectSharedSidebarShape,
  type SidebarFrameLine,
  sharedShapeSidebarState,
} from './fixtures/sidebar-shared-shape'

const lifetimes = createTestLifetimeSuite()
const test = lifetimes.test

/**
 * After the first frame, the probe writes `state` to the sidebar state file,
 * waits until the sidebar's file poll draws every `wanted` part, and reports
 * the renderable ids of each one-line account row (a row whose label is one of
 * `names`) before and after that update.
 */
type Rewrite = { state: unknown; wanted: string[]; names: string[] }

async function renderSidebar(
  state: unknown,
  wanted: string[],
  collapsed = false,
  options: {
    rewrite?: Rewrite
    width?: number
    height?: number
    showVersion?: boolean
  } = {},
) {
  const { rewrite, width = 42, height = 32 } = options
  const fixture = await mkdtemp(join(tmpdir(), 'anthropic-quota-render-'))
  // Remove the fixture only after the owned probe below has exited and both
  // pipes have ended; teardown drains those joins before running cleanups.
  lifetimes.deferCleanup(() => rm(fixture, { recursive: true, force: true }))
  const stateFile = join(fixture, 'sidebar.json')
  await writeFile(stateFile, JSON.stringify(state))
  await writeFile(
    join(fixture, 'preferences.jsonc'),
    JSON.stringify({
      'anthropic-auth': {
        startCollapsed: collapsed,
        rememberCollapsed: false,
        header: { showVersion: options.showVersion ?? true },
        // The fastest poll the preferences allow keeps a rewrite test short.
        ...(rewrite ? { pollMs: 500 } : {}),
      },
    }),
  )
  // Render the compiled sidebar with installed OpenTUI libraries, without a package install.
  const probe = `
let __probeRenderer;
process.once('SIGTERM', () => {
  // CliRenderer traps SIGTERM to destroy without exiting, leaving a probe
  // blocked awaiting its next frame alive until the hook times out. Exit
  // promptly so the harness never waits out its hook.
  try { __probeRenderer?.destroy(); } catch {}
  process.exit(143);
});
import { createTestRenderer } from '@opentui/core/testing';
import { render } from '@opentui/solid';
import { ensureRuntimePluginSupport } from '@opentui/solid/runtime-plugin-support/configure';
import { TextAttributes } from '@opentui/core';
ensureRuntimePluginSupport();
const { default: plugin } = await import(${JSON.stringify(new URL('../tui-compiled/tui.tsx', import.meta.url).href)});
const registered = [];
await plugin.tui({
  event: { on() { return () => {}; } },
  theme: { current: {
    accent: '#3366ff', background: '#000000', borderActive: '#ffffff',
    error: '#ff0000', success: '#00ff00', text: '#ffffff',
    textMuted: '#888888', warning: '#ffff00',
  } },
  slots: { register(value) { registered.push(value); } },
  state: { path: { directory: process.cwd() } },
  route: { current: () => ({ type: 'home' }) },
});
const sidebar = registered.find((value) => value.slots?.sidebar_content)?.slots.sidebar_content;
if (!sidebar) throw new Error('sidebar slot was not registered');
let destroyed;
const teardown = new Promise((resolve) => { destroyed = resolve; });
const setup = await createTestRenderer({ width: ${width}, height: ${height}, exitSignals: [], onDestroy() { destroyed(); } });
__probeRenderer = setup.renderer;
let pending;
const observe = () => {
  if (!pending) return;
  const text = setup.captureCharFrame();
  if (!pending.wanted.every((part) => text.includes(part))) return;
  const done = pending;
  pending = undefined;
  done.resolve(text);
};
const nextFrame = (wanted) => new Promise((resolve) => {
  pending = { wanted, resolve };
  setup.renderer.requestRender();
});
const settledFrame = async () => {
  // Shared rows measure their gutters and bars after layout, across frames.
  for (let i = 0; i < 10; i++) {
    await setup.renderOnce();
    await Bun.sleep(40);
  }
  return setup.captureCharFrame();
};
const rewrite = ${JSON.stringify(rewrite ?? null)};
const rowIds = () => {
  const ids = [];
  const walk = (node) => {
    const children = node.getChildren?.() ?? [];
    if (node.height === 1 && children.some((child) =>
      typeof child.plainText === 'string' && rewrite.names.includes(child.plainText.trim())))
      ids.push(node.id);
    for (const child of children) walk(child);
  };
  walk(setup.renderer.root);
  return ids;
};
setup.renderer.on('frame', observe);
try {
  const first = nextFrame(${JSON.stringify(wanted)});
  await render(() => sidebar({}, { session_id: 'quota-render-test' }), setup.renderer);
  setup.renderer.requestRender();
   await first;
   let text = await settledFrame();
  if (rewrite) {
    const before = rowIds();
    await Bun.write(process.env.OPENCODE_ANTHROPIC_AUTH_SIDEBAR_STATE_FILE, JSON.stringify(rewrite.state));
    await nextFrame(rewrite.wanted);
    text = await settledFrame();
    console.log('ROWS:' + JSON.stringify({ before, after: rowIds() }));
  }
  console.log(text);
  if (${collapsed}) {
    console.log('STYLES:' + JSON.stringify(setup.captureSpans().lines.map((line) => {
      const spans = line.spans.filter((span) => span.text.trim());
      return { text: line.spans.map((span) => span.text).join(''),
        spans: spans.map((span) => ({ text: span.text, fg: String(span.fg),
          dim: (span.attributes & TextAttributes.DIM) !== 0,
          bold: (span.attributes & TextAttributes.BOLD) !== 0 })),
        dim: spans.length > 0 && spans.every((span) => (span.attributes & TextAttributes.DIM) !== 0),
        bold: spans.length > 0 && spans.every((span) => (span.attributes & TextAttributes.BOLD) !== 0) };
    })));
  }
} finally {
  setup.renderer.off('frame', observe);
  setup.renderer.destroy();
  await teardown;
}
process.exit(0);
`
  const child = Bun.spawn(
    [process.execPath, '--preload', '@opentui/solid/preload', '-e', probe],
    {
      cwd: fileURLToPath(new URL('../../', import.meta.url)),
      env: {
        ...process.env,
        OPENCODE_ANTHROPIC_AUTH_SIDEBAR_STATE_FILE: stateFile,
        OPENCODE_TUI_PREFERENCES_FILE: join(fixture, 'preferences.jsonc'),
        OPENCODE_ANTHROPIC_AUTH_RPC_DIR: join(fixture, 'rpc'),
      },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )
  // Own the probe through the test lifetime: the gate kills it as soon as
  // teardown starts, before the lifetime waits for this body, so a body
  // awaiting a frame it never receives can still finish. A SIGTERM-ignored
  // probe would otherwise use up the hook; SIGKILL after a short grace is
  // the backstop because a signal handler alone cannot be relied on once the
  // renderer has trapped SIGTERM.
  const cancel = lifetimes.gate()
  const cancellation = cancel.wait.then(async () => {
    if (child.exitCode !== null) return
    child.kill('SIGTERM')
    await Bun.sleep(500)
    if (child.exitCode === null) child.kill('SIGKILL')
  })
  lifetimes.trackDetached(cancellation)
  const joined = Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  // Join the process and each stdio stream individually before the deferred
  // fixture removal runs, even if this body times out before awaiting them.
  lifetimes.trackDetached(
    joined.then(
      () => {},
      (error) => {
        throw error
      },
    ),
  )
  const [stdout, stderr, exitCode] = await joined
  cancel.open()
  await cancellation
  expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: '' })
  return stdout
}

for (const width of [36, 42]) {
  for (const collapsed of [false, true]) {
    test(`OpenCode 1 shared sidebar shape at ${width} columns ${collapsed ? 'collapsed with trailing status glyphs' : 'expanded'}`, async () => {
      const stdout = await renderSidebar(
        sharedShapeSidebarState(),
        collapsed
          ? ['5h 40% · 7d 80% left', '5h 70% left', '…', 'Opus 4.8 · 2 left']
          : ['Health', 'Prime', 'Opus 4.8 · 2 left'],
        collapsed,
        { width, height: 50 },
      )
      const [frame, styles] = stdout.split('STYLES:')
      expectSharedSidebarShape(
        frame!,
        JSON.parse(styles ?? '[]'),
        width,
        collapsed,
      )
      captureSharedSidebarFrame('OpenCode 1', width, collapsed, frame!)
    })
  }
}

test('compiled sidebar renders the shared quota figure reset and stale reading age offline', async () => {
  const now = Date.now()
  const stdout = await renderSidebar(
    {
      main: {
        quota: {
          five_hour: {
            usedPercent: 60,
            remainingPercent: 40,
            checkedAt: now - 2 * 86400000,
            resetsAt: new Date(now + 4 * 86400000).toISOString(),
          },
          scoped: [],
        },
      },
      fallbacks: [],
      activeId: 'main',
      route: 'main',
      lastUpdated: now,
    },
    ['40% left', 'checked 2d ago'],
  )
  expect(stdout).toContain('40% left')
  expect(stdout).toContain('3d23h')
  expect(stdout).toContain('checked 2d ago')
  expect(stdout).not.toContain('Fable')
})

test('shared sidebar replaces a pre-reset reading with reset since last check', async () => {
  const now = Date.now()
  const stdout = await renderSidebar(
    {
      main: {
        quota: {
          five_hour: {
            usedPercent: 60,
            remainingPercent: 40,
            checkedAt: now - 3 * 3_600_000,
            resetsAt: new Date(now - 3_600_000).toISOString(),
          },
        },
      },
      fallbacks: [],
      activeId: 'main',
      route: 'main',
      lastUpdated: now,
    },
    ['reset since last check', 'checked 3h ago'],
  )
  expect(stdout).not.toContain('40% left')
  expect(stdout).not.toMatch(/[█░▓▒]/)
  expect(stdout).not.toContain('out in')
})

for (const collapsed of [false, true]) {
  test(`OpenCode 1 respects the hidden version preference ${collapsed ? 'collapsed' : 'expanded'}`, async () => {
    const stdout = await renderSidebar(
      sharedShapeSidebarState(),
      ['80% left'],
      collapsed,
      { showVersion: false },
    )
    expect(stdout.split('\n')[0]).not.toMatch(/v\d+\.\d+\.\d+/)
    expect(stdout).toContain('CLAUDE')
  })
}

test('shared sidebar puts the credit below reading age and fallback advice below the credit', async () => {
  const now = Date.now()
  const stdout = await renderSidebar(
    {
      main: {
        quota: {
          five_hour: {
            usedPercent: 10,
            remainingPercent: 90,
            checkedAt: now - 30 * 3_600_000,
          },
          extraUsage: {
            used: { amountMinor: 1250, currency: 'USD', exponent: 2 },
            limit: { amountMinor: 5000, currency: 'USD', exponent: 2 },
            exhausted: false,
          },
          fallbackAdvised: true,
        },
      },
      fallbacks: [],
      activeId: 'main',
      route: 'main',
      lastUpdated: now,
    },
    [
      'checked 1d6h ago',
      'credits 75% left · $12.50/$50.00',
      '→ fallback advised',
    ],
  )
  const lines = stdout.split('\n').map((line) => line.trimEnd())
  const age = lines.indexOf('checked 1d6h ago')
  expect(age).toBeGreaterThan(0)
  expect(lines.slice(age, age + 3)).toEqual([
    'checked 1d6h ago',
    'credits 75% left · $12.50/$50.00',
    '→ fallback advised',
  ])
  expect(stdout).not.toContain('7d —')
})

test('collapsed sidebar keeps every account on one line with intact narrow quotas and muted stale rows', async () => {
  const now = Date.now()
  const window = (used: number, checkedAt = now) => ({
    usedPercent: used,
    remainingPercent: 100 - used,
    checkedAt,
  })
  const stdout = await renderSidebar(
    {
      main: {
        quota: {
          five_hour: window(62),
          seven_day: window(41),
          scoped: [
            {
              id: 'fable',
              title: 'Fable only',
              modelName: 'Fable',
              ...window(78),
            },
          ],
          extraUsage: {
            used: { amountMinor: 1250, currency: 'USD', exponent: 2 },
            limit: { amountMinor: 5000, currency: 'USD', exponent: 2 },
            exhausted: false,
          },
        },
      },
      fallbacks: [
        {
          id: 'work',
          label: 'work',
          enabled: true,
          needsReauth: false,
          quota: {
            five_hour: window(8, now - 30 * 3600000),
            seven_day: window(93, now - 30 * 3600000),
          },
        },
      ],
      activeId: 'main',
      route: 'main',
      lastUpdated: now,
    },
    ['5h 38% · 7d 59% · Fa 22% left', 'work', '5h 92% · 7d 7% left'],
    true,
  )
  const [frame, styleText] = stdout.split('STYLES:')
  expect(frame).toContain('main')
  expect(frame).toContain('5h 38% · 7d 59% · Fa 22% left')
  expect(frame).not.toContain('cr 75%')
  expect(frame).toContain('work')
  expect(frame).toContain('5h 92% · 7d 7% left')
  expect(frame).not.toContain('checked')
  const rows = frame!.split('\n').filter((line) => line.includes('5h'))
  expect(rows).toHaveLength(2)
  expect(rows[0]).toContain('38%')
  expect(rows[1]).toContain('92%')
  const styles = JSON.parse(styleText!) as SidebarFrameLine[]
  expectCollapsedStyle(
    styles,
    'main',
    '5h 38%',
    true,
    'rgba(1.00, 1.00, 0.00, 1.00)',
  )
  expectCollapsedStyle(styles, 'work', '5h 92%', false)
})

test('collapsed sidebar mutes a stale active row and a fresh inactive row without reordering accounts', async () => {
  const now = Date.now()
  const window = (used: number, checkedAt: number) => ({
    usedPercent: used,
    remainingPercent: 100 - used,
    checkedAt,
  })
  const stdout = await renderSidebar(
    {
      main: {
        quota: { five_hour: window(10, now), seven_day: window(20, now) },
      },
      fallbacks: [
        {
          id: 'work',
          label: 'work',
          enabled: true,
          needsReauth: false,
          quota: {
            five_hour: window(8, now - 30 * 3600000),
            seven_day: window(93, now - 30 * 3600000),
          },
        },
      ],
      activeId: 'work',
      route: 'work',
      lastUpdated: now,
    },
    ['main', '5h 90% · 7d 80% left', 'work', '5h 92% · 7d 7% left'],
    true,
  )
  const [frame, styleText] = stdout.split('STYLES:')
  expect(frame!.indexOf('main')).toBeLessThan(frame!.indexOf('work'))
  const styles = JSON.parse(styleText!) as SidebarFrameLine[]
  expectCollapsedStyle(styles, 'main', '5h 90%', false)
  expectCollapsedStyle(styles, 'work', '5h 92%', false)
})

test('collapsed sidebar leaves out a window without a reading and keeps the muted dash for an account with none', async () => {
  const now = Date.now()
  const stdout = await renderSidebar(
    {
      main: {
        quota: {
          five_hour: { usedPercent: 13, remainingPercent: 87, checkedAt: now },
        },
      },
      fallbacks: [
        {
          id: 'work',
          label: 'work',
          enabled: true,
          needsReauth: false,
          quota: null,
        },
      ],
      activeId: 'main',
      route: 'main',
      lastUpdated: now,
    },
    ['main', '5h 87% left', 'work'],
    true,
  )
  const [frame, styleText] = stdout.split('STYLES:')
  expect(frame).not.toContain('7d')
  const styles = JSON.parse(styleText!) as SidebarFrameLine[]
  const main = styles.find((line) => line.text.includes('main'))
  expect(main?.text.trimEnd().endsWith('5h 87% left ●')).toBe(true)
  expectCollapsedStyle(styles, 'main', '5h 87%', true)
  const work = styles.find((line) => line.text.includes('work'))
  expect(work?.text.trimEnd().endsWith('— ●')).toBe(true)
  expectCollapsedStyle(styles, 'work', '—', false)
})

test('collapsed account rows keep their renderables across same-value state updates', async () => {
  const now = Date.now()
  const window = (used: number) => ({
    usedPercent: used,
    remainingPercent: 100 - used,
    checkedAt: now,
  })
  const state = (workUsed: number, lastUpdated: number) => ({
    main: { quota: { five_hour: window(10), seven_day: window(20) } },
    fallbacks: [
      {
        id: 'work',
        label: 'work',
        enabled: true,
        needsReauth: false,
        quota: { five_hour: window(workUsed), seven_day: window(30) },
      },
    ],
    activeId: 'main',
    route: 'main',
    lastUpdated,
  })
  // The server rewrites the state file with a new lastUpdated on every
  // request. main's values stay the same; work's change shows that the poll
  // was applied and that a kept row still updates its text.
  const stdout = await renderSidebar(
    state(8, now),
    ['main', '5h 90% · 7d 80% left', 'work', '5h 92% · 7d 70% left'],
    true,
    {
      rewrite: {
        state: state(12, now + 1),
        wanted: ['5h 90% · 7d 80% left', '5h 88% · 7d 70% left'],
        names: ['main', 'work'],
      },
    },
  )
  const rows = JSON.parse(stdout.split('ROWS:')[1]!.split('\n')[0]!) as {
    before: string[]
    after: string[]
  }
  expect(rows.before).toHaveLength(2)
  expect(rows.after).toEqual(rows.before)
  expect(stdout).toContain('5h 88% · 7d 70% left')
})

test('42-column sidebar renders short scoped names credits and stale fallback rows in aligned columns', async () => {
  const now = Date.now()
  const window = (used: number, checkedAt = now, resetMinutes?: number) => ({
    usedPercent: used,
    remainingPercent: 100 - used,
    checkedAt,
    ...(resetMinutes === undefined
      ? {}
      : {
          resetsAt: new Date(now + resetMinutes * 60_000).toISOString(),
        }),
  })
  const stdout = await renderSidebar(
    {
      main: {
        quota: {
          five_hour: window(62, now, 149),
          seven_day: window(41, now, 3 * 1440 + 23 * 60),
          scoped: [
            {
              id: 'fable',
              title: 'Fable only',
              modelName: 'Fable',
              ...window(78),
            },
          ],
          extraUsage: {
            used: { amountMinor: 1250, currency: 'USD', exponent: 2 },
            limit: { amountMinor: 5000, currency: 'USD', exponent: 2 },
            exhausted: false,
          },
        },
      },
      fallbacks: [
        {
          id: 'work',
          label: 'work',
          enabled: true,
          needsReauth: false,
          quota: {
            five_hour: window(8, now - 30 * 3_600_000),
            seven_day: window(93, now - 30 * 3_600_000),
          },
        },
      ],
      activeId: 'main',
      route: 'main',
      lastUpdated: now,
    },
    [
      'Fa ████████░░ 22% left',
      'credits 75% left · $12.50/$50.00',
      'work',
      'checked 1d6h ago',
    ],
  )
  expect(stdout).toContain('38% left')
  expect(stdout).toContain('59% left')
  expect(stdout).toContain('Fa ████████░░ 22% left')
  expect(stdout).not.toContain('Fable')
  expect(stdout).toContain('credits 75% left · $12.50/$50.00')
  expect(stdout).toContain('92% left')
  expect(stdout).toContain('7% left')
  expect(stdout).toContain('checked 1d6h ago')
  const rows = stdout
    .split('\n')
    .filter((line) => /38% left|59% left|22% left|92% left|7% left/.test(line))
  expect(rows).toHaveLength(5)
  expect(new Set(rows.map((line) => line.search(/[█░▓▒]/)))).toEqual(
    new Set([3]),
  )
})

function largeCreditState() {
  const now = Date.now()
  return {
    main: {
      quota: {
        five_hour: { usedPercent: 10, remainingPercent: 90, checkedAt: now },
        extraUsage: {
          used: { amountMinor: 12_500_000, currency: 'USD', exponent: 2 },
          limit: { amountMinor: 50_000_000, currency: 'USD', exponent: 2 },
          exhausted: false,
        },
      },
    },
    fallbacks: [],
    activeId: 'main',
    route: 'main',
    lastUpdated: now,
  }
}

test('36-column sidebar drops the cents from credit amounts that would not fit on one line', async () => {
  const stdout = await renderSidebar(
    largeCreditState(),
    ['credits 75% left · $125,000/$500,000'],
    false,
    { width: 36 },
  )
  const line = stdout.split('\n').find((row) => row.includes('credits'))
  expect(line?.trim()).toBe('credits 75% left · $125,000/$500,000')
  expect(stdout).not.toContain('.00')
})

test('a wider sidebar keeps the cents on credit amounts that fit', async () => {
  const stdout = await renderSidebar(
    largeCreditState(),
    ['credits 75% left · $125,000.00/$500,000.00'],
    false,
    { width: 60 },
  )
  const line = stdout.split('\n').find((row) => row.includes('credits'))
  expect(line?.trim()).toBe('credits 75% left · $125,000.00/$500,000.00')
})

const FIVE_ACCOUNTS = ['main', 'work', 'personal', 'team', 'backup']

// OpenCode 1.18's session sidebar is 42 cells with 2 cells of padding each
// side, and its scrollbox puts a 1-cell scrollbar beside a slot box padded 1
// on the right, so a plugin gets 36 cells once the sidebar overflows.
for (const width of [36, 42]) {
  test(`${width}-column sidebar keeps every quota row and pacing subline of five accounts on one line`, async () => {
    const stdout = await renderSidebar(
      fiveAccountSidebarState(),
      ['backup', 'checked 1d6h ago', 'Routing'],
      false,
      { width, height: 70 },
    )
    const rows = expectOneLineQuotaRows(stdout, FIVE_ACCOUNTS)
    expect(rows).toHaveLength(15)
    expect(rows.map((row) => row.trim().split(' ')[0])).toEqual(
      FIVE_ACCOUNTS.flatMap(() => ['5h', '7d', 'Fa']),
    )
    expect(stdout).not.toContain('Fable')
    // One label column: every bar starts in the same cell.
    expect(new Set(rows.map((row) => row.search(/[█░▓▒]/)))).toEqual(
      new Set([3]),
    )
    // Every row here fits whole, so each keeps its reset after a space.
    for (const row of rows) expect(row).toMatch(/left( •)? +\d+[a-z]/)
    expect(stdout).toMatch(/deficit \d+% · out in \d+[a-z]/)
    expect(stdout).toMatch(/reserve \d+% · lasts to reset/)
    expect(stdout).toContain('credits 75% left · $12.50/$50.00')
  })
}

test('a 28-column shared sidebar shrinks bars before dropping resets without wrapping rows', async () => {
  const stdout = await renderSidebar(
    fiveAccountSidebarState(),
    // The cents drop once the block has a measured width, so this waits for it.
    ['backup', 'checked 1d6h ago', 'Routing', '$12/$50'],
    false,
    { width: 28, height: 70 },
  )
  const rows = expectOneLineQuotaRows(stdout, FIVE_ACCOUNTS)
  expect(rows).toHaveLength(15)
  for (const row of rows)
    expect(row).toMatch(/^\S+ +[█░▓▒]{4,10} \d+% left( •)? +\d+[a-z]/)
  expect(rows.some((row) => /[█░▓▒]{4,9} \d+% left/.test(row))).toBe(true)
  expect(rows.some((row) => / 100% left • +\d+h\d+m$/.test(row))).toBe(true)
  expect(stdout).toMatch(/reserve \d+% · lasts to re.*…/)
})

test('a 36-column sidebar keeps an exhausted window used-up line on one row', async () => {
  const now = Date.now()
  const minute = 60_000
  const state = {
    main: {
      quota: {
        // Elapsed 2h50m of 5h with nothing left: deficit pacing whose runout
        // is now, resetting in 2h10m.
        five_hour: {
          usedPercent: 100,
          remainingPercent: 0,
          checkedAt: now,
          resetsAt: new Date(now + 130 * minute).toISOString(),
        },
        seven_day: {
          usedPercent: 40,
          remainingPercent: 60,
          checkedAt: now,
          resetsAt: new Date(now + 5 * 24 * 60 * minute).toISOString(),
        },
      },
    },
    fallbacks: [],
    activeId: 'main',
    route: 'main',
    lastUpdated: now,
  }
  const stdout = await renderSidebar(
    state,
    ['used up · resets in', 'Routing'],
    false,
    { width: 36, height: 30 },
  )
  expect(stdout).toMatch(/used up · resets in \d+h\d+m/)
  expect(stdout).not.toContain('out in now')
  expect(stdout).not.toContain('out in 0m')
  const rows = expectOneLineQuotaRows(stdout, ['main'])
  expect(rows).toHaveLength(2)
  const pace = stdout
    .split('\n')
    .map((line) => line.trimEnd())
    .find((line) => /used up · resets in \d+h\d+m$/.test(line.trim()))
  expect(pace).toBeDefined()
})

test('scoped rows whose models share a short name extend it as the collapsed line does', async () => {
  const now = Date.now()
  const window = (used: number) => ({
    usedPercent: used,
    remainingPercent: 100 - used,
    checkedAt: now,
    resetsAt: new Date(now + 3 * 86_400_000).toISOString(),
  })
  const state = {
    main: {
      quota: {
        five_hour: window(10),
        seven_day: window(20),
        scoped: [
          {
            id: 'fable',
            title: 'Fable only',
            modelName: 'Fable',
            ...window(30),
          },
          {
            id: 'fabric',
            title: 'Fabric only',
            modelName: 'Fabric',
            ...window(90),
          },
        ],
      },
    },
    fallbacks: [
      {
        id: 'work',
        label: 'work',
        enabled: true,
        needsReauth: false,
        quota: { five_hour: window(5), seven_day: window(6) },
      },
    ],
    activeId: 'main',
    route: 'main',
    lastUpdated: now,
  }
  const expanded = await renderSidebar(
    state,
    ['Fabl', 'Fabr', 'work', 'Routing'],
    false,
    { width: 36, height: 40 },
  )
  const rows = expectOneLineQuotaRows(expanded, ['main', 'work'])
  expect(rows.map((row) => row.trim().split(' ')[0])).toEqual([
    '5h',
    '7d',
    'Fabl',
    'Fabr',
    '5h',
    '7d',
  ])
  // Each account's gutter fits its own longest window name.
  expect(rows.map((row) => row.search(/[█░▓▒]/))).toEqual([5, 5, 5, 5, 3, 3])
  const collapsed = await renderSidebar(state, ['Fabr 10% left'], true, {
    width: 36,
  })
  expect(collapsed).toContain('5h 90% · 7d 80% · Fabr 10% left')
})

test('a probe killed mid-render exits well within one second', async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'anthropic-quota-render-kill-'))
  lifetimes.deferCleanup(() => rm(fixture, { recursive: true, force: true }))
  // A probe that never reaches its wanted text: without the SIGTERM handler
  // the renderer's trapped SIGTERM leaves it alive for seconds, using up the
  // hook. The handler plus exitSignals below must end it promptly.
  const probe = `
let __probeRenderer;
process.once('SIGTERM', () => {
  try { __probeRenderer?.destroy(); } catch {}
  process.exit(143);
});
import { createTestRenderer } from '@opentui/core/testing';
import { render } from '@opentui/solid';
import { ensureRuntimePluginSupport } from '@opentui/solid/runtime-plugin-support/configure';
ensureRuntimePluginSupport();
const { default: plugin } = await import(${JSON.stringify(new URL('../tui-compiled/tui.tsx', import.meta.url).href)});
const registered = [];
await plugin.tui({
  event: { on() { return () => {}; } },
  theme: { current: {
    accent: '#3366ff', background: '#000000', borderActive: '#ffffff',
    error: '#ff0000', success: '#00ff00', text: '#ffffff',
    textMuted: '#888888', warning: '#ffff00',
  } },
  slots: { register(value) { registered.push(value); } },
  state: { path: { directory: process.cwd() } },
  route: { current: () => ({ type: 'home' }) },
});
const sidebar = registered.find((value) => value.slots?.sidebar_content)?.slots.sidebar_content;
if (!sidebar) throw new Error('sidebar slot was not registered');
let destroyed;
const teardown = new Promise((resolve) => { destroyed = resolve; });
const setup = await createTestRenderer({ width: 42, height: 32, exitSignals: [], onDestroy() { destroyed(); } });
__probeRenderer = setup.renderer;
setup.renderer.on('frame', () => {});
try {
  await render(() => sidebar({}, { session_id: 'quota-render-kill-test' }), setup.renderer);
  setup.renderer.requestRender();
  await new Promise(() => {});
} finally {
  setup.renderer.destroy();
  await teardown;
}
`
  const child = Bun.spawn(
    [process.execPath, '--preload', '@opentui/solid/preload', '-e', probe],
    {
      cwd: fileURLToPath(new URL('../../', import.meta.url)),
      env: {
        ...process.env,
        OPENCODE_ANTHROPIC_AUTH_SIDEBAR_STATE_FILE: join(
          fixture,
          'sidebar.json',
        ),
        OPENCODE_TUI_PREFERENCES_FILE: join(fixture, 'preferences.jsonc'),
        OPENCODE_ANTHROPIC_AUTH_RPC_DIR: join(fixture, 'rpc'),
      },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )
  const cancel = lifetimes.gate()
  const cancellation = cancel.wait.then(async () => {
    if (child.exitCode !== null) return
    child.kill('SIGTERM')
    await Bun.sleep(500)
    if (child.exitCode === null) child.kill('SIGKILL')
  })
  lifetimes.trackDetached(cancellation)
  const joined = Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  lifetimes.trackDetached(
    joined.then(
      () => {},
      (error) => {
        throw error
      },
    ),
  )
  // Let the probe reach its blocked render before killing it mid-render.
  await Bun.sleep(2000)
  const started = Date.now()
  child.kill('SIGTERM')
  const [, , exitCode] = await joined
  const elapsed = Date.now() - started
  cancel.open()
  await cancellation
  expect(exitCode).toBe(143)
  expect(elapsed).toBeLessThan(1000)
})
