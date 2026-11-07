import { resolve } from 'node:path'
import { resolveClaustrumConnectionPath } from './claustrum.ts'
import { getHostClaustrumEnrollmentPaths } from './claustrum-enrollment.ts'
import { NativeCustodyError } from './native-custody.ts'
import { isVaultHosted } from './native-vault-host.ts'
import type { NativePoolPaths } from './pool-paths.ts'

const identities = new WeakMap<object, number>()
let nextIdentity = 0

/** Compare injected transports and policy callbacks by object identity when selecting a shared runtime. */
export function nativeRuntimeOptionIdentity(value: object | undefined) {
  if (!value) return undefined
  let id = identities.get(value)
  if (id === undefined) {
    id = ++nextIdentity
    identities.set(value, id)
  }
  return id
}

export function nativeRuntimeStorageKey(options: {
  paths: NativePoolPaths
  host: 'opencode' | 'pi'
  env?: NodeJS.ProcessEnv
}) {
  const env = options.env ?? process.env
  const enrollment = getHostClaustrumEnrollmentPaths(options.host, env)
  const connection = nativeRuntimeConnectionFile(options.host, env)
  const paths = options.paths
  return JSON.stringify([
    options.host,
    isVaultHosted() ? 'host-anthropic-auth' : 'native',
    paths.storageId,
    ...(
      [
        'legacyConfig',
        'legacyState',
        'config',
        'state',
        'runtime',
        'journal',
        'roster',
      ] as const
    ).map((field) => resolve(paths[field])),
    resolve(enrollment.tokenPath),
    resolve(enrollment.statePath),
    resolve(connection),
  ])
}

export function nativeRuntimeConnectionFile(
  host: 'opencode' | 'pi',
  env: NodeJS.ProcessEnv,
) {
  return resolve(
    resolveClaustrumConnectionPath(
      host === 'pi'
        ? env.PI_ANTHROPIC_AUTH_CLAUSTRUM_CONNECTION_FILE
        : undefined,
      host === 'pi'
        ? {
            ...env,
            OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_CONNECTION_FILE: undefined,
          }
        : env,
    ),
  )
}

/** A release applies to the runtime entry acquired earlier, not to a later entry created with the same key. */
export class NativeRuntimeRegistry<
  T extends { close(): void | Promise<void> },
> {
  private readonly entries = new Map<string, { runtime: T; users: number }>()

  acquire(key: string, create: () => T) {
    let entry = this.entries.get(key)
    if (!entry) {
      entry = { runtime: create(), users: 0 }
      this.entries.set(key, entry)
    }
    const owned = entry
    owned.users++
    let closed = false
    let closing: void | Promise<void>
    return {
      use: (): T => {
        if (closed) throw new NativeCustodyError('closed')
        return owned.runtime
      },
      close: () => {
        if (closed) return closing
        closed = true
        if (--owned.users !== 0) return
        if (this.entries.get(key) === owned) this.entries.delete(key)
        closing = owned.runtime.close()
        return closing
      },
    }
  }
}
