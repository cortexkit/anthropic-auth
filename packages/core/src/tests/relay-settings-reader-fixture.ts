import { mock } from 'bun:test'
import { join } from 'node:path'
import { PrivateFileError } from '@cortexkit/common-auth/fs'
import * as storeModule from '@cortexkit/common-auth/store'

const real = { ...storeModule }
const settingsPaths: string[] = []
let opens = 0
let contended = false
let busy: PrivateFileError | undefined

mock.module('@cortexkit/common-auth/store', () => ({
  ...real,
  openPoolStore: (options: storeModule.OpenPoolStoreOptions) => {
    opens++
    const store = real.openPoolStore(options)
    return {
      ...store,
      read: async () =>
        contended
          ? {
              status: 'error',
              file: 'config',
              kind: 'snapshot-contended',
              reason: 'The account pool changed while it was being read',
              retryable: true,
            }
          : store.read(),
      readSettings: async () => {
        if (busy) throw busy
        return store.readSettings()
      },
    } satisfies storeModule.PoolStore
  },
  readPoolSettingsAt: async (configPath: string) => {
    settingsPaths.push(configPath)
    if (busy) throw busy
    return real.readPoolSettingsAt(configPath)
  },
}))

// Keep the module mock in a child process so other tests retain the real store.
const { createNativeAccountRuntime } = await import(
  '../native-account-runtime.ts'
)
const { resolveNativePoolPaths } = await import('../pool-paths.ts')
const { TEST_RELAY_ACCOUNT_HOME_KEY } = await import('../relay-location.ts')
const { isNativeTransientAccountError } = await import(
  '../native-transient-account.ts'
)
const { readNativeAccountsForRequest } = await import(
  '../native-vault-admission.ts'
)
const [home, config, state, mode] = process.argv.slice(2)
if (!home || !config || !state)
  throw new Error('expected home, config and state')
const paths = await resolveNativePoolPaths(config, state)
const hook = globalThis as Record<symbol, unknown>
hook[TEST_RELAY_ACCOUNT_HOME_KEY] = () => home
const runtime = createNativeAccountRuntime({
  paths,
  host: 'opencode',
  vault: {
    env: {
      OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE: join(
        home,
        'opencode-enrollment.json',
      ),
    },
  },
})
try {
  const initial = await runtime.read()
  if (mode === 'contention') {
    const failure = async (read: () => Promise<unknown>) => {
      try {
        await read()
        return 'unexpected-success'
      } catch (error) {
        if (isNativeTransientAccountError(error)) return error.code
        if (error === busy) return 'original-private-file-error'
        return String(error)
      }
    }
    contended = true
    const pool = await failure(() => readNativeAccountsForRequest(runtime))
    contended = false
    const settings = []
    const relay = []
    for (const win32Code of [32, 303, 5]) {
      busy = new PrivateFileError(paths.config, 'read', {
        reason: 'io-error',
        win32Code,
      })
      settings.push(await failure(() => runtime.read()))
      relay.push(await failure(() => runtime.getRelayConfig()))
    }
    console.log(
      JSON.stringify({
        pool,
        settings,
        relay,
        kept: runtime.peek?.() === initial,
      }),
    )
  } else {
    settingsPaths.length = 0
    const before = opens
    const relay = await runtime.getRelayConfig()
    console.log(JSON.stringify({ relay, settingsPaths, opens: opens - before }))
  }
} finally {
  await runtime.close()
}
