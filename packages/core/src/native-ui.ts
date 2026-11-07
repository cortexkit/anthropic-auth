import { types as utilTypes } from 'node:util'
import {
  VAULT_HOST_CONNECT_REFUSAL,
  VAULT_HOST_STATUS,
} from '@cortexkit/common-auth/claustrum'
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
import { isVaultHosted } from './native-vault-host.ts'

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
  AUTHORIZE_URLS,
  CLIENT_ID,
  CODE_CALLBACK_URL,
  OAUTH_SCOPES,
} from './constants.ts'
import {
  createNativeMenuExecutor,
  type NativeMenuDispatch,
  type NativeMenuExecutionResult,
  type NativeMenuRequest,
  type NativeVaultDisconnect,
  type NativeVaultDisconnectResult,
} from './native-menu-executor.ts'
import {
  getNativeMenuModel,
  isNativeMenuLocalCustodyAction,
  listNativeMenuActions,
  type NativeMenuAction,
  type NativeMenuCommandId,
  type NativeMenuCustodyMode,
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
  /**
   * Reads the host's current credential custody from its enrollment record,
   * never from status text. It is called each time the menu opens or applies
   * an action, so connecting or disconnecting the vault takes effect without
   * rebuilding the menu. Under 'claustrum' the menu leaves out and refuses
   * actions offered only under local custody: host-local account and
   * credential writes, and enrollment reset. A rejection or any other value
   * is treated as unknown custody, which also withholds them.
   */
  readonly readMode: () => Promise<NativeMenuCustodyMode>
  /** Token-free account names, credential IDs and states used to show which vault account needs re-login and its replacement command. */
  readonly readAccounts?: () => Promise<
    import('./native-account-view.ts').NativeAccountSnapshot
  >
  /** Re-read the separate host-login notice on each local Accounts render. */
  readonly readSeparateHostLoginNotice?: () => Promise<boolean>
  /**
   * Disconnects this host from the vault; while enrolled, this is the host's
   * only enrollment action. Before ending the enrollment, the callback
   * restores any host sign-in set aside when the host joined the vault. If
   * that restore would overwrite a sign-in the host already has, the callback
   * reports `conflict` and leaves the enrollment in place. Every host must
   * supply it: a host enrolled in the vault, or with an unreadable
   * enrollment, always needs a way back to local accounts.
   */
  readonly disconnectVault: NativeVaultDisconnect
  /** The host sets this flag; RPC callers cannot declare themselves interactive. */
  readonly interactive: boolean
}

/** Shown in Accounts while the vault owns this host's accounts. */
const VAULT_ACCOUNTS_GUIDANCE =
  'Accounts are managed in the vault. Disconnect from the vault to use local accounts.'
/** Shown in Accounts when the host's custody mode cannot be read. */
const UNKNOWN_CUSTODY_GUIDANCE =
  'Account custody could not be read, so local account changes are unavailable.'

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
        label:
          parameter.id === 'maxSameAccountWait'
            ? 'Longest wait on the same account'
            : parameter.id,
        choices: [
          ...(!parameter.required ? [{ value: '', label: 'Default' }] : []),
          ...parameter.choices.map((value) => ({
            value,
            label:
              parameter.id === 'maxSameAccountWait'
                ? {
                    '0': "Don't wait",
                    '15': '15 minutes',
                    max: 'Until the cache expires',
                  }[value as '0' | '15' | 'max']
                : value,
          })),
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

/**
 * The query parameters authorize() sets with fixed values. A sign-in link
 * also carries its per-login PKCE challenge and state, and nothing else.
 */
const SIGN_IN_QUERY: Readonly<Record<string, string>> = {
  code: 'true',
  client_id: CLIENT_ID,
  response_type: 'code',
  redirect_uri: CODE_CALLBACK_URL,
  scope: OAUTH_SCOPES.join(' '),
  code_challenge_method: 'S256',
}
const SIGN_IN_KEYS = [...Object.keys(SIGN_IN_QUERY), 'code_challenge', 'state']
const SIGN_IN_ENDPOINTS: ReadonlySet<string> = new Set(
  Object.values(AUTHORIZE_URLS),
)
/** Base64url of a SHA-256 digest, the S256 challenge generatePKCE() makes. */
const PKCE_CHALLENGE = /^[A-Za-z0-9_-]{43}$/
/** A UUID's 32 lowercase hex digits, the state authorize() generates. */
const SIGN_IN_STATE = /^[0-9a-f]{32}$/

/**
 * True only for a URL exactly as authorize() builds it: a known Anthropic
 * authorize endpoint, the fixed client, callback and scopes, one PKCE
 * challenge and one state of the generated shapes, written in canonical form
 * with no credentials, port, fragment or extra parameter.
 */
function isSignInLink(candidate: string): boolean {
  let url: URL
  try {
    url = new URL(candidate)
  } catch {
    return false
  }
  if (
    url.href !== candidate ||
    candidate.includes('#') ||
    url.username !== '' ||
    url.password !== '' ||
    !SIGN_IN_ENDPOINTS.has(`${url.origin}${url.pathname}`)
  )
    return false
  const keys = [...url.searchParams.keys()]
  if (
    keys.length !== SIGN_IN_KEYS.length ||
    !SIGN_IN_KEYS.every((key) => keys.includes(key))
  )
    return false
  return (
    Object.entries(SIGN_IN_QUERY).every(
      ([key, value]) => url.searchParams.get(key) === value,
    ) &&
    PKCE_CHALLENGE.test(url.searchParams.get('code_challenge') ?? '') &&
    SIGN_IN_STATE.test(url.searchParams.get('state') ?? '')
  )
}

/**
 * Text for a successful OAuth start. The person must open the authorize URL
 * with its state intact, or the pasted code cannot be matched to the pending
 * login. The redactor masks the 32-hex-digit state as a possible secret, so
 * exactly one link that passes isSignInLink is kept verbatim and the text
 * around it is still scrubbed. The state and PKCE challenge are public parts
 * of the browser request; the PKCE verifier never appears in the link. When
 * the text holds no valid sign-in link, or several distinct ones, it is
 * scrubbed in full and no link is returned.
 */
function showSignInLink(
  text: string,
  scrub: (text: string) => string,
): { text: string; link?: string } {
  const links = new Set(
    (text.match(/https:\/\/\S+/g) ?? []).filter(isSignInLink),
  )
  const [link] = links
  if (links.size !== 1 || link === undefined) return { text: scrub(text) }
  return { text: text.split(link).map(scrub).join(link), link }
}

/**
 * A menu result as Core returns it. After a successful OAuth start,
 * `authorizationUrl` carries the one checked sign-in link from `text` as its
 * own field, so a host can show it in a dialog of its own instead of finding
 * it in the message text. Every other result leaves it out.
 */
export type NativeCommandApplyResult = CommandApplyResult & {
  readonly authorizationUrl?: string
}

/** What a person sees for each result of a vault disconnect. */
const DISCONNECT_OUTCOMES: Readonly<
  Record<NativeVaultDisconnectResult, ReturnType<typeof outcome>>
> = {
  disconnected: {
    ok: true,
    text: 'Disconnected from the vault. This host uses local accounts again.',
  },
  idle: {
    ok: true,
    text: 'This host has no active vault enrollment.',
  },
  busy: {
    ok: false,
    code: 'busy',
    text: "Vault disconnect could not finish because another process is changing this host's enrollment. Try again.",
  },
  conflict: {
    ok: false,
    code: 'conflict',
    text: 'Disconnect stopped: this host already has a different stored sign-in, so it and the sign-in saved when the host joined the vault were both kept, and the vault connection remains. Resolve the two sign-ins with offline setup.',
  },
}

const DISCONNECT_FAILURES = {
  'disconnect-unsafe-file':
    'Check file ownership, private permissions, and safe storage. Then try Disconnect again. Do not delete enrollment files by hand.',
  'disconnect-wrong-consumer':
    'The enrollment belongs to another host or plugin. Check this host’s enrollment path. Then try Disconnect again. Do not delete another host’s enrollment.',
  'disconnect-pi-recovery':
    'Repair the Pi sign-in and its private recovery copy with offline setup. Keep both files. Then try Disconnect again.',
  'disconnect-conflict':
    'Resolve the stored Pi sign-in and its private recovery copy with offline setup. Keep both sign-ins. Then try Disconnect again.',
  'disconnect-busy':
    'Stop other setup or disconnect attempts. Then try Disconnect again.',
  'disconnect-io':
    'Check file access and free disk space. Then try Disconnect again.',
  'execution-failed':
    'Check this host’s vault connection and file access. Then try Disconnect again.',
  'invalid-outcome':
    'Check this host’s vault connection and file access. Then try Disconnect again.',
} satisfies Record<
  Extract<NativeMenuExecutionResult, { status: 'failed' }>['code'],
  string
>

function outcome(
  result: NativeMenuExecutionResult,
  host: NativeMenuHost,
): {
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
    case 'disconnect':
      return DISCONNECT_OUTCOMES[result.result]
    case 'failed':
      if (result.action === 'vault-disconnect')
        return {
          ok: false,
          code: result.code,
          text: `${host === 'opencode' ? 'OpenCode' : 'Pi'} could not disconnect from the vault. ${DISCONNECT_FAILURES[result.code]}`,
        }
      return { ok: false, code: result.code, text: 'Action failed.' }
    case 'refused':
      if (result.code === 'vault-managed')
        return {
          ok: false,
          code: result.code,
          text: `Action refused: ${VAULT_ACCOUNTS_GUIDANCE}`,
        }
      if (result.code === 'vault-not-connected')
        return {
          ok: false,
          code: result.code,
          text: 'Action refused: this host is not connected to the vault.',
        }
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
  const { host, dispatch, readStatus, readMode, disconnectVault, interactive } =
    options
  if (typeof readMode !== 'function')
    throw new TypeError('Native UI requires a custody mode reader')
  if (typeof disconnectVault !== 'function')
    throw new TypeError('Native UI requires a vault disconnect callback')
  // Look up submitted actions in every action the host supports under either
  // custody mode, not just the ones currently shown. A hidden or stale action
  // is then still recognised, and its secret input keys (an API key or OAuth
  // code) are known, so the refusal and any status notification redact them.
  const catalog = listNativeMenuActions(host)
  const executor = createNativeMenuExecutor({
    host,
    dispatch,
    disconnectVault,
  })
  const protectedIds = new Set(
    catalog.flatMap((action) =>
      action.parameters.flatMap((parameter) =>
        parameter.kind === 'text' && parameter.protectedEntry
          ? [parameter.id]
          : [],
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

  /**
   * Reads custody for one open or apply. Only the two known modes count; a
   * rejection or any other value is unknown, never local. The rejection value
   * is not inspected because it could quote credentials.
   */
  async function readCustody(): Promise<NativeMenuCustodyMode | undefined> {
    if (isVaultHosted()) return 'claustrum'
    try {
      const mode: unknown = await readMode()
      return mode === 'local' || mode === 'claustrum' ? mode : undefined
    } catch {
      return undefined
    }
  }

  async function model(
    invocation: CommandInvocation,
    scrub: (text: string) => string = redact,
    readable = true,
  ): Promise<CommandMenuModel> {
    const safeInvocation = capture(invocation, scrub)
    const custody = await readCustody()
    const hosted = isVaultHosted()
    // When the custody mode cannot be read, the menu shows the vault
    // (claustrum) action set. Sign-in, API-key, removal and reordering
    // actions stay hidden because they would write this host's own account
    // files. Account enable, disable, reset-backoff, plugin settings and
    // vault disconnect remain, so a host whose enrollment is corrupt can
    // still disconnect and return to local accounts.
    const offered = getNativeMenuModel(host, custody ?? 'claustrum')
    const sections = []
    for (const group of offered.groups) {
      const lines: string[] = []
      if (group.id === 'Accounts' && custody === 'local') {
        try {
          if ((await options.readSeparateHostLoginNotice?.()) === true)
            lines.push(
              "OpenCode's separate Anthropic login is not used. Add that account through /claude Accounts if needed, or remove the separate login from OpenCode.",
            )
        } catch {
          // Notice failures must not expose errors that could contain secrets.
        }
      }
      if (group.id === 'Accounts' && custody !== 'local')
        lines.push(
          hosted
            ? VAULT_HOST_STATUS
            : custody === 'claustrum'
              ? VAULT_ACCOUNTS_GUIDANCE
              : UNKNOWN_CUSTODY_GUIDANCE,
        )
      if (
        group.id === 'Accounts' &&
        custody === 'claustrum' &&
        options.readAccounts
      ) {
        try {
          const snapshot = await options.readAccounts()
          for (const account of snapshot.accounts) {
            if (
              account.source === 'vault' &&
              account.state === 'needs_reauth' &&
              account.credentialId
            )
              lines.push(
                scrub(
                  `${account.label || account.id} (${account.credentialId}) needs signing in again. Run: ck auth login --provider anthropic --id ${account.credentialId} --replace`,
                ),
              )
          }
        } catch {
          lines.push(
            'Vault sign-in status unavailable; reopen /claude to retry.',
          )
        }
      }
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
        actions: group.actions
          .filter(
            (action) =>
              !hosted ||
              !['custody-mode', 'vault-disconnect'].includes(action.id),
          )
          .map((action) => ({
            id: action.id,
            label: action.label,
            knobs: action.parameters.map(knob),
            ...(action.destructive
              ? {
                  confirm: {
                    message: action.confirm,
                    // Disconnecting is reversed by connecting the host to the
                    // vault again with offline setup. Removal and enrollment
                    // reset cannot be reversed that way.
                    irreversible: action.kind !== 'vault-disconnect',
                  },
                }
              : {}),
            ...(action.kind === 'setup-guidance'
              ? {
                  description:
                    'Offline guidance only; no settings are changed.',
                }
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
    async apply(rawRequest, rawInvocation): Promise<NativeCommandApplyResult> {
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
      const action: NativeMenuAction | undefined = catalog.find(
        (entry) =>
          entry.id === request?.actionId && entry.group === request?.sectionId,
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
      const finish = async (
        result: ReturnType<typeof outcome>,
        signInLink = false,
      ): Promise<NativeCommandApplyResult> => {
        const shown = signInLink
          ? showSignInLink(result.text, scrub)
          : { text: scrub(result.text) }
        return {
          command: 'claude',
          ...result,
          text: shown.text,
          ...(shown.link !== undefined ? { authorizationUrl: shown.link } : {}),
          // Without readable data fields there is no safe way to identify a
          // submitted secret. Do not invoke status callbacks that could echo it.
          menu: await model(invocation, scrub, readable),
        }
      }
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
      // The custody mode is read again for every apply. The menu may have
      // been opened under the other mode, and an action the current mode
      // does not offer must be refused before it reaches the host.
      const custody = await readCustody()
      if (
        isVaultHosted() &&
        ['custody-mode', 'vault-disconnect'].includes(action.id)
      )
        return finish({
          ok: false,
          code: 'custody-unavailable',
          text: VAULT_HOST_CONNECT_REFUSAL,
        })
      // Unknown custody refuses local-custody actions here. Vault disconnect
      // stays available because a corrupted enrollment must keep a recovery
      // action. The host's disconnect callback does the safety checks: it
      // deletes only this host's enrollment token and ceremony record, and
      // refuses if either file has the wrong owner or is readable by others.
      // For Pi it first restores the Anthropic sign-in that enrollment moved
      // out of Pi's auth file, and stops without disconnecting if that would
      // overwrite a sign-in Pi already has.
      if (custody === undefined && isNativeMenuLocalCustodyAction(action.id))
        return finish({
          ok: false,
          code: 'custody-unavailable',
          text: `Action refused: ${UNKNOWN_CUSTODY_GUIDANCE}`,
        })
      // The scalar transport cannot express the correlated native request type.
      // This is the untrusted boundary: the executor checks every field before
      // the injected capability receives a typed NativeMenuDispatchRequest.
      const result = await executor.execute(
        { action: action.id, values } as NativeMenuRequest,
        {
          interactive,
          custodyMode: custody ?? 'claustrum',
          confirmed: request.confirmed,
          sessionId: invocation.sessionId,
        },
      )
      // Only the checked OAuth start that the host reports as successful may
      // show its sign-in link. Status lines and notifications stay scrubbed.
      return finish(
        outcome(result, host),
        result.status === 'executed' &&
          result.action === 'add-oauth-start' &&
          result.ok &&
          protectedValues.length === 0,
      )
    },
  }
}
