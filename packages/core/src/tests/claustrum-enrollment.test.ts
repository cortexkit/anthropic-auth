import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  ClaustrumCredentialError,
  writeEnrollmentTokenFile,
} from '@cortexkit/claustrum-client'
import {
  CLAUSTRUM_OPENCODE_ENROLLMENT_NAME,
  type ClaustrumEnrollmentClient,
  ClaustrumEnrollmentManager,
  getClaustrumEnrollmentPaths,
  getHostClaustrumEnrollmentPaths,
  readClaustrumEnrollmentStatus,
  readClaustrumEnrollmentToken,
} from '../claustrum-enrollment.ts'

const tempDirs: string[] = []
const secret = '01'.repeat(32)

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'anthropic-auth-enrollment-'))
  tempDirs.push(dir)
  return getClaustrumEnrollmentPaths(join(dir, 'opencode-enrollment.json'))
}

function client(
  overrides: Partial<ClaustrumEnrollmentClient> = {},
): ClaustrumEnrollmentClient {
  return {
    enrollPropose: async () => ({ requestId: 'request-1' }),
    enrollPoll: async () => ({ status: 'pending' }),
    ...overrides,
  }
}

function manager(
  paths: Awaited<ReturnType<typeof fixture>>,
  enrollmentClient: ClaustrumEnrollmentClient,
  extra: Partial<
    ConstructorParameters<typeof ClaustrumEnrollmentManager>[0]
  > = {},
) {
  return new ClaustrumEnrollmentManager({
    client: enrollmentClient,
    paths,
    proposedName: CLAUSTRUM_OPENCODE_ENROLLMENT_NAME,
    mintSecret: () => secret,
    now: () => 1_000,
    ...extra,
  })
}

async function seedPendingRequest(
  paths: Awaited<ReturnType<typeof fixture>>,
  requestId?: string,
) {
  await writeFile(
    paths.statePath,
    `${JSON.stringify({
      version: 1,
      phase: 'pending',
      proposedName: CLAUSTRUM_OPENCODE_ENROLLMENT_NAME,
      requestSecret: secret,
      ...(requestId === undefined ? {} : { requestId }),
      createdAt: 1,
      updatedAt: 1,
    })}\n`,
    { mode: 0o600 },
  )
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  )
})

describe('ClaustrumEnrollmentManager', () => {
  test('persists the raw secret before proposing and hashes the decoded bytes', async () => {
    const paths = await fixture()
    const calls: string[] = []
    const instance = manager(
      paths,
      client({
        enrollPropose: async ({ name, requestSecretHash }) => {
          calls.push('propose')
          const persisted = JSON.parse(await readFile(paths.statePath, 'utf8'))
          expect(persisted.phase).toBe('pending')
          expect(persisted.requestSecret).toBe(secret)
          expect(persisted.requestId).toBeUndefined()
          expect(name).toBe(CLAUSTRUM_OPENCODE_ENROLLMENT_NAME)
          expect(requestSecretHash).toBe(
            createHash('sha256')
              .update(Buffer.from(secret, 'hex'))
              .digest('hex'),
          )
          return { requestId: 'request-1' }
        },
        enrollPoll: async ({ requestId, requestSecret }) => {
          calls.push('poll')
          expect(requestId).toBe('request-1')
          expect(requestSecret).toBe(secret)
          return {
            status: 'approved',
            name: 'renamed-consumer',
            token: 'ab'.repeat(32),
            tokenGeneration: 1,
          }
        },
      }),
    )

    await expect(instance.reconcile()).resolves.toEqual({
      state: 'approved',
      proposedName: CLAUSTRUM_OPENCODE_ENROLLMENT_NAME,
      approvedName: 'renamed-consumer',
      tokenGeneration: 1,
    })
    expect(calls).toEqual(['propose', 'poll'])
    expect(JSON.parse(await readFile(paths.tokenPath, 'utf8'))).toEqual({
      token: 'ab'.repeat(32),
      token_generation: 1,
    })
    const finalState = await readFile(paths.statePath, 'utf8')
    expect(finalState).not.toContain(secret)
    expect(JSON.parse(finalState)).toMatchObject({
      phase: 'approved',
      approvedName: 'renamed-consumer',
      tokenGeneration: 1,
    })
    expect((await stat(paths.tokenPath)).mode & 0o777).toBe(0o600)
    expect((await stat(paths.statePath)).mode & 0o777).toBe(0o600)
  })

  test('re-proposes with the same persisted secret after a crash before the request id is saved', async () => {
    const paths = await fixture()
    const hashes: string[] = []
    const first = manager(
      paths,
      client({
        enrollPropose: async ({ requestSecretHash }) => {
          hashes.push(requestSecretHash)
          throw new Error('connection reset after server commit')
        },
      }),
    )
    await expect(first.reconcile()).rejects.toThrow(
      'connection reset after server commit',
    )

    const second = manager(
      paths,
      client({
        enrollPropose: async ({ requestSecretHash }) => {
          hashes.push(requestSecretHash)
          return { requestId: 'same-server-request' }
        },
      }),
    )
    await expect(second.reconcile()).resolves.toEqual({
      state: 'pending',
      proposedName: CLAUSTRUM_OPENCODE_ENROLLMENT_NAME,
      requestId: 'same-server-request',
    })
    expect(hashes).toHaveLength(2)
    expect(hashes[0]).toBe(hashes[1])
    const persisted = JSON.parse(await readFile(paths.statePath, 'utf8'))
    expect(persisted.requestSecret).toBe(secret)
    expect(persisted.requestId).toBe('same-server-request')
  })

  test('keeps the secret and reports retryable queue saturation without inventing a request id', async () => {
    const paths = await fixture()
    const instance = manager(
      paths,
      client({
        enrollPropose: async () => {
          throw new ClaustrumCredentialError(
            'pending_queue_full',
            'transient',
            'retry',
          )
        },
      }),
    )
    await expect(instance.reconcile()).resolves.toEqual({
      state: 'pending',
      proposedName: CLAUSTRUM_OPENCODE_ENROLLMENT_NAME,
      retryCode: 'pending_queue_full',
    })
    const persisted = JSON.parse(await readFile(paths.statePath, 'utf8'))
    expect(persisted.requestSecret).toBe(secret)
    expect(persisted.requestId).toBeUndefined()
  })

  test('blocks and scrubs the secret when another live proposal owns the name', async () => {
    const paths = await fixture()
    const instance = manager(
      paths,
      client({
        enrollPropose: async () => {
          throw new ClaustrumCredentialError(
            'pending_exists',
            'permanent',
            'gone',
          )
        },
      }),
    )
    await expect(instance.reconcile()).resolves.toEqual({
      state: 'blocked',
      proposedName: CLAUSTRUM_OPENCODE_ENROLLMENT_NAME,
      code: 'pending_exists',
    })
    expect(await readFile(paths.statePath, 'utf8')).not.toContain(secret)
  })

  test('fails terminally and scrubs the secret for permanent ceremony refusals', async () => {
    for (const code of ['invalid_params', 'already_consumed', 'superseded']) {
      const paths = await fixture()
      const proposalFailure = code === 'invalid_params'
      const instance = manager(
        paths,
        client({
          ...(proposalFailure && {
            enrollPropose: async () => {
              throw new ClaustrumCredentialError(code, 'permanent', 'gone')
            },
          }),
          ...(!proposalFailure && {
            enrollPoll: async () => {
              throw new ClaustrumCredentialError(code, 'permanent', 'gone')
            },
          }),
        }),
      )
      await expect(instance.reconcile()).resolves.toEqual({
        state: 'blocked',
        proposedName: CLAUSTRUM_OPENCODE_ENROLLMENT_NAME,
        code,
      })
      expect(await readFile(paths.statePath, 'utf8')).not.toContain(secret)
    }
  })

  test('removes the request secret when the operator denies enrollment', async () => {
    const paths = await fixture()
    const instance = manager(
      paths,
      client({ enrollPoll: async () => ({ status: 'denied' }) }),
    )
    await expect(instance.reconcile()).resolves.toEqual({
      state: 'denied',
      proposedName: CLAUSTRUM_OPENCODE_ENROLLMENT_NAME,
    })
    const persisted = await readFile(paths.statePath, 'utf8')
    expect(persisted).not.toContain(secret)
    expect(JSON.parse(persisted).phase).toBe('denied')
  })

  test('resets only terminal local ceremony state', async () => {
    const deniedPaths = await fixture()
    const denied = manager(
      deniedPaths,
      client({ enrollPoll: async () => ({ status: 'denied' }) }),
    )
    await denied.reconcile()
    await expect(denied.resetTerminal()).resolves.toBe('reset')
    await expect(denied.status()).resolves.toEqual({ state: 'idle' })

    const pendingPaths = await fixture()
    const pending = manager(pendingPaths, client())
    await pending.reconcile()
    await expect(pending.resetTerminal()).resolves.toBe('refused-pending')

    const approvedPaths = await fixture()
    await writeEnrollmentTokenFile(approvedPaths.tokenPath, {
      token: 'ff'.repeat(32),
      token_generation: 1,
    })
    const approved = manager(approvedPaths, client())
    await expect(approved.resetTerminal()).resolves.toBe('refused-approved')
  })

  test('writes the one-shot token before replacing pending metadata', async () => {
    const paths = await fixture()
    let observedPending = false
    const instance = manager(
      paths,
      client({
        enrollPoll: async () => ({
          status: 'approved',
          name: CLAUSTRUM_OPENCODE_ENROLLMENT_NAME,
          token: 'cd'.repeat(32),
          tokenGeneration: 2,
        }),
      }),
      {
        writeTokenFile: async (path, value) => {
          const state = JSON.parse(await readFile(paths.statePath, 'utf8'))
          observedPending =
            state.phase === 'pending' && state.requestSecret === secret
          await writeEnrollmentTokenFile(path, value)
        },
      },
    )
    await instance.reconcile()
    expect(observedPending).toBe(true)
  })

  test('an existing token suppresses all wire calls and scrubs interrupted pending state', async () => {
    const paths = await fixture()
    await writeEnrollmentTokenFile(paths.tokenPath, {
      token: 'ef'.repeat(32),
      token_generation: 3,
    })
    await writeFile(
      paths.statePath,
      `${JSON.stringify({
        version: 1,
        phase: 'pending',
        proposedName: CLAUSTRUM_OPENCODE_ENROLLMENT_NAME,
        requestSecret: secret,
        requestId: 'request-before-crash',
        createdAt: 1,
        updatedAt: 1,
      })}\n`,
      { mode: 0o600 },
    )
    let calls = 0
    const instance = manager(
      paths,
      client({
        enrollPropose: async () => {
          calls += 1
          return { requestId: 'unexpected' }
        },
        enrollPoll: async () => {
          calls += 1
          return { status: 'pending' }
        },
      }),
    )
    await expect(instance.reconcile()).resolves.toEqual({
      state: 'approved',
      proposedName: CLAUSTRUM_OPENCODE_ENROLLMENT_NAME,
      tokenGeneration: 3,
    })
    expect(calls).toBe(0)
    expect(await readFile(paths.statePath, 'utf8')).not.toContain(secret)
  })

  test('fails closed on an owner-readable enrollment file with group permissions', async () => {
    const paths = await fixture()
    await writeFile(paths.statePath, '{}\n', { mode: 0o640 })
    await chmod(paths.statePath, 0o640)
    let calls = 0
    const instance = manager(
      paths,
      client({
        enrollPropose: async () => {
          calls += 1
          return { requestId: 'unexpected' }
        },
      }),
    )
    await expect(instance.reconcile()).rejects.toThrow('owner-only')
    expect(calls).toBe(0)
  })

  test('refuses to persist a request secret below an unsafe writable ancestor', async () => {
    const paths = await fixture()
    const unsafe = join(dirname(paths.tokenPath), 'unsafe')
    await mkdir(unsafe)
    await chmod(unsafe, 0o777)
    const unsafePaths = getClaustrumEnrollmentPaths(
      join(unsafe, 'private', 'enrollment.json'),
    )
    let proposed = false
    const instance = manager(
      unsafePaths,
      client({
        enrollPropose: async () => {
          proposed = true
          return { requestId: 'unexpected' }
        },
      }),
    )
    await expect(instance.reconcile()).rejects.toThrow(
      'unsafe writable ancestor',
    )
    expect(proposed).toBe(false)
  })

  test('refuses a symlinked enrollment state before any wire call', async () => {
    const paths = await fixture()
    const target = join(dirname(paths.statePath), 'attacker-state.json')
    await writeFile(target, '{}\n', { mode: 0o600 })
    await symlink(target, paths.statePath)
    let calls = 0
    const instance = manager(
      paths,
      client({
        enrollPropose: async () => {
          calls += 1
          return { requestId: 'unexpected' }
        },
      }),
    )
    await expect(instance.reconcile()).rejects.toThrow(
      'could not be opened safely',
    )
    expect(calls).toBe(0)
  })

  test('serializes concurrent process instances so only one proposal is sent', async () => {
    const paths = await fixture()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let proposals = 0
    const first = manager(
      paths,
      client({
        enrollPropose: async () => {
          proposals += 1
          await gate
          return { requestId: 'request-1' }
        },
      }),
    )
    const second = manager(paths, client())
    const firstRun = first.reconcile()
    await new Promise((resolve) => setTimeout(resolve, 10))
    await expect(second.reconcile()).resolves.toEqual({ state: 'busy' })
    release()
    await firstRun
    expect(proposals).toBe(1)
  })

  test('treats poll not_found as permanent without probing through re-proposal', async () => {
    const paths = await fixture()
    let proposals = 0
    let polls = 0
    const instance = manager(
      paths,
      client({
        enrollPropose: async () => ({ requestId: `request-${++proposals}` }),
        enrollPoll: async () => {
          polls += 1
          throw new ClaustrumCredentialError('not_found', 'permanent', 'gone')
        },
      }),
    )
    const blocked = {
      state: 'blocked' as const,
      proposedName: CLAUSTRUM_OPENCODE_ENROLLMENT_NAME,
      code: 'not_found',
    }
    await expect(instance.reconcile()).resolves.toEqual(blocked)
    await expect(instance.reconcile()).resolves.toEqual(blocked)
    expect(proposals).toBe(1)
    expect(polls).toBe(1)
  })

  test('persists every permanent poll refusal as an operator-visible terminal state', async () => {
    for (const code of ['already_consumed', 'superseded', 'invalid_params']) {
      const paths = await fixture()
      const instance = manager(
        paths,
        client({
          enrollPoll: async () => {
            throw new ClaustrumCredentialError(code, 'permanent', 'gone')
          },
        }),
      )
      await expect(instance.reconcile()).resolves.toEqual({
        state: 'blocked',
        proposedName: CLAUSTRUM_OPENCODE_ENROLLMENT_NAME,
        code,
      })
      await expect(readClaustrumEnrollmentStatus(paths)).resolves.toEqual({
        state: 'blocked',
        proposedName: CLAUSTRUM_OPENCODE_ENROLLMENT_NAME,
        code,
      })
    }
  })

  test('blocks a retryable poll refusal whose code is protocol-terminal and stops re-polling', async () => {
    for (const code of [
      'invalid_params',
      'pending_exists',
      'not_found',
      'already_consumed',
      'superseded',
      'stale_generation',
    ]) {
      const paths = await fixture()
      await seedPendingRequest(paths, 'request-1')
      let polls = 0
      const instance = manager(
        paths,
        client({
          enrollPoll: async () => {
            polls += 1
            throw new ClaustrumCredentialError(code, 'transient', 'retry')
          },
        }),
      )
      const blocked = {
        state: 'blocked' as const,
        proposedName: CLAUSTRUM_OPENCODE_ENROLLMENT_NAME,
        code,
      }
      await expect(instance.reconcile()).resolves.toEqual(blocked)
      expect(JSON.parse(await readFile(paths.statePath, 'utf8')).phase).toBe(
        'blocked',
      )
      await expect(instance.reconcile()).resolves.toEqual(blocked)
      expect(polls).toBe(1)
    }
  })

  test('blocks a retryable propose refusal whose code is protocol-terminal', async () => {
    for (const code of [
      'invalid_params',
      'pending_exists',
      'not_found',
      'already_consumed',
      'superseded',
      'stale_generation',
    ]) {
      const paths = await fixture()
      await seedPendingRequest(paths)
      const instance = manager(
        paths,
        client({
          enrollPropose: async () => {
            throw new ClaustrumCredentialError(code, 'transient', 'retry')
          },
        }),
      )
      await expect(instance.reconcile()).resolves.toEqual({
        state: 'blocked',
        proposedName: CLAUSTRUM_OPENCODE_ENROLLMENT_NAME,
        code,
      })
      expect(JSON.parse(await readFile(paths.statePath, 'utf8')).phase).toBe(
        'blocked',
      )
    }
  })

  test('keeps genuinely retryable poll refusals pending', async () => {
    for (const code of [
      'pending_queue_full',
      'store_error',
      'transport_error',
    ]) {
      const paths = await fixture()
      await seedPendingRequest(paths, 'request-1')
      const instance = manager(
        paths,
        client({
          enrollPoll: async () => {
            throw new ClaustrumCredentialError(code, 'transient', 'retry')
          },
        }),
      )
      await expect(instance.reconcile()).resolves.toEqual({
        state: 'pending',
        proposedName: CLAUSTRUM_OPENCODE_ENROLLMENT_NAME,
        requestId: 'request-1',
        retryCode: code,
      })
      expect(JSON.parse(await readFile(paths.statePath, 'utf8')).phase).toBe(
        'pending',
      )
    }
  })

  test('blocks approved metadata when the authoritative token file is missing', async () => {
    const paths = await fixture()
    await writeFile(
      paths.statePath,
      `${JSON.stringify({
        version: 1,
        phase: 'approved',
        proposedName: CLAUSTRUM_OPENCODE_ENROLLMENT_NAME,
        approvedName: CLAUSTRUM_OPENCODE_ENROLLMENT_NAME,
        tokenGeneration: 2,
        updatedAt: Date.now(),
      })}\n`,
      { mode: 0o600 },
    )
    const instance = manager(paths, client())
    await expect(instance.reconcile()).resolves.toEqual({
      state: 'blocked',
      proposedName: CLAUSTRUM_OPENCODE_ENROLLMENT_NAME,
      code: 'missing_token',
    })
  })

  test('reads a persisted approved status without exposing the enrollment token', async () => {
    const paths = await fixture()
    const token = 'aa'.repeat(32)
    await writeEnrollmentTokenFile(paths.tokenPath, {
      token,
      token_generation: 4,
    })
    const status = await readClaustrumEnrollmentStatus(paths)
    expect(status).toEqual({
      state: 'approved',
      proposedName: CLAUSTRUM_OPENCODE_ENROLLMENT_NAME,
      tokenGeneration: 4,
    })
    expect(JSON.stringify(status)).not.toContain(token)
  })
})

describe('scoped enrollment token reads', () => {
  test('reads each atomic replacement rather than retaining the previous token', async () => {
    const paths = await fixture()
    await writeEnrollmentTokenFile(paths.tokenPath, {
      token: secret,
      token_generation: 1,
    })
    expect(await readClaustrumEnrollmentToken(paths.tokenPath)).toEqual({
      token: secret,
      token_generation: 1,
    })
    await writeEnrollmentTokenFile(paths.tokenPath, {
      token: '02'.repeat(32),
      token_generation: 2,
    })
    expect(await readClaustrumEnrollmentToken(paths.tokenPath)).toEqual({
      token: '02'.repeat(32),
      token_generation: 2,
    })
    await rm(paths.tokenPath)
    await expect(readClaustrumEnrollmentToken(paths.tokenPath)).rejects.toThrow(
      'not configured',
    )
  })

  test.skipIf(process.platform === 'win32')(
    'refuses symlinks and world-readable token files',
    async () => {
      const paths = await fixture()
      await writeEnrollmentTokenFile(paths.tokenPath, {
        token: secret,
        token_generation: 1,
      })
      const link = join(dirname(paths.tokenPath), 'link.json')
      await symlink(paths.tokenPath, link)
      await expect(readClaustrumEnrollmentToken(link)).rejects.toThrow()
      await chmod(paths.tokenPath, 0o644)
      await expect(
        readClaustrumEnrollmentToken(paths.tokenPath),
      ).rejects.toThrow('owner-only')
    },
  )
})

test('a second host cannot adopt or reset another host ceremony on disk', async () => {
  const paths = await fixture()
  const original = manager(
    paths,
    client({ enrollPoll: async () => ({ status: 'denied' }) }),
  )
  await original.reconcile()
  const before = await readFile(paths.statePath, 'utf8')
  let calls = 0
  const other = manager(
    paths,
    client({
      enrollPropose: async () => {
        calls++
        return { requestId: 'wrong-host' }
      },
    }),
    { proposedName: 'anthropic-auth-pi' },
  )
  await expect(other.reconcile()).rejects.toThrow('different consumer')
  await expect(other.resetTerminal()).rejects.toThrow('different consumer')
  expect(await readFile(paths.statePath, 'utf8')).toBe(before)
  expect(calls).toBe(0)
})

test('Pi token-only status uses its own consumer name', async () => {
  const paths = await fixture()
  await writeEnrollmentTokenFile(paths.tokenPath, {
    token: secret,
    token_generation: 1,
  })
  const instance = manager(paths, client(), {
    proposedName: 'anthropic-auth-pi',
  })
  expect(await instance.status()).toEqual({
    state: 'approved',
    proposedName: 'anthropic-auth-pi',
    tokenGeneration: 1,
  })
  expect(
    await readClaustrumEnrollmentStatus(paths, 'anthropic-auth-pi'),
  ).toEqual(await instance.status())
})

test('a terminal refusal committed by one process stops an older process on its next tick', async () => {
  const paths = await fixture()
  await seedPendingRequest(paths, 'expired-request')
  let oldProcessPolls = 0
  const oldProcess = manager(
    paths,
    client({
      enrollPoll: async () => {
        oldProcessPolls++
        return { status: 'pending' }
      },
    }),
  )
  const newProcess = manager(
    paths,
    client({
      enrollPoll: async () => {
        throw new ClaustrumCredentialError('superseded', 'transient', 'retry')
      },
    }),
  )
  expect(await oldProcess.reconcile()).toMatchObject({ state: 'pending' })
  expect(oldProcessPolls).toBe(1)
  expect(await newProcess.reconcile()).toEqual({
    state: 'blocked',
    proposedName: CLAUSTRUM_OPENCODE_ENROLLMENT_NAME,
    code: 'superseded',
  })
  expect(await oldProcess.reconcile()).toMatchObject({
    state: 'blocked',
    code: 'superseded',
  })
  expect(oldProcessPolls).toBe(1)
  expect(
    JSON.parse(await readFile(paths.statePath, 'utf8')),
  ).not.toHaveProperty('requestSecret')
})

test('OpenCode and Pi resolve separate owner-only enrollment paths from the same state root', () => {
  const env = { XDG_STATE_HOME: join(tmpdir(), 'shared-state') }
  const opencode = getHostClaustrumEnrollmentPaths('opencode', env)
  const pi = getHostClaustrumEnrollmentPaths('pi', env)
  expect(opencode.tokenPath).toBe(
    join(
      env.XDG_STATE_HOME,
      'cortexkit',
      'anthropic-auth',
      'opencode-enrollment.json',
    ),
  )
  expect(opencode.statePath).toBe(
    join(
      env.XDG_STATE_HOME,
      'cortexkit',
      'anthropic-auth',
      'opencode-enrollment-state.json',
    ),
  )
  expect(pi.tokenPath).toBe(
    join(
      env.XDG_STATE_HOME,
      'cortexkit',
      'anthropic-auth',
      'pi-enrollment.json',
    ),
  )
  expect(pi.statePath).toBe(
    join(
      env.XDG_STATE_HOME,
      'cortexkit',
      'anthropic-auth',
      'pi-enrollment-state.json',
    ),
  )
  expect(pi.tokenPath).not.toBe(opencode.tokenPath)
})

test('host-specific overrides resolve absolute and project-relative enrollment paths without crossing hosts', () => {
  const project = join(tmpdir(), 'enrollment-project')
  const piToken = join(project, 'owner', 'pi.json')
  const env = {
    XDG_STATE_HOME: join(project, 'state'),
    PI_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE: piToken,
    OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE: 'owner/opencode.json',
  }
  expect(getHostClaustrumEnrollmentPaths('pi', env, project)).toEqual({
    tokenPath: piToken,
    statePath: join(project, 'owner', 'pi-state.json'),
  })
  expect(getHostClaustrumEnrollmentPaths('opencode', env, project)).toEqual({
    tokenPath: join(project, 'owner', 'opencode.json'),
    statePath: join(project, 'owner', 'opencode-state.json'),
  })
})
