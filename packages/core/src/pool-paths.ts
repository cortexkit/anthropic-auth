import { createHash } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'

import { getAccountStatePath, getAccountStoragePath } from './accounts.ts'
import {
  LEGACY_STATE_LAYOUT,
  processStateLayout,
  type StateLayout,
  stateHomeDatasetFiles,
} from './state-layout-paths.ts'
import { getStickyRoutingStatePath } from './sticky-routing.ts'
import { windowsLongPath } from './windows-long-path.ts'

export interface NativePoolPaths {
  legacyConfig: string
  legacyState: string
  config: string
  state: string
  runtime: string
  journal: string
  roster: string
  storageId: string
}

/**
 * The layout `paths` were resolved in. In the legacy and explicit layouts the
 * runtime file sits beside the account state file; only the state-home layout
 * puts it in another folder, which is then the state-home folder.
 */
export function stateLayoutOfPaths(
  paths: Pick<NativePoolPaths, 'legacyState' | 'runtime'>,
): StateLayout {
  const dir = dirname(paths.runtime)
  return dir === dirname(paths.legacyState)
    ? LEGACY_STATE_LAYOUT
    : { kind: 'state-home', dir }
}

/** Local hosts share the native pool's routing file unless explicitly overridden. */
export function resolveLocalRoutingDestination(
  host: 'opencode' | 'pi',
  paths: NativePoolPaths,
  env: NodeJS.ProcessEnv,
): string {
  return (
    (host === 'opencode'
      ? env.OPENCODE_ANTHROPIC_AUTH_ROUTING_STATE_FILE
      : env.PI_ANTHROPIC_AUTH_ROUTING_STATE_FILE) ||
    getStickyRoutingStatePath(paths.config)
  )
}

/**
 * Resolve existing parent aliases and nonexistent leaves without creating files.
 * This can follow a leaf symlink, so it does not establish configured-leaf safety.
 * Source capture and recheck must retain the configured path for the lstat guard.
 */
export async function canonicalPath(path: string): Promise<string> {
  const absolute = resolve(path)
  try {
    return await realpath(windowsLongPath(absolute))
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !('code' in error) ||
      error.code !== 'ENOENT'
    ) {
      throw error
    }
  }
  const parent = dirname(absolute)
  if (parent === absolute) return absolute
  return join(await canonicalPath(parent), basename(absolute))
}

function sibling(
  path: string,
  legacyName: string,
  name: string,
  suffix: string,
): string {
  return basename(path) === legacyName
    ? join(dirname(path), name)
    : `${path}.${suffix}.json`
}

/**
 * Separate runtime authority from import inputs so a stale legacy writer cannot
 * rewrite a stamped credential. Both independently configured paths matter.
 *
 * `layout` places the pool state, runtime, journal and custody roster; the pool
 * config stays beside the account file in every layout. It defaults to this
 * process's layout decision, so a re-resolution matches the first resolution.
 * The storage id is always computed from the pool state's legacy-layout path,
 * so moving files between layouts never changes it.
 */
export async function resolveNativePoolPaths(
  legacyConfig = getAccountStoragePath(),
  legacyState = getAccountStatePath(legacyConfig),
  layout?: StateLayout,
): Promise<NativePoolPaths> {
  const [sourceConfig, sourceState] = await Promise.all([
    canonicalPath(legacyConfig),
    canonicalPath(legacyState),
  ])
  const chosen = layout ?? processStateLayout(sourceConfig)
  const config = await canonicalPath(
    sibling(
      sourceConfig,
      'anthropic-auth.json',
      'anthropic-auth-pool.json',
      'pool',
    ),
  )
  const legacyLayoutState = await canonicalPath(
    sibling(
      sourceState,
      'anthropic-auth-state.json',
      'anthropic-auth-pool-state.json',
      'pool',
    ),
  )
  let state = legacyLayoutState
  let runtime = await canonicalPath(
    sibling(
      sourceState,
      'anthropic-auth-state.json',
      'anthropic-auth-native-state.json',
      'native',
    ),
  )
  let journal = await canonicalPath(
    sibling(
      sourceState,
      'anthropic-auth-state.json',
      'anthropic-auth-migration.json',
      'migration',
    ),
  )
  let roster = await canonicalPath(
    sibling(
      sourceState,
      'anthropic-auth-state.json',
      'anthropic-auth-custody-roster.json',
      'roster',
    ),
  )
  if (chosen.kind === 'state-home') {
    const moved = stateHomeDatasetFiles(chosen, sourceConfig, sourceState)
    ;[state, runtime, journal, roster] = await Promise.all([
      canonicalPath(moved.localPoolState),
      canonicalPath(moved.localRuntime),
      canonicalPath(moved.journal),
      canonicalPath(moved.localRoster),
    ])
  }
  const paths = [
    sourceConfig,
    sourceState,
    config,
    state,
    runtime,
    journal,
    roster,
  ]
  if (new Set(paths).size !== paths.length) {
    throw new Error(
      'Anthropic account storage paths overlap; migration requires separate files',
    )
  }
  const storageId = createHash('sha256')
    .update(JSON.stringify(['anthropic', config, legacyLayoutState]))
    .digest('hex')
  return {
    legacyConfig: sourceConfig,
    legacyState: sourceState,
    config,
    state,
    runtime,
    journal,
    roster,
    storageId,
  }
}
