import { afterAll, afterEach } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveCustodyHandlesPath } from '@cortexkit/anthropic-auth-core'
import {
  assertLoopback,
  assertPreconnectUrl,
  fetchUrl,
} from './network-guard-utils'
import { DEFAULT_FETCH_MOCK } from './test-fetch'

const nativeFetch = globalThis.fetch
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
const CROSS_ORIGIN_CREDENTIAL_HEADERS = [
  'authorization',
  'proxy-authorization',
  'cookie',
  'x-api-key',
]
export const MAX_REDIRECTS = 20
type GuardRequest = InstanceType<typeof globalThis.Request>
type GuardRequestInit = NonNullable<
  ConstructorParameters<typeof globalThis.Request>[1]
>

function buildRedirectRequest(
  request: GuardRequest,
  url: URL,
  status: number,
): GuardRequest {
  const switchesToGet =
    (status === 301 || status === 302) &&
    !['GET', 'HEAD'].includes(request.method)
      ? true
      : status === 303 && !['GET', 'HEAD'].includes(request.method)
  const headers = new Headers(request.headers)
  if (new URL(request.url).origin !== url.origin) {
    for (const name of CROSS_ORIGIN_CREDENTIAL_HEADERS) headers.delete(name)
  }
  if (!switchesToGet) {
    return new globalThis.Request(url.toString(), {
      method: request.method,
      headers,
      body: request.body,
      redirect: 'manual',
      credentials: request.credentials,
      cache: request.cache,
      integrity: request.integrity,
      keepalive: request.keepalive,
      mode: request.mode,
      referrer: request.referrer,
      referrerPolicy: request.referrerPolicy,
      signal: request.signal,
    })
  }

  for (const name of [
    'content-encoding',
    'content-language',
    'content-location',
    'content-type',
    'content-length',
  ]) {
    headers.delete(name)
  }
  return new globalThis.Request(url.toString(), {
    method: 'GET',
    headers,
    redirect: 'manual',
    credentials: request.credentials,
    cache: request.cache,
    integrity: request.integrity,
    keepalive: request.keepalive,
    mode: request.mode,
    referrer: request.referrer,
    referrerPolicy: request.referrerPolicy,
    signal: request.signal,
  })
}

export function createGuardedFetch(
  nativeFetchImpl: typeof nativeFetch = nativeFetch,
) {
  return Object.assign(
    async (
      input: Parameters<typeof globalThis.fetch>[0],
      init?: Parameters<typeof globalThis.fetch>[1],
    ) => {
      if (!fetchUrl(input)) {
        throw new Error(
          'Blocked fetch with an unparseable URL; stub globalThis.fetch in the test',
        )
      }

      let request = new globalThis.Request(
        input as unknown as ConstructorParameters<typeof globalThis.Request>[0],
        { ...init, redirect: 'manual' } as GuardRequestInit,
      )
      for (let redirects = 0; ; redirects++) {
        assertLoopback(new URL(request.url))
        const replayableRequest = request.clone()
        const response = await Reflect.apply(nativeFetchImpl, globalThis, [
          request,
        ])
        if (!REDIRECT_STATUSES.has(response.status)) return response
        const location = response.headers.get('location')
        if (!location) return response
        await response.body?.cancel()
        if (redirects >= MAX_REDIRECTS) {
          throw new Error(`Too many redirects while fetching ${request.url}`)
        }

        let nextURL: URL
        try {
          nextURL = new URL(location, request.url)
        } catch {
          throw new Error(
            'Blocked redirect with an unparseable URL; stub globalThis.fetch in the test',
          )
        }
        request = buildRedirectRequest(
          replayableRequest as unknown as GuardRequest,
          nextURL,
          response.status,
        )
      }
    },
    {
      preconnect: (input: Parameters<typeof nativeFetch.preconnect>[0]) => {
        assertPreconnectUrl(input)
        // Preconnect is an advisory hint; an impl without it has nothing to do.
        // The loopback assertion above already enforced the safety property.
        if (typeof nativeFetchImpl.preconnect !== 'function') return
        return nativeFetchImpl.preconnect(input)
      },
    },
  )
}

const guardedFetch = createGuardedFetch()

afterEach(() => {
  // A destroyed global is itself a leak; read the tag only off a present value
  // so the report stays the named leak error rather than a raw TypeError.
  const currentFetch = globalThis.fetch as
    | (typeof fetch & { [DEFAULT_FETCH_MOCK]?: true })
    | undefined
  const isDefaultFetchMock = Boolean(currentFetch?.[DEFAULT_FETCH_MOCK])
  if (currentFetch !== guardedFetch && !isDefaultFetchMock) {
    globalThis.fetch = guardedFetch
    throw new Error(
      'fetch mock leaked past its owning test; Bun reports the offending test name above',
    )
  }
  if (isDefaultFetchMock) globalThis.fetch = guardedFetch
})

// Keep a data property so Bun's spyOn can replace fetch and tests can restore
// the captured guarded implementation afterward.
globalThis.fetch = guardedFetch

const testDir = mkdtempSync(join(tmpdir(), 'anthropic-auth-opencode-test-'))
const testManifestPath = join(testDir, 'handles.json')

afterAll(async () => {
  await rm(testDir, { recursive: true, force: true }).catch(() => {})
})

process.env.OPENCODE_ANTHROPIC_AUTH_TEST_DIR = testDir
process.env.CLAUSTRUM_OPENCODE_HANDLES = testManifestPath
const resolvedTestManifestPath = resolveCustodyHandlesPath(
  undefined,
  process.env,
)
const productionDefaultManifestPath = resolveCustodyHandlesPath(undefined, {
  ...process.env,
  CLAUSTRUM_OPENCODE_HANDLES: undefined,
})
if (
  resolvedTestManifestPath !== testManifestPath ||
  resolvedTestManifestPath === productionDefaultManifestPath
) {
  throw new Error('test manifest path escaped the isolated test directory')
}
process.env.OPENCODE_ANTHROPIC_AUTH_FILE = join(testDir, 'anthropic-auth.json')
process.env.OPENCODE_ANTHROPIC_AUTH_SIDEBAR_STATE_FILE = join(
  testDir,
  'sidebar-state.json',
)
process.env.OPENCODE_ANTHROPIC_AUTH_CACHEKEEP_REGISTRY_DIR = join(
  testDir,
  'cachekeep-registry',
)
process.env.OPENCODE_ANTHROPIC_AUTH_QUOTA_FEED_DIR = join(
  testDir,
  'quota-header-feed',
)
