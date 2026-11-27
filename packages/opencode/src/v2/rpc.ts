import type {
  CommandApplyRequest,
  CommandDialogPayload,
  CommandInvocation,
  CommandMenu,
  NativeCommandApplyResult,
} from '@cortexkit/anthropic-auth-core'
import { logger } from '@cortexkit/anthropic-auth-core'
import type { Plugin } from '@opencode/plugin'
import type { Registration } from '@opencode/plugin/promise/registration'
import type { StandardSchemaV1 } from '@standard-schema/spec'
import { normalizeSidebarState, type SidebarState } from '../sidebar-state'
import type { NativeMenuCapabilities } from './menu-contract'

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const session = (
  value: unknown,
): value is Record<string, unknown> & { sessionId: string } =>
  record(value) &&
  typeof value.sessionId === 'string' &&
  value.sessionId.length > 0
const apply = (
  value: unknown,
): value is CommandApplyRequest & { sessionId: string } => {
  if (
    !session(value) ||
    !record(value) ||
    value.command !== 'claude' ||
    typeof value.sectionId !== 'string' ||
    typeof value.actionId !== 'string'
  )
    return false
  if (value.itemId !== undefined && typeof value.itemId !== 'string')
    return false
  if (value.confirmed !== undefined && typeof value.confirmed !== 'boolean')
    return false
  if (
    value.values !== undefined &&
    (!record(value.values) ||
      !Object.values(value.values).every(
        (entry) =>
          entry === null ||
          typeof entry === 'string' ||
          typeof entry === 'boolean' ||
          (typeof entry === 'number' && Number.isFinite(entry)),
      ))
  )
    return false
  return true
}
function schema<T>(
  valid: (value: unknown) => value is T,
): StandardSchemaV1<T, T> {
  return {
    '~standard': {
      version: 1 as const,
      vendor: 'cortexkit-native',
      validate: (value: unknown) =>
        valid(value)
          ? { value }
          : { issues: [{ message: 'Invalid native menu payload' }] },
    },
  }
}
// Validate the `claude` menu payload the plugin server sends over RPC: it must
// name the `claude` command and carry a menu with a title and a sections
// array, which the OpenCode 2 TUI in ./tui.ts reads to draw the menu.
const dialog = (value: unknown): value is CommandDialogPayload =>
  record(value) &&
  value.command === 'claude' &&
  record(value.menu) &&
  value.menu.command === 'claude' &&
  typeof value.menu.title === 'string' &&
  Array.isArray(value.menu.sections)
const result = (value: unknown): value is NativeCommandApplyResult =>
  record(value) &&
  value.command === 'claude' &&
  typeof value.ok === 'boolean' &&
  typeof value.text === 'string' &&
  (value.authorizationUrl === undefined ||
    typeof value.authorizationUrl === 'string') &&
  record(value.menu) &&
  Array.isArray(value.menu.sections)

type JsonValue =
  | null
  | string
  | boolean
  | number
  | JsonValue[]
  | { [key: string]: JsonValue }

let warnedInvalidSidebarField = false

// The host codec refuses undefined and non-finite numbers, even deep inside
// an output. Keep valid siblings if a future normalized field is not JSON.
// Invalid array entries become null so later entries keep their positions.
const repairSidebarJson = (
  value: unknown,
  path: string,
  ancestors = new Set<object>(),
): JsonValue | undefined => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'object' && value !== null && !ancestors.has(value)) {
    ancestors.add(value)
    if (Array.isArray(value)) {
      const repaired = Array.from(
        value,
        (entry, index) =>
          repairSidebarJson(entry, `${path}[${index}]`, ancestors) ?? null,
      )
      ancestors.delete(value)
      return repaired
    }
    if (
      Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null
    ) {
      const repaired = Object.fromEntries(
        Object.entries(value).flatMap(([key, entry]) => {
          const child = repairSidebarJson(entry, `${path}.${key}`, ancestors)
          return child === undefined ? [] : [[key, child]]
        }),
      )
      ancestors.delete(value)
      return repaired
    }
    ancestors.delete(value)
  }
  if (!warnedInvalidSidebarField) {
    warnedInvalidSidebarField = true
    // Never log the value: sidebar fields can originate in account storage.
    logger.warn('sidebar', 'Dropped non-JSON sidebar field', { path })
  }
  return undefined
}

const sidebarState: StandardSchemaV1<unknown, SidebarState> = {
  '~standard': {
    version: 1 as const,
    vendor: 'cortexkit-native',
    validate: (value: unknown) => {
      const state = normalizeSidebarState(value)
      return {
        value: repairSidebarJson(state, 'sidebar') as unknown as SidebarState,
      }
    },
  },
}

export const NATIVE_MENU_RPC = {
  id: 'cortexkit-anthropic-native',
  methods: {
    open: { input: schema(session), output: schema(dialog) },
    apply: { input: schema(apply), output: schema(result) },
    sidebar: { input: schema(session), output: sidebarState },
  },
  events: {
    opened: {
      schema: schema(
        (
          value: unknown,
        ): value is { sessionId: string; payload: CommandDialogPayload } =>
          session(value) && dialog(value.payload),
      ),
    },
    notification: {
      schema: schema(
        (
          value: unknown,
        ): value is {
          sessionId: string
          message: string
          kind: 'info' | 'warning' | 'error'
        } =>
          session(value) &&
          typeof value.message === 'string' &&
          ['info', 'warning', 'error'].includes(String(value.kind)),
      ),
    },
  },
} as const

/** OpenCode routes these RPC calls to the current project. No separate loopback server is started. */
export async function registerNativeMenu(
  ctx: Pick<Plugin.Context, 'rpc' | 'command' | 'event'>,
  command: CommandMenu,
  capabilities: NativeMenuCapabilities,
): Promise<Registration> {
  const abort = new AbortController()
  const invocation = (sessionId: string): CommandInvocation => ({
    sessionId,
    notify(message, kind = 'info') {
      void rpc.events
        .emit('notification', { sessionId, message, kind })
        .catch(() => {})
    },
  })
  const rpc = await ctx.rpc.register(NATIVE_MENU_RPC, {
    open: (input) => command.open(invocation(input.sessionId)),
    apply: (input) => command.apply(input, invocation(input.sessionId)),
    sidebar: (input) => capabilities.readSidebar(input.sessionId),
  })
  let registered: Registration
  try {
    registered = await ctx.command.transform((editor) =>
      editor.add({
        name: 'claude',
        description: 'Native Claude accounts and settings',
        async execute(input) {
          const payload = await command.open(invocation(input.sessionID))
          await rpc.events.emit('opened', {
            sessionId: input.sessionID,
            payload,
          })
        },
      }),
    )
  } catch (error) {
    await rpc.dispose()
    throw error
  }
  const listener = (async () => {
    try {
      for await (const event of ctx.event.subscribe({
        signal: abort.signal,
        types: ['session.deleted'],
      })) {
        if (event.type === 'session.deleted')
          capabilities.forgetSession(event.data.sessionID)
      }
    } catch {
      /* The OpenCode event subscription (ctx.event.subscribe) ends when dispose()
         aborts it or OpenCode closes it while unloading the plugin. Log nothing
         here: host events can carry conversation and tool content. */
    }
  })()
  let disposed = false
  return {
    async dispose() {
      if (disposed) return
      disposed = true
      abort.abort()
      await Promise.all([rpc.dispose(), registered.dispose(), listener])
    },
  }
}
