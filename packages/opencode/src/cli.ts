#!/usr/bin/env node

import { stdin as input, stdout as output } from 'node:process'
import { createInterface } from 'node:readline/promises'
import {
  authorize,
  createNativeAccountRuntime,
  decideOpenCodeStateLayoutOnce,
  exchange,
  formatNativeAccountState,
  generateRelayToken,
  getAccountStoragePath,
  isValidApiBaseURL,
  type NativeAccountRuntime,
  readNativeEnrollmentMode,
  resolveNativePoolPaths,
  WORKER_SCRIPT,
} from '@cortexkit/anthropic-auth-core'
import { type CliFailureStage, reportThrownFailure } from './cli-failure.ts'

async function withNativeAccounts<T>(
  run: (runtime: NativeAccountRuntime) => Promise<T>,
): Promise<T> {
  if (process.env.OPENCODE_AUTH_CONTENT !== undefined)
    throw new Error(
      'Native account changes require offline setup without OPENCODE_AUTH_CONTENT',
    )
  // Decide where the account state is before resolving any of its paths:
  // the config folder, or the state folder once it has moved there. The
  // decision also records that this command uses those files, so a later
  // version never moves them while it runs. It is made once per process.
  // A refusal reaches the failure handler, which prints its fixed text.
  const decision = await decideOpenCodeStateLayoutOnce({
    role: 'cli',
    requireExistingAuthority: true,
  })
  const paths = await resolveNativePoolPaths(
    undefined,
    undefined,
    decision.layout,
  )
  const runtime = createNativeAccountRuntime({ paths, host: 'opencode' })
  try {
    await runtime.read()
    return await run(runtime)
  } finally {
    if (decision.kind !== 'state-home') decision.registration?.close()
    await runtime.close()
  }
}

/**
 * This host's Claustrum enrollment files, not account settings, decide whether
 * credentials come from the vault. In vault mode the local account pool must
 * not gain accounts, so commands that add local credentials refuse before
 * reading the pool or asking for anything, and check again right before
 * writing in case setup enrolled the host while a prompt was open. Unreadable
 * enrollment state throws as well: it never counts as local mode.
 */
async function requireLocalCustody() {
  if ((await readNativeEnrollmentMode('opencode', process.env)) !== 'local')
    throw new Error('Disconnect from the vault first.')
}

function usage() {
  console.log(`Usage:
  opencode-anthropic-auth setup [--yes] [--dry-run]
  opencode-anthropic-auth login [label]
  opencode-anthropic-auth api add [label]
  opencode-anthropic-auth list
  opencode-anthropic-auth relay setup

Setup --yes selects every found host, including Pi. Run setup without --yes to choose hosts.
Run setup --help to list every setup option.
Native credentials are managed by the offline setup migration.
Legacy import source:
  ${getAccountStoragePath()}`)
}

function requireText(value: string | undefined, name: string) {
  const trimmed = value?.trim()
  if (!trimmed) throw new Error(`${name} is required`)
  return trimmed
}

async function cloudflareRequest<T>(options: {
  token: string
  method: string
  path: string
  body?: RequestInit['body']
  headers?: Record<string, string>
  fetchImpl?: FetchLike
}) {
  const fetchImpl = options.fetchImpl ?? fetch
  const response = await fetchImpl(
    `https://api.cloudflare.com/client/v4${options.path}`,
    {
      method: options.method,
      headers: {
        authorization: `Bearer ${options.token}`,
        ...(options.body instanceof FormData
          ? {}
          : { 'content-type': 'application/json' }),
        ...options.headers,
      },
      body: options.body,
    },
  )
  const text = await response.text()
  let data: {
    success?: boolean
    result?: T
    errors?: Array<{ message?: string }>
  }
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error(`Cloudflare API returned ${response.status}: ${text}`)
  }
  if (!response.ok || data.success === false) {
    const message = data.errors
      ?.map((error) => error.message)
      .filter(Boolean)
      .join('; ')
    throw new Error(message || `Cloudflare API returned ${response.status}`)
  }
  return data.result as T
}

async function createKvNamespace(
  token: string,
  accountId: string,
  title: string,
  fetchImpl?: FetchLike,
) {
  return cloudflareRequest<{ id: string }>({
    token,
    method: 'POST',
    path: `/accounts/${accountId}/storage/kv/namespaces`,
    body: JSON.stringify({ title }),
    fetchImpl,
  })
}

async function uploadRelayWorker(options: {
  token: string
  accountId: string
  scriptName: string
  kvNamespaceId: string
  relayToken: string
  fetchImpl?: FetchLike
}) {
  const metadata = {
    main_module: 'worker.js',
    compatibility_date: '2026-04-28',
    bindings: [
      {
        type: 'kv_namespace',
        name: 'RELAY_STATE',
        namespace_id: options.kvNamespaceId,
      },
      {
        type: 'secret_text',
        name: 'RELAY_TOKEN',
        text: options.relayToken,
      },
    ],
  }
  const form = new FormData()
  form.set('metadata', JSON.stringify(metadata))
  form.set(
    'worker.js',
    new Blob([WORKER_SCRIPT], { type: 'application/javascript+module' }),
    'worker.js',
  )
  return cloudflareRequest<unknown>({
    token: options.token,
    method: 'PUT',
    path: `/accounts/${options.accountId}/workers/scripts/${options.scriptName}`,
    body: form,
    fetchImpl: options.fetchImpl,
  })
}

async function enableWorkersDev(
  token: string,
  accountId: string,
  scriptName: string,
  fetchImpl?: FetchLike,
) {
  await cloudflareRequest<unknown>({
    token,
    method: 'POST',
    path: `/accounts/${accountId}/workers/scripts/${scriptName}/subdomain`,
    body: JSON.stringify({ enabled: true, previews_enabled: false }),
    fetchImpl,
  })
}

async function getWorkersSubdomain(
  token: string,
  accountId: string,
  fetchImpl?: FetchLike,
) {
  return cloudflareRequest<{ subdomain?: string }>({
    token,
    method: 'GET',
    path: `/accounts/${accountId}/workers/subdomain`,
    fetchImpl,
  }).catch(() => null)
}

/**
 * Minimal fetch shape relaySetup needs. Narrower than `typeof fetch` (no
 * `preconnect`) so test stubs and the global `fetch` are both assignable
 * without a cast. The global `fetch` satisfies this structurally.
 */
type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>

/**
 * Dependencies relaySetup talks to the outside world through. Both default to
 * the real implementations (global fetch, the readline-backed prompt) so the
 * production `relay setup` path is unchanged; tests inject deterministic stubs
 * to exercise the full setup logic in-process without a subprocess.
 */
export interface RelaySetupDeps {
  fetchImpl?: FetchLike
  prompt?: (message: string) => Promise<string>
  /** Receives each credential this command handles, for redacting failure detail. */
  secrets?: string[]
  /** Prints a non-fatal warning; defaults to console.warn. */
  warn?: (message: string) => void
}

export async function relaySetup(deps: RelaySetupDeps = {}) {
  await withNativeAccounts((runtime) => runtime.read())
  const fetchImpl = deps.fetchImpl ?? fetch
  const ask = deps.prompt ?? prompt
  const warn = deps.warn ?? ((message: string) => console.warn(message))
  const token = requireText(
    process.env.CLOUDFLARE_API_TOKEN?.trim() ||
      (await ask('Cloudflare API token: ')),
    'Cloudflare API token',
  )
  deps.secrets?.push(token)
  const accountId = requireText(
    process.env.CLOUDFLARE_ACCOUNT_ID || (await ask('Cloudflare account ID: ')),
    'Cloudflare account ID',
  )
  const scriptName =
    (await ask('Worker name [opencode-anthropic-relay]: ')) ||
    'opencode-anthropic-relay'
  const kvTitle = `${scriptName}-state`
  const relayToken = generateRelayToken()
  deps.secrets?.push(relayToken)

  console.log('Creating Cloudflare KV namespace...')
  const namespace = await createKvNamespace(
    token,
    accountId,
    kvTitle,
    fetchImpl,
  )
  console.log('Uploading relay Worker...')
  await uploadRelayWorker({
    token,
    accountId,
    scriptName,
    kvNamespaceId: namespace.id,
    relayToken,
    fetchImpl,
  })
  // Cloudflare's error text can echo request details, so the warning names
  // only a fixed code and the private file holding the scrubbed detail.
  await enableWorkersDev(token, accountId, scriptName, fetchImpl).catch(
    async (error) => {
      warn(
        await reportThrownFailure('cli-relay-workers-dev', error, process.env, [
          token,
          relayToken,
        ]),
      )
    },
  )

  const subdomain = await getWorkersSubdomain(token, accountId, fetchImpl)
  const defaultUrl = subdomain?.subdomain
    ? `https://${scriptName}.${subdomain.subdomain}.workers.dev`
    : ''
  const url =
    defaultUrl ||
    requireText(await prompt('Relay Worker URL: '), 'Relay Worker URL')

  // Provisioning can take minutes. The relay transaction updates private
  // connection authorization and settings without replacing account metadata.
  await withNativeAccounts((runtime) =>
    runtime.updateRelay({
      enabled: true,
      url,
      token: relayToken,
      fallbackToDirect: true,
      transport: 'http',
    }),
  )

  console.log(`Relay enabled at ${url}`)
  console.log('Relay settings saved to the native account store.')
}

let promptInterface: ReturnType<typeof createInterface> | null = null

async function prompt(message: string) {
  promptInterface ??= createInterface({ input, output })
  return (await promptInterface.question(message)).trim()
}

function closePromptInterface() {
  promptInterface?.close()
  promptInterface = null
}

/**
 * Tests can supply prompts and OAuth responses without opening a browser.
 * Login stores exchanged tokens in the shared account pool after validating
 * the account identity. It never writes OpenCode's auth.json or old sidecars.
 */
export interface LoginDeps {
  prompt?: (message: string) => Promise<string>
  authorize?: typeof authorize
  exchange?: typeof exchange
  /** Receives each credential this command handles, for redacting failure detail. */
  secrets?: string[]
}

export async function login(labelArg?: string, deps: LoginDeps = {}) {
  if (process.env.OPENCODE_AUTH_CONTENT !== undefined) {
    throw new Error(
      'Local login cannot be verified while OPENCODE_AUTH_CONTENT is set',
    )
  }
  const ask = deps.prompt ?? prompt
  const authorizeImpl = deps.authorize ?? authorize
  const exchangeImpl = deps.exchange ?? exchange
  await requireLocalCustody()
  await withNativeAccounts(async (runtime) => {
    const snapshot = await runtime.read()
    const label =
      labelArg?.trim() || (await ask('Fallback account label (optional): '))
    const authorization = await authorizeImpl('max')
    console.log(
      '\nOpen this URL in your browser and complete Claude sign-in:\n',
    )
    console.log(`${authorization.url}\n`)
    const code = await ask(
      'Paste the full callback URL or authorization code here: ',
    )
    deps.secrets?.push(code)
    const result = await exchangeImpl(
      code,
      authorization.verifier,
      authorization.redirectUri,
      authorization.state,
    )
    if (result.type === 'failed') throw new Error('Authentication failed')
    deps.secrets?.push(result.access, result.refresh)
    if (process.env.OPENCODE_AUTH_CONTENT !== undefined)
      throw new Error(
        'Local login cannot be verified while OPENCODE_AUTH_CONTENT is set',
      )
    // Sign-in can take minutes; refuse if setup enrolled the host meanwhile.
    await requireLocalCustody()
    const routeId = label && label !== 'main' ? label : crypto.randomUUID()
    const replace = snapshot.accounts.some(
      (account) => account.id === routeId && account.source === 'local',
    )
    await runtime.loginOAuth({
      routeId,
      replace,
      label: label || undefined,
      credential: {
        access: result.access,
        refresh: result.refresh,
        expires: result.expires,
      },
    })
    console.log(`\nSaved native fallback account${label ? ` "${label}"` : ''}.`)
  })
}

/**
 * Tests can supply prompts to check API keys and proxy route settings.
 * New keys go to the shared account pool after migration has committed;
 * OpenCode's auth.json and the old sidecar files remain unchanged.
 */
export interface ApiAddDeps {
  prompt?: (message: string) => Promise<string>
  /** Receives each credential this command handles, for redacting failure detail. */
  secrets?: string[]
}

export async function addApiRoute(labelArg?: string, deps: ApiAddDeps = {}) {
  await requireLocalCustody()
  await withNativeAccounts((runtime) => runtime.read())
  const ask = deps.prompt ?? prompt
  const label =
    labelArg?.trim() || (await ask('API fallback label (optional): '))
  const baseURL =
    process.env.OPENCODE_ANTHROPIC_AUTH_API_BASE_URL?.trim() ||
    (
      await ask('Anthropic-compatible base URL [https://api.kie.ai/claude]: ')
    ).trim() ||
    'https://api.kie.ai/claude'
  if (!isValidApiBaseURL(baseURL)) {
    throw new Error(
      'API fallback base URL must be an http(s) URL without embedded credentials',
    )
  }
  const apiKey =
    process.env.OPENCODE_ANTHROPIC_AUTH_API_KEY?.trim() ||
    (await ask('API key: '))
  if (!apiKey.trim()) throw new Error('API key is required')
  deps.secrets?.push(apiKey.trim())
  const authHeaderInput = (
    process.env.OPENCODE_ANTHROPIC_AUTH_API_AUTH_HEADER?.trim() ||
    (await ask(
      'Auth header [authorization-bearer|x-api-key] (default authorization-bearer): ',
    ))
  )
    .trim()
    .toLowerCase()
  const authHeader =
    authHeaderInput === 'x-api-key' ? 'x-api-key' : 'authorization-bearer'

  await withNativeAccounts(async (runtime) => {
    // The prompts above can take minutes; refuse if setup enrolled the host.
    await requireLocalCustody()
    const snapshot = await runtime.read()
    const routeId = label && label !== 'main' ? label : crypto.randomUUID()
    const existing = snapshot.accounts.find((account) => account.id === routeId)
    if (existing?.source === 'vault')
      throw new Error('Vault routes cannot be replaced with a local API key')
    await runtime.addApi({
      routeId,
      replace: Boolean(existing),
      label: label || undefined,
      apiKey: apiKey.trim(),
      baseURL,
      authHeader,
    })
  })

  console.log(
    `\nSaved API fallback route${label ? ` "${label}"` : ''} (${baseURL}).`,
  )
}

async function listAccounts() {
  await withNativeAccounts(async (runtime) => {
    const accounts = (await runtime.read()).accounts.filter(
      (account) => account.id !== 'main',
    )
    if (!accounts.length) {
      console.log('No native fallback accounts found.')
      return
    }
    for (const [index, account] of accounts.entries()) {
      const label = account.label || account.id
      const status = account.enabled ? 'enabled' : 'disabled'
      if (account.type === 'api') {
        console.log(
          `${index + 1}. ${label} (${status}) — API route ${account.baseURL}`,
        )
        continue
      }
      const fiveHour = account.quota?.five_hour?.remainingPercent
      const sevenDay = account.quota?.seven_day?.remainingPercent
      const quota =
        fiveHour === undefined && sevenDay === undefined
          ? 'quota unknown'
          : `5h ${fiveHour ?? '?'}%, 1w ${sevenDay ?? '?'}% remaining`
      console.log(
        `${index + 1}. ${label} (${status}) — ${quota}${account.state ? ` — ${formatNativeAccountState(account)}` : ''}`,
      )
    }
  })
}

import { runSetupCommand } from './setup/command.ts'

export { runSetupCommand }

/**
 * What the top-level failure handler needs from the running command: `stage`
 * names the command being run (it starts as the generic 'cli-command'), and
 * `secrets` collects the credentials that command handled so a failure detail
 * can be scrubbed of their exact values. Lives only for one CLI invocation.
 */
interface CliFailureContext {
  stage: CliFailureStage
  secrets: string[]
}

async function main(failure: CliFailureContext) {
  const [command, subcommandOrLabel, maybeLabel] = process.argv.slice(2)
  if (
    !command ||
    command === 'help' ||
    command === '--help' ||
    command === '-h'
  ) {
    usage()
    return
  }

  if (command === 'setup') {
    failure.stage = 'cli-setup'
    const code = await runSetupCommand(process.argv.slice(3))
    if (code !== 0) process.exitCode = code
    return
  }

  if (command === 'login') {
    failure.stage = 'cli-login'
    await login(subcommandOrLabel, { secrets: failure.secrets })
    return
  }

  if (command === 'api' && subcommandOrLabel === 'add') {
    failure.stage = 'cli-api-add'
    await addApiRoute(maybeLabel, { secrets: failure.secrets })
    return
  }

  if (command === 'list') {
    failure.stage = 'cli-list'
    await listAccounts()
    return
  }

  if (command === 'relay' && subcommandOrLabel === 'setup') {
    failure.stage = 'cli-relay-setup'
    await relaySetup({ secrets: failure.secrets })
    return
  }

  usage()
  process.exitCode = 1
}

// Only run the CLI when executed directly (e.g. `bun src/cli.ts ...`), not when
// imported by tests that exercise individual commands (relaySetup) in-process.
if (import.meta.main) {
  const failure: CliFailureContext = { stage: 'cli-command', secrets: [] }
  try {
    await main(failure)
  } catch (error) {
    // Known fixed remedies print as before; any other failure prints only a
    // fixed code and the path of a private file holding the scrubbed detail.
    console.error(
      await reportThrownFailure(
        failure.stage,
        error,
        process.env,
        failure.secrets,
      ),
    )
    process.exitCode = 1
  } finally {
    closePromptInterface()
  }
}
