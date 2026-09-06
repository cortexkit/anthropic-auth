import * as fs from 'node:fs/promises'
import { join } from 'node:path'
import {
  type AccountStorage,
  custodyCredentialId,
  custodyTombstoneOAuth,
  type OAuthAccount,
} from '@cortexkit/anthropic-auth-core'

export type CredentialCall = {
  method: string
  params: Record<string, unknown>
}

type RuledRowPlugin = {
  __claustrumCredentialCache: {
    get: (handle: string) => Promise<unknown>
    invalidate: (handle: string) => void
  }
  auth: {
    loader: (
      getAuth: () => Promise<never>,
      options: { models: Record<string, never> },
    ) => Promise<{
      fetch: (
        input: string | URL | Request,
        init?: RequestInit,
      ) => Promise<Response>
    }>
  }
  dispose?: () => Promise<void> | void
}

export const ruledMainHandle = `ckh_${'Z'.repeat(43)}`

export function credentialResponse(
  accessToken: string,
  recordVersion: number,
  expiresAtMs = Date.now() + 60_000,
  accountId?: string,
) {
  return {
    result: {
      payload: Array.from(
        new TextEncoder().encode(JSON.stringify({ access_token: accessToken })),
      ),
      expires_at_ms: expiresAtMs,
      record_version: recordVersion,
      ...(accountId && { account_id: accountId }),
    },
  }
}

export function connectorFor(
  calls: CredentialCall[],
  handler: (method: string, params: Record<string, unknown>) => unknown,
) {
  return async () =>
    ({
      call: async (_moduleId: string, method: string, params: unknown) => {
        const normalized = (params ?? {}) as Record<string, unknown>
        calls.push({ method, params: normalized })
        return handler(method, normalized)
      },
      close: () => {},
    }) as never
}

export function manifestConnector(
  calls: CredentialCall[],
  credentials: ReadonlyMap<string, string>,
) {
  return connectorFor(calls, (method, params) => {
    if (method !== 'credential.get') return { result: {} }
    return credentialResponse(
      credentials.get(String(params.handle)) ?? 'other',
      1,
    )
  })
}

export async function writeManifest(
  tempConfigDir: string,
  entries: Array<{ label: string; handle: string }>,
  serve = 'anthropic-auth',
) {
  const path = join(tempConfigDir, 'handles.json')
  await fs.writeFile(
    path,
    JSON.stringify({
      version: 1,
      providers: [
        {
          provider: 'anthropic',
          serve,
          accounts: entries.map(({ label, handle }) => ({
            label,
            handle,
            credential_id: custodyCredentialId(label),
          })),
        },
      ],
    }),
  )
  await fs.chmod(path, 0o600)
  await fs.lstat(path)
  process.env.CLAUSTRUM_OPENCODE_HANDLES = path
  return path
}

export async function bootRuledClaustrumRow({
  fallbacks,
  route,
  quota = { enabled: false, failClosedOnUnknownQuota: false },
  connector,
  onFetch,
  response,
  storageOverrides,
  initialNow,
  createFallbackStorage,
  useTempAccountFile,
  getPlugin,
  extractUrl,
  tempConfigDir,
}: {
  fallbacks: Array<{
    label: string
    handle: string
    access: string
    account?: Partial<OAuthAccount>
  }>
  route: 'fallback-first' | 'main-exhausted' | { sticky: string }
  quota?: AccountStorage['quota']
  connector?: (calls: CredentialCall[]) => () => Promise<unknown>
  onFetch?: (input: unknown, init?: RequestInit) => Response | Promise<Response>
  response?: Response | (() => Response)
  storageOverrides?: Omit<
    Partial<AccountStorage>,
    'accounts' | 'claustrum' | 'quota' | 'routing'
  >
  initialNow?: number
  createFallbackStorage: (storage: Partial<AccountStorage>) => AccountStorage
  useTempAccountFile: (storage: AccountStorage) => Promise<void>
  getPlugin: (runtimeOverrides: {
    claustrumNow: () => number
    claustrumConnector: () => Promise<unknown>
  }) => Promise<RuledRowPlugin>
  extractUrl: (input: string | URL | Request) => string
  tempConfigDir: () => string
}) {
  let now = initialNow ?? Date.now()
  const calls: CredentialCall[] = []
  const authorizations: string[] = []
  const routing: AccountStorage['routing'] =
    route === 'fallback-first'
      ? { mode: 'fallback-first' }
      : route === 'main-exhausted'
        ? { mode: 'main-first' }
        : { mode: 'sticky-balanced' }
  await useTempAccountFile(
    createFallbackStorage({
      ...storageOverrides,
      main: {
        ...custodyTombstoneOAuth('anthropic'),
        claustrumHandle: ruledMainHandle,
      },
      claustrum: { mode: 'claustrum' },
      routing,
      quota,
      accounts: fallbacks.map((fallback, index) => ({
        id: fallback.account?.id ?? `fallback-${index + 1}`,
        label: fallback.label,
        ...custodyTombstoneOAuth('anthropic'),
        quota: {
          checkedAt: Date.now(),
          five_hour: {
            usedPercent: 10,
            remainingPercent: 90,
            checkedAt: Date.now(),
          },
          seven_day: {
            usedPercent: 10,
            remainingPercent: 90,
            checkedAt: Date.now(),
          },
        },
        ...fallback.account,
      })) as OAuthAccount[],
    }),
  )
  const manifestPath = await writeManifest(tempConfigDir(), [
    { label: 'main', handle: ruledMainHandle },
    ...fallbacks.map(({ label, handle }) => ({ label, handle })),
  ])
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    if (extractUrl(input as string | URL | Request).includes('/v1/messages')) {
      authorizations.push(new Headers(init?.headers).get('authorization') ?? '')
    }
    return (
      (await onFetch?.(input, init)) ??
      (typeof response === 'function'
        ? response()
        : (response?.clone() ?? new Response('{}', { status: 200 })))
    )
  }) as typeof fetch
  const plugin = await getPlugin({
    claustrumNow: () => now,
    claustrumConnector:
      connector?.(calls) ??
      manifestConnector(
        calls,
        new Map([
          [ruledMainHandle, 'vault-main-access'],
          ...fallbacks.map(({ handle, access }) => [handle, access] as const),
        ]),
      ),
  })
  await plugin.__claustrumCredentialCache.get(ruledMainHandle)
  await plugin.auth.loader(
    () =>
      Promise.resolve({
        type: 'oauth' as const,
        access: 'bootstrap-main-access',
        refresh: 'bootstrap-main-refresh',
        expires: Date.now() + 5 * 60 * 60 * 1_000,
      }),
    { models: {} },
  )
  const load = () =>
    plugin.auth.loader(
      () => Promise.resolve(custodyTombstoneOAuth('anthropic') as never),
      { models: {} },
    )
  const result = await load()
  return {
    authorizations,
    calls,
    manifestPath,
    plugin,
    result,
    setNow(value: number) {
      now = value
    },
  }
}
