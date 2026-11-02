import {
  acquireNativeAccountRuntime,
  assertUnmanagedInjectedPaths,
  authorize,
  createNativeUi,
  decideOpenCodeStateLayoutOnce,
  disconnectNativeVaultForHost,
  exchange,
  getPersistedLogLevel,
  isDumpPersistentlyEnabled,
  logger,
  type NativeAccountRuntime,
  type NativeAccountRuntimeOptions,
  type NativeHolderRegistration,
  type NativePoolPaths,
  type NativeUiOptions,
  openCodeHolderKind,
  readNativeEnrollmentMode,
  registerNativePoolHolder,
  resolveNativePoolPaths,
  setDumpEnabled,
  setLogLevel,
  stateLayoutIoFailure,
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
  const runtime = acquireNativeAccountRuntime({
    paths,
    host: 'opencode',
    local: options.local,
    vault: options.vault,
  })
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
  const source: NativeSource = createNativeAnthropicSource({
    runtime,
    paths,
    fetch: options.fetch,
    requestOptions: wire.requestOptions,
    responseOptions: wire.responseOptions,
    onRequestId: wire.onRequestId,
    onForgetSession: (sessionID) => {
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
    onResponseHeaders: (input) => {
      try {
        cacheKeep?.onResponseHeaders(input)
      } catch {
        logger.warn('cachekeep', 'live request tracking failed')
      }
    },
    onAttemptEnd: (input) => cacheKeep?.discardAttempt(input.attemptId),
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
    isSubagent: async (sessionID) =>
      Boolean(
        (
          await ctx.session.get({
            sessionID: sessionID as Parameters<
              Plugin.Context['session']['get']
            >[0]['sessionID'],
          })
        ).parentID,
      ),
  })
  await cacheKeep.ready
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
      log: { warn: (message, data) => logger.warn('opencode2', message, data) },
    },
    { credential: preparedAnthropicCredential },
  ).catch(async (error: unknown) => {
    holderRegistration?.close()
    capabilities.close()
    await cacheKeep?.dispose()
    await source.close()
    await runtime.drainQuotaPublications()
    await runtime.close()
    throw error
  })
  let cleanup: Promise<void> | undefined
  const dispose = () => {
    if (cleanup) return cleanup
    active = false
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
      await source.close()
      // A quota reading taken by a request or poll is written after the
      // reading returns. Closing the runtime first would refuse that write and
      // lose the reading, so wait for it as OpenCode 1 and Pi do on close. Each
      // write stops waiting for its file lock after a fixed timeout, so this
      // wait is bounded.
      await runtime.drainQuotaPublications()
      await runtime.close()
    })()
    return cleanup
  }
  try {
    registrations.push(await wire.install(ctx))
    registrations.push(await models.install(ctx))
    registrations.push(
      await registerOpenCode2AuthMethods(
        ctx,
        claudeLoginMethods({
          isActive: () => active,
          readMode: enrollment.readMode,
          runtime,
        }),
      ),
    )
    const ui: NativeUiOptions = {
      host: 'opencode',
      dispatch: capabilities.dispatch,
      readStatus: (command) => capabilities.readStatus(command),
      readAccounts: () => runtime.read(),
      readMode: enrollment.readMode,
      disconnectVault: enrollment.disconnectVault,
      interactive: true,
    }
    const command = createNativeUi(ui)
    registrations.push(await registerNativeMenu(ctx, command, capabilities))
    // Only a completed, explicit Claude-pool login selects the plugin's inert
    // OAuth connection. Startup never creates or replaces a host connection.
    return dispose
  } catch (error) {
    await dispose()
    throw error
  }
}
