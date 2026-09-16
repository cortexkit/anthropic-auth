import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const productionFiles = [
  '../custody-mode.ts',
  '../custody-live.ts',
  '../local-login.ts',
  '../../../core/src/claustrum.ts',
  '../../../core/src/commands/account.ts',
  '../index.ts',
]

const allowedGuidance = [
  'Mint a handle with `ck auth mint-handle`; this plugin then writes the manifest entry.',
  'Claustrum main credential requires re-import; run ck auth import --replace.',
  'Claustrum main binding is not active while local main material remains; mint a handle with `ck auth mint-handle` so this plugin can write the manifest entry.',
  'Claustrum main credential identity differs from the persisted main identity; run ck auth set-identity.',
]
const forbidden = [
  /child_process/u,
  /Bun\.spawn/u,
  /Bun\.\$/u,
  /execa/u,
  /ck auth/u,
]

describe('custody production dependencies', () => {
  test('does not invoke vault CLIs or spawn processes', async () => {
    for (const relativePath of productionFiles) {
      const source = await readFile(join(import.meta.dir, relativePath), 'utf8')
      const unguarded = allowedGuidance.reduce(
        (remaining, guidance) => remaining.replace(guidance, ''),
        source,
      )
      for (const pattern of forbidden)
        expect(
          unguarded,
          `${relativePath} must not contain ${pattern}`,
        ).not.toMatch(pattern)
    }
  })
})
