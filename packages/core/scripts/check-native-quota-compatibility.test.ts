import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { QuotaCodec } from '@cortexkit/common-auth/quota'
import type { OAuthQuotaSnapshot } from '../src/accounts.ts'
import {
  type NativeQuotaMap,
  nativeQuotaCodec,
  toNativeQuotaMap,
} from '../src/native-quota-codec.ts'
import { resolveNativePoolPaths } from '../src/pool-paths.ts'
import { createNativePoolStore } from '../src/pool-store.ts'

async function run(command: string[], cwd: string) {
  const child = Bun.spawn(command, { cwd, stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (code !== 0)
    throw new Error(`${command.join(' ')} exited ${code}: ${stderr}`)
  return stdout
}

/** Network integration guard against making a shared pool unreadable after rollback. */
test('quota maps written by the shared store remain accepted by the published Core 2.2.7 codec', async () => {
  const scratch = new URL('../../../target/scratch/', import.meta.url).pathname
  await mkdir(scratch, { recursive: true })
  const root = await mkdtemp(join(scratch, 'quota-format-227-'))
  try {
    // npm 11 prints an array of records, npm 12 an object keyed by package name.
    const packed: unknown = JSON.parse(
      await run(
        [
          'npm',
          'pack',
          '@cortexkit/anthropic-auth-core@2.2.7',
          '--json',
          '--pack-destination',
          root,
        ],
        root,
      ),
    )
    const [pack] = (
      Array.isArray(packed) ? packed : Object.values(packed as object)
    ) as Array<{ filename: string; version: string; shasum: string }>
    if (pack?.version !== '2.2.7')
      throw new Error('Wrong compatibility release')
    console.log(
      'QUOTA_COMPATIBILITY_PACK',
      JSON.stringify({ version: pack.version, shasum: pack.shasum }),
    )
    const consumer = join(root, 'consumer')
    await mkdir(consumer)
    await writeFile(
      join(consumer, 'package.json'),
      JSON.stringify({
        private: true,
        type: 'module',
        dependencies: {
          '@cortexkit/anthropic-auth-core': `file:${join(root, pack.filename)}`,
        },
      }),
    )
    await run([process.execPath, 'install'], consumer)
    const dist = join(
      consumer,
      'node_modules/@cortexkit/anthropic-auth-core/dist',
    )
    const source = await readFile(join(dist, 'index.js'), 'utf8')
    // Expose the private validator without changing any of the packed code.
    const hook = join(dist, 'compatibility-codec.js')
    await writeFile(
      hook,
      `${source}\nexport {nativeQuotaCodec as legacyNativeQuotaCodec};\n`,
    )
    const { legacyNativeQuotaCodec } = (await import(
      pathToFileURL(hook).href
    )) as { legacyNativeQuotaCodec: QuotaCodec }
    const identity = '11111111-1111-4111-8111-111111111111'
    const poll: OAuthQuotaSnapshot = {
      accountIdentity: identity,
      source: 'poll',
      checkedAt: 1000,
      five_hour: { usedPercent: 20, remainingPercent: 80, checkedAt: 1000 },
      seven_day: { usedPercent: 30, remainingPercent: 70, checkedAt: 1000 },
      scoped: [
        {
          id: 'fable',
          title: 'Fable',
          modelName: 'Fable',
          usedPercent: 40,
          remainingPercent: 60,
          checkedAt: 1000,
        },
      ],
      extraUsage: {
        used: { amountMinor: 10, currency: 'USD', exponent: 2 },
        limit: { amountMinor: 100, currency: 'USD', exponent: 2 },
        exhausted: false,
      },
    }
    const headers: OAuthQuotaSnapshot = {
      accountIdentity: identity,
      source: 'headers',
      checkedAt: 2000,
      five_hour: { usedPercent: 12, remainingPercent: 88, checkedAt: 2000 },
      seven_day: { usedPercent: 21, remainingPercent: 79, checkedAt: 2000 },
    }
    const cases: Array<{ name: string; readings: OAuthQuotaSnapshot[] }> = [
      { name: 'full poll', readings: [poll] },
      { name: 'poll followed by headers', readings: [poll, headers] },
      { name: 'headers followed by an older poll', readings: [headers, poll] },
      {
        name: 'newer complete poll clears optional fields',
        readings: [poll, { ...headers, source: 'poll', scoped: [] }],
      },
      { name: 'headers only', readings: [headers] },
      {
        name: 'scoped only',
        readings: [
          {
            accountIdentity: identity,
            source: 'poll',
            checkedAt: 1000,
            scoped: poll.scoped,
          },
        ],
      },
      {
        name: 'empty scoped',
        readings: [
          {
            accountIdentity: identity,
            source: 'poll',
            checkedAt: 1000,
            scoped: [],
          },
        ],
      },
      {
        name: 'extra usage only',
        readings: [
          {
            accountIdentity: identity,
            source: 'poll',
            checkedAt: 1000,
            extraUsage: poll.extraUsage,
          },
        ],
      },
    ]
    for (const [index, scenario] of cases.entries()) {
      const directory = join(root, `pool-${index}`)
      await mkdir(directory)
      const paths = await resolveNativePoolPaths(join(directory, 'auth.json'))
      const writer = createNativePoolStore({ paths, quota: nativeQuotaCodec })
      try {
        await writer.initialize()
        await writer.add({
          id: 'main',
          identity,
          credential: {
            type: 'oauth',
            access: 'sk-ant-oat01-compatibility',
            refresh: 'synthetic',
            expires: Date.now() + 3_600_000,
          },
        })
        for (const reading of scenario.readings)
          await writer.recordQuota(
            'main',
            { credentialEpoch: 1, identity },
            toNativeQuotaMap(reading),
          )
      } finally {
        await writer.close()
      }
      const reader = createNativePoolStore({ paths, quota: nativeQuotaCodec })
      try {
        const loaded = await reader.read()
        if (loaded.status !== 'ready')
          throw new Error(`Pool not ready: ${scenario.name}`)
        const written = loaded.rows.find((row) => row.id === 'main')?.quota
        expect({
          scenario: scenario.name,
          accepted: legacyNativeQuotaCodec.validate(written),
        }).toEqual({ scenario: scenario.name, accepted: true })
        // A known-incompatible field proves that the old validator is actually
        // enforcing its closed metadata format, not merely accepting all inputs.
        const map = written as NativeQuotaMap
        const incompatible = {
          ...map,
          anthropic: { ...map.anthropic, futureFormatField: 1 },
        }
        expect(legacyNativeQuotaCodec.validate(incompatible)).toBe(false)
      } finally {
        await reader.close()
      }
    }
    console.log(
      `QUOTA_COMPATIBILITY_ACCEPTED ${cases.length} persisted quota shapes`,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 60_000)
