#!/usr/bin/env node

import { stdin as input, stdout as output } from 'node:process'
import { createInterface } from 'node:readline/promises'
import {
  type AccountStorage,
  authorize,
  exchange,
  generateRelayToken,
  getAccountStoragePath,
  loadAccounts,
  type OAuthAccount,
  saveAccounts,
  WORKER_SCRIPT,
} from '@marcusrbrown/anthropic-auth-core'

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
}) {
  const response = await fetch(
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
) {
  return cloudflareRequest<{ id: string }>({
    token,
    method: 'POST',
    path: `/accounts/${accountId}/storage/kv/namespaces`,
    body: JSON.stringify({ title }),
  })
}

async function uploadRelayWorker(options: {
  token: string
  accountId: string
  scriptName: string
  kvNamespaceId: string
  relayToken: string
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
  })
}

async function enableWorkersDev(
  token: string,
  accountId: string,
  scriptName: string,
) {
  await cloudflareRequest<unknown>({
    token,
    method: 'POST',
    path: `/accounts/${accountId}/workers/scripts/${scriptName}/subdomain`,
    body: JSON.stringify({ enabled: true, previews_enabled: false }),
  })
}

async function getWorkersSubdomain(token: string, accountId: string) {
  return cloudflareRequest<{ subdomain?: string }>({
    token,
    method: 'GET',
    path: `/accounts/${accountId}/workers/subdomain`,
  }).catch(() => null)
}

async function relaySetup() {
  const storage = (await loadAccounts()) ?? defaultStorage()
  const token = requireText(
    process.env.CLOUDFLARE_API_TOKEN?.trim() ||
      (await prompt('Cloudflare API token: ')),
    'Cloudflare API token',
  )
  const accountId = requireText(
    process.env.CLOUDFLARE_ACCOUNT_ID ||
      (await prompt('Cloudflare account ID: ')),
    'Cloudflare account ID',
  )
  const scriptName =
    (await prompt('Worker name [opencode-anthropic-relay]: ')) ||
    'opencode-anthropic-relay'
  const kvTitle = `${scriptName}-state`
  const relayToken = generateRelayToken()

  console.log('Creating Cloudflare KV namespace...')
  const namespace = await createKvNamespace(token, accountId, kvTitle)
  console.log('Uploading relay Worker...')
  await uploadRelayWorker({
    token,
    accountId,
    scriptName,
    kvNamespaceId: namespace.id,
    relayToken,
  })
  await enableWorkersDev(token, accountId, scriptName).catch((error) => {
    console.warn(
      `Could not enable workers.dev automatically: ${error instanceof Error ? error.message : String(error)}`,
    )
  })

  const subdomain = await getWorkersSubdomain(token, accountId)
  const defaultUrl = subdomain?.subdomain
    ? `https://${scriptName}.${subdomain.subdomain}.workers.dev`
    : ''
  const url =
    defaultUrl ||
    requireText(await prompt('Relay Worker URL: '), 'Relay Worker URL')

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

async function prompt(message: string) {
  const rl = createInterface({ input, output })
  try {
    return (await rl.question(message)).trim()
  } finally {
    rl.close()
  }
}

function upsertAccount(storage: AccountStorage, account: OAuthAccount) {
  const index = storage.accounts.findIndex(
    (candidate) =>
      candidate.id === account.id ||
      (account.label && candidate.label === account.label),
  )
  if (index >= 0) {
    storage.accounts[index] = {
      ...storage.accounts[index],
      ...account,
      addedAt: storage.accounts[index]?.addedAt ?? account.addedAt,
      quota: account.quota,
      lastRefreshedAt: account.lastRefreshedAt,
      lastRefreshError: account.lastRefreshError,
      lastQuotaRefreshError: account.lastQuotaRefreshError,
    }
    return
  }
  storage.accounts.push(account)
}

async function login(labelArg?: string) {
  const storage = (await loadAccounts()) ?? defaultStorage()
  const label =
    labelArg?.trim() || (await prompt('Fallback account label (optional): '))
  const authorization = await authorize('max')

  console.log('\nOpen this URL in your browser and complete Claude sign-in:\n')
  console.log(`${authorization.url}\n`)
  const code = await prompt(
    'Paste the full callback URL or authorization code here: ',
  )
  const result = await exchange(
    code,
    authorization.verifier,
    authorization.redirectUri,
    authorization.state,
  )

  if (result.type === 'failed') {
    throw new Error('Authentication failed')
  }

  const now = Date.now()
  upsertAccount(storage, {
    id: label || crypto.randomUUID(),
    label: label || undefined,
    type: 'oauth',
    access: result.access,
    refresh: result.refresh,
    expires: result.expires,
    enabled: true,
    addedAt: now,
    lastUsed: now,
  })
  await saveAccounts(storage)

  console.log(`\nSaved fallback account${label ? ` "${label}"` : ''}.`)
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
  const [command, label] = process.argv.slice(2)
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
    await login(label)
    return
  }

  if (command === 'list') {
    await listAccounts()
    return
  }

  if (command === 'relay' && label === 'setup') {
    await relaySetup()
    return
  }

  usage()
  process.exitCode = 1
}

try {
  await main()
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
