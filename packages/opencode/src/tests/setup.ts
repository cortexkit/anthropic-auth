import { afterEach, beforeEach } from 'bun:test'
import {
  assertLoopback,
  assertPreconnectUrl,
  fetchUrl,
} from './network-guard-utils'
import { restoreTestSafetyPaths } from './preload-sandbox'
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
          // Bun's connection-pool opt-out is a fetch option, not a Request
          // property. Preserve it when rebuilding requests, including redirects.
          { keepalive: init?.keepalive },
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
const nativeDateNow = Date.now

function isDefaultFetchMock(value: typeof fetch | undefined): boolean {
  return Boolean(
    (value as (typeof fetch & { [DEFAULT_FETCH_MOCK]?: true }) | undefined)?.[
      DEFAULT_FETCH_MOCK
    ],
  )
}

// Once an afterEach hook times out, Bun skips every later afterEach hook for
// that test, including the leak check below. Check again before each test
// starts: restore any leaked fetch mock (and, at a file boundary, a leaked
// fake clock) and fail this test, so the leak stops at the next test boundary
// instead of running on through later files. This cannot undo a change that a
// timed-out body, which Bun does not cancel, makes after this check; the
// owning test must cancel such a body itself.
let currentTestFile: string | undefined
beforeEach(() => {
  const previousTestFile = currentTestFile
  currentTestFile = Bun.main
  const leaked: string[] = []
  const currentFetch = globalThis.fetch as typeof fetch | undefined
  if (isDefaultFetchMock(currentFetch)) globalThis.fetch = guardedFetch
  else if (currentFetch !== guardedFetch) {
    globalThis.fetch = guardedFetch
    leaked.push('a fetch mock')
  }
  // Some files keep a fake clock between their own tests and reset it in
  // their own beforeEach, so a fake clock is only a leak once the file
  // that installed it has finished.
  if (
    previousTestFile !== undefined &&
    previousTestFile !== currentTestFile &&
    Date.now !== nativeDateNow
  ) {
    Date.now = nativeDateNow
    leaked.push(`a fake Date.now from ${previousTestFile}`)
  }
  if (leaked.length)
    throw new Error(
      `${leaked.join(' and ')} outlived an earlier test whose teardown did not finish; restored before this test ran`,
    )
})

afterEach(() => {
  // A destroyed global is itself a leak; read the tag only off a present value
  // so the report stays the named leak error rather than a raw TypeError.
  const currentFetch = globalThis.fetch as typeof fetch | undefined
  const defaultFetchMock = isDefaultFetchMock(currentFetch)
  if (currentFetch !== guardedFetch && !defaultFetchMock) {
    globalThis.fetch = guardedFetch
    throw new Error(
      'fetch mock leaked past its owning test; Bun reports the offending test name above',
    )
  }
  if (defaultFetchMock) globalThis.fetch = guardedFetch
})

// Keep a data property so Bun's spyOn can replace fetch and tests can restore
// the captured guarded implementation afterward.
globalThis.fetch = guardedFetch

beforeEach(async () => {
  delete process.env.CORTEXKIT_VAULT_HOST
  restoreTestSafetyPaths()
  const core = await import('@cortexkit/anthropic-auth-core')
  core.resetVaultHostAuthorityForTests?.()
  const source = await import('../../../core/src/native-vault-host.ts')
  source.resetVaultHostAuthorityForTests?.()
})
afterEach(restoreTestSafetyPaths)
// User-level Anthropic overrides are valid runtime configuration, but they make
// request-transform tests depend on the developer machine. Tests set these
// explicitly when they exercise override behavior.
for (const key of Object.keys(process.env)) {
  if (key.startsWith('ANTHROPIC_')) delete process.env[key]
}
