import {
  getHostClaustrumEnrollmentPaths,
  resolveClaustrumConnectionPath,
} from '@cortexkit/anthropic-auth-core'
import { writeEnrollmentTokenFile } from '@cortexkit/claustrum-client'
import {
  type ClaustrumEnrollmentClient,
  ClaustrumEnrollmentManager,
  type ClaustrumEnrollmentPaths,
  connectClaustrumEnrollmentClient,
  readClaustrumEnrollmentStatus,
} from '@cortexkit/common-auth/claustrum'

import type { CommandRunner, HarnessKind } from './types.ts'

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
}

export class NativeVaultEnrollmentError extends Error {
  constructor(
    public readonly code:
      | 'enrollment-refused'
      | 'approval-refused'
      | 'permission-refused',
  ) {
    super(`Native vault setup: ${code}`)
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
  const name = `anthropic-auth-${host}`
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
          connectionFile: resolveClaustrumConnectionPath(
            options.connectionFile ??
              (host === 'pi'
                ? env.PI_ANTHROPIC_AUTH_CLAUSTRUM_CONNECTION_FILE
                : undefined),
            host === 'pi'
              ? {
                  ...env,
                  OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_CONNECTION_FILE: undefined,
                }
              : env,
          ),
        })
        client = ownedClient
      }
      const connected = client
      const manager = new ClaustrumEnrollmentManager({
        paths,
        proposedName: name,
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
    await processFence()
    const grant = await runner.run(
      ck,
      [
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
      ],
      { env },
    )
    if (grant.exitCode !== 0)
      throw new NativeVaultEnrollmentError('permission-refused')
  } catch (error) {
    if (error instanceof NativeVaultEnrollmentError) throw error
    // Never propagate a daemon, runner or fence exception that could contain a
    // request secret, enrollment bearer or command stderr.
    throw new NativeVaultEnrollmentError('enrollment-refused')
  } finally {
    ownedClient?.close()
  }
}
