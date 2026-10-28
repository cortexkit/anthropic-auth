import { rename } from 'node:fs/promises'
import { types as utilTypes } from 'node:util'
import { windowsLongPath } from './windows-long-path.ts'

/** Per-publication seams keep platform and sharing-failure tests out of process globals. */
export interface PublicationOptions {
  readonly platform?: NodeJS.Platform
  readonly rename?: (from: string, to: string) => Promise<void>
  readonly now?: () => number
  readonly sleep?: (ms: number) => Promise<void>
}

/** Capture optional callbacks before staging I/O, just like the writer's other hooks. */
export function capturePublicationOptions(
  options: PublicationOptions = {},
): PublicationOptions {
  return {
    platform: options.platform ?? process.platform,
    rename: options.rename,
    now: options.now,
    sleep: options.sleep,
  }
}

function sharingViolation(error: unknown): boolean {
  if (error === null || typeof error !== 'object' || utilTypes.isProxy(error))
    return false
  const fields: Record<string, unknown> = {}
  for (const key of ['code', 'reason', 'win32Code']) {
    const descriptor = Object.getOwnPropertyDescriptor(error, key)
    if (descriptor && !('value' in descriptor)) return false
    fields[key] = descriptor?.value
  }
  return fields.win32Code !== undefined
    ? fields.win32Code === 32 || fields.win32Code === 33
    : ['EBUSY', 'EPERM', 'EACCES'].includes(fields.code as string) &&
        !fields.reason
}

/** First publication is unconditional; only subsequent Windows sharing failures are retried. */
export async function renameWithWindowsSharingRetry(
  from: string,
  to: string,
  options: PublicationOptions = {},
  beforeRetry?: () => Promise<'publish' | 'skip'>,
): Promise<'published' | 'skipped'> {
  const move =
    options.rename ??
    ((from, to) =>
      rename(
        windowsLongPath(from, options.platform ?? process.platform),
        windowsLongPath(to, options.platform ?? process.platform),
      ))
  if ((options.platform ?? process.platform) !== 'win32') {
    await move(from, to)
    return 'published'
  }
  const now = options.now ?? (() => performance.now())
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const start = now()
  let original: unknown
  try {
    await move(from, to)
    return 'published'
  } catch (error) {
    if (!sharingViolation(error)) throw error
    original = error
  }
  for (const delay of [10, 20, 40, 80, 100]) {
    const remaining = 500 - (now() - start)
    if (remaining <= 0) break
    await sleep(Math.min(delay, remaining))
    if (now() - start >= 500) break
    // Refusals from authority checks are not rename failures and must not be retried.
    if ((await beforeRetry?.()) === 'skip') return 'skipped'
    if (now() - start >= 500) break
    try {
      await move(from, to)
      return 'published'
    } catch (error) {
      if (!sharingViolation(error)) throw error
    }
  }
  throw original
}
