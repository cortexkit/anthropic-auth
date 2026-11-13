import {
  acquireNativeAccountRuntime,
  assertUnmanagedInjectedPaths,
  authorize,
  connectVaultHost,
  createNativeAccountRuntime,
  createNativeUi,
  decideOpenCodeStateLayoutOnce,
  disconnectNativeVaultForHost,
  exchange,
  getPersistedLogLevel,
  getSettingsFilePath,
  isDumpPersistentlyEnabled,
  isVaultHosted,
  legacySettingsProtection,
  logger,
  type NativeAccountRuntime,
  type NativeAccountRuntimeOptions,
  NativeCustodyError,
  type NativeHolderRegistration,
  type NativePoolPaths,
  type NativeUiOptions,
  nativeVaultRuntimeKey,
  openCodeHolderKind,
  readNativeEnrollmentMode,
  readPeerLegacySettingsProtection,
  registerNativePoolHolder,
  resolveNativePoolPaths,
  resolveSettingsPaths,
  type SettingsPaths,
  setDumpEnabled,
  setLogLevel,
  startSettings,
  stateLayoutIoFailure,
  stateLayoutOfPaths,
  unmovedRegistrationPolicy,
} from '@cortexkit/anthropic-auth-core'
import {
  type PoolLoginMethod,
  type RegisterOpenCode2AuthMethodsOptions,
  registerOpenCode2AuthMethods,
} from '@cortexkit/common-auth/opencode2'
import type { Plugin } from '@opencode/plugin'
import type { Registration } from '@opencode/plugin/promise/registration'
import {
  CLAUDE_POOL_LOGIN_METHOD_ID,
  CLAUDE_POOL_LOGIN_METHOD_LABEL,
  CLAUDE_VAULT_ACTIVATION_METHOD_ID,
} from './activation'
import { stateRefusalFrom } from './adapter'
import { createNativeCacheKeep, type NativeCacheKeepOptions } from './cachekeep'
import { installNativeAnthropic } from './install'
import { startNativeAnthropicLifecycle } from './lifecycle'
import { createNativeMenuCapabilities } from './menu'
import { createNativeClaudeModelRules } from './models'
import { preparedAnthropicCredential } from './ownership'
import { createNativePrime } from './prime'
import { createReloadableRequestHooks } from './reload'
import { registerNativeMenu } from './rpc'
import { createNativeAnthropicSource, type NativeSource } from './source'
import { createNativeWirePolicy } from './wire'

export const ANTHROPIC_AUTH_PLUGIN_ID = 'cortexkit-anthropic-auth'

/**
 * The account source vault enrollment selects: 'local' serves accounts stored
 * in this machine's account pool, 'claustrum' serves accounts from the
 * Claustrum vault this OpenCode is enrolled in.
 */
export type NativeEnrollmentMode = 'local' | 'claustrum'

export interface AnthropicAuthV2Options {
  /**
   * Pool files to serve instead of the ones the layout decision picks; a
   * seam for tests. They must lie outside the state folder (see
   * `decideNativePaths`).
   */
  readonly paths?: NativePoolPaths
  readonly local?: NativeAccountRuntimeOptions['local']
  readonly vault?: NativeAccountRuntimeOptions['vault']
  readonly fetch?: typeof fetch
  readonly cacheKeep?: NativeCacheKeepOptions
}

/** The OAuth result a completed Claude Pro / Max sign-in hands to the pool. */
export interface ClaudeOAuthLogin {
  readonly access: string
  readonly refresh: string
  readonly expires: number
}

export const LOCAL_LOGIN_REFUSED_IN_VAULT =
  'This OpenCode is enrolled in the Claude vault and uses only vault accounts. Choose "Claude vault accounts" instead; no local account was changed.'
export const VAULT_ACTIVATION_REFUSED_LOCALLY =
  'This OpenCode is not enrolled in the Claude vault. Enroll it first, or sign in with Claude Pro / Max.'
export const ENROLLMENT_UNREADABLE =
  'The Claude vault enrollment could not be read; repair it and retry. Nothing was changed.'

export interface ClaudeLoginMethodsInput {
  readonly verifyVault?: () => Promise<unknown>
  /** False once setup is disposed; every step refuses after that. */
  readonly isActive: () => boolean
  readonly readMode: () => Promise<NativeEnrollmentMode>
  /** Verifies a completed sign-in's account and writes it to the local pool. */
  readonly runtime: Pick<NativeAccountRuntime, 'loginOAuth'>
  readonly authorize?: typeof authorize
  readonly exchange?: typeof exchange
}

/**
 * Builds the two login methods OpenCode 2 offers for the anthropic provider:
 * the Claude Pro / Max browser sign-in, which writes to the local account
 * pool, and vault activation, which writes nothing locally. Vault enrollment
 * alone decides which one works. When OpenCode is enrolled in the vault, the
 * browser sign-in refuses before it opens a browser and again before it
 * writes, and only vault activation succeeds. When it is not enrolled, vault
 * activation refuses. An enrollment that cannot be read refuses both, since
 * neither account source can then be shown to be the right one.
 */
export function claudeLoginMethods(
  input: ClaudeLoginMethodsInput,
): RegisterOpenCode2AuthMethodsOptions<ClaudeOAuthLogin> {
  const start = input.authorize ?? authorize
  const finish = input.exchange ?? exchange
  const ensureActive = () => {
    if (!input.isActive())
      throw new Error('Claude authentication setup is closed')
  }
  const mode = async () => {
    let current: NativeEnrollmentMode
    try {
      current = await input.readMode()
    } catch {
      throw new Error(ENROLLMENT_UNREADABLE)
    }
    ensureActive()
    return current
  }
  const requireLocal = async () => {
    if ((await mode()) !== 'local')
      throw new Error(LOCAL_LOGIN_REFUSED_IN_VAULT)
  }
  const loginMethods: PoolLoginMethod<ClaudeOAuthLogin>[] = [
    {
      method: {
        id: CLAUDE_POOL_LOGIN_METHOD_ID,
        type: 'oauth',
        label: CLAUDE_POOL_LOGIN_METHOD_LABEL,
      },
      async authorize() {
        ensureActive()
        await requireLocal()
        const auth = await start('max')
        ensureActive()
        return {
          mode: 'code',
          url: auth.url,
          instructions: 'Paste the authorization code returned by Claude.',
          callback: async (code) => {
            ensureActive()
            const result = await finish(
              code,
              auth.verifier,
              auth.redirectUri,
              auth.state,
            )
            if (!input.isActive() || result.type !== 'success')
              throw new Error('Claude sign-in did not complete')
            // Hand on only the token fields. The exchange result's own `type`
            // field ('success') would replace the stored credential's
            // `type: 'oauth'` when the pool copies these fields into it.
            return {
              access: result.access,
              refresh: result.refresh,
              expires: result.expires,
            }
          },
        }
      },
    },
  ]
  return {
    integrationID: 'anthropic',
    methods: loginMethods,
    vault: {
      method: {
        id: CLAUDE_VAULT_ACTIVATION_METHOD_ID,
        type: 'oauth',
        label: 'Claude vault accounts',
      },
      async activate() {
        ensureActive()
        if ((await mode()) !== 'claustrum')
          throw new Error(VAULT_ACTIVATION_REFUSED_LOCALLY)
        if (isVaultHosted()) {
          if (input.verifyVault) await input.verifyVault()
          else {
            try {
              const client = connectVaultHost('anthropic-auth')
              await Promise.resolve(client.close()).catch(() => undefined)
            } catch {
              throw new NativeCustodyError('unavailable')
            }
          }
          ensureActive()
          if ((await mode()) !== 'claustrum')
            throw new Error(VAULT_ACTIVATION_REFUSED_LOCALLY)
        }
      },
    },
    async onLogin(credential) {
      ensureActive()
      // Enrollment can change while the user is in the browser. Check it
      // again immediately before writing anything to the local pool.
      await requireLocal()
      await input.runtime.loginOAuth({
        routeId: 'main',
        credential,
        replace: true,
      })
      ensureActive()
    },
    label: 'Claude native account pool',
  }
}

/**
 * OpenCode's vault enrollment callbacks for the login methods and the
 * `claude` menu. Both use only the enrollment files that `env` names.
 * Disconnecting ends this OpenCode's vault enrollment and never reads or
 * changes OpenCode's own stored sign-ins.
 */
export function nativeEnrollmentCallbacks(env: NodeJS.ProcessEnv) {
  return {
    readMode: (): Promise<NativeEnrollmentMode> =>
      readNativeEnrollmentMode('opencode', env),
    disconnectVault: () =>
      disconnectNativeVaultForHost({ host: 'opencode', env }),
  }
}

export function createAnthropicAuthPlugin(
  options: AnthropicAuthV2Options = {},
): Plugin.Plugin {
  return {
    id: ANTHROPIC_AUTH_PLUGIN_ID,
    setup: (ctx) => setupAnthropicAuth(ctx, options),
  }
}

/**
 * The pool files this setup serves, and the registration that records its use
 * of them. Without injected paths, where the files are is decided once per
 * process before any is resolved: the config folder, or the state folder once
 * the state has moved there; the decision also registers this process. A
 * refusal is reported with its fixed text, which names no folder; the log
 * names them.
 *
 * `options.paths` is a seam for tests: OpenCode loads the plugin through
 * `server.ts`, which passes no options. Injected paths skip the decision, and
 * with it the holder-locked admission that checks the state folder's move
 * record, so they may name only files outside the state folder: paths in
 * the state-home layout, or in a folder anthropic-auth manages or a
 * destination-shaped one, refuse. Other injected paths are only registered.
 *
 * Whatever fails here, OpenCode 2 is handed fixed text that names no path
 * (see `startFailure`).
 */
async function decideNativePaths(options: AnthropicAuthV2Options): Promise<{
  paths: NativePoolPaths
  holderRegistration: NativeHolderRegistration | undefined
}> {
  try {
    return await decideNativePathsRaw(options)
  } catch (error) {
    throw startFailure(error)
  }
}

/**
 * What OpenCode 2 is handed when its start can't decide the pool files: the
 * relocation or registration refusal behind `error` with its fixed text, or
 * for any other error, such as a file system error whose message names a
 * path, a refusal with the fixed text of `io-failed`. OpenCode 2 may show a
 * plugin's setup error where its output is shared, so no raw message may
 * reach it; the plugin log keeps the original error.
 */
export function startFailure(error: unknown): Error {
  const refusal = stateRefusalFrom(error)
  if (refusal) return refusal
  const failure = stateLayoutIoFailure(
    'decide where its account state is',
    [],
    error,
  )
  logger.error('state-layout', failure.message, { code: failure.code })
  return stateRefusalFrom(failure) ?? failure
}

async function decideNativePathsRaw(options: AnthropicAuthV2Options): Promise<{
  paths: NativePoolPaths
  holderRegistration: NativeHolderRegistration | undefined
}> {
  if (options.paths) {
    const paths = options.paths
    await assertUnmanagedInjectedPaths(paths)
    return {
      paths,
      holderRegistration: await registerNativePoolHolder({
        paths,
        role: 'opencode2',
        kind: openCodeHolderKind(),
        policy: unmovedRegistrationPolicy(),
        onLockEvent: options.local?.onLockEvent,
      }),
    }
  }
  const decision = await decideOpenCodeStateLayoutOnce({
    role: 'opencode2',
    onLockEvent: options.local?.onLockEvent,
  })
  return {
    paths: await resolveNativePoolPaths(undefined, undefined, decision.layout),
    holderRegistration:
      decision.kind === 'state-home' ? undefined : decision.registration,
  }
}

/** Install request hooks before credential transfer to the shared pool finishes; requests must refuse until that transfer commits, never reuse old host tokens. */
export async function setupAnthropicAuth(
  ctx: Plugin.Context,
  options: AnthropicAuthV2Options = {},
): Promise<Plugin.Cleanup> {
  const { paths, holderRegistration } = await decideNativePaths(options)
  const env = {
    ...(options.vault?.env ?? process.env),
    ...(process.env.OPENCODE_ANTHROPIC_AUTH_LOG_LEVEL && {
      OPENCODE_ANTHROPIC_AUTH_LOG_LEVEL:
        process.env.OPENCODE_ANTHROPIC_AUTH_LOG_LEVEL,
    }),
  }
  // Injected account paths have the same separate-install rules as configured
  // paths. Never move a test or embedded host's private pool into the user file.
  const settingsEnv = options.paths
    ? {
        ...env,
        OPENCODE_ANTHROPIC_AUTH_FILE: paths.legacyConfig,
        OPENCODE_ANTHROPIC_AUTH_STATE_FILE: paths.legacyState,
      }
    : env
  // A failure to resolve the settings paths must not abort this start:
  // startSettings then resolves them itself and falls back as for any other
  // settings startup failure. Only fixed text is logged, since the error may
  // name a path.
  let settingsPaths: SettingsPaths | undefined
  try {
    settingsPaths = await resolveSettingsPaths('opencode', {
      env: settingsEnv,
    })
  } catch {
    logger.warn(
      'settings',
      'Settings file paths could not be resolved; settings startup falls back to the last applied protection settings.',
    )
  }
  let settingsTarget = settingsPaths?.target
  if (settingsTarget === undefined)
    try {
      settingsTarget = getSettingsFilePath({ env: settingsEnv })
    } catch {
      settingsTarget = ''
    }
  const requests = createReloadableRequestHooks(
    ctx,
    JSON.stringify([
      nativeVaultRuntimeKey({ ...options.vault, paths, host: 'opencode' }),
      settingsTarget,
    ]),
  )
  ctx = requests.context
  const runtimeOptions = {
    paths,
    host: 'opencode' as const,
    local: options.local,
    vault: { ...options.vault, env },
  }
  const withLegacy = async <T>(
    read: (runtime: NativeAccountRuntime) => Promise<T>,
  ) => {
    const legacy = createNativeAccountRuntime(runtimeOptions)
    try {
      return await read(legacy)
    } finally {
      await legacy.close()
    }
  }
  const settingsStartup = await startSettings({
    host: 'opencode',
    env: settingsEnv,
    paths: settingsPaths,
    ownPoolPaths: paths,
    initializeVaultSettings: () =>
      withLegacy(async (legacy) => {
        await legacy.vault.initializeSettings()
      }),
    fence: {
      // Choosing state-home already listed this process in its holder file.
      // The layout decision owns that registration, not this plugin, so
      // there is no plugin-owned registration to pass or release here.
      registration:
        holderRegistration ??
        (stateLayoutOfPaths(paths).kind === 'state-home'
          ? { status: 'registered' }
          : undefined),
    },
    protection: {
      readLegacyProtection: () =>
        withLegacy(async (legacy) => {
          // Recover from the local or vault account store selected by
          // enrollment, before applying any user-file settings to it.
          const snapshot = await legacy.read()
          return legacySettingsProtection(
            snapshot.settings,
            'opencode',
            snapshot.mode,
          )
        }),
      // Recreating a missing settings file needs Pi's own protection.
      readPeerLegacyProtection: (host) =>
        readPeerLegacySettingsProtection({ host, env: settingsEnv }),
    },
  })
  const settingsService = settingsStartup.service
  const runtime = acquireNativeAccountRuntime({
    ...runtimeOptions,
    settingsService,
    settingsFile: settingsStartup.file,
    settingsMode: () => settingsStartup.mode,
    settingsFallback: settingsStartup.fallback,
    settingsReopen: settingsStartup.reopen,
    settingsAuthority: { options: { env: settingsEnv } },
  })
  try {
    await runtime.prepareSettingsAction?.()
    runtime.applySettingsEffects?.()
  } catch {
    logger.warn(
      'settings',
      'Settings authority check failed; continuing with current settings.',
    )
  }
  // Use the same enrollment files the account runtime reads, so the login
  // methods, the menu and request serving always agree on the mode.
  const enrollment = nativeEnrollmentCallbacks(
    options.vault?.env ?? process.env,
  )
  // Read the current custody mode's settings before starting background work.
  // As in OpenCode 1, an environment override wins over the saved log level.
  try {
    const initial = await runtime.read()
    if (!process.env.OPENCODE_ANTHROPIC_AUTH_LOG_LEVEL)
      setLogLevel(getPersistedLogLevel(initial.policyStorage) ?? 'info')
    setDumpEnabled(isDumpPersistentlyEnabled(initial.policyStorage))
  } catch {}
  let active = true
  const wire = createNativeWirePolicy()
  const models = createNativeClaudeModelRules()
  let lifecycle: ReturnType<typeof startNativeAnthropicLifecycle> | undefined
  let prime: ReturnType<typeof createNativePrime> | undefined
  let cacheKeep: ReturnType<typeof createNativeCacheKeep> | undefined
  const parents = new Map<string, { value?: boolean }>()
  const subagent = (sessionID: string): boolean | undefined => {
    const cached = parents.get(sessionID)
    if (cached) return cached.value
    const entry: { value?: boolean } = {}
    parents.set(sessionID, entry)
    if (parents.size > 4096) {
      const oldest = parents.keys().next().value
      if (oldest !== undefined) parents.delete(oldest)
    }
    // Parent lookup is advisory at capture time, but must resolve before a
    // warm may spend. A failure is forgotten so the next warm can retry it.
    void Promise.resolve()
      .then(() =>
        ctx.session.get({
          sessionID: sessionID as Parameters<
            Plugin.Context['session']['get']
          >[0]['sessionID'],
        }),
      )
      .then((session) => {
        if (!active || parents.get(sessionID) !== entry) return
        entry.value = Boolean(session.parentID)
        return cacheKeep?.resolvedParent(sessionID, entry.value)
      })
      .catch(() => {
        if (parents.get(sessionID) === entry) parents.delete(sessionID)
      })
    return undefined
  }
  const source: NativeSource = createNativeAnthropicSource({
    runtime,
    paths,
    fetch: options.fetch,
    requestOptions: (input, snapshot) => {
      if (input.agent !== 'cachekeep' && input.agent !== 'prime')
        subagent(input.sessionID)
      return wire.requestOptions(input, snapshot)
    },
    responseOptions: wire.responseOptions,
    onRequestId: wire.onRequestId,
    onForgetSession: (sessionID) => {
      parents.delete(sessionID)
      wire.forgetSession(sessionID)
      cacheKeep?.forgetSession(sessionID)
    },
    onRequestPrepared: async (input) => {
      try {
        await cacheKeep?.track(input)
      } catch {
        logger.warn('cachekeep', 'live request tracking failed')
      }
    },
    onCacheResponse: (input) => {
      try {
        cacheKeep?.onResponseHeaders({
          ...input,
          status: input.acceptedAt === undefined ? 0 : 200,
        })
      } catch {
        logger.warn('cachekeep', 'live request tracking failed')
      }
    },
    onAttemptEnd: (input, outcome) => {
      if (outcome.status === undefined)
        cacheKeep?.discardAttempt(input.attemptId)
    },
    onCacheUsage: (sessionID, bodyText, usage) =>
      cacheKeep?.recordAcceptedUsage(sessionID, bodyText, usage),
    billingWarming: (input) => cacheKeep?.warming(input),
    resolveModelId: async (scope) => models.modelId(scope.modelID),
    onOwnedRequest: () => {
      lifecycle ??= startNativeAnthropicLifecycle(runtime, options.fetch)
      prime ??= createNativePrime({
        runtime,
        paths,
        source,
        fetch: options.fetch,
      })
    },
  })
  cacheKeep = createNativeCacheKeep({
    ...options.cacheKeep,
    runtime,
    source,
    storageId: paths.storageId,
    fetch: options.fetch,
    subagent,
  })
  await cacheKeep.ready.catch(async (error: unknown) => {
    requests.retire()
    holderRegistration?.close()
    await cacheKeep?.dispose()
    await source.close()
    await runtime.close()
    await settingsService?.dispose()
    throw error
  })
  const capabilities = createNativeMenuCapabilities({
    runtime,
    source,
    cacheKeepRegistry: cacheKeep.registry,
    start: async (sessionID, text) => {
      await ctx.session.synthetic({
        sessionID,
        text,
        description: 'Claude lane start',
        resume: true,
      })
    },
  })
  const registrations: Registration[] = []
  const installation = await installNativeAnthropic(
    ctx,
    {
      source,
      now: options.cacheKeep?.now,
      log: { warn: (message, data) => logger.warn('opencode2', message, data) },
    },
    { credential: preparedAnthropicCredential },
  ).catch(async (error: unknown) => {
    holderRegistration?.close()
    capabilities.close()
    await cacheKeep?.dispose()
    await Promise.all([source.close(), runtime.drainQuotaPublications()])
    await runtime.close()
    await settingsService?.dispose()
    throw error
  })
  let cleanup: Promise<void> | undefined
  const dispose = () => {
    if (cleanup) return cleanup
    active = false
    parents.clear()
    requests.retire()
    holderRegistration?.close()
    capabilities.close()
    source.close()
    cleanup = (async () => {
      await Promise.allSettled([
        installation.dispose(),
        lifecycle?.dispose(),
        prime?.dispose(),
        cacheKeep?.dispose(),
        ...registrations.map((registration) => registration.dispose()),
      ])
      // Prime and transport teardown can finish attempts after source shutdown
      // begins. Join their advisory usage writes before closing the runtime.
      await installation.drain()
      // Retiring this host can stop waiting for shared quota work, but only
      // the final runtime close may cancel its pending lock acquisitions.
      await Promise.all([source.close(), runtime.drainQuotaPublications()])
      await runtime.close()
      await settingsService?.dispose()
    })()
    return cleanup
  }
  try {
    registrations.push(await wire.install(ctx))
    registrations.push(await models.installProviderModels(ctx))
    registrations.push(await models.install(ctx))
    registrations.push(
      await registerOpenCode2AuthMethods(
        ctx,
        claudeLoginMethods({
          isActive: () => active,
          readMode: enrollment.readMode,
          verifyVault: () => runtime.vault.refresh(),
          runtime,
        }),
      ),
    )
    const ui: NativeUiOptions = {
      host: 'opencode',
      dispatch: capabilities.dispatch,
      readStatus: (command) => capabilities.readStatus(command),
      readAccounts: async () => {
        await runtime.prepareSettingsAction?.()
        return runtime.read()
      },
      readMode: enrollment.readMode,
      disconnectVault: enrollment.disconnectVault,
      interactive: true,
    }
    const command = createNativeUi(ui)
    registrations.push(await registerNativeMenu(ctx, command, capabilities))
    // Only a completed, explicit Claude-pool login selects the plugin's inert
    // OAuth connection. Startup never creates or replaces a host connection.
    requests.activate()
    return dispose
  } catch (error) {
    await dispose()
    throw error
  }
}
