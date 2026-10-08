import { expect, test } from 'bun:test'
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { enrollNativeVaultForHost } from './native-enrollment.ts'
import type { CommandRunner } from './types.ts'

async function fixture(body: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'native-offline-enrollment-'))
  try {
    await body(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
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
