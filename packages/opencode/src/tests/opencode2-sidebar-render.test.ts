import { expect } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createTestLifetimeSuite } from '../../../core/src/tests/test-lifetime.ts'
import { normalizeSidebarState } from '../sidebar-state'
import { NATIVE_MENU_RPC } from '../v2/rpc'
import {
  expectOneLineQuotaRows,
  fiveAccountSidebarState,
} from './fixtures/sidebar-five-accounts'
import {
  captureSharedSidebarFrame,
  expectSharedSidebarShape,
  type SidebarFrameLine,
  sharedShapeSidebarState,
} from './fixtures/sidebar-shared-shape'

const lifetimes = createTestLifetimeSuite()
const test = lifetimes.test

interface Step {
  /** Text the frame must contain before the step completes. */
  wanted: string[]
  /** Sidebar calls the server must have answered first. */
  calls?: number
  /** Moves the probe's clock forward once the step completes. */
  advanceMs?: number
}

// Loads the package's `./tui` entry the way OpenCode 2 does (`setup(context)`),
// so the bundled v2 TUI, the RPC call and the precompiled sidebar all run.
// The server gives `answers` in order and repeats the last; `null` is a server
// without the `sidebar` method.
async function renderOpenCode2Sidebar(
  answers: unknown[],
  steps: Step[],
  size: {
    width: number
    height: number
    collapsed?: boolean
    showVersion?: boolean
  } = { width: 42, height: 32 },
): Promise<{
  frames: string[]
  asked: string[]
  released: number
  colors: Record<string, string>
  lines: SidebarFrameLine[]
}> {
  const fixture = await mkdtemp(join(tmpdir(), 'anthropic-oc2-sidebar-'))
  lifetimes.deferCleanup(() => rm(fixture, { recursive: true, force: true }))
  await writeFile(
    join(fixture, 'preferences.jsonc'),
    JSON.stringify({
      'anthropic-auth': {
        rememberCollapsed: false,
        pollMs: 500,
        startCollapsed: size.collapsed ?? false,
        header: { showVersion: size.showVersion ?? true },
      },
    }),
  )
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
import { TextAttributes } from '@opentui/core';
import { render } from '@opentui/solid';
import { ensureRuntimePluginSupport } from '@opentui/solid/runtime-plugin-support/configure';
ensureRuntimePluginSupport();
const realNow = Date.now;
let clock = 0;
Date.now = () => realNow() + clock;
const { setup } = await import(${JSON.stringify(new URL('../tui/entry.mjs', import.meta.url).href)});
const answers = ${JSON.stringify(answers)};
const steps = ${JSON.stringify(steps)};
const asked = [];
const claims = [];
let released = 0;
const cleanup = await setup({
  location: { directory: process.cwd() },
  theme: {
    text: {
      base: '#ffffff', muted: '#888888',
      action: { primary: { base: '#3366ff' } },
      feedback: { success: { base: '#00ff00' }, warning: { base: '#ffff00' }, error: { base: '#ff0000' } },
    },
    background: { base: '#000000' },
    border: { base: '#ffffff' },
  },
  client: { rpc: () => ({
    events: { on: () => () => {} },
    open: async () => { throw new Error('unused'); },
    apply: async () => { throw new Error('unused'); },
    sidebar: async ({ sessionId }) => {
      const answer = answers[Math.min(asked.length, answers.length - 1)];
      asked.push(sessionId);
      if (answer === null) throw Object.assign(new Error('missing'), { code: 'rpc.method_not_found' });
      return answer;
    },
  }) },
  keymap: { layer() {} },
  ui: {
    router: { current: () => ({ type: 'session', sessionID: 'ses_oc2' }) },
    slot(claim) { claims.push(claim); return () => { released++; }; },
    toast: { show() {} },
    dialog: {},
  },
});
if (claims.length !== 1 || claims[0].append !== 'sidebar.content') throw new Error('sidebar slot was not claimed');
let destroyed;
const teardown = new Promise((resolve) => { destroyed = resolve; });
const setupRenderer = await createTestRenderer({ width: ${size.width}, height: ${size.height}, exitSignals: [], onDestroy() { destroyed(); } });
__probeRenderer = setupRenderer.renderer;
const frames = [];
try {
  await render(() => claims[0].render({ sessionID: 'ses_oc2' }), setupRenderer.renderer);
  for (const step of steps) {
    for (;;) {
      await setupRenderer.renderOnce();
      const text = setupRenderer.captureCharFrame();
      if (asked.length >= (step.calls ?? 0) && step.wanted.every((part) => text.includes(part))) {
        // The shared frame measures gutters and bars after its first layout.
        for (let i = 0; i < 10; i++) {
          await setupRenderer.renderOnce();
          await Bun.sleep(40);
        }
        frames.push(setupRenderer.captureCharFrame());
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    clock += step.advanceMs ?? 0;
  }
  const colors = {};
  const lines = setupRenderer.captureSpans().lines.map((line) => ({
    text: line.spans.map((span) => span.text).join(''),
    spans: line.spans.map((span) => ({ text: span.text, fg: String(span.fg), dim: (span.attributes & TextAttributes.DIM) !== 0, bold: (span.attributes & TextAttributes.BOLD) !== 0 })),
  }));
  for (const line of setupRenderer.captureSpans().lines)
    for (const span of line.spans)
      if (span.text.trim()) colors[span.text.trim()] ??= String(span.fg);
  cleanup();
  console.log(JSON.stringify({ frames, asked, released, colors, lines }));
} finally {
  setupRenderer.renderer.destroy();
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
        OPENCODE_TUI_PREFERENCES_FILE: join(fixture, 'preferences.jsonc'),
      },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )
  // Own the probe through the test lifetime: the gate kills it as soon as
  // teardown starts, before the lifetime waits for this body, so a body
  // awaiting a frame it never receives can still finish. SIGKILL after a
  // short grace is the backstop because a signal handler alone cannot be
  // relied on once the renderer has trapped SIGTERM.
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
  const [stdout, stderr, exitCode] = await joined
  cancel.open()
  await cancellation
  expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: '' })
  return JSON.parse(stdout.trim().split('\n').at(-1) ?? '{}')
}

// Each test starts Bun with OpenTUI; a loaded machine takes past the 5 s default.
const SUBPROCESS_TIMEOUT_MS = 20_000

// The test renderer prints colors as `RGBA.toString()`.
const rgba = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map(
    (at) => Number.parseInt(hex.slice(at, at + 2), 16) / 255,
  )
  return `rgba(${r?.toFixed(2)}, ${g?.toFixed(2)}, ${b?.toFixed(2)}, 1.00)`
}

// Main at 60 % (5h) and 20 % (7d) used, both resetting three hours from now.
function quotaState() {
  const now = Date.now()
  const window = (used: number) => ({
    usedPercent: used,
    remainingPercent: 100 - used,
    checkedAt: now,
    resetsAt: new Date(now + 3 * 3_600_000).toISOString(),
  })
  return {
    main: {
      quota: { checkedAt: now, five_hour: window(60), seven_day: window(20) },
    },
    fallbacks: [],
    activeId: 'main',
    route: 'main-first',
    relay: null,
    fastMode: false,
    lastUpdated: now,
  }
}

for (const width of [37, 42]) {
  for (const collapsed of [false, true]) {
    test(
      `OpenCode 2 shared sidebar shape at ${width} columns ${collapsed ? 'collapsed with trailing status glyphs' : 'expanded'}`,
      async () => {
        const result = await renderOpenCode2Sidebar(
          [sharedShapeSidebarState(Date.now(), 'ses_oc2')],
          [
            {
              wanted: collapsed
                ? ['5h 70% left', '…', 'Opus 4.8 · 2 left']
                : ['Health', 'Prime', 'Opus 4.8 · 2 left'],
            },
          ],
          { width, height: 50, collapsed },
        )
        const [frame] = result.frames
        expectSharedSidebarShape(frame!, result.lines, width, collapsed)
        captureSharedSidebarFrame('OpenCode 2', width, collapsed, frame!)
      },
      SUBPROCESS_TIMEOUT_MS,
    )
  }
}

for (const collapsed of [false, true]) {
  test(
    `OpenCode 2 respects the hidden version preference ${collapsed ? 'collapsed' : 'expanded'}`,
    async () => {
      const result = await renderOpenCode2Sidebar(
        [quotaState()],
        [{ wanted: ['40%'] }],
        { width: 42, height: 32, collapsed, showVersion: false },
      )
      expect(result.frames[0]?.split('\n')[0]).not.toMatch(/v\d+\.\d+\.\d+/)
      expect(result.frames[0]).toContain('CLAUDE')
    },
    SUBPROCESS_TIMEOUT_MS,
  )
}

test(
  'OpenCode 2 sidebar draws server quota with the host theme and releases its slot',
  async () => {
    const result = await renderOpenCode2Sidebar(
      [quotaState()],
      [{ wanted: ['40% left', '80% left'] }],
    )
    const [frame] = result.frames
    expect(frame).toContain('CLAUDE')
    expect(frame).toContain('main')
    expect(frame).toContain('active')
    expect(frame).toContain('main-first')
    expect(result.asked).toContain('ses_oc2')
    const colorOf = (text: string) =>
      Object.entries(result.colors).find(([span]) => span.includes(text))?.[1]
    // 60 % used is past the default warning threshold; 20 % is fine.
    expect(colorOf('40% left')).toBe(rgba('#ffff00'))
    expect(colorOf('80% left')).toBe(rgba('#00ff00'))
    expect(colorOf('active')).toBe(rgba('#00ff00'))
    expect(colorOf('main-first')).toBe(rgba('#3366ff'))
    expect(result.released).toBe(1)
  },
  SUBPROCESS_TIMEOUT_MS,
)

test(
  'OpenCode 2 sidebar at 37 columns renders a no-reset window without reset text',
  async () => {
    const state = quotaState()
    const normalized = normalizeSidebarState({
      ...state,
      main: {
        quota: {
          ...state.main.quota,
          five_hour: { usedPercent: 0, remainingPercent: 100 },
        },
      },
    })
    const checked =
      await NATIVE_MENU_RPC.methods.sidebar.output['~standard'].validate(
        normalized,
      )
    if (checked.issues) throw new Error('Sidebar output did not validate')
    const result = await renderOpenCode2Sidebar(
      [checked.value],
      [{ wanted: ['100% left', '80% left'] }],
      { width: 37, height: 32 },
    )
    const frame = result.frames[0]!
    const fiveHour = frame
      .split('\n')
      .find((line) => line.trim().startsWith('5h '))
    const sevenDay = frame
      .split('\n')
      .find((line) => line.trim().startsWith('7d '))
    expect(fiveHour?.trim()).toMatch(/^5h .*100% left( •)?$/)
    expect(sevenDay).toMatch(/80% left( •)? +2h59m/)
    expect(frame).not.toContain('Waiting for quota')
  },
  SUBPROCESS_TIMEOUT_MS,
)

test(
  'OpenCode 2 sidebar waits instead of failing when the server has no sidebar method',
  async () => {
    const result = await renderOpenCode2Sidebar(
      [null],
      [{ wanted: ['Waiting for quota'] }],
    )
    expect(result.frames[0]).toContain('CLAUDE')
    expect(result.asked.length).toBeGreaterThan(0)
  },
  SUBPROCESS_TIMEOUT_MS,
)

test(
  'OpenCode 2 setup survives a refused sidebar slot and stops watching preferences',
  async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'anthropic-oc2-sidebar-slot-'))
    lifetimes.deferCleanup(() => rm(fixture, { recursive: true, force: true }))
    await writeFile(
      join(fixture, 'preferences.jsonc'),
      JSON.stringify({ 'anthropic-auth': { rememberCollapsed: false } }),
    )
    // Setup keeps the /claude menu when the sidebar can't mount, so it resolves
    // rather than rethrowing. The child never calls process.exit: it ends only
    // once nothing keeps its event loop alive. A preferences directory watcher
    // left open after the refused slot keeps it running, and the deadline
    // below catches that.
    const probe = `
process.once('SIGTERM', () => {
  // The refused slot leaves no renderer to trap SIGTERM, but exit promptly
  // here too so a leaked watcher cannot use up the hook either.
  process.exit(143);
});
const { setup } = await import(${JSON.stringify(new URL('../tui/entry.mjs', import.meta.url).href)});
let slotCalls = 0;
let result;
try {
  result = await setup({
    location: { directory: process.cwd() },
    theme: {
      text: {
        base: '#ffffff', muted: '#888888',
        action: { primary: { base: '#3366ff' } },
        feedback: { success: { base: '#00ff00' }, warning: { base: '#ffff00' }, error: { base: '#ff0000' } },
      },
      background: { base: '#000000' },
      border: { base: '#ffffff' },
    },
    client: { rpc: () => ({
      events: { on: () => () => {} },
      open: async () => { throw new Error('unused'); },
      apply: async () => { throw new Error('unused'); },
      sidebar: async () => { throw new Error('unused'); },
    }) },
    keymap: { layer() {} },
    ui: {
      router: { current: () => ({ type: 'session', sessionID: 'ses_oc2' }) },
      slot() { slotCalls++; throw new Error('slot refused by host'); },
      toast: { show() {} },
      dialog: {},
    },
  });
} catch (error) {
  result = error;
}
console.log(JSON.stringify({ slotCalls, setupReturned: typeof result }));
`
    const running = Bun.spawn(
      [process.execPath, '--preload', '@opentui/solid/preload', '-e', probe],
      {
        cwd: fileURLToPath(new URL('../../', import.meta.url)),
        env: {
          ...process.env,
          OPENCODE_TUI_PREFERENCES_FILE: join(fixture, 'preferences.jsonc'),
        },
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )
    // Own the probe through the test lifetime: the gate ends it as soon as
    // teardown starts, before the lifetime waits for this body. SIGKILL after
    // a short grace is the backstop for a watcher that outlives SIGTERM.
    const cancel = lifetimes.gate()
    const cancellation = cancel.wait.then(async () => {
      if (running.exitCode !== null) return
      running.kill('SIGTERM')
      await Bun.sleep(500)
      if (running.exitCode === null) running.kill('SIGKILL')
    })
    lifetimes.trackDetached(cancellation)
    const stdoutPromise = new Response(running.stdout).text()
    const stderrPromise = new Response(running.stderr).text()
    const joined = Promise.all([stdoutPromise, stderrPromise, running.exited])
    lifetimes.trackDetached(
      joined.then(
        () => {},
        (error) => {
          throw error
        },
      ),
    )
    const exited = await Promise.race([
      running.exited.then(() => true),
      Bun.sleep(8_000).then(() => false),
    ])
    if (!exited) {
      running.kill('SIGTERM')
      const killed = await Promise.race([
        running.exited.then(() => true),
        Bun.sleep(500).then(() => false),
      ])
      if (!killed) running.kill('SIGKILL')
    }
    const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise])
    // The child has exited and both pipes have ended; the gate is no longer
    // needed for cancellation.
    cancel.open()
    await cancellation
    await joined
    expect({ exited, exitCode: running.exitCode, stderr }).toEqual({
      exited: true,
      exitCode: 0,
      stderr: '',
    })
    expect(JSON.parse(stdout.trim().split('\n').at(-1) ?? '{}')).toEqual({
      slotCalls: 1,
      setupReturned: 'function',
    })
  },
  SUBPROCESS_TIMEOUT_MS,
)

test(
  'OpenCode 2 sidebar countdowns advance while the server answers the same state',
  async () => {
    const result = await renderOpenCode2Sidebar(
      [quotaState()],
      [
        { wanted: ['40% left', '2h59m'], calls: 2, advanceMs: 3_600_000 },
        { wanted: ['1h59m'] },
      ],
    )
    expect(result.frames[1]).toContain('40% left')
    expect(result.frames[1]).not.toContain('2h59m')
  },
  SUBPROCESS_TIMEOUT_MS,
)

test(
  'OpenCode 2 sidebar keeps the last quota when later polls fail',
  async () => {
    const result = await renderOpenCode2Sidebar(
      [quotaState(), null],
      [
        { wanted: ['40% left'], calls: 3, advanceMs: 1_800_000 },
        { wanted: ['40% left', '2h29m'], calls: 4 },
      ],
    )
    expect(result.frames[1]).not.toContain('Waiting for quota')
  },
  SUBPROCESS_TIMEOUT_MS,
)

// OpenCode 2's session sidebar is 42 cells with 2 cells of padding each side;
// its scrollbar floats over the slot box's 1-cell right padding, so a plugin
// gets 37 cells.
for (const width of [37, 42]) {
  test(
    `OpenCode 2 sidebar at ${width} columns keeps every quota row of five accounts on one line with short scoped names`,
    async () => {
      const result = await renderOpenCode2Sidebar(
        [fiveAccountSidebarState()],
        [{ wanted: ['backup', 'checked 1d6h ago', 'Routing'] }],
        { width, height: 70 },
      )
      const [frame] = result.frames
      const rows = expectOneLineQuotaRows(frame!, [
        'main',
        'work',
        'personal',
        'team',
        'backup',
      ])
      expect(rows).toHaveLength(15)
      expect(rows.filter((row) => row.trim().startsWith('Fa '))).toHaveLength(5)
      expect(frame).not.toContain('Fable')
      for (const row of rows) expect(row).toMatch(/left( •)? +\d+[a-z]/)
    },
    SUBPROCESS_TIMEOUT_MS,
  )
}
