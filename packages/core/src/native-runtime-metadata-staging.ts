import { lstat, readdir, realpath, unlink } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { canonicalFilePath } from '@cortexkit/common-auth/fs'

const MIN_STAGE_AGE_MS = 10 * 60_000
const STAGE_SWEEP_LIMIT = 256

export function canonicalRuntimeMetadataPath(
  path: string,
  unsafe: () => Error,
) {
  return canonicalFilePath(path, {
    realpath,
    lstat,
    readlink: async () => {
      // Resolve directory aliases without following runtime leaf symlinks,
      // which the normal owner-only runtime reader would refuse.
      throw unsafe()
    },
  })
}

export function runtimeMetadataStagePrefix(path: string) {
  return `${basename(path)}.native-runtime-metadata.`
}

export async function sweepNativeRuntimeMetadataStages(
  dir: string,
  prefix: string,
) {
  const names = await readdir(dir).catch(() => [])
  const candidates = names
    .filter(
      (name) =>
        name.startsWith(prefix) &&
        /^\d+\.\d+\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.partial$/.test(
          name.slice(prefix.length),
        ),
    )
    .slice(0, STAGE_SWEEP_LIMIT)
  const cutoff = Date.now() - MIN_STAGE_AGE_MS
  for (const name of candidates) {
    const stage = join(dir, name)
    try {
      // Staging names are never reused. Check only the file's metadata, since
      // the staged contents can contain private account data.
      const info = await lstat(stage)
      if (info.isFile() && info.mtimeMs < cutoff) await unlink(stage)
    } catch {
      // A writer or another sweep may already have removed this copy.
    }
  }
}
