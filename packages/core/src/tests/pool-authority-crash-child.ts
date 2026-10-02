import { join } from 'node:path'
import {
  advanceNativeMigration,
  beginNativeMigration,
  type NativeMigrationPhase,
} from '../pool-authority.ts'
import { resolveNativePoolPaths } from '../pool-paths.ts'

const root = process.argv[2]
const action = process.argv[3]
const point = process.argv[4]
if (!root || !action || (point !== 'before-write' && point !== 'after-write'))
  throw new Error('Invalid fixture arguments')
const paths = await resolveNativePoolPaths(
  join(root, 'anthropic-auth.json'),
  join(root, 'anthropic-auth-state.json'),
)
const hooks = {
  onWriteStep: async (step: 'before-write' | 'after-write') => {
    if (step === point) process.exit(19)
  },
}
if (action === 'building') {
  await beginNativeMigration(
    paths,
    {
      host: 'opencode',
      sources: {
        config: 'a'.repeat(64),
        state: 'b'.repeat(64),
        hostAuth: null,
      },
    },
    hooks,
  )
} else {
  const transitions = new Map<
    string,
    [NativeMigrationPhase, NativeMigrationPhase]
  >([
    ['verified', ['building', 'verified']],
    ['activation-installed', ['verified', 'activation-installed']],
    ['committed', ['activation-installed', 'committed']],
    ['retired', ['committed', 'retired']],
  ])
  const transition = transitions.get(action)
  if (!transition) throw new Error('Invalid fixture transition')
  await advanceNativeMigration(paths, transition[0], transition[1], hooks)
}
throw new Error('Expected fixture exit')
