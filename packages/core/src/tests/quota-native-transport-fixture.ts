import { join } from 'node:path'

const root = process.argv[2]
const scenario = process.argv[3]
if (!root || !['main', 'fallback', 'missing'].includes(scenario ?? ''))
  throw new Error('Invalid fixture input')
process.env.TMPDIR = root
process.env.HOME = root
process.env.USERPROFILE = root
process.env.OPENCODE_CONFIG_DIR = root
process.env.OPENCODE_ANTHROPIC_AUTH_FILE = join(root, 'accounts.json')
const { QuotaManager } = await import('../quota-manager.ts')
const calls: unknown[] = []
const manager = new QuotaManager({
  storage: { version: 1, accounts: [] },
  ...(scenario !== 'missing' && {
    fetchQuotaSnapshot: async (request: {
      kind: 'main' | 'fallback'
      accountId: string | undefined
      accessToken: string
    }) => {
      calls.push(request)
      return {
        accountIdentity: request.accountId,
        checkedAt: Date.now(),
        scoped: [],
      }
    },
  }),
  fetchImpl: Object.assign(
    async () => {
      throw new Error('Direct token-based transport must not run')
    },
    { preconnect: fetch.preconnect },
  ),
})
let fetched = false
try {
  const result =
    scenario === 'fallback'
      ? await manager.refreshFallbackWithMetadata(
          'synthetic-fallback',
          '',
          undefined,
        )
      : await manager.refreshMainWithMetadata('synthetic-main', '')
  fetched = result.fetched
} catch {
  fetched = false
}
console.log(
  JSON.stringify({
    fetched,
    calls,
    tokenless: manager.canFetchWithoutAccessToken(),
  }),
)
