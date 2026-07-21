#!/usr/bin/env node

import { stdin as input, stdout as output } from 'node:process'
import { createInterface } from 'node:readline/promises'
import {
  type AccountStorage,
  addAccountPersistent,
  authorize,
  exchange,
  generateRelayToken,
  getAccountStoragePath,
  isOAuthAccount,
  isValidApiBaseURL,
  loadAccounts,
  saveAccounts,
  WORKER_SCRIPT,
} from '@cortexkit/anthropic-auth-core'

function defaultStorage(): AccountStorage {
  return {
    version: 1,
    main: { type: 'opencode', provider: 'anthropic' },
    fallbackOn: [401, 403, 429],
    refresh: {
      enabled: true,
      intervalMinutes: 10,
      refreshBeforeExpiryMinutes: 240,
    },
    quota: {
      enabled: true,
      checkIntervalMinutes: 5,
      minimumRemaining: {
        five_hour: 10,
        seven_day: 20,
      },
      failClosedOnUnknownQuota: true,
    },
    accounts: [],
  }
}

function usage() {
  console.log(`Usage:
  opencode-anthropic-auth login [label]
  opencode-anthropic-auth api add [label]
  opencode-anthropic-auth list
  opencode-anthropic-auth relay setup

Fallback accounts are stored in:
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
}

export async function relaySetup(deps: RelaySetupDeps = {}) {
  const fetchImpl = deps.fetchImpl ?? fetch
  const ask = deps.prompt ?? prompt
  const token = requireText(
    process.env.CLOUDFLARE_API_TOKEN?.trim() ||
      (await ask('Cloudflare API token: ')),
    'Cloudflare API token',
  )
  const accountId = requireText(
    process.env.CLOUDFLARE_ACCOUNT_ID || (await ask('Cloudflare account ID: ')),
    'Cloudflare account ID',
  )
  const scriptName =
    (await ask('Worker name [opencode-anthropic-relay]: ')) ||
    'opencode-anthropic-relay'
  const kvTitle = `${scriptName}-state`
  const relayToken = generateRelayToken()

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
  await enableWorkersDev(token, accountId, scriptName, fetchImpl).catch(
    (error) => {
      console.warn(
        `Could not enable workers.dev automatically: ${error instanceof Error ? error.message : String(error)}`,
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

  // Provisioning can take minutes. Reload immediately before commit so the
  // relay setup cannot overwrite fallback accounts changed while it was open.
  const storage = (await loadAccounts()) ?? defaultStorage()
  storage.relay = {
    enabled: true,
    url,
    token: relayToken,
    fallbackToDirect: true,
    transport: 'http',
  }
  await saveAccounts(storage)

  console.log(`Relay enabled at ${url}`)
  console.log(`Config saved to ${getAccountStoragePath()}.`)
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
 * Dependencies the `login` command talks to the outside world through. All
 * default to the real implementations (the readline-backed prompt, and the
 * core authorize/exchange helpers) so the production `login` path is
 * unchanged; tests inject deterministic stubs to exercise the full login flow
 * in-process without a subprocess, real network, or stdin.
 */
export interface LoginDeps {
  prompt?: (message: string) => Promise<string>
  authorize?: typeof authorize
  exchange?: typeof exchange
}

export async function login(labelArg?: string, deps: LoginDeps = {}) {
  const ask = deps.prompt ?? prompt
  const authorizeImpl = deps.authorize ?? authorize
  const exchangeImpl = deps.exchange ?? exchange
  const label =
    labelArg?.trim() || (await ask('Fallback account label (optional): '))
  const authorization = await authorizeImpl('max')

  console.log('\nOpen this URL in your browser and complete Claude sign-in:\n')
  console.log(`${authorization.url}\n`)
  const code = await ask(
    'Paste the full callback URL or authorization code here: ',
  )
  const result = await exchangeImpl(
    code,
    authorization.verifier,
    authorization.redirectUri,
    authorization.state,
  )

  if (result.type === 'failed') {
    throw new Error('Authentication failed')
  }

  const now = Date.now()
  await addAccountPersistent({
    id: label || crypto.randomUUID(),
    label: label || undefined,
    type: 'oauth',
    authLineageId: crypto.randomUUID(),
    access: result.access,
    refresh: result.refresh,
    expires: result.expires,
    enabled: true,
    addedAt: now,
    lastUsed: now,
    lastRefreshedAt: now,
  })

  console.log(`\nSaved fallback account${label ? ` "${label}"` : ''}.`)
}

/**
 * Dependencies the `api add` command talks to the outside world through. The
 * prompt defaults to the real readline-backed prompt so the production
 * `api add` path is unchanged; tests inject canned answers to exercise the
 * full route-add flow in-process without a subprocess or stdin.
 */
export interface ApiAddDeps {
  prompt?: (message: string) => Promise<string>
}

export async function addApiRoute(labelArg?: string, deps: ApiAddDeps = {}) {
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
  const now = Date.now()

  await addAccountPersistent({
    id: label || crypto.randomUUID(),
    label: label || undefined,
    type: 'api',
    apiKey: apiKey.trim(),
    baseURL,
    authHeader,
    enabled: true,
    addedAt: now,
    lastUsed: now,
  })

  console.log(
    `\nSaved API fallback route${label ? ` "${label}"` : ''} (${baseURL}).`,
  )
}

async function listAccounts() {
  const storage = await loadAccounts()
  if (!storage?.accounts.length) {
    console.log(`No fallback accounts found at ${getAccountStoragePath()}.`)
    return
  }

  for (const [index, account] of storage.accounts.entries()) {
    const label = account.label || account.id
    const status = account.enabled === false ? 'disabled' : 'enabled'
    if (!isOAuthAccount(account)) {
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
    console.log(`${index + 1}. ${label} (${status}) — ${quota}`)
  }
}

async function main() {
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

  if (command === 'login') {
    await login(subcommandOrLabel)
    return
  }

  if (command === 'api' && subcommandOrLabel === 'add') {
    await addApiRoute(maybeLabel)
    return
  }

  if (command === 'list') {
    await listAccounts()
    return
  }

  if (command === 'relay' && subcommandOrLabel === 'setup') {
    await relaySetup()
    return
  }

  usage()
  process.exitCode = 1
}

// Only run the CLI when executed directly (e.g. `bun src/cli.ts ...`), not when
// imported by tests that exercise individual commands (relaySetup) in-process.
if (import.meta.main) {
  try {
    await main()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  } finally {
    closePromptInterface()
  }
}
