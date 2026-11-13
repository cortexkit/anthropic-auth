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

export interface SettingsUpdateOptions {
  /** Only menu writes and setup with a <target>.moved marker and no user file may create it. */
  createMissing?: boolean
}

export interface SettingsProtectionRecovery {
  /** Return only this host's complete set; missing or corrupt copies return undefined or throw. */
  readAppliedCopy?: (
    host: SettingsHost,
  ) => Promise<SettingsProtectionValues | undefined>
  /** Read this runtime's local or vault settings store, as selected by its current enrollment mode. */
  readLegacyProtection?: (
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
  refresh(): Promise<void>
  update(
    edits: readonly SettingsEdit[],
    host: SettingsHost,
    options?: SettingsUpdateOptions,
  ): Promise<UpdateResult>
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

function fileLevels(raw: Record<string, unknown>): SettingsFileLevels {
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

/** Carry only the writer's account floors; vault routes apply to both hosts after recreation. */
export function settingsProtectionForRecreation(
  values: SettingsProtectionValues,
  host: SettingsHost,
): SettingsProtectionValues {
  return {
    ...values,
    killswitch_account_floors: values.killswitch_account_floors
      .filter((entry) => entry.host === host || entry.host === 'both')
      .map((entry) => ({
        ...entry,
        host: entry.account.startsWith('vault:') ? 'both' : host,
      })),
  }
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

  watch(listener: SettingsChangeListener) {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
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
    const readAt = performance.timeOrigin + performance.now()
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
    const usable =
      status === 'ready' &&
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
        fileLevels: fileLevels(raw),
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
      )
        continue
      const generation = freeze({
        ...candidate,
        fileStatus: status,
        id: (prior?.id ?? 0) + 1,
      })
      this.current = generation
      for (const host of hosts) {
        if (generation.protection[host].usable)
          this.lastGood.set(host, generation.protection[host].values)
      }
      logReports(generation.report)
      if (
        generation.status === 'missing' &&
        !logged.has(`missing:${this.file}`)
      ) {
        logged.add(`missing:${this.file}`)
        logger.warn(
          'settings',
          `Settings file is missing at "${this.file}"; non-protection settings use schema defaults. A menu write will recreate it.`,
        )
      }
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
    edits: readonly SettingsEdit[],
    host: SettingsHost,
    options: SettingsUpdateOptions,
    applied: SettingsGeneration['protection'][SettingsHost],
  ): Promise<UpdateResult> {
    if (!edits.length) return { outcome: 'unchanged' }
    const missing = (await this.bytes()).status === 'missing'
    let carried: SettingsProtectionValues | undefined
    if (missing && options.createMissing) {
      if (applied.rung === 3) throw new SettingsRecreationRefusal(this.file)
      const values = settingsProtectionForRecreation(applied.values, host)
      carried = values
      edits = [
        ...SETTINGS_PROTECTION_KEYS.map((setting) => ({
          setting,
          value: values[setting],
        })),
        ...edits,
      ]
    }
    // The shared read/watch handle cannot create files. Only the menu's transient writer can.
    const handle = options.createMissing
      ? (this.options.dependencies?.open?.(this.openOptions(true)) ??
        openSettings(settingsDefinition, this.openOptions(true)))
      : this.handle
    const result = await handle.update(edits, { host })
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
    await this.running
  }
}

/** File resolution is shared; recovery belongs to the runtime holding each lease. */
class SettingsProtectionLease {
  private current: SettingsGeneration | undefined
  private pending = Promise.resolve()
  private readonly copies = new Set<Promise<void>>()
  private copied: string | undefined

  constructor(
    private readonly shared: SharedSettingsService,
    private readonly recovery: SettingsProtectionRecovery = {},
    private readonly options?: SettingsServiceOptions,
  ) {}

  async close(): Promise<void> {
    await this.pending
    await Promise.all(this.copies)
  }

  private persist(generation: SettingsGeneration) {
    const host = this.options?.host
    if (!host) return
    const set = generation.protection[host]
    if (!set.usable || set.rung !== 0) return
    const identity = JSON.stringify(set.values)
    if (identity === this.copied) return
    this.copied = identity
    const write =
      this.options?.dependencies?.writeAppliedCopy ??
      writeSettingsProtectionCopy
    const task = Promise.resolve()
      .then(() =>
        write(
          generation.file,
          host,
          { readAt: generation.readAt, values: set.values },
          this.options?.lockTimeoutMs,
        ),
      )
      .catch(() => {
        const key = `copy:${generation.file}:${host}`
        if (logged.has(key)) return
        logged.add(key)
        logger.warn(
          'settings',
          `Could not save applied protection settings for ${host} at "${generation.file}.applied.json"; the previous copy is unchanged.`,
        )
      })
      .finally(() => this.copies.delete(task))
    this.copies.add(task)
  }

  snapshot(): SettingsGeneration {
    if (!this.current) throw new Error('Settings startup has not finished')
    return this.current
  }

  publish(generation: SettingsGeneration): Promise<void> {
    this.pending = this.pending.then(() => this.apply(generation))
    return this.pending
  }

  private async recover(host: SettingsHost) {
    const good = this.shared.lastGoodProtection(host)
    if (good) return { values: good, rung: 1 as const }
    const previous = this.current?.protection[host]
    if (previous) return previous
    for (const [rung, read] of [
      [
        1,
        this.recovery.readAppliedCopy ??
          (this.options?.host === host
            ? () => readSettingsProtectionCopy(this.shared.file, host)
            : undefined),
      ],
      [2, this.recovery.readLegacyProtection],
    ] as const) {
      try {
        const values = await read?.(host)
        if (values) return { values, rung }
      } catch {
        // Unreadable recovery sources leave the whole rung, never individual keys.
      }
    }
    return { values: mostRestrictiveSettingsProtection(), rung: 3 as const }
  }

  private async apply(generation: SettingsGeneration) {
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
      watch(listener) {
        const unsubscribe = use().watch(listener)
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
  const use = () => {
    if (closed) throw new Error('Settings service lease is disposed')
    return owned
  }
  const dispose = (): Promise<void> => {
    if (closed) return closing ?? Promise.resolve()
    closed = true
    unsubscribeLease()
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
    refresh: () => use().refresh(),
    update: (edits, host, options = {}) =>
      use().update(edits, host, options, lease.snapshot().protection[host]),
    dispose,
  })
}
