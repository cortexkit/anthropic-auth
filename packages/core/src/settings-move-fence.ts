import { getOpenCodeConfigDir } from './accounts.ts'
import {
  HOLDER_FILE_NAME,
  type HolderEntry,
  type HolderFileContents,
  type HolderLiveness,
  holderEntryIsLive,
  holderEntryLiveness,
  holderInstance,
  type NativeHolderRegistration,
  processIncarnation,
  readHolderFile,
} from './holder-registry.ts'
import {
  defaultPreNArtifactLocations,
  type FenceBlocker,
  type PreNArtifactLocations,
  preNArtifactBlockers,
} from './layout-fence.ts'
import {
  type PathResolutionOptions,
  resolvePathOptions,
} from './path-options.ts'
import { canonicalPath } from './pool-paths.ts'
import { getPiAgentDir } from './settings-paths.ts'
import {
  anthropicAuthStateRoot,
  stateSubfolderName,
} from './state-layout-paths.ts'

/** The first release that serves settings from the shared user file. */
export const SETTINGS_MOVE_FIRST_RELEASE = '2.12.0'

export type SettingsMoveFenceBlocker =
  | { kind: 'registration'; reason: string }
  | { kind: 'floor'; release: string }
  | {
      kind: 'settings-holder'
      holderFile: string
      pid: number | null
      release: string | null
      reason: 'unreadable' | 'release'
    }
  | Extract<
      FenceBlocker,
      { kind: 'holder-file' | 'pre-n-artifact' | 'artifact-scan' }
    >

export interface SettingsMoveFenceOptions extends PathResolutionOptions {
  /** Every settings store the move will read, including overridden stores. */
  stores: readonly string[]
  /** A failed or still-pending registration prevents only this settings move. */
  registration: Pick<NativeHolderRegistration, 'status'> | undefined
  floor?: string
  /**
   * This code copy's own holder entry, the only one the fence ignores.
   * `instance` defaults to this copy's; another copy of the code loaded in
   * the same process is judged by its release like any other holder.
   */
  self?: Pick<HolderEntry, 'pid' | 'incarnation'> &
    Partial<Pick<HolderEntry, 'instance'>>
  liveness?: HolderLiveness
  artifacts?: PreNArtifactLocations
  /** Tests inject holder sets without consulting the installed package release. */
  readHolders?: (path: string) => Promise<HolderFileContents | undefined>
}

function reasonOf(error: unknown): string {
  if (error instanceof Error && 'code' in error) return String(error.code)
  return error instanceof Error ? error.name : 'unknown'
}

/** Check both hosts' standard holder folders as well as every move source's folder. */
export async function settingsMoveHolderFiles(
  options: PathResolutionOptions & { stores: readonly string[] },
): Promise<string[]> {
  const context = resolvePathOptions(options)
  const { env, home, paths } = context
  const configDir = getOpenCodeConfigDir(env, home, context)
  const identity = await canonicalPath(configDir, context)
  const defaultIdentity = await canonicalPath(
    paths.join(home, '.config', 'opencode'),
    context,
  )
  const stateRoot = anthropicAuthStateRoot(
    { xdgStateHome: env.XDG_STATE_HOME, home },
    paths,
  )
  const directories = [
    configDir,
    paths.join(stateRoot, stateSubfolderName(identity, defaultIdentity)),
    getPiAgentDir(context),
    ...options.stores.map((store) => paths.dirname(store)),
  ]
  // Canonicalize aliases so a source reached through a symlink gets its registry too.
  return [
    ...new Set(
      await Promise.all(
        directories.map(async (directory) =>
          paths.join(await canonicalPath(directory, context), HOLDER_FILE_NAME),
        ),
      ),
    ),
  ].sort()
}

/**
 * A closed fence is not a startup refusal: the caller keeps serving legacy settings.
 * Any older live holder blocks, even when its file list shares no path with a move source.
 */
export async function checkSettingsMoveFence(
  options: SettingsMoveFenceOptions,
): Promise<{ open: boolean; blockers: SettingsMoveFenceBlocker[] }> {
  const blockers: SettingsMoveFenceBlocker[] = []
  if (options.registration?.status !== 'registered') {
    return {
      open: false,
      blockers: [
        { kind: 'registration', reason: 'holder registration is unavailable' },
      ],
    }
  }
  const floorText = options.floor ?? SETTINGS_MOVE_FIRST_RELEASE
  const floor = parseRelease(floorText)
  if (!floor)
    return { open: false, blockers: [{ kind: 'floor', release: floorText }] }
  const context = resolvePathOptions(options)
  const self = {
    ...(options.self ?? {
      pid: process.pid,
      incarnation: await processIncarnation(process.pid),
    }),
    instance: options.self?.instance ?? holderInstance(),
  }
  let holderFiles: string[]
  try {
    holderFiles = await settingsMoveHolderFiles(options)
  } catch (error) {
    return {
      open: false,
      blockers: [
        {
          kind: 'artifact-scan',
          path: getOpenCodeConfigDir(context.env, context.home, context),
          reason: reasonOf(error),
        },
      ],
    }
  }
  for (const holderFile of holderFiles) {
    let contents: HolderFileContents | undefined
    try {
      contents = await (options.readHolders ?? readHolderFile)(holderFile)
    } catch (error) {
      blockers.push({
        kind: 'holder-file',
        holderFile,
        reason: reasonOf(error),
      })
      continue
    }
    for (const value of contents?.entries ?? []) {
      const life = holderEntryLiveness(value)
      if (!life) {
        blockers.push({
          kind: 'settings-holder',
          holderFile,
          pid: null,
          release: null,
          reason: 'unreadable',
        })
        continue
      }
      if (
        life.pid === self.pid &&
        life.incarnation === self.incarnation &&
        (value as { instance?: unknown }).instance === self.instance
      )
        continue
      if (!(await holderEntryIsLive(life, options.liveness))) continue
      const releaseText = (value as { release?: unknown }).release
      const release =
        typeof releaseText === 'string' ? parseRelease(releaseText) : undefined
      if (!release || compareRelease(release, floor) < 0) {
        blockers.push({
          kind: 'settings-holder',
          holderFile,
          pid: life.pid,
          release: typeof releaseText === 'string' ? releaseText : null,
          reason: 'release',
        })
      }
    }
  }
  const artifactBlockers = await preNArtifactBlockers(
    options.artifacts ??
      defaultPreNArtifactLocations(context.env, context.home),
    options.liveness?.pidAlive,
    options.liveness,
    (release) => {
      const parsed =
        typeof release === 'string' ? parseRelease(release) : undefined
      return !!parsed && compareRelease(parsed, floor) >= 0
    },
  )
  for (const blocker of artifactBlockers) {
    if (blocker.kind === 'pre-n-artifact' || blocker.kind === 'artifact-scan')
      blockers.push(blocker)
  }
  return { open: blockers.length === 0, blockers }
}

interface Release {
  version: [bigint, bigint, bigint]
  prerelease: string[]
}

function parseRelease(value: string): Release | undefined {
  const match =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(
      value,
    )
  if (!match || match[0] !== value) return undefined
  const [, major, minor, patch] = match
  if (major === undefined || minor === undefined || patch === undefined)
    return undefined
  const prerelease = match[4]?.split('.') ?? []
  if (prerelease.some((part) => /^0\d+$/.test(part))) return undefined
  return {
    version: [BigInt(major), BigInt(minor), BigInt(patch)],
    prerelease,
  }
}

/** Compare SemVer precedence; build metadata never changes the fence. */
function compareRelease(left: Release, right: Release): number {
  for (const i of [0, 1, 2] as const) {
    if (left.version[i] !== right.version[i])
      return left.version[i] < right.version[i] ? -1 : 1
  }
  if (!left.prerelease.length) return right.prerelease.length ? 1 : 0
  if (!right.prerelease.length) return -1
  for (
    let i = 0;
    i < Math.max(left.prerelease.length, right.prerelease.length);
    i++
  ) {
    const a = left.prerelease[i]
    const b = right.prerelease[i]
    if (a === undefined) return -1
    if (b === undefined) return 1
    if (a === b) continue
    const aNumeric = /^\d+$/.test(a)
    const bNumeric = /^\d+$/.test(b)
    if (aNumeric && bNumeric) return BigInt(a) < BigInt(b) ? -1 : 1
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1
    return a < b ? -1 : 1
  }
  return 0
}
