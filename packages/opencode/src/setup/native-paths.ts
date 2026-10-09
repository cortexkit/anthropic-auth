import { dirname, join, resolve } from 'node:path'
import {
  ACCOUNT_FILE_NAME,
  ACCOUNT_STATE_FILE_NAME,
  canonicalPath,
  getStickyRoutingStatePath,
  type NativePoolPaths,
  resolveNativePoolPaths,
} from '@cortexkit/anthropic-auth-core'

import {
  getOpenCodeAuthPath,
  getOpenCodeConfigDir,
  getPiAgentDir,
  getPiAuthPath,
} from './paths.ts'
import type { HarnessKind } from './types.ts'

export interface NativeSetupPaths {
  host: HarnessKind
  paths: NativePoolPaths
  legacyConfigPath: string
  legacyStatePath: string
  hostAuthPath: string
  routingSourcePath: string
  routingDestinationPath: string
}

/** Resolve actor-supplied environment without changing ambient process variables. */
export async function resolveNativeSetupPaths(
  host: HarnessKind,
  env: NodeJS.ProcessEnv,
): Promise<NativeSetupPaths> {
  const directory =
    host === 'pi' ? getPiAgentDir(env) : getOpenCodeConfigDir(env)
  const configured =
    host === 'pi'
      ? env.PI_ANTHROPIC_AUTH_FILE?.trim()
      : env.OPENCODE_ANTHROPIC_AUTH_FILE?.trim()
  const legacyConfigPath = resolve(
    configured || join(directory, ACCOUNT_FILE_NAME),
  )
  // Pi also stored credentials at OPENCODE_ANTHROPIC_AUTH_STATE_FILE when set.
  // Read that source during migration rather than assuming a sibling file.
  const legacyStatePath = resolve(
    env.OPENCODE_ANTHROPIC_AUTH_STATE_FILE?.trim() ||
      (legacyConfigPath.endsWith(ACCOUNT_FILE_NAME)
        ? join(dirname(legacyConfigPath), ACCOUNT_STATE_FILE_NAME)
        : `${legacyConfigPath}.state.json`),
  )
  const paths = await resolveNativePoolPaths(legacyConfigPath, legacyStatePath)
  const routingOverride =
    host === 'pi'
      ? env.PI_ANTHROPIC_AUTH_ROUTING_STATE_FILE?.trim()
      : env.OPENCODE_ANTHROPIC_AUTH_ROUTING_STATE_FILE?.trim()
  return {
    host,
    paths,
    legacyConfigPath,
    legacyStatePath,
    hostAuthPath: host === 'pi' ? getPiAuthPath(env) : getOpenCodeAuthPath(env),
    routingSourcePath: resolve(
      routingOverride || getStickyRoutingStatePath(legacyConfigPath),
    ),
    routingDestinationPath: resolve(
      routingOverride || getStickyRoutingStatePath(paths.config),
    ),
  }
}

/** Reject plans where OpenCode and Pi share credential, journal or routing files. */
export async function requireDisjointNativeSetupPaths(
  plans: readonly NativeSetupPaths[],
): Promise<void> {
  const owners = new Map<string, HarnessKind>()
  for (const plan of plans) {
    for (const path of [
      plan.paths.legacyConfig,
      plan.paths.legacyState,
      plan.paths.config,
      plan.paths.state,
      plan.paths.runtime,
      plan.paths.roster,
      plan.paths.journal,
      plan.hostAuthPath,
      plan.routingSourcePath,
      plan.routingDestinationPath,
    ]) {
      const canonical = await canonicalPath(path)
      const owner = owners.get(canonical)
      if (owner !== undefined && owner !== plan.host)
        throw new Error(
          'Native setup storage paths overlap between selected hosts',
        )
      owners.set(canonical, plan.host)
    }
  }
}
