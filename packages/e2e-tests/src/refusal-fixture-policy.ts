import { readFile, rename, writeFile } from 'node:fs/promises'
import {
  createNativeAccountRuntime,
  type NativePoolPaths,
  type OAuthQuotaSnapshot,
  type ProviderAccountUuid,
} from '@cortexkit/anthropic-auth-core'

export const replacementFixtureToken = 'sk-ant-oat01-fixture-replacement-only'

export function fixturePolicy(
  paths: NativePoolPaths,
  host: 'opencode' | 'pi',
  settingsPath: string,
) {
  async function usingRuntime<T>(
    fn: (runtime: ReturnType<typeof createNativeAccountRuntime>) => Promise<T>,
    replacementIdentity?: () => string | undefined,
  ) {
    const runtime = createNativeAccountRuntime({
      paths,
      host,
      settingsFile: settingsPath,
      local: {
        async refreshToken() {
          throw new Error('Unexpected fixture refresh')
        },
        async resolveIdentity(token) {
          const identity = replacementIdentity?.()
          if (token !== replacementFixtureToken || !identity)
            throw new Error('Unexpected fixture identity lookup')
          return {
            accountUuid: identity as ProviderAccountUuid,
            deviceId: 'fixture',
            sessionId: 'fixture',
          }
        },
      },
    })
    try {
      return await fn(runtime)
    } finally {
      await runtime.close()
    }
  }
  return {
    async settings(patch: Record<string, unknown>) {
      const current = JSON.parse(await readFile(settingsPath, 'utf8'))
      const next = `${settingsPath}.new`
      await writeFile(next, JSON.stringify({ ...current, ...patch }))
      await rename(next, settingsPath)
    },
    async quota(quota: OAuthQuotaSnapshot) {
      return usingRuntime(async (runtime) => {
        const admitted = await runtime.authorizeLocal('main', {
          intent: 'serve',
        })
        if (admitted.status !== 'usable')
          throw new Error(
            `Unexpected fixture authorization result: ${admitted.status}`,
          )
        if (
          !(await runtime.publishLocal(admitted.validation, {
            quota: {
              ...quota,
              accountIdentity: admitted.validation.binding.identity,
            },
          }))
        )
          throw new Error(
            'Synthetic quota was not published for the fixture account',
          )
      })
    },
    logout: () => usingRuntime((runtime) => runtime.remove('main')),
    relay: ({ url, token }: { url: string; token: string }) =>
      usingRuntime((runtime) =>
        runtime.updateRelay({
          enabled: true,
          url,
          token,
          transport: 'http',
          fallbackToDirect: false,
        }),
      ),
    replace() {
      let identity: string | undefined
      return usingRuntime(
        async (runtime) => {
          const old = await runtime.captureLocalSubject('main')
          identity = old.binding.identity
          if (!identity) throw new Error('Fixture account identity missing')
          await runtime.loginOAuth({
            routeId: 'main',
            accountIdentity: identity,
            replace: true,
            credential: {
              access: replacementFixtureToken,
              refresh: 'fixture-replacement-refresh',
              expires: Date.now() + 3600_000,
            },
          })
        },
        () => identity,
      )
    },
  }
}
