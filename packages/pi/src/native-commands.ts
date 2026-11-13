import { randomUUID } from 'node:crypto'
import {
  authorize,
  buildClaudeQuotaSummary,
  buildPrimeAccountStatuses,
  DEFAULT_KILLSWITCH_THRESHOLDS,
  exchange,
  executeCacheKeepCommand,
  executePrimeCommand,
  formatEnrollmentStatus,
  formatNativeAccountState,
  formatOAuthAccountTier,
  getCache1hPersistentMode,
  getCacheKeepWindow,
  getMaxSameAccountWait,
  getPersistedLogLevel,
  getRoutingMode,
  isCache1hPersistentlyEnabled,
  isCacheKeepAlways,
  isCacheKeepHybridActive,
  isCacheKeepPersistentlyEnabled,
  isDumpPersistentlyEnabled,
  isFastModePersistentlyEnabled,
  isKillswitchEnabled,
  isPrimePersistentlyEnabled,
  isVaultHosted,
  type NativeMenuDispatch,
  type NativeMenuKillswitchEntry,
  type NativeSettingsWriteResult,
  nativeAccountCanServe,
  setDumpEnabled,
  VAULT_HOST_CONNECT_REFUSAL,
  VAULT_HOST_STATUS,
} from '@cortexkit/anthropic-auth-core'
import type { PiNativeCommands } from './commands.ts'
import { createPiCustodyCommands } from './custody.ts'
import { getPiNativeRuntime } from './native.ts'
import { getPiAccountStoragePath } from './paths.ts'
import {
  clearPiStickyRoutingSession,
  getPiTrackedCacheKeepSessions,
} from './stream.ts'
import { fetchPiOAuth } from './transport.ts'

export function createPiNativeCommands(
  storagePath = getPiAccountStoragePath(),
): PiNativeCommands {
  const native = getPiNativeRuntime(storagePath)
  const custody = createPiCustodyCommands()
  const pending = new Map<
    string,
    { authorization: Awaited<ReturnType<typeof authorize>>; expires: number }
  >()
  const written = (result: NativeSettingsWriteResult, text: string) =>
    result.outcome === 'refused' || result.outcome === 'failed'
      ? { ok: false, text: result.reason }
      : { ok: true, text }
  const setSection = async (key: string, patch: Record<string, unknown>) => {
    return (await native.service()).updateSettings((settings) =>
      mergeNativeSettingsSection(settings, key, patch),
    )
  }
  const setLimits = async (entries: readonly NativeMenuKillswitchEntry[]) => {
    const snapshot = await native.view()
    return (await native.service()).updateSettings((settings) => {
      const limits = record(settings.killswitch)
      let accounts = { ...record(limits.accounts) }
      let main = limits.main
      for (const entry of entries) {
        const threshold = {
          five_hour: entry.fh,
          seven_day: entry.sd,
          scoped: entry.scoped ?? 0,
        }
        if (entry.account === 'main' || entry.account === 'all')
          main = threshold
        if (entry.account === 'all') {
          for (const account of snapshot.accounts)
            if (account.id !== 'main')
              accounts = { ...accounts, [account.id]: threshold }
        } else if (entry.account !== 'main')
          accounts = { ...accounts, [entry.account]: threshold }
      }
      return {
        ...settings,
        killswitch: { ...limits, enabled: true, main, accounts },
      }
    })
  }
  const dispatch: NativeMenuDispatch = async (request, options) => {
    const runtime = await native.service()
    await runtime.prepareSettingsAction?.()
    if (
      isVaultHosted() &&
      [
        'enrollment-reset',
        'add-oauth-start',
        'add-oauth-finish',
        'add-apikey',
      ].includes(request.action)
    )
      return { ok: false, text: VAULT_HOST_CONNECT_REFUSAL }
    switch (request.action) {
      case 'enable':
      case 'disable':
        await runtime.setEnabled(request.values.id, request.action === 'enable')
        return { ok: true, text: `Native account ${request.action}d.` }
      case 'remove':
        await runtime.remove(request.values.id)
        return { ok: true, text: 'Native account removed.' }
      case 'move-up':
      case 'move-down': {
        const order = (await native.view()).accounts.map(
          (account) => account.id,
        )
        const index = order.indexOf(request.values.id)
        if (index < 0) return { ok: false, text: 'Native account not found.' }
        const target = index + (request.action === 'move-up' ? -1 : 1)
        if (target < 0 || target >= order.length)
          return {
            ok: true,
            text: 'Native account is already at that end of the order.',
          }
        const id = order[index]
        const other = order[target]
        if (!id || !other)
          return { ok: false, text: 'Native account order is unavailable.' }
        order[index] = other
        order[target] = id
        await runtime.reorder(order, request.values.id)
        return { ok: true, text: 'Native account order updated.' }
      }
      case 'add-apikey':
        await runtime.addApi({
          apiKey: request.values.apiKey,
          ...(request.values.baseURL && { baseURL: request.values.baseURL }),
          ...(request.values.authHeader && {
            authHeader: request.values.authHeader,
          }),
          ...(request.values.label && { label: request.values.label }),
        })
        return {
          ok: true,
          text: 'API-key fallback saved in the native pool. It is used only after confirmed general OAuth exhaustion.',
        }
      case 'reset-backoff': {
        const snapshot = await native.view()
        const main = snapshot.accounts.find((account) => account.id === 'main')
        if (main?.type !== 'oauth')
          return {
            ok: false,
            text: 'Native main OAuth account is unavailable.',
          }
        const fence =
          main.source === 'vault'
            ? await runtime.authorizeVault('main', options.signal)
            : await runtime.captureLocalSubject('main')
        const reset = await runtime.resetBackoff('main', fence, 'all')
        return {
          ok: reset,
          text: reset
            ? 'Native main OAuth refresh and quota backoff cleared.'
            : 'Native account changed before backoff could be cleared.',
        }
      }
      case 'enrollment-reset': {
        const result = await custody.reset()
        return { ok: !result.text.startsWith('Refused:'), text: result.text }
      }
      case 'add-oauth-start': {
        if ((await native.view()).mode !== 'local')
          return {
            ok: false,
            text: 'Local OAuth login is disabled in Claustrum mode. Use offline setup.',
          }
        const authorization = await authorize('max')
        pending.delete(request.sessionId)
        pending.set(request.sessionId, {
          authorization,
          expires: Date.now() + 10 * 60_000,
        })
        while (pending.size > 32) {
          const first = pending.keys().next().value
          if (first === undefined) break
          pending.delete(first)
        }
        return {
          ok: true,
          text: `Open this OAuth URL, then complete Add OAuth finish in the same session:\n${authorization.url}`,
        }
      }
      case 'add-oauth-finish': {
        const flow = pending.get(request.sessionId)
        pending.delete(request.sessionId)
        if (!flow || flow.expires <= Date.now())
          return {
            ok: false,
            text: 'No pending OAuth login in this session. Start a new login.',
          }
        const snapshot = await native.view()
        if (snapshot.mode !== 'local')
          return {
            ok: false,
            text: 'Local OAuth login is disabled in Claustrum mode. Use offline setup.',
          }
        const result = await exchange(
          request.values.code,
          flow.authorization.verifier,
          flow.authorization.redirectUri,
          flow.authorization.state,
        )
        if (result.type !== 'success')
          return { ok: false, text: 'Anthropic OAuth exchange failed.' }
        const account = await runtime.loginOAuth({
          routeId: snapshot.accounts.some((account) => account.id === 'main')
            ? randomUUID()
            : 'main',
          credential: {
            access: result.access,
            refresh: result.refresh,
            expires: result.expires,
          },
          ...(request.values.label && { label: request.values.label }),
        })
        const admission = await runtime.authorizeLocal(account.id, {
          signal: options.signal,
        })
        if (admission.status !== 'usable')
          return {
            ok: false,
            text: 'OAuth material was saved in the native pool, but account validation did not complete. It cannot serve until native validation succeeds.',
          }
        return {
          ok: true,
          text: 'OAuth account validated and saved in the native pool. Pi host auth was not changed.',
        }
      }
      case 'quota-refresh': {
        const snapshot = await native.view()
        for (const account of snapshot.accounts) {
          if (!nativeAccountCanServe(account) || account.type !== 'oauth')
            continue
          await runtime.fetchQuota(account.id, fetchPiOAuth, options.signal)
          await runtime.fetchProfile(account.id, fetchPiOAuth, options.signal)
        }
        return { ok: true, text: 'Native OAuth quota and profile refreshed.' }
      }
      case 'routing-mode':
        return written(
          await setSection('routing', { mode: request.values.mode }),
          'Native routing mode updated.',
        )
      case 'routing-max-same-account-wait':
        return written(
          await setSection('routing', {
            maxSameAccountWait: request.values.maxSameAccountWait,
          }),
          'Longest wait on the same account updated.',
        )
      case 'routing-reset':
        await clearPiStickyRoutingSession(storagePath, request.sessionId)
        return {
          ok: true,
          text: 'This session’s sticky assignment was cleared.',
        }
      case 'killswitch-on':
        return written(
          await runtime.updateSettings((settings) => {
            const limits = record(settings.killswitch)
            return {
              ...settings,
              killswitch: {
                ...limits,
                enabled: true,
                main: limits.main ?? { ...DEFAULT_KILLSWITCH_THRESHOLDS },
              },
            }
          }),
          'Native killswitch enabled.',
        )
      case 'killswitch-off':
        return written(
          await setSection('killswitch', { enabled: false }),
          'Native killswitch disabled.',
        )
      case 'killswitch-set':
        return written(
          await setLimits(request.values.entries),
          'Native killswitch thresholds updated.',
        )
      case 'cache-on':
      case 'cache-off':
        return written(
          await setSection('claudeCache', {
            enabled: request.action === 'cache-on',
          }),
          'Native prompt cache setting updated.',
        )
      case 'cache-mode':
        return written(
          await setSection('claudeCache', { mode: request.values.mode }),
          'Native prompt cache mode updated.',
        )
      case 'cachekeep-always':
        return written(
          await runtime.updateSettings(nativeCacheKeepAlways),
          'Native CacheKeep is always enabled.',
        )
      case 'cachekeep-off':
        return written(
          await setSection('cacheKeep', { enabled: false }),
          'Native CacheKeep disabled.',
        )
      case 'cachekeep-window':
        return written(
          await setSection('cacheKeep', {
            enabled: true,
            always: false,
            startHour: request.values.startHour,
            endHour: request.values.endHour,
          }),
          'Native CacheKeep local time window updated.',
        )
      case 'cachekeep-subagents':
        return written(
          await setSection('cacheKeep', {
            subagents: request.values.enabled === 'on',
          }),
          'Native CacheKeep subagent setting updated.',
        )
      case 'dump-on':
      case 'dump-off': {
        const enabled = request.action === 'dump-on'
        const result = written(
          await setSection('dump', { enabled }),
          'Native request dumping setting updated.',
        )
        if (!result.ok) return result
        setDumpEnabled(enabled)
        return result
      }
      case 'logging-level':
        // The native runtime stores the level and applies it to the logger.
        return written(
          await runtime.setLoggingLevel(request.values.level),
          'Native logging level updated.',
        )
      case 'fast-on':
      case 'fast-off':
        return written(
          await setSection('claudeFast', {
            enabled: request.action === 'fast-on',
          }),
          'Native fast mode setting updated.',
        )
      case 'prime-on':
      case 'prime-off': {
        const result = written(
          await setSection('prime', { enabled: request.action === 'prime-on' }),
          'Native Prime setting updated.',
        )
        if (!result.ok) return result
        native.prime?.settingsChanged()
        return result
      }
      case 'start-fire':
        return {
          ok: false,
          text: 'Pi has no lane-start action.',
        }
    }
  }
  return {
    readAccounts: async () => {
      const runtime = await native.service()
      await runtime.prepareSettingsAction?.()
      return runtime.read()
    },
    dispatch,
    async readStatus(command) {
      const runtime = await native.service()
      await runtime.prepareSettingsAction?.()
      const snapshot = await runtime.read()
      if (
        (command === 'account' || command === 'quota') &&
        snapshot.mode === 'claustrum' &&
        !(await runtime.vault.read())
      )
        return 'Claustrum roster is unavailable; no verified account view has been discovered.'
      const storage = snapshot.policyStorage
      const settingsStatus = (summary: string) => {
        const status = runtime.getSettingsStatus?.()
        if (!status) return summary
        const { file } = status
        return [
          summary,
          `Settings file: ${file.file}`,
          ...(file.missing
            ? ['Settings file is missing; a menu write will recreate it.']
            : [`Settings file state: ${file.state}`]),
          ...(file.recreated
            ? ['Settings file was recreated by a menu write.']
            : []),
          ...file.invalidKeys.map((key) => `Invalid setting: ${key}`),
          ...file.ignoredModelKeys.map(
            ({ setting, model }) => `Ignored model key: ${setting}.${model}`,
          ),
          ...file.duplicateKeys.map((key) => `Duplicate setting: ${key}`),
          'Settings (no model):',
          ...Object.entries(status.values).map(
            ([key, value]) => `  ${key}: ${JSON.stringify(value)}`,
          ),
          ...Object.entries(status.modelOverrides).flatMap(([key, rows]) =>
            (rows ?? []).map(
              ({ model, value }) =>
                `  ${key} [${model}]: ${JSON.stringify(value)}`,
            ),
          ),
        ].join('\n')
      }
      switch (command) {
        case 'account':
          return [
            `Custody: ${snapshot.mode}`,
            ...snapshot.accounts.map(
              (account) =>
                `${account.id}: ${account.label ?? account.id} (${account.type}, ${account.enabled ? 'enabled' : 'disabled'}, ${account.source}${account.state ? `, ${formatNativeAccountState(account)}` : ''}${formatOAuthAccountTier(account.profile) ? `, ${formatOAuthAccountTier(account.profile)}` : ''}); identity: ${account.accountIdentity ?? 'unverified'}${account.lastRefreshError ? `; refresh: ${account.lastRefreshError.permanent ? 'requires login' : 'backoff'}` : ''}`,
            ),
            ...(isVaultHosted()
              ? [VAULT_HOST_STATUS]
              : formatEnrollmentStatus(
                  await custody.status(),
                  snapshot.mode === 'claustrum',
                )),
          ].join('\n')
        case 'quota':
          return buildClaudeQuotaSummary({
            accounts: snapshot.accounts
              .filter((account) => account.type === 'oauth')
              .map((account) => ({
                name: account.label ?? account.id,
                role: account.id === 'main' ? 'main' : 'fallback',
                enabled: account.enabled,
                quota: account.quota,
                lastRefreshedAt: account.lastRefreshedAt,
                tierLabel: formatOAuthAccountTier(account.profile),
                error:
                  account.lastQuotaRefreshError?.message ??
                  account.lastRefreshError?.message,
              })),
          })
        case 'routing':
          return settingsStatus(
            `Routing: ${getRoutingMode(storage)}\nLongest wait on the same account: ${getMaxSameAccountWait(storage)}`,
          )
        case 'killswitch':
          return settingsStatus(
            `Killswitch: ${isKillswitchEnabled(storage) ? 'enabled' : 'disabled'}\n${JSON.stringify(storage.killswitch ?? {})}`,
          )
        case 'cache':
          return settingsStatus(
            [
              `1-hour cache: ${isCache1hPersistentlyEnabled(storage) ? 'enabled' : 'disabled'}; mode: ${getCache1hPersistentMode(storage)}`,
              `- Persisted: ${await runtime.getSettingsPath()}`,
            ].join('\n'),
          )
        case 'cachekeep': {
          const sessions = await getPiTrackedCacheKeepSessions()
          return settingsStatus(
            executeCacheKeepCommand({
              argumentsText: '',
              enabled: isCacheKeepPersistentlyEnabled(storage),
              always: isCacheKeepAlways(storage),
              hybridActive: isCacheKeepHybridActive(storage),
              window: getCacheKeepWindow(storage),
              trackedSessions: sessions.length,
              trackedSessionDetails: sessions,
              nextPrewarmAt: sessions.length
                ? Math.min(...sessions.map((session) => session.nextPrewarmAt))
                : undefined,
            }),
          )
        }
        case 'dump':
          return settingsStatus(
            [
              `Request dumping: ${isDumpPersistentlyEnabled(storage) ? 'enabled' : 'disabled'}`,
              `- Persisted: ${await runtime.getSettingsPath()}`,
            ].join('\n'),
          )
        case 'logging':
          return settingsStatus(
            [
              `Logging: ${getPersistedLogLevel(storage) ?? 'info'}`,
              `- Persisted: ${await runtime.getSettingsPath()}`,
            ].join('\n'),
          )
        case 'fast':
          return settingsStatus(
            [
              `Fast mode: ${isFastModePersistentlyEnabled(storage) ? 'enabled' : 'disabled'}`,
              `- Persisted: ${await runtime.getSettingsPath()}`,
            ].join('\n'),
          )
        case 'prime':
          return settingsStatus(
            executePrimeCommand({
              argumentsText: 'status',
              enabled: isPrimePersistentlyEnabled(storage),
              accounts:
                native.prime?.manager.stats(storage) ??
                buildPrimeAccountStatuses(storage, { now: Date.now() }),
            }).text,
          )
      }
    },
  }
}

import {
  mergeNativeSettingsSection,
  nativeCacheKeepAlways,
  nativeSettingsRecord as record,
} from '@cortexkit/anthropic-auth-core'
