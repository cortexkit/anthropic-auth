import { dirname } from 'node:path'
import {
  CLAUSTRUM_OPENCODE_ENROLLMENT_NAME,
  CLAUSTRUM_PI_ENROLLMENT_NAME,
  type ClaustrumEnrollmentClient,
  ClaustrumEnrollmentManager,
  type ClaustrumEnrollmentPaths,
  connectClaustrumEnrollmentClient,
  getHostClaustrumEnrollmentPaths,
  readClaustrumEnrollmentStatus,
  resolveClaustrumConnectionPath,
} from '@cortexkit/anthropic-auth-core'
import { writeEnrollmentTokenFile } from '@cortexkit/claustrum-client'

import type { CommandRunner, HarnessKind } from './types.ts'

export const NATIVE_VAULT_HOST_NAMES = {
  opencode: CLAUSTRUM_OPENCODE_ENROLLMENT_NAME,
  pi: CLAUSTRUM_PI_ENROLLMENT_NAME,
} as const

const NATIVE_VAULT_HOST_DISPLAY_NAMES = {
  opencode: 'Claude sign-in for OpenCode',
  pi: 'Claude sign-in for Pi',
} as const

/** Convert the token file resolved by getHostClaustrumEnrollmentPaths into runSetup's path inputs; the runner derives the matching state file itself. */
export function nativeVaultHostPaths(
  host: HarnessKind,
  env: NodeJS.ProcessEnv,
) {
  const { tokenPath } = getHostClaustrumEnrollmentPaths(host, env)
  return { stateDir: dirname(tokenPath), host, override: tokenPath }
}

export function nativeVaultConnectionFile(
  host: HarnessKind,
  env: NodeJS.ProcessEnv,
): string {
  return resolveClaustrumConnectionPath(
    host === 'pi' ? env.PI_ANTHROPIC_AUTH_CLAUSTRUM_CONNECTION_FILE : undefined,
    host === 'pi'
      ? { ...env, OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_CONNECTION_FILE: undefined }
      : env,
  )
}

export interface NativeVaultEnrollmentOptions {
  env: NodeJS.ProcessEnv
  runner: CommandRunner
  /**
   * Check that selected host processes are stopped and their inspection succeeded,
   * and reject an inherited OPENCODE_AUTH_CONTENT snapshot. These checks run
   * before each enrollment request, token write and permission change.
   */
  processFence: () => Promise<void>
  paths?: ClaustrumEnrollmentPaths
  client?: ClaustrumEnrollmentClient
  ckBinary?: string
  connectionFile?: string
  /** Defaults to granting native-account read access after enrollment. False leaves that grant to completeNativeVaultActivation, avoiding a duplicate grant. */
  grantPermissions?: boolean
}

export class NativeVaultEnrollmentError extends Error {
  constructor(
    public readonly code:
      | 'enrollment-refused'
      | 'enrollment-reset'
      | 'approval-refused'
      | 'permission-refused',
  ) {
    super(
      code === 'permission-refused'
        ? 'Native vault setup: permission-refused. Could not grant this host read access to native Claude accounts. An older ck may refuse a grant that already exists. Update CortexKit tools and run setup again.'
        : `Native vault setup: ${code}`,
    )
    this.name = 'NativeVaultEnrollmentError'
  }
}

/**
 * Enroll this stopped host and grant permission to list native Claude accounts.
 * This function does not fetch OAuth tokens or change which store serves requests;
 * account discovery and the credential-store switch are separate setup steps.
 */
export async function enrollNativeVaultForHost(
  host: HarnessKind,
  options: NativeVaultEnrollmentOptions,
): Promise<void> {
  const env = { ...options.env }
  const paths = options.paths ?? getHostClaustrumEnrollmentPaths(host, env)
  const name = NATIVE_VAULT_HOST_NAMES[host]
  const processFence = options.processFence
  const runner = options.runner
  const ck = options.ckBinary ?? 'ck'
  let ownedClient:
    | Awaited<ReturnType<typeof connectClaustrumEnrollmentClient>>
    | undefined
  let client = options.client
  try {
    await processFence()
    let status = await readClaustrumEnrollmentStatus(paths, name)
    const recoverable = new Set(['superseded', 'not_found', 'already_consumed'])
    if (
      status.state === 'idle' ||
      status.state === 'pending' ||
      (status.state === 'blocked' && recoverable.has(status.code))
    ) {
      if (!client) {
        ownedClient = await connectClaustrumEnrollmentClient({
          connectionFile:
            options.connectionFile ?? nativeVaultConnectionFile(host, env),
        })
        client = ownedClient
      }
      const connected = client
      const manager = new ClaustrumEnrollmentManager({
        paths,
        proposedName: name,
        displayName: NATIVE_VAULT_HOST_DISPLAY_NAMES[host],
        client: {
          enrollPropose: async (input) => {
            await processFence()
            return connected.enrollPropose(input)
          },
          enrollPoll: async (input) => {
            await processFence()
            return connected.enrollPoll(input)
          },
        },
        writeTokenFile: async (path, file) => {
          await processFence()
          await writeEnrollmentTokenFile(path, file)
        },
      })
      if (status.state === 'blocked') {
        await processFence()
        if ((await manager.resetTerminal()) !== 'reset')
          throw new NativeVaultEnrollmentError('enrollment-refused')
        // Clearing a refused or superseded request is the whole effect of
        // this run. A new request is proposed only when the user runs setup
        // again, so a stale ceremony never turns into a fresh one unasked.
        throw new NativeVaultEnrollmentError('enrollment-reset')
      }
      await processFence()
      status = await manager.reconcile()
      if (status.state === 'pending' && status.requestId) {
        await processFence()
        const approved = await runner.run(
          ck,
          [
            'auth',
            'enroll',
            'approve',
            '--request-id',
            status.requestId,
            '--name',
            name,
          ],
          { env },
        )
        if (approved.exitCode !== 0)
          throw new NativeVaultEnrollmentError('approval-refused')
        await processFence()
        status = await manager.reconcile()
      }
    }
    if (status.state !== 'approved')
      throw new NativeVaultEnrollmentError('enrollment-refused')
    if (options.grantPermissions !== false)
      await grantNativeVaultForHost(host, options)
  } catch (error) {
    if (error instanceof NativeVaultEnrollmentError) throw error
    // Never propagate a daemon, runner or fence exception that could contain a
    // request secret, enrollment bearer or command stderr.
    throw new NativeVaultEnrollmentError('enrollment-refused')
  } finally {
    ownedClient?.close()
  }
}

/**
 * The `ck` arguments that grant this host's enrolled principal read access to
 * the vault's anthropic-native category. Setup runs them, and the empty-vault
 * message shows the same command so the user can run it by hand.
 */
export function nativeVaultGrantArgs(
  host: HarnessKind,
  approvedName?: string,
): string[] {
  const name = approvedName ?? NATIVE_VAULT_HOST_NAMES[host]
  // Match the principal-name rules used by the Accounts enrollment display.
  if (typeof name !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(name))
    throw new NativeVaultEnrollmentError('permission-refused')
  return [
    'auth',
    'grant',
    '--principal',
    `enrolled:${name}`,
    '--selector-kind',
    'category',
    '--selector',
    'anthropic-native',
    '--operation',
    'read',
  ]
}

/** Grant this OpenCode or Pi principal read access to the vault's anthropic-native category; enrollment alone grants no provider access. */
export async function grantNativeVaultForHost(
  host: HarnessKind,
  options: Pick<
    NativeVaultEnrollmentOptions,
    'env' | 'runner' | 'processFence' | 'ckBinary' | 'paths'
  >,
): Promise<string | undefined> {
  try {
    await options.processFence()
    // common-auth's public status API includes the operator's approvedName;
    // the proposed default can belong to a different installation.
    const status = await readClaustrumEnrollmentStatus(
      options.paths ?? getHostClaustrumEnrollmentPaths(host, options.env),
      NATIVE_VAULT_HOST_NAMES[host],
    )
    if (status.state === 'blocked')
      throw new NativeVaultEnrollmentError('permission-refused')
    const approvedName =
      status.state === 'approved' ? status.approvedName : undefined
    const args = nativeVaultGrantArgs(host, approvedName)
    const grant = await options.runner.run(options.ckBinary ?? 'ck', args, {
      env: options.env,
    })
    if (grant.exitCode !== 0)
      throw new NativeVaultEnrollmentError('permission-refused')
    return approvedName
  } catch {
    throw new NativeVaultEnrollmentError('permission-refused')
  }
}
