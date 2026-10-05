import { createHash } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'

import { getAccountStatePath, getAccountStoragePath } from './accounts.ts'

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

/** Resolve existing parent aliases without creating any migration files. */
async function canonicalPath(path: string): Promise<string> {
  const absolute = resolve(path)
  try {
    return await realpath(absolute)
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
 */
export async function resolveNativePoolPaths(
  legacyConfig = getAccountStoragePath(),
  legacyState = getAccountStatePath(legacyConfig),
): Promise<NativePoolPaths> {
  const [sourceConfig, sourceState] = await Promise.all([
    canonicalPath(legacyConfig),
    canonicalPath(legacyState),
  ])
  const config = await canonicalPath(
    sibling(
      sourceConfig,
      'anthropic-auth.json',
      'anthropic-auth-pool.json',
      'pool',
    ),
  )
  const state = await canonicalPath(
    sibling(
      sourceState,
      'anthropic-auth-state.json',
      'anthropic-auth-pool-state.json',
      'pool',
    ),
  )
  const runtime = await canonicalPath(
    sibling(
      sourceState,
      'anthropic-auth-state.json',
      'anthropic-auth-native-state.json',
      'native',
    ),
  )
  const journal = await canonicalPath(
    sibling(
      sourceState,
      'anthropic-auth-state.json',
      'anthropic-auth-migration.json',
      'migration',
    ),
  )
  const roster = await canonicalPath(
    sibling(
      sourceState,
      'anthropic-auth-state.json',
      'anthropic-auth-custody-roster.json',
      'roster',
    ),
  )
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
    .update(JSON.stringify(['anthropic', config, state]))
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
