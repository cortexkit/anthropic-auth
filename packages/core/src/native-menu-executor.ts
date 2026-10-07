import { types as utilTypes } from 'node:util'
import {
  getNativeMenuModel,
  type NativeMenuAction,
  type NativeMenuActionId,
  type NativeMenuCacheMode,
  type NativeMenuCustodyMode,
  type NativeMenuHost,
  type NativeMenuLogLevel,
  type NativeMenuParameter,
  type NativeMenuParameterId,
  type NativeMenuRefusalCode,
  type NativeMenuRoutingMode,
} from './native-menu-model.ts'

/**
 * Typed input checking and safety gating for native menu actions.
 *
 * The menu model in native-menu-model.ts only describes actions. This module
 * checks the values a menu collected against that description and the
 * existing command parsers' rules, applies the safety rules (headless refusal,
 * confirmation, session requirement, cancellation before dispatch), and then
 * hands one validated request to a host-provided capability. The capability
 * performs the real effect; this module performs no I/O, retries, or
 * background work, and it does not render a menu or collect input.
 */

/**
 * One killswitch threshold row. The fields match the `/claude-killswitch set`
 * entries, but `account` is taken as structured data, not command text.
 */
export type NativeMenuKillswitchEntry = {
  /**
   * An opaque account ID, passed on exactly as given, or the `main` / `all`
   * selector. Native route IDs such as `vault:oauth:...` contain colons, so a
   * menu that collects entries as text must keep the IDs whole rather than
   * split them with the legacy command's `account:fh,sd` delimiters.
   */
  readonly account: string
  /** Five-hour remaining-percent threshold. */
  readonly fh: number
  /** Seven-day remaining-percent threshold. */
  readonly sd: number
  /** Optional model-scoped remaining-percent threshold. */
  readonly scoped?: number
}

/** Values for an action that takes no parameters: no key is accepted. */
export type NativeMenuNoValues = { readonly [key: string]: never }

/**
 * The values each action accepts. Optional inputs may be left out or sent as
 * `null`, which is how a menu reports an input left empty.
 */
export type NativeMenuActionValues = {
  readonly enable: { readonly id: string }
  readonly disable: { readonly id: string }
  readonly remove: { readonly id: string }
  readonly 'move-up': { readonly id: string }
  readonly 'move-down': { readonly id: string }
  readonly 'reset-backoff': NativeMenuNoValues
  readonly 'enrollment-reset': NativeMenuNoValues
  readonly 'add-apikey': {
    readonly apiKey: string
    readonly label?: string | null
    readonly baseURL?: string | null
    readonly authHeader?: 'authorization-bearer' | 'x-api-key' | null
  }
  readonly 'add-oauth-start': NativeMenuNoValues
  readonly 'add-oauth-finish': {
    readonly code: string
    readonly label?: string | null
  }
  readonly 'custody-mode': { readonly mode: NativeMenuCustodyMode }
  readonly 'quota-refresh': NativeMenuNoValues
  readonly 'routing-mode': { readonly mode: NativeMenuRoutingMode }
  readonly 'routing-reset': NativeMenuNoValues
  readonly 'killswitch-on': NativeMenuNoValues
  readonly 'killswitch-off': NativeMenuNoValues
  readonly 'killswitch-set': {
    readonly entries: readonly NativeMenuKillswitchEntry[]
  }
  readonly 'cache-on': NativeMenuNoValues
  readonly 'cache-off': NativeMenuNoValues
  readonly 'cache-mode': { readonly mode: NativeMenuCacheMode }
  readonly 'cachekeep-always': NativeMenuNoValues
  readonly 'cachekeep-off': NativeMenuNoValues
  readonly 'cachekeep-window': {
    readonly startHour: number
    readonly endHour: number
  }
  readonly 'cachekeep-subagents': { readonly enabled: 'on' | 'off' }
  readonly 'dump-on': NativeMenuNoValues
  readonly 'dump-off': NativeMenuNoValues
  readonly 'logging-level': { readonly level: NativeMenuLogLevel }
  readonly 'fast-on': NativeMenuNoValues
  readonly 'fast-off': NativeMenuNoValues
  readonly 'prime-on': NativeMenuNoValues
  readonly 'prime-off': NativeMenuNoValues
  readonly 'start-fire': NativeMenuNoValues
}

/** A menu request as the shared UI hands it over, before any checking. */
export type NativeMenuRequest = {
  [Id in NativeMenuActionId]: NativeMenuActionValues[Id] extends NativeMenuNoValues
    ? { readonly action: Id; readonly values?: NativeMenuActionValues[Id] }
    : { readonly action: Id; readonly values: NativeMenuActionValues[Id] }
}[NativeMenuActionId]

/**
 * Actions whose effect belongs to one conversation: routing reset clears that
 * session's sticky assignment, lane start fires inside that session, and the
 * OAuth start/finish pair keeps its pending sign-in state per session.
 */
export type NativeMenuSessionActionId =
  | 'routing-reset'
  | 'start-fire'
  | 'add-oauth-start'
  | 'add-oauth-finish'

/** Custody changes are offline setup steps, so they are never dispatched. */
export type NativeMenuDispatchActionId = Exclude<
  NativeMenuActionId,
  'custody-mode'
>

/** Checked values: empty optional inputs are left out instead of `null`. */
export type NativeMenuDispatchValues<Id extends NativeMenuDispatchActionId> = {
  readonly [Key in keyof NativeMenuActionValues[Id]]: Exclude<
    NativeMenuActionValues[Id][Key],
    null
  >
}

/** A fully checked request, the only thing a host capability receives. */
export type NativeMenuDispatchRequest = {
  [Id in NativeMenuDispatchActionId]: {
    readonly action: Id
    readonly values: NativeMenuDispatchValues<Id>
  } & (Id extends NativeMenuSessionActionId
    ? { readonly sessionId: string }
    : { readonly sessionId?: never })
}[NativeMenuDispatchActionId]

export type NativeMenuDispatchOptions = {
  /** The caller's signal, passed on so a long capability may stop early. */
  readonly signal?: AbortSignal
}

/** What the host capability reports after it ran. */
export type NativeMenuCapabilityOutcome = {
  readonly ok: boolean
  readonly text: string
}

/**
 * The host capability that performs the real effect for a checked request.
 * It must accept every dispatchable action; a callback written for only some
 * actions does not satisfy this type.
 */
export type NativeMenuDispatch = (
  request: NativeMenuDispatchRequest,
  options: NativeMenuDispatchOptions,
) => Promise<NativeMenuCapabilityOutcome>

export type NativeMenuExecutorOptions = {
  readonly host: NativeMenuHost
  readonly dispatch: NativeMenuDispatch
}

/** Facts about the invocation that the safety rules depend on. */
export type NativeMenuExecutionContext = {
  /** False when no person can answer prompts (a headless or scripted run). */
  readonly interactive: boolean
  /** True once the person confirmed an action that requires confirmation. */
  readonly confirmed?: boolean
  /** The conversation the request came from, when the host has one. */
  readonly sessionId?: string
  readonly signal?: AbortSignal
}

export type NativeMenuExecutorRefusalCode =
  | NativeMenuRefusalCode
  | 'invalid-request'
  | 'invalid-context'
  | 'unsupported-action'
  | 'unknown-parameter'
  | 'missing-parameter'
  | 'invalid-parameter'
  | 'confirmation-required'
  | 'session-required'
  | 'aborted'

export type NativeMenuExecutionResult =
  | {
      /** The capability ran; `ok` and `text` are what it reported. */
      readonly status: 'executed'
      readonly action: NativeMenuDispatchActionId
      readonly ok: boolean
      readonly text: string
    }
  | {
      /**
       * The capability was called but threw, rejected, or returned something
       * unreadable. Whether its effect happened is unknown.
       */
      readonly status: 'failed'
      readonly action: NativeMenuDispatchActionId
      readonly code: 'execution-failed' | 'invalid-outcome'
    }
  | {
      /** Offline custody setup steps; nothing was changed. */
      readonly status: 'guidance'
      readonly action: 'custody-mode'
      readonly mode: NativeMenuCustodyMode
      readonly instructions: readonly string[]
    }
  | {
      /** Nothing was dispatched. */
      readonly status: 'refused'
      readonly code: NativeMenuExecutorRefusalCode
      readonly action?: NativeMenuActionId
      readonly parameter?: NativeMenuParameterId
    }

export type NativeMenuExecutor = {
  readonly execute: (
    request: NativeMenuRequest,
    context: NativeMenuExecutionContext,
  ) => Promise<NativeMenuExecutionResult>
}

const SESSION_ACTIONS: ReadonlySet<NativeMenuActionId> =
  new Set<NativeMenuActionId>([
    'routing-reset',
    'start-fire',
    'add-oauth-start',
    'add-oauth-finish',
  ])

const HOSTS: ReadonlySet<unknown> = new Set<NativeMenuHost>(['opencode', 'pi'])

// Captured once so a signal's state is read through the platform getter, not
// through any property a caller-made object could define.
const readAborted = Object.getOwnPropertyDescriptor(
  AbortSignal.prototype,
  'aborted',
)?.get

type Refusal = Extract<NativeMenuExecutionResult, { status: 'refused' }>

function refused(
  code: NativeMenuExecutorRefusalCode,
  action?: NativeMenuActionId,
  parameter?: NativeMenuParameterId,
): Refusal {
  return Object.freeze({
    status: 'refused',
    code,
    ...(action !== undefined ? { action } : {}),
    ...(parameter !== undefined ? { parameter } : {}),
  })
}

/**
 * Reads own data fields of a plain object without running caller code.
 * Proxies are rejected before any reflection, because even asking a proxy for
 * its prototype or keys runs its traps. Accessors, symbol keys, and objects
 * with another prototype are rejected rather than read. Returns `unknown-key`
 * when the object is well formed but carries a field outside `allowed`.
 */
function readPlain(
  value: unknown,
  allowed: readonly string[],
): Map<string, unknown> | 'malformed' | 'unknown-key' {
  if (value === null || typeof value !== 'object') return 'malformed'
  if (utilTypes.isProxy(value)) return 'malformed'
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return 'malformed'
  const fields = new Map<string, unknown>()
  let unknownKey = false
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') return 'malformed'
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) return 'malformed'
    if (!allowed.includes(key)) unknownKey = true
    else fields.set(key, descriptor.value)
  }
  return unknownKey ? 'unknown-key' : fields
}

/** Reads a dense plain array's elements without running caller code. */
function readArray(value: unknown): unknown[] | undefined {
  if (value === null || typeof value !== 'object') return undefined
  if (utilTypes.isProxy(value)) return undefined
  if (!Array.isArray(value)) return undefined
  if (Object.getPrototypeOf(value) !== Array.prototype) return undefined
  const lengthDescriptor = Reflect.getOwnPropertyDescriptor(value, 'length')
  const length = lengthDescriptor?.value
  if (typeof length !== 'number') return undefined
  const keys = Reflect.ownKeys(value)
  // Exactly the indices plus `length`: no holes, no extra or symbol keys.
  if (keys.length !== length + 1) return undefined
  const items: unknown[] = []
  for (let index = 0; index < length; index++) {
    const descriptor = Reflect.getOwnPropertyDescriptor(value, String(index))
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) return undefined
    items.push(descriptor.value)
  }
  return items
}

function hasContent(value: string): boolean {
  return /\S/.test(value)
}

/**
 * Non-negative safe integers, excluding -0: the values the command parsers
 * produce from digit-only text. No upper bound is applied, because the
 * killswitch parser applies none.
 */
function isDigitInteger(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    !Object.is(value, -0)
  )
}

/**
 * Whole hours 0..23, the bounds the `/claude-cachekeep HH-HH` parser in
 * cachekeep.ts accepts.
 */
function isHour(value: unknown): value is number {
  return isDigitInteger(value) && value <= 23
}

/**
 * Mirrors isValidApiBaseURL in accounts.ts (http or https, no embedded
 * credentials). That module is not imported because it pulls in storage code
 * this pure module must not depend on.
 */
function isApiBaseURL(value: string): boolean {
  try {
    const url = new URL(value.trim())
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      !url.username &&
      !url.password
    )
  } catch {
    return false
  }
}

/**
 * A non-blank account ID or the `main` / `all` selector. IDs are opaque: the
 * value is never split, trimmed, or mapped, and the host capability decides
 * whether it names a known account. The text command's rule against colons
 * only exists because it uses a colon as a delimiter; native route IDs contain
 * colons by design, so that rule does not apply to structured entries.
 */
function isKillswitchAccount(value: unknown): value is string {
  return typeof value === 'string' && hasContent(value)
}

const ENTRY_KEYS = ['account', 'fh', 'sd', 'scoped'] as const

function readKillswitchEntries(
  value: unknown,
): readonly NativeMenuKillswitchEntry[] | undefined {
  const items = readArray(value)
  // The parser treats `set` without any entry as a usage error.
  if (!items || items.length === 0) return undefined
  const entries: NativeMenuKillswitchEntry[] = []
  for (const item of items) {
    const fields = readPlain(item, ENTRY_KEYS)
    if (!(fields instanceof Map)) return undefined
    const account = fields.get('account')
    const fh = fields.get('fh')
    const sd = fields.get('sd')
    const scoped = fields.get('scoped')
    if (!isKillswitchAccount(account)) return undefined
    if (!isDigitInteger(fh) || !isDigitInteger(sd)) return undefined
    if (scoped !== undefined && !isDigitInteger(scoped)) return undefined
    entries.push(
      Object.freeze(
        scoped === undefined
          ? { account, fh, sd }
          : { account, fh, sd, scoped },
      ),
    )
  }
  return Object.freeze(entries)
}

type ParameterCheck =
  | { readonly ok: true; readonly present: boolean; readonly value?: unknown }
  | {
      readonly ok: false
      readonly code: 'missing-parameter' | 'invalid-parameter'
    }

const missing = { ok: false, code: 'missing-parameter' } as const
const invalid = { ok: false, code: 'invalid-parameter' } as const
const absent = { ok: true, present: false } as const

function accept(value: unknown): ParameterCheck {
  return { ok: true, present: true, value }
}

// Error codes name the parameter only; no submitted value is ever echoed, so
// a protected entry such as an API key cannot leak through a refusal.
function checkParameter(
  parameter: NativeMenuParameter,
  provided: boolean,
  value: unknown,
): ParameterCheck {
  const empty = !provided || value === undefined || value === null
  switch (parameter.kind) {
    case 'account-id':
      if (empty) return missing
      if (typeof value !== 'string') return invalid
      return hasContent(value) ? accept(value) : missing
    case 'text': {
      if (empty) return parameter.required ? missing : absent
      if (typeof value !== 'string') return invalid
      // The commands treat a blank optional input as not given.
      if (!hasContent(value)) return parameter.required ? missing : absent
      // The command parser takes the API key as one token, so it never
      // contains whitespace; a pasted key with a line break is refused.
      if (parameter.id === 'apiKey' && /\s/.test(value)) return invalid
      if (parameter.id === 'baseURL' && !isApiBaseURL(value)) return invalid
      return accept(value)
    }
    case 'choice':
      if (empty) return parameter.required ? missing : absent
      if (typeof value !== 'string') return invalid
      return (parameter.choices as readonly string[]).includes(value)
        ? accept(value)
        : invalid
    case 'number':
      if (empty) return missing
      return isHour(value) ? accept(value) : invalid
    case 'limit-entries': {
      if (empty) return missing
      const entries = readKillswitchEntries(value)
      return entries ? accept(entries) : invalid
    }
    default: {
      const unhandled: never = parameter
      return unhandled
    }
  }
}

function readSignal(value: unknown): AbortSignal | 'malformed' {
  if (value === null || typeof value !== 'object') return 'malformed'
  if (utilTypes.isProxy(value) || !readAborted) return 'malformed'
  try {
    // The platform getter throws for anything that is not a real signal.
    Reflect.apply(readAborted, value, [])
  } catch {
    return 'malformed'
  }
  return value as AbortSignal
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal !== undefined && readAborted !== undefined
    ? Reflect.apply(readAborted, signal, []) === true
    : false
}

type CheckedContext = {
  readonly interactive: boolean
  readonly confirmed: boolean
  readonly sessionId?: string
  readonly signal?: AbortSignal
}

const CONTEXT_KEYS = [
  'interactive',
  'confirmed',
  'sessionId',
  'signal',
] as const

function readContext(value: unknown): CheckedContext | undefined {
  const fields = readPlain(value, CONTEXT_KEYS)
  if (!(fields instanceof Map)) return undefined
  const interactive = fields.get('interactive')
  const confirmed = fields.get('confirmed')
  const sessionId = fields.get('sessionId')
  const rawSignal = fields.get('signal')
  if (typeof interactive !== 'boolean') return undefined
  if (confirmed !== undefined && typeof confirmed !== 'boolean')
    return undefined
  if (sessionId !== undefined && typeof sessionId !== 'string') return undefined
  let signal: AbortSignal | undefined
  if (rawSignal !== undefined) {
    const read = readSignal(rawSignal)
    if (read === 'malformed') return undefined
    signal = read
  }
  return {
    interactive,
    confirmed: confirmed === true,
    ...(sessionId !== undefined && hasContent(sessionId) ? { sessionId } : {}),
    ...(signal !== undefined ? { signal } : {}),
  }
}

type Plan =
  | { readonly kind: 'done'; readonly result: NativeMenuExecutionResult }
  | {
      readonly kind: 'dispatch'
      readonly action: NativeMenuDispatchActionId
      readonly request: NativeMenuDispatchRequest
      readonly options: NativeMenuDispatchOptions
    }

function done(result: NativeMenuExecutionResult): Plan {
  return { kind: 'done', result }
}

function plan(
  actions: ReadonlyMap<string, NativeMenuAction>,
  rawRequest: unknown,
  rawContext: unknown,
): Plan {
  const request = readPlain(rawRequest, ['action', 'values'])
  if (!(request instanceof Map)) return done(refused('invalid-request'))
  const actionId = request.get('action')
  if (typeof actionId !== 'string') return done(refused('invalid-request'))
  // Unknown names and actions this host does not offer are refused alike.
  const action = actions.get(actionId)
  if (!action) return done(refused('unsupported-action'))

  const context = readContext(rawContext)
  if (!context) return done(refused('invalid-context', action.id))
  if (action.interactive && !context.interactive)
    return done(refused(action.headlessRefusal, action.id))

  const rawValues = request.get('values')
  const allowed = action.parameters.map((parameter) => parameter.id)
  const values =
    rawValues === undefined
      ? new Map<string, unknown>()
      : readPlain(rawValues, allowed)
  if (values === 'malformed') return done(refused('invalid-request', action.id))
  if (values === 'unknown-key')
    return done(refused('unknown-parameter', action.id))

  const checked: Record<string, unknown> = {}
  for (const parameter of action.parameters) {
    const result = checkParameter(
      parameter,
      values.has(parameter.id),
      values.get(parameter.id),
    )
    if (!result.ok) return done(refused(result.code, action.id, parameter.id))
    if (result.present) checked[parameter.id] = result.value
  }
  // The cachekeep parser rejects a window that starts and ends on one hour.
  if (action.id === 'cachekeep-window' && checked.startHour === checked.endHour)
    return done(refused('invalid-parameter', action.id, 'endHour'))

  if (action.destructive && !context.confirmed)
    return done(refused('confirmation-required', action.id))
  const needsSession = SESSION_ACTIONS.has(action.id)
  if (needsSession && context.sessionId === undefined)
    return done(refused('session-required', action.id))
  if (isAborted(context.signal)) return done(refused('aborted', action.id))

  if (action.kind === 'setup-guidance') {
    return done(
      Object.freeze({
        status: 'guidance',
        action: action.id,
        mode: checked.mode as NativeMenuCustodyMode,
        instructions: action.setupInstructions,
      }),
    )
  }

  const dispatchRequest = Object.freeze({
    action: action.id,
    values: Object.freeze(checked),
    ...(needsSession ? { sessionId: context.sessionId } : {}),
  }) as NativeMenuDispatchRequest
  return {
    kind: 'dispatch',
    action: action.id,
    request: dispatchRequest,
    options: Object.freeze(
      context.signal !== undefined ? { signal: context.signal } : {},
    ),
  }
}

function readOutcome(
  action: NativeMenuDispatchActionId,
  outcome: unknown,
): NativeMenuExecutionResult {
  const fields = readPlain(outcome, ['ok', 'text'])
  const ok = fields instanceof Map ? fields.get('ok') : undefined
  const text = fields instanceof Map ? fields.get('text') : undefined
  if (typeof ok !== 'boolean' || typeof text !== 'string')
    return Object.freeze({ status: 'failed', action, code: 'invalid-outcome' })
  return Object.freeze({ status: 'executed', action, ok, text })
}

function invalidOption(key: string): TypeError {
  return new TypeError(`Native menu executor option ${key} is invalid`)
}

/**
 * Creates an executor for one host. The host's available actions and their
 * safety rules come from getNativeMenuModel; `dispatch` is captured once and
 * called only with fully checked requests.
 */
export function createNativeMenuExecutor(
  options: NativeMenuExecutorOptions,
): NativeMenuExecutor {
  const fields = readPlain(options, ['host', 'dispatch'])
  if (!(fields instanceof Map))
    throw new TypeError('Native menu executor options are invalid')
  const host = fields.get('host')
  const dispatch = fields.get('dispatch')
  if (!HOSTS.has(host)) throw invalidOption('host')
  if (typeof dispatch !== 'function' || utilTypes.isProxy(dispatch))
    throw invalidOption('dispatch')

  const actions = new Map<string, NativeMenuAction>()
  for (const group of getNativeMenuModel(host as NativeMenuHost).groups)
    for (const action of group.actions) actions.set(action.id, action)

  const execute = async (
    request: NativeMenuRequest,
    context: NativeMenuExecutionContext,
  ): Promise<NativeMenuExecutionResult> => {
    let next: Plan
    try {
      next = plan(actions, request, context)
    } catch {
      return refused('invalid-request')
    }
    if (next.kind === 'done') return next.result
    let outcome: unknown
    try {
      outcome = await Reflect.apply(dispatch, undefined, [
        next.request,
        next.options,
      ])
    } catch {
      // The thrown value is never read: it may carry secrets or run code.
      return Object.freeze({
        status: 'failed',
        action: next.action,
        code: 'execution-failed',
      })
    }
    return readOutcome(next.action, outcome)
  }
  return Object.freeze({ execute: Object.freeze(execute) })
}
