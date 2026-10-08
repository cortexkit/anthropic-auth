import { types as utilTypes } from 'node:util'
import {
  type CommandApplyResult,
  type CommandInvocation,
  type CommandMenu,
  type CommandMenuModel,
  createTextRedactor,
  type MenuKnob,
  parseApplyRequest,
  type SectionSlot,
} from '@cortexkit/common-auth/commands'

export type {
  CommandApplyRequest,
  CommandApplyResult,
  CommandDialogPayload,
  CommandInvocation,
  CommandMenu,
  CommandMenuModel,
  KnobValue,
  KnobValues,
  MenuAction,
  MenuItem,
  MenuKnob,
  MenuSection,
  NotifyKind,
  SectionSlot,
} from '@cortexkit/common-auth/commands'
// Export the menu renderer from @cortexkit/anthropic-auth-core so the Pi
// extension does not need a separate common-auth installation.
export {
  parseApplyRequest,
  runPiCommandMenu,
} from '@cortexkit/common-auth/commands'

import {
  createNativeMenuExecutor,
  type NativeMenuDispatch,
  type NativeMenuExecutionResult,
  type NativeMenuRequest,
} from './native-menu-executor.ts'
import {
  getNativeMenuModel,
  type NativeMenuAction,
  type NativeMenuCommandId,
  type NativeMenuGroupId,
  type NativeMenuHost,
  type NativeMenuParameter,
} from './native-menu-model.ts'

export interface NativeUiOptions {
  readonly host: NativeMenuHost
  /** Execute account/settings changes and host actions; this adapter never writes their storage. */
  readonly dispatch: NativeMenuDispatch
  /** Read-only account, quota and settings status. Exclude OAuth tokens, API keys and other secrets. */
  readonly readStatus: (
    command: Exclude<NativeMenuCommandId, 'start'>,
    invocation: CommandInvocation,
  ) => Promise<string>
  /** The host sets this flag; RPC callers cannot declare themselves interactive. */
  readonly interactive: boolean
}

const slots: Record<NativeMenuGroupId, SectionSlot> = {
  Accounts: 'accounts',
  Quota: 'quota',
  Routing: 'routing',
  Limits: 'limits',
  Cache: 'cache',
  Diagnostics: 'diagnostics',
  Extras: 'extra',
}

/** Inspect data fields only; rejected input must not run credential getters. */
function ownData(value: unknown, key: string): unknown {
  if (value === null || typeof value !== 'object' || utilTypes.isProxy(value))
    return undefined
  try {
    const field = Object.getOwnPropertyDescriptor(value, key)
    return field && 'value' in field ? field.value : undefined
  } catch {
    return undefined
  }
}

/** Parsing reads properties, so reject getters, proxies and non-plain objects before it runs. */
function isDataRecord(value: unknown): boolean {
  if (value === null || typeof value !== 'object' || utilTypes.isProxy(value))
    return false
  try {
    if (Array.isArray(value)) return false
    const prototype: unknown = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return false
    return Reflect.ownKeys(value).every((key) => {
      const field = Object.getOwnPropertyDescriptor(value, key)
      return field !== undefined && 'value' in field
    })
  } catch {
    return false
  }
}

function knob(parameter: NativeMenuParameter): MenuKnob {
  switch (parameter.kind) {
    case 'choice':
      return {
        kind: 'choice',
        id: parameter.id,
        label: parameter.id,
        choices: [
          ...(!parameter.required ? [{ value: '', label: 'Default' }] : []),
          ...parameter.choices.map((value) => ({ value, label: value })),
        ],
      }
    case 'number':
      return {
        kind: 'number',
        id: parameter.id,
        label: parameter.id,
        required: true,
        min: 0,
        max: 23,
      }
    case 'account-id':
      return {
        kind: 'text',
        id: parameter.id,
        label: 'Account ID (copy the complete ID from status)',
        required: true,
      }
    case 'text':
      return {
        kind: 'text',
        id: parameter.id,
        label: parameter.id,
        required: parameter.required,
        masked: parameter.protectedEntry,
      }
    case 'limit-entries':
      // Each menu input holds a scalar value. JSON carries threshold rows
      // without splitting account IDs that contain colons; fh and sd are
      // five-hour and seven-day percentages, and scoped is model-specific.
      return {
        kind: 'text',
        id: parameter.id,
        label: 'Threshold rows as JSON: account, fh, sd, optional scoped',
        required: true,
        placeholder: '[{"account":"main","fh":5,"sd":10,"scoped":0}]',
      }
  }
}

function outcome(result: NativeMenuExecutionResult): {
  ok: boolean
  text: string
  code?: string
  needsConfirmation?: boolean
} {
  switch (result.status) {
    case 'executed':
      return {
        ok: result.ok,
        text: result.text,
        ...(!result.ok ? { code: 'refused' } : {}),
      }
    case 'guidance':
      return {
        ok: true,
        text: `Offline ${result.mode} setup guidance (nothing changed):\n${result.instructions.join('\n')}`,
      }
    case 'failed':
      return { ok: false, code: result.code, text: 'Action failed.' }
    case 'refused':
      return {
        ok: false,
        code: result.code,
        text: `Action refused: ${result.code}${result.parameter ? ` (${result.parameter})` : ''}.`,
        ...(result.code === 'confirmation-required'
          ? { needsConfirmation: true }
          : {}),
      }
  }
}

/**
 * Builds the Claude menu from the supported commands for OpenCode or Pi.
 * Shared renderers display it, but each submitted action still goes through
 * input validation, required confirmation and host capability checks.
 * Credential fields never contain saved values. Current host input controls
 * display typed text even when the field requests masking; do not promise
 * hidden entry until those controls support it.
 */
export function createNativeUi(options: NativeUiOptions): CommandMenu {
  const { host, dispatch, readStatus, interactive } = options
  const native = getNativeMenuModel(host)
  const executor = createNativeMenuExecutor({ host, dispatch })
  const protectedIds = new Set(
    native.groups.flatMap((group) =>
      group.actions.flatMap((action) =>
        action.parameters.flatMap((parameter) =>
          parameter.kind === 'text' && parameter.protectedEntry
            ? [parameter.id]
            : [],
        ),
      ),
    ),
  )
  const redact = createTextRedactor({
    extraValuePatterns: [/sk-ant-[A-Za-z0-9_-]+/g],
  })

  function capture(
    invocation: CommandInvocation,
    scrub: (text: string) => string = redact,
  ): CommandInvocation {
    const { sessionId, notify } = invocation
    return {
      ...(sessionId !== undefined ? { sessionId } : {}),
      notify: (text, kind) => notify(scrub(text), kind),
    }
  }

  async function model(
    invocation: CommandInvocation,
    scrub: (text: string) => string = redact,
    readable = true,
  ): Promise<CommandMenuModel> {
    const safeInvocation = capture(invocation, scrub)
    const sections = []
    for (const group of native.groups) {
      const lines: string[] = []
      for (const status of group.statuses) {
        if (!readable) {
          lines.push(`${status.label}: status unavailable.`)
          continue
        }
        try {
          lines.push(scrub(await readStatus(status.command, safeInvocation)))
        } catch {
          // Arbitrary thrown values can quote credentials; never inspect them.
          lines.push(`${status.label}: status unavailable.`)
        }
      }
      sections.push({
        id: group.id,
        slot: slots[group.id],
        title: group.id,
        lines,
        items: [],
        actions: group.actions.map((action) => ({
          id: action.id,
          label: action.label,
          knobs: action.parameters.map(knob),
          ...(action.destructive
            ? { confirm: { message: action.confirm, irreversible: true } }
            : {}),
          ...(action.kind === 'setup-guidance'
            ? { description: 'Offline guidance only; no settings are changed.' }
            : {}),
        })),
      })
    }
    return { command: 'claude', title: 'Claude', sections }
  }

  return {
    command: 'claude',
    async open(invocation) {
      return { command: 'claude', menu: await model(capture(invocation)) }
    },
    async apply(rawRequest, rawInvocation): Promise<CommandApplyResult> {
      const invocation = capture(rawInvocation)
      let request: ReturnType<typeof parseApplyRequest>
      const rawValues = ownData(rawRequest, 'values')
      const readable =
        isDataRecord(rawRequest) &&
        (rawValues === undefined || isDataRecord(rawValues))
      try {
        request = readable ? parseApplyRequest(rawRequest) : undefined
      } catch {
        // An in-process caller can supply throwing accessors, unlike JSON RPC.
        // Refuse without inspecting the thrown value.
        request = undefined
      }
      const group = native.groups.find(
        (entry) => entry.id === request?.sectionId,
      )
      const action: NativeMenuAction | undefined = group?.actions.find(
        (entry) => entry.id === request?.actionId,
      )
      const values: Record<string, unknown> = { ...request?.values }
      // Status callbacks can reflect submitted input even after a request was
      // refused. Collect protected data fields independently of action lookup
      // and parsing, then scrub both returned text and invocation notifications.
      const protectedValues: string[] = []
      for (const id of protectedIds) {
        for (const submitted of [values, rawValues]) {
          const value = ownData(submitted, id)
          if (typeof value === 'string' && value.length > 0)
            protectedValues.push(value)
        }
      }
      const scrub = (text: string) => {
        let safe = text
        for (const value of protectedValues)
          safe = safe.split(value).join('[REDACTED]')
        return redact(safe)
      }
      const finish = async (result: ReturnType<typeof outcome>) => ({
        command: 'claude',
        ...result,
        text: scrub(result.text),
        // Without readable data fields there is no safe way to identify a
        // submitted secret. Do not invoke status callbacks that could echo it.
        menu: await model(invocation, scrub, readable),
      })
      if (
        request?.command !== 'claude' ||
        !action ||
        request.itemId !== undefined ||
        (request.sessionId !== undefined &&
          request.sessionId !== invocation.sessionId)
      ) {
        return finish({
          ok: false,
          code: 'invalid-request',
          text: 'Invalid menu request.',
        })
      }
      for (const parameter of action.parameters) {
        if (
          parameter.kind === 'choice' &&
          !parameter.required &&
          values[parameter.id] === ''
        )
          values[parameter.id] = null
        if (
          parameter.kind === 'limit-entries' &&
          typeof values[parameter.id] === 'string'
        ) {
          try {
            const decoded: unknown = JSON.parse(String(values[parameter.id]))
            values[parameter.id] = decoded
          } catch {
            return finish({
              ok: false,
              code: 'invalid-parameter',
              text: 'Threshold rows must be valid JSON.',
            })
          }
        }
      }
      // The scalar transport cannot express the correlated native request type.
      // This is the untrusted boundary: the executor checks every field before
      // the injected capability receives a typed NativeMenuDispatchRequest.
      const result = await executor.execute(
        { action: action.id, values } as NativeMenuRequest,
        {
          interactive,
          confirmed: request.confirmed,
          sessionId: invocation.sessionId,
        },
      )
      return finish(outcome(result))
    },
  }
}
