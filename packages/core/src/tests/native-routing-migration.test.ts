import { expect, spyOn, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  migrateStickyRoutingState,
  type StickyRouteAssignment,
  StickySessionRouter,
} from '../sticky-routing.ts'

function assignment(
  accountId = 'main',
  overrides: Partial<StickyRouteAssignment> = {},
): StickyRouteAssignment {
  return {
    accountId,
    family: 'fable',
    affinityModelId: 'claude-fable-5',
    assignedAt: 11,
    lastSeenAt: 23,
    initialInputBytes: 4096.5,
    quotaCheckedAt: 37,
    ...overrides,
  }
}

function source(
  assignments: Record<string, unknown> = { session: assignment() },
) {
  return { version: 1, updatedAt: 713, assignments }
}

const proven = new Map([
  ['main', 'former-main-row'],
  ['fallback', 'fallback-row'],
])

function expectInvalid(
  input: unknown,
  map: ReadonlyMap<string, string> = proven,
) {
  let caught: unknown
  try {
    migrateStickyRoutingState(input, map)
  } catch (error) {
    caught = error
  }
  expect(caught).toBeInstanceOf(Error)
  expect((caught as Error).message).toBe('invalid-source')
  expect(Object.hasOwn(caught as Error, 'cause')).toBe(false)
}

test('serializes exact UTF-8 journal bytes with explicit main and fallback remaps', () => {
  // Source field order is intentionally unlike the normalizer's output order.
  const input = {
    assignments: {
      'z-session': {
        quotaCheckedAt: 37,
        lastSeenAt: 23,
        accountId: 'main',
        assignedAt: 11,
        initialInputBytes: 4096.5,
        affinityModelId: 'claude-fable-café-💻',
        family: 'fable',
      },
      'a-session': assignment('fallback', {
        family: 'opus',
        affinityModelId: 'claude-opus-4-8',
        assignedAt: 12,
        lastSeenAt: 24,
        initialInputBytes: 8,
        quotaCheckedAt: 38,
      }),
    },
    updatedAt: 713,
    version: 1,
  }
  const expected = `{
  "version": 1,
  "updatedAt": 713,
  "assignments": {
    "z-session": {
      "accountId": "former-main-row",
      "family": "fable",
      "affinityModelId": "claude-fable-café-💻",
      "assignedAt": 11,
      "lastSeenAt": 23,
      "initialInputBytes": 4096.5,
      "quotaCheckedAt": 37
    },
    "a-session": {
      "accountId": "fallback-row",
      "family": "opus",
      "affinityModelId": "claude-opus-4-8",
      "assignedAt": 12,
      "lastSeenAt": 24,
      "initialInputBytes": 8,
      "quotaCheckedAt": 38
    }
  }
}
`
  expect(migrateStickyRoutingState(input, proven)).toBe(expected)
  expect(Buffer.from(migrateStickyRoutingState(input, proven), 'utf8')).toEqual(
    Buffer.from(expected, 'utf8'),
  )
})

test('is deterministic across changing clocks and map insertion orders without reading time', () => {
  const clock = spyOn(Date, 'now').mockReturnValue(1)
  try {
    const input = source()
    const first = migrateStickyRoutingState(input, proven)
    clock.mockReturnValue(9_000_000_000_000)
    expect(
      migrateStickyRoutingState(input, new Map([...proven].reverse())),
    ).toBe(first)
    clock.mockImplementation(() => {
      throw new Error('clock must not be read')
    })
    expect(migrateStickyRoutingState(input, proven)).toBe(first)
    expect(clock).not.toHaveBeenCalled()
  } finally {
    clock.mockRestore()
  }
})

test('timestamp control carries source updatedAt rather than replacing it', () => {
  const migrated = JSON.parse(migrateStickyRoutingState(source(), proven))
  expect(migrated.updatedAt).toBe(713)
})

test('clamping control refuses negative bytes even in an orphan assignment', () => {
  for (const accountId of ['main', 'unproven-private-row']) {
    expectInvalid(
      source({ session: assignment(accountId, { initialInputBytes: -0.25 }) }),
    )
  }
})

test('orphan control drops unproven main and fallback without selecting another row', () => {
  const input = source({
    mainSession: assignment(),
    orphanSession: assignment('missing'),
    survivor: assignment('fallback', { initialInputBytes: 8 }),
  })
  const migrated = JSON.parse(
    migrateStickyRoutingState(input, new Map([['fallback', 'explicit-row']])),
  )
  expect(Object.keys(migrated.assignments)).toEqual(['survivor'])
  expect(migrated.assignments.survivor.accountId).toBe('explicit-row')
  expect(migrated.assignments.survivor.initialInputBytes).toBe(8)
})

test('a present source yields journal bytes even when every assignment is orphaned', () => {
  expect(migrateStickyRoutingState(source(), new Map())).toBe(
    '{\n  "version": 1,\n  "updatedAt": 713,\n  "assignments": {}\n}\n',
  )
})

test('proven aliases share a concrete row without merging sessions or changing deficit clocks', () => {
  const input = source({
    first: assignment('main', { initialInputBytes: 400 }),
    second: assignment('alias', { initialInputBytes: 700 }),
    staleQuota: assignment('alias', {
      initialInputBytes: 9999,
      quotaCheckedAt: 36,
    }),
  })
  const migrated = JSON.parse(
    migrateStickyRoutingState(
      input,
      new Map([
        ['main', 'concrete-row'],
        ['alias', 'concrete-row'],
      ]),
    ),
  )
  expect(Object.keys(migrated.assignments)).toEqual([
    'first',
    'second',
    'staleQuota',
  ])
  for (const value of Object.values(
    migrated.assignments,
  ) as StickyRouteAssignment[]) {
    expect(value.accountId).toBe('concrete-row')
    expect(value.assignedAt).toBe(11)
    expect(value.lastSeenAt).toBe(23)
  }
  expect(migrated.assignments.first.quotaCheckedAt).toBe(37)
  expect(migrated.assignments.second.quotaCheckedAt).toBe(37)
  expect(migrated.assignments.staleQuota.quotaCheckedAt).toBe(36)
  expect(migrated.assignments.first.initialInputBytes).toBe(400)
  expect(migrated.assignments.second.initialInputBytes).toBe(700)
  expect(migrated.assignments.staleQuota.initialInputBytes).toBe(9999)
})

test('preserved quota timestamps causally retain only matching deficits in the real router', async () => {
  const root = await mkdtemp(join(tmpdir(), 'native-routing-migration-'))
  try {
    const path = join(root, 'routing.json')
    const hash = (id: string) => createHash('sha256').update(id).digest('hex')
    const input = source({
      [hash('charged')]: assignment('main', { initialInputBytes: 400 }),
      [hash('stale')]: assignment('fallback', {
        initialInputBytes: 9000,
        quotaCheckedAt: 36,
      }),
      [hash('orphan')]: assignment('orphan', { initialInputBytes: 99999 }),
    })
    const candidates = ['former-main-row', 'fallback-row'].map(
      (accountId, order) => ({
        accountId,
        order,
        quota: {
          checkedAt: 37,
          five_hour: { usedPercent: 0, remainingPercent: 100, checkedAt: 37 },
          seven_day: { usedPercent: 0, remainingPercent: 100, checkedAt: 37 },
        },
      }),
    )
    const resolve = async (checkedAt: number) => {
      await writeFile(path, migrateStickyRoutingState(input, proven))
      const router = new StickySessionRouter({ path, now: () => 100 })
      return router.resolve({
        sessionId: 'fresh',
        family: 'general',
        inputBytes: 1,
        storage: null,
        retainAccountIds: new Set(candidates.map(({ accountId }) => accountId)),
        candidates: candidates.map((candidate) => ({
          ...candidate,
          quota: { ...candidate.quota, checkedAt },
        })),
      })
    }
    expect((await resolve(37))?.accountId).toBe('fallback-row')
    // Moving the snapshot clock beyond the preserved clock removes the charge;
    // the ordinary equal-weight tie then selects the first candidate again.
    expect((await resolve(38))?.accountId).toBe('former-main-row')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('retains old histories above the runtime assignment cap without pruning', () => {
  const assignments = Object.fromEntries(
    Array.from({ length: 4200 }, (_, index) => [
      `session-${index}`,
      assignment('main', {
        assignedAt: 1,
        lastSeenAt: 2,
        initialInputBytes: index + 0.5,
      }),
    ]),
  )
  const migrated = JSON.parse(
    migrateStickyRoutingState(source(assignments), proven),
  )
  expect(Object.keys(migrated.assignments)).toHaveLength(4200)
  expect(migrated.assignments['session-0']).toEqual({
    ...assignment('former-main-row'),
    assignedAt: 1,
    lastSeenAt: 2,
    initialInputBytes: 0.5,
  })
  expect(migrated.assignments['session-4199'].lastSeenAt).toBe(2)
  expect(migrated.assignments['session-4199'].initialInputBytes).toBe(4199.5)
})

test('legacy absent affinity stays absent and empty string affinity is not guessed', () => {
  const legacy: Partial<StickyRouteAssignment> = assignment()
  delete legacy.affinityModelId
  const migrated = JSON.parse(
    migrateStickyRoutingState(
      source({ legacy, empty: assignment('main', { affinityModelId: '' }) }),
      proven,
    ),
  )
  expect(Object.hasOwn(migrated.assignments.legacy, 'affinityModelId')).toBe(
    false,
  )
  expect(migrated.assignments.empty.affinityModelId).toBe('')
})

test('does not invent stricter legacy account, key or finite-number constraints', () => {
  const input = source({
    '': assignment('', {
      family: 'general',
      assignedAt: -1.5,
      lastSeenAt: -7,
      initialInputBytes: 0.5,
      quotaCheckedAt: -2.25,
    }),
  })
  input.updatedAt = -0.75
  const migrated = JSON.parse(
    migrateStickyRoutingState(input, new Map([['', 'row:synthetic']])),
  )
  expect(migrated.updatedAt).toBe(-0.75)
  expect(migrated.assignments['']).toEqual({
    accountId: 'row:synthetic',
    family: 'general',
    affinityModelId: 'claude-fable-5',
    assignedAt: -1.5,
    lastSeenAt: -7,
    initialInputBytes: 0.5,
    quotaCheckedAt: -2.25,
  })
})

test.each([
  ['absent', undefined],
  ['null', null],
  ['array', []],
  ['scalar', 'private-source'],
  ['empty', {}],
  ['wrong version', { ...source(), version: 2 }],
  ['string version', { ...source(), version: '1' }],
  ['missing assignments', { version: 1, updatedAt: 713 }],
  ['null assignments', { ...source(), assignments: null }],
  ['array assignments', { ...source(), assignments: [] }],
  ['extra root data', { ...source(), privateToken: 'synthetic-private-token' }],
])('refuses malformed root: %s', (_name, input) => {
  expectInvalid(input)
})

test('refuses missing updatedAt rather than accepting the normalizer zero default', () => {
  expectInvalid({ version: 1, assignments: {} })
})

test.each([
  ['null', null],
  ['undefined', undefined],
  ['string', '713'],
  ['boolean', false],
  ['object', {}],
  ['array', []],
  ['NaN', NaN],
  ['Infinity', Infinity],
  ['-Infinity', -Infinity],
])('refuses invalid updatedAt: %s', (_name, updatedAt) => {
  expectInvalid({ ...source(), updatedAt })
})

test.each([
  ['null', null],
  ['array', []],
  ['scalar', 'synthetic-private-token'],
  ['bad account', assignment(undefined, { accountId: 1 as unknown as string })],
  ['bad family', { ...assignment(), family: 'mythos' }],
  [
    'throwing family conversion',
    { ...assignment(), family: { toString: 'private' } },
  ],
  ['string timestamp', { ...assignment(), assignedAt: '11' }],
  ['null timestamp', { ...assignment(), lastSeenAt: null }],
  ['infinite timestamp', { ...assignment(), quotaCheckedAt: Infinity }],
  ['nonfinite bytes', { ...assignment(), initialInputBytes: NaN }],
  ['null affinity', { ...assignment(), affinityModelId: null }],
  ['undefined affinity', { ...assignment(), affinityModelId: undefined }],
  ['array affinity', { ...assignment(), affinityModelId: [] }],
  ['numeric affinity', { ...assignment(), affinityModelId: 42 }],
  ['object affinity', { ...assignment(), affinityModelId: {} }],
  ['extra field', { ...assignment(), token: 'synthetic-private-token' }],
  ['extra dictionary field', { ...assignment(), constructor: 'private' }],
])(
  'refuses rejected or altered assignment in mapped and orphan rows: %s',
  (_name, value) => {
    expectInvalid(source({ session: value }))
    expectInvalid(source({ session: value }), new Map())
  },
)

test('preserves a family value accepted unchanged by the pinned normalizer', () => {
  // The normalizer checks String(family) but retains the original family value.
  // Migration must not silently coerce it or invent a stricter schema here.
  const migrated = JSON.parse(
    migrateStickyRoutingState(
      source({ session: { ...assignment(), family: ['fable'] } }),
      proven,
    ),
  )
  expect(migrated.assignments.session.family).toEqual(['fable'])
})

test('refuses each missing required assignment field even when its account is unmapped', () => {
  for (const field of [
    'accountId',
    'family',
    'assignedAt',
    'lastSeenAt',
    'initialInputBytes',
    'quotaCheckedAt',
  ]) {
    const value: Record<string, unknown> = { ...assignment() }
    delete value[field]
    expectInvalid(source({ session: value }))
    expectInvalid(source({ session: value }), new Map())
  }
})

test.each(['', ' ', ' row', 'row ', null, undefined, 1])(
  'refuses unusable concrete map values, including unused entries: %p',
  (value) => {
    for (const key of ['main', 'unused']) {
      expectInvalid(source(), new Map([[key, value as string]]))
    }
  },
)

test('preserves dangerous dictionary keys without prototype writes or hidden loss', () => {
  const keys = [
    '2',
    '10',
    '__proto__',
    'constructor',
    'prototype',
    'toString',
    'toJSON',
  ]
  const input = JSON.parse(
    JSON.stringify(
      source(Object.fromEntries(keys.map((key) => [key, assignment()]))),
    ),
  )
  const migrated = JSON.parse(migrateStickyRoutingState(input, proven))
  expect(Object.keys(migrated.assignments)).toEqual(keys)
  for (const key of keys) {
    expect(Object.hasOwn(migrated.assignments, key)).toBe(true)
    expect(migrated.assignments[key]).toEqual(assignment('former-main-row'))
    expect(input.assignments[key]).toEqual(assignment())
  }
  expect(Object.getPrototypeOf(input.assignments)).toBe(Object.prototype)
  const invalid = JSON.parse(
    JSON.stringify(
      source(
        Object.fromEntries([['__proto__', { ...assignment(), extra: true }]]),
      ),
    ),
  )
  expectInvalid(invalid, new Map())
})

test('does not mutate frozen sources or read-only maps on success or refusal', () => {
  const input = Object.freeze(
    source(Object.freeze({ session: Object.freeze(assignment()) })),
  )
  const invalid = Object.freeze(
    source(
      Object.freeze({
        session: Object.freeze({ ...assignment(), extra: true }),
      }),
    ),
  )
  const map = new Map(proven)
  for (const method of ['set', 'delete', 'clear'] as const) {
    Object.defineProperty(map, method, {
      value: () => {
        throw new Error('map must not be mutated')
      },
    })
  }
  Object.freeze(map)
  const sourceBefore = JSON.stringify(input)
  const invalidBefore = JSON.stringify(invalid)
  const mapBefore = [...map]
  expect(
    JSON.parse(migrateStickyRoutingState(input, map)).assignments.session
      .accountId,
  ).toBe('former-main-row')
  expectInvalid(invalid, map)
  expect(JSON.stringify(input)).toBe(sourceBefore)
  expect(JSON.stringify(invalid)).toBe(invalidBefore)
  expect([...map]).toEqual(mapBefore)
})
