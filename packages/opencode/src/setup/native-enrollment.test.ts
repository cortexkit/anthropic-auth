import { expect, test } from 'bun:test'
import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  enrollNativeVaultForHost,
  grantNativeVaultForHost,
} from './native-enrollment.ts'
import type { CommandRunner } from './types.ts'

async function fixture(body: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'native-offline-enrollment-'))
  try {
    await body(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

for (const host of ['opencode', 'pi'] as const) {
  test(`${host} enrollment grants the principal approved under a different name`, async () => {
    await fixture(async (root) => {
      const calls: string[][] = []
      await enrollNativeVaultForHost(host, {
        env: {},
        paths: {
          tokenPath: join(root, 'token.json'),
          statePath: join(root, 'state.json'),
        },
        processFence: async () => {},
        runner: {
          run: async (_command, args) => {
            calls.push(args)
            return { exitCode: 0, stdout: '', stderr: '' }
          },
        },
        client: {
          enrollPropose: async () => ({ requestId: 'synthetic-request-id' }),
          enrollPoll: async () => ({
            status: 'approved',
            name: `anthropic-auth-${host}-v2`,
            token: 'a'.repeat(64),
            tokenGeneration: 1,
          }),
        },
      })
      expect(calls).toEqual([
        [
          'auth',
          'grant',
          '--principal',
          `enrolled:anthropic-auth-${host}-v2`,
          '--selector-kind',
          'category',
          '--selector',
          'anthropic-native',
          '--operation',
          'read',
        ],
      ])
    })
  })

  for (const approvedName of [
    undefined,
    'bad;synthetic-secret',
    'has space',
    'x'.repeat(129),
    '',
    42,
  ]) {
    test(`${host} grant ${approvedName === undefined ? 'falls back only when no approved name is recorded' : `refuses invalid approved name ${JSON.stringify(approvedName)}`}`, async () => {
      await fixture(async (root) => {
        const env = {
          [`${host.toUpperCase()}_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE`]:
            join(root, 'token.json'),
        }
        const paths = getHostClaustrumEnrollmentPaths(host, env)
        await writeFile(
          paths.tokenPath,
          JSON.stringify({ token: 'a'.repeat(64), token_generation: 1 }),
          { mode: 0o600 },
        )
        await writeFile(
          paths.statePath,
          JSON.stringify({
            version: 1,
            phase: 'approved',
            proposedName: `anthropic-auth-${host}`,
            approvedName,
            tokenGeneration: 1,
            updatedAt: 1,
          }),
          { mode: 0o600 },
        )
        const calls: string[][] = []
        const operation = grantNativeVaultForHost(host, {
          env,
          processFence: async () => {},
          runner: {
            run: async (_command, args) => {
              calls.push(args)
              return { exitCode: 0, stdout: '', stderr: '' }
            },
          },
        })
        if (approvedName === undefined) {
          await operation
          expect(calls).toHaveLength(1)
          expect(calls[0]?.[3]).toBe(`enrolled:anthropic-auth-${host}`)
        } else {
          await expect(operation).rejects.toMatchObject({
            code: 'permission-refused',
            message:
              'Native vault setup: permission-refused. Could not grant this host read access to native Claude accounts. An older ck may refuse a grant that already exists. Update CortexKit tools and run setup again.',
          })
          expect(calls).toEqual([])
        }
      })
    })
  }
}

for (const [name, exitCode, stdout] of [
  [
    'a fresh grant',
    0,
    'granted enrolled:anthropic-auth-opencode read category:anthropic-native',
  ],
  [
    'an existing identical grant',
    0,
    'already granted (no change) enrolled:anthropic-auth-opencode read category:anthropic-native',
  ],
  ['a real grant failure', 1, 'synthetic-secret-output'],
] as const) {
  test(`${name} uses only the grant exit status and never exposes command output`, async () => {
    await fixture(async (root) => {
      const calls: Array<{ command: string; args: string[] }> = []
      let fences = 0
      const operation = grantNativeVaultForHost('opencode', {
        env: {},
        paths: {
          tokenPath: join(root, 'token.json'),
          statePath: join(root, 'state.json'),
        },
        ckBinary: '/fixture/ck',
        processFence: async () => {
          fences++
        },
        runner: {
          run: async (command, args) => {
            calls.push({ command, args })
            return {
              exitCode,
              stdout,
              stderr:
                'error: the running module refused the op: credential already exists; synthetic-secret-stderr',
            }
          },
        },
      })
      if (exitCode === 0) await expect(operation).resolves.toBeUndefined()
      else {
        await expect(operation).rejects.toMatchObject({
          code: 'permission-refused',
        })
        await expect(operation).rejects.toThrow(
          'Update CortexKit tools and run setup again.',
        )
        await expect(operation).rejects.not.toThrow('synthetic-secret')
        await expect(operation).rejects.not.toThrow('credential already exists')
      }
      expect(fences).toBe(1)
      expect(calls).toEqual([
        {
          command: '/fixture/ck',
          args: [
            'auth',
            'grant',
            '--principal',
            'enrolled:anthropic-auth-opencode',
            '--selector-kind',
            'category',
            '--selector',
            'anthropic-native',
            '--operation',
            'read',
          ],
        },
      ])
    })
  })
}

test('explicit offline enrollment uses public ceremony and permission APIs without legacy account writes', async () => {
  await fixture(async (root) => {
    const paths = {
      tokenPath: join(root, 'enrollment.json'),
      statePath: join(root, 'enrollment-state.json'),
    }
    const calls: string[] = []
    let approved = false
    let fences = 0
    const runner: CommandRunner = {
      run: async (_command, args) => {
        calls.push(args.slice(0, 3).join(' '))
        if (args.includes('approve')) approved = true
        return { exitCode: 0, stdout: '', stderr: '' }
      },
    }
    await enrollNativeVaultForHost('opencode', {
      paths,
      env: {},
      runner,
      processFence: async () => {
        fences++
      },
      client: {
        enrollPropose: async (input) => {
          expect(input.name).toBe('anthropic-auth-opencode')
          calls.push('propose')
          return { requestId: 'synthetic-request-id' }
        },
        enrollPoll: async () => {
          calls.push('poll')
          return approved
            ? {
                status: 'approved',
                name: 'anthropic-auth-opencode',
                token: 'a'.repeat(64),
                tokenGeneration: 3,
              }
            : { status: 'pending' }
        },
      },
    })
    expect(calls).toEqual([
      'propose',
      'poll',
      'auth enroll approve',
      'poll',
      'auth grant --principal',
    ])
    expect(fences).toBeGreaterThanOrEqual(calls.length)
    expect(JSON.parse(await readFile(paths.tokenPath, 'utf8'))).toEqual({
      token: 'a'.repeat(64),
      token_generation: 3,
    })
    expect((await stat(paths.tokenPath)).mode & 0o777).toBe(0o600)
    expect((await readdir(root)).sort()).toEqual([
      'enrollment-state.json',
      'enrollment.json',
    ])
  })
})

test('offline enrollment refuses initial process fence with no ceremony, permission or file effect', async () => {
  await fixture(async (root) => {
    let calls = 0
    await expect(
      enrollNativeVaultForHost('pi', {
        env: {},
        paths: {
          tokenPath: join(root, 'token.json'),
          statePath: join(root, 'state.json'),
        },
        processFence: async () => {
          throw new Error('synthetic running host')
        },
        runner: {
          run: async () => {
            calls++
            return { exitCode: 0, stdout: '', stderr: '' }
          },
        },
        client: {
          enrollPropose: async () => {
            calls++
            return { requestId: 'synthetic' }
          },
          enrollPoll: async () => {
            calls++
            return { status: 'pending' }
          },
        },
      }),
    ).rejects.toMatchObject({ code: 'enrollment-refused' })
    expect(calls).toBe(0)
    expect(await readdir(root)).toEqual([])
  })
})

test('approval and grant failures retain fixed errors without runner stderr or enrollment secrets', async () => {
  for (const failure of ['approve', 'grant'])
    await fixture(async (root) => {
      let approved = false
      const runner: CommandRunner = {
        run: async (_command, args) => {
          if (args.includes(failure))
            return {
              exitCode: 1,
              stdout: 'synthetic-secret-output',
              stderr: 'synthetic-secret-stderr',
            }
          if (args.includes('approve')) approved = true
          return { exitCode: 0, stdout: '', stderr: '' }
        },
      }
      let caught: unknown
      try {
        await enrollNativeVaultForHost('pi', {
          env: {},
          runner,
          processFence: async () => {},
          paths: {
            tokenPath: join(root, 'token.json'),
            statePath: join(root, 'state.json'),
          },
          client: {
            enrollPropose: async () => ({ requestId: 'synthetic-id' }),
            enrollPoll: async () =>
              approved
                ? {
                    status: 'approved',
                    name: 'anthropic-auth-pi',
                    token: 'b'.repeat(64),
                    tokenGeneration: 1,
                  }
                : { status: 'pending' },
          },
        })
      } catch (error) {
        caught = error
      }
      expect(caught).toMatchObject({
        code: failure === 'approve' ? 'approval-refused' : 'permission-refused',
      })
      expect(String(caught)).not.toContain('synthetic-secret')
      expect(String(caught)).not.toContain('b'.repeat(64))
    })
})

test('a terminal enrollment is reset without proposing; only a later explicit setup run proposes again', async () => {
  await fixture(async (root) => {
    const paths = {
      tokenPath: join(root, 'enrollment.json'),
      statePath: join(root, 'enrollment-state.json'),
    }
    await writeFile(
      paths.statePath,
      JSON.stringify({
        version: 1,
        phase: 'blocked',
        proposedName: 'anthropic-auth-pi',
        errorCode: 'superseded',
        updatedAt: 1,
      }),
      { mode: 0o600 },
    )
    const calls: string[] = []
    const client = {
      enrollPropose: async () => {
        calls.push('propose')
        return { requestId: 'synthetic-request-id' }
      },
      enrollPoll: async () => {
        calls.push('poll')
        return { status: 'pending' as const }
      },
    }
    const runner: CommandRunner = {
      run: async (_command, args) => {
        calls.push(args.slice(0, 3).join(' '))
        return { exitCode: 0, stdout: '', stderr: '' }
      },
    }
    await expect(
      enrollNativeVaultForHost('pi', {
        paths,
        env: {},
        runner,
        processFence: async () => {},
        client,
      }),
    ).rejects.toMatchObject({ code: 'enrollment-reset' })
    expect(calls).toEqual([])
    await expect(stat(paths.tokenPath)).rejects.toMatchObject({
      code: 'ENOENT',
    })
    // The next explicit run starts a new request from the reset state.
    await expect(
      enrollNativeVaultForHost('pi', {
        paths,
        env: {},
        runner,
        processFence: async () => {},
        client,
      }),
    ).rejects.toMatchObject({ code: 'enrollment-refused' })
    expect(calls.slice(0, 2)).toEqual(['propose', 'poll'])
  })
})

import { getHostClaustrumEnrollmentPaths } from '@cortexkit/anthropic-auth-core'
import { hostEnrollmentPaths } from '@cortexkit/common-auth/claustrum'
import {
  NATIVE_VAULT_HOST_NAMES,
  nativeVaultHostPaths,
} from './native-enrollment.ts'

for (const host of ['opencode', 'pi'] as const) {
  for (const override of [undefined, '/fixture/private/enrollment.json']) {
    test(`runner enrollment paths match Core for ${host} (${override ? 'override' : 'default'})`, () => {
      const env = {
        XDG_STATE_HOME: '/fixture/state',
        [`${host.toUpperCase()}_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE`]:
          override,
      }
      expect(NATIVE_VAULT_HOST_NAMES[host]).toBe(`anthropic-auth-${host}`)
      expect(hostEnrollmentPaths(nativeVaultHostPaths(host, env))).toEqual(
        getHostClaustrumEnrollmentPaths(host, env),
      )
    })
  }
}

for (const [host, name, displayName] of [
  ['opencode', 'anthropic-auth-opencode', 'Claude sign-in for OpenCode'],
  ['pi', 'anthropic-auth-pi', 'Claude sign-in for Pi'],
] as const) {
  test(`${host} enrollment proposes its fixed person-facing display name`, async () => {
    await fixture(async (root) => {
      const proposals: { name: string; displayName?: string }[] = []
      await enrollNativeVaultForHost(host, {
        paths: {
          tokenPath: join(root, 'enrollment.json'),
          statePath: join(root, 'enrollment-state.json'),
        },
        env: {},
        runner: { run: async () => ({ exitCode: 0, stdout: '', stderr: '' }) },
        processFence: async () => {},
        grantPermissions: false,
        client: {
          enrollPropose: async (input) => {
            proposals.push(input)
            return { requestId: 'named-request' }
          },
          enrollPoll: async () => ({
            status: 'approved',
            name,
            token: 'a'.repeat(64),
            tokenGeneration: 1,
          }),
        },
      })
      expect(proposals).toHaveLength(1)
      expect(proposals).toMatchObject([{ name, displayName }])
      expect(displayName.length).toBeLessThanOrEqual(40)
    })
  })
}
