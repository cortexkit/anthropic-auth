/** @jsxImportSource @opentui/solid */

import type {
  CommandApplyRequest,
  CommandApplyResult,
  CommandDialogPayload,
  CommandMenuModel,
  KnobValue,
  MenuAction,
  MenuItem,
  MenuSection,
} from '@cortexkit/anthropic-auth-core'
import {
  custodyStatusLabel,
  type PrimeAccountStatus,
} from '@cortexkit/anthropic-auth-core'
import type { TuiPluginApi } from '@opencode-ai/plugin/tui'
import type { AccountDialogAccount } from '../rpc/protocol'
import type { OpenDialogPayload } from '../rpc/protocol.js'
import { formatPrimeCost, formatPrimeTime } from '../sidebar-state.js'

/** Render menu sections, accounts and action inputs; send changes to the host instead of writing credentials here. */
export function openNativeMenuDialog(
  api: {
    readonly ui: Pick<
      TuiPluginApi['ui'],
      'dialog' | 'DialogSelect' | 'DialogPrompt' | 'DialogConfirm' | 'toast'
    >
  },
  payload: CommandDialogPayload,
  apply: (request: CommandApplyRequest) => Promise<CommandApplyResult>,
  isCurrentSession: () => boolean,
): void {
  let menu: CommandMenuModel = payload.menu
  let inFlight = false
  const DialogSelect = api.ui.DialogSelect<string>
  const DialogPrompt = api.ui.DialogPrompt
  const DialogConfirm = api.ui.DialogConfirm
  const active = () => isCurrentSession() && !inFlight

  const root = () => {
    if (!active()) return
    api.ui.dialog.setSize('xlarge')
    api.ui.dialog.replace(() => (
      <DialogSelect
        title={menu.title}
        options={[
          ...menu.sections.map((section) => ({
            title: section.title,
            value: section.id,
          })),
          { title: 'Close', value: '__close' },
        ]}
        onSelect={(option) => {
          if (!active()) return
          const section = menu.sections.find(
            (entry) => entry.id === option.value,
          )
          if (section) showSection(section)
          else if (option.value === '__close') api.ui.dialog.clear()
        }}
      />
    ))
  }

  const showSection = (section: MenuSection) => {
    if (!active()) return
    api.ui.dialog.replace(() => (
      <box flexDirection='column' padding={1}>
        <text>{section.lines.join('\n')}</text>
        <DialogSelect
          title={section.title}
          options={[
            ...section.items.map((item) => ({
              title: item.label,
              value: `item:${item.id}`,
              description: item.detail,
            })),
            ...section.actions.map((action) => ({
              title: action.label,
              value: `action:${action.id}`,
              description: action.description,
            })),
            { title: 'Back', value: '__back' },
          ]}
          onSelect={(option) => {
            if (!active()) return
            if (option.value === '__back') return root()
            const action = section.actions.find(
              (entry) => `action:${entry.id}` === option.value,
            )
            if (action) return collect(section, action)
            const item = section.items.find(
              (entry) => `item:${entry.id}` === option.value,
            )
            if (item) showItem(section, item)
          }}
        />
      </box>
    ))
  }

  const showItem = (section: MenuSection, item: MenuItem) => {
    if (!active()) return
    api.ui.dialog.replace(() => (
      <box flexDirection='column' padding={1}>
        <text>{item.detail ?? ''}</text>
        <DialogSelect
          title={item.label}
          options={[
            ...item.actions.map((action) => ({
              title: action.label,
              value: action.id,
              description: action.description,
            })),
            { title: 'Back', value: '__back' },
          ]}
          onSelect={(option) => {
            if (!active()) return
            const action = item.actions.find(
              (entry) => entry.id === option.value,
            )
            if (action) collect(section, action, item)
            else if (option.value === '__back') showSection(section)
          }}
        />
      </box>
    ))
  }

  const collect = (
    section: MenuSection,
    action: MenuAction,
    item?: MenuItem,
  ) => {
    const values: Record<string, KnobValue> = {}
    const back = () => {
      for (const key of Object.keys(values)) delete values[key]
      if (item) showItem(section, item)
      else showSection(section)
    }
    const submit = async () => {
      if (!active()) return
      inFlight = true
      try {
        const result = await apply({
          command: menu.command,
          sectionId: section.id,
          actionId: action.id,
          ...(item ? { itemId: item.id } : {}),
          values: { ...values },
          ...(action.confirm ? { confirmed: true } : {}),
        })
        if (!isCurrentSession()) return
        menu = result.menu
        api.ui.toast({ message: result.text })
      } catch {
        if (isCurrentSession())
          api.ui.toast({ message: 'Menu apply unavailable; outcome unknown.' })
      } finally {
        for (const key of Object.keys(values)) delete values[key]
        inFlight = false
        if (isCurrentSession()) {
          const refreshed = menu.sections.find(
            (entry) => entry.id === section.id,
          )
          if (refreshed) showSection(refreshed)
          else root()
        }
      }
    }
    const next = (index: number) => {
      if (!active()) return
      const knob = action.knobs[index]
      if (!knob) {
        if (!action.confirm) return void submit()
        api.ui.dialog.replace(() => (
          <DialogConfirm
            title={action.label}
            message={action.confirm?.message ?? ''}
            onConfirm={() => void submit()}
            onCancel={back}
          />
        ))
        return
      }
      if (knob.kind === 'choice' || knob.kind === 'toggle') {
        const choices =
          knob.kind === 'choice'
            ? knob.choices
            : [
                { value: 'on', label: 'On' },
                { value: 'off', label: 'Off' },
              ]
        api.ui.dialog.replace(() => (
          <DialogSelect
            title={knob.label}
            options={[
              ...choices.map((choice) => ({
                title: choice.label,
                value: choice.value,
              })),
              { title: 'Cancel', value: '__cancel' },
            ]}
            onSelect={(option) => {
              if (!active()) return
              if (option.value === '__cancel') return back()
              values[knob.id] =
                knob.kind === 'toggle' ? option.value === 'on' : option.value
              next(index + 1)
            }}
          />
        ))
        return
      }
      // DialogPrompt has no masking capability in the host API. Never seed a
      // protected input or claim it is hidden; warn before collecting it.
      api.ui.dialog.replace(() => (
        <DialogPrompt
          title={knob.label}
          description={() => (
            <text>
              {knob.kind === 'text' && knob.masked
                ? 'This host prompt displays input. Avoid screen sharing; the value is not echoed in menu results.'
                : knob.required
                  ? 'Required input'
                  : 'Optional; leave empty for the default'}
            </text>
          )}
          value={
            knob.kind === 'text' && knob.masked
              ? ''
              : knob.value === undefined
                ? ''
                : String(knob.value)
          }
          placeholder={
            knob.kind === 'text'
              ? knob.placeholder
              : `${knob.min ?? ''}-${knob.max ?? ''}`
          }
          onCancel={back}
          onConfirm={(typed) => {
            if (!active()) return
            const text = typed.trim()
            if (!text && knob.required) {
              api.ui.toast({ message: `${knob.label} is required.` })
              return
            }
            const value =
              text === '' ? null : knob.kind === 'number' ? Number(text) : text
            if (
              knob.kind === 'number' &&
              typeof value === 'number' &&
              (!Number.isFinite(value) ||
                (knob.min !== undefined && value < knob.min) ||
                (knob.max !== undefined && value > knob.max))
            ) {
              api.ui.toast({
                message: `${knob.label} needs a number in range.`,
              })
              return
            }
            values[knob.id] = value
            next(index + 1)
          }}
        />
      ))
    }
    next(0)
  }
  root()
}

type ApplyFn = (
  command: OpenDialogPayload['command'],
  args: string,
) => Promise<{ text: string; knobs: Record<string, unknown> }>

type KillswitchDialogConfig = {
  enabled?: boolean
  main?: Record<string, number>
  accounts?: Record<string, Record<string, number>>
}

type TuiAccountDialogAccount = Omit<
  AccountDialogAccount,
  'vaultReauth' | 'custodyState'
> &
  Partial<Pick<AccountDialogAccount, 'vaultReauth' | 'custodyState'>>

type TuiAccountDialogPayload = {
  accounts: TuiAccountDialogAccount[]
  claustrumDetection: string
  custodyMode?: TuiCustodyMode
  enrollmentStatus?: string
}

type TuiCustodyMode = 'local' | 'claustrum' | `mismatch: ${string}`

type AccountDialogOption = {
  title: string
  value: string
  description?: string
}

export const PRIME_DIALOG_OPTIONS = [
  { title: 'Enable', value: 'on' },
  { title: 'Disable', value: 'off' },
  { title: 'Status', value: 'status' },
  { title: 'Back', value: 'back' },
]

export function handlePrimeStatusOption(
  option: { value: string },
  renderMain: () => void,
): void {
  if (option.value === 'back') renderMain()
}

export function buildKillswitchThresholdSeed(
  config: KillswitchDialogConfig,
  accountIds: string[],
) {
  const readT = (t: Record<string, number> | undefined) => {
    const fh = t?.five_hour ?? t?.['5h'] ?? 5
    const sd = t?.seven_day ?? t?.['1w'] ?? 10
    const scoped = t?.scoped ?? 0
    return { fh, sd, scoped }
  }
  const mainT = readT(config.main)
  const seedParts = [`main:${mainT.fh},${mainT.sd},${mainT.scoped}`]
  for (const id of accountIds) {
    const t = readT(config.accounts?.[id] ?? config.main)
    seedParts.push(`${id}:${t.fh},${t.sd},${t.scoped}`)
  }
  return seedParts.join(' ')
}

function normalizeTuiCustodyMode(value: string): TuiCustodyMode {
  return value === 'local' || value === 'claustrum'
    ? value
    : `mismatch: ${value}`
}

export function normalizeAccountDialogPayload(
  value: unknown,
): TuiAccountDialogPayload {
  const payload =
    value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  const rawAccounts = Array.isArray(payload.accounts) ? payload.accounts : []
  const accounts = rawAccounts.flatMap((value) => {
    if (!value || typeof value !== 'object') return []
    const account = value as Record<string, unknown>
    const quotaPercent = account.quotaPercent
    if (
      typeof account.id !== 'string' ||
      typeof account.label !== 'string' ||
      (account.role !== 'main' && account.role !== 'fallback') ||
      typeof account.enabled !== 'boolean' ||
      (quotaPercent !== null &&
        (typeof quotaPercent !== 'number' || !Number.isFinite(quotaPercent))) ||
      (account.claustrumGate !== 'on' &&
        account.claustrumGate !== 'off' &&
        account.claustrumGate !== 'na') ||
      typeof account.vaultServed !== 'boolean'
    ) {
      return []
    }
    const normalized = {
      id: account.id,
      label: account.label,
      role: account.role,
      enabled: account.enabled,
      quotaPercent,
      ...(typeof account.tierLabel === 'string' && {
        tierLabel: account.tierLabel,
      }),
      claustrumGate: account.claustrumGate,
      vaultServed: account.vaultServed,
    } satisfies TuiAccountDialogAccount
    const custodyState = account.custodyState
    if (
      (custodyState === 'na' ||
        custodyState === 'off' ||
        custodyState === 'on-vault-served' ||
        custodyState === 'on-vault-reauth' ||
        custodyState === 'on-cold') &&
      typeof account.vaultReauth === 'boolean'
    ) {
      return [
        {
          ...normalized,
          custodyState,
          vaultReauth: account.vaultReauth,
        },
      ]
    }
    return [normalized]
  })
  const custodyMode: TuiCustodyMode | undefined =
    payload.custodyModeKnown === true && typeof payload.custodyMode === 'string'
      ? normalizeTuiCustodyMode(payload.custodyMode)
      : undefined
  return {
    accounts,
    claustrumDetection:
      typeof payload.claustrumDetection === 'string'
        ? payload.claustrumDetection
        : 'unknown',
    ...(custodyMode && { custodyMode }),
    ...(typeof payload.enrollmentStatus === 'string' &&
      payload.enrollmentStatus.length <= 2_000 && {
        enrollmentStatus: payload.enrollmentStatus,
      }),
  }
}

export function buildAccountDialogOption(account: TuiAccountDialogAccount) {
  const pct =
    account.quotaPercent != null
      ? ` ${Math.round(account.quotaPercent)}%`
      : ' \u2013%'
  const status = !account.enabled ? ' (disabled)' : ''
  const custody = account.custodyState
    ? account.custodyState === 'na'
      ? undefined
      : custodyStatusLabel(account.custodyState).replace(
          ' (OpenCode managed)',
          '',
        )
    : undefined
  return {
    title: `${account.label} [${account.role}]${status}${pct}${custody ? ` · custody ${custody}` : ''}`,
    value: account.id,
    ...(account.tierLabel && { description: account.tierLabel }),
  }
}

export function buildManageAccountOptions(account: TuiAccountDialogAccount) {
  const options: AccountDialogOption[] = []
  const toggleLabel = account.enabled ? 'Disable' : 'Enable'
  options.push({
    title: toggleLabel,
    value: account.enabled ? 'disable' : 'enable',
    description: account.enabled
      ? 'Stop using this fallback account'
      : 'Allow this fallback account to be used',
  })
  options.push({
    title: 'Move up',
    value: 'move-up',
    description: 'Higher priority in fallback order',
  })
  options.push({
    title: 'Move down',
    value: 'move-down',
    description: 'Lower priority in fallback order',
  })
  options.push({
    title: 'Remove\u2026',
    value: 'remove',
    description: 'Delete this account permanently',
  })
  options.push({ title: 'Back', value: 'back' })
  return options
}

export function buildAccountDialogL1(value: unknown): {
  header: string
  options: AccountDialogOption[]
  enrollmentStatus?: string
  modeAction?: { command: 'claude-account'; arguments: 'local' | 'claustrum' }
} {
  const payload = normalizeAccountDialogPayload(value)
  const modeAction =
    payload.custodyMode === 'local' || payload.custodyMode === 'claustrum'
      ? {
          command: 'claude-account' as const,
          arguments:
            payload.custodyMode === 'local'
              ? ('claustrum' as const)
              : ('local' as const),
        }
      : undefined
  return {
    header: payload.custodyMode
      ? `Custody mode: ${payload.custodyMode}`
      : 'Custody mode: unavailable from older server',
    options: [
      ...(modeAction
        ? [
            {
              title:
                payload.custodyMode === 'local'
                  ? 'Use Claustrum custody'
                  : 'Use local custody',
              value: '__custody-mode__',
            },
          ]
        : []),
      {
        title: 'Add account…',
        value: '__add__',
        description: 'Add an API key or OAuth fallback account',
      },
      ...payload.accounts.map(buildAccountDialogOption),
    ],
    ...(payload.enrollmentStatus && {
      enrollmentStatus: payload.enrollmentStatus,
    }),
    ...(modeAction && { modeAction }),
  }
}

export function retainAccountDialogProjection(
  current: Record<string, unknown>,
  incoming: Record<string, unknown>,
): Record<string, unknown> {
  return Array.isArray(incoming.accounts) ? incoming : current
}

function showText(api: TuiPluginApi, text: string) {
  api.ui.dialog.setSize('xlarge')
  api.ui.dialog.replace(() => (
    <box flexDirection='column' padding={1} width='100%'>
      <text>{text}</text>
    </box>
  ))
}

/**
 * Format the per-account status lines shown in the Claude prime Status
 * view. Pure: consumed by the dialog's Status pane; the sidebar uses a
 * different formatter (`formatPrimeSidebarValue`) for its one-line
 * expanded row.
 */
export function buildPrimeStatusRows(accounts: PrimeAccountStatus[]): string[] {
  const rows: string[] = []
  for (const account of accounts) {
    if (account.usage?.count) {
      const cost = account.estimatedCostUsd ?? 0
      rows.push(
        `${account.label}: ${account.usage.count} ${account.usage.count === 1 ? 'prime' : 'primes'} \u2248 $${formatPrimeCost(cost)}`,
      )
    }
    if (account.nextDueAt && account.nextDueAt > Date.now()) {
      rows.push(
        `${account.label} \u00b7 next prime ${formatPrimeTime(account.nextDueAt)}`,
      )
    } else if (account.lastPrimedAt) {
      const time = formatPrimeTime(account.lastPrimedAt)
      if (account.lastResult === 'error') {
        rows.push(`${account.label} \u00b7 primed ${time} err`)
      } else if (account.lastResult === 'skipped') {
        rows.push(`${account.label} \u00b7 primed ${time} skipped`)
      } else {
        rows.push(`${account.label} \u00b7 primed ${time} \u2713`)
      }
    } else if (account.usage?.count) {
      // already shown above
    } else {
      rows.push(`${account.label} \u2014 window active`)
    }
  }
  return rows
}

export function openCommandDialog(
  api: TuiPluginApi,
  payload: OpenDialogPayload,
  apply: ApplyFn,
) {
  if (payload.command === 'claude-routing') {
    const current = (payload.knobs.mode as string) ?? 'main-first'
    const DialogSelect = api.ui.DialogSelect<string>
    api.ui.dialog.setSize('xlarge')
    api.ui.dialog.replace(() => (
      <DialogSelect
        title='Claude routing'
        current={current}
        options={[
          {
            title: 'Main first',
            value: 'main-first',
            description: 'Use the main account until exhausted',
          },
          {
            title: 'Fallback first',
            value: 'fallback-first',
            description: 'Prefer fallback accounts, preserve main',
          },
          {
            title: 'Sticky balanced',
            value: 'sticky-balanced',
            description:
              'Balance new sessions by quota and keep each account sticky',
          },
          {
            title: 'Reset this session',
            value: 'reset',
            description: 'Reassign this session on its next request',
          },
        ]}
        onSelect={(option) => {
          void apply('claude-routing', String(option.value)).then((r) => {
            api.ui.toast({ message: r.text })
            api.ui.dialog.clear()
          })
        }}
      />
    ))
    return
  }

  if (payload.command === 'claude-fast' || payload.command === 'claude-dump') {
    const enabled = payload.knobs.enabled === true
    const label =
      payload.command === 'claude-fast' ? 'fast mode' : 'request dump'
    const DialogConfirm = api.ui.DialogConfirm
    api.ui.dialog.setSize('xlarge')
    api.ui.dialog.replace(() => (
      <DialogConfirm
        title={`Claude ${label}`}
        message={`${payload.text}\n\n${enabled ? 'Disable' : 'Enable'} ${label}?`}
        onConfirm={() => {
          void apply(payload.command, enabled ? 'off' : 'on').then((r) => {
            api.ui.toast({ message: r.text })
            api.ui.dialog.clear()
          })
        }}
        onCancel={() => api.ui.dialog.clear()}
      />
    ))
    return
  }

  if (payload.command === 'claude-cache') {
    const enabled = payload.knobs.enabled === true
    const mode = (payload.knobs.mode as string) ?? 'hybrid'
    const currentValue = enabled ? mode : 'off'
    const DialogSelect = api.ui.DialogSelect<string>
    api.ui.dialog.setSize('xlarge')
    api.ui.dialog.replace(() => (
      <DialogSelect
        title='Claude 1h cache'
        current={currentValue}
        options={[
          { title: 'Off', value: 'off', description: 'Disable 1h cache' },
          {
            title: 'Explicit',
            value: 'explicit',
            description: 'Existing OpenCode breakpoints',
          },
          {
            title: 'Automatic',
            value: 'automatic',
            description: 'Top-level cache_control only',
          },
          {
            title: 'Hybrid',
            value: 'hybrid',
            description: 'system + messages[0] + top-level',
          },
        ]}
        onSelect={(option) => {
          if (option.value === 'off') {
            void apply('claude-cache', 'off').then((r) => {
              api.ui.toast({ message: r.text })
              api.ui.dialog.clear()
            })
            return
          }
          void apply('claude-cache', `mode ${option.value}`)
            .then(() => apply('claude-cache', 'on'))
            .then((r) => {
              api.ui.toast({ message: r.text })
              api.ui.dialog.clear()
            })
        }}
      />
    ))
    return
  }

  if (payload.command === 'claude-cachekeep') {
    const window = payload.knobs.window as
      | { startHour: number; endHour: number }
      | undefined
    const seed = window
      ? `${String(window.startHour).padStart(2, '0')}-${String(window.endHour).padStart(2, '0')}`
      : ''
    const DialogPrompt = api.ui.DialogPrompt
    api.ui.dialog.setSize('xlarge')
    api.ui.dialog.replace(() => (
      <DialogPrompt
        title='Claude cachekeep schedule'
        description={() => <text>{payload.text}</text>}
        placeholder="'always', HH-HH (e.g. 08-20), or 'off'"
        value={seed}
        onConfirm={(value: string) => {
          void apply('claude-cachekeep', value.trim()).then((r) => {
            api.ui.toast({ message: r.text })
            api.ui.dialog.clear()
          })
        }}
        onCancel={() => api.ui.dialog.clear()}
      />
    ))
    return
  }

  if (payload.command === 'claude-prime') {
    // Prime modal spec: always four options — Enable / Disable / Status /
    // Back — regardless of current state (the contextual toggle
    // approach is forbidden). Status uses a DialogSelect replace with
    // a single Back action (killswitch dialog-replace pattern), so the
    // user has a working affordance to return to the main menu.
    const DialogSelect = api.ui.DialogSelect<string>
    const openStatusView = () => {
      const accounts =
        (payload.knobs.accounts as PrimeAccountStatus[] | undefined) ?? []
      const lines = buildPrimeStatusRows(accounts)
      const statusText = `Claude prime status:\n\n${lines.join('\n')}`
      api.ui.dialog.setSize('xlarge')
      api.ui.dialog.replace(() => (
        <box flexDirection='column' padding={1} width='100%'>
          <text>{statusText}</text>
          <box marginTop={1}>
            <DialogSelect
              title='Claude prime — status'
              current='back'
              options={[{ title: 'Back', value: 'back' }]}
              onSelect={(option) => handlePrimeStatusOption(option, renderMain)}
            />
          </box>
        </box>
      ))
    }
    const renderMain = () => {
      const enabled = payload.knobs.enabled === true
      api.ui.dialog.setSize('xlarge')
      api.ui.dialog.replace(() => (
        <DialogSelect
          title='Claude prime'
          current={enabled ? 'on' : 'off'}
          options={PRIME_DIALOG_OPTIONS}
          onSelect={(option) => {
            if (option.value === 'back') {
              api.ui.dialog.clear()
              return
            }
            if (option.value === 'status') {
              openStatusView()
              return
            }
            void apply('claude-prime', String(option.value)).then((r) => {
              api.ui.toast({ message: r.text })
              payload = {
                command: 'claude-prime',
                text: r.text,
                knobs: r.knobs,
              }
              renderMain()
            })
          }}
        />
      ))
    }
    renderMain()
    return
  }

  if (payload.command === 'claude-killswitch') {
    const config = (payload.knobs.config ?? {}) as KillswitchDialogConfig
    const accountIds = (payload.knobs.accountIds as string[]) ?? []
    const enabled = config.enabled === true
    const seed = buildKillswitchThresholdSeed(config, accountIds)

    const openEdit = () => {
      const DialogPrompt = api.ui.DialogPrompt
      api.ui.dialog.setSize('xlarge')
      api.ui.dialog.replace(() => (
        <DialogPrompt
          title='Killswitch thresholds'
          description={() => <text>{payload.text}</text>}
          placeholder='main:5,10,0 work-alt:5,10,0'
          value={seed}
          onConfirm={(value: string) => {
            void apply('claude-killswitch', `set ${value.trim()}`).then((r) => {
              api.ui.toast({ message: r.text })
              api.ui.dialog.clear()
            })
          }}
          onCancel={() => api.ui.dialog.clear()}
        />
      ))
    }

    const DialogSelect = api.ui.DialogSelect<string>
    api.ui.dialog.setSize('xlarge')
    api.ui.dialog.replace(() => (
      <DialogSelect
        title='Claude killswitch'
        options={[
          {
            title: enabled ? 'Disable killswitch' : 'Enable killswitch',
            value: enabled ? 'off' : 'on',
            description: enabled
              ? 'Stop hard-blocking on low quota'
              : 'Hard-block requests when quota drops below thresholds',
          },
          {
            title: 'Edit thresholds…',
            value: 'edit',
            description: 'Set per-account 5h,1w,scoped cutoffs',
          },
        ]}
        onSelect={(option) => {
          if (option.value === 'edit') {
            openEdit()
            return
          }
          void apply('claude-killswitch', String(option.value)).then((r) => {
            api.ui.toast({ message: r.text })
            api.ui.dialog.clear()
          })
        }}
      />
    ))
    return
  }

  if (payload.command === 'claude-account') {
    let accountKnobs: Record<string, unknown> = payload.knobs
    const accounts = normalizeAccountDialogPayload(accountKnobs).accounts
    let statusMessage: { text: string; error?: boolean } | undefined

    const updateAccounts = (r: {
      text: string
      knobs: Record<string, unknown>
    }) => {
      accountKnobs = retainAccountDialogProjection(accountKnobs, r.knobs)
      const updated = normalizeAccountDialogPayload(accountKnobs).accounts
      if (updated.length > 0) {
        accounts.length = 0
        accounts.push(...updated)
      }
    }

    const buildL1 = () => {
      const DialogSelect = api.ui.DialogSelect<string>
      const l1 = buildAccountDialogL1({ ...accountKnobs, accounts })
      api.ui.dialog.setSize('xlarge')
      api.ui.dialog.replace(() => (
        <box flexDirection='column' padding={1} width='100%'>
          <text>{`Claustrum: ${normalizeAccountDialogPayload(accountKnobs).claustrumDetection}`}</text>
          <text>{l1.header}</text>
          {l1.enrollmentStatus && (
            <box marginTop={1}>
              <text>{l1.enrollmentStatus}</text>
            </box>
          )}
          {statusMessage && (
            <box marginTop={1}>
              <text fg={statusMessage.error ? '#ef4444' : '#22c55e'}>
                {statusMessage.text}
              </text>
            </box>
          )}
          <box marginTop={1}>
            <DialogSelect
              title='Claude accounts'
              options={l1.options}
              onSelect={(option) => {
                if (option.value === '__add__') {
                  statusMessage = undefined
                  openAddType()
                  return
                }
                if (option.value === '__custody-mode__' && l1.modeAction) {
                  void apply(l1.modeAction.command, l1.modeAction.arguments)
                    .then((r) => {
                      const isRefusalOrError =
                        r.text.includes('refused') ||
                        r.text.includes('unavailable') ||
                        r.text.includes('failed') ||
                        r.text.includes('Error') ||
                        r.text.includes('error')
                      if (isRefusalOrError) {
                        statusMessage = { text: r.text, error: true }
                      } else {
                        statusMessage = { text: r.text, error: false }
                        api.ui.toast({ message: r.text })
                      }
                      updateAccounts(r)
                      buildL1()
                    })
                    .catch((err) => {
                      const msg =
                        err instanceof Error ? err.message : String(err)
                      statusMessage = { text: `Error: ${msg}`, error: true }
                      buildL1()
                    })
                  return
                }
                statusMessage = undefined
                const account = accounts.find((a) => a.id === option.value)
                if (!account) return
                if (account.role === 'main') {
                  const pct =
                    account.quotaPercent != null
                      ? ` ${Math.round(account.quotaPercent)}%`
                      : ' \u2013%'
                  showText(
                    api,
                    `${account.label}\nRole: main (read-only)\nQuota:${pct}`,
                  )
                  return
                }
                openManage(account, false)
              }}
            />
          </box>
        </box>
      ))
    }

    // -- Add type selection (OAuth vs API key) ------------------------------
    const openAddType = () => {
      const DialogSelect = api.ui.DialogSelect<string>
      api.ui.dialog.setSize('xlarge')
      api.ui.dialog.replace(() => (
        <DialogSelect
          title='Add account'
          options={[
            {
              title: 'OAuth (login)',
              value: 'oauth',
              description:
                'Sign in to Claude via browser — works with Pro, Max, and Team plans',
            },
            {
              title: 'API key',
              value: 'apikey',
              description:
                'Provide an API key for an Anthropic-compatible endpoint',
            },
            { title: 'Back', value: 'back' },
          ]}
          onSelect={(option) => {
            if (option.value === 'back') {
              buildL1()
              return
            }
            if (option.value === 'apikey') {
              openAddApiKey()
              return
            }
            openAddOAuthStart()
          }}
        />
      ))
    }

    // -- Add API key (multi-step: key → baseURL → authHeader → label) ------
    const openAddApiKey = () => {
      const collected: {
        apiKey?: string
        baseURL?: string
        authHeader?: string
        label?: string
      } = {}

      const openApiKeyPrompt = () => {
        const DialogPrompt = api.ui.DialogPrompt
        api.ui.dialog.setSize('xlarge')
        api.ui.dialog.replace(() => (
          <DialogPrompt
            title='Add API key account \u2014 API key'
            description={() => <text>Paste your API key (required).</text>}
            placeholder='sk-ant-...'
            value=''
            onConfirm={(value: string) => {
              const trimmed = value.trim()
              if (!trimmed) {
                openAddType()
                return
              }
              collected.apiKey = trimmed
              openBaseURLPrompt()
            }}
            onCancel={() => openAddType()}
          />
        ))
      }

      const openBaseURLPrompt = () => {
        const DialogPrompt = api.ui.DialogPrompt
        api.ui.dialog.setSize('xlarge')
        api.ui.dialog.replace(() => (
          <DialogPrompt
            title='Add API key account \u2014 base URL'
            description={() => (
              <text>
                Anthropic-compatible API base URL. Default:
                https://api.kie.ai/claude
              </text>
            )}
            placeholder='https://api.kie.ai/claude'
            value=''
            onConfirm={(value: string) => {
              const trimmed = value.trim()
              collected.baseURL = trimmed || 'https://api.kie.ai/claude'
              openAuthHeaderSelect()
            }}
            onCancel={() => openApiKeyPrompt()}
          />
        ))
      }

      const openAuthHeaderSelect = () => {
        const DialogSelect = api.ui.DialogSelect<string>
        api.ui.dialog.setSize('xlarge')
        api.ui.dialog.replace(() => (
          <DialogSelect
            title='Add API key account \u2014 auth header'
            options={[
              {
                title: 'Authorization: Bearer (default)',
                value: 'authorization-bearer',
                description: 'Standard bearer token authentication',
              },
              {
                title: 'X-API-Key',
                value: 'x-api-key',
                description: 'Custom header-based API key',
              },
            ]}
            onSelect={(option) => {
              collected.authHeader = option.value as
                | 'authorization-bearer'
                | 'x-api-key'
              openLabelPrompt()
            }}
          />
        ))
      }

      const openLabelPrompt = () => {
        const DialogPrompt = api.ui.DialogPrompt
        api.ui.dialog.setSize('xlarge')
        api.ui.dialog.replace(() => (
          <DialogPrompt
            title='Add API key account \u2014 label'
            description={() => (
              <text>A short name for this account (optional).</text>
            )}
            placeholder='e.g. Work API'
            value=''
            onConfirm={(value: string) => {
              const trimmed = value.trim()
              collected.label = trimmed || undefined
              const apiKey = collected.apiKey
              if (!apiKey) return
              let args = `add-apikey ${apiKey}`
              if (
                collected.baseURL &&
                collected.baseURL !== 'https://api.kie.ai/claude'
              ) {
                args += ` --base-url ${collected.baseURL}`
              }
              if (
                collected.authHeader &&
                collected.authHeader !== 'authorization-bearer'
              ) {
                args += ` --auth-header ${collected.authHeader}`
              }
              if (collected.label) {
                args += ` --label ${collected.label}`
              }
              void apply('claude-account', args).then((r) => {
                api.ui.toast({ message: r.text })
                updateAccounts(r)
                buildL1()
              })
            }}
            onCancel={() => openAuthHeaderSelect()}
          />
        ))
      }

      openApiKeyPrompt()
    }

    // -- Add OAuth (OSC-52 copy + code entry) ------------------------------
    const openAddOAuthStart = () => {
      void apply('claude-account', 'add-oauth-start').then((r) => {
        const oauthUrl = r.knobs.oauthUrl as string | undefined
        updateAccounts(r)
        if (oauthUrl) {
          openOAuthUrlScreen(oauthUrl)
        } else {
          api.ui.toast({ message: r.text })
          buildL1()
        }
      })
    }

    const openOAuthUrlScreen = (oauthUrl: string) => {
      const DialogSelect = api.ui.DialogSelect<string>
      api.ui.dialog.setSize('xlarge')
      api.ui.dialog.replace(() => (
        <DialogSelect
          title='OAuth sign-in'
          options={[
            {
              title: 'Copy URL to clipboard',
              value: 'copy',
              description: oauthUrl,
            },
            {
              title: 'Enter sign-in code',
              value: 'code',
              description:
                'Open the URL in your browser, sign in, then paste the callback URL or code',
            },
            { title: 'Cancel', value: 'cancel' },
          ]}
          onSelect={(option) => {
            if (option.value === 'cancel') {
              buildL1()
              return
            }
            if (option.value === 'copy') {
              const ok = api.renderer.copyToClipboardOSC52(oauthUrl)
              if (ok) {
                api.ui.toast({ message: 'URL copied to clipboard' })
              } else {
                api.ui.toast({
                  message:
                    'Copy unavailable \u2014 select the URL text above to copy',
                })
              }
              openOAuthUrlScreen(oauthUrl)
              return
            }
            openOAuthCodePrompt(oauthUrl)
          }}
        />
      ))
    }

    const openOAuthCodePrompt = (oauthUrl: string) => {
      const DialogPrompt = api.ui.DialogPrompt
      api.ui.dialog.setSize('xlarge')
      api.ui.dialog.replace(() => (
        <DialogPrompt
          title='OAuth sign-in \u2014 enter code'
          description={() => (
            <text>
              After signing in you will be redirected. Paste the full callback
              URL or authorization code below.
            </text>
          )}
          placeholder='Paste callback URL or code here'
          value=''
          onConfirm={(value: string) => {
            const trimmed = value.trim()
            if (!trimmed) {
              buildL1()
              return
            }
            openOAuthLabelPrompt(trimmed, oauthUrl)
          }}
          // Step BACK to the sign-in URL screen, not L1: the OAuth session
          // (PKCE verifier/state) is already minted. Returning to L1 would let a
          // retry re-run add-oauth-start and re-mint it, invalidating the URL the
          // user is mid-sign-in with. Same session → same URL is preserved.
          onCancel={() => openOAuthUrlScreen(oauthUrl)}
        />
      ))
    }

    const openOAuthLabelPrompt = (code: string, oauthUrl: string) => {
      const DialogPrompt = api.ui.DialogPrompt
      api.ui.dialog.setSize('xlarge')
      api.ui.dialog.replace(() => (
        <DialogPrompt
          title='OAuth sign-in \u2014 label'
          description={() => (
            <text>A short name for this account (optional).</text>
          )}
          placeholder='e.g. work'
          value=''
          onConfirm={(value: string) => {
            const label = value.trim()
            const args = label
              ? `add-oauth-finish ${code} --label ${label}`
              : `add-oauth-finish ${code}`
            void apply('claude-account', args).then((r) => {
              api.ui.toast({ message: r.text })
              updateAccounts(r)
              buildL1()
            })
          }}
          // Step BACK to the code prompt, not L1: the user already obtained an
          // auth code to reach this step. Returning to L1 would let a retry
          // re-run add-oauth-start, minting a new PKCE verifier/state that
          // invalidates the code they already have and forces a full re-auth.
          onCancel={() => openOAuthCodePrompt(oauthUrl)}
        />
      ))
    }

    // -- Manage existing account -------------------------------------------
    const openManage = (
      account: (typeof accounts)[number],
      isMain: boolean,
    ) => {
      const DialogSelect = api.ui.DialogSelect<string>
      const DialogConfirm = api.ui.DialogConfirm
      api.ui.dialog.setSize('xlarge')

      const options = isMain
        ? [{ title: 'Back', value: 'back' }]
        : buildManageAccountOptions(account)

      api.ui.dialog.replace(() => (
        <DialogSelect
          title={`Manage ${account.label}`}
          options={options}
          onSelect={(option) => {
            if (option.value === 'back') {
              buildL1()
              return
            }

            if (option.value === 'remove') {
              api.ui.dialog.replace(() => (
                <DialogConfirm
                  title={`Remove ${account.label}?`}
                  message={`Are you sure you want to remove the fallback account "${account.label}"?`}
                  onConfirm={() => {
                    void apply('claude-account', `remove ${account.id}`)
                      .then((r) => {
                        api.ui.toast({ message: r.text })
                        updateAccounts(r)
                        buildL1()
                      })
                      .catch((err) => {
                        const msg =
                          err instanceof Error ? err.message : String(err)
                        statusMessage = { text: `Error: ${msg}`, error: true }
                        buildL1()
                      })
                  }}
                  onCancel={() => openManage(account, isMain)}
                />
              ))
              return
            }

            const args = `${option.value} ${account.id}`
            void apply('claude-account', args)
              .then((r) => {
                api.ui.toast({ message: r.text })
                updateAccounts(r)
                const updatedList = normalizeAccountDialogPayload(
                  r.knobs,
                ).accounts
                const refreshed =
                  (updatedList && updatedList.length > 0
                    ? updatedList.find((a) => a.id === account.id)
                    : undefined) ?? account
                openManage(refreshed, isMain)
              })
              .catch((err) => {
                const msg = err instanceof Error ? err.message : String(err)
                statusMessage = { text: `Error: ${msg}`, error: true }
                buildL1()
              })
          }}
        />
      ))
    }

    buildL1()
    return
  }

  if (payload.command === 'claude-logging') {
    const current = (payload.knobs.level as string) ?? 'info'
    const levels = ['error', 'warn', 'info', 'debug', 'trace']
    const DialogSelect = api.ui.DialogSelect<string>
    api.ui.dialog.setSize('xlarge')
    api.ui.dialog.replace(() => (
      <DialogSelect
        title='Claude log level'
        current={current}
        options={levels.map((level) => ({
          title: level === current ? `\u2022 ${level}` : level,
          value: level,
        }))}
        onSelect={(option) => {
          void apply('claude-logging', String(option.value)).then((r) => {
            api.ui.toast({ message: r.text })
            api.ui.dialog.clear()
          })
        }}
      />
    ))
    return
  }

  // fallback for quota (display-only)
  showText(api, payload.text)
}
