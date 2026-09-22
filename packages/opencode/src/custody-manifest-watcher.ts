import { type FSWatcher, watch } from 'node:fs'
import { stat } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'

const REGISTRY_KEY = Symbol.for(
  'cortexkit.anthropic-auth.custody-manifest-watchers.v1',
)
const DEFAULT_DEBOUNCE_MS = 25
const DEFAULT_POLL_INTERVAL_MS = 2_000

type Listener = () => void | Promise<void>
type Timer = ReturnType<typeof setTimeout>
type WatchFactory = typeof watch

type WatcherEntry = {
  watcher?: FSWatcher
  listeners: Map<symbol, Listener>
  timer?: Timer
  pollTimer?: Timer
  pollInFlight: boolean
  signature?: string
  setTimeoutImpl: typeof setTimeout
  clearTimeoutImpl: typeof clearTimeout
  pollSetTimeoutImpl: typeof setTimeout
  pollClearTimeoutImpl: typeof clearTimeout
  debounceMs: number
  pollIntervalMs: number
  onError?: (error: unknown) => void
}

type WatcherRegistry = Map<string, WatcherEntry>

type WatcherGlobal = typeof globalThis & {
  [REGISTRY_KEY]?: WatcherRegistry
}

function registry(): WatcherRegistry {
  const target = globalThis as WatcherGlobal
  let watchers = target[REGISTRY_KEY]
  if (!watchers) {
    watchers = new Map()
    target[REGISTRY_KEY] = watchers
  }
  return watchers
}

function filenameMatches(
  filename: string | Buffer | null | undefined,
  expected: string,
): boolean {
  // Node may omit the filename (undefined) when it cannot attribute the change
  // to a specific entry; treat that like null and reconcile the whole directory.
  return filename == null || filename.toString() === expected
}

function schedule(entry: WatcherEntry): void {
  if (entry.timer) entry.clearTimeoutImpl(entry.timer)
  entry.timer = entry.setTimeoutImpl(() => {
    entry.timer = undefined
    for (const callback of entry.listeners.values()) {
      Promise.resolve()
        .then(callback)
        .catch((error) => entry.onError?.(error))
    }
  }, entry.debounceMs)
  ;(entry.timer as { unref?: () => void }).unref?.()
}

async function pollManifest(path: string, entry: WatcherEntry): Promise<void> {
  if (entry.pollInFlight) return
  entry.pollInFlight = true
  try {
    let signature = 'missing'
    try {
      const metadata = await stat(path, { bigint: true })
      signature = `${metadata.dev}:${metadata.ino}:${metadata.size}:${metadata.mtimeNs}`
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    if (entry.signature !== signature) {
      entry.signature = signature
      schedule(entry)
    }
  } catch (error) {
    entry.onError?.(error)
  } finally {
    entry.pollInFlight = false
  }
}

function schedulePoll(path: string, entry: WatcherEntry): void {
  entry.pollTimer = entry.pollSetTimeoutImpl(async () => {
    entry.pollTimer = undefined
    await pollManifest(path, entry)
    const current = registry().get(path)
    if (current === entry && current.listeners.size > 0) {
      schedulePoll(path, current)
    }
  }, entry.pollIntervalMs)
  ;(entry.pollTimer as { unref?: () => void }).unref?.()
}

export function adoptCustodyManifestWatcher(
  manifestPath: string,
  listener: Listener,
  options: {
    watchImpl?: WatchFactory
    setTimeoutImpl?: typeof setTimeout
    clearTimeoutImpl?: typeof clearTimeout
    pollSetTimeoutImpl?: typeof setTimeout
    pollClearTimeoutImpl?: typeof clearTimeout
    debounceMs?: number
    pollIntervalMs?: number
    onError?: (error: unknown) => void
  } = {},
): { release: () => void } {
  const key = resolve(manifestPath)
  const lease = Symbol(key)
  const watchers = registry()
  let entry = watchers.get(key)

  if (!entry) {
    const setTimeoutImpl = options.setTimeoutImpl ?? globalThis.setTimeout
    const clearTimeoutImpl = options.clearTimeoutImpl ?? globalThis.clearTimeout
    entry = {
      listeners: new Map(),
      pollInFlight: false,
      setTimeoutImpl,
      clearTimeoutImpl,
      pollSetTimeoutImpl: options.pollSetTimeoutImpl ?? setTimeoutImpl,
      pollClearTimeoutImpl: options.pollClearTimeoutImpl ?? clearTimeoutImpl,
      debounceMs: options.debounceMs ?? DEFAULT_DEBOUNCE_MS,
      pollIntervalMs: options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
      onError: options.onError,
    }
    watchers.set(key, entry)

    const expectedBasename = basename(key)
    try {
      const watcher = (options.watchImpl ?? watch)(
        dirname(key),
        { persistent: false },
        (_eventType, filename) => {
          if (!filenameMatches(filename, expectedBasename)) return
          const current = watchers.get(key)
          if (current) schedule(current)
        },
      )
      entry.watcher = watcher
      watcher.on('error', (error) => {
        const current = watchers.get(key)
        if (current?.watcher === watcher) {
          current.watcher = undefined
          watcher.close()
        }
        entry?.onError?.(error)
      })
    } catch (error) {
      entry.onError?.(error)
    }

    void pollManifest(key, entry)
    if (entry.pollIntervalMs > 0) schedulePoll(key, entry)
  }

  entry.listeners.set(lease, listener)
  // Reconcile once after every adoption. This closes the race where the
  // manifest changes between an instance's startup read and watcher creation.
  schedule(entry)

  let released = false
  return {
    release() {
      if (released) return
      released = true
      const current = watchers.get(key)
      if (!current) return
      current.listeners.delete(lease)
      if (current.listeners.size > 0) return
      if (current.timer) current.clearTimeoutImpl(current.timer)
      if (current.pollTimer) current.pollClearTimeoutImpl(current.pollTimer)
      current.watcher?.close()
      watchers.delete(key)
    },
  }
}
