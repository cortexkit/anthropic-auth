// Core's rules for local-pool quota readings, checked through Core's own store
// wiring (`createNativePoolStore`) with common-auth's opt-in quota coalescer.
//
// The shared rules run twice: with `nativeQuotaCodec`, which production uses, and
// with common-auth's own `quotaCodec` as a control, to tell a failure of the
// coalescer apart from a mismatch between the coalescer and Core's codec.
// Native snapshots keep legacy whole-snapshot precedence. A late older poll
// may therefore lose poll-only fields; the library codec is a per-field control.
import { afterEach, describe, expect, test } from 'bun:test'
import {
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { isQuotaMap } from '@cortexkit/common-auth/quota'

import { nativeQuotaCodec } from '../native-quota-codec.ts'
import { resolveNativePoolPaths } from '../pool-paths.ts'
import type { NativePoolStorePaths } from '../pool-store.ts'
import {
  closeStore,
  coalescingOpens,
  credential,
  type Facts,
  headerSnapshot,
  type Lane,
  lanes,
  type NativeStore,
  openNativeStore,
  pollSnapshot,
  type QuotaCommitTimer,
} from './pool-store-coalescing-fixture.ts'
import { holdPoolStoreLocks } from './pool-store-lock-fixture.ts'

const coalescing = test
const roots: string[] = []
const open: NativeStore[] = []
const holderCleanup: Array<() => void | Promise<void>> = []
const BINDING_CHANGED = /binding changed/

afterEach(async () => {
  await Promise.allSettled(holderCleanup.splice(0).map((cleanup) => cleanup()))
  // A failed test can leave a coalescing store with queued readings and a
  // retry timer; stop it before its directory goes away.
  await Promise.allSettled(open.splice(0).map((store) => closeStore(store)))
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

async function fixture() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'anthropic-quota-coalescing-')),
  )
  roots.push(root)
  return resolveNativePoolPaths(
    join(root, 'anthropic-auth.json'),
    join(root, 'anthropic-auth-state.json'),
  )
}

/** An immediate writer used as an independent control. */
function plain(paths: NativePoolStorePaths, lane: Lane) {
  return openNativeStore({ paths, quota: lane.codec })
}

function coalesced(
  paths: NativePoolStorePaths,
  lane: Lane,
  options: Partial<Parameters<typeof openNativeStore>[0]> = {},
  drainTimeoutMs = 5_000,
  quotaCommitTimer?: QuotaCommitTimer,
) {
  const before = coalescingOpens()
  const store = openNativeStore(
    { paths, quota: lane.codec, ...options },
    { drainTimeoutMs, quotaCommitTimer },
  )
  // Confirms Core opted into coalescing rather than opening an immediate writer.
  expect(coalescingOpens()).toBe(before + 1)
  open.push(store)
  return store
}

async function seed(
  paths: NativePoolStorePaths,
  lane: Lane,
  rows: ReadonlyArray<readonly [id: string, identity: string]>,
) {
  const store = plain(paths, lane)
  await store.initialize()
  for (const [id, identity] of rows)
    await store.add({ id, identity, credential: credential(id) })
}

async function facts(
  store: NativeStore,
  lane: Lane,
  id: string,
): Promise<Facts> {
  const loaded = await store.read()
  if (loaded.status !== 'ready') throw new Error(`Pool is ${loaded.status}`)
  const row = loaded.rows.find((candidate) => candidate.id === id)
  if (!row) throw new Error(`Row ${id} is missing`)
  return lane.facts(row.quota)
}

/** What a fresh store that has queued nothing reads from the files. */
function onDisk(paths: NativePoolStorePaths, lane: Lane, id: string) {
  return facts(plain(paths, lane), lane, id)
}

async function eventually(
  read: () => Promise<Facts>,
  done: (value: Facts) => boolean,
  ms = 5_000,
): Promise<Facts> {
  const deadline = Date.now() + ms
  let value = await read()
  while (!done(value) && Date.now() < deadline) {
    await sleep(25)
    value = await read()
  }
  return value
}

function warnings() {
  const seen: string[] = []
  return {
    seen,
    logger: { warn: (message: string) => void seen.push(message) },
  }
}

/** Holds a store's locks inside its first write until `release` is called. */
function lockHolder(paths: NativePoolStorePaths, lane: Lane) {
  let release!: () => void
  let entered!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const holding = new Promise<void>((resolve) => {
    entered = resolve
  })
  let first = true
  const store = openNativeStore({
    paths,
    quota: lane.codec,
    onStep: async () => {
      if (!first) return
      first = false
      entered()
      await held
    },
  })
  return { store, holding, release }
}

const epoch1 = (identity: string) => ({ credentialEpoch: 1, identity })

for (const lane of lanes) {
  describe(`quota coalescing with ${lane.name} codec`, () => {
    for (const order of [
      'poll, then newer header',
      'newer header, then older poll',
    ] as const) {
      coalescing(
        `quota observations preserve newer windows using each codec's precedence (${order})`,
        async () => {
          const paths = await fixture()
          await seed(paths, lane, [['a', 'acct-a']])
          const store = coalesced(paths, lane)
          const poll = lane.observe(
            pollSnapshot('acct-a', 1_000, {
              five_hour: 70,
              seven_day: 40,
              fable: 51,
            }),
          )
          const header = lane.observe(
            headerSnapshot('acct-a', 2_000, { five_hour: 12, seven_day: 41 }),
          )
          for (const reading of order === 'poll, then newer header'
            ? [poll, header]
            : [header, poll])
            await store.recordQuota('a', epoch1('acct-a'), reading)
          const expected: Facts = {
            five_hour: { usedPercent: 12, checkedAt: 2_000 },
            seven_day: { usedPercent: 41, checkedAt: 2_000 },
            fable: { usedPercent: 51, checkedAt: 1_000 },
            extraUsagePercent: 19.225,
          }
          expect(await facts(store, lane, 'a')).toEqual(expected)
          await closeStore(store)
          expect(await onDisk(paths, lane, 'a')).toEqual(expected)
        },
      )
    }

    coalescing(
      'the first poll adds scoped limits and credits without replacing newer header windows on disk',
      async () => {
        const paths = await fixture()
        await seed(paths, lane, [['a', 'acct-a']])
        const store = coalesced(paths, lane)
        await store.recordQuota(
          'a',
          epoch1('acct-a'),
          lane.observe(
            headerSnapshot('acct-a', 2_000, { five_hour: 12, seven_day: 41 }),
          ),
        )
        const header = await eventually(
          () => onDisk(paths, lane, 'a'),
          (value) => value.five_hour?.checkedAt === 2_000,
        )
        expect(header.five_hour).toEqual({ usedPercent: 12, checkedAt: 2_000 })
        expect(header.fable).toBeUndefined()
        expect(header.extraUsagePercent).toBeUndefined()
        await store.recordQuota(
          'a',
          epoch1('acct-a'),
          lane.observe(
            pollSnapshot('acct-a', 1_000, {
              five_hour: 70,
              seven_day: 40,
              fable: 51,
            }),
          ),
        )
        const expected: Facts = {
          five_hour: { usedPercent: 12, checkedAt: 2_000 },
          seven_day: { usedPercent: 41, checkedAt: 2_000 },
          fable: { usedPercent: 51, checkedAt: 1_000 },
          extraUsagePercent: 19.225,
        }
        expect(await facts(store, lane, 'a')).toEqual(expected)
        await closeStore(store)
        expect(await onDisk(paths, lane, 'a')).toEqual(expected)
      },
    )

    coalescing(
      'an accepted reading shows in read() and load() before its write lands',
      async () => {
        const paths = await fixture()
        await seed(paths, lane, [['a', 'acct-a']])
        const holder = lockHolder(paths, lane)
        const adding = holder.store.add({
          id: 'z',
          identity: 'acct-z',
          credential: credential('z'),
        })
        await holder.holding
        const store = coalesced(paths, lane)
        try {
          await store.recordQuota(
            'a',
            epoch1('acct-a'),
            lane.observe(
              headerSnapshot('acct-a', 2_000, { five_hour: 12, seven_day: 41 }),
            ),
          )
          const shown: Facts = {
            five_hour: { usedPercent: 12, checkedAt: 2_000 },
            seven_day: { usedPercent: 41, checkedAt: 2_000 },
          }
          expect(await facts(store, lane, 'a')).toEqual(shown)
          const loaded = await store.load()
          expect(
            loaded.status === 'ready'
              ? lane.facts(loaded.rows.find((row) => row.id === 'a')?.quota)
              : loaded.status,
          ).toEqual(shown)
          // A fresh store reads only the files, which cannot hold the reading
          // yet: the held lock keeps this store from writing it.
          expect(await onDisk(paths, lane, 'a')).toEqual({})
        } finally {
          holder.release()
          await adding
        }
      },
    )

    for (const replacement of [
      { change: 'credential epoch and identity', identity: 'acct-b' },
      { change: 'credential epoch only', identity: 'acct-a' },
    ])
      coalescing(
        `a reading queued before its row's ${replacement.change} changes is dropped with one warning`,
        async () => {
          const paths = await fixture()
          await seed(paths, lane, [['a', 'acct-a']])
          const log = warnings()
          const store = coalesced(paths, lane, { logger: log.logger })
          // The replacement holds the store locks across its writes, so the
          // queued readings cannot reach disk before the binding changes.
          const holder = lockHolder(paths, lane)
          const replacing = holder.store.replace('a', credential('a2'), {
            identity: replacement.identity,
          })
          await holder.holding
          await store.recordQuota(
            'a',
            epoch1('acct-a'),
            lane.observe(
              headerSnapshot('acct-a', 2_000, { five_hour: 12, seven_day: 41 }),
            ),
          )
          await store.recordQuota(
            'a',
            epoch1('acct-a'),
            lane.observe(
              pollSnapshot('acct-a', 1_000, {
                five_hour: 70,
                seven_day: 40,
                fable: 51,
              }),
            ),
          )
          holder.release()
          await replacing
          // The old binding's readings are no longer shown for the new one.
          expect(await facts(store, lane, 'a')).toEqual({})
          await store.recordQuota(
            'a',
            { credentialEpoch: 2, identity: replacement.identity },
            lane.observe(
              headerSnapshot(replacement.identity, 3_000, {
                five_hour: 5,
                seven_day: 6,
              }),
            ),
          )
          await closeStore(store)
          // Only the new binding's reading, never merged with the old Fable
          // window or extra usage.
          expect(await onDisk(paths, lane, 'a')).toEqual({
            five_hour: { usedPercent: 5, checkedAt: 3_000 },
            seven_day: { usedPercent: 6, checkedAt: 3_000 },
          })
          expect(
            log.seen.filter((line) => BINDING_CHANGED.test(line)),
          ).toHaveLength(1)
        },
      )

    coalescing(
      'readings for two accounts never merge into each other',
      async () => {
        const paths = await fixture()
        await seed(paths, lane, [
          ['a', 'acct-a'],
          ['b', 'acct-b'],
        ])
        const store = coalesced(paths, lane)
        await Promise.all([
          store.recordQuota(
            'a',
            epoch1('acct-a'),
            lane.observe(
              pollSnapshot('acct-a', 1_000, {
                five_hour: 70,
                seven_day: 40,
                fable: 51,
              }),
            ),
          ),
          store.recordQuota(
            'b',
            epoch1('acct-b'),
            lane.observe(
              headerSnapshot('acct-b', 2_000, { five_hour: 9, seven_day: 8 }),
            ),
          ),
        ])
        const a: Facts = {
          five_hour: { usedPercent: 70, checkedAt: 1_000 },
          seven_day: { usedPercent: 40, checkedAt: 1_000 },
          fable: { usedPercent: 51, checkedAt: 1_000 },
          extraUsagePercent: 19.225,
        }
        const b: Facts = {
          five_hour: { usedPercent: 9, checkedAt: 2_000 },
          seven_day: { usedPercent: 8, checkedAt: 2_000 },
        }
        expect([
          await facts(store, lane, 'a'),
          await facts(store, lane, 'b'),
        ]).toEqual([a, b])
        await closeStore(store)
        expect([
          await onDisk(paths, lane, 'a'),
          await onDisk(paths, lane, 'b'),
        ]).toEqual([a, b])
      },
    )

    coalescing(
      'close() writes an accepted reading within the drain bound',
      async () => {
        const paths = await fixture()
        await seed(paths, lane, [['a', 'acct-a']])
        const store = coalesced(paths, lane, {}, 2_000)
        await store.recordQuota(
          'a',
          epoch1('acct-a'),
          lane.observe(
            headerSnapshot('acct-a', 2_000, { five_hour: 12, seven_day: 41 }),
          ),
        )
        const started = performance.now()
        await closeStore(store)
        expect(performance.now() - started).toBeLessThan(2_000)
        expect(await onDisk(paths, lane, 'a')).toEqual({
          five_hour: { usedPercent: 12, checkedAt: 2_000 },
          seven_day: { usedPercent: 41, checkedAt: 2_000 },
        })
        await expect(
          store.recordQuota(
            'a',
            epoch1('acct-a'),
            lane.observe(
              headerSnapshot('acct-a', 3_000, { five_hour: 1, seven_day: 2 }),
            ),
          ),
        ).rejects.toMatchObject({ kind: 'invalid-input' })
      },
    )

    coalescing(
      'close() returns within its bound while the store locks are held',
      async () => {
        const paths = await fixture()
        await seed(paths, lane, [['a', 'acct-a']])
        const log = warnings()
        const holder = lockHolder(paths, lane)
        const adding = holder.store.add({
          id: 'z',
          identity: 'acct-z',
          credential: credential('z'),
        })
        await holder.holding
        const store = coalesced(paths, lane, { logger: log.logger }, 300)
        try {
          await store.recordQuota(
            'a',
            epoch1('acct-a'),
            lane.observe(
              headerSnapshot('acct-a', 2_000, { five_hour: 12, seven_day: 41 }),
            ),
          )
          const started = performance.now()
          await closeStore(store)
          const elapsed = performance.now() - started
          expect(elapsed).toBeGreaterThanOrEqual(250)
          expect(elapsed).toBeLessThan(1_500)
          expect(log.seen.some((line) => /drain timed out/.test(line))).toBe(
            true,
          )
        } finally {
          holder.release()
          await adding
        }
      },
    )

    coalescing(
      '200 readings survive a held lock and the 128-reading cap starts an early flush',
      async () => {
        const paths = await fixture()
        await seed(paths, lane, [['a', 'acct-a']])
        // A separate process renews the normal store leases while native codec
        // validation occupies this process; no unrelated row lease can expire.
        const holder = holdPoolStoreLocks(paths, {
          deferCleanup: (cleanup) => holderCleanup.push(cleanup),
        })
        await holder.ready
        let contended!: () => void
        const flushing = new Promise<void>((resolve) => {
          contended = resolve
        })
        let preflight129!: () => void
        const waitingForRoom = new Promise<void>((resolve) => {
          preflight129 = resolve
        })
        let scheduledCommits = 0
        // Leave ordinary scheduled commits pending so only the queue cap can
        // start the flush while the holder keeps the pool locks contended.
        const quotaCommitTimer: QuotaCommitTimer = {
          now: () => 0,
          schedule: () => {
            scheduledCommits++
            return { cancel() {} }
          },
        }
        const store = coalesced(
          paths,
          lane,
          {
            quota: {
              validate: (value) => lane.codec.validate(value),
              merge(stored, observation) {
                const merged = lane.codec.merge(stored, observation)
                if (
                  isQuotaMap(merged) &&
                  merged.limits.some(
                    (entry) => entry.label === 'seven_day:marker-128',
                  )
                )
                  preflight129()
                return merged
              },
            },
            onLockEvent: (event) => {
              if (event.type === 'contended') contended()
            },
          },
          5_000,
          quotaCommitTimer,
        )
        const observation = (index: number) => {
          const checkedAt = 1_000 + index
          const scoped = pollSnapshot('acct-a', checkedAt, {
            five_hour: 0,
            seven_day: 0,
            fable: index % 100,
          }).scoped?.[0]
          if (!scoped) throw new Error('Missing marker window')
          return lane.observe({
            accountIdentity: 'acct-a',
            source: 'headers',
            checkedAt,
            scoped: [{ ...scoped, id: `marker-${index}` }],
          })
        }
        let publishing: Promise<void> | undefined
        try {
          for (let index = 0; index < 128; index++)
            await store.recordQuota('a', epoch1('acct-a'), observation(index))
          expect(scheduledCommits).toBeGreaterThan(0)
          // No 129th recordQuota call has started, so its capacity check cannot
          // have triggered the flush.
          expect(
            await Promise.race([
              flushing.then(() => true),
              sleep(5_000).then(() => false),
            ]),
          ).toBe(true)
          let accepted = 128
          // Start all remaining calls while the lock is still held. The full
          // queue must make them wait for room rather than discard readings.
          publishing = Promise.all(
            Array.from({ length: 72 }, (_, offset) =>
              store
                .recordQuota('a', epoch1('acct-a'), observation(128 + offset))
                .then(() => {
                  accepted++
                }),
            ),
          ).then(() => {})
          await waitingForRoom
          expect(accepted).toBe(128)
          const pending = await store.read()
          const quota =
            pending.status === 'ready'
              ? pending.rows.find((row) => row.id === 'a')?.quota
              : undefined
          expect(isQuotaMap(quota) ? quota.limits.length : undefined).toBe(128)
          await holder.release()
          await publishing
          expect(accepted).toBe(200)
          await closeStore(store)
          const fresh = await plain(paths, lane).read()
          const written =
            fresh.status === 'ready'
              ? fresh.rows.find((row) => row.id === 'a')?.quota
              : undefined
          const expected = Array.from({ length: 200 }, (_, index) => ({
            scope: 'fable',
            label: `seven_day:marker-${index}`,
            kind: 'reading' as const,
            usedPercent: index % 100,
            checkedAt: 1_000 + index,
          }))
          // The codecs choose their own entry order; compare every marker's
          // contents without imposing queue order on the persisted map.
          const byLabel = (a: { label: string }, b: { label: string }) =>
            a.label.localeCompare(b.label)
          expect(
            isQuotaMap(written) ? [...written.limits].sort(byLabel) : undefined,
          ).toEqual(expected.sort(byLabel))
        } finally {
          await holder.release()
          await publishing
        }
      },
      60_000,
    )

    coalescing(
      'four processes publishing many readings on one pool all land without lock timeouts, even past another writer holding the lock',
      async () => {
        const paths = await fixture()
        const processes = 4
        const readings = 40
        const rows = Array.from(
          { length: processes },
          (_, index) => [`r${index}`, `acct-${index}`] as const,
        )
        await seed(paths, lane, rows)
        const ready = join(paths.config, '..', 'ready')
        await mkdir(ready)
        const go = join(ready, 'go')
        const child = new URL(
          './pool-store-coalescing-child.ts',
          import.meta.url,
        ).pathname
        const children = Array.from({ length: processes }, (_, index) =>
          Bun.spawn(
            [
              process.execPath,
              child,
              lane.name,
              paths.config,
              paths.state,
              String(index),
              String(readings),
              ready,
            ],
            { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
          ),
        )
        try {
          const marked = async (prefix: string) =>
            (await readdir(ready)).filter((name) => name.startsWith(prefix))
              .length
          const until = async (prefix: string, what: string) => {
            const by = Date.now() + 20_000
            while ((await marked(prefix)) < processes) {
              if (Date.now() > by || children.some((c) => c.exitCode !== null))
                throw new Error(`Quota processes did not ${what}`)
              await sleep(25)
            }
          }
          await until('ready-', 'start')
          // Another writer holds the store locks while every process publishes
          // and starts its shutdown drain, so each process's flushes miss their
          // short lock wait and must retry, rather than lose or refuse readings.
          const holder = lockHolder(paths, lane)
          const adding = holder.store.add({
            id: 'z',
            identity: 'acct-z',
            credential: credential('z'),
          })
          await holder.holding
          try {
            await writeFile(go, '')
            await until('done-', 'finish publishing')
            await sleep(300)
          } finally {
            holder.release()
            await adding
          }
          const reports = await Promise.all(
            children.map(async (process) => {
              const [stdout, stderr, code] = await Promise.all([
                new Response(process.stdout).text(),
                new Response(process.stderr).text(),
                process.exited,
              ])
              if (code !== 0)
                throw new Error(
                  `quota process exited ${code}: ${stderr.trim()}`,
                )
              return JSON.parse(stdout.trim().split('\n').at(-1) ?? '') as {
                index: number
                accepted: number
                rejected: string[]
                warnings: string[]
                merges: number
                usesNativeCodec: boolean
                closeMs: number
              }
            }),
          )
          for (const report of reports) {
            expect({ index: report.index, rejected: report.rejected }).toEqual({
              index: report.index,
              rejected: [],
            })
            expect(report.accepted).toBe(readings)
            expect(
              report.warnings.filter((line) => /timed out/.test(line)),
            ).toEqual([])
            // The held lock did make this process's flushes wait and retry.
            expect(report.warnings.some((line) => /retrying/.test(line))).toBe(
              true,
            )
            // The codec the child passed in did the merging, not common-auth's
            // built-in `quotaCodec`.
            expect(report.merges).toBeGreaterThan(0)
            expect(report.usesNativeCodec).toBe(lane.codec === nativeQuotaCodec)
          }
          // Each process's last reading is its row's newest, so it must be the
          // one on disk.
          for (const [index, [id]] of rows.entries()) {
            const last = readings - 1
            const checkedAt = 1_000_000 + last
            expect(await onDisk(paths, lane, id)).toEqual({
              five_hour: { usedPercent: index * 10 + (last % 10), checkedAt },
              seven_day: { usedPercent: last, checkedAt },
            })
          }
        } finally {
          for (const process of children) process.kill()
          await Promise.all(children.map((process) => process.exited))
        }
      },
      60_000,
    )
  })
}
