import { describe, expect, spyOn, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_ROUTE_PREFIX,
  mutateVaultRoster,
  projectVaultRoster,
  readVaultRoster,
  type VaultRosterFile,
} from '@cortexkit/common-auth/claustrum'
import { moduleReferences } from '../../scripts/check-native-type-closure.ts'
import {
  buildNativeVaultRosterSeed,
  NativeRosterSeedError,
  type NativeRosterSeedErrorCode,
  type NativeRosterSeedInput,
  type NativeVaultRosterDocument,
  type NativeVaultRosterSeed,
  validateNativeVaultRosterSeed,
} from '../native-roster-seed.ts'

type Assert<T extends true> = T
// Compile-only type checks, no runtime assertion: NativeVaultRosterSeed must
// be assignable to the published VaultRosterFile (a built seed can be written
// as a roster file), and VaultRosterFile must be assignable to
// NativeVaultRosterDocument (a file the published reader returns can be
// passed to the seed check). The producer types stay in tests only.
export type SeedIsRosterFile = Assert<
  NativeVaultRosterSeed extends VaultRosterFile ? true : false
>
export type RosterFileIsDocument = Assert<
  VaultRosterFile extends NativeVaultRosterDocument ? true : false
>

type Mutable<T> = { -readonly [K in keyof T]: Mutable<T[K]> }
type Input = Mutable<NativeRosterSeedInput>

/** A fresh, independently owned healthy input for every use. */
function healthy(): Input {
  return {
    inventory: {
      view: 'view-1',
      credentials: [
        {
          credentialId: 'oauth:anthropic',
          credentialType: 'oauth',
          accountIdentity: 'acct-primary',
          state: 'active',
          email: 'primary@example.test',
        },
        {
          credentialId: 'oauth:anthropic:work',
          credentialType: 'oauth',
          accountIdentity: 'acct-work',
          state: 'active',
        },
        {
          credentialId: 'oauth:anthropic:old',
          credentialType: 'oauth',
          accountIdentity: 'acct-old',
          state: 'cold',
        },
        {
          credentialId: 'oauth:anthropic:spare',
          credentialType: 'oauth',
          accountIdentity: 'acct-spare',
          state: 'active',
        },
      ],
      skipped: [],
    },
    primary: {
      credentialId: 'oauth:anthropic',
      accountIdentity: 'acct-primary',
    },
    primaryRouteId: 'former-main-route',
    legacyRows: [
      {
        routeId: 'work-route',
        scopedCredentialId: 'oauth:anthropic:work',
        anthropicAccountUuid: 'acct-work',
        label: 'Work account',
        addedAt: 1_700_000_000_000,
        enabled: true,
      },
      {
        routeId: 'old-route',
        scopedCredentialId: 'oauth:anthropic:old',
        anthropicAccountUuid: 'acct-old',
        enabled: false,
      },
    ],
    disabledAccountIdentities: ['acct-old'],
    reservedRouteIds: ['api-route'],
  }
}

/**
 * Run a public call and report 'accepted' or the NativeRosterSeedError code.
 * Any other error is rethrown, so a raw exception fails the test.
 */
function refusal(run: () => unknown): NativeRosterSeedErrorCode | 'accepted' {
  try {
    run()
    return 'accepted'
  } catch (error) {
    if (error instanceof NativeRosterSeedError) return error.code
    throw error
  }
}

/** Collect identifiers, labels and view text that error diagnostics must not reveal. */
function capturedStrings(input: Input): string[] {
  return [
    input.inventory.view,
    input.primaryRouteId,
    input.primary.credentialId,
    input.primary.accountIdentity,
    ...input.legacyRows.flatMap((row) => [
      row.routeId,
      row.scopedCredentialId ?? '',
      row.anthropicAccountUuid ?? '',
      row.label ?? '',
    ]),
    ...input.reservedRouteIds,
  ].filter(Boolean)
}

describe('buildNativeVaultRosterSeed', () => {
  test('builds a deterministic complete seed the published reader accepts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'native-roster-seed-'))
    try {
      const seed = buildNativeVaultRosterSeed(healthy())
      expect(buildNativeVaultRosterSeed(healthy())).toEqual(seed)
      expect(JSON.stringify(buildNativeVaultRosterSeed(healthy()))).toBe(
        JSON.stringify(seed),
      )
      expect(seed).toEqual({
        version: 1,
        view: 'view-1',
        complete: true,
        rows: [
          {
            routeId: 'former-main-route',
            credentialId: 'oauth:anthropic',
            credentialType: 'oauth',
            accountIdentity: 'acct-primary',
            state: 'active',
            label: 'former-main-route',
            enabled: true,
            addedAt: 0,
          },
          {
            routeId: 'work-route',
            credentialId: 'oauth:anthropic:work',
            credentialType: 'oauth',
            accountIdentity: 'acct-work',
            state: 'active',
            label: 'Work account',
            enabled: true,
            addedAt: 1_700_000_000_000,
          },
          {
            routeId: 'old-route',
            credentialId: 'oauth:anthropic:old',
            credentialType: 'oauth',
            accountIdentity: 'acct-old',
            state: 'cold',
            label: 'old-route',
            enabled: false,
            addedAt: 0,
          },
        ],
        declined: [
          { credentialId: 'oauth:anthropic:old', accountIdentity: 'acct-old' },
        ],
      })

      const path = join(root, 'roster.json')
      await writeFile(path, JSON.stringify(seed))
      expect(await readVaultRoster(path)).toEqual(seed)

      // The next discovery over the same complete list keeps every seeded
      // route id and only adds the unseeded account under the default prefix.
      const projected = projectVaultRoster(seed, healthy().inventory, {
        reservedRouteIds: new Set(['api-route']),
        now: 5,
      })
      const added = projected.rows[3]?.routeId ?? ''
      expect(added.startsWith(DEFAULT_ROUTE_PREFIX)).toBe(true)
      expect(
        projected.rows.map((row) => [row.routeId, row.enabled, row.addedAt]),
      ).toEqual([
        ['former-main-route', true, 0],
        ['work-route', true, 1_700_000_000_000],
        ['old-route', false, 0],
        [added, true, 5],
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('keeps primary and fallback route ids, labels, added times and disable intent', () => {
    const input = healthy()
    input.disabledAccountIdentities = ['acct-primary', 'acct-work']
    input.legacyRows[0] = { ...input.legacyRows[0]!, label: '   ' }
    input.legacyRows[1] = {
      ...input.legacyRows[1]!,
      label: 'Old account',
      addedAt: 42,
    }
    const seed = buildNativeVaultRosterSeed(input)
    expect(
      seed.rows.map((row) => [
        row.routeId,
        row.label,
        row.addedAt,
        row.enabled,
      ]),
    ).toEqual([
      ['former-main-route', 'former-main-route', 0, false],
      // The legacy row's own enable choice wins over the disabled list.
      ['work-route', 'work-route', 1_700_000_000_000, true],
      ['old-route', 'Old account', 42, false],
    ])
    expect(seed.declined).toEqual([
      { credentialId: 'oauth:anthropic', accountIdentity: 'acct-primary' },
      { credentialId: 'oauth:anthropic:old', accountIdentity: 'acct-old' },
    ])
  })

  test('declines a disabled listed account without a seed row by its lowest credential id', () => {
    const input = healthy()
    input.inventory.credentials.push({
      credentialId: 'oauth:anthropic:a-spare',
      credentialType: 'oauth',
      accountIdentity: 'acct-spare',
      state: 'active',
    })
    input.disabledAccountIdentities = ['acct-spare', 'acct-gone', 'acct-old']
    const seed = buildNativeVaultRosterSeed(input)
    expect(seed.rows.map((row) => row.routeId)).toEqual([
      'former-main-route',
      'work-route',
      'old-route',
    ])
    // An account the vault does not list cannot be named by a credential.
    expect(seed.declined).toEqual([
      { credentialId: 'oauth:anthropic:old', accountIdentity: 'acct-old' },
      {
        credentialId: 'oauth:anthropic:a-spare',
        accountIdentity: 'acct-spare',
      },
    ])
    const projected = projectVaultRoster(seed, input.inventory, { now: 1 })
    expect(
      projected.rows.find((row) => row.accountIdentity === 'acct-spare')
        ?.enabled,
    ).toBe(false)
  })

  const refusals: [
    string,
    NativeRosterSeedErrorCode,
    (input: Input) => void,
  ][] = [
    [
      'a skipped record makes the list incomplete',
      'roster-incomplete',
      (input) => {
        input.inventory.skipped.push({
          credentialId: 'oauth:anthropic:bad',
          reason: 'empty state',
        })
      },
    ],
    [
      'a skipped record with no id makes the list incomplete',
      'roster-incomplete',
      (input) => {
        input.inventory.skipped.push({ reason: 'empty credential id' })
      },
    ],
    [
      'a blank view is not a verified list',
      'roster-incomplete',
      (input) => {
        input.inventory.view = ''
      },
    ],
    [
      'an unrelated record without an account is unasserted',
      'roster-incomplete',
      (input) => {
        delete input.inventory.credentials[3]!.accountIdentity
      },
    ],
    [
      'a duplicated credential id is ambiguous',
      'roster-incomplete',
      (input) => {
        input.inventory.credentials.push({
          ...input.inventory.credentials[3]!,
          accountIdentity: 'acct-other',
        })
      },
    ],
    [
      'the primary credential is not listed',
      'roster-incomplete',
      (input) => {
        input.inventory.credentials.shift()
      },
    ],
    [
      'the primary is listed for another account',
      'roster-incomplete',
      (input) => {
        input.primary.accountIdentity = 'acct-elsewhere'
      },
    ],
    [
      'the captured primary has no account',
      'roster-incomplete',
      (input) => {
        input.primary.accountIdentity = ''
      },
    ],
    [
      'the primary is listed as an API key',
      'roster-incomplete',
      (input) => {
        input.inventory.credentials[0]!.credentialType = 'api_key'
      },
    ],
    [
      'a legacy row has no account',
      'roster-incomplete',
      (input) => {
        delete input.legacyRows[0]!.anthropicAccountUuid
      },
    ],
    [
      'a legacy credential is not listed',
      'roster-incomplete',
      (input) => {
        input.inventory.credentials.splice(1, 1)
      },
    ],
    [
      'a legacy credential is listed for another account',
      'roster-incomplete',
      (input) => {
        input.inventory.credentials[1]!.accountIdentity = 'acct-moved'
      },
    ],
    [
      'a legacy OAuth row was never enrolled',
      'unenrolled-local-row',
      (input) => {
        delete input.legacyRows[1]!.scopedCredentialId
      },
    ],
    [
      'a legacy OAuth row has a blank enrollment',
      'unenrolled-local-row',
      (input) => {
        input.legacyRows[0]!.scopedCredentialId = ' '
      },
    ],
    [
      'the primary route is main',
      'roster-route-conflict',
      (input) => {
        input.primaryRouteId = 'main'
      },
    ],
    [
      'a legacy route is main',
      'roster-route-conflict',
      (input) => {
        input.legacyRows[0]!.routeId = 'main'
      },
    ],
    [
      'a legacy route repeats the primary route',
      'roster-route-conflict',
      (input) => {
        input.legacyRows[1]!.routeId = 'former-main-route'
      },
    ],
    [
      'two legacy rows share a route',
      'roster-route-conflict',
      (input) => {
        input.legacyRows[1]!.routeId = 'work-route'
      },
    ],
    [
      'a legacy route takes an imported API route',
      'roster-route-conflict',
      (input) => {
        input.legacyRows[0]!.routeId = 'api-route'
      },
    ],
    [
      'the primary route takes an imported API route',
      'roster-route-conflict',
      (input) => {
        input.primaryRouteId = 'api-route'
      },
    ],
    [
      'a legacy row is a second login of the primary account',
      'seed-conflict',
      (input) => {
        input.inventory.credentials[1]!.accountIdentity = 'acct-primary'
        input.legacyRows[0]!.anthropicAccountUuid = 'acct-primary'
      },
    ],
    [
      'two legacy rows log into one account',
      'seed-conflict',
      (input) => {
        input.inventory.credentials[2]!.accountIdentity = 'acct-work'
        input.legacyRows[1]!.anthropicAccountUuid = 'acct-work'
      },
    ],
    [
      'two legacy rows name one credential',
      'seed-conflict',
      (input) => {
        input.legacyRows[1]!.scopedCredentialId = 'oauth:anthropic:work'
        input.legacyRows[1]!.anthropicAccountUuid = 'acct-work'
      },
    ],
    [
      'a legacy added time is not a finite number',
      'seed-conflict',
      (input) => {
        input.legacyRows[0]!.addedAt = Number.NaN
      },
    ],
  ]

  for (const [name, code, mutate] of refusals) {
    test(`refuses ${code}: ${name}`, () => {
      // The unmodified healthy input must still build, so the refusal comes
      // from the one mutation and not from a broken fixture.
      expect(refusal(() => buildNativeVaultRosterSeed(healthy()))).toBe(
        'accepted',
      )
      const input = healthy()
      mutate(input)
      expect(refusal(() => buildNativeVaultRosterSeed(input))).toBe(code)
      expect(refusal(() => buildNativeVaultRosterSeed(healthy()))).toBe(
        'accepted',
      )
    })
  }

  test('refusals carry only a fixed code, never captured values or a cause', () => {
    const input = healthy()
    input.legacyRows[0]!.anthropicAccountUuid = 'acct-secretive'
    let caught: unknown
    try {
      buildNativeVaultRosterSeed(input)
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(NativeRosterSeedError)
    const error = caught as NativeRosterSeedError
    expect(error.code).toBe('roster-incomplete')
    expect(error.message).toBe('Native roster seed refused: roster-incomplete')
    expect(error.cause).toBeUndefined()
    const surfaces = [
      error.message,
      JSON.stringify(error),
      Bun.inspect(error),
      String(error),
    ]
    for (const surface of surfaces) {
      for (const value of [...capturedStrings(input), 'acct-secretive']) {
        expect(surface.includes(value)).toBe(false)
      }
    }
    // A code outside the closed set falls back to seed-conflict.
    expect(
      new NativeRosterSeedError('oauth:anthropic' as NativeRosterSeedErrorCode)
        .code,
    ).toBe('seed-conflict')
  })

  test('performs no provider request and imports no runtime dependency', async () => {
    const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((() => {
      throw new Error('provider request attempted')
    }) as unknown as typeof fetch)
    try {
      const input = healthy()
      const seed = buildNativeVaultRosterSeed(input)
      validateNativeVaultRosterSeed(seed, input)
      expect(
        refusal(() =>
          buildNativeVaultRosterSeed({ ...input, primaryRouteId: 'main' }),
        ),
      ).toBe('roster-route-conflict')
      expect(fetchSpy).not.toHaveBeenCalled()
    } finally {
      fetchSpy.mockRestore()
    }
    // The only runtime import is the proxy detector from node:util; the
    // NativeCustodyInventory import is type-only and compiles away. Nothing
    // the module imports can list, read, refresh or reach the network.
    const source = await readFile(
      new URL('../native-roster-seed.ts', import.meta.url),
      'utf8',
    )
    expect(
      new Bun.Transpiler({ loader: 'ts' })
        .scan(source)
        .imports.map((edge) => edge.path),
    ).toEqual(['node:util'])
    expect(source.match(/^import .*$/gm)).toEqual([
      "import { types } from 'node:util'",
      "import type { NativeCustodyInventory } from './native-custody.ts'",
    ])
    expect(source).not.toMatch(/\b(?:require|import)\s*\(/)
  })
})

describe('validateNativeVaultRosterSeed', () => {
  test('keeps an existing seed byte for byte across a changed view and state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'native-roster-seed-'))
    try {
      const path = join(root, 'roster.json')
      const original = buildNativeVaultRosterSeed(healthy())
      // Email and organisation metadata the reader retains are not judged by
      // the seed check and must not cause a refusal.
      const stored = {
        ...original,
        rows: original.rows.map((row, index) =>
          index === 0
            ? { ...row, email: 'primary@example.test', orgName: 'Org' }
            : row,
        ),
      }
      const bytes = `${JSON.stringify(stored, null, 2)}\n`
      await writeFile(path, bytes)

      const later = healthy()
      later.inventory.view = 'view-2'
      later.inventory.credentials[0]!.state = 'cold'
      later.inventory.credentials[2]!.state = 'active'
      later.inventory.credentials.push({
        credentialId: 'oauth:anthropic:new',
        credentialType: 'oauth',
        accountIdentity: 'acct-new',
        state: 'active',
      })
      // A fresh seed from the later list differs, so a byte comparison with a
      // rebuilt seed would refuse this harmless change.
      expect(JSON.stringify(buildNativeVaultRosterSeed(later))).not.toBe(
        JSON.stringify(original),
      )

      const existing = await readVaultRoster(path)
      expect(existing).toBeDefined()
      const snapshot = structuredClone(existing)
      expect(validateNativeVaultRosterSeed(existing!, later)).toBeUndefined()
      expect(existing).toEqual(snapshot!)

      // mutateVaultRoster leaves the file unchanged when the callback returns
      // no next roster.
      const outcome = await mutateVaultRoster(path, (current) => {
        if (!current) throw new Error('seed missing')
        validateNativeVaultRosterSeed(current, later)
        return { result: 'kept' as const }
      })
      expect(outcome).toBe('kept')
      expect(await readFile(path, 'utf8')).toBe(bytes)
      expect((await readVaultRoster(path))?.view).toBe('view-1')
      expect((await readVaultRoster(path))?.rows[0]?.state).toBe('active')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('judges a decline for an account without a seed row by account and disable intent', () => {
    const input = healthy()
    input.disabledAccountIdentities = ['acct-old', 'acct-spare']
    const seed = buildNativeVaultRosterSeed(input)
    const later = healthy()
    later.disabledAccountIdentities = ['acct-old', 'acct-spare']
    later.inventory.credentials.push({
      credentialId: 'oauth:anthropic:0-spare',
      credentialType: 'oauth',
      accountIdentity: 'acct-spare',
      state: 'active',
    })
    expect(refusal(() => validateNativeVaultRosterSeed(seed, later))).toBe(
      'accepted',
    )
    // The disabled account's credential was removed from the vault: its
    // decline is still accepted.
    const gone = healthy()
    gone.disabledAccountIdentities = ['acct-old', 'acct-spare']
    gone.inventory.credentials.pop()
    expect(refusal(() => validateNativeVaultRosterSeed(seed, gone))).toBe(
      'accepted',
    )
    // The decline must be present while the later inventory still lists the
    // disabled account, and must be absent once the input no longer disables
    // that account (it is enabled).
    const dropped = structuredClone(seed)
    dropped.declined.pop()
    expect(refusal(() => validateNativeVaultRosterSeed(dropped, later))).toBe(
      'seed-conflict',
    )
    expect(refusal(() => validateNativeVaultRosterSeed(seed, healthy()))).toBe(
      'seed-conflict',
    )
  })

  type Seed = Mutable<NativeVaultRosterDocument>
  const conflicts: [string, (seed: Seed) => void][] = [
    [
      'a changed account identity',
      (seed) => {
        seed.rows[1]!.accountIdentity = 'acct-other'
      },
    ],
    [
      'a changed credential',
      (seed) => {
        seed.rows[2]!.credentialId = 'oauth:anthropic:spare'
      },
    ],
    [
      'a changed route id',
      (seed) => {
        seed.rows[1]!.routeId = 'vault:work'
      },
    ],
    ['a missing row', (seed) => void seed.rows.pop()],
    [
      'an extra row',
      (seed) => {
        seed.rows.push({
          routeId: 'vault:spare',
          credentialId: 'oauth:anthropic:spare',
          credentialType: 'oauth',
          accountIdentity: 'acct-spare',
          state: 'active',
          label: 'spare',
          enabled: true,
          addedAt: 3,
        })
      },
    ],
    [
      'a repeated row in place of another',
      (seed) => {
        seed.rows[2] = { ...seed.rows[1]! }
      },
    ],
    [
      'an alias added to a seeded row',
      (seed) => {
        seed.rows[1]!.aliases = ['oauth:anthropic:spare']
      },
    ],
    [
      'a changed label',
      (seed) => {
        seed.rows[1]!.label = 'Renamed'
      },
    ],
    [
      'a changed added time',
      (seed) => {
        seed.rows[1]!.addedAt = 1
      },
    ],
    [
      'a changed enable flag',
      (seed) => {
        seed.rows[2]!.enabled = true
      },
    ],
    ['a removed decline', (seed) => void seed.declined.pop()],
    [
      'an added decline',
      (seed) => {
        seed.declined.push({
          credentialId: 'oauth:anthropic:work',
          accountIdentity: 'acct-work',
        })
      },
    ],
    [
      'a decline naming another credential of a seeded account',
      (seed) => {
        seed.declined[0]!.credentialId = 'oauth:anthropic:other'
      },
    ],
    [
      'a decline without an account',
      (seed) => {
        delete seed.declined[0]!.accountIdentity
      },
    ],
    [
      'an incomplete file',
      (seed) => {
        seed.complete = false
      },
    ],
    [
      'rejected records',
      (seed) => {
        seed.rejected = [{ reason: 'empty state' }]
      },
    ],
    [
      'a stale row',
      (seed) => {
        seed.rows[0]!.stale = true
      },
    ],
    [
      'a missing view',
      (seed) => {
        delete seed.view
      },
    ],
  ]

  for (const [name, mutate] of conflicts) {
    test(`refuses a retained seed with ${name}`, () => {
      const input = healthy()
      const healthySeed = buildNativeVaultRosterSeed(input)
      expect(
        refusal(() => validateNativeVaultRosterSeed(healthySeed, input)),
      ).toBe('accepted')
      const seed = structuredClone(healthySeed) as Seed
      mutate(seed)
      expect(refusal(() => validateNativeVaultRosterSeed(seed, input))).toBe(
        'seed-conflict',
      )
      expect(
        refusal(() => validateNativeVaultRosterSeed(healthySeed, healthy())),
      ).toBe('accepted')
    })
  }

  const capturedChanges: [
    string,
    NativeRosterSeedErrorCode,
    (input: Input) => void,
  ][] = [
    [
      'the vault now lists a legacy credential for another account',
      'roster-incomplete',
      (input) => {
        input.inventory.credentials[1]!.accountIdentity = 'acct-moved'
      },
    ],
    [
      'the current list is incomplete',
      'roster-incomplete',
      (input) => {
        input.inventory.skipped.push({ reason: 'empty credential id' })
      },
    ],
    [
      'the captured label changed',
      'seed-conflict',
      (input) => {
        input.legacyRows[0]!.label = 'Another label'
      },
    ],
    [
      'the captured added time changed',
      'seed-conflict',
      (input) => {
        input.legacyRows[0]!.addedAt = 7
      },
    ],
    [
      'the captured disable intent changed',
      'seed-conflict',
      (input) => {
        input.legacyRows[1]!.enabled = true
        input.disabledAccountIdentities = []
      },
    ],
    [
      'the primary was disabled',
      'seed-conflict',
      (input) => {
        input.disabledAccountIdentities.push('acct-primary')
      },
    ],
    [
      'a captured legacy row was added',
      'seed-conflict',
      (input) => {
        input.legacyRows.push({
          routeId: 'spare-route',
          scopedCredentialId: 'oauth:anthropic:spare',
          anthropicAccountUuid: 'acct-spare',
          enabled: true,
        })
      },
    ],
    [
      'a captured legacy row was removed',
      'seed-conflict',
      (input) => {
        input.legacyRows.pop()
        input.disabledAccountIdentities = []
      },
    ],
    [
      'the primary route id changed',
      'seed-conflict',
      (input) => {
        input.primaryRouteId = 'other-main-route'
      },
    ],
    [
      'an imported API row now takes a seeded route',
      'roster-route-conflict',
      (input) => {
        input.reservedRouteIds.push('work-route')
      },
    ],
  ]

  for (const [name, code, mutate] of capturedChanges) {
    test(`refuses ${code} when ${name}`, () => {
      const seed = buildNativeVaultRosterSeed(healthy())
      expect(
        refusal(() => validateNativeVaultRosterSeed(seed, healthy())),
      ).toBe('accepted')
      const input = healthy()
      mutate(input)
      expect(refusal(() => validateNativeVaultRosterSeed(seed, input))).toBe(
        code,
      )
    })
  }
})

describe('public input boundary', () => {
  const MARKER = 'synthetic-bearer-roster-probe'

  interface Probe {
    /** Getter, proxy trap and iterator calls; the boundary must make none. */
    calls: number
    thrown?: unknown
  }

  /** Install a getter that counts calls and throws a caller-chosen value. */
  function accessor(
    owner: object,
    key: PropertyKey,
    probe: Probe,
    thrown: unknown = new Error(MARKER, { cause: MARKER }),
  ): void {
    probe.thrown = thrown
    Object.defineProperty(owner, key, {
      configurable: true,
      enumerable: true,
      get() {
        probe.calls++
        throw thrown
      },
    })
  }

  const TRAPS = [
    'apply',
    'construct',
    'defineProperty',
    'deleteProperty',
    'get',
    'getOwnPropertyDescriptor',
    'getPrototypeOf',
    'has',
    'isExtensible',
    'ownKeys',
    'preventExtensions',
    'set',
    'setPrototypeOf',
  ] as const

  /** Wrap a value in a proxy whose every trap counts its call. */
  function trapped<T extends object>(value: T, probe: Probe): T {
    const handler: Record<string, unknown> = {}
    for (const trap of TRAPS) {
      handler[trap] = (...args: unknown[]) => {
        probe.calls++
        return (Reflect[trap] as (...forwarded: unknown[]) => unknown)(...args)
      }
    }
    return new Proxy(value, handler as ProxyHandler<T>)
  }

  /** Give an array an own iterator that counts calls. */
  function counted(array: unknown[], probe: Probe): void {
    const original = array[Symbol.iterator].bind(array)
    Object.defineProperty(array, Symbol.iterator, {
      configurable: true,
      value: () => {
        probe.calls++
        return original()
      },
    })
  }

  /**
   * The public call must fail with a new NativeRosterSeedError that holds only
   * an allowed code and no caller details (no message text, cause or marker).
   */
  function closedFailure(
    run: () => unknown,
    probe: Probe,
  ): NativeRosterSeedErrorCode {
    let caught: unknown
    try {
      run()
    } catch (error) {
      caught = error
    }
    expect(probe.calls).toBe(0)
    expect(caught).toBeInstanceOf(NativeRosterSeedError)
    expect(caught).not.toBe(probe.thrown)
    const error = caught as NativeRosterSeedError
    expect(error.cause).toBeUndefined()
    expect(Object.keys(error).sort()).toEqual(['code', 'name'])
    for (const surface of [
      error.message,
      JSON.stringify(error),
      Bun.inspect(error),
      String(error),
    ]) {
      expect(surface.includes(MARKER)).toBe(false)
    }
    return error.code
  }

  const hostileBuilds: [
    string,
    NativeRosterSeedErrorCode,
    (input: Input, probe: Probe) => unknown,
  ][] = [
    [
      'a getter on the inventory',
      'roster-incomplete',
      (input, probe) => {
        accessor(input, 'inventory', probe)
        return input
      },
    ],
    [
      'an inherited inventory getter',
      'roster-incomplete',
      (input, probe) => {
        const { inventory: _inventory, ...rest } = input
        const prototype = {}
        accessor(prototype, 'inventory', probe)
        return Object.assign(Object.create(prototype), rest)
      },
    ],
    [
      'a getter on the inventory credentials',
      'roster-incomplete',
      (input, probe) => {
        accessor(input.inventory, 'credentials', probe)
        return input
      },
    ],
    [
      'a getter on a credentials array index',
      'roster-incomplete',
      (input, probe) => {
        accessor(input.inventory.credentials, '1', probe)
        return input
      },
    ],
    [
      'a getter on a listed account identity',
      'roster-incomplete',
      (input, probe) => {
        accessor(input.inventory.credentials[1]!, 'accountIdentity', probe)
        return input
      },
    ],
    [
      'a getter on the primary pair',
      'roster-incomplete',
      (input, probe) => {
        accessor(input, 'primary', probe)
        return input
      },
    ],
    [
      'a getter on a legacy label',
      'seed-conflict',
      (input, probe) => {
        accessor(input.legacyRows[0]!, 'label', probe)
        return input
      },
    ],
    [
      'a getter on the legacy rows throwing a forged closed error',
      'seed-conflict',
      (input, probe) => {
        accessor(
          input,
          'legacyRows',
          probe,
          new NativeRosterSeedError('unenrolled-local-row'),
        )
        return input
      },
    ],
    [
      'a getter on the reserved route ids throwing a plain string',
      'seed-conflict',
      (input, probe) => {
        accessor(input, 'reservedRouteIds', probe, MARKER)
        return input
      },
    ],
    [
      'a proxied input',
      'seed-conflict',
      (input, probe) => trapped(input, probe),
    ],
    [
      'a proxied inventory',
      'roster-incomplete',
      (input, probe) => ({
        ...input,
        inventory: trapped(input.inventory, probe),
      }),
    ],
    [
      'a revoked proxy inventory',
      'roster-incomplete',
      (input) => {
        const revocable = Proxy.revocable(input.inventory, {})
        revocable.revoke()
        return { ...input, inventory: revocable.proxy }
      },
    ],
    [
      'a proxied credentials array',
      'roster-incomplete',
      (input, probe) => {
        input.inventory.credentials = trapped(
          input.inventory.credentials,
          probe,
        )
        return input
      },
    ],
    [
      'a proxied credential',
      'roster-incomplete',
      (input, probe) => {
        input.inventory.credentials[2] = trapped(
          input.inventory.credentials[2]!,
          probe,
        )
        return input
      },
    ],
    [
      'a proxied primary pair',
      'roster-incomplete',
      (input, probe) => ({ ...input, primary: trapped(input.primary, probe) }),
    ],
    [
      'proxied legacy rows',
      'seed-conflict',
      (input, probe) => ({
        ...input,
        legacyRows: trapped(input.legacyRows, probe),
      }),
    ],
    [
      'a proxied legacy row',
      'seed-conflict',
      (input, probe) => {
        input.legacyRows[1] = trapped(input.legacyRows[1]!, probe)
        return input
      },
    ],
    [
      'a proxied disabled list',
      'seed-conflict',
      (input, probe) => ({
        ...input,
        disabledAccountIdentities: trapped(
          input.disabledAccountIdentities,
          probe,
        ),
      }),
    ],
  ]

  for (const [name, code, install] of hostileBuilds) {
    test(`the builder refuses ${name} without running caller code`, () => {
      // The unmodified healthy input builds, so the refusal comes from the
      // hostile part.
      expect(refusal(() => buildNativeVaultRosterSeed(healthy()))).toBe(
        'accepted',
      )
      const probe: Probe = { calls: 0 }
      const input = install(healthy(), probe) as NativeRosterSeedInput
      expect(
        closedFailure(() => buildNativeVaultRosterSeed(input), probe),
      ).toBe(code)
      // The validator checks its input before the stored document, so the
      // same malformed input is refused there with the same code.
      expect(
        closedFailure(
          () =>
            validateNativeVaultRosterSeed(
              buildNativeVaultRosterSeed(healthy()),
              input,
            ),
          probe,
        ),
      ).toBe(code)
    })
  }

  type Seed = Mutable<NativeVaultRosterDocument>
  const hostileSeeds: [string, (seed: Seed, probe: Probe) => unknown][] = [
    [
      'a getter on the rows',
      (seed, probe) => {
        accessor(seed, 'rows', probe)
        return seed
      },
    ],
    [
      'a getter on a row label',
      (seed, probe) => {
        accessor(seed.rows[1]!, 'label', probe)
        return seed
      },
    ],
    [
      'a getter on the declines',
      (seed, probe) => {
        accessor(seed, 'declined', probe)
        return seed
      },
    ],
    [
      'a getter on a decline account throwing a forged closed error',
      (seed, probe) => {
        accessor(
          seed.declined[0]!,
          'accountIdentity',
          probe,
          new NativeRosterSeedError('roster-incomplete'),
        )
        return seed
      },
    ],
    ['a proxied document', (seed, probe) => trapped(seed, probe)],
    [
      'a proxied rows array',
      (seed, probe) => ({ ...seed, rows: trapped(seed.rows, probe) }),
    ],
    [
      'a proxied row',
      (seed, probe) => {
        seed.rows[0] = trapped(seed.rows[0]!, probe)
        return seed
      },
    ],
    [
      'a proxied decline',
      (seed, probe) => {
        seed.declined[0] = trapped(seed.declined[0]!, probe)
        return seed
      },
    ],
    [
      'a proxied empty alias list',
      (seed, probe) => {
        seed.rows[1]!.aliases = trapped([], probe)
        return seed
      },
    ],
    [
      'a proxied empty rejected list',
      (seed, probe) => ({ ...seed, rejected: trapped([], probe) }),
    ],
  ]

  for (const [name, install] of hostileSeeds) {
    test(`the validator refuses ${name} without running caller code`, () => {
      const input = healthy()
      const healthySeed = buildNativeVaultRosterSeed(input)
      expect(
        refusal(() => validateNativeVaultRosterSeed(healthySeed, input)),
      ).toBe('accepted')
      const probe: Probe = { calls: 0 }
      const seed = install(
        structuredClone(healthySeed) as Seed,
        probe,
      ) as NativeVaultRosterDocument
      expect(
        closedFailure(() => validateNativeVaultRosterSeed(seed, input), probe),
      ).toBe('seed-conflict')
    })
  }

  test('custom array iterators are never called', () => {
    const probe: Probe = { calls: 0 }
    const input = healthy()
    counted(input.inventory.credentials, probe)
    counted(input.inventory.skipped, probe)
    counted(input.legacyRows, probe)
    counted(input.disabledAccountIdentities, probe)
    counted(input.reservedRouteIds, probe)
    const seed = buildNativeVaultRosterSeed(input)
    expect(seed).toEqual(buildNativeVaultRosterSeed(healthy()))
    const stored = structuredClone(seed) as Seed
    counted(stored.rows, probe)
    counted(stored.declined, probe)
    const aliases: string[] = []
    counted(aliases, probe)
    stored.rows[1]!.aliases = aliases
    expect(refusal(() => validateNativeVaultRosterSeed(stored, input))).toBe(
      'accepted',
    )
    expect(probe.calls).toBe(0)
    // Control: the counter does see an ordinary iteration of the same arrays.
    void [...input.legacyRows]
    expect(probe.calls).toBe(1)
  })

  const malformedInputs: [
    string,
    NativeRosterSeedErrorCode,
    (input: Record<string, unknown>) => unknown,
  ][] = [
    ['a null input', 'seed-conflict', () => null],
    [
      'a null inventory',
      'roster-incomplete',
      (input) => ({ ...input, inventory: null }),
    ],
    [
      'credentials that are not an array',
      'roster-incomplete',
      (input) => {
        ;(input.inventory as Record<string, unknown>).credentials = 'oauth'
        return input
      },
    ],
    [
      'skipped records that are not an array',
      'roster-incomplete',
      (input) => {
        ;(input.inventory as Record<string, unknown>).skipped = null
        return input
      },
    ],
    [
      'a null credential',
      'roster-incomplete',
      (input) => {
        ;(input.inventory as { credentials: unknown[] }).credentials[3] = null
        return input
      },
    ],
    [
      'a numeric listed state',
      'roster-incomplete',
      (input) => {
        ;(input.inventory as { credentials: Record<string, unknown>[] })
          .credentials[3]!.state = 1
        return input
      },
    ],
    [
      'a null primary',
      'roster-incomplete',
      (input) => ({ ...input, primary: null }),
    ],
    [
      'legacy rows that are not an array',
      'seed-conflict',
      (input) => ({ ...input, legacyRows: {} }),
    ],
    [
      'a null legacy row',
      'seed-conflict',
      (input) => {
        ;(input.legacyRows as unknown[])[1] = null
        return input
      },
    ],
    [
      'a numeric legacy route id',
      'roster-route-conflict',
      (input) => {
        ;(input.legacyRows as Record<string, unknown>[])[0]!.routeId = 7
        return input
      },
    ],
    [
      'a numeric primary route id',
      'roster-route-conflict',
      (input) => ({ ...input, primaryRouteId: 7 }),
    ],
    [
      'a string enable flag',
      'seed-conflict',
      (input) => {
        ;(input.legacyRows as Record<string, unknown>[])[0]!.enabled = 'yes'
        return input
      },
    ],
    [
      'a numeric label',
      'seed-conflict',
      (input) => {
        ;(input.legacyRows as Record<string, unknown>[])[0]!.label = 3
        return input
      },
    ],
    [
      'a numeric disabled identity',
      'seed-conflict',
      (input) => ({ ...input, disabledAccountIdentities: [1] }),
    ],
    [
      'reserved route ids given as one string',
      'seed-conflict',
      (input) => ({ ...input, reservedRouteIds: 'api-route' }),
    ],
  ]

  for (const [name, code, malform] of malformedInputs) {
    test(`the builder refuses ${code} for ${name}`, () => {
      expect(refusal(() => buildNativeVaultRosterSeed(healthy()))).toBe(
        'accepted',
      )
      const input = malform(
        healthy() as unknown as Record<string, unknown>,
      ) as NativeRosterSeedInput
      // `refusal` rethrows any error other than NativeRosterSeedError.
      expect(refusal(() => buildNativeVaultRosterSeed(input))).toBe(code)
      expect(
        refusal(() =>
          validateNativeVaultRosterSeed(
            buildNativeVaultRosterSeed(healthy()),
            input,
          ),
        ),
      ).toBe(code)
    })
  }

  const malformedSeeds: [string, (seed: Record<string, unknown>) => unknown][] =
    [
      ['a null document', () => null],
      ['rows that are not an array', (seed) => ({ ...seed, rows: 'rows' })],
      [
        'declines that are not an array',
        (seed) => ({ ...seed, declined: null }),
      ],
      [
        'rejected records that are not an array',
        (seed) => ({ ...seed, rejected: 'empty state' }),
      ],
      [
        'a null row',
        (seed) => {
          ;(seed.rows as unknown[])[0] = null
          return seed
        },
      ],
      [
        'a numeric route id',
        (seed) => {
          ;(seed.rows as Record<string, unknown>[])[0]!.routeId = 1
          return seed
        },
      ],
      [
        'aliases that are not an array',
        (seed) => {
          ;(seed.rows as Record<string, unknown>[])[1]!.aliases = 'alias'
          return seed
        },
      ],
      [
        'a null decline',
        (seed) => {
          ;(seed.declined as unknown[])[0] = null
          return seed
        },
      ],
      [
        'a numeric decline credential',
        (seed) => {
          ;(seed.declined as Record<string, unknown>[])[0]!.credentialId = 1
          return seed
        },
      ],
    ]

  for (const [name, malform] of malformedSeeds) {
    test(`the validator refuses seed-conflict for ${name}`, () => {
      const input = healthy()
      const healthySeed = buildNativeVaultRosterSeed(input)
      expect(
        refusal(() => validateNativeVaultRosterSeed(healthySeed, input)),
      ).toBe('accepted')
      const seed = malform(
        structuredClone(healthySeed) as unknown as Record<string, unknown>,
      ) as NativeVaultRosterDocument
      expect(refusal(() => validateNativeVaultRosterSeed(seed, input))).toBe(
        'seed-conflict',
      )
    })
  }

  test('a built seed shares no object with its input', () => {
    const input = healthy()
    const seed = buildNativeVaultRosterSeed(input)
    const before = JSON.stringify(seed)
    input.inventory.view = 'changed'
    input.inventory.credentials[0]!.state = 'changed'
    input.legacyRows[0]!.label = 'changed'
    input.disabledAccountIdentities.push('acct-work')
    expect(JSON.stringify(seed)).toBe(before)
  })
})

test('native roster seed declaration has no producer or internal-types edge', async () => {
  const source = await readFile(
    new URL('../../dist/native-roster-seed.d.ts', import.meta.url),
    'utf8',
  )
  const references = moduleReferences(source).map(
    (reference) => reference.specifier,
  )
  expect(references).toEqual(['./native-custody.ts'])
  expect(source).toContain('export declare function buildNativeVaultRosterSeed')
  expect(source).toContain(
    'export declare function validateNativeVaultRosterSeed',
  )
})
