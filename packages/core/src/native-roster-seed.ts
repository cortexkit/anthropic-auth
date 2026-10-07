import { types } from 'node:util'
import type { NativeCustodyInventory } from './native-custody.ts'

/**
 * Builds and re-checks the vault roster seed written while a legacy custody
 * install migrates to the native pool. It is pure: it never lists, reads,
 * refreshes or writes anything. The caller lists the vault, reads the legacy
 * config, resolves the primary route id and owns every file write.
 *
 * The seed keeps the route ids the legacy install already used, so later
 * discovery (which only adds new routes under its own prefix) keeps them.
 * It carries no token, refresh token or other credential material.
 */

/** Allowed build/check failure codes. Diagnostics contain no caller data. */
export type NativeRosterSeedErrorCode =
  | 'roster-incomplete'
  | 'unenrolled-local-row'
  | 'roster-route-conflict'
  | 'seed-conflict'

function seedCode(value: unknown): NativeRosterSeedErrorCode {
  switch (value) {
    case 'roster-incomplete':
    case 'unenrolled-local-row':
    case 'roster-route-conflict':
    case 'seed-conflict':
      return value
    default:
      return 'seed-conflict'
  }
}

export class NativeRosterSeedError extends Error {
  readonly code: NativeRosterSeedErrorCode

  constructor(code: NativeRosterSeedErrorCode) {
    const safeCode = seedCode(code)
    super(`Native roster seed refused: ${safeCode}`)
    this.name = 'NativeRosterSeedError'
    this.code = safeCode
  }
}

/** One OAuth account row from the legacy custody config. No secrets. */
export interface NativeRosterSeedLegacyRow {
  /** The legacy account id; it becomes the seeded route id unchanged. */
  readonly routeId: string
  /** Vault credential ID associated with this enrolled legacy row, if present. */
  readonly scopedCredentialId?: string
  readonly anthropicAccountUuid?: string
  readonly label?: string
  readonly addedAt?: number
  /** The user's enable/disable choice for this row. */
  readonly enabled: boolean
}

export interface NativeRosterSeedInput {
  /** The vault list, already verified by the caller's discovery. */
  readonly inventory: NativeCustodyInventory
  /** The primary credential and account captured from the legacy config. */
  readonly primary: {
    readonly credentialId: string
    readonly accountIdentity: string
  }
  /** Route ID assigned by offline migration to the legacy primary Claude account. */
  readonly primaryRouteId: string
  readonly legacyRows: readonly NativeRosterSeedLegacyRow[]
  /** Accounts the user disabled, by Anthropic account UUID. */
  readonly disabledAccountIdentities: readonly string[]
  /** Route ids taken by imported API-key rows; a seeded route never takes one. */
  readonly reservedRouteIds: readonly string[]
}

export interface NativeVaultRosterSeedRow {
  routeId: string
  credentialId: string
  credentialType: 'oauth'
  accountIdentity: string
  state: string
  label: string
  enabled: boolean
  addedAt: number
}

export interface NativeVaultRosterSeedDecline {
  credentialId: string
  accountIdentity: string
}

/** Fresh secret-free roster, compatible with common-auth's readVaultRoster. */
export interface NativeVaultRosterSeed {
  version: 1
  view: string
  complete: true
  rows: NativeVaultRosterSeedRow[]
  declined: NativeVaultRosterSeedDecline[]
}

/**
 * Stored roster returned by common-auth's readVaultRoster. Account quota,
 * email and organisation metadata do not participate in seed matching.
 */
export interface NativeVaultRosterDocument {
  readonly version: 1
  readonly view?: string
  readonly complete: boolean
  readonly rejected?: readonly {
    readonly credentialId?: string
    readonly reason: string
  }[]
  readonly rows: readonly {
    readonly routeId: string
    readonly credentialId: string
    readonly credentialType: 'oauth' | 'api_key'
    readonly accountIdentity?: string
    readonly aliases?: readonly string[]
    readonly state: string
    readonly label: string
    readonly email?: string
    readonly orgName?: string
    readonly enabled: boolean
    readonly addedAt: number
    readonly quota?: unknown
    readonly stale?: true
    readonly unclaimed?: true
  }[]
  readonly declined: readonly {
    readonly credentialId: string
    readonly accountIdentity?: string
  }[]
}

interface ExpectedDecline extends NativeVaultRosterSeedDecline {
  /**
   * A decline for a seeded row must name that row's credential. A decline for
   * an account the seed has no row for is matched by account only, because
   * which listed credential represents that account may change between runs.
   */
  readonly exactCredential: boolean
}

interface Expected {
  readonly view: string
  readonly rows: readonly NativeVaultRosterSeedRow[]
  readonly declined: readonly ExpectedDecline[]
  /** Disabled accounts the seed has no row for, listed now or not. */
  readonly unseeded: ReadonlySet<string>
}

type Refuse = (code: NativeRosterSeedErrorCode) => never

/**
 * The refusal state of one public call. Every failure leaves the call as a
 * fresh closed error chosen from this record alone, never from the thrown
 * value: a caller getter or malformed input can throw anything, and copying
 * or even inspecting that value could carry caller data out.
 */
interface Boundary {
  /**
   * The code this module's own refusal check chose, when one refused. It is
   * never taken from a caught exception, which may have come from the caller.
   */
  refused?: NativeRosterSeedErrorCode
  /**
   * The generic code to report when an unexpected failure happens while one
   * section of the input is being checked, set as each section begins.
   */
  fallback: NativeRosterSeedErrorCode
}

function guarded<T>(body: (boundary: Boundary, refuse: Refuse) => T): T {
  const boundary: Boundary = { fallback: 'seed-conflict' }
  const refuse: Refuse = (code) => {
    boundary.refused = code
    throw new NativeRosterSeedError(code)
  }
  try {
    return body(boundary, refuse)
  } catch {
    throw new NativeRosterSeedError(boundary.refused ?? boundary.fallback)
  }
}

function filled(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

/**
 * Caller input is read without running caller code: a proxy is refused before
 * any reflection (reflection on a proxy runs its traps), only own data
 * properties are read through their descriptors (an accessor is refused, never
 * called), and arrays are copied by index (a custom iterator is never used).
 * An inherited property reads as absent.
 */
function target(
  value: unknown,
  code: NativeRosterSeedErrorCode,
  refuse: Refuse,
): object {
  if (typeof value !== 'object' || value === null || types.isProxy(value))
    refuse(code)
  return value
}

function dataField(
  owner: object,
  key: string,
  code: NativeRosterSeedErrorCode,
  refuse: Refuse,
): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(owner, key)
  if (descriptor === undefined) return undefined
  if (Object.hasOwn(descriptor, 'get') || Object.hasOwn(descriptor, 'set'))
    refuse(code)
  return descriptor.value
}

/** Copy the named own data fields of a caller object into a plain object. */
function capture<K extends string>(
  value: unknown,
  keys: readonly K[],
  code: NativeRosterSeedErrorCode,
  refuse: Refuse,
): Record<K, unknown> {
  const owner = target(value, code, refuse)
  const copy = {} as Record<K, unknown>
  for (const key of keys) copy[key] = dataField(owner, key, code, refuse)
  return copy
}

/** The length of a caller array, read without touching its elements. */
function count(
  value: unknown,
  code: NativeRosterSeedErrorCode,
  refuse: Refuse,
): number {
  const owner = target(value, code, refuse)
  if (!Array.isArray(owner)) refuse(code)
  const length = dataField(owner, 'length', code, refuse)
  if (typeof length !== 'number') refuse(code)
  return length
}

/** Copy a caller array by index, so later checks never re-read caller state. */
function items(
  value: unknown,
  code: NativeRosterSeedErrorCode,
  refuse: Refuse,
): unknown[] {
  const owner = target(value, code, refuse)
  const length = count(owner, code, refuse)
  const copy: unknown[] = []
  for (let index = 0; index < length; index++)
    copy.push(dataField(owner, String(index), code, refuse))
  return copy
}

/**
 * Validate the complete vault list and every legacy row first, and only then
 * derive the route rows and the declines (the markers for disabled accounts).
 * Nothing is filtered: one bad record refuses the whole seed rather than
 * seeding the rest as complete. Each caller field is read once into owned
 * plain data before it is judged.
 */
function expectedSeed(
  input: NativeRosterSeedInput,
  boundary: Boundary,
  refuse: Refuse,
): Expected {
  const source = target(input, 'seed-conflict', refuse)
  const top = (key: string, code: NativeRosterSeedErrorCode) =>
    dataField(source, key, code, refuse)

  // A vault list or primary credential/account pair that cannot be read must
  // not count as a verified complete list, so failures here report
  // roster-incomplete.
  boundary.fallback = 'roster-incomplete'
  const inventory = capture(
    top('inventory', 'roster-incomplete'),
    ['view', 'credentials', 'skipped'],
    'roster-incomplete',
    refuse,
  )
  const view = inventory.view
  const skipped = items(inventory.skipped, 'roster-incomplete', refuse)
  const credentialRecords = items(
    inventory.credentials,
    'roster-incomplete',
    refuse,
  ).map((record) =>
    capture(
      record,
      ['credentialId', 'credentialType', 'accountIdentity', 'state'],
      'roster-incomplete',
      refuse,
    ),
  )

  // The seed is written as complete, so the list must be complete: no
  // skipped records, a view to record, and every record naming its account.
  // A record without an account could log into a seeded account, so the
  // seed's account membership could not be proven.
  if (!filled(view) || skipped.length > 0) refuse('roster-incomplete')
  const listed = new Map<
    string,
    {
      credentialType: unknown
      accountIdentity: string
      state: string
    }
  >()
  for (const record of credentialRecords) {
    const { credentialId, credentialType, accountIdentity, state } = record
    if (
      !filled(credentialId) ||
      !filled(accountIdentity) ||
      !filled(state) ||
      listed.has(credentialId)
    ) {
      refuse('roster-incomplete')
    }
    listed.set(credentialId, { credentialType, accountIdentity, state })
  }

  const primary = capture(
    top('primary', 'roster-incomplete'),
    ['credentialId', 'accountIdentity'],
    'roster-incomplete',
    refuse,
  )
  const primaryCredentialId = primary.credentialId
  const primaryIdentity = primary.accountIdentity

  boundary.fallback = 'seed-conflict'
  const primaryRouteId = top('primaryRouteId', 'seed-conflict')
  const legacyRecords = items(
    top('legacyRows', 'seed-conflict'),
    'seed-conflict',
    refuse,
  ).map((record) =>
    capture(
      record,
      [
        'routeId',
        'scopedCredentialId',
        'anthropicAccountUuid',
        'label',
        'addedAt',
        'enabled',
      ],
      'seed-conflict',
      refuse,
    ),
  )
  const disabledList = items(
    top('disabledAccountIdentities', 'seed-conflict'),
    'seed-conflict',
    refuse,
  )
  const reservedList = items(
    top('reservedRouteIds', 'seed-conflict'),
    'seed-conflict',
    refuse,
  )
  for (const value of [...disabledList, ...reservedList]) {
    if (typeof value !== 'string') refuse('seed-conflict')
  }
  const disabled = new Set(disabledList as string[])
  const reserved = new Set(reservedList as string[])

  // A credential and account pair is seeded only when the vault lists exactly
  // that OAuth credential logging into exactly that account.
  function listedState(credentialId: string, accountIdentity: string): string {
    const credential = listed.get(credentialId)
    if (
      credential?.credentialType !== 'oauth' ||
      credential.accountIdentity !== accountIdentity
    ) {
      refuse('roster-incomplete')
    }
    return credential.state
  }

  if (!filled(primaryCredentialId) || !filled(primaryIdentity))
    refuse('roster-incomplete')
  const primaryState = listedState(primaryCredentialId, primaryIdentity)

  for (const row of legacyRecords) {
    if (!filled(row.scopedCredentialId)) refuse('unenrolled-local-row')
  }
  const legacy = legacyRecords.map((row) => {
    const credentialId = row.scopedCredentialId
    const identity = row.anthropicAccountUuid
    if (!filled(credentialId) || !filled(identity)) refuse('roster-incomplete')
    return {
      row,
      credentialId,
      identity,
      state: listedState(credentialId, identity),
    }
  })

  // `main` is the host's own slot name, never a route. A route id may not
  // repeat or take an imported API-key row's id.
  const routes = new Set<string>()
  for (const routeId of [
    primaryRouteId,
    ...legacyRecords.map((row) => row.routeId),
  ]) {
    if (
      !filled(routeId) ||
      routeId === 'main' ||
      reserved.has(routeId) ||
      routes.has(routeId)
    ) {
      refuse('roster-route-conflict')
    }
    routes.add(routeId)
  }
  if (!filled(primaryRouteId)) refuse('roster-route-conflict')

  // The published projection folds every credential of one account into a
  // single row, so two seeded rows for one account (or one credential) would
  // be collapsed on the next discovery, losing a route.
  const credentials = new Set([primaryCredentialId])
  const identities = new Set([primaryIdentity])
  const legacyRows = legacy.map(
    ({ row, credentialId, identity, state }): NativeVaultRosterSeedRow => {
      if (credentials.has(credentialId) || identities.has(identity))
        refuse('seed-conflict')
      credentials.add(credentialId)
      identities.add(identity)
      const { routeId, label, addedAt, enabled } = row
      if (
        !filled(routeId) ||
        typeof enabled !== 'boolean' ||
        (addedAt !== undefined &&
          (typeof addedAt !== 'number' || !Number.isFinite(addedAt))) ||
        (label !== undefined && typeof label !== 'string')
      ) {
        refuse('seed-conflict')
      }
      return {
        routeId,
        credentialId,
        credentialType: 'oauth',
        accountIdentity: identity,
        state,
        label: filled(label) ? label : routeId,
        enabled,
        addedAt: addedAt ?? 0,
      }
    },
  )

  // A fallback row's own `enabled` flag decides its account, because the legacy
  // runtime gated fallback routes on that flag alone and applied the disabled
  // account list only to the primary.
  const rows: NativeVaultRosterSeedRow[] = [
    {
      routeId: primaryRouteId,
      credentialId: primaryCredentialId,
      credentialType: 'oauth',
      accountIdentity: primaryIdentity,
      state: primaryState,
      label: primaryRouteId,
      enabled: !disabled.has(primaryIdentity),
      addedAt: 0,
    },
    ...legacyRows,
  ]

  const declined: ExpectedDecline[] = rows
    .filter((row) => !row.enabled)
    .map((row) => ({
      credentialId: row.credentialId,
      accountIdentity: row.accountIdentity,
      exactCredential: true,
    }))
  // A disabled account the vault lists but the seed has no row for is declined
  // through its lowest listed credential id, so discovery adds it disabled.
  // A disabled account the vault does not list cannot be declined here (a
  // decline needs a credential id); the pool settings keep that choice.
  const unseeded = [...disabled]
    .filter((identity) => !identities.has(identity))
    .sort()
  for (const identity of unseeded) {
    const credentialId = [...listed]
      .filter(([, credential]) => credential.accountIdentity === identity)
      .map(([credentialId]) => credentialId)
      .sort()[0]
    if (credentialId !== undefined)
      declined.push({
        credentialId,
        accountIdentity: identity,
        exactCredential: false,
      })
  }

  return { view, rows, declined, unseeded: new Set(unseeded) }
}

/**
 * Build the first seed from the current verified vault list and the captured
 * legacy state. The result is a complete roster the published reader accepts,
 * built only from owned copies, so it shares no object with the input.
 */
export function buildNativeVaultRosterSeed(
  input: NativeRosterSeedInput,
): NativeVaultRosterSeed {
  return guarded((boundary: Boundary, refuse: Refuse) => {
    const expected = expectedSeed(input, boundary, refuse)
    return {
      version: 1,
      view: expected.view,
      complete: true,
      rows: expected.rows.map((row) => ({ ...row })),
      declined: expected.declined.map(({ credentialId, accountIdentity }) => ({
        credentialId,
        accountIdentity,
      })),
    }
  })
}

/**
 * Check a seed already on disk against the captured legacy state, so a resumed
 * migration can keep it. Returns nothing: a valid seed is kept exactly as it
 * is, with its original view and states. The current vault list must still
 * pass every refusal, but a changed view or record state alone is not a
 * conflict. Route, credential and account membership, labels, added times and
 * enable/decline choices must match exactly; any difference refuses.
 */
export function validateNativeVaultRosterSeed(
  existing: NativeVaultRosterDocument,
  input: NativeRosterSeedInput,
): void {
  guarded((boundary: Boundary, refuse: Refuse) => {
    const expected = expectedSeed(input, boundary, refuse)
    boundary.fallback = 'seed-conflict'
    // Check schema, completeness, membership and imported user preferences.
    // The stored view must be a string but need not match the current cursor.
    // Row state, display metadata and quota are not read or rewritten.
    const document = capture(
      existing,
      ['version', 'complete', 'view', 'rejected', 'rows', 'declined'],
      'seed-conflict',
      refuse,
    )
    const { version, complete, view, rejected } = document
    const rows = items(document.rows, 'seed-conflict', refuse).map((row) =>
      capture(
        row,
        [
          'routeId',
          'credentialId',
          'credentialType',
          'accountIdentity',
          'aliases',
          'label',
          'addedAt',
          'enabled',
          'stale',
          'unclaimed',
        ],
        'seed-conflict',
        refuse,
      ),
    )
    const declinedEntries = items(
      document.declined,
      'seed-conflict',
      refuse,
    ).map((entry) =>
      capture(
        entry,
        ['credentialId', 'accountIdentity'],
        'seed-conflict',
        refuse,
      ),
    )
    if (
      version !== 1 ||
      complete !== true ||
      typeof view !== 'string' ||
      (rejected !== undefined &&
        count(rejected, 'seed-conflict', refuse) > 0) ||
      rows.length !== expected.rows.length
    ) {
      refuse('seed-conflict')
    }

    const wanted = new Map(expected.rows.map((row) => [row.routeId, row]))
    const seen = new Set<string>()
    for (const row of rows) {
      const match =
        typeof row.routeId === 'string' ? wanted.get(row.routeId) : undefined
      if (
        !match ||
        seen.has(match.routeId) ||
        row.credentialId !== match.credentialId ||
        row.credentialType !== 'oauth' ||
        row.accountIdentity !== match.accountIdentity ||
        (row.aliases !== undefined &&
          count(row.aliases, 'seed-conflict', refuse) > 0) ||
        row.label !== match.label ||
        row.addedAt !== match.addedAt ||
        row.enabled !== match.enabled ||
        row.stale !== undefined ||
        row.unclaimed !== undefined
      ) {
        refuse('seed-conflict')
      }
      seen.add(match.routeId)
    }

    // Keep all current disabled-account markers. A disabled account with no
    // seed row can also keep its earlier marker after disappearing from the
    // vault, so credential removal alone does not prevent migration resume.
    const declines = new Map(
      expected.declined.map((entry) => [entry.accountIdentity, entry]),
    )
    const declinedSeen = new Set<string>()
    for (const { credentialId, accountIdentity: identity } of declinedEntries) {
      if (
        typeof credentialId !== 'string' ||
        typeof identity !== 'string' ||
        declinedSeen.has(identity)
      ) {
        refuse('seed-conflict')
      }
      const match = declines.get(identity)
      if (
        match
          ? match.exactCredential && credentialId !== match.credentialId
          : !expected.unseeded.has(identity)
      ) {
        refuse('seed-conflict')
      }
      declinedSeen.add(identity)
    }
    for (const identity of declines.keys()) {
      if (!declinedSeen.has(identity)) refuse('seed-conflict')
    }
  })
}
