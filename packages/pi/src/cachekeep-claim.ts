import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import {
  createWindowsOwnerOnly,
  ensureHolderDirectory,
  type HolderLiveness,
  holderEntryIsLive,
  holderEntryLiveness,
  isOwnerOnly,
  type OwnerOnlyOptions,
  processIncarnation,
  readWindowsOwnerOnly,
  renameWithWindowsSharingRetry,
  withNativeLock,
} from '@cortexkit/anthropic-auth-core'

/** A process-lifetime claim, not a timer lease that can expire during a pause. */
export class PiCacheKeepClaim {
  private readonly token = randomUUID()
  private readonly path: string
  private held = false

  constructor(
    private readonly directory: string,
    sessionId: string,
    private readonly options: {
      ownerOnly?: OwnerOnlyOptions
      liveness?: HolderLiveness
      sessionHash?: boolean
    } = {},
  ) {
    const hash = options.sessionHash
      ? sessionId
      : createHash('sha256').update(sessionId).digest('hex')
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('Invalid session hash')
    this.path = join(directory, `${hash}.claim.json`)
  }

  private async read(): Promise<Record<string, unknown> | undefined> {
    try {
      const stat = await lstat(this.path)
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.size > 4096 ||
        !(await isOwnerOnly(
          this.path,
          () =>
            stat.uid === process.getuid?.() && (stat.mode & 0o777) === 0o600,
          this.options.ownerOnly,
        ))
      )
        throw new Error('Unsafe CacheKeep claim')
      let bytes = await readWindowsOwnerOnly(this.path, this.options.ownerOnly)
      if (!bytes) {
        const file = await open(
          this.path,
          constants.O_RDONLY | constants.O_NOFOLLOW,
        )
        try {
          bytes = await file.readFile()
        } finally {
          await file.close()
        }
      }
      const value = JSON.parse(bytes.toString())
      if (!holderEntryLiveness(value) || typeof value.token !== 'string')
        throw new Error('Invalid CacheKeep claim')
      return value
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }

  async acquire() {
    if (this.held) return true
    await ensureHolderDirectory(this.directory, this.options.ownerOnly)
    for (;;) {
      const result = await this.tryAcquire()
      if (result !== 'sweep') return result
      // A sweep borrows ownership only while reading one record. A resuming
      // session waits in the background instead of mistaking temporary sweep
      // ownership for an active session claim.
      await delay(25)
    }
  }

  private tryAcquire() {
    return withNativeLock(
      this.path,
      {
        name: 'cachekeep-session',
        ttlMs: 10_000,
        timeoutMs: 2000,
        renew: true,
      },
      async (lease) => {
        const existing = await this.read()
        const life = holderEntryLiveness(existing)
        if (life && (await holderEntryIsLive(life, this.options.liveness)))
          return !this.options.sessionHash && existing?.purpose === 'sweep'
            ? ('sweep' as const)
            : false
        const bytes = JSON.stringify({
          pid: process.pid,
          incarnation: await (
            this.options.liveness?.incarnation ?? processIncarnation
          )(process.pid),
          registeredAt: Date.now(),
          token: this.token,
          purpose: this.options.sessionHash ? 'sweep' : 'session',
        })
        const temp = `${this.path}.${this.token}.tmp`
        try {
          if (
            !(await createWindowsOwnerOnly(temp, bytes, this.options.ownerOnly))
          )
            await writeFile(temp, bytes, { flag: 'wx', mode: 0o600 })
          await lease.assertOwned()
          await renameWithWindowsSharingRetry(temp, this.path, {
            platform: this.options.ownerOnly?.platform,
          })
          this.held = true
          return true
        } finally {
          await rm(temp, { force: true })
        }
      },
    )
  }

  async release() {
    if (!this.held) return
    await withNativeLock(
      this.path,
      {
        name: 'cachekeep-session',
        ttlMs: 10_000,
        timeoutMs: 2000,
        renew: true,
      },
      async (lease) => {
        const current = await this.read()
        if (current?.token === this.token) {
          await lease.assertOwned()
          await rm(this.path, { force: true })
        }
        this.held = false
      },
    )
  }
}
