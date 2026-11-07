import { expect } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  captureNativeLocalPoolBinding,
  createNativeAccountRuntime,
  createNativePoolStore,
  type NativeAccountRuntime,
  resolveNativePoolPaths,
  runNativeMigration,
} from '@cortexkit/anthropic-auth-core'
import { fingerprintOf } from '@cortexkit/common-auth/store'
import { nativeQuotaCodec } from '../../../core/src/native-quota-codec.ts'
import { createTestLifetimeSuite } from '../../../core/src/tests/test-lifetime.ts'
import { tokenFingerprint } from '../../../core/src/token-fingerprint.ts'
import { createNativePrime } from '../v2/prime.ts'
import { createNativeAnthropicSource } from '../v2/source.ts'

const { test, deferCleanup } = createTestLifetimeSuite()

const IDENTITY = '11111111-2222-4333-8444-555555555555'
const ACCESS = 'sk-ant-oat01-primeFingerprintSyntheticAccess0123'
const DAY = 24 * 60 * 60_000

// A due OpenCode 2 account must fire exactly once through the real Prime
// manager: the first tick claims and sends, the second tick sees the claim
// and skips. With the raw lineage UUID the marker folder rejects the
// fingerprint before any refresh or send, so this test sends 0 without the
// hash and 1 with it.
test('a due OC2 account fires once through the real Prime manager', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'oc2-prime-fingerprint-'))
  deferCleanup(() => rm(directory, { recursive: true, force: true }))
  const paths = await resolveNativePoolPaths(
    join(directory, 'anthropic-auth.json'),
    join(directory, 'anthropic-auth-state.json'),
  )
  await writeFile(
    paths.legacyConfig,
    JSON.stringify({ version: 1, accounts: [] }),
    { mode: 0o600 },
  )
  await writeFile(
    paths.legacyState,
    JSON.stringify({ version: 1, accounts: {} }),
    { mode: 0o600 },
  )
  await runNativeMigration({
    paths,
    host: 'opencode',
    hostAuthPath: join(directory, 'auth.json'),
    routingSourcePath: join(directory, 'legacy-routing.json'),
    routingDestinationPath: join(directory, 'native-routing.json'),
    env: {},
    processFence: async () => {},
    removePiAnthropicAuth: false,
  })
  const store = createNativePoolStore({ paths, quota: nativeQuotaCodec })
  await store.add({
    id: 'primary-row',
    identity: IDENTITY,
    credential: {
      type: 'oauth',
      access: ACCESS,
      refresh: 'primeFingerprintSyntheticRefresh',
      expires: Date.now() + DAY,
    },
  })
  await store.updateSettings(() => ({
    mainAccountId: 'primary-row',
    quota: { enabled: false },
    routing: { mode: 'main-first' },
  }))
  const read = await store.read()
  const row = read.status === 'ready' ? read.rows[0] : undefined
  if (
    row?.credential?.type !== 'oauth' ||
    !row.credential.access ||
    row.credential.expires === undefined
  )
    throw new Error('The Prime fingerprint fixture has no stored OAuth account')
  const binding = captureNativeLocalPoolBinding(paths, row)
  await writeFile(
    paths.runtime,
    JSON.stringify({
      version: 1,
      storageId: paths.storageId,
      accounts: {
        'primary-row': {
          binding,
          credentialValidation: {
            binding,
            credentialFingerprint: fingerprintOf(row.credential),
            version: {
              accessFingerprint: tokenFingerprint(row.credential.access),
              expires: row.credential.expires,
            },
          },
        },
      },
    }),
    { mode: 0o600 },
  )
  const runtime: NativeAccountRuntime = createNativeAccountRuntime({
    paths,
    host: 'opencode',
    local: {
      resolveIdentity: async () => ({
        deviceId: 'synthetic-device',
        sessionId: 'synthetic-session',
        accountUuid: IDENTITY as never,
      }),
      refreshToken: async () => {
        throw new Error('The fingerprint fixture never refreshes')
      },
    },
    vault: {
      env: {
        OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE: join(
          directory,
          'opencode-enrollment.json',
        ),
      },
    },
  })
  deferCleanup(() => runtime.close())
  await runtime.updateSettings((settings) => ({
    ...settings,
    prime: { enabled: true },
  }))

  // The quota poll answers with a past five-hour reset, so the tick treats a
  // missing stored reset as due and fires instead of recording window-active.
  const pastReset = new Date(Date.now() - 120_000).toISOString()
  let messageSends = 0
  const countingFetch: typeof fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const request =
        input instanceof Request ? input : new Request(String(input), init)
      const url = new URL(request.url)
      if (url.pathname === '/api/oauth/usage')
        return Response.json({
          five_hour: { utilization: 0, resets_at: pastReset },
          seven_day: { utilization: 0, resets_at: pastReset },
        })
      if (url.pathname !== '/v1/messages')
        throw new Error(`Prime fingerprint test refused ${url.pathname}`)
      messageSends += 1
      await request.arrayBuffer().catch(() => {})
      return Response.json(
        {
          id: 'msg_prime_fingerprint',
          type: 'message',
          role: 'assistant',
          model: 'claude-haiku-4-5',
          content: [{ type: 'text', text: 'ok' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 1, output_tokens: 1 },
        },
        {
          headers: {
            'request-id': 'req_prime_fingerprint',
            'anthropic-ratelimit-unified-5h-utilization': '0.1',
          },
        },
      )
    },
    { preconnect: () => {} },
  )

  const source = createNativeAnthropicSource({
    runtime,
    paths,
    fetch: countingFetch,
    requestOptions: () => ({}),
  })
  deferCleanup(() => source.close())
  const prime = createNativePrime({
    runtime,
    paths,
    source,
    fetch: countingFetch,
  })
  deferCleanup(() => prime.dispose())
  prime.manager.updateOptions({
    ...prime.manager.options,
    markerDir: join(directory, 'prime-markers'),
  })

  // The manager hashes the lineage before using it as a marker folder name.
  const fingerprint = await prime.manager.options.getAccountFingerprint('main')
  expect(fingerprint).toMatch(/^[a-f0-9]{16}$/)
  expect(await prime.manager.options.getAccountIdentity?.('main')).toBe(
    IDENTITY,
  )

  await prime.manager.tick()
  await prime.manager.tick()

  expect(messageSends).toBe(1)
  const account = (await runtime.read()).accounts.find(
    (row) => row.id === 'main',
  )
  expect(account?.prime?.count).toBe(1)
})
