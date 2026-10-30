/** @jsxImportSource @opentui/solid */

// The CLAUDE quota sidebar, shared by the OpenCode 1 and OpenCode 2 TUIs.
// Each host supplies the sidebar state, a flat theme token set and the
// preference controller; this module only renders.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  formatCreditAmounts,
  type QuotaWindowPart,
  quotaDisplayProjection,
  quotaWindowParts,
} from '@cortexkit/anthropic-auth-core'
import type { BoxRenderable, RGBA } from '@opentui/core'
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  Index,
  type JSX,
  onCleanup,
  Show,
} from 'solid-js'
import { createStore, reconcile } from 'solid-js/store'
import {
  type AccountQuota,
  computeQuotaPacing,
  DEFAULT_SIDEBAR_STATE,
  FIVE_HOUR_MS,
  fitPaceLine,
  fitQuotaRow,
  formatPrimeAccountValue,
  getCollapsedAccounts,
  getCollapsedQuotaSummary,
  getFableRecoverySummary,
  type QuotaPacing,
  quotaLabelColumnWidth,
  resolveActiveAccount,
  SEVEN_DAY_MS,
  type SidebarState,
  scopedQuotaShortNames,
} from '../sidebar-state.js'
import {
  type AnthropicAuthTuiPrefs,
  type AppearancePrefs,
  PLUGIN_KEY,
  queueTuiPreferenceUpdate,
  readTuiPreferencesFile,
  resolveAnthropicAuthPrefs,
  watchTuiPreferences,
} from '../tui-preferences.js'
import {
  type AccountView,
  type PaceView,
  type Tone as SharedTone,
  SidebarFrame,
  SidebarTextRow,
} from './quota-sidebar.js'

// Read package metadata from either the raw src/ entry or its generated
// src/tui-compiled/tui/ counterpart. Avoid a JSON import because package.json sits
// outside the declaration build's rootDir.
const PLUGIN_VERSION: string = (() => {
  const here = dirname(fileURLToPath(import.meta.url))
  for (const packageFile of [
    join(here, '..', '..', 'package.json'),
    join(here, '..', '..', '..', 'package.json'),
  ]) {
    try {
      const raw = readFileSync(packageFile, 'utf8')
      const version = (JSON.parse(raw) as { version?: string }).version
      if (version) return version
    } catch {
      // Try the path for the other TUI entry layout.
    }
  }
  return ''
})()

export type SidebarColor = RGBA | string

/** The flat theme tokens the sidebar draws with; OpenCode 1's `theme.current` has them all. */
export interface SidebarTheme {
  readonly text: SidebarColor
  readonly textMuted: SidebarColor
  readonly success: SidebarColor
  readonly warning: SidebarColor
  readonly error: SidebarColor
  readonly accent: SidebarColor
  readonly background: SidebarColor
  readonly borderActive: SidebarColor
}

type Tone = 'ok' | 'warn' | 'err' | 'muted' | 'accent' | 'text'

// Tone -> theme token. Theme tokens only — never hardcoded colors. Fallbacks
// resolve to other theme tokens so the sidebar always tracks the active theme.
function toneColor(theme: SidebarTheme, tone: Tone): SidebarColor {
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

function sharedTone(tone: Tone): SharedTone {
  return tone === 'ok'
    ? 'success'
    : tone === 'warn'
      ? 'warning'
      : tone === 'err'
        ? 'error'
        : tone === 'muted'
          ? 'textMuted'
          : tone
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
  width: number,
): BarSegment[] {
  if (width <= 0) return []
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

function formatResetIn(resetsAt: string | undefined, now: number): string {
  if (!resetsAt) return ''
  const ms = new Date(resetsAt).getTime() - now
  // A pacing runout under a minute away is not `now` while quota remains;
  // the exhausted window never reaches this formatter with an `out in` line.
  if (ms < 60_000) return '<1m'
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

function formatUntil(until: number | undefined, now: number): string {
  if (!until) return ''
  const ms = until - now
  if (ms <= 0) return 'now'
  const mins = Math.ceil(ms / 60_000)
  if (mins < 60) return `${mins}m`
  const hrs = Math.floor(mins / 60)
  const rm = mins % 60
  return rm > 0 ? `${hrs}h${rm}m` : `${hrs}h`
}

// --- Reusable components (aft-style) ---------------------------------------

function SectionHeader(props: {
  theme: SidebarTheme
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
  theme: SidebarTheme
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
  theme: SidebarTheme
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

// One cell run of a single-line row: drawn at its own width, never shrunk and
// never wrapped, so the row's layout is exactly what `fitQuotaRow` measured.
function Cell(props: { fg: SidebarColor; text: string }) {
  return (
    <text
      width={Bun.stringWidth(props.text)}
      flexShrink={0}
      wrapMode='none'
      fg={props.fg}
    >
      {props.text}
    </text>
  )
}

// Quota window row: muted label left in a column `labelWidth` wide, then the
// tone-colored bar and the shared figure, and the muted reset at the right
// edge. The row is one line: `fitQuotaRow` drops detail to fit `width`
// instead of letting it wrap. When pacing data is present, the bar gains a
// pace segment and an off-pace window adds a one-line subline under the bar
// with the reserve/deficit delta and either the projected runout or
// `lasts to reset`; a window already at 0% left names itself used up until
// its reset instead.
function QuotaRow(props: {
  theme: SidebarTheme
  appearance: AppearancePrefs
  label: string
  labelWidth: number
  /** The row's laid-out width, undefined until the first layout. */
  width: number | undefined
  part: QuotaWindowPart | undefined
  usedPercent: number | undefined
  pacing: QuotaPacing | null
  binding?: boolean
  now: number
}) {
  const used = () => props.usedPercent ?? 0
  const labelCell = () =>
    `${props.label}${' '.repeat(Math.max(0, props.labelWidth - Bun.stringWidth(props.label)))} `
  const figure = () =>
    `${props.part?.figure ?? ''}${props.binding ? ' \u2022' : ''}`
  const fit = () =>
    fitQuotaRow({
      width: props.width,
      labelWidth: props.labelWidth,
      barWidth: props.appearance.barWidth,
      figure: figure(),
      reset: props.part?.resetIn,
    })
  const paceLine = () =>
    fitPaceLine(
      props.pacing,
      props.width === undefined
        ? undefined
        : props.width - props.labelWidth - 1,
      props.pacing?.runsOutAt
        ? formatResetIn(props.pacing.runsOutAt, props.now)
        : undefined,
      props.part?.resetIn,
      props.part?.remainingPercent,
    )
  return (
    <Show
      when={props.part}
      fallback={
        <box width='100%' height={1} flexDirection='row'>
          <Cell fg={props.theme.textMuted} text={`${labelCell()}\u2014`} />
        </box>
      }
    >
      {/* The label column is the same width in every row, so bars start in
          one column; a bar shrinks only when its row needs the room. The
          reset is pushed to the right edge, always at least one space after
          the figure. */}
      <box width='100%' height={1} flexDirection='row'>
        <Cell fg={props.theme.textMuted} text={labelCell()} />
        {/* Index: the clock rebuilds the segments, which must not remount. */}
        <Index
          each={quotaBarSegments(
            used(),
            props.appearance,
            props.pacing,
            fit().barCells,
          )}
        >
          {(segment) => (
            <Cell
              fg={toneColor(props.theme, segment().tone)}
              text={segment().text}
            />
          )}
        </Index>
        <Cell
          fg={toneColor(props.theme, usageTone(used(), props.appearance))}
          text={`${fit().barCells > 0 ? ' ' : ''}${figure()}`}
        />
        <box flexGrow={1} />
        <Show when={fit().reset}>
          {(reset: () => string) => (
            <Cell fg={props.theme.textMuted} text={` ${reset()}`} />
          )}
        </Show>
      </box>
      <Show when={paceLine()}>
        {(line: () => string) => (
          <box width='100%' height={1} flexDirection='row'>
            <Cell
              fg={props.theme.textMuted}
              text={' '.repeat(props.labelWidth + 1)}
            />
            <Cell
              fg={toneColor(
                props.theme,
                props.pacing?.state === 'deficit' ? 'warn' : 'muted',
              )}
              text={line()}
            />
          </box>
        )}
      </Show>
    </Show>
  )
}

// The shared credit figure followed by the spent and limit amounts:
// `credits 75% left · $25.00/$100.00`. When that line is wider than the
// measured width, the amounts drop their cents (`$1,250/$5,000`) instead of
// wrapping onto a second line.
function creditLine(
  figure: string,
  extraUsage: AccountQuota['extraUsage'],
  width: number | undefined,
) {
  const amounts = formatCreditAmounts(extraUsage)
  if (!amounts) return figure
  const line = `${figure} · ${amounts}`
  if (width === undefined || Bun.stringWidth(line) <= width) return line
  return `${figure} · ${formatCreditAmounts(extraUsage, { wholeUnits: true })}`
}

// Account block: header row (name + status word) then per-window quota rows.
// Pacing is computed here — per window, against the wall clock at render time
// (re-evaluated on every state poll) — and disabled by passing false.
export function AccountBlock(props: {
  theme: SidebarTheme
  appearance: AppearancePrefs
  name: string
  quota: AccountQuota | null
  active: boolean
  pacingEnabled: boolean
  needsReauth?: boolean
  vaultReauth?: boolean
  stateLine?: string
  quotaDated?: boolean
  tierLabel?: string
  /**
   * The quota rows' label column width, shared across the sidebar's accounts
   * so their bars line up; defaults to this account's own longest label.
   */
  labelWidth?: number
  marginTop?: number
  now: number
}) {
  const statusWord = () =>
    props.quotaDated && props.quota
      ? 'dated'
      : props.needsReauth
        ? 're-login'
        : props.vaultReauth
          ? 'needs sign-in in the vault'
          : props.active
            ? 'active'
            : 'idle'
  const statusTone = (): Tone =>
    props.needsReauth || props.vaultReauth || props.stateLine
      ? 'warn'
      : props.active
        ? 'ok'
        : 'muted'
  const pacingFor = (
    window:
      | { usedPercent: number; remainingPercent: number; resetsAt?: string }
      | undefined,
    windowMs: number,
  ) =>
    props.pacingEnabled && !props.quotaDated && window
      ? computeQuotaPacing(window, windowMs, props.now)
      : null
  const parts = () =>
    quotaWindowParts(quotaDisplayProjection(props.quota, props.now), {
      now: props.now,
    })
  const partFor = (name: string) =>
    parts().windows.find((part) => part.name === name)
  const scopedLabels = () => scopedQuotaShortNames(props.quota, props.now)
  const labelWidth = () =>
    props.labelWidth ?? quotaLabelColumnWidth([props.quota], props.now)
  // The block's laid-out width, read when it mounts and on each resize. Quota
  // rows drop or shrink detail to fit it (and are cut at the edge when even
  // that is not enough); pacing sublines are cut to fit. Undefined until layout.
  const [width, setWidth] = createSignal<number>()
  let block: BoxRenderable | undefined
  return (
    <box
      width='100%'
      flexDirection='column'
      marginTop={props.marginTop ?? 0}
      ref={(element: BoxRenderable) => {
        block = element
        setWidth(element.width || undefined)
      }}
      onSizeChange={() => setWidth(block?.width || undefined)}
    >
      <box width='100%' flexDirection='row' justifyContent='space-between'>
        <text fg={props.theme.text}>
          <b>{`${props.name}${props.tierLabel ? ` · ${props.tierLabel}` : ''}`}</b>
        </text>
        <text fg={toneColor(props.theme, statusTone())}>
          <b>{statusWord()}</b>
        </text>
      </box>
      <Show when={props.stateLine}>
        <text fg={props.theme.textMuted}>{props.stateLine}</text>
      </Show>
      <Show
        when={props.quota}
        fallback={<text fg={props.theme.textMuted}>{'checking\u2026'}</text>}
      >
        <QuotaRow
          theme={props.theme}
          appearance={props.appearance}
          label='5h'
          labelWidth={labelWidth()}
          width={width()}
          part={partFor('5h')}
          usedPercent={props.quota?.five_hour?.usedPercent}
          pacing={pacingFor(props.quota?.five_hour, FIVE_HOUR_MS)}
          binding={props.quota?.bindingWindow === 'five_hour'}
          now={props.now}
        />
        <QuotaRow
          theme={props.theme}
          appearance={props.appearance}
          label='7d'
          labelWidth={labelWidth()}
          width={width()}
          part={partFor('7d')}
          usedPercent={props.quota?.seven_day?.usedPercent}
          pacing={pacingFor(props.quota?.seven_day, SEVEN_DAY_MS)}
          binding={props.quota?.bindingWindow === 'seven_day'}
          now={props.now}
        />
        <For each={props.quota?.scoped ?? []}>
          {(window, index) => (
            <QuotaRow
              theme={props.theme}
              appearance={props.appearance}
              label={scopedLabels()[index()] ?? window.title}
              labelWidth={labelWidth()}
              width={width()}
              part={partFor(window.title)}
              usedPercent={window.usedPercent}
              pacing={pacingFor(window, SEVEN_DAY_MS)}
              binding={props.quota?.bindingWindow === window.id}
              now={props.now}
            />
          )}
        </For>
        <Show when={partFor('credits')}>
          {(budget: () => QuotaWindowPart) => (
            // One line in the block's width: amounts drop their cents rather
            // than wrap, and keep them until the first layout.
            <box width='100%' height={1} flexDirection='row'>
              <text
                wrapMode='none'
                fg={toneColor(
                  props.theme,
                  props.quota?.extraUsage?.severity === 'critical'
                    ? 'err'
                    : props.quota?.extraUsage?.severity === 'warning' ||
                        props.quota?.extraUsage?.exhausted
                      ? 'warn'
                      : 'muted',
                )}
              >
                {creditLine(budget().figure, props.quota?.extraUsage, width())}
              </text>
            </box>
          )}
        </Show>
        <Show when={parts().age}>
          <text fg={props.theme.textMuted}>{parts().age}</text>
        </Show>
        <Show when={props.quota?.fallbackAdvised === true}>
          <text fg={props.theme.textMuted}>{'→ fallback advised'}</text>
        </Show>
      </Show>
    </box>
  )
}

function AccountExtras(props: {
  quota: AccountQuota | null
  now: number
  theme: SidebarTheme
}) {
  const [width, setWidth] = createSignal<number>()
  let block: BoxRenderable | undefined
  const budget = () =>
    quotaWindowParts(quotaDisplayProjection(props.quota, props.now), {
      now: props.now,
    }).windows.find((part) => part.kind === 'budget')
  return (
    <box
      width='100%'
      flexDirection='column'
      ref={(element: BoxRenderable) => {
        block = element
        setWidth(element.width || undefined)
      }}
      onSizeChange={() => setWidth(block?.width || undefined)}
    >
      <Show when={budget()}>
        {(part: () => QuotaWindowPart) => (
          <box width='100%' height={1} flexDirection='row'>
            <text
              wrapMode='none'
              fg={toneColor(
                props.theme,
                props.quota?.extraUsage?.severity === 'critical'
                  ? 'err'
                  : props.quota?.extraUsage?.severity === 'warning' ||
                      props.quota?.extraUsage?.exhausted
                    ? 'warn'
                    : 'muted',
              )}
            >
              {creditLine(part().figure, props.quota?.extraUsage, width())}
            </text>
          </box>
        )}
      </Show>
      <Show when={props.quota?.fallbackAdvised === true}>
        <SidebarTextRow text='→ fallback advised' />
      </Show>
    </box>
  )
}

export interface SidebarController {
  prefs: () => AnthropicAuthTuiPrefs
  collapsed: () => boolean
  toggleCollapsed: () => void
  /** Stops the preference watcher; OpenCode 1 keeps it for the process. */
  dispose: () => void
  /**
   * However many refreshes in a row have failed, a retry never waits longer
   * than this. Every attempt costs the server a full runtime read, so a
   * failing sidebar must not keep trying at the poll rate forever.
   */
  retryMaxMs: number
}

// The TUI may unmount and remount sidebar_content when the user switches
// views (e.g. main -> subagent -> main). A remount re-runs the component
// body, so any signal created inside the component would reset to its
// seed. The controller lives in the plugin closure (process lifetime)
// and owns the durable prefs/collapse signals plus the single shared
// watcher subscription, so collapse and live pref reloads survive the
// remount. No effects or memos here — those need a Solid owner, so the
// poll-interval createEffect stays inside the component.
export function createSidebarController(
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

  // OpenCode 1 keeps the watcher for the process lifetime; OpenCode 2 calls
  // dispose when the plugin unloads. Collapse guard mirrors the race-fix in toggleCollapsed:
  // lastPersistedCollapsed is advanced only once our own write lands, so
  // watcher echoes of the previous persisted value are rejected by the
  // `!==` check and cannot revert a user click.
  const dispose = watchTuiPreferences(() => {
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

  return { prefs, collapsed, toggleCollapsed, dispose, retryMaxMs: 30_000 }
}

/** The sidebar panel for one session; the host owns polling and the theme. */
export function ClaudeSidebar(props: {
  state: () => SidebarState
  theme: () => SidebarTheme
  controller: SidebarController
  sessionId: string
}) {
  const prefs = props.controller.prefs
  const collapsed = props.controller.collapsed
  const state = props.state
  const theme = props.theme
  // Countdowns, reading ages and pacing read this clock, so they advance on
  // each tick and state change without a new answer or rebuilt rows.
  const [tick, setTick] = createSignal(0)
  createEffect(() => {
    const timer = setInterval(() => setTick((n) => n + 1), prefs().pollMs)
    onCleanup(() => clearInterval(timer))
  })
  const now = createMemo(() => {
    tick()
    state()
    return Date.now()
  })
  const enabledFallbacks = () =>
    (state().fallbacks ?? []).filter(
      (f) => f.enabled || (f.custodyState && f.custodyState !== 'off'),
    )
  const hasData = () =>
    state().main?.quota != null ||
    state().main?.stateLine != null ||
    enabledFallbacks().length > 0
  const activeAccount = () => resolveActiveAccount(state())
  const activeQuotaSummary = () =>
    getCollapsedQuotaSummary(activeAccount().quota, now())
  const activePacingDeficit = () => {
    if (!prefs().sections.pacing) return false
    if (activeAccount().quotaDated) return null
    const quota = activeAccount().quota
    if (!quota) return false
    const windows: Array<
      [
        (
          | { usedPercent: number; remainingPercent: number; resetsAt?: string }
          | undefined
        ),
        number,
      ]
    > = [
      [quota.five_hour, FIVE_HOUR_MS],
      [quota.seven_day, SEVEN_DAY_MS],
      ...(quota.scoped ?? []).map((window): [typeof window, number] => [
        window,
        SEVEN_DAY_MS,
      ]),
    ]
    return windows.some(
      ([w, ms]) =>
        w != null && computeQuotaPacing(w, ms, now())?.state === 'deficit',
    )
  }
  const activeQuotaTone = (): Tone => {
    const summary = activeQuotaSummary()
    const values = [
      summary.fiveHourUsedPercent,
      summary.sevenDayUsedPercent,
      ...summary.scopedUsedPercents,
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
  const vaultReauth = () => enabledFallbacks().some((f) => f.vaultReauth)
  const degraded = () =>
    quotaBackedOff() || refreshBackedOff() || needsReauth() || vaultReauth()

  const fableRecoverySummary = () =>
    getFableRecoverySummary(state(), props.sessionId)
  const fableRecoveryTone = (): Tone =>
    state().fableRecoveries?.find(
      (recovery) => recovery.sessionId === props.sessionId,
    )?.mode === 'fable'
      ? 'ok'
      : 'warn'
  const cacheKeep = () => state().cacheKeep
  const showCache = () =>
    prefs().sections.cache && cacheKeep() != null && cacheKeep()?.window != null
  const prime = () => state().prime
  const showPrime = () => prime() != null
  const primeHasError = () =>
    prime()?.accounts.some((account) => account.lastResult === 'error') ?? false
  const relayValue = () => {
    const r = state().relay
    if (!r) return '\u2014'
    return `${r.transport} \u00b7 ${r.enabled ? 'on' : 'off'}`
  }

  const accountDetail = (id: string) =>
    id === 'main'
      ? state().main
      : state().fallbacks?.find((account) => account.id === id)
  const accountViews = createMemo((): AccountView[] => {
    if (!hasData()) return []
    return getCollapsedAccounts(state(), prefs().sections.fallbackAccounts).map(
      (account): AccountView => {
        const detail = accountDetail(account.id)
        const quota = quotaDisplayProjection(account.quota, now())
        const needsReauth =
          detail && 'needsReauth' in detail && detail.needsReauth
        const vaultReauth =
          detail && 'vaultReauth' in detail && detail.vaultReauth
        const active = state().activeId === account.id
        const status =
          account.quotaDated && account.quota
            ? 'dated'
            : needsReauth
              ? 're-login'
              : vaultReauth
                ? 'needs sign-in in the vault'
                : active
                  ? 'active'
                  : 'idle'
        const groups = [
          {
            rows: quotaWindowParts(quota, { now: now() })
              .windows.filter((part) => part.kind === 'window')
              .map((part) => {
                const scoped = account.quota?.scoped?.find(
                  (window) => window.title === part.name,
                )
                const window =
                  part.name === '5h'
                    ? account.quota?.five_hour
                    : part.name === '7d'
                      ? account.quota?.seven_day
                      : scoped
                const pacing =
                  prefs().sections.pacing && !account.quotaDated && window
                    ? computeQuotaPacing(
                        window,
                        part.name === '5h' ? FIVE_HOUR_MS : SEVEN_DAY_MS,
                        now(),
                      )
                    : null
                const text = fitPaceLine(
                  pacing,
                  undefined,
                  pacing?.runsOutAt
                    ? formatResetIn(pacing.runsOutAt, now())
                    : undefined,
                  part.resetIn,
                  part.remainingPercent,
                )
                const pace: PaceView | undefined = pacing
                  ? {
                      text: text ?? '',
                      tone:
                        pacing.state === 'deficit' ? 'warning' : 'textMuted',
                      overlay: {
                        kind: pacing.deltaPercent > 0 ? 'deficit' : 'reserve',
                        percent: pacing.pacePercent,
                      },
                    }
                  : undefined
                const binding =
                  account.quota?.bindingWindow ===
                  (part.name === '5h'
                    ? 'five_hour'
                    : part.name === '7d'
                      ? 'seven_day'
                      : scoped?.id)
                return {
                  part: {
                    ...part,
                    name: part.short,
                    figure: `${part.figure}${binding ? ' •' : ''}`,
                  },
                  pace,
                }
              }),
          },
        ]
        return {
          id: account.id,
          label: account.name,
          titleSuffix: detail?.tierLabel,
          quota,
          groups,
          status: {
            text: status,
            tone:
              needsReauth || vaultReauth || detail?.stateLine
                ? 'warning'
                : active
                  ? 'success'
                  : 'textMuted',
          },
          blocked: Boolean(account.blocked),
          indicatorTone: account.blocked
            ? 'warning'
            : account.active
              ? 'success'
              : 'textMuted',
          collapsed: {
            muted: Boolean(
              !account.active ||
                account.quotaDated ||
                getCollapsedQuotaSummary(account.quota, now()).stale,
            ),
            quotaTone: sharedTone(activeQuotaTone()),
          },
          emptyQuotaText: { expanded: 'checking…', collapsed: '—' },
        }
      },
    )
  })
  // Polls rebuild snapshots, but account ids keep the shared frame's rows mounted.
  const [accounts, setAccounts] = createStore<AccountView[]>([])
  createEffect(() => setAccounts(reconcile(accountViews(), { key: 'id' })))

  return (
    <SidebarFrame
      header={{
        badge: prefs().header.label,
        version:
          prefs().header.showVersion && PLUGIN_VERSION !== ''
            ? `v${PLUGIN_VERSION}`
            : undefined,
      }}
      accounts={accounts}
      theme={theme()}
      appearance={prefs().appearance}
      showQuota={prefs().sections.quota}
      now={now()}
      collapsed={collapsed()}
      onToggle={props.controller.toggleCollapsed}
      beforeQuota={(account) => (
        <Show when={accountDetail(account.id)?.stateLine}>
          {(text: () => string) => <SidebarTextRow text={text()} />}
        </Show>
      )}
      afterQuota={(account) => (
        <AccountExtras
          quota={accountDetail(account.id)?.quota ?? null}
          now={now()}
          theme={theme()}
        />
      )}
      collapsedSections={() => (
        <>
          <Show when={state().fastMode}>
            <CollapsedRow theme={theme()} label='Mode'>
              <text fg={toneColor(theme(), 'accent')}>
                <b>{'fast'}</b>
              </text>
            </CollapsedRow>
          </Show>
          <Show when={fableRecoverySummary()}>
            {(summary: () => string) => (
              <CollapsedRow theme={theme()} label='Recovery'>
                <text fg={toneColor(theme(), fableRecoveryTone())}>
                  <b>{summary()}</b>
                </text>
              </CollapsedRow>
            )}
          </Show>
        </>
      )}
      sections={() => (
        <>
          <Show when={!hasData()}>
            <box marginTop={1} width='100%'>
              <text fg={theme().textMuted}>{'Waiting for quota\u2026'}</text>
            </box>
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

          <Show when={fableRecoverySummary()}>
            {(summary: () => string) => (
              <StatRow
                theme={theme()}
                label='Recovery'
                value={summary()}
                tone={fableRecoveryTone()}
              />
            )}
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

          {/* Prime — only when enabled. Expanded view only (no collapsed surface). */}
          <Show when={showPrime()}>
            <StatRow
              theme={theme()}
              label='Prime'
              value={primeHasError() ? 'err' : 'on'}
              tone={primeHasError() ? 'warn' : 'ok'}
            />
            <For each={prime()?.accounts ?? []}>
              {(account) => {
                const value = () => formatPrimeAccountValue(account, now())
                return (
                  <StatRow
                    theme={theme()}
                    label={account.label}
                    value={value().text}
                    tone={value().hasError ? 'warn' : 'text'}
                  />
                )
              }}
            </For>
          </Show>

          {/* Health — only when something is wrong */}
          <Show when={degraded() && prefs().sections.health}>
            <SectionHeader theme={theme()} title='Health' />
            <Show when={quotaBackedOff()}>
              <StatRow
                theme={theme()}
                label='Quota API'
                value={`backoff ${formatUntil(state().main?.quotaBackoffUntil, now())}`}
                tone='warn'
              />
            </Show>
            <Show when={refreshBackedOff()}>
              <StatRow
                theme={theme()}
                label='Token refresh'
                value={`backoff ${formatUntil(state().main?.refreshBackoffUntil, now())}`}
                tone='warn'
              />
            </Show>
          </Show>
        </>
      )}
    />
  )
}

// --- OpenCode 2 -------------------------------------------------------------

/** The OpenCode 2 theme tokens the sidebar reads (`ResolvedTheme` subset). */
export interface HostTheme {
  readonly text: {
    readonly base: SidebarColor
    readonly muted: SidebarColor
    readonly action: { readonly primary: { readonly base: SidebarColor } }
    readonly feedback: {
      readonly success: { readonly base: SidebarColor }
      readonly warning: { readonly base: SidebarColor }
      readonly error: { readonly base: SidebarColor }
    }
  }
  readonly background: { readonly base: SidebarColor }
  readonly border: { readonly base: SidebarColor }
}

/** OpenCode 2's semantic theme as the flat tokens OpenCode 1 provides. */
export function sidebarThemeFromHost(theme: HostTheme): SidebarTheme {
  return {
    text: theme.text.base,
    textMuted: theme.text.muted,
    success: theme.text.feedback.success.base,
    warning: theme.text.feedback.warning.base,
    error: theme.text.feedback.error.base,
    accent: theme.text.action.primary.base,
    background: theme.background.base,
    borderActive: theme.border.base,
  }
}

/** The OpenCode 2 TUI context members the sidebar uses. */
export interface ClaudeSidebarHost {
  readonly theme: HostTheme
  readonly ui: {
    slot(claim: {
      readonly append: 'sidebar.content'
      readonly render: (input: { readonly sessionID: string }) => JSX.Element
    }): () => void
  }
}

/** Reads one session's sidebar state from the location's server. */
export type ReadSidebarState = (
  sessionID: string,
  signal: AbortSignal,
) => Promise<SidebarState>

/**
 * What the sidebar reads and draws with, independent of the host chrome.
 * The timer functions default to the global ones; a test passes its own so it
 * can drive the refresh schedule without touching the shared globals.
 */
export interface HostSidebarPropsState {
  read: ReadSidebarState
  controller: SidebarController
  sessionId: string
  setTimeoutImpl?: typeof globalThis.setTimeout
  /** Clears a handle `setTimeoutImpl` returned, whatever type that was. */
  clearTimeoutImpl?: (handle: unknown) => void
}

interface HostSidebarProps extends HostSidebarPropsState {
  host: ClaudeSidebarHost
}

/** The refresh loop's own timers, so a test can drive its schedule. */
export interface SidebarScheduleTimers {
  setTimeoutImpl?: typeof globalThis.setTimeout
  clearTimeoutImpl?: (handle: unknown) => void
}

/**
 * Delay before the next refresh after `failures` failed reads in a row, each
 * one longer than the last until the controller's limit. A successful read
 * resets the count, so a healthy server is polled at the configured rate. A
 * failed read still costs the server a full runtime read, so retrying at the
 * poll rate keeps that cost alive for as long as the failure lasts.
 */
export function sidebarRetryDelay(
  pollMs: number,
  failures: number,
  retryMaxMs: number,
): number {
  if (failures <= 0) return pollMs
  return Math.min(pollMs * 2 ** failures, retryMaxMs)
}

/** Starts and stops the refresh schedule the sidebar lives on. */
export interface SidebarSchedule {
  /**
   * Reads once and then keeps the retry timer running. Safe to call more than
   * once: a running schedule is left alone.
   */
  start: () => void
  /**
   * Stops the schedule for good: clears the waiting timer and aborts a read
   * still in flight, so it cannot queue another one. The item that unmounts a
   * sidebar calls this; without it, a failing refresh would keep polling the
   * server from a sidebar nobody is looking at.
   */
  stop: () => void
}

// One read on start, then a timer that backs off after failures and resets
// after a success. Lives outside Solid: the component drives it from an
// effect, and tests drive it with their own timers.
export function createSidebarSchedule(
  options: {
    read: ReadSidebarState
    sessionId: string
    pollRate: () => { pollMs: number; retryMaxMs: number }
    /** Receives each answer that differs from the one before it. */
    onState: (state: SidebarState) => void
  } & SidebarScheduleTimers,
): SidebarSchedule {
  const {
    read,
    sessionId,
    pollRate,
    onState,
    setTimeoutImpl = setTimeout,
    clearTimeoutImpl = clearTimeout as (handle: unknown) => void,
  } = options
  const abort = new AbortController()
  // The timer waiting to run. Every schedule replaces it, so stopping always
  // clears the one that is actually queued.
  let timer: unknown
  let running = false
  let inFlight = false
  let shown = ''
  let failures = 0
  // `undefined` means the previous read was still running, which is not a
  // failure: counting it as one would back off before the server answered.
  const refresh = async (): Promise<boolean | undefined> => {
    if (inFlight || abort.signal.aborted) return undefined
    inFlight = true
    try {
      const next = await read(sessionId, abort.signal)
      // Every answer is stamped by the server; redraw only when its content
      // changed. Countdowns and ages advance on the sidebar's own clock.
      const content = JSON.stringify({ ...next, lastUpdated: 0 })
      if (!abort.signal.aborted && content !== shown) {
        shown = content
        onState(next)
      }
      return true
    } catch {
      // Keep the last state; an older server without `sidebar` keeps waiting.
      return false
    } finally {
      inFlight = false
    }
  }
  const schedule = () => {
    if (!running) return
    const { pollMs, retryMaxMs } = pollRate()
    const wait = sidebarRetryDelay(pollMs, failures, retryMaxMs)
    timer = setTimeoutImpl(async () => {
      timer = undefined
      if (!running) return
      const ok = await refresh()
      if (!running) return
      if (ok === true) failures = 0
      else if (ok === false) failures += 1
      schedule()
    }, wait)
  }
  return {
    start() {
      if (running || abort.signal.aborted) return
      running = true
      // The first read happens here rather than in the timer, so a caller that
      // starts before any draw still has an answer waiting for it. The loop
      // then continues on the retry timer below.
      void refresh().then((ok) => {
        if (running && ok === false) failures += 1
      })
      schedule()
    },
    stop() {
      running = false
      if (timer !== undefined) clearTimeoutImpl(timer)
      timer = undefined
      abort.abort()
    },
  }
}

// The OpenCode 2 sidebar's state: its refresh schedule, redrawn through a
// signal the component renders from.
export function useHostSidebarState(
  props: HostSidebarPropsState,
): () => SidebarState {
  const [state, setState] = createSignal<SidebarState>(DEFAULT_SIDEBAR_STATE)
  createEffect(() => {
    // Reading the poll rate here re-runs this effect when it changes. A
    // stopped schedule never restarts, so each run builds a fresh one and the
    // cleanup stops the run it belongs to.
    const pollMs = props.controller.prefs().pollMs
    const schedule = createSidebarSchedule({
      read: props.read,
      sessionId: props.sessionId,
      pollRate: () => ({ pollMs, retryMaxMs: props.controller.retryMaxMs }),
      onState: setState,
      setTimeoutImpl: props.setTimeoutImpl,
      clearTimeoutImpl: props.clearTimeoutImpl,
    })
    schedule.start()
    onCleanup(() => schedule.stop())
  })
  return state
}

function HostSidebar(props: HostSidebarProps) {
  const state = useHostSidebarState(props)
  return (
    <ClaudeSidebar
      state={state}
      theme={() => sidebarThemeFromHost(props.host.theme)}
      controller={props.controller}
      sessionId={props.sessionId}
    />
  )
}

/** Claims the OpenCode 2 session sidebar; the returned function releases it. */
export async function mountClaudeSidebar(
  host: ClaudeSidebarHost,
  read: ReadSidebarState,
): Promise<() => void> {
  const controller = createSidebarController(
    resolveAnthropicAuthPrefs(await readTuiPreferencesFile()),
  )
  let release: () => void
  try {
    release = host.ui.slot({
      append: 'sidebar.content',
      render: (input) => (
        <HostSidebar
          host={host}
          read={read}
          controller={controller}
          sessionId={input.sessionID}
        />
      ),
    })
  } catch (error) {
    controller.dispose()
    throw error
  }
  return () => {
    release()
    controller.dispose()
  }
}
