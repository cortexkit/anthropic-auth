import { expect } from 'bun:test'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  captureNativeLocalPoolBinding,
  createNativeAccountRuntime,
  createNativePoolStore,
  type NativeAccountRuntime,
  primeAccountMarkerDir,
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
const OTHER_IDENTITY = '22222222-2222-4333-8444-555555555555'
const ACCESS = 'sk-ant-oat01-primeFingerprintSyntheticAccess0123'
const SUCCESSOR = {
  access: 'sk-ant-oat01-primeFingerprintSyntheticSuccessor',
  refresh: 'primeFingerprintSyntheticSuccessorRefresh',
}
const DAY = 24 * 60 * 60_000

async function fixture() {
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
  deferCleanup(() => store.close())
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
  let successorIdentity = IDENTITY
  const runtime: NativeAccountRuntime = createNativeAccountRuntime({
    paths,
    host: 'opencode',
    local: {
      resolveIdentity: async (access) => ({
        deviceId: 'synthetic-device',
        sessionId: 'synthetic-session',
        accountUuid: (access === SUCCESSOR.access
          ? successorIdentity
          : IDENTITY) as never,
      }),
      refreshToken: async () => ({
        ...SUCCESSOR,
        expires: Date.now() + DAY,
        expiresIn: DAY / 1000,
      }),
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
  const tokens: Array<string | null> = []
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
      tokens.push(request.headers.get('authorization'))
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
  const markerDir = join(directory, 'prime-markers')
  prime.manager.updateOptions({ ...prime.manager.options, markerDir })
  return {
    manager: prime.manager,
    markerDir,
    tokens,
    runtime,
    async replace(identity: string) {
      successorIdentity = identity
      await store.replace(
        'primary-row',
        { type: 'oauth', ...SUCCESSOR, expires: Date.now() + DAY },
        { identity },
      )
    },
  }
}

test('a due OC2 account fires once through the real Prime manager', async () => {
  const { manager, tokens, runtime } = await fixture()

  // The manager hashes the lineage before using it as a marker folder name.
  const evidence = await manager.options.getAccountEvidence('main')
  const fingerprint = evidence && tokenFingerprint(evidence.lineage)
  expect(fingerprint).toMatch(/^[a-f0-9]{16}$/)
  expect(evidence?.accountIdentity).toBe(IDENTITY)

  await manager.tick()
  await manager.tick()

  expect(tokens).toEqual([`Bearer ${ACCESS}`])
  const account = (await runtime.read()).accounts.find(
    (row) => row.id === 'main',
  )
  expect(account?.prime?.count).toBe(1)
})

for (const stage of ['after evidence', 'after claim'] as const) {
  test(`OC2 Prime refuses a slot replacement ${stage} and releases its claims`, async () => {
    const { manager, markerDir, tokens, replace } = await fixture()
    const options = manager.options
    const original = (await options.getAccountEvidence('main'))!
    const storageDir = primeAccountMarkerDir(
      markerDir,
      options.storagePath,
      tokenFingerprint(original.lineage),
    )
    const verifiedDir = join(markerDir, 'accounts')
    let replaced = false
    manager.updateOptions({
      ...options,
      async getAccountEvidence(accountId) {
        const evidence = await options.getAccountEvidence(accountId)
        if (!replaced && stage === 'after evidence') {
          replaced = true
          await replace(OTHER_IDENTITY)
        }
        return evidence
      },
      async sendPrime(accountId, evidence) {
        if (!replaced && stage === 'after claim') {
          expect(await readdir(storageDir)).toHaveLength(1)
          expect(await readdir(verifiedDir)).toHaveLength(1)
          replaced = true
          // Re-signing in as the same Claude account still replaces lineage.
          await replace(IDENTITY)
        }
        return options.sendPrime(accountId, evidence)
      },
    })
    await manager.tick()
    expect(replaced).toBe(true)
    expect(tokens).toEqual([])
    expect(await readdir(storageDir)).toEqual([])
    expect(await readdir(verifiedDir)).toEqual([])

    await manager.tick()
    expect(tokens).toEqual([`Bearer ${SUCCESSOR.access}`])
  })
}

test('OC2 Prime uses a refreshed token for the same binding after claiming', async () => {
  const { manager, tokens, runtime } = await fixture()
  const options = manager.options
  let rotated = false
  manager.updateOptions({
    ...options,
    async sendPrime(accountId, evidence) {
      const successor = await runtime.authorizeLocal(accountId, {
        intent: 'refresh',
      })
      rotated =
        successor.status === 'usable' && successor.access === SUCCESSOR.access
      return options.sendPrime(accountId, evidence)
    },
  })
  await manager.tick()
  expect(rotated).toBe(true)
  expect(tokens).toEqual([`Bearer ${SUCCESSOR.access}`])
})
