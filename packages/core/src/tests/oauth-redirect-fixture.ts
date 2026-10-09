import { exchange, refreshClaudeOAuthToken } from '../auth.ts'
import { resolveClaudeCodeIdentity } from '../claude-code.ts'

const operation = process.argv[2]
const status = Number(process.argv[3])
if (!['refresh', 'exchange', 'bootstrap'].includes(operation ?? ''))
  throw new Error('Invalid fixture operation')
if (![200, 302, 307].includes(status)) throw new Error('Invalid fixture status')

let entries = 0
let redirected = 0
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch(request, activeServer): Response {
    if (new URL(request.url).pathname === '/redirected') {
      redirected++
      return Response.json({
        access_token: 'synthetic-redirect-access',
        refresh_token: 'synthetic-redirect-refresh',
        expires_in: 3600,
        oauth_account: { account_uuid: 'synthetic-redirect-account' },
      })
    }
    entries++
    if (status !== 200)
      return new Response(null, {
        status,
        headers: { location: new URL('/redirected', activeServer.url).href },
      })
    return Response.json({
      access_token: 'synthetic-access',
      refresh_token: 'synthetic-refresh',
      expires_in: 3600,
      oauth_account: { account_uuid: 'synthetic-account' },
    })
  },
})
const nativeFetch = globalThis.fetch
const localFetch: typeof fetch = Object.assign(
  async (
    _input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => nativeFetch(new URL('/entry', server.url), init),
  { preconnect: nativeFetch.preconnect },
)
// Only this disposable child replaces fetch. Native fetch still performs any
// redirect itself, so following one reaches the second server endpoint.
globalThis.fetch = localFetch
let accepted = false
try {
  if (operation === 'refresh') {
    const value = await refreshClaudeOAuthToken({
      refreshToken: 'synthetic-refresh',
      fetchImpl: localFetch,
      maxRetries: 0,
    })
    accepted = Boolean(value.access)
  } else if (operation === 'exchange') {
    accepted =
      (
        await exchange(
          'synthetic-code#synthetic-state',
          'synthetic-verifier',
          'https://example.invalid/callback',
          'synthetic-state',
        )
      ).type === 'success'
  } else {
    const identity = await resolveClaudeCodeIdentity(
      `sk-ant-oat-synthetic-${status}`,
      undefined,
      undefined,
    )
    accepted = Boolean(identity.accountUuid)
  }
} catch {
  accepted = false
} finally {
  globalThis.fetch = nativeFetch
  await server.stop(true)
}
console.log(
  JSON.stringify({ operation, status, accepted, entries, redirected }),
)
