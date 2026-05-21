/** @jsxImportSource @opentui/solid */

import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  TuiPlugin,
  TuiPluginApi,
  TuiPluginModule,
} from '@opencode-ai/plugin/tui'
import { createSignal, For, onCleanup, Show } from 'solid-js'
import type { AccountQuota, SidebarState } from './sidebar-state.js'

const STATE_FILE = join(
  tmpdir(),
  'opencode-anthropic-auth',
  'sidebar-state.json',
)
const POLL_MS = 2000

const DEFAULT_STATE: SidebarState = {
  main: { quota: null },
  fallbacks: [],
  activeId: undefined,
  route: 'main',
  relay: null,
  fastMode: false,
  lastUpdated: 0,
}

async function readStateFromFile(): Promise<SidebarState> {
  try {
    const raw = await readFile(STATE_FILE, 'utf8')
    return JSON.parse(raw) as SidebarState
  } catch {
    return DEFAULT_STATE
  }
}

const ID = 'cortexkit.anthropic-auth'
const BAR_WIDTH = 12
const BAR_FILLED = '\u2588'
const BAR_EMPTY = '\u2591'

function quotaBar(usedPct: number, width = BAR_WIDTH): string {
  const filled = Math.max(0, Math.min(Math.round((usedPct / 100) * width), width))
  return BAR_FILLED.repeat(filled) + BAR_EMPTY.repeat(width - filled)
}

function barColor(usedPct: number, api: TuiPluginApi): string {
  if (usedPct < 50)
    return api.theme.current.success ?? api.theme.current.accent ?? 'green'
  if (usedPct < 80) return api.theme.current.warning ?? 'yellow'
  return api.theme.current.error ?? 'red'
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

function QuotaBar(props: {
  label: string
  usedPct: number
  api: TuiPluginApi
}) {
  const color = () => barColor(props.usedPct, props.api)
  const muted = () => props.api.theme.current.textMuted
  return (
    <box flexDirection='row'>
      <text fg={muted()}>{`   ${props.label} `}</text>
      <text fg={color()}>{quotaBar(props.usedPct)}</text>
      <text
        fg={muted()}
      >{` ${String(Math.round(props.usedPct)).padStart(3)}%`}</text>
    </box>
  )
}

function AccountSection(props: {
  name: string
  quota: AccountQuota | null
  active: boolean
  api: TuiPluginApi
}) {
  const dotColor = () =>
    props.active
      ? (props.api.theme.current.success ??
        props.api.theme.current.accent ??
        'green')
      : (props.api.theme.current.textMuted ?? 'gray')
  const muted = () => props.api.theme.current.textMuted
  const resetStr = () => formatResetIn(props.quota?.five_hour?.resetsAt)
  return (
    <box flexDirection='column'>
      <box flexDirection='row'>
        <text fg={dotColor()} bold>
          {'* '}
        </text>
        <text bold>{props.name}</text>
        <Show when={resetStr()}>
          <text fg={muted()}>{` ${resetStr()}`}</text>
        </Show>
      </box>
      <Show
        when={props.quota}
        fallback={<text fg={muted()}>{'    checking...'}</text>}
      >
        <QuotaBar
          label='5h'
          usedPct={props.quota?.five_hour?.usedPercent ?? 0}
          api={props.api}
        />
        <QuotaBar
          label='7d'
          usedPct={props.quota?.seven_day?.usedPercent ?? 0}
          api={props.api}
        />
      </Show>
    </box>
  )
}

function QuotaSidebar(props: { api: TuiPluginApi }) {
  const [state, setState] = createSignal<SidebarState>(DEFAULT_STATE)
  let lastUpdated = 0

  async function refresh() {
    const next = await readStateFromFile()
    if (next.lastUpdated !== lastUpdated) {
      lastUpdated = next.lastUpdated
      setState(next)

    }
  }

  // Poll globalThis since server and TUI load separate module instances
  const timer = setInterval(refresh, POLL_MS)
  onCleanup(() => clearInterval(timer))

  // Also refresh on OpenCode events for faster updates
  const unsubs = [
    props.api.event.on('session.updated', refresh),
    props.api.event.on('message.updated', refresh),
  ]
  onCleanup(() => {
    for (const u of unsubs) u()
  })

  // Initial refresh after short delay (server plugin may not have written yet)
  setTimeout(refresh, 500)
  setTimeout(refresh, 2000)



  const hasData = () =>
    state().main.quota != null || state().fallbacks.length > 0
  const muted = () => props.api.theme.current.textMuted ?? '#71717a'

  return (
    <box flexDirection='column'>
      <text fg={muted()}>
        {'\u2500 Claude Quota \u2500\u2500\u2500\u2500\u2500'}
      </text>
      <Show
        when={hasData()}
        fallback={<text fg={muted()}>{'  Waiting...'}</text>}
      >
        <text> </text>
        <AccountSection
          name='main'
          quota={state().main.quota}
          active={state().activeId === 'main'}
          api={props.api}
        />
        <For each={state().fallbacks.filter((f) => f.enabled)}>
          {(fb) => (
            <box flexDirection='column'>
              <text> </text>
              <AccountSection
                name={fb.label ?? fb.id}
                quota={fb.quota}
                active={state().activeId === fb.id}
                api={props.api}
              />
            </box>
          )}
        </For>
      </Show>
      <text> </text>
      <text fg={muted()}>
        {
          '\u2500\u2500 Status \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500'
        }
      </text>
      <box flexDirection='row'>
        <text fg={muted()}>{'  Route: '}</text>
        <text fg={props.api.theme.current.accent ?? '#3b82f6'}>
          {state().route}
        </text>
      </box>
      <box flexDirection='row'>
        <text fg={muted()}>{'  Mode:  '}</text>
        <text>{state().fastMode ? 'fast \u26a1' : 'std'}</text>
      </box>
      <box flexDirection='row'>
        <text fg={muted()}>{'  Relay: '}</text>
        <Show
          when={state().relay}
          fallback={<text fg={muted()}>{'\u2014'}</text>}
        >
          <text>{`${state().relay?.transport} `}</text>
          <text
            fg={
              state().relay?.enabled
                ? (props.api.theme.current.success ??
                  props.api.theme.current.accent)
                : props.api.theme.current.error
            }
          >
            {'*'}
          </text>
        </Show>
      </box>
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 150,
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
