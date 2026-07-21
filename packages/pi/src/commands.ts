import {
  buildClaudeQuotaSummary,
  buildFallbackQuotaSummaries,
  buildPrimeAccountStatuses,
  CLAUDE_ACCOUNT_COMMAND_NAME,
  CLAUDE_CACHE_KEEP_COMMAND_NAME,
  CLAUDE_PRIME_COMMAND_NAME,
  CLAUDE_ROUTING_COMMAND_NAME,
  createEmptyStorage,
  executeAccountCommand,
  executeCache1hCommand,
  executeCacheKeepCommand,
  executeDumpCommand,
  executeFastModeCommand,
  executeLoggingCommand,
  executePrimeCommand,
  executeRoutingCommand,
  getCache1hPersistentMode,
  getCacheKeepWindow,
  getPersistedLogLevel,
  getRoutingMode,
  isCache1hPersistentlyEnabled,
  isCacheKeepAlways,
  isCacheKeepHybridActive,
  isCacheKeepPersistentlyEnabled,
  isDumpPersistentlyEnabled,
  isFastModePersistentlyEnabled,
  isPrimePersistentlyEnabled,
  loadAccounts,
  parseCache1hCommandAction,
  parseCacheKeepCommandAction,
  parseDumpCommandAction,
  parseFastModeCommandAction,
  parseLoggingCommandAction,
  parseRoutingCommandAction,
  removeAccountPersistent,
  reorderAccountsPersistent,
  setAccountEnabledPersistent,
  setCache1hPersistentEnabled,
  setCache1hPersistentMode,
  setCacheKeepPersistentAlways,
  setCacheKeepPersistentEnabled,
  setCacheKeepPersistentWindow,
  setCacheKeepSubagentsEnabled,
  setDumpEnabled,
  setDumpPersistentEnabled,
  setFastModePersistentEnabled,
  setLogLevelPersistent,
  setRoutingMode,
} from '@cortexkit/anthropic-auth-core'
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from '@earendil-works/pi-coding-agent'

import { getPiAccountStoragePath } from './paths.ts'
import {
  clearPiStickyRoutingSession,
  getPiTrackedCacheKeepSessions,
} from './stream.ts'

type NotifyKind = 'info' | 'warning' | 'error'

function notify(
  ctx: ExtensionCommandContext,
  message: string,
  kind: NotifyKind = 'info',
) {
  ctx.ui.notify(message, kind)
}

export function registerCommands(pi: ExtensionAPI) {
  pi.registerCommand('claude-cache', {
    description: 'Show or configure Claude 1-hour prompt cache mode',
    handler: async (args, ctx) => {
      const path = getPiAccountStoragePath()
      const storage = await loadAccounts(path)
      const action = parseCache1hCommandAction(args ?? '')
      const enabled = isCache1hPersistentlyEnabled(storage)
      const mode = getCache1hPersistentMode(storage)

      const nextEnabled =
        action.type === 'enable'
          ? true
          : action.type === 'disable'
            ? false
            : enabled
      const nextMode = action.type === 'mode' ? action.mode : mode

      if (action.type === 'enable') {
        await setCache1hPersistentEnabled(true, undefined, path)
      } else if (action.type === 'disable') {
        await setCache1hPersistentEnabled(false, undefined, path)
      } else if (action.type === 'mode') {
        await setCache1hPersistentMode(action.mode, path)
      }

      notify(
        ctx,
        executeCache1hCommand({
          argumentsText: args ?? '',
          enabled: nextEnabled,
          mode: nextMode,
        }),
        action.type === 'usage' ? 'warning' : 'info',
      )
    },
  })

  pi.registerCommand(CLAUDE_CACHE_KEEP_COMMAND_NAME, {
    description:
      'Keep hybrid Claude cache warm always or during a local time window',
    handler: async (args, ctx) => {
      const path = getPiAccountStoragePath()
      let storage = await loadAccounts(path)
      const action = parseCacheKeepCommandAction(args ?? '')

      if (action.type === 'window') {
        storage = await setCacheKeepPersistentWindow(
          action.startHour,
          action.endHour,
          path,
        )
      } else if (action.type === 'always') {
        storage = await setCacheKeepPersistentAlways(path)
      } else if (action.type === 'disable') {
        storage = await setCacheKeepPersistentEnabled(false, path)
      } else if (action.type === 'subagents') {
        storage = await setCacheKeepSubagentsEnabled(action.enabled, path)
      }

      const trackedSessionDetails = await getPiTrackedCacheKeepSessions()
      const nextPrewarmAt = trackedSessionDetails.length
        ? Math.min(
            ...trackedSessionDetails.map((session) => session.nextPrewarmAt),
          )
        : undefined
      notify(
        ctx,
        executeCacheKeepCommand({
          argumentsText: args ?? '',
          enabled: isCacheKeepPersistentlyEnabled(storage),
          always: isCacheKeepAlways(storage),
          window: getCacheKeepWindow(storage),
          hybridActive: isCacheKeepHybridActive(storage),
          trackedSessions: trackedSessionDetails.length,
          trackedSessionDetails,
          nextPrewarmAt,
        }),
        action.type === 'usage' ? 'warning' : 'info',
      )
    },
  })

  pi.registerCommand('claude-dump', {
    description: 'Show or configure Anthropic request/relay dumping',
    handler: async (args, ctx) => {
      const path = getPiAccountStoragePath()
      const storage = await loadAccounts(path)
      const action = parseDumpCommandAction(args ?? '')
      const enabled = isDumpPersistentlyEnabled(storage)

      const nextEnabled =
        action.type === 'enable'
          ? true
          : action.type === 'disable'
            ? false
            : enabled

      if (action.type === 'enable') {
        await setDumpPersistentEnabled(true, path)
        setDumpEnabled(true)
      } else if (action.type === 'disable') {
        await setDumpPersistentEnabled(false, path)
        setDumpEnabled(false)
      } else {
        setDumpEnabled(enabled)
      }

      notify(
        ctx,
        executeDumpCommand({ argumentsText: args ?? '', enabled: nextEnabled }),
        action.type === 'usage' ? 'warning' : 'info',
      )
    },
  })

  pi.registerCommand('claude-fast', {
    description:
      'Show or configure Anthropic fast mode for supported Opus models',
    handler: async (args, ctx) => {
      const path = getPiAccountStoragePath()
      const storage = await loadAccounts(path)
      const action = parseFastModeCommandAction(args ?? '')
      const enabled = isFastModePersistentlyEnabled(storage)

      const nextEnabled =
        action.type === 'enable'
          ? true
          : action.type === 'disable'
            ? false
            : enabled

      if (action.type === 'enable') {
        await setFastModePersistentEnabled(true, path)
      } else if (action.type === 'disable') {
        await setFastModePersistentEnabled(false, path)
      }

      notify(
        ctx,
        executeFastModeCommand({
          argumentsText: args ?? '',
          enabled: nextEnabled,
        }),
        action.type === 'usage' ? 'warning' : 'info',
      )
    },
  })

  pi.registerCommand(CLAUDE_ROUTING_COMMAND_NAME, {
    description: 'Show or change Claude account routing mode',
    handler: async (args, ctx) => {
      const path = getPiAccountStoragePath()
      let storage = await loadAccounts(path)
      const action = parseRoutingCommandAction(args ?? '')

      if (action.type === 'mode') {
        storage = await setRoutingMode(action.mode, path)
      } else if (action.type === 'reset') {
        await clearPiStickyRoutingSession(
          path,
          ctx.sessionManager.getSessionId(),
        )
      }

      notify(
        ctx,
        executeRoutingCommand({
          argumentsText: args ?? '',
          mode: getRoutingMode(storage),
        }),
        action.type === 'usage' ? 'warning' : 'info',
      )
    },
  })

  pi.registerCommand('claude-quota', {
    description: 'Show Claude quota state for fallback accounts',
    handler: async (_args, ctx) => {
      const storage = await loadAccounts(getPiAccountStoragePath())
      notify(
        ctx,
        buildClaudeQuotaSummary({
          accounts: buildFallbackQuotaSummaries(storage),
          now: Date.now(),
        }),
      )
    },
  })

  pi.registerCommand(CLAUDE_ACCOUNT_COMMAND_NAME, {
    description: 'List, enable/disable, reorder, or remove fallback accounts',
    handler: async (args, ctx) => {
      const path = getPiAccountStoragePath()
      const storage = await loadAccounts(path)
      const result = executeAccountCommand({
        argumentsText: args ?? '',
        storage: storage ?? createEmptyStorage(),
      })

      if (!result.updated) {
        notify(ctx, result.text)
        return
      }

      // Wire persistent mutations via core helpers
      const { id, action: mutationAction } = result.updated

      if (mutationAction === 'enable') {
        await setAccountEnabledPersistent(id, true, path)
      } else if (mutationAction === 'disable') {
        await setAccountEnabledPersistent(id, false, path)
      } else if (mutationAction === 'remove') {
        const existed = await removeAccountPersistent(id, path)
        if (!existed) {
          notify(ctx, `Account "${id}" not found.`, 'warning')
          return
        }
      } else if (mutationAction === 'reorder') {
        const newOrder = result.updated.newOrder
        if (newOrder) {
          await reorderAccountsPersistent(newOrder, path)
        }
      }

      notify(ctx, result.text)
    },
  })

  pi.registerCommand('claude-logging', {
    description: 'Show or set the plugin log level',
    handler: async (args, ctx) => {
      const path = getPiAccountStoragePath()
      const storage = await loadAccounts(path)
      const action = parseLoggingCommandAction(args ?? '')
      const currentLevel = getPersistedLogLevel(storage) ?? 'info'

      // Wire persistent log-level mutation
      let level = currentLevel
      if (action.type === 'level') {
        await setLogLevelPersistent(action.level, path)
        level = action.level
      }

      notify(ctx, executeLoggingCommand({ argumentsText: args ?? '', level }))
    },
  })

  pi.registerCommand(CLAUDE_PRIME_COMMAND_NAME, {
    description: "Show each OAuth account's five-hour quota window state",
    handler: async (_args, ctx) => {
      // Pi has no live PrimeManager; render persisted counters and the
      // next-due timestamp from stored quota snapshots. Always pass
      // `argumentsText: 'status'` to the pure executor so on/off args
      // are display-only — Pi cannot toggle the setting.
      const path = getPiAccountStoragePath()
      const storage = await loadAccounts(path)
      const accounts = buildPrimeAccountStatuses(storage, { now: Date.now() })
      notify(
        ctx,
        executePrimeCommand({
          argumentsText: 'status',
          enabled: isPrimePersistentlyEnabled(storage),
          accounts,
        }).text,
      )
    },
  })
}
