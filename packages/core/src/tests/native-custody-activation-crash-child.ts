/**
 * Child process for real crash proofs of the vault activation controller.
 * argv: <native config path> <native state path> <host> <inventory JSON>
 *       <step kind: step|store> <point>
 * Exits with 19 at the named point, leaving its leases and files exactly as a
 * killed setup process would. Uses synthetic files and inventory only.
 */
import { resolveNativePoolPaths } from '../pool-paths.ts'

const [configPath, statePath, host, inventoryJson, kind, point] =
  process.argv.slice(2)
if (
  !configPath ||
  !statePath ||
  (host !== 'opencode' && host !== 'pi') ||
  !inventoryJson ||
  (kind !== 'step' && kind !== 'store') ||
  !point
)
  throw new Error('Invalid activation crash fixture arguments')

const { runNativeCustodyActivation } = await import(
  '../native-custody-activation.ts'
)
const paths = await resolveNativePoolPaths(configPath, statePath)
const inventory = JSON.parse(inventoryJson)
await runNativeCustodyActivation(
  {
    paths,
    host,
    env: {},
    processFence: async () => {},
    removePiAnthropicAuth: true,
    discover: async () => inventory,
  },
  {
    onStep: async (step) => {
      if (kind === 'step' && step === point) process.exit(19)
    },
    store: {
      // `store` points are `<write step>:<operation>`, e.g. the gap between a
      // removal's config write and its state write.
      onStep: async (step, info) => {
        if (kind === 'store' && `${step}:${info.operation}` === point)
          process.exit(19)
      },
    },
  },
)
throw new Error('Expected activation crash fixture exit')
