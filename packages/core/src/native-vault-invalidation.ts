import { resolve } from 'node:path'
import type { NativeVaultRosterDocument } from './native-roster-seed.ts'

// Multiple runtimes can share files without sharing a connection. Publication
// must invalidate every in-process holder, not only the runtime doing the write.
const holders = new Set<{
  roster: string
  tokenPath: string
  retain: (roster: NativeVaultRosterDocument | undefined) => void
  close: () => void
  isHosted?: () => boolean
}>()

export function watchNativeVaultAuthority(holder: {
  roster: string
  tokenPath: string
  retain: (roster: NativeVaultRosterDocument | undefined) => void
  close: () => void
  isHosted?: () => boolean
}): () => void {
  const held = {
    ...holder,
    roster: resolve(holder.roster),
    tokenPath: resolve(holder.tokenPath),
  }
  holders.add(held)
  return () => {
    holders.delete(held)
  }
}

export function retainNativeVaultRoster(
  path: string,
  roster: NativeVaultRosterDocument | undefined,
): void {
  for (const holder of holders)
    if (holder.roster === resolve(path)) holder.retain(roster)
}

export function closeNativeVaultAuthority(tokenPath: string): void {
  for (const holder of holders)
    if (holder.tokenPath === resolve(tokenPath) && !holder.isHosted?.())
      holder.close()
}
