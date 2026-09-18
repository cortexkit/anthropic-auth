import { afterEach, describe, expect, mock, test } from 'bun:test'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  __setLogTestSink,
  custodyTombstoneOAuth,
  getLogLevel,
  saveAccounts,
  setLogLevel,
} from '@cortexkit/anthropic-auth-core'

import { AnthropicAuthPlugin } from '../index'
import { drainSidebarWrites } from '../sidebar-state'

const roots: string[] = []
const originalEnv = {
  account: process.env.OPENCODE_ANTHROPIC_AUTH_FILE,
  sidebar: process.env.OPENCODE_ANTHROPIC_AUTH_SIDEBAR_STATE_FILE,
  manifest: process.env.CLAUSTRUM_OPENCODE_HANDLES,
}

function restoreEnv(name: keyof typeof originalEnv, variable: string) {
  const value = originalEnv[name]
  if (value === undefined) delete process.env[variable]
  else process.env[variable] = value
}

const MAIN_HANDLE = `ckh_${'Z'.repeat(43)}`
const FALLBACK_HANDLE = `ckh_${'F'.repeat(43)}`

// Structural-dark requires claustrum mode + provisional custody + a fallback
// dimension of M or R. A fallback with real refresh material (not a tombstone)
// and a resolved manifest binding classifies as R.
async function bootStructuralDark() {
  const root = await mkdtemp(join(tmpdir(), 'fallback-refresh-observability-'))
  roots.push(root)
  const accountPath = join(root, 'anthropic-auth.json')
  const manifestPath = join(root, 'handles.json')
  const sidebarPath = join(root, 'sidebar.json')
  process.env.OPENCODE_ANTHROPIC_AUTH_FILE = accountPath
  process.env.OPENCODE_ANTHROPIC_AUTH_SIDEBAR_STATE_FILE = sidebarPath
  process.env.CLAUSTRUM_OPENCODE_HANDLES = manifestPath

  await writeFile(
    manifestPath,
    JSON.stringify({
      version: 1,
      providers: [
        {
          provider: 'anthropic',
          serve: 'anthropic-auth',
          accounts: [
            {
              label: 'main',
              handle: MAIN_HANDLE,
              credential_id: 'oauth:anthropic:main',
            },
            {
              label: 'work',
              handle: FALLBACK_HANDLE,
              credential_id: 'oauth:anthropic:work',
            },
          ],
        },
      ],
    }),
  )
  await chmod(manifestPath, 0o600)

  await saveAccounts(
    {
      version: 1,
      claustrum: { mode: 'claustrum' },
      quota: { enabled: false, failClosedOnUnknownQuota: false },
      main: {
        ...custodyTombstoneOAuth('anthropic'),
        claustrumHandle: MAIN_HANDLE,
      },
      accounts: [
        {
          id: 'work-alt',
          label: 'work',
          type: 'oauth',
          refresh: 'real-fallback-refresh',
          access: 'real-fallback-access',
          enabled: true,
          claustrumHandle: FALLBACK_HANDLE,
        },
      ],
    } as never,
    accountPath,
  )

  const connector = async () =>
    ({
      call: async (_moduleId: string, method: string, params?: unknown) => {
        if (method !== 'credential.get') return { result: {} }
        const handle = (params as { handle?: string } | undefined)?.handle
        const isMain = handle === MAIN_HANDLE
        return {
          result: {
            payload: Array.from(
              new TextEncoder().encode(
                JSON.stringify({
                  access_token: isMain
                    ? 'vault-main-access'
                    : 'vault-fallback-access',
                }),
              ),
            ),
            expires_at_ms: Date.now() + 60 * 60 * 1000,
            record_version: 1,
          },
        }
      },
      close: () => {},
    }) as never

  const plugin = await (
    AnthropicAuthPlugin as unknown as (
      ctx: unknown,
      runtime: unknown,
    ) => Promise<any>
  )(
    {
      client: {
        auth: { set: mock(() => Promise.resolve()) },
        session: { promptAsync: mock(() => Promise.resolve()) },
      },
    },
    { claustrumConnector: connector },
  )

  return { plugin, sidebarPath }
}

afterEach(async () => {
  restoreEnv('account', 'OPENCODE_ANTHROPIC_AUTH_FILE')
  restoreEnv('sidebar', 'OPENCODE_ANTHROPIC_AUTH_SIDEBAR_STATE_FILE')
  restoreEnv('manifest', 'CLAUSTRUM_OPENCODE_HANDLES')
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

describe('fallback refresh structural-dark observability', () => {
  test('withholding the fallback refresh logs the three dimensions that produced it', async () => {
    const previousLogLevel = getLogLevel()
    const logs: Array<Record<string, unknown>> = []
    setLogLevel('debug')
    __setLogTestSink((record) => logs.push(record as Record<string, unknown>))
    try {
      const { plugin } = await bootStructuralDark()
      try {
        const withheld = logs.find(
          (record) =>
            record.channel === 'claustrum' &&
            record.message === 'fallback refresh withheld at construction',
        )
        expect(withheld).toBeDefined()
        expect(withheld?.payload).toEqual({
          custodyMode: 'claustrum',
          provisional: true,
          fallbacks: 'R',
        })
      } finally {
        await plugin.dispose?.()
      }
    } finally {
      __setLogTestSink(null)
      setLogLevel(previousLogLevel)
    }
  })

  test('the sidebar carries the structural-dark flag', async () => {
    const { plugin, sidebarPath } = await bootStructuralDark()
    try {
      // The loader sets latestGetAuth before its custody reconcile refuses; the
      // add-apikey command then routes through refreshSidebarAfterMutation, which
      // is the write path reachable while the process is structurally dark.
      await plugin.auth.loader(
        () => Promise.resolve(custodyTombstoneOAuth('anthropic') as never),
        { models: {} },
      )
      await plugin['command.execute.before']({
        command: 'claude-account',
        arguments: 'add-apikey sk-ant-observability-test',
        sessionID: 'fallback-refresh-observability',
      }).catch(() => {})
      await drainSidebarWrites()

      const sidebar = JSON.parse(await readFile(sidebarPath, 'utf8'))
      expect(sidebar.fallbackRefreshStructuralDark).toBe(true)
    } finally {
      await plugin.dispose?.()
    }
  })
})
