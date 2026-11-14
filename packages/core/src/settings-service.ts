import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
  type OpenSettingsOptions,
  openSettings,
  type ReportEntry,
  type SettingsEdit,
  type SettingsHandle,
  type UpdateResult,
  type ValueOf,
} from '@cortexkit/common-auth/settings'
import { type ParseError, parse } from 'jsonc-parser'

import { logger } from './logger.ts'
import {
  CLAUDE_MODEL_CAPABILITIES,
  resolveClaudeModelCapabilities,
} from './model-capabilities.ts'
import {
  refusedSettingsRecreationText,
  type SettingsKey,
  settingsCheckPendingText,
  settingsDefinition,
} from './settings-definition.ts'
import type { SettingsHost } from './settings-paths.ts'
import {
  readSettingsProtectionCopy,
  writeSettingsProtectionCopy,
} from './settings-protection-copy.ts'

export type SettingsValues = {
  [K in SettingsKey]: ValueOf<(typeof settingsDefinition.settings)[K]['value']>
}

export const SETTINGS_PROTECTION_KEYS = [
  'max_same_account_wait',
  'quota_minimum_remaining_five_hour',
  'quota_minimum_remaining_seven_day',
  'quota_minimum_remaining_scoped',
  'quota_fail_closed_on_unknown_quota',
  'killswitch_enabled',
  'killswitch_default_five_hour',
  'killswitch_default_seven_day',
  'killswitch_default_scoped',
  'killswitch_account_floors',
] as const satisfies readonly SettingsKey[]

export type SettingsProtectionValues = Pick<
  SettingsValues,
  (typeof SETTINGS_PROTECTION_KEYS)[number]
>

export type SettingsProtectionRung = 0 | 1 | 2 | 3

export class SettingsRecreationRefusal extends Error {
  constructor(file: string) {
    super(refusedSettingsRecreationText(file))
    this.name = 'SettingsRecreationRefusal'
  }
}

/**
 * A write into an existing settings file by a host that has not adopted it
 * (its import check has not passed). The file may protect less than the
 * host's legacy store, so the write is refused under the writer lock; the
 * caller reports the same refusal as while the host is held by that check.
 */
export class SettingsAdoptionRefusal extends Error {
  constructor(readonly file: string) {
    super(settingsCheckPendingText(file))
    this.name = 'SettingsAdoptionRefusal'
  }
}

export interface SettingsUpdateOptions {
  /** Only menu writes and setup with a <target>.moved marker and no user file may create it. */
  createMissing?: boolean
  /**
   * This write is the host's import into the file (the import check, or
   * setup filling the file from the legacy store), which by design runs
   * before the host adopts the file. Every other write by a host lease that
   * has not adopted the file is refused when the file exists.
   */
  importing?: boolean
}

export interface SettingsProtectionRecovery {
  /** Return only this host's complete set; a missing copy returns undefined, an unreadable or corrupt one throws. */
  readAppliedCopy?: (
    host: SettingsHost,
  ) => Promise<SettingsProtectionValues | undefined>
  /** Read this runtime's local or vault settings store, as selected by its current enrollment mode. */
  readLegacyProtection?: (
    host: SettingsHost,
  ) => Promise<SettingsProtectionValues | undefined>
  /**
   * Read the other host's own legacy store through that host's current custody
   * (see `readPeerLegacySettingsProtection`). Recreating a missing file uses it
   * to learn the other host's protection. Without it, that host's set is
   * unknown and recreation is refused: an absent reader never means the
   * other host has nothing to protect.
   */
  readPeerLegacyProtection?: (
    host: SettingsHost,
  ) => Promise<SettingsProtectionValues | undefined>
}

export interface SettingsContextValues {
  readonly noModel: SettingsValues
  readonly models: Readonly<Record<string, SettingsValues>>
}

/** Explicit file levels only; values and their validity remain common-auth's responsibility. */
export type SettingsFileLevels = Readonly<
  Partial<Record<SettingsKey, readonly string[]>>
>

export interface SettingsFileStatus {
  readonly file: string
  readonly state: 'ready' | 'missing' | 'unparseable' | 'unreadable'
  readonly missing: boolean
  readonly recreated: boolean
  readonly invalidKeys: readonly string[]
  readonly ignoredModelKeys: readonly { setting: SettingsKey; model: string }[]
  readonly duplicateKeys: readonly string[]
}

export interface SettingsGeneration {
  readonly id: number
  /** Time the coherent file version was read; detached persistence retains this time. */
  readonly readAt: number
  readonly file: string
  readonly status: 'ready' | 'missing' | 'unparseable' | 'unreadable'
  /** Raw file text for inspecting override locations outside request handling; never log it. */
  readonly source: string | undefined
  readonly fileLevels: SettingsFileLevels
  readonly contexts: Readonly<Record<SettingsHost, SettingsContextValues>>
  readonly report: readonly ReportEntry[]
  readonly fileStatus: SettingsFileStatus
  /** Recover an unusable set as a whole from last-good values or startup recovery, never per key. */
  readonly protection: Readonly<
    Record<
      SettingsHost,
      {
        readonly usable: boolean
        readonly values: SettingsProtectionValues
        readonly rung: SettingsProtectionRung
      }
    >
  >
}

export interface SettingsService {
  readonly file: string
  /** An independently disposable reference; settings stay live until all references are disposed. */
  retain(): SettingsService
  /** Synchronous, memory-only reads; unknown models use the no-model context. */
  resolve(host: SettingsHost, model?: string): SettingsValues
  snapshot(): SettingsGeneration
  /** Secret-free diagnostics for status displays, with no filesystem work. */
  status(): SettingsFileStatus
  /** Effects are awaited in publication order; unsubscribe before disposing a host. */
  watch(listener: SettingsChangeListener): () => void
  /** Every underlying user-file watch callback, even if resolved values stay identical. */
  onFileEvent?(listener: () => void): () => void
  refresh(): Promise<void>
  update(
    edits: SettingsUpdate,
    host: SettingsHost,
    options?: SettingsUpdateOptions,
  ): Promise<UpdateResult>
  /**
   * Called once the acting host has passed its import check for this file
   * (after its `adopted` option turned true): the lease records the
   * generation it holds as that host's last-good set at once, before the
   * applied copy is saved, so a failed copy write leaves no stale window.
   * Does nothing while `adopted` still returns false.
   */
  noteAdoption?(): void
  dispose(): Promise<void>
}

export type SettingsChangeListener = (
  generation: SettingsGeneration,
) => void | Promise<void>

type CoreSettingsHandle = SettingsHandle<typeof settingsDefinition.settings>
export interface SettingsServiceOptions {
  file: string
  /** Acting host: enables persistence and startup recovery of only its own copy set. */
  host?: SettingsHost
  separateInstall?: boolean
  lockTimeoutMs?: number
  protection?: SettingsProtectionRecovery
  /**
   * False while the acting host has not passed its import check for this
   * file (see `importSettingsHostStore`), so it does not use the file yet.
   * Until then the file's values are never this host's last-good protection:
   * a file it has not imported may protect less than its legacy store, so a
   * missing or unusable file recovers this host's set from the ladder (its
   * applied copy, then its legacy store, then the strictest set). Nor does
   * the lease save an applied copy from it, and a write into the existing
   * file is refused unless it is the host's import. Omitted means the host
   * has not adopted the file: every production caller passes it explicitly.
   */
  adopted?: () => boolean
  /** Dependency seams for deterministic file-race and no-I/O tests. */
  dependencies?: {
    open?: (options: OpenSettingsOptions) => CoreSettingsHandle
    readFile?: (file: string) => Promise<Uint8Array>
    writeAppliedCopy?: typeof writeSettingsProtectionCopy
    /** Schedule an off-request re-read; return a cancellation function. */
    schedule?: (callback: () => void, delayMs: number) => () => void
  }
}

const keys = Object.keys(settingsDefinition.settings) as SettingsKey[]
const hosts = ['opencode', 'pi'] as const
const modelIds = new Set(CLAUDE_MODEL_CAPABILITIES.map((row) => row.id))
const services = new Map<string, SharedSettingsService>()
const logged = new Set<string>()
const recreatedFiles = new Set<string>()
const silentLogger = { warn() {}, info() {} }

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  return value
}

function defaults(): SettingsValues {
  return Object.fromEntries(
    keys.map((key) => [
      key,
      structuredClone(settingsDefinition.settings[key].default),
    ]),
  ) as unknown as SettingsValues
}

function fileObject(source: string | undefined): Record<string, unknown> {
  if (source === undefined) return {}
  const text = source.replace(/^\uFEFF/, '')
  if (/^[\x20\t\r\n]*$/.test(text)) return {}
  const errors: ParseError[] = []
  const raw = parse(text, errors, { allowTrailingComma: true })
  return !errors.length && raw && typeof raw === 'object' && !Array.isArray(raw)
    ? raw
    : {}
}

/** The levels at which a parsed settings document sets each key; values and their validity remain common-auth's responsibility. */
export function settingsFileLevels(
  raw: Record<string, unknown>,
): SettingsFileLevels {
  return Object.fromEntries(
    keys
      .filter((key) => Object.hasOwn(raw, key))
      .map((key) => {
        const declaration = settingsDefinition.settings[key]
        const value = raw[key]
        const levels =
          'overrides' in declaration &&
          value &&
          typeof value === 'object' &&
          !Array.isArray(value)
            ? Object.keys(value).filter(
                (level) =>
                  level === 'default' ||
                  hosts.some((host) => host === level) ||
                  ('model' in declaration.overrides &&
                    declaration.overrides.model &&
                    modelIds.has(level)),
              )
            : ['default']
        return [key, levels]
      }),
  )
}

function protection(values: SettingsValues): SettingsProtectionValues {
  return Object.fromEntries(
    SETTINGS_PROTECTION_KEYS.map((key) => [key, values[key]]),
  ) as SettingsProtectionValues
}

type AccountFloor =
  SettingsProtectionValues['killswitch_account_floors'][number]

/** The account floors one host applies, in list order, without their host tags. */
function hostFloors(values: SettingsProtectionValues, host: SettingsHost) {
  return values.killswitch_account_floors
    .filter((entry) => entry.host === host || entry.host === 'both')
    .map(({ account, five_hour, seven_day, scoped }) => ({
      account,
      five_hour,
      seven_day,
      scoped,
    }))
}

function sameJson(a: unknown, b: unknown) {
  return JSON.stringify(a) === JSON.stringify(b)
}

/** One host's whole protection set, as the recreation planner receives it. */
export interface SettingsRecreationSide {
  host: SettingsHost
  values: SettingsProtectionValues
}

/** A shared-settings edit, including an explicit default or host level. */
export type SettingsLevelEdit = SettingsEdit

/**
 * The protection edits for a recreated file, as a pure function of both
 * hosts' whole sets, so each host resolves exactly its own set from the new
 * file. A key both hosts agree on is one plain value. A key they disagree on
 * is the writer's value at the default level, then the other host's value at
 * that host's level. Floors are one list whose entries keep each host's tag;
 * an entry becomes `both` only for a vault account whose floors are
 * identical for the two hosts.
 */
export function planSettingsRecreation(
  writer: SettingsRecreationSide,
  peer: SettingsRecreationSide,
): {
  edits: SettingsLevelEdit[]
  /**
   * True when the other host resolves any protection value other than its
   * account floors differently. Floors never set it: the one floor list
   * carries each host's entries under that host's tag.
   */
  peerDiffers: boolean
} {
  let peerDiffers = false
  const edits: SettingsLevelEdit[] = []
  for (const setting of SETTINGS_PROTECTION_KEYS) {
    if (setting === 'killswitch_account_floors') continue
    const own = writer.values[setting]
    const other = peer.values[setting]
    if (sameJson(own, other)) {
      edits.push({ setting, value: own })
      continue
    }
    peerDiffers = true
    edits.push(
      { setting, level: 'default', value: own },
      { setting, level: peer.host, value: other },
    )
  }
  const ownFloors = hostFloors(writer.values, writer.host)
  const otherFloors = hostFloors(peer.values, peer.host)
  const floors: AccountFloor[] = []
  const shared = new Set<string>()
  for (const entry of ownFloors) {
    const identical = otherFloors.some(
      (other) => other.account === entry.account && sameJson(other, entry),
    )
    if (identical && entry.account.startsWith('vault:')) {
      shared.add(entry.account)
      floors.push({ ...entry, host: 'both' })
    } else floors.push({ ...entry, host: writer.host })
  }
  for (const entry of otherFloors)
    if (!shared.has(entry.account)) floors.push({ ...entry, host: peer.host })
  edits.push({ setting: 'killswitch_account_floors', value: floors })
  return { edits, peerDiffers }
}

/**
 * The protection edits for a recreation whose other host has no set of its
 * own: the writer's values as plain values, its own account floors tagged
 * with it, and its vault floors as `both`, since vault routes are shared.
 */
export function settingsRecreationForWriter(
  values: SettingsProtectionValues,
  host: SettingsHost,
): SettingsLevelEdit[] {
  return SETTINGS_PROTECTION_KEYS.map((setting) => ({
    setting,
    value:
      setting === 'killswitch_account_floors'
        ? hostFloors(values, host).map((entry) => ({
            ...entry,
            host: entry.account.startsWith('vault:') ? 'both' : host,
          }))
        : values[setting],
  }))
}

/**
 * The floor list a recreation writes when the other host applies the same
 * floors as `host`.
 */
export function settingsRecreationFloors(
  values: SettingsProtectionValues,
  host: SettingsHost,
): SettingsProtectionValues['killswitch_account_floors'] {
  const peer = host === 'opencode' ? 'pi' : 'opencode'
  const { edits } = planSettingsRecreation(
    { host, values },
    {
      host: peer,
      values: {
        ...values,
        killswitch_account_floors: hostFloors(values, host).map((entry) => ({
          ...entry,
          host: peer,
        })),
      },
    },
  )
  const floors = edits.find(
    (edit) => edit.setting === 'killswitch_account_floors',
  )?.value
  return (floors ?? []) as SettingsProtectionValues['killswitch_account_floors']
}

/** One host's protection set and where it came from, for planning a recreation. */
export interface SettingsRecreationInput {
  host: SettingsHost
  values: SettingsProtectionValues
  rung: SettingsProtectionRung
  /** A source exists but could not be read, so the set is unknown. */
  unreadable?: boolean
  /**
   * The host has no set at all: no applied copy and no legacy store (it never
   * ran). Distinct from rung 3 without a reader, which is an unknown set.
   */
  none?: boolean
}

export type SettingsRecreationRefusalReason = 'own-unknown' | 'peer-unknown'

/**
 * What a menu write or setup that finds the file missing does, as a pure
 * function of both hosts' sets: the protection edits it carries, or why it
 * is refused. Only a peer known to have no set (it never ran) takes the
 * writer's. A peer whose set is unknown refuses the write, whether or not
 * the hosts are running, so its protection is never replaced by the
 * writer's. Otherwise both known sets are carried together, with host levels
 * preserving any differing values.
 */
export function planSettingsFileRecreation(
  writer: SettingsRecreationInput,
  peer: SettingsRecreationInput,
):
  | { edits: SettingsLevelEdit[] }
  | { refused: SettingsRecreationRefusalReason } {
  if (writer.rung === 3) return { refused: 'own-unknown' }
  if (peer.none)
    return { edits: settingsRecreationForWriter(writer.values, writer.host) }
  if (peer.rung === 3) return { refused: 'peer-unknown' }
  return { edits: planSettingsRecreation(writer, peer).edits }
}

/** The state of the user file a menu write found, as common-auth's planned update reports it. */
export type SettingsWriteState =
  | { status: 'missing' }
  | { status: 'ready'; document: unknown }

/** Menu edits run under the writer lock; a missing file also supplies its protection carry. */
export type SettingsUpdatePlan = (
  current: SettingsWriteState,
  carry?: readonly SettingsEdit[],
) => readonly SettingsEdit[]
export type SettingsUpdate = readonly SettingsEdit[] | SettingsUpdatePlan

/**
 * The edits for one menu write, as a pure function of the file it finds:
 * protection is carried only into a missing file, and an existing file keeps
 * its own. `carry` throws when recreation must be refused.
 */
export function planSettingsMenuWrite(
  current: SettingsWriteState,
  edits: readonly SettingsEdit[],
  carry: () => readonly SettingsEdit[],
): readonly SettingsEdit[] {
  return current.status === 'missing' ? [...carry(), ...edits] : edits
}

/**
 * Why `host` can't use the file, in plain words for a refused menu write, or
 * undefined when it can (or the file is missing). It names at most a
 * declared setting, never a value: file contents may hold secrets.
 */
export function settingsFileProblem(
  generation: SettingsGeneration,
  host: SettingsHost,
): string | undefined {
  if (generation.status === 'missing') return undefined
  if (generation.status === 'unparseable') return "can't be parsed"
  if (generation.status === 'unreadable') return "can't be read"
  if (generation.protection[host].usable) return undefined
  if (
    generation.source !== undefined &&
    /^[\x20\t\r\n]*$/.test(generation.source.replace(/^\uFEFF/, ''))
  )
    return 'is empty'
  const invalid = generation.report.find((entry) =>
    SETTINGS_PROTECTION_KEYS.some((key) => key === entry.keyPath[0]),
  )
  if (invalid) return `has an invalid value for ${invalid.keyPath[0]}`
  // The remaining unusable file is one from a newer or invalid schema version.
  return 'is from a newer or unknown settings version'
}

export function mostRestrictiveSettingsProtection(): SettingsProtectionValues {
  return {
    ...protection(defaults()),
    killswitch_enabled: true,
    killswitch_account_floors: [],
    quota_fail_closed_on_unknown_quota: 'on',
    max_same_account_wait: 'off',
  }
}

function reportText(entry: ReportEntry): string {
  // File contents and dependency detail strings may contain secrets. Only name declared keys.
  const key = keys.includes(entry.keyPath[0] as SettingsKey)
    ? entry.keyPath[0]
    : '<root>'
  return `Settings ${entry.reason} in "${entry.file.path}" (${key}).`
}

function logReports(report: readonly ReportEntry[]) {
  for (const entry of report) {
    const identity = JSON.stringify([
      entry.file.path,
      entry.keyPath,
      entry.reason,
    ])
    if (logged.has(identity)) continue
    logged.add(identity)
    logger.warn('settings', reportText(entry))
  }
}

function fileStatus(candidate: Candidate): SettingsFileStatus {
  const ignoredModelKeys: { setting: SettingsKey; model: string }[] = []
  for (const entry of candidate.report) {
    const key = entry.keyPath[0] as SettingsKey
    const declaration = settingsDefinition.settings[key]
    const model = entry.keyPath[1]
    if (
      entry.reason === 'unknown-key' &&
      declaration &&
      'overrides' in declaration &&
      'model' in declaration.overrides &&
      declaration.overrides.model &&
      model !== undefined &&
      !['default', ...hosts].includes(model) &&
      !modelIds.has(model)
    )
      ignoredModelKeys.push({ setting: key, model })
  }
  return {
    file: candidate.file,
    state: candidate.status,
    missing: candidate.status === 'missing',
    recreated: recreatedFiles.has(candidate.file),
    invalidKeys: [
      ...new Set(
        candidate.report
          .filter(
            (entry) =>
              [
                'invalid-value',
                'override-not-allowed',
                'invalid-schema-version',
                'unknown-key',
              ].includes(entry.reason) &&
              !ignoredModelKeys.some(
                (ignored) =>
                  ignored.setting === entry.keyPath[0] &&
                  ignored.model === entry.keyPath[1],
              ),
          )
          .map((entry) => entry.keyPath.join('.')),
      ),
    ],
    ignoredModelKeys,
    duplicateKeys: candidate.report
      .filter((entry) => entry.reason === 'duplicate-key')
      .map((entry) => entry.keyPath.join('.')),
  }
}

type FileBytes =
  | { status: 'ready'; bytes: Buffer }
  | { status: 'missing' | 'unreadable' }
function sameBytes(a: FileBytes, b: FileBytes) {
  return a.status === 'ready' && b.status === 'ready'
    ? a.bytes.equals(b.bytes)
    : a.status === b.status
}

type Candidate = Omit<SettingsGeneration, 'id' | 'fileStatus' | 'readAt'>
type Pass = {
  before: FileBytes
  after: FileBytes
  candidate: Candidate
  readAt: number
}

class SharedSettingsService {
  users = 0
  readonly ready: Promise<void>
  private readonly handle: CoreSettingsHandle
  private readonly unwatch: () => void
  private readonly listeners = new Set<SettingsChangeListener>()
  private readonly fileListeners = new Set<() => void>()
  private readonly readingListeners = new Set<
    (generation: SettingsGeneration) => void
  >()
  private current: SettingsGeneration | undefined
  private running: Promise<void> | undefined
  private pending = false
  private closed = false
  private cancelMissingRead: (() => void) | undefined
  private missingConfirmed = false
  private readonly lastGood = new Map<SettingsHost, SettingsProtectionValues>()

  constructor(
    readonly file: string,
    private readonly options: SettingsServiceOptions,
  ) {
    this.handle = options.dependencies?.open
      ? options.dependencies.open(this.openOptions())
      : openSettings(settingsDefinition, this.openOptions())
    this.unwatch = this.handle.watch(() => {
      for (const listener of this.fileListeners) listener()
      void this.refresh()
    })
    this.ready = this.refresh()
  }

  private openOptions(createMissing = false): OpenSettingsOptions {
    return {
      file: this.file,
      separateInstall: false,
      createMissing,
      lockTimeoutMs: this.options.lockTimeoutMs,
      log: silentLogger,
    }
  }

  snapshot(): SettingsGeneration {
    if (!this.current) throw new Error('Settings startup has not finished')
    return this.current
  }

  lastGoodProtection(host: SettingsHost) {
    return this.lastGood.get(host)
  }

  /**
   * Only a lease of `host` records its set, and only from a generation that
   * host uses: a reading of the file alone says nothing about whether a host
   * adopted it, and a set it never adopted must not become its recovery.
   */
  recordLastGood(host: SettingsHost, values: SettingsProtectionValues) {
    this.lastGood.set(host, values)
  }

  watch(listener: SettingsChangeListener) {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  onFileEvent(listener: () => void) {
    this.fileListeners.add(listener)
    return () => {
      this.fileListeners.delete(listener)
    }
  }

  /** A newer reading of an unchanged generation, for applied-copy persistence only. */
  onReading(listener: (generation: SettingsGeneration) => void) {
    this.readingListeners.add(listener)
    return () => {
      this.readingListeners.delete(listener)
    }
  }

  private async bytes(): Promise<FileBytes> {
    try {
      return {
        status: 'ready',
        bytes: Buffer.from(
          await (this.options.dependencies?.readFile ?? readFile)(this.file),
        ),
      }
    } catch (error) {
      return {
        status:
          (error as NodeJS.ErrnoException).code === 'ENOENT'
            ? 'missing'
            : 'unreadable',
      }
    }
  }

  private async resolveContexts() {
    const contexts = {} as Record<SettingsHost, SettingsContextValues>
    for (const host of hosts) {
      const read = async (model?: string) => {
        const values = {} as SettingsValues
        for (const key of keys) {
          Object.defineProperty(values, key, {
            value: await this.handle.get(key, {
              host,
              ...(model === undefined ? {} : { model }),
            }),
            enumerable: true,
            writable: true,
            configurable: true,
          })
        }
        return values
      }
      const noModel = await read()
      const models: Record<string, SettingsValues> = {}
      for (const row of CLAUDE_MODEL_CAPABILITIES)
        models[row.id] = await read(row.id)
      contexts[host] = { noModel, models }
    }
    return { contexts, report: this.handle.report() }
  }

  private async pass(): Promise<Pass> {
    // Wall-clock time: readings are compared across processes, and the
    // monotonic clock behind performance.now() can stop during system sleep.
    const readAt = Date.now()
    const before = await this.bytes()
    let resolved: Awaited<ReturnType<SharedSettingsService['resolveContexts']>>
    let after: FileBytes
    try {
      resolved = await this.resolveContexts()
    } finally {
      after = await this.bytes()
    }
    const { contexts, report } = resolved
    const source =
      after.status === 'ready' ? after.bytes.toString('utf8') : undefined
    const addReport = (keyPath: string[], reason: ReportEntry['reason']) => {
      if (
        !report.some(
          (entry) =>
            entry.reason === reason &&
            JSON.stringify(entry.keyPath) === JSON.stringify(keyPath),
        )
      )
        report.push({
          file: { kind: 'user', path: this.file },
          keyPath,
          reason,
        })
    }
    if (after.status === 'unreadable') addReport([], 'unreadable')
    // Inspect override names and deciding locations only; common-auth validates and resolves values.
    const raw = fileObject(source)
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      for (const key of keys) {
        const declaration = settingsDefinition.settings[key]
        const value = raw[key]
        if (
          !('overrides' in declaration) ||
          !('model' in declaration.overrides) ||
          !declaration.overrides.model ||
          !value ||
          typeof value !== 'object' ||
          Array.isArray(value)
        )
          continue
        for (const override of Object.keys(value)) {
          if (
            !['default', ...hosts].includes(override) &&
            !modelIds.has(override)
          ) {
            // Unknown model levels never participate, even when their values are invalid.
            for (let index = report.length - 1; index >= 0; index--) {
              const entry = report[index]!
              if (
                entry.keyPath[0] === key &&
                entry.keyPath[1] === override &&
                entry.reason !== 'duplicate-key'
              )
                report.splice(index, 1)
            }
            addReport([key, override], 'unknown-key')
          }
        }
      }
    }
    // The descriptor validates window entries; Core additionally limits each level to one entry.
    const window = raw?.cache_keep_window
    const windowLevels =
      window && typeof window === 'object' && !Array.isArray(window)
        ? Object.entries(window).filter(([level]) =>
            ['default', ...hosts].includes(level),
          )
        : [[undefined, window] as const]
    for (const [level, value] of windowLevels) {
      if (Array.isArray(value) && value.length > 1)
        addReport(
          ['cache_keep_window', ...(level === undefined ? [] : [level])],
          'invalid-value',
        )
    }
    for (const host of hosts) {
      const previous = this.current?.contexts[host]
      for (const [model, values] of [
        [undefined, contexts[host].noModel],
        ...Object.entries(contexts[host].models),
      ] as const) {
        const lastGood =
          model === undefined ? previous?.noModel : previous?.models[model]
        for (const entry of report) {
          const key = entry.keyPath[0] as SettingsKey
          if (
            entry.reason !== 'invalid-value' ||
            !keys.includes(key) ||
            SETTINGS_PROTECTION_KEYS.some(
              (protectedKey) => protectedKey === key,
            )
          )
            continue
          const value = raw?.[key]
          const override =
            value && typeof value === 'object' && !Array.isArray(value)
              ? model !== undefined && Object.hasOwn(value, model)
                ? model
                : Object.hasOwn(value, host)
                  ? host
                  : 'default'
              : undefined
          if (
            override !== undefined &&
            entry.keyPath[1] !== undefined &&
            entry.keyPath[1] !== override
          )
            continue
          if (lastGood) values[key] = lastGood[key] as never
        }
        if (!lastGood && values.cache_keep_window.length > 1) {
          // Drop an invalid host level before considering the remaining default level.
          const fallback =
            window && !Array.isArray(window) && typeof window === 'object'
              ? (window as Record<string, unknown>).default
              : undefined
          values.cache_keep_window =
            Array.isArray(fallback) &&
            fallback.length <= 1 &&
            !report.some(
              (entry) =>
                entry.reason === 'invalid-value' &&
                entry.keyPath[0] === 'cache_keep_window' &&
                entry.keyPath[1] === 'default',
            )
              ? fallback
              : []
        }
      }
    }
    const status =
      after.status !== 'ready'
        ? after.status
        : report.some((entry) => entry.reason === 'unparseable')
          ? 'unparseable'
          : report.some((entry) => entry.reason === 'unreadable')
            ? 'unreadable'
            : 'ready'
    // common-auth reads an empty or whitespace-only file, and one from a newer
    // or invalid schema version, with no report on any protection key. Such a
    // file (a truncated save, a downgrade) holds no protection the user
    // chose, so its schema defaults must never replace a known set.
    const version = raw.schema_version
    const untrustedFile =
      (source !== undefined &&
        /^[\x20\t\r\n]*$/.test(source.replace(/^\uFEFF/, ''))) ||
      (typeof version === 'number' &&
        Number.isInteger(version) &&
        version > 1) ||
      report.some((entry) => entry.reason === 'invalid-schema-version')
    if (untrustedFile && status === 'ready') {
      const identity = `untrusted:${this.file}`
      if (!logged.has(identity)) {
        logged.add(identity)
        logger.warn(
          'settings',
          `Settings file "${this.file}" is empty or from another settings version; protection settings keep their last known values.`,
        )
      }
    }
    const usable =
      status === 'ready' &&
      !untrustedFile &&
      !report.some((entry) =>
        SETTINGS_PROTECTION_KEYS.some((key) => key === entry.keyPath[0]),
      )
    const sets = {} as {
      [H in SettingsHost]: SettingsGeneration['protection'][H]
    }
    for (const host of hosts) {
      const values = protection(contexts[host].noModel)
      const seen = new Set<string>()
      let overlaps = false
      for (const entry of values.killswitch_account_floors) {
        for (const target of entry.host === 'both' ? hosts : [entry.host]) {
          const identity = JSON.stringify([entry.account, target])
          if (seen.has(identity)) overlaps = true
          seen.add(identity)
        }
      }
      if (overlaps) addReport(['killswitch_account_floors'], 'invalid-value')
      sets[host] = { usable: usable && !overlaps, values, rung: 0 }
    }
    return {
      before,
      after,
      readAt,
      candidate: {
        file: this.file,
        source,
        fileLevels: settingsFileLevels(raw),
        status,
        contexts,
        report,
        protection: sets,
      },
    }
  }

  private fallback(
    report: readonly ReportEntry[],
    status: 'unreadable' | 'unparseable',
  ): Candidate {
    const contexts =
      this.current?.contexts ??
      (Object.fromEntries(
        hosts.map((host) => [
          host,
          {
            noModel: defaults(),
            models: Object.fromEntries(
              CLAUDE_MODEL_CAPABILITIES.map((row) => [row.id, defaults()]),
            ),
          },
        ]),
      ) as Record<SettingsHost, SettingsContextValues>)
    return {
      file: this.file,
      source: undefined,
      fileLevels: this.current?.fileLevels ?? {},
      status,
      contexts,
      report,
      protection: Object.fromEntries(
        hosts.map((host) => [
          host,
          {
            usable: false,
            values: protection(contexts[host].noModel),
            rung: 0,
          },
        ]),
      ) as SettingsGeneration['protection'],
    }
  }

  private async stabilize(): Promise<Candidate & { readAt: number }> {
    let previous: Pass | undefined
    for (let attempt = 0; attempt < 5; attempt++) {
      let next: Pass
      try {
        next = await this.pass()
      } catch {
        previous = undefined
        continue
      }
      if (
        previous &&
        sameBytes(previous.before, previous.after) &&
        sameBytes(previous.after, next.before) &&
        sameBytes(next.before, next.after) &&
        JSON.stringify(previous.candidate) === JSON.stringify(next.candidate)
      ) {
        if (
          next.candidate.status === 'unreadable' ||
          next.candidate.status === 'unparseable'
        )
          return {
            ...this.fallback(next.candidate.report, next.candidate.status),
            readAt: next.readAt,
          }
        return { ...next.candidate, readAt: next.readAt }
      }
      previous = next
    }
    return {
      ...this.fallback(
        [
          {
            file: { kind: 'user', path: this.file },
            keyPath: [],
            reason: 'unreadable',
          },
        ],
        'unreadable',
      ),
      readAt: 0,
    }
  }

  refresh(): Promise<void> {
    if (this.closed) return Promise.resolve()
    this.pending = true
    if (!this.running) {
      this.running = this.drain().finally(() => {
        this.running = undefined
      })
    }
    return this.running
  }

  private async drain() {
    while (this.pending && !this.closed) {
      this.pending = false
      const candidate = await this.stabilize()
      if (this.closed) return
      const prior = this.current
      if (candidate.status === 'missing' && prior && !this.missingConfirmed) {
        if (!this.cancelMissingRead) {
          const schedule =
            this.options.dependencies?.schedule ??
            ((callback, delayMs) => {
              const timer = setTimeout(callback, delayMs)
              timer.unref?.()
              return () => clearTimeout(timer)
            })
          this.cancelMissingRead = schedule(() => {
            this.cancelMissingRead = undefined
            this.missingConfirmed = true
            void this.refresh()
          }, 2_000)
        }
        continue
      }
      if (candidate.status !== 'missing') {
        this.cancelMissingRead?.()
        this.cancelMissingRead = undefined
        this.missingConfirmed = false
      } else {
        this.missingConfirmed = true
      }
      if (prior?.status === 'missing' && candidate.status === 'ready')
        recreatedFiles.add(this.file)
      const status = fileStatus(candidate)
      if (
        prior &&
        JSON.stringify({ ...prior, id: undefined, readAt: undefined }) ===
          JSON.stringify({
            ...candidate,
            fileStatus: status,
            readAt: undefined,
          })
      ) {
        // Same settings, newer reading: hosts see no change, but the applied
        // copy must learn the newer reading time, or an older reading of
        // looser values that another process saves late would win.
        if (candidate.readAt > prior.readAt) {
          this.current = freeze({ ...prior, readAt: candidate.readAt })
          for (const listener of this.readingListeners) listener(this.current)
        }
        continue
      }
      const generation = freeze({
        ...candidate,
        fileStatus: status,
        id: (prior?.id ?? 0) + 1,
      })
      this.current = generation
      logReports(generation.report)
      // The missing-file line is logged by a host's lease, which can tell
      // whether that host's menu write would recreate the file or be refused.
      // Host effects finish in publication order; detached copy writes order themselves on disk.
      for (const listener of this.listeners) {
        if (this.closed) return
        try {
          await listener(generation)
        } catch {
          const identity = `effect:${this.file}`
          if (!logged.has(identity)) {
            logged.add(identity)
            logger.warn(
              'settings',
              `Settings change effect failed for "${this.file}".`,
            )
          }
        }
      }
    }
  }

  async update(
    edits: SettingsUpdate,
    host: SettingsHost,
    options: SettingsUpdateOptions,
    applied: SettingsGeneration['protection'][SettingsHost],
    /**
     * Whether the writing lease may change an existing file: false for a host
     * lease whose host has not adopted it. Read under the writer lock, since
     * the file may appear after the caller last saw it missing.
     */
    mayChangeFile: () => boolean,
    peerProtection: (
      host: SettingsHost,
    ) => Promise<Omit<SettingsRecreationInput, 'host'>> = async () => ({
      values: mostRestrictiveSettingsProtection(),
      rung: 3,
    }),
  ): Promise<UpdateResult> {
    if (typeof edits !== 'function' && !edits.length)
      return { outcome: 'unchanged' }
    const peer = host === 'opencode' ? 'pi' : 'opencode'
    // Protection recovery may do I/O, so gather it before entering the
    // synchronous writer plan. Only the plan decides whether it is needed.
    const other = options.createMissing ? await peerProtection(peer) : undefined
    let carried: Record<string, unknown> | undefined
    // The shared read/watch handle cannot create files. Only the menu's transient writer can.
    const handle = options.createMissing
      ? (this.options.dependencies?.open?.(this.openOptions(true)) ??
        openSettings(settingsDefinition, this.openOptions(true)))
      : this.handle
    const result = await handle.update(
      (current) => {
        if (
          current.status !== 'missing' &&
          !options.importing &&
          !mayChangeFile()
        )
          throw new SettingsAdoptionRefusal(this.file)
        let carry: readonly SettingsEdit[] | undefined
        if (current.status === 'missing') {
          const plan = planSettingsFileRecreation(
            { host, values: applied.values, rung: applied.rung },
            {
              host: peer,
              ...(other ?? {
                values: mostRestrictiveSettingsProtection(),
                rung: 3,
              }),
            },
          )
          if ('refused' in plan) throw new SettingsRecreationRefusal(this.file)
          carry = plan.edits
          // Retain levels in the diagnostic too: a plain map would hide
          // which host a differing protection value belongs to.
          carried = {}
          for (const edit of carry) {
            if (edit.level) {
              const levels = carried[edit.setting] as
                | Record<string, unknown>
                | undefined
              carried[edit.setting] = { ...levels, [edit.level]: edit.value }
            } else carried[edit.setting] = edit.value
          }
        }
        const menu = typeof edits === 'function' ? edits(current, carry) : edits
        return carry ? [...carry, ...menu] : menu
      },
      { host },
    )
    if (carried && result.outcome === 'updated') {
      recreatedFiles.add(this.file)
      const identity = `recreated:${this.file}`
      if (!logged.has(identity)) {
        logged.add(identity)
        logger.info(
          'settings',
          `Settings file was recreated at "${this.file}" carrying protection settings: ${JSON.stringify(carried)}.`,
        )
      }
    }
    await this.refresh()
    return result
  }

  async close() {
    this.closed = true
    this.cancelMissingRead?.()
    this.cancelMissingRead = undefined
    this.unwatch()
    this.listeners.clear()
    this.fileListeners.clear()
    this.readingListeners.clear()
    await this.running
  }
}

/**
 * Rungs 1-3 of the protection ladder, which need no open settings handle:
 * the applied copy (by default read from disk only for the acting host),
 * then the host's legacy store, then the strictest set. A source that can't
 * be read is skipped whole; keys are never mixed across sources.
 */
export async function recoverSettingsProtection(
  file: string,
  host: SettingsHost,
  recovery: SettingsProtectionRecovery = {},
  actingHost?: SettingsHost,
): Promise<{ values: SettingsProtectionValues; rung: 1 | 2 | 3 }> {
  for (const [rung, read] of [
    [
      1,
      recovery.readAppliedCopy ??
        (actingHost === host
          ? () => readSettingsProtectionCopy(file, host)
          : undefined),
    ],
    [2, recovery.readLegacyProtection],
  ] as const) {
    try {
      const values = await read?.(host)
      if (values) return { values, rung }
    } catch {
      // Skip this source whole.
    }
  }
  return { values: mostRestrictiveSettingsProtection(), rung: 3 }
}

/** File resolution is shared; recovery belongs to the runtime holding each lease. */
class SettingsProtectionLease {
  private current: SettingsGeneration | undefined
  private pending = Promise.resolve()
  private readonly copies = new Set<Promise<void>>()
  /** The last submitted copy write: its values and reading time. */
  private copied: string | undefined
  /**
   * The newest usable reading of this host's set whose copy is not known to
   * be saved. A retry writes exactly this reading, even after the file has
   * become unusable, until it is saved or a newer usable reading replaces it.
   */
  private unsaved:
    | {
        file: string
        readAt: number
        values: SettingsProtectionValues
        identity: string
      }
    | undefined
  private cancelRetry: (() => void) | undefined
  private closed = false
  /** Set once this lease has seen its host adopt the file. */
  private sawAdoption = false

  constructor(
    private readonly shared: SharedSettingsService,
    private readonly recovery: SettingsProtectionRecovery = {},
    private readonly options?: SettingsServiceOptions,
  ) {}

  /** Whether the acting host uses the file; see `SettingsServiceOptions.adopted`. */
  private adopted() {
    return this.options?.adopted?.() ?? false
  }

  /**
   * Whether a write through this lease may change an existing file. A lease
   * with no acting host records no host's protection, so only a host lease
   * is held to its host's adoption.
   */
  mayChangeFile() {
    return !this.options?.host || this.adopted()
  }

  /** See `SettingsService.noteAdoption`. */
  noteAdoption() {
    if (!this.current || !this.options?.host || !this.adopted()) return
    this.recordLastGood(this.current)
    this.persist(this.current)
  }

  /**
   * Record the acting host's set as last-good, but only from a generation it
   * uses. The import check runs on the generation this lease last applied,
   * so when adoption is first seen that generation is recorded too.
   */
  private recordLastGood(generation: SettingsGeneration) {
    const host = this.options?.host
    if (!host || !this.adopted()) return
    if (!this.sawAdoption) {
      this.sawAdoption = true
      const adopted = this.current?.protection[host]
      if (adopted?.usable && adopted.rung === 0)
        this.shared.recordLastGood(host, adopted.values)
    }
    const set = generation.protection[host]
    if (set.usable && set.rung === 0)
      this.shared.recordLastGood(host, set.values)
  }

  async close(): Promise<void> {
    this.closed = true
    this.cancelRetry?.()
    this.cancelRetry = undefined
    await this.pending
    await Promise.all(this.copies)
  }

  private persist(generation: SettingsGeneration) {
    const host = this.options?.host
    // Only a set this host adopted becomes its applied copy, whatever copy
    // writer the options supply: recovery trusts the copy as this host's own.
    if (!host || this.closed || !this.adopted()) return
    const set = generation.protection[host]
    if (!set.usable || set.rung !== 0) return
    // A newer reading of the same values is still submitted: the copy keeps
    // whichever reading is newest, across processes.
    const identity = JSON.stringify([generation.readAt, set.values])
    if (identity === this.copied) return
    this.unsaved = {
      file: generation.file,
      readAt: generation.readAt,
      values: set.values,
      identity,
    }
    this.write(this.unsaved)
  }

  private write(entry: NonNullable<SettingsProtectionLease['unsaved']>) {
    const host = this.options?.host
    if (!host || this.closed) return
    const { identity } = entry
    this.copied = identity
    this.cancelRetry?.()
    this.cancelRetry = undefined
    const write =
      this.options?.dependencies?.writeAppliedCopy ??
      writeSettingsProtectionCopy
    const task = Promise.resolve()
      .then(() =>
        write(
          entry.file,
          host,
          { readAt: entry.readAt, values: entry.values },
          this.options?.lockTimeoutMs,
        ),
      )
      .then(() => {
        if (this.unsaved === entry) this.unsaved = undefined
      })
      .catch(() => {
        const key = `copy:${entry.file}:${host}`
        if (!logged.has(key)) {
          logged.add(key)
          logger.warn(
            'settings',
            `Could not save applied protection settings for ${host} at "${entry.file}.applied.json"; the previous copy is unchanged until a retry succeeds.`,
          )
        }
        // Not done: the next generation or a retry within a minute submits again.
        if (this.copied === identity) {
          this.copied = undefined
          this.scheduleRetry()
        }
      })
      .finally(() => this.copies.delete(task))
    this.copies.add(task)
  }

  /** Retry a failed copy write off the request path, with the newest unsaved usable reading. */
  private scheduleRetry() {
    if (this.closed || this.cancelRetry) return
    const schedule =
      this.options?.dependencies?.schedule ??
      ((callback: () => void, delayMs: number) => {
        const timer = setTimeout(callback, delayMs)
        timer.unref?.()
        return () => clearTimeout(timer)
      })
    this.cancelRetry = schedule(() => {
      this.cancelRetry = undefined
      // Not `this.current`: the file may have become corrupt or missing since,
      // and the reading that failed to save is still the newest usable one.
      if (this.unsaved) this.write(this.unsaved)
    }, 60_000)
  }

  /** The shared file was read again with no change; carry the newer reading time. */
  reread(generation: SettingsGeneration): Promise<void> {
    this.pending = this.pending.then(() => {
      if (!this.current || this.current.id !== generation.id) return
      this.current = freeze({ ...this.current, readAt: generation.readAt })
      this.persist(this.current)
    })
    return this.pending
  }

  snapshot(): SettingsGeneration {
    if (!this.current) throw new Error('Settings startup has not finished')
    return this.current
  }

  publish(generation: SettingsGeneration): Promise<void> {
    this.pending = this.pending.then(() => this.apply(generation))
    return this.pending
  }

  /**
   * The other host's whole set for recreating a missing file: its last-good
   * set in this process (recorded only by that host's own lease, from a file
   * it adopted), then its applied copy, then its own legacy store.
   * `none` means both sources were read and hold nothing (that host never
   * ran). Anything else that yields no set is unknown (rung 3): a copy or
   * store that exists but can't be read, or no legacy reader at all. An
   * unreadable copy stops here rather than falling back to the legacy store,
   * because the copy may hold protection tightened in the file since the
   * legacy store was last written.
   */
  async peerProtection(
    host: SettingsHost,
  ): Promise<Omit<SettingsRecreationInput, 'host'>> {
    const good = this.shared.lastGoodProtection(host)
    if (good) return { values: good, rung: 1 }
    const unknown = (unreadable: boolean) => ({
      values: mostRestrictiveSettingsProtection(),
      rung: 3 as const,
      unreadable,
    })
    const readCopy =
      this.recovery.readAppliedCopy ??
      ((peer: SettingsHost) =>
        readSettingsProtectionCopy(this.shared.file, peer))
    try {
      const values = await readCopy(host)
      if (values) return { values, rung: 1 }
    } catch {
      return unknown(true)
    }
    const readLegacy = this.recovery.readPeerLegacyProtection
    if (!readLegacy) return unknown(false)
    try {
      const values = await readLegacy(host)
      if (values) return { values, rung: 2 }
    } catch {
      return unknown(true)
    }
    return { ...unknown(false), none: true }
  }

  /**
   * Log once per file that it is missing, saying what this host's next menu
   * write will do: recreate the file, or be refused and why.
   */
  private async logMissing(generation: SettingsGeneration) {
    const host = this.options?.host
    const key = `missing:${generation.file}`
    if (!host || logged.has(key)) return
    const peer = host === 'opencode' ? 'pi' : 'opencode'
    const own = generation.protection[host]
    const plan = planSettingsFileRecreation(
      { host, values: own.values, rung: own.rung },
      { host: peer, ...(await this.peerProtection(peer)) },
    )
    if (logged.has(key) || this.closed) return
    logged.add(key)
    const next =
      'refused' in plan
        ? `Menu writes that change settings are refused until the file is recreated by hand, because ${
            {
              'own-unknown': `${host}'s protection settings could not be recovered`,
              'peer-unknown': `the protection settings of ${peer} are unknown`,
            }[plan.refused]
          }.`
        : 'A menu write will recreate it.'
    logger.warn(
      'settings',
      `Settings file is missing at "${generation.file}"; non-protection settings use schema defaults. ${next}`,
    )
  }

  private async recover(host: SettingsHost) {
    // A host's set is taken only from a file that host adopted: its last-good
    // set, which only its own adopted lease records. The set this lease read
    // from the file is used only for its own host, once adopted. Another
    // host's set in that reading was never adopted through this lease, and a
    // host that has not adopted the file takes no protection from it either:
    // that file may protect less than the host's legacy store, which its
    // import check has not compared yet.
    const own = host === this.options?.host
    if (!own || this.adopted()) {
      const good = this.shared.lastGoodProtection(host)
      if (good) return { values: good, rung: 1 as const }
    }
    if (own && this.adopted()) {
      const previous = this.current?.protection[host]
      // A set read from the file earlier is a last-good recovery now.
      if (previous)
        return previous.rung === 0
          ? { values: previous.values, rung: 1 as const }
          : previous
    }
    return recoverSettingsProtection(
      this.shared.file,
      host,
      this.recovery,
      this.options?.host,
    )
  }

  private async apply(generation: SettingsGeneration) {
    this.recordLastGood(generation)
    if (hosts.every((host) => generation.protection[host].usable)) {
      this.current = generation
      this.persist(generation)
      return
    }
    const contexts = { ...generation.contexts }
    const sets = { ...generation.protection }
    for (const host of hosts) {
      if (sets[host].usable) continue
      const recovered = await this.recover(host)
      const values = structuredClone(recovered.values)
      sets[host] = { usable: false, values, rung: recovered.rung }
      const context = contexts[host]
      contexts[host] = {
        noModel: { ...context.noModel, ...values },
        models: Object.fromEntries(
          Object.entries(context.models).map(([model, modelValues]) => [
            model,
            { ...modelValues, ...values },
          ]),
        ),
      }
    }
    this.current = freeze({ ...generation, contexts, protection: sets })
    this.persist(this.current)
    if (generation.status === 'missing')
      await this.logMissing(this.current).catch(() => {})
  }
}

/** Share a resolved lease without tying a runtime's lifetime to its first caller. */
function referenceCountedSettingsService(
  service: Omit<SettingsService, 'retain'>,
): SettingsService {
  let users = 0
  function reference(): SettingsService {
    users++
    let closed = false
    let closing: Promise<void> | undefined
    const subscriptions = new Set<() => void>()
    const use = () => {
      if (closed) throw new Error('Settings service lease is disposed')
      return service
    }
    return {
      file: service.file,
      retain() {
        use()
        return reference()
      },
      resolve: (host, model) => use().resolve(host, model),
      snapshot: () => use().snapshot(),
      status: () => use().status(),
      refresh: () => use().refresh(),
      update: (edits, host, options) => use().update(edits, host, options),
      noteAdoption: () => use().noteAdoption?.(),
      watch(listener) {
        const unsubscribe = use().watch(listener)
        const stop = () => {
          unsubscribe()
          subscriptions.delete(stop)
        }
        subscriptions.add(stop)
        return stop
      },
      onFileEvent(listener) {
        const unsubscribe = use().onFileEvent?.(listener) ?? (() => {})
        const stop = () => {
          unsubscribe()
          subscriptions.delete(stop)
        }
        subscriptions.add(stop)
        return stop
      },
      dispose() {
        if (closed) return closing ?? Promise.resolve()
        closed = true
        for (const unsubscribe of subscriptions) unsubscribe()
        subscriptions.clear()
        closing = --users === 0 ? service.dispose() : Promise.resolve()
        return closing
      },
    }
  }
  return reference()
}

/** One lease per plugin instance; no handle, reads or watch for a separate install. */
export async function openSettingsService(
  options: SettingsServiceOptions,
): Promise<SettingsService | undefined> {
  if (options.separateInstall) return undefined
  const file = resolve(options.file)
  let shared = services.get(file)
  if (!shared) {
    shared = new SharedSettingsService(file, options)
    services.set(file, shared)
  }
  const owned = shared
  owned.users++
  let closed = false
  let closing: Promise<void> | undefined
  const subscriptions = new Set<() => void>()
  const lease = new SettingsProtectionLease(owned, options.protection, options)
  const unsubscribeLease = owned.watch((generation) =>
    lease.publish(generation),
  )
  const unsubscribeReading = owned.onReading((generation) => {
    void lease.reread(generation)
  })
  const use = () => {
    if (closed) throw new Error('Settings service lease is disposed')
    return owned
  }
  const dispose = (): Promise<void> => {
    if (closed) return closing ?? Promise.resolve()
    closed = true
    unsubscribeLease()
    unsubscribeReading()
    for (const unsubscribe of subscriptions) unsubscribe()
    subscriptions.clear()
    if (--owned.users === 0) {
      if (services.get(file) === owned) services.delete(file)
      closing = owned.close()
    }
    closing = Promise.all([closing, lease.close()]).then(() => {})
    return closing
  }
  try {
    await owned.ready
    await lease.publish(owned.snapshot())
  } catch (error) {
    await dispose()
    throw error
  }
  return referenceCountedSettingsService({
    file,
    resolve(host, model) {
      use()
      const context = lease.snapshot().contexts[host]
      const row = resolveClaudeModelCapabilities(model)
      return (row ? context.models[row.id] : undefined) ?? context.noModel
    },
    snapshot: () => {
      use()
      return lease.snapshot()
    },
    status: () => {
      use()
      return lease.snapshot().fileStatus
    },
    watch(listener) {
      const unsubscribe = use().watch(() => listener(lease.snapshot()))
      const stop = () => {
        unsubscribe()
        subscriptions.delete(stop)
      }
      subscriptions.add(stop)
      return stop
    },
    onFileEvent(listener) {
      const unsubscribe = use().onFileEvent(listener)
      const stop = () => {
        unsubscribe()
        subscriptions.delete(stop)
      }
      subscriptions.add(stop)
      return stop
    },
    refresh: () => use().refresh(),
    update: (edits, host, options = {}) =>
      use().update(
        edits,
        host,
        options,
        lease.snapshot().protection[host],
        () => lease.mayChangeFile(),
        (peer) => lease.peerProtection(peer),
      ),
    noteAdoption() {
      use()
      lease.noteAdoption()
    },
    dispose,
  })
}
