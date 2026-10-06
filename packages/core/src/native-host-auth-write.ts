import { randomUUID } from 'node:crypto'
import { lstat, open, rename, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'

import { custodyTombstoneOAuth } from './claustrum.ts'
import {
  NativeMigrationSourceError,
  readNativeMigrationSource,
  requireUnchangedNativeMigrationSource,
} from './migration-source.ts'
import {
  inspectNativeHostAuthEntry,
  NativeHostAuthError,
  requireNoSupervisedAuthContentSnapshot,
} from './native-host-auth.ts'

export interface NativeHostAuthWriteInput {
  readonly host: 'opencode' | 'pi'
  /**
   * Use the configured auth path, not a symlink's target, so the source reader
   * can reject a symlink at the auth file. Its directory must already exist.
   */
  readonly authPath: string
  readonly sourceDigest: string
  readonly expectedDigest: string
  readonly env: NodeJS.ProcessEnv
  readonly removePiAnthropicAuth: boolean
  /**
   * Must reject if the caller no longer owns the offline operation.
   * Awaited immediately before replacing or deleting the auth file.
   */
  readonly processFence: () => Promise<void>
}

export interface NativeHostAuthWriteHooks {
  readonly beforeRecheck?: () => Promise<void>
  readonly beforeRename?: () => Promise<void>
  readonly afterRename?: () => Promise<void>
  readonly afterUnlink?: () => Promise<void>
}

export type NativeHostAuthWriteOutcome =
  | { readonly status: 'unchanged' }
  | { readonly status: 'replaced' | 'created' }
  | { readonly status: 'removed'; readonly file: 'replaced' | 'unlinked' }

export class NativeHostAuthWriteError extends Error {
  constructor(
    public readonly code:
      | 'invalid-source'
      | 'unsafe-source'
      | 'consent-required'
      | 'process-fence-refused'
      | 'write-io'
      | 'hook-failed',
    /** Records the file change already completed if a later callback throws. */
    public readonly effect: NativeHostAuthWriteOutcome | undefined = undefined,
  ) {
    super(`Native host auth write: ${code}`)
    this.name = 'NativeHostAuthWriteError'
  }
}

/** Match this helper's temporary filenames so crash cleanup leaves other files alone. */
export function isNativeHostAuthWriteStagingName(name: string): boolean {
  return (
    name.endsWith('.tmp') &&
    /^\.native-host-auth-write\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/.test(
      name,
    )
  )
}

function isEntryDigest(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    (value === 'absent' ||
      (value.length === 64 && /^[a-f0-9]{64}$/.test(value)))
  )
}

async function barrier(
  callback: (() => Promise<void>) | undefined,
  code: 'hook-failed' | 'process-fence-refused',
  effect?: NativeHostAuthWriteOutcome,
): Promise<void> {
  try {
    await callback?.()
  } catch {
    // A caller's exception may contain credentials; never retain it as a cause.
    throw new NativeHostAuthWriteError(code, effect)
  }
}

/**
 * Physical offline recipes only: no journal transaction or host SDK writes.
 * The entry digest fences phases; the complete fresh snapshot fences this write.
 * There is NO compare-and-swap with host writers: a host change between the final
 * recheck and rename/unlink can be overwritten without detection. Advisory locks
 * do not stop unlocked host writers. Callers must quiesce hosts and use the entry
 * oracle on the next resume, as well as bind paths and preflight selected hosts.
 */
export async function writeNativeHostAuth(
  input: NativeHostAuthWriteInput,
  hooks: NativeHostAuthWriteHooks = {},
): Promise<NativeHostAuthWriteOutcome> {
  let stage: string | undefined
  let ownedStage: { dev: number; ino: number } | undefined
  let effect: NativeHostAuthWriteOutcome | undefined
  try {
    // Save the original values and callbacks before awaiting file I/O; caller
    // mutations must not redirect the write or replace its checks.
    const {
      host,
      authPath,
      sourceDigest,
      expectedDigest,
      removePiAnthropicAuth,
      processFence,
    } = input
    requireNoSupervisedAuthContentSnapshot(input.env)
    const { beforeRecheck, beforeRename, afterRename, afterUnlink } = hooks
    if (
      (host !== 'opencode' && host !== 'pi') ||
      typeof authPath !== 'string' ||
      !isAbsolute(authPath) ||
      /\p{Cc}/u.test(authPath) ||
      !isEntryDigest(sourceDigest) ||
      !isEntryDigest(expectedDigest) ||
      typeof processFence !== 'function'
    )
      throw new NativeHostAuthWriteError('invalid-source')

    const snapshot = await readNativeMigrationSource('hostAuth', authPath)
    if (
      snapshot.metadata &&
      process.getuid &&
      snapshot.metadata.uid !== process.getuid()
    )
      throw new NativeHostAuthWriteError('unsafe-source')
    const entry = inspectNativeHostAuthEntry(host, snapshot.data)
    if (entry.digest !== sourceDigest)
      throw new NativeHostAuthWriteError('invalid-source')

    // Copy own JSON keys into a null-prototype object so __proto__ stays data.
    const next: Record<string, unknown> = Object.assign(
      Object.create(null),
      snapshot.data,
    )
    if (host === 'opencode') {
      if (entry.kind !== 'api' && entry.kind !== 'activation')
        next.anthropic = custodyTombstoneOAuth('anthropic')
    } else {
      delete next.anthropic
    }
    if (inspectNativeHostAuthEntry(host, next).digest !== expectedDigest)
      throw new NativeHostAuthWriteError('invalid-source')

    if (
      (host === 'opencode' &&
        (entry.kind === 'api' || entry.kind === 'activation')) ||
      (host === 'pi' && entry.kind === 'absent')
    )
      return Object.freeze({ status: 'unchanged' })
    // Pi activation markers are stored as OAuth entries; removing one still
    // requires the caller's explicit consent.
    if (host === 'pi' && removePiAnthropicAuth !== true)
      throw new NativeHostAuthWriteError('consent-required')

    const removingFile = host === 'pi' && Object.keys(next).length === 0
    const outcome: NativeHostAuthWriteOutcome = Object.freeze(
      host === 'pi'
        ? { status: 'removed', file: removingFile ? 'unlinked' : 'replaced' }
        : { status: snapshot.data === undefined ? 'created' : 'replaced' },
    )
    if (!removingFile) {
      stage = join(
        dirname(authPath),
        `.native-host-auth-write.${randomUUID()}.tmp`,
      )
      // Never retry a collision and never clean up a stage we did not create.
      const handle = await open(stage, 'wx', 0o600)
      try {
        const identity = await handle.stat()
        ownedStage = { dev: identity.dev, ino: identity.ino }
        await handle.writeFile(`${JSON.stringify(next, null, 2)}\n`, 'utf8')
        await handle.chmod(
          snapshot.metadata ? snapshot.metadata.mode & 0o7777 : 0o600,
        )
        await handle.sync()
      } finally {
        await handle.close()
      }
    }

    await barrier(beforeRecheck, 'hook-failed')
    await requireUnchangedNativeMigrationSource(snapshot)
    // The file can still change after the final snapshot check; no atomic
    // comparison protects the rename or unlink. Run the caller's process check
    // after the test hook, immediately before changing the file.
    await barrier(beforeRename, 'hook-failed')
    await barrier(processFence, 'process-fence-refused')
    if (removingFile) {
      await unlink(authPath)
      effect = outcome
      await barrier(afterUnlink, 'hook-failed', effect)
    } else {
      await rename(stage as string, authPath)
      ownedStage = undefined
      effect = outcome
      await barrier(afterRename, 'hook-failed', effect)
    }
    return outcome
  } catch (error) {
    if (
      error instanceof NativeHostAuthWriteError ||
      error instanceof NativeHostAuthError
    )
      throw error
    if (error instanceof NativeMigrationSourceError)
      throw new NativeHostAuthWriteError(
        error.code === 'unsafe-source' ? 'unsafe-source' : 'invalid-source',
        effect,
      )
    throw new NativeHostAuthWriteError('write-io', effect)
  } finally {
    if (stage && ownedStage) {
      try {
        const current = await lstat(stage)
        if (current.dev === ownedStage.dev && current.ino === ownedStage.ino)
          await unlink(stage)
      } catch {
        // If temporary-file cleanup fails, keep the original error or completed
        // file-change result. Later cleanup may remove recognized temporary files,
        // but must never read them as host auth.
      }
    }
  }
}
