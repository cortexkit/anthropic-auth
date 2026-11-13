import {
  type AuthorizationResult,
  authorize,
  buildCacheKeepStatusSummary,
  buildClaudeQuotaSummary,
  buildPrimeAccountStatuses,
  buildPrimeStatusSummary,
  type CacheKeepSessionRegistry,
  CLAUSTRUM_OPENCODE_ENROLLMENT_NAME,
  effectiveRelayTransport,
  exchange,
  formatNativeAccountState,
  formatOAuthAccountTier,
  getCacheKeepWindow,
  getHostClaustrumEnrollmentPaths,
  isCacheKeepAlways,
  isCacheKeepHybridActive,
  isCacheKeepPersistentlyEnabled,
  isVaultHosted,
  type NativeAccountRuntime,
  type NativeAccountSnapshot,
  type NativeMenuDispatch,
  type NativeSettingsWriteResult,
  nativeAccountCanServe,
  nativeCacheKeepAlways,
  parseLogLevel,
  resetClaustrumEnrollmentState,
  setDumpEnabled,
  VAULT_HOST_CONNECT_REFUSAL,
} from '@cortexkit/anthropic-auth-core'
import { LANE_START_TEXT } from '../lane-start'
import { normalizeSidebarState } from '../sidebar-state'
import {
  CLAUDE_POOL_LOGIN_METHOD_ID,
  CLAUDE_POOL_LOGIN_METHOD_LABEL,
} from './activation'
import { NativeAnthropicTransportRefusal } from './adapter'
import type { NativeMenuCapabilities } from './menu-contract'
import { buildNativeSidebarState } from './sidebar'
import type { NativeSource } from './source'

export type { NativeMenuCapabilities } from './menu-contract'

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}

const POOL_CONNECTION_GUIDANCE = `For first-time model access, connect Anthropic with "${CLAUDE_POOL_LOGIN_METHOD_LABEL}".\nRun: opencode auth login anthropic --method ${CLAUDE_POOL_LOGIN_METHOD_ID}`
const VAULT_EMPTY =
  'No Claude accounts in the vault for this host yet. Add one with `ck auth login --provider anthropic`, then grant it to this host.'
const VAULT_REJECTED =
  'The vault returned an account this plugin cannot use yet.'

async function refreshVaultForStatus(runtime: NativeAccountRuntime) {
  const deadline = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    // Refresh shares discovery with requests and the watcher. Only this menu's
    // wait ends at the deadline; the shared lookup can still publish later.
    return await Promise.race([
      runtime.vault.refresh(deadline.signal).then(
        () => 'complete' as const,
        () => 'failed' as const,
      ),
      new Promise<'pending'>((resolve) => {
        timer = setTimeout(() => {
          resolve('pending')
          deadline.abort()
        }, 2000)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * The pool login connects OpenCode and stores the pool's main account, and
 * running it again replaces that main account. So the menu only points users
 * at it while a local pool has no main account yet. Vault custody signs in
 * through a different method, so it never gets this guidance.
 */
const needsPoolConnection = (snapshot: NativeAccountSnapshot) =>
  snapshot.mode === 'local' &&
  !snapshot.accounts.some((account) => account.id === 'main')

const formatAccountStatus = (
  account: NativeAccountSnapshot['accounts'][number],
) => {
  const role = account.id === 'main' ? 'main' : 'fallback'
  const details = `${account.enabled ? 'enabled' : 'disabled'}, ${account.type}, ${account.source}${account.state ? `, ${formatNativeAccountState(account)}` : ''}`
  // A label is the user's name for the account, so the route id goes on its
  // own line. Without a label the role (and a fallback's route id) is the
  // name, printed once.
  if (account.label)
    return `${account.label} [${role}]: ${details}\n  Route: ${account.id}`
  return `${role === 'main' ? 'Main account' : `Fallback ${account.id}`}: ${details}`
}

/** Account and setting changes use the same Core runtime as model requests. */
export function createNativeMenuCapabilities(options: {
  readonly runtime: NativeAccountRuntime
  readonly source: NativeSource
  readonly cacheKeepRegistry?: CacheKeepSessionRegistry
  readonly start: (sessionID: string, text: string) => Promise<void>
}): NativeMenuCapabilities {
  const { runtime, source } = options
  const pending = new Map<
    string,
    { auth?: AuthorizationResult; readonly active: AbortController }
  >()
  let closed = false
  const write = async (field: string, patch: Record<string, unknown>) => {
    return runtime.updateSettings((settings) => ({
      ...settings,
      [field]: { ...record(settings[field]), ...patch },
    }))
  }
  const done = () => ({ ok: true, text: 'Native Claude settings updated.' })
  const written = (result: NativeSettingsWriteResult) =>
    result.outcome === 'refused' || result.outcome === 'failed'
      ? { ok: false, text: result.reason }
      : done()
  const settingsStatus = (summary: string) => {
    const status = runtime.getSettingsStatus?.()
    if (!status)
      return `${summary}\nSettings file: ${runtime.getSettingsPath()}`
    const { file } = status
    return [
      summary,
      `Settings file: ${file.file}`,
      ...(file.missing
        ? [
            "Settings file is missing; a menu change recreates it when both hosts' protection can be read.",
          ]
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
          ({ model, value }) => `  ${key} [${model}]: ${JSON.stringify(value)}`,
        ),
      ),
    ].join('\n')
  }
  const dispatch: NativeMenuDispatch = async (request, options) => {
    if (
      isVaultHosted() &&
      [
        'enrollment-reset',
        'add-oauth-start',
        'add-oauth-finish',
        'add-apikey',
      ].includes(request.action)
    )
      throw new Error(VAULT_HOST_CONNECT_REFUSAL)
    if (closed) throw new Error('Native menu is closed')
    options.signal?.throwIfAborted()
    await runtime.prepareSettingsAction?.()
    switch (request.action) {
      case 'enable':
      case 'disable':
        await runtime.setEnabled(request.values.id, request.action === 'enable')
        return done()
      case 'remove':
        await runtime.remove(request.values.id)
        return done()
      case 'move-up':
      case 'move-down': {
        const snapshot = await runtime.read()
        const ids = snapshot.accounts.map((account) => account.id)
        const index = ids.indexOf(request.values.id)
        const next = index + (request.action === 'move-up' ? -1 : 1)
        if (index < 0 || next < 0 || next >= ids.length)
          return { ok: false, text: 'Account cannot move in that direction.' }
        const moved = ids[index]
        const neighbour = ids[next]
        if (moved === undefined || neighbour === undefined)
          return { ok: false, text: 'Account order changed.' }
        ids[index] = neighbour
        ids[next] = moved
        await runtime.reorder(ids)
        return done()
      }
      case 'add-apikey':
        await runtime.addApi(request.values)
        return {
          ok: true,
          text: 'API route stored in the native account pool.',
        }
      case 'add-oauth-start': {
        const active = new AbortController()
        pending.get(request.sessionId)?.active.abort()
        const login = {
          active,
          auth: undefined as AuthorizationResult | undefined,
        }
        pending.set(request.sessionId, login)
        const auth = await authorize('max')
        if (closed || active.signal.aborted || options.signal?.aborted)
          return { ok: false, text: 'Sign-in cancelled.' }
        login.auth = auth
        return {
          ok: true,
          text: `Open ${auth.url} and paste the returned code using Finish OAuth sign-in.`,
        }
      }
      case 'add-oauth-finish': {
        const login = pending.get(request.sessionId)
        if (!login?.auth)
          return {
            ok: false,
            text: 'Start OAuth sign-in in this session first.',
          }
        const result = await exchange(
          request.values.code,
          login.auth.verifier,
          login.auth.redirectUri,
          login.auth.state,
        )
        login.active.signal.throwIfAborted()
        options.signal?.throwIfAborted()
        if (closed || result.type !== 'success')
          return { ok: false, text: 'OAuth sign-in did not complete.' }
        await runtime.loginOAuth({
          routeId: crypto.randomUUID(),
          credential: {
            access: result.access,
            refresh: result.refresh,
            expires: result.expires,
          },
          label: request.values.label,
        })
        login.active.signal.throwIfAborted()
        options.signal?.throwIfAborted()
        if (closed) return { ok: false, text: 'Sign-in cancelled.' }
        pending.delete(request.sessionId)
        const stored = 'OAuth account stored in the native account pool.'
        return {
          ok: true,
          text: needsPoolConnection(await runtime.read())
            ? `${stored}\n\n${POOL_CONNECTION_GUIDANCE}\n\nAdding an account here does not change OpenCode's Anthropic connection.`
            : stored,
        }
      }
      case 'reset-backoff': {
        const snapshot = await runtime.read()
        for (const account of snapshot.accounts) {
          options.signal?.throwIfAborted()
          if (account.type !== 'oauth') continue
          const fence =
            account.source === 'vault'
              ? await runtime.authorizeVault(account.id, options.signal)
              : await runtime.captureLocalSubject(account.id)
          await runtime.resetBackoff(account.id, fence)
        }
        return done()
      }
      case 'enrollment-reset': {
        const result = await resetClaustrumEnrollmentState(
          getHostClaustrumEnrollmentPaths('opencode'),
          CLAUSTRUM_OPENCODE_ENROLLMENT_NAME,
        )
        return {
          ok: result === 'reset',
          text:
            result === 'reset'
              ? 'Terminal enrollment state reset. Run offline setup to reconnect.'
              : result === 'refused-pending'
                ? // A pending state may hold a request the vault already stored
                  // under this secret; setup replays that secret to resume it.
                  'An enrollment request may still be in progress. Quit OpenCode and run setup again; it picks up the same request.'
                : 'Only terminal enrollment state may be reset; active enrollment was left unchanged.',
        }
      }
      case 'quota-refresh': {
        const snapshot = await runtime.read()
        const accounts = snapshot.accounts.filter(
          (account) =>
            account.type === 'oauth' && nativeAccountCanServe(account),
        )
        const results = await Promise.allSettled(
          accounts.map((account) =>
            runtime.fetchQuota(account.id, undefined, options.signal),
          ),
        )
        const ok = results.every((result) => result.status === 'fulfilled')
        return {
          ok,
          text: `${results.filter((result) => result.status === 'fulfilled').length}/${accounts.length} native quota readings refreshed.`,
        }
      }
      case 'routing-reset':
        await source.resetRouting(request.sessionId)
        return done()
      case 'routing-mode':
        return written(await write('routing', { mode: request.values.mode }))
      case 'routing-max-same-account-wait':
        return written(
          await write('routing', {
            maxSameAccountWait: request.values.maxSameAccountWait,
          }),
        )
      case 'killswitch-on':
      case 'killswitch-off':
        return written(
          await write('killswitch', {
            enabled: request.action === 'killswitch-on',
          }),
        )
      case 'killswitch-set': {
        const result = await runtime.updateSettings((settings) => {
          const existing = record(settings.killswitch)
          const accounts = { ...record(existing.accounts) }
          let main = existing.main
          for (const entry of request.values.entries) {
            const threshold = {
              five_hour: entry.fh,
              seven_day: entry.sd,
              ...(entry.scoped !== undefined ? { scoped: entry.scoped } : {}),
            }
            if (entry.account === 'main' || entry.account === 'all')
              main = threshold
            if (entry.account === 'all')
              for (const id of Object.keys(accounts)) accounts[id] = threshold
            else if (entry.account !== 'main')
              accounts[entry.account] = threshold
          }
          return { ...settings, killswitch: { ...existing, main, accounts } }
        })
        return written(result)
      }
      case 'cache-on':
      case 'cache-off':
        return written(
          await write('claudeCache', {
            enabled: request.action === 'cache-on',
          }),
        )
      case 'cache-mode':
        return written(
          await write('claudeCache', { mode: request.values.mode }),
        )
      case 'cachekeep-always':
        return written(await runtime.updateSettings(nativeCacheKeepAlways))
      case 'cachekeep-off':
        return written(await write('cacheKeep', { enabled: false }))
      case 'cachekeep-window':
        return written(
          await write('cacheKeep', {
            enabled: true,
            always: false,
            startHour: request.values.startHour,
            endHour: request.values.endHour,
          }),
        )
      case 'cachekeep-subagents':
        return written(
          await write('cacheKeep', {
            subagents: request.values.enabled === 'on',
          }),
        )
      case 'dump-on':
      case 'dump-off': {
        const enabled = request.action === 'dump-on'
        const result = written(await write('dump', { enabled }))
        if (!result.ok) return result
        // Mirror the persisted switch into this process's Core dump flag, as
        // OpenCode 1 does after its own dump command. The adapter still reads
        // the persisted switch per send; this keeps background Core dumps
        // (CacheKeep prewarms) in sync without waiting for the next request.
        try {
          setDumpEnabled(enabled)
        } catch {}
        return result
      }
      case 'logging-level': {
        const level = parseLogLevel(request.values.level)
        if (!level) throw new Error('Invalid log level')
        return written(await runtime.setLoggingLevel(level))
      }
      case 'fast-on':
      case 'fast-off':
        return written(
          await write('claudeFast', { enabled: request.action === 'fast-on' }),
        )
      case 'prime-on':
      case 'prime-off':
        return written(
          await write('prime', { enabled: request.action === 'prime-on' }),
        )
      case 'start-fire':
        await optionsStart(request.sessionId)
        return { ok: true, text: 'Claude lane start queued in this session.' }
    }
  }
  const optionsStart = (sessionID: string) =>
    options.start(sessionID, LANE_START_TEXT)
  return {
    dispatch,
    async readStatus(command) {
      await runtime.prepareSettingsAction?.()
      let snapshot = await runtime.read()
      if (command === 'account') {
        let empty = 'No native Claude accounts.'
        const notices: string[] = []
        if (snapshot.mode === 'claustrum') {
          const relay = snapshot.policyStorage.relay
          if (
            relay?.enabled === true &&
            effectiveRelayTransport(relay.transport, relay.url) === 'websocket'
          )
            return new NativeAnthropicTransportRefusal().message
          let lookup = await refreshVaultForStatus(runtime)
          // The host may have disconnected from the vault during discovery.
          snapshot = await runtime.read()
          if (snapshot.mode === 'claustrum') {
            const roster = await runtime.vault.read()
            if (lookup === 'complete' && !roster?.view) lookup = 'failed'
            empty =
              lookup === 'complete'
                ? VAULT_EMPTY
                : 'No saved Claude accounts for this host yet.'
            if (roster?.rejected?.length) {
              empty = VAULT_REJECTED
              if (snapshot.accounts.length) notices.push(VAULT_REJECTED)
            }
            if (lookup === 'pending')
              notices.push('Vault account lookup is still running.')
            else if (lookup === 'failed')
              notices.push(
                'Vault account lookup did not complete; reopen /claude to retry.',
              )
          }
        }
        const accounts = [
          snapshot.accounts.map(formatAccountStatus).join('\n') || empty,
          ...notices,
        ].join('\n')
        return needsPoolConnection(snapshot)
          ? `${accounts}\n\n${POOL_CONNECTION_GUIDANCE}\nQuota refresh checks the pool; it does not check OpenCode's Anthropic connection.`
          : accounts
      }
      if (command === 'quota')
        return settingsStatus(
          buildClaudeQuotaSummary({
            accounts: snapshot.accounts
              .filter((account) => account.type === 'oauth')
              .map((account) => ({
                name: account.label ?? account.id,
                role:
                  account.id === 'main'
                    ? ('main' as const)
                    : ('fallback' as const),
                enabled: account.enabled,
                quota: account.quota,
                tierLabel: formatOAuthAccountTier(account.profile),
                lastRefreshedAt: account.lastRefreshedAt,
                error: account.lastQuotaRefreshError?.message,
              })),
          }).replace(
            /Usage:[^\n]*/,
            'Use /claude to refresh native quota readings.',
          ),
        )
      if (command === 'prime')
        return settingsStatus(
          buildPrimeStatusSummary({
            enabled: snapshot.policyStorage.prime?.enabled === true,
            accounts: buildPrimeAccountStatuses(snapshot.policyStorage),
          }).replace(/Usage:[^\n]*/, 'Use /claude to change Prime settings.'),
        )
      if (command === 'cachekeep') {
        const sessions = (await options.cacheKeepRegistry?.list()) ?? []
        return settingsStatus(
          buildCacheKeepStatusSummary({
            enabled: isCacheKeepPersistentlyEnabled(snapshot.policyStorage),
            always: isCacheKeepAlways(snapshot.policyStorage),
            hybridActive: isCacheKeepHybridActive(snapshot.policyStorage),
            trackedSessionDetails: sessions,
            window: getCacheKeepWindow(snapshot.policyStorage),
            trackedSessions: sessions.length,
            nextPrewarmAt: sessions.length
              ? Math.min(...sessions.map((session) => session.nextPrewarmAt))
              : undefined,
          }),
        )
      }
      const fields = {
        routing: 'routing',
        killswitch: 'killswitch',
        cache: 'claudeCache',
        cachekeep: 'cacheKeep',
        dump: 'dump',
        logging: 'logging',
        fast: 'claudeFast',
        prime: 'prime',
      } as const
      return settingsStatus(
        JSON.stringify(snapshot.settings[fields[command]] ?? {}),
      )
    },
    async readSidebar(sessionID) {
      const [snapshot, sessions] = await Promise.all([
        runtime.read(),
        options.cacheKeepRegistry?.list() ?? [],
      ])
      return normalizeSidebarState(
        buildNativeSidebarState(snapshot, {
          activeId: source.servedAccount(sessionID),
          trackedSessions: sessions.length,
          now: Date.now(),
        }),
      )
    },
    forgetSession(sessionID) {
      pending.get(sessionID)?.active.abort()
      pending.delete(sessionID)
    },
    close() {
      closed = true
      for (const login of pending.values()) login.active.abort()
      pending.clear()
    },
  }
}
