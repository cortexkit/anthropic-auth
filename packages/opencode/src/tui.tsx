/** @jsxImportSource @opentui/solid */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type {
  TuiPlugin,
  TuiPluginApi,
  TuiPluginModule,
} from '@opencode-ai/plugin/tui'
import { For, type JSX, Show, createSignal, onCleanup } from 'solid-js'

import {
  type AccountQuota,
  DEFAULT_SIDEBAR_STATE,
  type SidebarState,
  getSidebarState,
  resolveActiveAccount,
} from './sidebar-state.js'

const POLL_MS = 1500
const REFRESH_DEBOUNCE_MS = 200

const ID = 'cortexkit.anthropic-auth'
const BAR_WIDTH = 10
const BAR_FILLED = '\u2588'
const BAR_EMPTY = '\u2591'

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

function usageTone(usedPct: number): Tone {
  if (usedPct < 50) return 'ok'
  if (usedPct < 80) return 'warn'
  return 'err'
}

function quotaBar(usedPct: number, width = BAR_WIDTH): string {
  const filled = Math.max(
    0,
    Math.min(Math.round((usedPct / 100) * width), width),
  )
  return BAR_FILLED.repeat(filled) + BAR_EMPTY.repeat(width - filled)
}

function formatResetIn(resetsAt: string | undefined): string {
  if (!resetsAt) return ''
  const ms = new Date(resetsAt).getTime() - Date.now()
  if (ms <= 0) return 'now'
  const mins = Math.floor(ms / 60_000)
  if (mins < 60) return `${mins}m`
  const hrs = Math.floor(mins / 60)
  const rm = mins % 60
  return rm > 0 ? `${hrs}h${rm}m` : `${hrs}h`
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
// with an optional muted reset suffix.
function QuotaRow(props: {
  theme: ThemeCurrent
  label: string
  window: { usedPercent: number; resetsAt?: string } | undefined
}) {
  const used = () => props.window?.usedPercent ?? 0
  const reset = () => formatResetIn(props.window?.resetsAt)
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
          <text fg={toneColor(props.theme, usageTone(used()))}>
            {quotaBar(used())}
          </text>
          <text fg={toneColor(props.theme, usageTone(used()))}>
            {` ${String(Math.round(used())).padStart(3)}%`}
          </text>
        </box>
        <Show when={reset()}>
          <text fg={props.theme.textMuted}>{reset()}</text>
        </Show>
      </box>
    </Show>
  )
}

// Account block: header row (name + status word) then per-window quota rows.
function AccountBlock(props: {
  theme: ThemeCurrent
  name: string
  quota: AccountQuota | null
  active: boolean
  marginTop?: number
}) {
  const statusWord = () => (props.active ? 'active' : 'idle')
  const statusTone = (): Tone => (props.active ? 'ok' : 'muted')
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
          label='5h'
          window={props.quota?.five_hour}
        />
        <QuotaRow
          theme={props.theme}
          label='7d'
          window={props.quota?.seven_day}
        />
      </Show>
    </box>
  )
}

// --- State plumbing ---------------------------------------------------------

async function readStateFromFile(): Promise<SidebarState> {
  return getSidebarState()
}

function QuotaSidebar(props: { api: TuiPluginApi }) {
  const [state, setState] = createSignal<SidebarState>(DEFAULT_SIDEBAR_STATE)
  const [collapsed, setCollapsed] = createSignal(false)
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
    }, REFRESH_DEBOUNCE_MS)
  }

  // Background poller (server and TUI run as separate module instances, so we
  // sync through the state file) plus event-driven refreshes for low latency.
  const timer = setInterval(refresh, POLL_MS)
  const unsubs = [
    props.api.event.on('session.updated', scheduleRefresh),
    props.api.event.on('message.updated', scheduleRefresh),
  ]
  setTimeout(refresh, 300)
  onCleanup(() => {
    clearInterval(timer)
    if (debounce) clearTimeout(debounce)
    for (const u of unsubs) u()
  })

  const theme = () => props.api.theme.current
  const enabledFallbacks = () => state().fallbacks.filter((f) => f.enabled)
  const hasData = () =>
    state().main.quota != null || enabledFallbacks().length > 0

  const headerLabel = () =>
    !hasData() ? 'CLAUDE' : collapsed() ? '\u25b6 CLAUDE' : '\u25bc CLAUDE'
  const activeAccount = () => resolveActiveAccount(state())
  const activeFiveHourPct = () =>
    activeAccount().quota?.five_hour?.usedPercent ?? null

  const quotaBackedOff = () => state().main.quotaBackedOff === true
  const refreshBackedOff = () => state().main.refreshBackedOff === true
  const degraded = () => quotaBackedOff() || refreshBackedOff()

  const cacheKeep = () => state().cacheKeep
  const showCache = () => cacheKeep() != null && cacheKeep()?.window != null
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
          if (hasData()) setCollapsed((value) => !value)
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
            <Show when={PLUGIN_VERSION !== ''}>
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

      {/* Collapsed: active account 5h quota + dot, plus fast-mode when on */}
      <Show when={collapsed() && hasData()}>
        <CollapsedRow theme={theme()} label={activeAccount().name}>
          <Show
            when={activeFiveHourPct() != null}
            fallback={<text fg={theme().textMuted}>{'\u2014'}</text>}
          >
            <box flexDirection='row'>
              <text
                fg={toneColor(
                  theme(),
                  usageTone(activeFiveHourPct() as number),
                )}
              >
                <b>
                  {`${String(Math.round(activeFiveHourPct() as number)).padStart(3)}%`}
                </b>
              </text>
              <text
                fg={toneColor(
                  theme(),
                  usageTone(activeFiveHourPct() as number),
                )}
              >
                {' \u25cf'}
              </text>
            </box>
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
          <SectionHeader theme={theme()} title='Quota' />
          <AccountBlock
            theme={theme()}
            name='main'
            quota={state().main.quota}
            active={state().activeId === 'main'}
          />
          <For each={enabledFallbacks()}>
            {(fb) => (
              <AccountBlock
                theme={theme()}
                name={fb.label ?? fb.id}
                quota={fb.quota}
                active={state().activeId === fb.id}
                marginTop={1}
              />
            )}
          </For>
        </Show>

        {/* Routing */}
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
        <Show when={degraded()}>
          <SectionHeader theme={theme()} title='Health' />
          <Show when={quotaBackedOff()}>
            <StatRow
              theme={theme()}
              label='Quota API'
              value={`backoff ${formatUntil(state().main.quotaBackoffUntil)}`}
              tone='warn'
            />
          </Show>
          <Show when={refreshBackedOff()}>
            <StatRow
              theme={theme()}
              label='Token refresh'
              value={`backoff ${formatUntil(state().main.refreshBackoffUntil)}`}
              tone='warn'
            />
          </Show>
        </Show>
      </Show>
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 160,
    slots: {
      sidebar_content(_ctx: unknown, _props: { session_id: string }) {
        return <QuotaSidebar api={api} />
      },
    },
  })
}

const plugin: TuiPluginModule & { id: string } = {
  id: ID,
  tui,
}

export default plugin
