import type { AccountStorage, FallbackAccount } from '../accounts.ts'

export const CLAUDE_ACCOUNT_COMMAND_NAME = 'claude-account'

export type AccountCommandAction =
  | { type: 'status' }
  | { type: 'enable'; id: string }
  | { type: 'disable'; id: string }
  | { type: 'remove'; id: string }
  | { type: 'move-up'; id: string }
  | { type: 'move-down'; id: string }
  | {
      type: 'add-apikey'
      apiKey: string
      label?: string
      baseURL?: string
      authHeader?: 'authorization-bearer' | 'x-api-key'
    }
  | { type: 'add-oauth-start' }
  | { type: 'add-oauth-finish'; code: string; label?: string }
  | { type: 'usage' }

export function parseAccountCommandAction(
  argumentsText: string,
): AccountCommandAction {
  const parts = argumentsText.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return { type: 'status' }

  const action = parts[0]
  const rest = parts.slice(1).join(' ')

  if (action === 'enable' && rest) return { type: 'enable', id: rest }
  if (action === 'disable' && rest) return { type: 'disable', id: rest }
  if (action === 'remove' && rest) return { type: 'remove', id: rest }
  if (action === 'move-up' && rest) return { type: 'move-up', id: rest }
  if (action === 'move-down' && rest) return { type: 'move-down', id: rest }

  if (action === 'add-apikey' && rest) {
    let remaining = rest
    let baseURL: string | undefined
    let authHeader: 'authorization-bearer' | 'x-api-key' | undefined

    // Parse --base-url flag
    const baseUrlMatch = remaining.match(/--base-url\s+(\S+)/)
    if (baseUrlMatch) {
      baseURL = baseUrlMatch[1]
      remaining = remaining.replace(baseUrlMatch[0], '').trim()
    }

    // Parse --auth-header flag
    const authMatch = remaining.match(
      /--auth-header\s+(authorization-bearer|x-api-key)/,
    )
    if (authMatch) {
      authHeader = authMatch[1] as 'authorization-bearer' | 'x-api-key'
      remaining = remaining.replace(authMatch[0], '').trim()
    }

    // Parse --label flag
    let label: string | undefined
    const labelMatch = remaining.match(/--label\s+(.+)/)
    if (labelMatch) {
      label = labelMatch[1]?.trim() || undefined
      remaining = remaining.replace(labelMatch[0], '').trim()
    }

    // First remaining token is the API key; rest (if any) is label
    const firstSpace = remaining.indexOf(' ')
    if (firstSpace === -1) {
      if (!remaining) return { type: 'usage' }
      return {
        type: 'add-apikey',
        apiKey: remaining,
        baseURL,
        authHeader,
        label,
      }
    }
    const apiKey = remaining.slice(0, firstSpace)
    const tail = remaining.slice(firstSpace + 1).trim()
    return {
      type: 'add-apikey',
      apiKey,
      label: label ?? (tail || undefined),
      baseURL,
      authHeader,
    }
  }

  if (action === 'add-oauth-start') return { type: 'add-oauth-start' }

  if (action === 'add-oauth-finish' && rest) {
    let remaining = rest

    // Parse --label flag (mirrors add-apikey). The OAuth code is opaque (may
    // contain a #state segment) so the label is collected via the flag, never
    // positionally.
    let label: string | undefined
    const labelMatch = remaining.match(/--label\s+(.+)/)
    if (labelMatch) {
      label = labelMatch[1]?.trim() || undefined
      remaining = remaining.replace(labelMatch[0], '').trim()
    }

    if (!remaining) return { type: 'usage' }
    return { type: 'add-oauth-finish', code: remaining, label }
  }

  return { type: 'usage' }
}

export interface AccountListItem {
  id: string
  label: string
  role: 'main' | 'fallback'
  enabled: boolean
  quotaPercent: number | null
}

export function buildAccountList(storage: AccountStorage): AccountListItem[] {
  const list: AccountListItem[] = []

  const fiveHour = storage.quota?.mainQuota?.five_hour
  list.push({
    id: 'main',
    label:
      storage.main?.provider === 'anthropic' ? 'OpenCode anthropic' : 'Main',
    role: 'main',
    enabled: true,
    quotaPercent: fiveHour?.usedPercent ?? null,
  })

  for (const account of storage.accounts) {
    const fiveHourQuota = (
      account as { quota?: { five_hour?: { usedPercent: number } } }
    ).quota?.five_hour
    list.push({
      id: account.id,
      label: account.label ?? account.id,
      role: 'fallback',
      enabled: account.enabled !== false,
      quotaPercent: fiveHourQuota?.usedPercent ?? null,
    })
  }

  return list
}

const USAGE_TEXT = [
  'Usage:',
  '  /claude-account                       Show account list',
  '  /claude-account enable <id>           Enable a fallback account',
  '  /claude-account disable <id>          Disable a fallback account',
  '  /claude-account remove <id>           Remove a fallback account',
  '  /claude-account move-up <id>          Move a fallback account up',
  '  /claude-account move-down <id>        Move a fallback account down',
  '  /claude-account add-apikey <key>      Add an API key fallback account',
  '  /claude-account add-oauth-start       Start OAuth device flow',
  '  /claude-account add-oauth-finish <code>  Complete OAuth flow',
].join('\n')

export function executeAccountCommand(input: {
  argumentsText: string
  storage: AccountStorage
}): {
  text: string
  updated?: {
    id: string
    action: 'enable' | 'disable' | 'remove' | 'reorder'
    enabled?: boolean
    previousOrder?: string[]
    newOrder?: string[]
  }
} {
  const action = parseAccountCommandAction(input.argumentsText)
  const accounts = input.storage.accounts
  const mainId = 'main'

  if (action.type === 'status') {
    const list = buildAccountList(input.storage)
    const lines = ['## Claude Accounts', '']
    for (const a of list) {
      const pct =
        a.quotaPercent != null ? ` ${Math.round(a.quotaPercent)}%` : ''
      const status = !a.enabled ? ' (disabled)' : ''
      lines.push(`- **${a.label}** [${a.role}]${status}${pct}`)
    }
    lines.push('', USAGE_TEXT)
    return { text: lines.join('\n') }
  }

  if (action.type === 'usage') {
    return { text: USAGE_TEXT }
  }

  if (action.type === 'add-apikey') {
    return { text: 'add-apikey' }
  }
  if (action.type === 'add-oauth-start') {
    return { text: 'add-oauth-start' }
  }
  if (action.type === 'add-oauth-finish') {
    return { text: 'add-oauth-finish' }
  }

  const id = action.id
  if (id === mainId) {
    return {
      text: `Cannot ${action.type} the main account (OpenCode managed).`,
    }
  }

  if (action.type === 'enable' || action.type === 'disable') {
    const target = accounts.find((a) => a.id === id)
    if (!target) {
      return { text: `Account "${id}" not found.` }
    }
    return {
      text: `Account "${target.label ?? id}" ${action.type}d.`,
      updated: {
        id,
        action: action.type,
        enabled: action.type === 'enable',
      },
    }
  }

  if (action.type === 'remove') {
    const target = accounts.find((a) => a.id === id)
    if (!target) {
      return { text: `Account "${id}" not found.` }
    }
    return {
      text: `Account "${target.label ?? id}" removed.`,
      updated: { id, action: 'remove' },
    }
  }

  if (action.type === 'move-up') {
    const idx = accounts.findIndex((a) => a.id === id)
    if (idx < 0) {
      return { text: `Account "${id}" not found.` }
    }
    if (idx === 0) {
      return {
        text: `Account "${accounts[idx]?.label ?? id}" is already first.`,
      }
    }
    const previousOrder = accounts.map((a) => a.id)
    const newAccounts = [...accounts]
    ;[newAccounts[idx - 1], newAccounts[idx]] = [
      newAccounts[idx] as FallbackAccount,
      newAccounts[idx - 1] as FallbackAccount,
    ]
    const newOrder = newAccounts.map((a) => a.id)
    return {
      text: `Account "${accounts[idx]?.label ?? id}" moved up.`,
      updated: { id, action: 'reorder', previousOrder, newOrder },
    }
  }

  if (action.type === 'move-down') {
    const idx = accounts.findIndex((a) => a.id === id)
    if (idx < 0) {
      return { text: `Account "${id}" not found.` }
    }
    if (idx === accounts.length - 1) {
      return {
        text: `Account "${accounts[idx]?.label ?? id}" is already last.`,
      }
    }
    const previousOrder = accounts.map((a) => a.id)
    const newAccounts = [...accounts]
    ;[newAccounts[idx], newAccounts[idx + 1]] = [
      newAccounts[idx + 1] as FallbackAccount,
      newAccounts[idx] as FallbackAccount,
    ]
    const newOrder = newAccounts.map((a) => a.id)
    return {
      text: `Account "${accounts[idx]?.label ?? id}" moved down.`,
      updated: { id, action: 'reorder', previousOrder, newOrder },
    }
  }

  return { text: USAGE_TEXT }
}
