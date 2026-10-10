import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import {
  type AccountStorage,
  createNativeAccountRuntime,
  createNativePoolStore,
  getClaudeCodeIdentityForVerifiedAccount,
  type NativeAccountMetadataPatch,
  type NativeAccountRuntime,
  type NativePoolPaths,
  type ProviderAccountUuid,
  readNativeMigrationJournal,
  resolveNativePoolPaths,
  runNativeMigration,
} from '@cortexkit/anthropic-auth-core'
import { nativeQuotaCodec } from '../../../core/src/native-quota-codec.ts'
import { updateNativeRuntime } from '../../../core/src/native-runtime.ts'
import { getPiAccountStoragePath } from '../paths.ts'

export function fixtureAccountIdentity(id: string): ProviderAccountUuid {
  const digest = createHash('sha256')
    .update(`pi-native-fixture:${id}`)
    .digest('hex')
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20, 32)}` as ProviderAccountUuid
}

export async function initializeNativePiFixture(
  paths: NativePoolPaths,
): Promise<void> {
  if (await readNativeMigrationJournal(paths)) return
  // Run the real offline migration on this empty disposable installation
  // before adding accounts; do not fabricate an authorized journal.
  let processFenceChecks = 0
  await runNativeMigration({
    paths,
    host: 'pi',
    hostAuthPath: join(dirname(paths.config), 'auth.json'),
    routingSourcePath: join(dirname(paths.config), 'legacy-routing.json'),
    routingDestinationPath:
      process.env.PI_ANTHROPIC_AUTH_ROUTING_STATE_FILE ??
      join(dirname(paths.config), 'native-routing.json'),
    env: {},
    removePiAnthropicAuth: false,
    // These unit fixtures never start a host process. Count each stopped-host
    // check so omitting the check fails the fixture.
    processFence: async () => {
      processFenceChecks++
    },
  })
  if (processFenceChecks === 0)
    throw new Error('Fixture migration did not check its process fence')
}

export async function saveNativePiFixture(
  storage: AccountStorage,
  storagePath = getPiAccountStoragePath(),
  options: { primary?: boolean; mainAccess?: string } = {},
): Promise<void> {
  process.env.PI_CODING_AGENT_DIR = dirname(storagePath)
  // Core reads OPENCODE_ANTHROPIC_AUTH_STATE_FILE even in Pi. Bind it to this fixture’s isolated state file instead of inheriting another suite’s path.
  process.env.OPENCODE_ANTHROPIC_AUTH_STATE_FILE = join(
    dirname(storagePath),
    'anthropic-auth-state.json',
  )
  const paths = await resolveNativePoolPaths(storagePath)
  await initializeNativePiFixture(paths)
  const store = createNativePoolStore({ paths, quota: nativeQuotaCodec })
  await store.initialize()
  const identityByToken = new Map<string, ProviderAccountUuid>()
  const runtime = createNativeAccountRuntime({
    paths,
    host: 'pi',
    local: {
      resolveIdentity: async (token, _model, routeId) => {
        const uuid = identityByToken.get(token)
        if (!uuid) throw new Error('Fixture identity lookup has no token')
        return getClaudeCodeIdentityForVerifiedAccount(routeId ?? 'main', uuid)
      },
    },
  })
  const publish = async (id: string, metadata: NativeAccountMetadataPatch) => {
    const admitted = await runtime.authorizeLocal(id)
    if (admitted.status !== 'usable')
      throw new Error(
        `Fixture credential was not admitted: ${admitted.status}${admitted.status === 'refused' ? ` (${admitted.reason})` : admitted.status === 'failed' ? ` (${admitted.failure.kind}, ${admitted.failure.classification}, reconciliation=${admitted.reconciliationFailed})` : ''}`,
      )
    const accountIdentity = admitted.binding.identity
    if (!accountIdentity)
      throw new Error('Fixture admission has no account identity')
    const patch: NativeAccountMetadataPatch = {
      ...(metadata.quota !== undefined && {
        quota: { ...metadata.quota, accountIdentity },
      }),
      ...(metadata.profile !== undefined && { profile: metadata.profile }),
      ...(metadata.prime !== undefined && { prime: metadata.prime }),
      ...(metadata.lastQuotaRefreshError !== undefined && {
        lastQuotaRefreshError: metadata.lastQuotaRefreshError,
      }),
      ...(metadata.quotaErrorClearedAt !== undefined && {
        quotaErrorClearedAt: metadata.quotaErrorClearedAt,
      }),
      ...(metadata.quotaErrorGeneration !== undefined && {
        quotaErrorGeneration: metadata.quotaErrorGeneration,
      }),
    }
    // Publish quota and errors for the account and credential version returned by the identity lookup.
    await runtime.publishLocal(admitted.subject, patch)
  }
  try {
    const {
      version: _version,
      accounts,
      main,
      quota,
      refresh,
      prime,
      relay,
      ...settings
    } = storage
    await store.updateSettings((current) => ({
      ...current,
      ...settings,
      ...(quota && {
        quota: {
          enabled: quota.enabled,
          checkIntervalMinutes: quota.checkIntervalMinutes,
          refreshEveryNRequests: quota.refreshEveryNRequests,
          minimumRemaining: quota.minimumRemaining,
          failClosedOnUnknownQuota: quota.failClosedOnUnknownQuota,
        },
      }),
      ...(refresh && {
        refresh: {
          enabled: refresh.enabled,
          intervalMinutes: refresh.intervalMinutes,
          refreshBeforeExpiryMinutes: refresh.refreshBeforeExpiryMinutes,
        },
      }),
      ...(prime && { prime: { enabled: prime.enabled } }),
    }))
    if (relay) await runtime.updateRelay(relay)
    if (options.primary !== false) {
      const access = options.mainAccess ?? 'main-access'
      identityByToken.set(access, fixtureAccountIdentity('main'))
      await runtime.loginOAuth({
        routeId: 'main',
        accountIdentity: fixtureAccountIdentity('main'),
        replace: (await runtime.read()).accounts.some(
          (account) => account.id === 'main',
        ),
        credential: {
          access,
          refresh: 'synthetic-native-main-refresh',
          expires: Date.now() + 3_600_000,
        },
      })
      await publish('main', {
        quota: quota?.mainQuota,
        profile: main?.profile,
        prime: prime?.main,
        ...(quota?.mainLastQuotaApiError && {
          lastQuotaRefreshError: {
            ...quota.mainLastQuotaApiError,
            accountIdentity: fixtureAccountIdentity('main'),
          },
        }),
        quotaErrorClearedAt: quota?.mainQuotaErrorClearedAt,
        quotaErrorGeneration: quota?.mainQuotaErrorGeneration,
      })
      if (refresh?.mainLastRefreshError) {
        const refreshError = refresh.mainLastRefreshError
        const subject = await runtime.captureLocalSubject('main')
        await updateNativeRuntime(paths.runtime, paths.storageId, (state) => ({
          ...state,
          accounts: {
            ...state.accounts,
            [subject.binding.rowId]: {
              ...state.accounts[subject.binding.rowId],
              binding: subject.binding,
              lastRefreshError: {
                ...refreshError,
                credentialFingerprint: subject.credentialFingerprint,
              },
            },
          },
        }))
      }
    }
    for (const account of accounts) {
      if (account.type === 'api') {
        await runtime.addApi({
          routeId: account.id,
          apiKey: account.apiKey ?? 'synthetic-api-key',
          baseURL: account.baseURL,
          authHeader: account.authHeader,
          label: account.label,
          replace: (await runtime.read()).accounts.some(
            (current) => current.id === account.id,
          ),
        })
      } else {
        const access = account.access ?? `synthetic-${account.id}-access`
        identityByToken.set(access, fixtureAccountIdentity(account.id))
        await runtime.loginOAuth({
          routeId: account.id,
          accountIdentity: fixtureAccountIdentity(account.id),
          replace: (await runtime.read()).accounts.some(
            (current) => current.id === account.id,
          ),
          label: account.label,
          credential: {
            access,
            refresh: account.refresh,
            expires: account.expires ?? Date.now() + 3_600_000,
          },
        })
        await publish(account.id, {
          quota: account.quota,
          profile: account.profile,
          prime: account.prime,
        })
      }
      if (account.enabled === false) await runtime.setEnabled(account.id, false)
    }
  } finally {
    runtime.close()
  }
}

export async function readNativePiFixture(
  storagePath = getPiAccountStoragePath(),
): Promise<AccountStorage> {
  const runtime: NativeAccountRuntime = createNativeAccountRuntime({
    paths: await resolveNativePoolPaths(storagePath),
    host: 'pi',
  })
  try {
    return (await runtime.read()).policyStorage
  } finally {
    runtime.close()
  }
}

/** Change only the fixture’s local or Claustrum mode; the live menu does not offer this operation. */
export async function setNativePiFixtureMode(
  storagePath: string,
  mode: 'local' | 'claustrum',
  primary?: { routeId: string; credentialId: string; accountIdentity: string },
): Promise<void> {
  const store = createNativePoolStore({
    paths: await resolveNativePoolPaths(storagePath),
    quota: nativeQuotaCodec,
  })
  await store.updateSettings((settings) => ({
    ...settings,
    ...(primary && { mainAccountId: primary.routeId }),
    claustrum: {
      mode,
      ...(primary && {
        primaryAccount: {
          credentialId: primary.credentialId,
          accountId: primary.accountIdentity,
        },
      }),
    },
  }))
}
