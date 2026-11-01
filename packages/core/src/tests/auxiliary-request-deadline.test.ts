import { expect, spyOn, test } from 'bun:test'
import { fetchOAuthQuotaSnapshot } from '../accounts.ts'
import { refreshClaudeOAuthToken } from '../auth.ts'
import { fetchOAuthAccountProfile } from '../oauth-profile.ts'
import { AUXILIARY_REQUEST_TIMEOUT_MS } from '../request-abort.ts'

for (const phase of ['headers', 'body'] as const) {
  for (const kind of ['quota', 'profile', 'refresh'] as const) {
    test(`${kind} account check bounds its ${phase} wait independently of the caller`, async () => {
      const controller = new AbortController()
      const timeout = spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
        expect(ms).toBe(AUXILIARY_REQUEST_TIMEOUT_MS)
        expect(ms).toBeLessThanOrEqual(30_000)
        return controller.signal
      })
      let entered!: () => void
      const started = new Promise<void>((resolve) => {
        entered = resolve
      })
      let signal: AbortSignal | null | undefined
      const fetchImpl = Object.assign(
        async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
          signal = init?.signal
          entered()
          if (phase === 'headers') return new Promise<Response>(() => {})
          return new Response(new ReadableStream({}))
        },
        { preconnect: fetch.preconnect },
      )
      try {
        const pending =
          kind === 'quota'
            ? fetchOAuthQuotaSnapshot({
                accessToken: 'synthetic-access',
                fetchImpl,
              })
            : kind === 'profile'
              ? fetchOAuthAccountProfile({
                  accessToken: 'synthetic-access',
                  fetchImpl,
                })
              : refreshClaudeOAuthToken({
                  refreshToken: 'synthetic-refresh',
                  fetchImpl,
                })
        await started
        const reason = new DOMException(
          'account check timed out',
          'TimeoutError',
        )
        controller.abort(reason)
        await expect(pending).rejects.toBe(reason)
        expect(signal?.aborted).toBe(true)
      } finally {
        timeout.mockRestore()
      }
    })
  }
}
