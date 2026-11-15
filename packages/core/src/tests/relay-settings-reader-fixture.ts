import { mock } from 'bun:test'
import { join } from 'node:path'
import * as storeModule from '@cortexkit/common-auth/store'

const real = { ...storeModule }
const settingsPaths: string[] = []
let opens = 0

mock.module('@cortexkit/common-auth/store', () => ({
  ...real,
  openPoolStore: (options: storeModule.OpenPoolStoreOptions) => {
    opens++
    return real.openPoolStore(options)
  },
  readPoolSettingsAt: (configPath: string) => {
    settingsPaths.push(configPath)
    return real.readPoolSettingsAt(configPath)
  },
}))

// Keep the module mock in a child process so other tests retain the real store.
const { createNativeAccountRuntime } = await import(
  '../native-account-runtime.ts'
)
const { resolveNativePoolPaths } = await import('../pool-paths.ts')
const { TEST_RELAY_ACCOUNT_HOME_KEY } = await import('../relay-location.ts')
const [home, config, state] = process.argv.slice(2)
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
  await runtime.read()
  settingsPaths.length = 0
  const before = opens
  const relay = await runtime.getRelayConfig()
  console.log(JSON.stringify({ relay, settingsPaths, opens: opens - before }))
} finally {
  await runtime.close()
}
