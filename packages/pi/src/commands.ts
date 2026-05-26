import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from '@earendil-works/pi-coding-agent'
import {
  buildClaudeQuotaSummary,
  buildFallbackQuotaSummaries,
  CLAUDE_CACHE_KEEP_COMMAND_NAME,
  executeCache1hCommand,
  executeCacheKeepCommand,
  executeDumpCommand,
  executeFastModeCommand,
  getCache1hPersistentMode,
  getCacheKeepWindow,
  isCache1hPersistentlyEnabled,
  isCacheKeepHybridActive,
  isCacheKeepPersistentlyEnabled,
  isDumpPersistentlyEnabled,
  isFastModePersistentlyEnabled,
  loadAccounts,
  parseCache1hCommandAction,
  parseCacheKeepCommandAction,
  parseDumpCommandAction,
  parseFastModeCommandAction,
  setCache1hPersistentEnabled,
  setCache1hPersistentMode,
  setCacheKeepPersistentEnabled,
  setCacheKeepPersistentWindow,
  setDumpPersistentEnabled,
  setFastModePersistentEnabled,
} from '@marcusrbrown/anthropic-auth-core'

import { getPiAccountStoragePath } from './paths.ts'

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
    description: 'Keep hybrid Claude cache warm during a local time window',
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
      } else if (action.type === 'disable') {
        storage = await setCacheKeepPersistentEnabled(false, path)
      }

      notify(
        ctx,
        executeCacheKeepCommand({
          argumentsText: args ?? '',
          enabled: isCacheKeepPersistentlyEnabled(storage),
          window: getCacheKeepWindow(storage),
          hybridActive: isCacheKeepHybridActive(storage),
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
      } else if (action.type === 'disable') {
        await setDumpPersistentEnabled(false, path)
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
}
