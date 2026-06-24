/** @jsxImportSource @opentui/solid */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type {
  TuiPlugin,
  TuiPluginApi,
  TuiPluginModule,
} from '@opencode-ai/plugin/tui'
import {
  createEffect,
  createSignal,
  For,
  type JSX,
  onCleanup,
  Show,
} from 'solid-js'
import { createRpcClient } from './rpc/rpc-client.js'
import { getRpcDir } from './rpc/rpc-dir.js'
import {
  type AccountQuota,
  computeQuotaPacing,
  DEFAULT_SIDEBAR_STATE,
  FIVE_HOUR_MS,
  getCollapsedQuotaSummary,
  getSidebarState,
  type QuotaPacing,
  resolveActiveAccount,
  SEVEN_DAY_MS,
  type SidebarState,
} from './sidebar-state.js'
import { openCommandDialog } from './tui/command-dialogs.js'
import {
  type AnthropicAuthTuiPrefs,
  type AppearancePrefs,
  computeEffectiveOrder,
  DEFAULT_SLOT_ORDER,
  PLUGIN_KEY,
  queueTuiPreferenceUpdate,
  readTuiPreferencesFile,
  resolveAnthropicAuthPrefs,
  watchTuiPreferences,
} from './tui-preferences.js'

const RPC_POLL_MS = 500
let rpcPollStarted = false

const ID = 'cortexkit.anthropic-auth'

// Plugin version for the header (mirrors the Magic Context / AFT convention).
// Read at runtime from package.json relative to this module — NOT a TS JSON
// import, which would break the declaration build (package.json is outside
// rootDir). tui.tsx ships as source (package.json exports["./tui"] →
// "./src/tui.tsx") and is never compiled into a deeper dist tree, so `..` from
// src/ is always the package root. Empty string on any failure → header shows
// the badge with no version.
const PLUGIN_VERSION: string = (() => {
  try {
    const here = dirname(fileURLToPath(import.meta.url))
    const raw = readFileSync(join(here, '..', 'package.json'), 'utf8')
    return (JSON.parse(raw) as { version?: string }).version ?? ''
  } catch {
    return ''
  }
})()

// biome-ignore lint/suspicious/noExplicitAny: opentui border prop not typed in plugin tui surface
const SINGLE_BORDER = { type: 'single' } as any

type Tone = 'ok' | 'warn' | 'err' | 'muted' | 'accent' | 'text'
type ThemeCurrent = TuiPluginApi['theme']['current']
type ThemeColor = ThemeCurrent['text']

// Tone -> theme token. Theme tokens only — never hardcoded colors. Fallbacks
// resolve to other theme tokens so the sidebar always tracks the active theme.
function toneColor(theme: ThemeCurrent, tone: Tone): ThemeColor {
  switch (tone) {
    case 'ok':
      return theme.success ?? theme.accent
    case 'warn':
      return theme.warning ?? theme.accent
    case 'err':
      return theme.error ?? theme.accent
    case 'muted':
      return theme.textMuted ?? theme.text
    case 'accent':
      return theme.accent ?? theme.text
    default:
      return theme.text
  }
}

function usageTone(usedPct: number, appearance: AppearancePrefs): Tone {
  if (usedPct < appearance.warnThreshold) return 'ok'
  if (usedPct < appearance.errorThreshold) return 'warn'
  return 'err'
}

interface BarSegment {
  text: string
  tone: Tone
}

const PACE_RESERVE_CHAR = '\u2592'
const PACE_DEFICIT_CHAR = '\u2593'

// Variant C pacing bar: normal fill up to min(used, pace), then a pace
// segment covering the gap — headroom being banked (reserve, ok tone) or the
// overshoot itself (deficit, err tone) — then empty cells. Without pacing the
// bar renders as a single fill+empty pair, identical to the pre-pacing look.
// Empty text nodes still occupy a phantom cell in the opentui flex row, so
// zero-length segments are dropped from every return path (plain and pacing).
function quotaBarSegments(
  usedPct: number,
  appearance: AppearancePrefs,
  pacing: QuotaPacing | null,
): BarSegment[] {
  const width = appearance.barWidth
  const cells = (pct: number) =>
    Math.max(0, Math.min(Math.round((pct / 100) * width), width))
  const usedCells = cells(usedPct)
  const fillTone = usageTone(usedPct, appearance)
  const plain: BarSegment[] = [
    { text: appearance.barFilledChar.repeat(usedCells), tone: fillTone },
    {
      text: appearance.barEmptyChar.repeat(width - usedCells),
      tone: fillTone,
    },
  ]
  if (!pacing) return plain.filter((segment) => segment.text.length > 0)
  const paceCells = cells(pacing.pacePercent)
  const lo = Math.min(usedCells, paceCells)
  const hi = Math.max(usedCells, paceCells)
  if (hi === lo) return plain.filter((segment) => segment.text.length > 0)
  const overspent = usedCells > paceCells
  return (
    [
      { text: appearance.barFilledChar.repeat(lo), tone: fillTone },
      {
        text: (overspent ? PACE_DEFICIT_CHAR : PACE_RESERVE_CHAR).repeat(
          hi - lo,
        ),
        tone: overspent ? 'err' : 'ok',
      },
      { text: appearance.barEmptyChar.repeat(width - hi), tone: fillTone },
    ] as BarSegment[]
  ).filter((segment) => segment.text.length > 0)
}

function formatResetIn(resetsAt: string | undefined): string {
  if (!resetsAt) return ''
  const ms = new Date(resetsAt).getTime() - Date.now()
  if (ms <= 0) return 'now'
  const mins = Math.floor(ms / 60_000)
  if (mins < 60) return `${mins}m`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) {
    const rm = mins % 60
    return rm > 0 ? `${hrs}h${rm}m` : `${hrs}h`
  }
  const days = Math.floor(hrs / 24)
  const rh = hrs % 24
  return rh > 0 ? `${days}d${rh}h` : `${days}d`
}

function formatUntil(until: number | undefined): string {
  if (!until) return ''
  const ms = until - Date.now()
  if (ms <= 0) return 'now'
  const mins = Math.ceil(ms / 60_000)
  if (mins < 60) return `${mins}m`
  const hrs = Math.floor(mins / 60)
  const rm = mins % 60
  return rm > 0 ? `${hrs}h${rm}m` : `${hrs}h`
}

// --- Reusable components (aft-style) ---------------------------------------

function SectionHeader(props: {
  theme: ThemeCurrent
  title: string
  marginTop?: number
}) {
  return (
    <box width='100%' marginTop={props.marginTop ?? 1}>
      <text fg={props.theme.text}>
        <b>{props.title}</b>
      </text>
    </box>
  )
}

function StatRow(props: {
  theme: ThemeCurrent
  label: string
  value: string
  tone?: Tone
}) {
  return (
    <box width='100%' flexDirection='row' justifyContent='space-between'>
      <text fg={props.theme.textMuted}>{props.label}</text>
      <text fg={toneColor(props.theme, props.tone ?? 'text')}>
        <b>{props.value}</b>
      </text>
    </box>
  )
}

// Compact row for the collapsed view: muted label left, caller-provided value
// right. Mirrors StatRow's layout so columns line up.
function CollapsedRow(props: {
  theme: ThemeCurrent
  label: string
  children: JSX.Element
}) {
  return (
    <box width='100%' flexDirection='row' justifyContent='space-between'>
      <text fg={props.theme.textMuted}>{props.label}</text>
      {props.children}
    </box>
  )
}

// Quota window row: muted label left, tone-colored bar + percentage right,
// with an optional muted reset suffix. When pacing data is present, the bar
// gains a pace segment and an off-pace window adds a muted subline with the
// reserve/deficit delta and the projected runout.
function QuotaRow(props: {
  theme: ThemeCurrent
  appearance: AppearancePrefs
  label: string
  window: { usedPercent: number; resetsAt?: string } | undefined
  pacing: QuotaPacing | null
}) {
  const used = () => props.window?.usedPercent ?? 0
  const reset = () => formatResetIn(props.window?.resetsAt)
  const paceLine = () => {
    const pacing = props.pacing
    if (!pacing || pacing.state === 'on-pace') return null
    const pct = Math.round(Math.abs(pacing.deltaPercent))
    if (pacing.state === 'reserve') return `reserve ${pct}% \u00b7 lasts`
    return pacing.runsOutAt
      ? `deficit ${pct}% \u00b7 out in ${formatResetIn(pacing.runsOutAt)}`
      : `deficit ${pct}% \u00b7 lasts`
  }
  return (
    <Show
      when={props.window}
      fallback={
        <box width='100%' flexDirection='row'>
          <text fg={props.theme.textMuted}>{props.label.padEnd(3)}</text>
          <text fg={props.theme.textMuted}>{'\u2014'}</text>
        </box>
      }
    >
      {/* Left group (label · bar · pct) stays left-aligned in fixed columns so
          bars and percentages line up across rows; the reset time is pushed to
          the right edge so reset times align in their own right column. */}
      <box width='100%' flexDirection='row' justifyContent='space-between'>
        <box flexDirection='row'>
          <text fg={props.theme.textMuted}>{props.label.padEnd(3)}</text>
          <For each={quotaBarSegments(used(), props.appearance, props.pacing)}>
            {(segment) => (
              <text fg={toneColor(props.theme, segment.tone)}>
                {segment.text}
              </text>
            )}
          </For>
          <text
            fg={toneColor(props.theme, usageTone(used(), props.appearance))}
          >
            {` ${String(Math.round(used())).padStart(3)}%`}
          </text>
        </box>
        <Show when={reset()}>
          <text fg={props.theme.textMuted}>{reset()}</text>
        </Show>
      </box>
      <Show when={paceLine()}>
        <box width='100%' flexDirection='row'>
          <text fg={props.theme.textMuted}>{'   '}</text>
          <text
            fg={toneColor(
              props.theme,
              props.pacing?.state === 'deficit' ? 'warn' : 'muted',
            )}
          >
            {paceLine()}
          </text>
        </box>
      </Show>
    </Show>
  )
}

// Account block: header row (name + status word) then per-window quota rows.
// Pacing is computed here — per window, against the wall clock at render time
// (re-evaluated on every state poll) — and disabled by passing false.
function AccountBlock(props: {
  theme: ThemeCurrent
  appearance: AppearancePrefs
  name: string
  quota: AccountQuota | null
  active: boolean
  pacingEnabled: boolean
  needsReauth?: boolean
  marginTop?: number
}) {
  const statusWord = () =>
    props.needsReauth ? 're-login' : props.active ? 'active' : 'idle'
  const statusTone = (): Tone =>
    props.needsReauth ? 'err' : props.active ? 'ok' : 'muted'
  const pacingFor = (
    window:
      | { usedPercent: number; remainingPercent: number; resetsAt?: string }
      | undefined,
    windowMs: number,
  ) =>
    props.pacingEnabled && window
      ? computeQuotaPacing(window, windowMs, Date.now())
      : null
  return (
    <box width='100%' flexDirection='column' marginTop={props.marginTop ?? 0}>
      <box width='100%' flexDirection='row' justifyContent='space-between'>
        <text fg={props.theme.text}>
          <b>{props.name}</b>
        </text>
        <text fg={toneColor(props.theme, statusTone())}>
          <b>{statusWord()}</b>
        </text>
      </box>
      <Show
        when={props.quota}
        fallback={<text fg={props.theme.textMuted}>{'checking\u2026'}</text>}
      >
        <QuotaRow
          theme={props.theme}
          appearance={props.appearance}
          label='5h'
          window={props.quota?.five_hour}
          pacing={pacingFor(props.quota?.five_hour, FIVE_HOUR_MS)}
        />
        <QuotaRow
          theme={props.theme}
          appearance={props.appearance}
          label='7d'
          window={props.quota?.seven_day}
          pacing={pacingFor(props.quota?.seven_day, SEVEN_DAY_MS)}
        />
      </Show>
    </box>
  )
}

// --- Quota dialog content ---------------------------------------------------

// Renders the same rich visualization as the sidebar (account blocks with
// quota bars + pacing) so the modal matches the sidebar look.
function QuotaDialogContent(props: {
  api: TuiPluginApi
  controller: SidebarController
}) {
  const prefs = props.controller.prefs
  const [state, setState] = createSignal<SidebarState>(DEFAULT_SIDEBAR_STATE)
  let lastUpdated = 0
  async function refresh() {
    const next = await readStateFromFile()
    if (next.lastUpdated !== lastUpdated) {
      lastUpdated = next.lastUpdated
      setState(next)
    }
  }
  createEffect(() => {
    const timer = setInterval(refresh, prefs().pollMs)
    onCleanup(() => clearInterval(timer))
  })
  setTimeout(refresh, 0)
  const theme = () => props.api.theme.current
  const enabledFallbacks = () =>
    (state().fallbacks ?? []).filter((f) => f.enabled)
  return (
    <box flexDirection='column' padding={2} width='100%' alignItems='center'>
      <box flexDirection='column' width={58}>
        <box width='100%' justifyContent='center' marginBottom={1}>
          <text fg={theme().text}>
            <b>Quota</b>
          </text>
        </box>
        <AccountBlock
          theme={theme()}
          appearance={prefs().appearance}
          name='main'
          quota={state().main?.quota}
          active={state().activeId === 'main'}
          pacingEnabled={prefs().sections.pacing}
        />
        <Show when={prefs().sections.fallbackAccounts}>
          <For each={enabledFallbacks()}>
            {(fb) => (
              <AccountBlock
                theme={theme()}
                appearance={prefs().appearance}
                name={fb.label ?? fb.id}
                quota={fb.quota}
                active={state().activeId === fb.id}
                pacingEnabled={prefs().sections.pacing}
                needsReauth={fb.needsReauth}
                marginTop={1}
              />
            )}
          </For>
        </Show>
      </box>
    </box>
  )
}

// --- State plumbing ---------------------------------------------------------

async function readStateFromFile(): Promise<SidebarState> {
  return getSidebarState()
}

interface SidebarController {
  prefs: () => AnthropicAuthTuiPrefs
  collapsed: () => boolean
  toggleCollapsed: () => void
}

// The TUI may unmount and remount sidebar_content when the user switches
// views (e.g. main -> subagent -> main). A remount re-runs the component
// body, so any signal created inside the component would reset to its
// seed. The controller lives in the plugin closure (process lifetime)
// and owns the durable prefs/collapse signals plus the single shared
// watcher subscription, so collapse and live pref reloads survive the
// remount. No effects or memos here — those need a Solid owner, so the
// poll-interval createEffect stays inside the component.
function createSidebarController(
  initialPrefs: AnthropicAuthTuiPrefs,
): SidebarController {
  const [prefs, setPrefs] = createSignal<AnthropicAuthTuiPrefs>(initialPrefs)
  const seedCollapsed =
    initialPrefs.rememberCollapsed && initialPrefs.collapsed != null
      ? initialPrefs.collapsed
      : initialPrefs.startCollapsed
  const [collapsed, setCollapsed] = createSignal(seedCollapsed)
  let lastPersistedCollapsed: boolean | null = initialPrefs.collapsed
  let lastApplied = JSON.stringify(initialPrefs)

  // The watcher lives for the plugin/process lifetime — it is intentionally
  // never disposed. Collapse guard mirrors the race-fix in toggleCollapsed:
  // lastPersistedCollapsed is advanced only once our own write lands, so
  // watcher echoes of the previous persisted value are rejected by the
  // `!==` check and cannot revert a user click.
  watchTuiPreferences(() => {
    void (async () => {
      const next = resolveAnthropicAuthPrefs(await readTuiPreferencesFile())
      const serialized = JSON.stringify(next)
      if (serialized === lastApplied) return
      lastApplied = serialized
      setPrefs(next)
      if (
        next.rememberCollapsed &&
        next.collapsed != null &&
        next.collapsed !== lastPersistedCollapsed
      ) {
        lastPersistedCollapsed = next.collapsed
        setCollapsed(next.collapsed)
      }
    })()
  })

  function toggleCollapsed() {
    const next = !collapsed()
    setCollapsed(next)
    if (prefs().rememberCollapsed) {
      void queueTuiPreferenceUpdate(PLUGIN_KEY, ['collapsed'], next).then(
        () => {
          lastPersistedCollapsed = next
        },
      )
    }
  }

  return { prefs, collapsed, toggleCollapsed }
}

function QuotaSidebar(props: {
  api: TuiPluginApi
  controller: SidebarController
}) {
  const prefs = props.controller.prefs
  const collapsed = props.controller.collapsed
  const [state, setState] = createSignal<SidebarState>(DEFAULT_SIDEBAR_STATE)
  let lastUpdated = 0
  let debounce: ReturnType<typeof setTimeout> | null = null

  async function refresh() {
    const next = await readStateFromFile()
    if (next.lastUpdated !== lastUpdated) {
      lastUpdated = next.lastUpdated
      setState(next)
    }
  }

  function scheduleRefresh() {
    if (debounce) clearTimeout(debounce)
    debounce = setTimeout(() => {
      debounce = null
      void refresh()
    }, prefs().refreshDebounceMs)
  }

  // Background poller (server and TUI run as separate module instances, so we
  // sync through the state file) plus event-driven refreshes for low latency.
  // The interval rebuilds whenever pollMs changes.
  createEffect(() => {
    const timer = setInterval(refresh, prefs().pollMs)
    onCleanup(() => clearInterval(timer))
  })
  const unsubs = [
    props.api.event.on('session.updated', scheduleRefresh),
    props.api.event.on('message.updated', scheduleRefresh),
  ]
  setTimeout(refresh, 300)

  onCleanup(() => {
    if (debounce) clearTimeout(debounce)
    for (const u of unsubs) u()
  })

  const theme = () => props.api.theme.current
  const enabledFallbacks = () =>
    (state().fallbacks ?? []).filter((f) => f.enabled)
  const hasData = () =>
    state().main?.quota != null || enabledFallbacks().length > 0

  const headerLabel = () => {
    const name = prefs().header.label
    return !hasData() ? name : collapsed() ? `\u25b6 ${name}` : `\u25bc ${name}`
  }
  const activeAccount = () => resolveActiveAccount(state())
  const activeQuotaSummary = () =>
    getCollapsedQuotaSummary(activeAccount().quota)
  const activePacingDeficit = () => {
    if (!prefs().sections.pacing) return false
    const quota = activeAccount().quota
    if (!quota) return false
    const now = Date.now()
    const windows: Array<[typeof quota.five_hour, number]> = [
      [quota.five_hour, FIVE_HOUR_MS],
      [quota.seven_day, SEVEN_DAY_MS],
    ]
    return windows.some(
      ([w, ms]) =>
        w != null && computeQuotaPacing(w, ms, now)?.state === 'deficit',
    )
  }
  const activeQuotaTone = (): Tone => {
    const summary = activeQuotaSummary()
    const values = [
      summary.fiveHourUsedPercent,
      summary.sevenDayUsedPercent,
    ].filter((value): value is number => value != null)
    // Pacing deficit is an advisory projection, not actual quota exhaustion,
    // so it can only BUMP the usage tone up to warn at most — never soften a
    // real warn/err usage reading and never paint a true red.
    const base: Tone =
      values.length > 0
        ? usageTone(Math.max(...values), prefs().appearance)
        : 'muted'
    if (!activePacingDeficit()) return base
    return base === 'ok' || base === 'muted' ? 'warn' : base
  }

  const quotaBackedOff = () => state().main?.quotaBackedOff === true
  const refreshBackedOff = () => state().main?.refreshBackedOff === true
  const needsReauth = () => enabledFallbacks().some((f) => f.needsReauth)
  const degraded = () => quotaBackedOff() || refreshBackedOff() || needsReauth()

  const cacheKeep = () => state().cacheKeep
  const showCache = () =>
    prefs().sections.cache && cacheKeep() != null && cacheKeep()?.window != null
  const relayValue = () => {
    const r = state().relay
    if (!r) return '\u2014'
    return `${r.transport} \u00b7 ${r.enabled ? 'on' : 'off'}`
  }

  return (
    <box
      width='100%'
      flexDirection='column'
      border={SINGLE_BORDER}
      borderColor={theme().borderActive}
      paddingTop={1}
      paddingBottom={1}
      paddingLeft={1}
      paddingRight={1}
    >
      {/* Header: ▼/▶ CLAUDE badge (click to collapse) + version, or LIMITED badge */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: opentui renders to a terminal, not the DOM — ARIA roles do not apply */}
      <box
        width='100%'
        flexDirection='row'
        justifyContent='space-between'
        alignItems='center'
        onMouseDown={() => {
          if (hasData()) props.controller.toggleCollapsed()
        }}
      >
        <box paddingLeft={1} paddingRight={1} backgroundColor={theme().accent}>
          <text fg={theme().background}>
            <b>{headerLabel()}</b>
          </text>
        </box>
        <Show
          when={degraded()}
          fallback={
            <Show when={prefs().header.showVersion && PLUGIN_VERSION !== ''}>
              <text fg={theme().textMuted}>{`v${PLUGIN_VERSION}`}</text>
            </Show>
          }
        >
          <box
            paddingLeft={1}
            paddingRight={1}
            backgroundColor={theme().warning}
          >
            <text fg={theme().background}>
              <b>{'LIMITED'}</b>
            </text>
          </box>
        </Show>
      </box>

      {/* Collapsed: active account 5h + 7d quota, plus fast-mode when on */}
      <Show when={collapsed() && hasData()}>
        <CollapsedRow theme={theme()} label={activeAccount().name}>
          <Show
            when={activeQuotaSummary().text != null}
            fallback={<text fg={theme().textMuted}>{'\u2014'}</text>}
          >
            <text fg={toneColor(theme(), activeQuotaTone())}>
              <b>{activeQuotaSummary().text}</b>
            </text>
          </Show>
        </CollapsedRow>
        <Show when={state().fastMode}>
          <CollapsedRow theme={theme()} label='Mode'>
            <text fg={toneColor(theme(), 'accent')}>
              <b>{'fast'}</b>
            </text>
          </CollapsedRow>
        </Show>
      </Show>

      {/* Expanded: full sections. Also render when there's no data so the
          sidebar can never go blank if data clears while collapsed. */}
      <Show when={!collapsed() || !hasData()}>
        <Show
          when={hasData()}
          fallback={
            <box marginTop={1} width='100%'>
              <text fg={theme().textMuted}>{'Waiting for quota\u2026'}</text>
            </box>
          }
        >
          {/* Quota */}
          <Show when={prefs().sections.quota}>
            <SectionHeader theme={theme()} title='Quota' />
            <AccountBlock
              theme={theme()}
              appearance={prefs().appearance}
              name='main'
              quota={state().main?.quota}
              active={state().activeId === 'main'}
              pacingEnabled={prefs().sections.pacing}
            />
            <Show when={prefs().sections.fallbackAccounts}>
              <For each={enabledFallbacks()}>
                {(fb) => (
                  <AccountBlock
                    theme={theme()}
                    appearance={prefs().appearance}
                    name={fb.label ?? fb.id}
                    quota={fb.quota}
                    active={state().activeId === fb.id}
                    pacingEnabled={prefs().sections.pacing}
                    needsReauth={fb.needsReauth}
                    marginTop={1}
                  />
                )}
              </For>
            </Show>
          </Show>
        </Show>

        {/* Routing */}
        <Show when={prefs().sections.routing}>
          <SectionHeader theme={theme()} title='Routing' />
          <StatRow
            theme={theme()}
            label='Route'
            value={state().route}
            tone='accent'
          />
          <StatRow
            theme={theme()}
            label='Mode'
            value={state().fastMode ? 'fast' : 'std'}
            tone={state().fastMode ? 'accent' : 'muted'}
          />
          <StatRow
            theme={theme()}
            label='Relay'
            value={relayValue()}
            tone={state().relay?.enabled ? 'ok' : 'muted'}
          />
        </Show>

        {/* Cache */}
        <Show when={showCache()}>
          <SectionHeader theme={theme()} title='Cache' />
          <StatRow
            theme={theme()}
            label='1h cache'
            value={`${cacheKeep()?.window} \u00b7 ${cacheKeep()?.enabled ? 'on' : 'off'}`}
            tone={cacheKeep()?.enabled ? 'ok' : 'muted'}
          />
          <Show when={(cacheKeep()?.trackedSessions ?? 0) > 0}>
            <StatRow
              theme={theme()}
              label='Tracked'
              value={String(cacheKeep()?.trackedSessions)}
              tone='text'
            />
          </Show>
        </Show>

        {/* Health — only when something is wrong */}
        <Show when={degraded() && prefs().sections.health}>
          <SectionHeader theme={theme()} title='Health' />
          <Show when={quotaBackedOff()}>
            <StatRow
              theme={theme()}
              label='Quota API'
              value={`backoff ${formatUntil(state().main?.quotaBackoffUntil)}`}
              tone='warn'
            />
          </Show>
          <Show when={refreshBackedOff()}>
            <StatRow
              theme={theme()}
              label='Token refresh'
              value={`backoff ${formatUntil(state().main?.refreshBackoffUntil)}`}
              tone='warn'
            />
          </Show>
        </Show>
      </Show>
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  const root = await readTuiPreferencesFile()
  const controller = createSidebarController(resolveAnthropicAuthPrefs(root))
  api.slots.register({
    order: computeEffectiveOrder(root, PLUGIN_KEY, DEFAULT_SLOT_ORDER),
    slots: {
      sidebar_content(_ctx: unknown, _props: { session_id: string }) {
        return <QuotaSidebar api={api} controller={controller} />
      },
    },
  })

  if (!rpcPollStarted) {
    rpcPollStarted = true
    const rpcClient = createRpcClient(
      getRpcDir(api.state.path.directory ?? ''),
      process.pid,
    )
    let lastNotificationId = 0
    let rpcInFlight = false
    setInterval(() => {
      if (rpcInFlight) return
      const current = (api.route as { current?: unknown }).current
      const resolved =
        typeof current === 'function' ? (current as () => unknown)() : current
      const sessionId = (
        resolved as { params?: { sessionID?: string } } | undefined
      )?.params?.sessionID
      rpcInFlight = true
      void rpcClient
        .pending(lastNotificationId, sessionId)
        .then((messages) => {
          for (const message of [...messages].sort((a, b) => a.id - b.id)) {
            lastNotificationId = Math.max(lastNotificationId, message.id)
            if (message.payload.command === 'claude-quota') {
              api.ui.dialog.setSize('xlarge')
              api.ui.dialog.replace(() => (
                <QuotaDialogContent api={api} controller={controller} />
              ))
              continue
            }
            openCommandDialog(api, message.payload, (command, args) =>
              rpcClient.apply({ command, arguments: args, sessionId }),
            )
          }
        })
        .catch(() => {})
        .finally(() => {
          rpcInFlight = false
        })
    }, RPC_POLL_MS)
  }
}

const plugin: TuiPluginModule & { id: string } = {
  id: ID,
  tui,
}

export default plugin
