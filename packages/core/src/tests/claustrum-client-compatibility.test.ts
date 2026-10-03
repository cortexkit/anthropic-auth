import { expect, test } from 'bun:test'
import {
  ClaustrumClient,
  type ClaustrumConnector,
  type ClaustrumReporterSource,
  type CredentialStatus,
  type EnrollmentPollOutcome,
  type ScopedInventory,
  type ScopedInventoryRow,
  type ServedCredential,
} from '@cortexkit/claustrum-client'
import type {
  ClaustrumEnrollmentClient as CommonAuthEnrollmentClient,
  ClaustrumScopedClient as CommonAuthScopedClient,
} from '@cortexkit/common-auth/claustrum'
import type { ClaustrumEnrollmentClient } from '../claustrum-enrollment.ts'
import type {
  ClaustrumScopedAttempt,
  ClaustrumScopedClient,
} from '../claustrum-scoped.ts'

type Assert<T extends true> = T
type Equal<Actual, Expected> = [Actual] extends [Expected]
  ? [Expected] extends [Actual]
    ? true
    : false
  : false
type RequiredKeys<T, K extends keyof T> = [Pick<T, K>] extends [
  Required<Pick<T, K>>,
]
  ? true
  : false

type ConnectOptions = NonNullable<Parameters<typeof ClaustrumClient.connect>[0]>
type ScopedGetInput = Parameters<ClaustrumClient['getScoped']>[0]
type ScopedReportInput = Parameters<
  ClaustrumClient['reportAuthFailureScoped']
>[0]
type EnrollmentProposeInput = Parameters<ClaustrumClient['enrollPropose']>[0]
type EnrollmentPollInput = Parameters<ClaustrumClient['enrollPoll']>[0]
type EnrollmentRotateInput = Parameters<ClaustrumClient['enrollRotate']>[0]
type StatusCredentialResult = Awaited<
  ReturnType<ClaustrumClient['statusCredential']>
>
type ApprovedPoll = Extract<EnrollmentPollOutcome, { status: 'approved' }>

// These declarations make a peer API shape change fail Core's typecheck instead
// of silently compiling against a subset of the published producer contract.
const producerContract: [
  Assert<Equal<ConnectOptions['connector'], ClaustrumConnector | undefined>>,
  Assert<
    Equal<ReturnType<typeof ClaustrumClient.connect>, Promise<ClaustrumClient>>
  >,
  Assert<
    RequiredKeys<ServedCredential, 'material' | 'recordVersion' | 'expiresAtMs'>
  >,
  Assert<
    Equal<
      Pick<ServedCredential, 'material' | 'recordVersion' | 'expiresAtMs'>,
      { material: string; recordVersion: number; expiresAtMs: number | null }
    >
  >,
  Assert<
    Equal<
      Pick<ServedCredential, 'credentialId' | 'accountId'>,
      { credentialId?: string; accountId?: string }
    >
  >,
  Assert<RequiredKeys<ScopedInventory, 'rows' | 'view'>>,
  Assert<
    RequiredKeys<
      ScopedInventoryRow,
      'id' | 'recordVersion' | 'createdAtMs' | 'operations'
    >
  >,
  Assert<
    Equal<
      Pick<
        ClaustrumScopedAttempt,
        'credentialId' | 'accountId' | 'recordVersion' | 'expiresAtMs'
      >,
      {
        readonly credentialId: string
        readonly accountId: string
        readonly recordVersion: number
        readonly expiresAtMs: number
      }
    >
  >,
  Assert<
    Equal<
      ScopedGetInput,
      { credentialId: string; enrollmentToken?: string; minTtlMs?: number }
    >
  >,
  Assert<
    Equal<
      ScopedReportInput,
      {
        credentialId: string
        enrollmentToken?: string
        providerStatus: number
        recordVersion: number
        reporterSource: ClaustrumReporterSource
      }
    >
  >,
  Assert<
    Equal<EnrollmentProposeInput, { name: string; requestSecretHash: string }>
  >,
  Assert<
    Equal<EnrollmentPollInput, { requestId: string; requestSecret: string }>
  >,
  Assert<
    Equal<
      Pick<ApprovedPoll, 'status' | 'name' | 'token' | 'tokenGeneration'>,
      {
        readonly status: 'approved'
        readonly name: string
        readonly token: string
        readonly tokenGeneration: number
      }
    >
  >,
  Assert<
    Equal<
      EnrollmentRotateInput,
      { token: string; expectedTokenGeneration: number }
    >
  >,
  Assert<
    Equal<
      Pick<CredentialStatus, 'ready' | 'lastErrorCode' | 'leaseHeld'>,
      { ready: boolean; lastErrorCode: string | null; leaseHeld: boolean }
    >
  >,
  Assert<
    Equal<
      Pick<CredentialStatus, 'credentialId' | 'recordVersion' | 'stalePending'>,
      {
        credentialId?: string
        recordVersion?: number
        stalePending?: boolean
      }
    >
  >,
  Assert<
    Equal<
      Pick<StatusCredentialResult, 'credentialId' | 'recordVersion'>,
      { credentialId?: string; recordVersion?: number }
    >
  >,
  Assert<Equal<ClaustrumScopedClient, CommonAuthScopedClient>>,
  Assert<
    Equal<
      Pick<ClaustrumClient, 'enrollPropose' | 'enrollPoll'>,
      CommonAuthEnrollmentClient
    >
  >,
  Assert<Equal<ClaustrumEnrollmentClient, CommonAuthEnrollmentClient>>,
] = [
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
]

test('published Claustrum client decodes scoped and enrollment replies', async () => {
  const credentialId = 'oauth:anthropic:work'
  const accountId = 'provider-account-1'
  const enrollmentToken = '01'.repeat(32)
  const accessToken = 'synthetic-access-token'
  const calls: Array<{ moduleId: string; method: string; params?: unknown }> =
    []
  let closes = 0
  const responses: Record<string, unknown> = {
    'credential.list_scoped': {
      result: {
        credentials: [
          {
            id: credentialId,
            account_id: accountId,
            type: 'oauth',
            categories: ['anthropic-native'],
            serves: ['anthropic'],
            refresh_adapter: 'anthropic',
            operations: ['read'],
            state: 'active',
            record_version: 7,
            created_at_ms: null,
          },
        ],
        view: 'synthetic-view-1',
      },
    },
    'credential.status': {
      result: {
        ready: false,
        last_error_code: 'not_found',
        lease_held: false,
      },
    },
    'credential.get_scoped': {
      result: {
        payload: Array.from(new TextEncoder().encode(accessToken)),
        credential_id: credentialId,
        account_id: accountId,
        record_version: 7,
        expires_at_ms: 9_000_000,
      },
    },
    'credential.report_auth_failure': { result: { accepted: true } },
    'auth.enroll_propose': { result: { request_id: 'synthetic-request-1' } },
    'auth.enroll_poll': {
      result: {
        status: 'approved',
        name: 'anthropic-auth-test',
        token: 'ab'.repeat(32),
        token_generation: 4,
      },
    },
    'auth.enroll_rotate': {
      result: { token: 'cd'.repeat(32), token_generation: 5 },
    },
  }
  const connector: ClaustrumConnector = async () =>
    ({
      call: async (moduleId: string, method: string, params?: unknown) => {
        calls.push({ moduleId, method, params })
        const response = responses[method]
        if (response === undefined) {
          throw new Error(`Unexpected synthetic Claustrum method: ${method}`)
        }
        return response
      },
      close: () => {
        closes++
      },
    }) as unknown as Awaited<ReturnType<ClaustrumConnector>>

  const client = await ClaustrumClient.connect({
    connectionFile: '/synthetic-test/no-daemon-connection.json',
    identity: {
      project_root: '/synthetic-test/project',
      harness: 'compatibility-test',
      session: 'synthetic-session',
    },
    connector,
    logger: () => {},
  })

  const inventory = await client.listScoped(enrollmentToken)
  expect(inventory).toEqual({
    rows: [
      {
        id: credentialId,
        accountId,
        categories: ['anthropic-native'],
        credentialType: 'oauth',
        serves: ['anthropic'],
        refreshAdapter: 'anthropic',
        state: 'active',
        recordVersion: 7,
        operations: ['read'],
        createdAtMs: null,
        email: undefined,
        orgName: undefined,
      },
    ],
    view: 'synthetic-view-1',
  })

  const status = await client.statusCredential(credentialId)
  expect(status).toEqual({
    ready: false,
    lastErrorCode: 'not_found',
    leaseHeld: false,
  })
  expect('credentialId' in status).toBe(false)
  expect('recordVersion' in status).toBe(false)

  const served = await client.getScoped({
    credentialId,
    enrollmentToken,
    minTtlMs: 300_000,
  })
  expect(served).toEqual({
    material: accessToken,
    credentialId,
    accountId,
    recordVersion: 7,
    expiresAtMs: 9_000_000,
    projectId: undefined,
    email: undefined,
    orgName: undefined,
  })

  await client.reportAuthFailureScoped({
    credentialId,
    enrollmentToken,
    providerStatus: 401,
    recordVersion: served.recordVersion,
    reporterSource: 'relay_status_field',
  })
  expect(
    await client.enrollPropose({
      name: 'anthropic-auth-test',
      requestSecretHash: 'ef'.repeat(32),
    }),
  ).toEqual({ requestId: 'synthetic-request-1' })
  expect(
    await client.enrollPoll({
      requestId: 'synthetic-request-1',
      requestSecret: '12'.repeat(32),
    }),
  ).toEqual({
    status: 'approved',
    name: 'anthropic-auth-test',
    token: 'ab'.repeat(32),
    tokenGeneration: 4,
  })
  expect(
    await client.enrollRotate({
      token: enrollmentToken,
      expectedTokenGeneration: 4,
    }),
  ).toEqual({ token: 'cd'.repeat(32), tokenGeneration: 5 })

  expect(calls).toEqual([
    {
      moduleId: 'claustrum',
      method: 'credential.list_scoped',
      params: { enrollment_token: enrollmentToken },
    },
    {
      moduleId: 'claustrum',
      method: 'credential.status',
      params: { handle: credentialId },
    },
    {
      moduleId: 'claustrum',
      method: 'credential.get_scoped',
      params: {
        credential_id: credentialId,
        enrollment_token: enrollmentToken,
        min_ttl_ms: 300_000,
      },
    },
    {
      moduleId: 'claustrum',
      method: 'credential.report_auth_failure',
      params: {
        credential_id: credentialId,
        enrollment_token: enrollmentToken,
        provider_status: 401,
        record_version: 7,
        reporter_source: 'relay_status_field',
      },
    },
    {
      moduleId: 'claustrum',
      method: 'auth.enroll_propose',
      params: {
        proposed_name: 'anthropic-auth-test',
        request_secret_hash: 'ef'.repeat(32),
      },
    },
    {
      moduleId: 'claustrum',
      method: 'auth.enroll_poll',
      params: {
        request_id: 'synthetic-request-1',
        request_secret: '12'.repeat(32),
      },
    },
    {
      moduleId: 'claustrum',
      method: 'auth.enroll_rotate',
      params: {
        token: enrollmentToken,
        expected_token_generation: 4,
      },
    },
  ])
  expect(producerContract.every(Boolean)).toBe(true)
  client.close()
  expect(closes).toBe(1)
})
