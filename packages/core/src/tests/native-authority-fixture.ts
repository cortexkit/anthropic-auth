import { dirname, join } from 'node:path'
import { runNativeMigration } from '../native-migration.ts'
import type { NativePoolPaths } from '../pool-paths.ts'

/** Commit an empty disposable pool through the real offline migration controller. */
export async function initializeNativeTestAuthority(
  paths: NativePoolPaths,
  host: 'opencode' | 'pi' = 'opencode',
): Promise<void> {
  const root = dirname(paths.journal)
  await runNativeMigration({
    paths,
    host,
    hostAuthPath: join(root, 'host-auth'),
    routingSourcePath: join(root, 'old-routing'),
    routingDestinationPath: join(root, 'routing'),
    env: {},
    processFence: async () => {},
  })
}
