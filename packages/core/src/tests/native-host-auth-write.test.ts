import { expect, spyOn } from 'bun:test'
import * as crypto from 'node:crypto'
import {
  chmod,
  type FileHandle,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inspect } from 'node:util'

import { inspectNativeHostAuthEntry } from '../native-host-auth.ts'
import {
  isNativeHostAuthWriteStagingName,
  type NativeHostAuthWriteHooks,
  type NativeHostAuthWriteInput,
  writeNativeHostAuth,
} from '../native-host-auth-write.ts'
import { createTestLifetimeSuite } from './test-lifetime.ts'

const { test, deferCleanup, gate, trackDetached } = createTestLifetimeSuite()
const oauth = {
  type: 'oauth',
  access: 'synthetic-access',
  refresh: 'synthetic-refresh',
  expires: 0,
}
// These SHA-256 digests are the oauth and activation fixtures in
// native-host-auth.test.ts, hashed from its hand-written canonical JSON.
const sourceDigest =
  'b006e78a28dd6ba18131eb83536a8be9919c684befbd2b30ac57df97ff8d11ed'
const activationDigest =
  '34ff5181a0466836fec63f58d91bf4d04c46ec2090ab5ed3b6c554332c4bc669'
const activation = {
  type: 'oauth',
  access: '',
  refresh: 'claustrum-tombstone:v1:anthropic',
  expires: 0,
}

async function fixture(text?: string) {
  const created = await mkdtemp(join(tmpdir(), 'anthropic-host-auth-write-'))
  deferCleanup(() => rm(created, { recursive: true, force: true }))
  const root = await realpath(created)
  const path = join(root, 'auth.json')
  if (text !== undefined) await writeFile(path, text, { mode: 0o600 })
  return { root, path }
}

function input(
  path: string,
  overrides: Partial<NativeHostAuthWriteInput> = {},
): NativeHostAuthWriteInput {
  return {
    host: 'opencode',
    authPath: path,
    sourceDigest,
    expectedDigest: activationDigest,
    env: {},
    removePiAnthropicAuth: false,
    processFence: async () => {},
    ...overrides,
  }
}

async function bytes(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return undefined
    throw error
  }
}

async function stages(root: string) {
  return (await readdir(root)).filter(isNativeHostAuthWriteStagingName)
}

async function attempt(work: Promise<unknown>): Promise<unknown> {
  return work.then(
    (result) => result,
    (error: unknown) => error,
  )
}

function safeError(error: unknown, code: string, effect?: unknown) {
  expect(error).toMatchObject({ code, effect })
  expect(error).toBeInstanceOf(Error)
  expect(Object.hasOwn(error as object, 'cause')).toBe(false)
  expect(inspect(error, { showHidden: true })).not.toContain('synthetic-')
  expect(JSON.stringify(error)).not.toContain('synthetic-')
}

test('fresh snapshot preserves changed unrelated providers and dangerous own keys', async () => {
  const original = { anthropic: oauth, other: { key: 'synthetic-old' } }
  const { path, root } = await fixture(JSON.stringify(original))
  const captured = inspectNativeHostAuthEntry('opencode', original).digest
  const current = JSON.parse(
    `{"anthropic":${JSON.stringify(oauth)},"other":{"key":"synthetic-new"},"__proto__":{"polluted":true},"constructor":{"unknown":[1,null,"café"]},"unfamiliar":{"deep":{"enabled":true}}}`,
  )
  await writeFile(path, JSON.stringify(current))
  expect(inspectNativeHostAuthEntry('opencode', current).digest).toBe(captured)
  const result = await writeNativeHostAuth(
    input(path, { sourceDigest: captured }),
  )
  const actual = JSON.parse((await bytes(path))!)
  expect(actual).toEqual({
    ...current,
    anthropic: activation,
  })
  expect(Object.keys(actual).sort()).toEqual(Object.keys(current).sort())
  expect(Object.hasOwn(actual, '__proto__')).toBe(true)
  expect(Object.hasOwn(actual, 'constructor')).toBe(true)
  expect(actual.constructor).toEqual(current.constructor)
  expect(Object.hasOwn(Object.prototype, 'polluted')).toBe(false)
  expect(result).toEqual({ status: 'replaced' })
  expect(Object.isFrozen(result)).toBe(true)
  expect(JSON.stringify(result)).not.toContain('synthetic-')
  expect(await stages(root)).toEqual([])
})

test('missing OpenCode creates only the exact activation entry with mode 0600', async () => {
  const { path, root } = await fixture()
  expect(
    await writeNativeHostAuth(input(path, { sourceDigest: 'absent' })),
  ).toEqual({ status: 'created' })
  expect(JSON.parse((await bytes(path))!)).toEqual({ anthropic: activation })
  expect((await stat(path)).mode & 0o7777).toBe(0o600)
  expect(await stages(root)).toEqual([])
})

test('replacement preserves existing mode bits and unknown OAuth properties are fenced', async () => {
  const original = {
    anthropic: { ...oauth, extra: { labels: ['café', 1] } },
    other: false,
  }
  const { path } = await fixture(JSON.stringify(original))
  await chmod(path, 0o640)
  const digest = inspectNativeHostAuthEntry('opencode', original).digest
  expect(
    await writeNativeHostAuth(input(path, { sourceDigest: digest })),
  ).toEqual({ status: 'replaced' })
  expect((await stat(path)).mode & 0o7777).toBe(0o640)
  expect(JSON.parse((await bytes(path))!)).toEqual({
    anthropic: activation,
    other: false,
  })
})

test('stock OpenCode API and exact activation are byte-for-byte no-ops with E equal S', async () => {
  for (const entry of [
    { type: 'api', key: 'synthetic-key', unknown: 9 },
    activation,
  ]) {
    const text = `  { "other" : {"key":"synthetic-other"}, "anthropic": ${JSON.stringify(entry)} }\n`
    const { path, root } = await fixture(text)
    const before = await stat(path)
    const digest = inspectNativeHostAuthEntry('opencode', {
      anthropic: entry,
    }).digest
    let fences = 0
    const result = await writeNativeHostAuth(
      input(path, {
        sourceDigest: digest,
        expectedDigest: digest,
        processFence: async () => {
          fences++
        },
      }),
    )
    expect(await bytes(path)).toBe(text)
    expect((await stat(path)).ino).toBe(before.ino)
    expect(result).toEqual({ status: 'unchanged' })
    expect(fences).toBe(0)
    expect(await stages(root)).toEqual([])
    const refused = await attempt(
      writeNativeHostAuth(
        input(path, {
          sourceDigest: digest,
          expectedDigest: 'e'.repeat(64),
        }),
      ),
    )
    expect(await bytes(path)).toBe(text)
    safeError(refused, 'invalid-source')
  }
})

test('absent OpenCode entry preserves the complete current object when installing activation', async () => {
  const original = { other: { key: 'synthetic-other' }, metadata: [1, true] }
  const { path } = await fixture(JSON.stringify(original))
  await writeNativeHostAuth(input(path, { sourceDigest: 'absent' }))
  expect(JSON.parse((await bytes(path))!)).toEqual({
    ...original,
    anthropic: activation,
  })
})

test('source and expected digest mismatches refuse before any stage or provider changes', async () => {
  const text = JSON.stringify({
    anthropic: oauth,
    other: { key: 'synthetic-other' },
  })
  const { path, root } = await fixture(text)
  for (const overrides of [
    { sourceDigest: 'absent' },
    { sourceDigest: 'f'.repeat(64) },
    { expectedDigest: 'absent' },
    { expectedDigest: sourceDigest },
    { expectedDigest: 'f'.repeat(64) },
    ...[
      'a'.repeat(63),
      'A'.repeat(64),
      `${sourceDigest}\n`,
      'synthetic-key',
      '',
      null,
    ].flatMap((digest) => [
      { sourceDigest: digest as string },
      { expectedDigest: digest as string },
    ]),
  ]) {
    let fences = 0
    const error = await attempt(
      writeNativeHostAuth(
        input(path, {
          ...overrides,
          processFence: async () => {
            fences++
          },
        }),
      ),
    )
    expect(await bytes(path)).toBe(text)
    expect(await stages(root)).toEqual([])
    expect(fences).toBe(0)
    safeError(error, 'invalid-source')
  }
})

test('Pi consent refusal actively retains every target byte', async () => {
  const text = JSON.stringify({
    anthropic: oauth,
    other: { key: 'synthetic-other' },
  })
  const { path, root } = await fixture(text)
  const error = await attempt(
    writeNativeHostAuth(
      input(path, {
        host: 'pi',
        expectedDigest: 'absent',
        removePiAnthropicAuth: false,
      }),
    ),
  )
  expect(await bytes(path)).toBe(text)
  expect(await stages(root)).toEqual([])
  safeError(error, 'consent-required')
})

test('Pi removes all supported consented credential shapes without normalizing or importing them', async () => {
  for (const entry of [
    oauth,
    { type: 'api_key', key: 'synthetic-key' },
    { type: 'api_key', env: { ANTHROPIC_API_KEY: 'synthetic-env' } },
    { type: 'api_key' },
    { type: 'api_key', key: '', env: {} },
    activation,
  ]) {
    const original = JSON.parse(
      `{"anthropic":${JSON.stringify(entry)},"__proto__":{"polluted":true},"other":{"key":"synthetic-other"}}`,
    )
    const { path, root } = await fixture(JSON.stringify(original))
    const result = await writeNativeHostAuth(
      input(path, {
        host: 'pi',
        sourceDigest: inspectNativeHostAuthEntry('pi', original).digest,
        expectedDigest: 'absent',
        removePiAnthropicAuth: true,
      }),
    )
    delete original.anthropic
    expect(JSON.parse((await bytes(path))!)).toEqual(original)
    expect(result).toEqual({ status: 'removed', file: 'replaced' })
    expect(Object.hasOwn(Object.prototype, 'polluted')).toBe(false)
    expect(await stages(root)).toEqual([])
  }
})

test('Pi consent requires boolean true, not yes flags or truthy values', async () => {
  const text = JSON.stringify({ anthropic: { type: 'api_key' } })
  const { path } = await fixture(text)
  for (const consent of [undefined, false, 'yes', '--yes', 1, {}]) {
    const error = await attempt(
      writeNativeHostAuth(
        input(path, {
          host: 'pi',
          sourceDigest:
            '8bdbf2b15baae9ecfba096133446a79e4055f9adb8a307ee863d1bc8eb6873ab',
          expectedDigest: 'absent',
          removePiAnthropicAuth: consent as boolean,
        }),
      ),
    )
    expect(await bytes(path)).toBe(text)
    safeError(error, 'consent-required')
  }
})

test('Pi last-provider removal unlinks only after its mandatory fence and awaits afterUnlink', async () => {
  const { path, root } = await fixture(JSON.stringify({ anthropic: oauth }))
  const events: string[] = []
  const result = await writeNativeHostAuth(
    input(path, {
      host: 'pi',
      expectedDigest: 'absent',
      removePiAnthropicAuth: true,
      processFence: async () => {
        events.push('fence')
        expect(await bytes(path)).toBeDefined()
      },
    }),
    {
      beforeRecheck: async () => {
        events.push('recheck')
        expect(await stages(root)).toEqual([])
      },
      beforeRename: async () => {
        events.push('before')
      },
      afterUnlink: async () => {
        events.push('after')
        expect(await bytes(path)).toBeUndefined()
      },
      afterRename: async () => {
        throw new Error('wrong effect hook')
      },
    },
  )
  expect(result).toEqual({ status: 'removed', file: 'unlinked' })
  expect(events).toEqual(['recheck', 'before', 'fence', 'after'])
  expect(await bytes(path)).toBeUndefined()
})

test('Pi missing or absent entry does not create unlink or claim removal, even without consent', async () => {
  for (const text of [
    undefined,
    '{}',
    ' {"other":{"key":"synthetic-other"}}\n',
  ]) {
    const { path, root } = await fixture(text)
    let calls = 0
    const result = await writeNativeHostAuth(
      input(path, {
        host: 'pi',
        sourceDigest: 'absent',
        expectedDigest: 'absent',
        processFence: async () => {
          calls++
        },
      }),
      {
        beforeRecheck: async () => {
          calls++
        },
        afterUnlink: async () => {
          calls++
        },
      },
    )
    expect(await bytes(path)).toBe(text)
    expect(result).toEqual({ status: 'unchanged' })
    expect(calls).toBe(0)
    expect(await stages(root)).toEqual([])
  }
})

test('malformed and non-object files or invalid Anthropic entries refuse without changing other providers', async () => {
  for (const host of ['opencode', 'pi'] as const) {
    for (const text of [
      '',
      '{synthetic-malformed',
      'null',
      '[]',
      '1',
      '"synthetic-string"',
      ...[
        null,
        [],
        {},
        { type: 'unknown' },
        { ...oauth, expires: '0' },
        { ...activation, extra: true },
        { ...oauth, refresh: 'claustrum-tombstone:anything' },
        { type: 'api', key: 'claustrum-tombstone:anything' },
      ].map((entry) =>
        JSON.stringify({ other: { key: 'synthetic-other' }, anthropic: entry }),
      ),
    ]) {
      const { path, root } = await fixture(text)
      const error = await attempt(
        writeNativeHostAuth(
          input(path, {
            host,
            expectedDigest: host === 'pi' ? 'absent' : activationDigest,
          }),
        ),
      )
      expect(await bytes(path)).toBe(text)
      expect(await stages(root)).toEqual([])
      expect(error).toMatchObject({ code: 'invalid-source' })
      expect(inspect(error, { showHidden: true })).not.toContain('synthetic-')
    }
  }
})

test('unsafe symlink and directory leaves preserve their targets', async () => {
  const { path, root } = await fixture()
  const target = join(root, 'target.json')
  const text = JSON.stringify({ anthropic: oauth, other: true })
  await writeFile(target, text)
  await symlink(target, path)
  const linked = await attempt(writeNativeHostAuth(input(path)))
  expect(await bytes(target)).toBe(text)
  expect((await lstat(path)).isSymbolicLink()).toBe(true)
  safeError(linked, 'unsafe-source')
  await rm(path)
  await mkdir(path)
  const directory = await attempt(writeNativeHostAuth(input(path)))
  expect((await lstat(path)).isDirectory()).toBe(true)
  expect(await bytes(target)).toBe(text)
  safeError(directory, 'unsafe-source')
  expect(await stages(root)).toEqual([])
})

test('foreign ownership refuses with getuid available', async () => {
  const text = JSON.stringify({ anthropic: oauth })
  const { path } = await fixture(text)
  if (!process.getuid) return
  const uid = process.getuid()
  const getuid = spyOn(process, 'getuid').mockReturnValue(uid + 1)
  try {
    const error = await attempt(writeNativeHostAuth(input(path)))
    expect(await bytes(path)).toBe(text)
    safeError(error, 'unsafe-source')
  } finally {
    getuid.mockRestore()
  }
})

test('source I/O and size errors map to invalid-source without echoing raw input', async () => {
  const { path, root } = await fixture('{}')
  safeError(
    await attempt(writeNativeHostAuth(input(join(path, 'auth.json')))),
    'invalid-source',
  )
  const oversized = `{"padding":"${'x'.repeat(4 * 1024 * 1024)}"}`
  await writeFile(path, oversized)
  const error = await attempt(writeNativeHostAuth(input(path)))
  expect((await stat(path)).size).toBe(Buffer.byteLength(oversized))
  safeError(error, 'invalid-source')
  expect(await stages(root)).toEqual([])
})

test('supervised snapshot presence including empty string refuses with existing safe guidance', async () => {
  for (const content of [
    '',
    'synthetic-malformed',
    '{"key":"synthetic-snapshot"}',
  ]) {
    const text = JSON.stringify({ anthropic: oauth })
    const { path, root } = await fixture(text)
    const error = await attempt(
      writeNativeHostAuth(
        input(path, { env: { OPENCODE_AUTH_CONTENT: content } }),
      ),
    )
    expect(await bytes(path)).toBe(text)
    expect(await stages(root)).toEqual([])
    expect(error).toMatchObject({
      code: 'supervised-auth-snapshot',
      message:
        'Local login cannot be verified while OPENCODE_AUTH_CONTENT is set. Run setup without OPENCODE_AUTH_CONTENT in the environment.',
    })
    expect(inspect(error, { showHidden: true })).not.toContain('synthetic-')
  }
  const { path } = await fixture()
  const error = await attempt(
    writeNativeHostAuth(
      input(path, {
        sourceDigest: 'absent',
        env: { OPENCODE_AUTH_CONTENT: '' },
      }),
    ),
  )
  expect(await bytes(path)).toBeUndefined()
  expect(error).toMatchObject({ code: 'supervised-auth-snapshot' })
})

test('final snapshot recheck actively retains the changed unrelated provider bytes', async () => {
  const text = JSON.stringify({
    anthropic: oauth,
    other: { key: 'synthetic-original' },
  })
  const changed = JSON.stringify({
    anthropic: oauth,
    other: { key: 'synthetic-changed' },
  })
  const { path, root } = await fixture(text)
  let fences = 0
  const error = await attempt(
    writeNativeHostAuth(
      input(path, {
        processFence: async () => {
          fences++
        },
      }),
      {
        beforeRecheck: async () => {
          await writeFile(path, changed)
        },
      },
    ),
  )
  expect(await bytes(path)).toBe(changed)
  expect(await stages(root)).toEqual([])
  expect(fences).toBe(0)
  safeError(error, 'invalid-source')
})

test('continued absence recheck retains a newly appeared OpenCode file', async () => {
  const { path, root } = await fixture()
  const appeared = '{"other":{"key":"synthetic-appeared"}}'
  const error = await attempt(
    writeNativeHostAuth(input(path, { sourceDigest: 'absent' }), {
      beforeRecheck: async () => {
        await writeFile(path, appeared)
      },
    }),
  )
  expect(await bytes(path)).toBe(appeared)
  expect(await stages(root)).toEqual([])
  safeError(error, 'invalid-source')
})

test('Pi recheck refuses newly added providers before replacement or last-provider unlink', async () => {
  for (const other of [false, true]) {
    const { path, root } = await fixture(
      JSON.stringify({ anthropic: oauth, ...(other ? { other: 1 } : {}) }),
    )
    const changed = JSON.stringify({
      anthropic: oauth,
      other: 2,
      appeared: true,
    })
    const error = await attempt(
      writeNativeHostAuth(
        input(path, {
          host: 'pi',
          expectedDigest: 'absent',
          removePiAnthropicAuth: true,
        }),
        {
          beforeRecheck: async () => {
            await writeFile(path, changed)
          },
        },
      ),
    )
    expect(await bytes(path)).toBe(changed)
    expect(await stages(root)).toEqual([])
    safeError(error, 'invalid-source')
  }
})

test('recheck detects deletion byte-identical replacement and changed permissions', async () => {
  const text = JSON.stringify({ anthropic: oauth })
  for (const change of ['deletion', 'replacement', 'mode'] as const) {
    const { path, root } = await fixture(text)
    const error = await attempt(
      writeNativeHostAuth(input(path), {
        beforeRecheck: async () => {
          if (change === 'deletion') await rm(path)
          if (change === 'mode') await chmod(path, 0o640)
          if (change === 'replacement') {
            const replacement = join(root, 'replacement.json')
            await writeFile(replacement, text)
            await rename(replacement, path)
          }
        },
      }),
    )
    expect(await bytes(path)).toBe(change === 'deletion' ? undefined : text)
    if (change === 'mode') expect((await stat(path)).mode & 0o777).toBe(0o640)
    expect(await stages(root)).toEqual([])
    safeError(error, 'invalid-source')
  }
})

test('process fence refusal actively retains all target bytes and removes the owned stage', async () => {
  const text = JSON.stringify({ anthropic: oauth, other: true })
  const { path, root } = await fixture(text)
  const error = await attempt(
    writeNativeHostAuth(
      input(path, {
        processFence: async () => {
          throw new Error('synthetic-fence-secret')
        },
      }),
    ),
  )
  expect(await bytes(path)).toBe(text)
  expect(await stages(root)).toEqual([])
  safeError(error, 'process-fence-refused')
})

test('mandatory fence absence rejects and fence refusal also prevents creation and Pi unlink', async () => {
  for (const host of ['opencode', 'pi'] as const) {
    const text =
      host === 'pi' ? JSON.stringify({ anthropic: oauth }) : undefined
    const { path, root } = await fixture(text)
    const options = input(path, {
      host,
      sourceDigest: host === 'pi' ? sourceDigest : 'absent',
      expectedDigest: host === 'pi' ? 'absent' : activationDigest,
      removePiAnthropicAuth: true,
    })
    for (const processFence of [undefined, null, 1]) {
      const error = await attempt(
        writeNativeHostAuth({
          ...options,
          processFence:
            processFence as unknown as NativeHostAuthWriteInput['processFence'],
        }),
      )
      expect(await bytes(path)).toBe(text)
      safeError(error, 'invalid-source')
    }
    const error = await attempt(
      writeNativeHostAuth({
        ...options,
        processFence: async () => {
          throw 'synthetic-fence-secret'
        },
      }),
    )
    expect(await bytes(path)).toBe(text)
    expect(await stages(root)).toEqual([])
    safeError(error, 'process-fence-refused')
  }
})

test('captured input and hook identities cannot be redirected after a lifecycle barrier', async () => {
  const { path, root } = await fixture(JSON.stringify({ anthropic: oauth }))
  const otherPath = join(root, 'other-auth.json')
  const options = { ...input(path) }
  const paused = gate()
  const reached = gate()
  let fences = 0
  let after = 0
  options.processFence = async () => {
    fences++
  }
  const hooks: {
    -readonly [K in keyof NativeHostAuthWriteHooks]: NativeHostAuthWriteHooks[K]
  } = {
    beforeRecheck: async () => {
      reached.open()
      await paused.wait
    },
    afterRename: async () => {
      after++
    },
  }
  const writing = writeNativeHostAuth(options, hooks)
  trackDetached(writing)
  await reached.wait
  options.authPath = otherPath
  options.host = 'pi'
  options.sourceDigest = 'absent'
  options.expectedDigest = 'absent'
  options.removePiAnthropicAuth = true
  options.env.OPENCODE_AUTH_CONTENT = 'synthetic-snapshot'
  options.processFence = async () => {
    throw new Error('synthetic-mutated-fence')
  }
  hooks.afterRename = async () => {
    throw new Error('synthetic-mutated-hook')
  }
  paused.open()
  expect(await writing).toEqual({ status: 'replaced' })
  expect(await bytes(otherPath)).toBeUndefined()
  expect(JSON.parse((await bytes(path))!)).toEqual({ anthropic: activation })
  expect(fences).toBe(1)
  expect(after).toBe(1)
})

test('Pi consent is captured before the first await rather than adopted from mutable caller input', async () => {
  const text = JSON.stringify({ anthropic: oauth })
  const { path } = await fixture(text)
  const options = { ...input(path, { host: 'pi', expectedDigest: 'absent' }) }
  const writing = attempt(writeNativeHostAuth(options))
  options.removePiAnthropicAuth = true
  const error = await writing
  expect(await bytes(path)).toBe(text)
  safeError(error, 'consent-required')
})

test('replacement awaits lifecycle barriers and runs the process fence last', async () => {
  const { path, root } = await fixture(JSON.stringify({ anthropic: oauth }))
  const events: string[] = []
  const reached = gate()
  const resume = gate()
  let settled = false
  const writing = writeNativeHostAuth(
    input(path, {
      processFence: async () => {
        events.push('fence')
      },
    }),
    {
      beforeRecheck: async () => {
        events.push('recheck')
        expect(await stages(root)).toHaveLength(1)
      },
      beforeRename: async () => {
        events.push('before')
      },
      afterRename: async () => {
        events.push('after')
        reached.open()
        await resume.wait
      },
    },
  ).then((value) => {
    settled = true
    return value
  })
  trackDetached(writing)
  await reached.wait
  expect(settled).toBe(false)
  expect(JSON.parse((await bytes(path))!)).toEqual({ anthropic: activation })
  resume.open()
  expect(await writing).toEqual({ status: 'replaced' })
  expect(events).toEqual(['recheck', 'before', 'fence', 'after'])
})

test('throwing pre-effect hooks clean up stages without changing target bytes', async () => {
  for (const hook of ['beforeRecheck', 'beforeRename'] as const) {
    const text = JSON.stringify({ anthropic: oauth })
    const { path, root } = await fixture(text)
    const error = await attempt(
      writeNativeHostAuth(input(path), {
        [hook]: async () => {
          throw new Error('synthetic-hook-secret')
        },
      }),
    )
    expect(await bytes(path)).toBe(text)
    expect(await stages(root)).toEqual([])
    safeError(error, 'hook-failed')
  }
})

test('after-effect hook failures retain token-free replacement creation and removal provenance', async () => {
  for (const recipe of [
    'replaced',
    'created',
    'removed-replaced',
    'removed-unlinked',
  ] as const) {
    const removing = recipe.startsWith('removed')
    const original = {
      anthropic: oauth,
      ...(recipe === 'removed-replaced' ? { other: true } : {}),
    }
    const { path, root } = await fixture(
      recipe === 'created' ? undefined : JSON.stringify(original),
    )
    const fail = async () => {
      throw new Error('synthetic-after-effect-secret')
    }
    const error = await attempt(
      writeNativeHostAuth(
        input(path, {
          host: removing ? 'pi' : 'opencode',
          sourceDigest: recipe === 'created' ? 'absent' : sourceDigest,
          expectedDigest: removing ? 'absent' : activationDigest,
          removePiAnthropicAuth: true,
        }),
        { afterRename: fail, afterUnlink: fail },
      ),
    )
    if (recipe === 'removed-unlinked') expect(await bytes(path)).toBeUndefined()
    else
      expect(JSON.parse((await bytes(path))!)).toEqual(
        removing ? { other: true } : { anthropic: activation },
      )
    safeError(
      error,
      'hook-failed',
      removing
        ? {
            status: 'removed',
            file: recipe === 'removed-unlinked' ? 'unlinked' : 'replaced',
          }
        : { status: recipe },
    )
    expect(await stages(root)).toEqual([])
  }
})

test('stage collisions never delete another writer file and partial stages are cleaned', async () => {
  const text = JSON.stringify({ anthropic: oauth })
  const { path, root } = await fixture(text)
  const uuid = '11111111-2222-4333-8444-555555555555'
  const stage = join(root, `.native-host-auth-write.${uuid}.tmp`)
  await writeFile(stage, 'synthetic-other-writer')
  const random = spyOn(crypto, 'randomUUID').mockReturnValue(uuid)
  try {
    const error = await attempt(writeNativeHostAuth(input(path)))
    expect(await bytes(path)).toBe(text)
    expect(await bytes(stage)).toBe('synthetic-other-writer')
    safeError(error, 'write-io')
    await rm(stage)
    // Write incomplete JSON to the actual temporary file, then throw to test
    // cleanup after a failed write. Only writeFile is patched; the source reader
    // still uses its normal read calls.
    const handle = await open(path, 'r')
    const prototype: Pick<FileHandle, 'writeFile'> =
      Object.getPrototypeOf(handle)
    await handle.close()
    const originalWrite = prototype.writeFile
    const partialWrite = spyOn(prototype, 'writeFile').mockImplementation(
      async function (this: FileHandle) {
        await originalWrite.call(this, '{"partial":')
        throw new Error('synthetic-write-secret')
      },
    )
    let errorAfterOpen: unknown
    try {
      errorAfterOpen = await attempt(writeNativeHostAuth(input(path)))
    } finally {
      partialWrite.mockRestore()
    }
    expect(await bytes(path)).toBe(text)
    expect(await stages(root)).toEqual([])
    safeError(errorAfterOpen, 'write-io')
  } finally {
    random.mockRestore()
  }
})

test('stage-name predicate does not recognize arbitrary temp paths or sibling writers', () => {
  const own = '.native-host-auth-write.11111111-2222-4333-8444-555555555555.tmp'
  expect(isNativeHostAuthWriteStagingName(own)).toBe(true)
  for (const name of [
    'auth.json.tmp',
    '.native-runtime.111.tmp',
    `/tmp/${own}`,
    `${own}\n`,
    `${own}.bak`,
    own.replace('4333', '1333'),
    own.replace('8444', '7444'),
  ])
    expect(isNativeHostAuthWriteStagingName(name)).toBe(false)
})

test('the documented recheck-to-rename window is not a compare-and-swap guarantee', async () => {
  const { path } = await fixture(JSON.stringify({ anthropic: oauth }))
  const result = await writeNativeHostAuth(input(path), {
    beforeRename: async () => {
      await writeFile(
        path,
        JSON.stringify({ anthropic: oauth, lateProvider: true }),
      )
    },
  })
  expect(result).toEqual({ status: 'replaced' })
  expect(JSON.parse((await bytes(path))!)).toEqual({ anthropic: activation })
})

for (const recipe of [
  'replacement',
  'creation',
  'Pi-replacement',
  'Pi-unlink',
] as const) {
  for (const point of [
    'beforeRename',
    recipe === 'Pi-unlink' ? 'afterUnlink' : 'afterRename',
  ] as const) {
    test(`real child crash ${point} at ${recipe} leaves old or complete new authority bytes`, async () => {
      const removing = recipe.startsWith('Pi-')
      const original = {
        anthropic: oauth,
        ...(recipe === 'Pi-replacement' || recipe === 'replacement'
          ? { other: { key: 'synthetic-other' } }
          : {}),
      }
      const text = recipe === 'creation' ? undefined : JSON.stringify(original)
      const { path, root } = await fixture(text)
      const options = input(path, {
        host: removing ? 'pi' : 'opencode',
        sourceDigest: recipe === 'creation' ? 'absent' : sourceDigest,
        expectedDigest: removing ? 'absent' : activationDigest,
        removePiAnthropicAuth: true,
      })
      const { processFence: _fence, ...scalars } = options
      const writer = fileURLToPath(
        new URL('../native-host-auth-write.ts', import.meta.url),
      )
      const script = `import { writeNativeHostAuth } from ${JSON.stringify(writer)};
        await writeNativeHostAuth({ ...${JSON.stringify(scalars)}, processFence: async () => {} },
          { ${point}: async () => { process.exit(19) } }); process.exit(2);`
      const child = Bun.spawn([process.execPath, '--eval', script], {
        stdout: 'pipe',
        stderr: 'pipe',
      })
      // TestLifetime opens this gate before waiting for the test body, so teardown
      // can kill a child the body is still awaiting. Registering kill as a cleanup
      // would wait for the body to finish and deadlock.
      const cancellation = gate()
      let exited = false
      const exit = child.exited.then((value) => {
        exited = true
        return value
      })
      const stdout = new Response(child.stdout).text()
      const stderr = new Response(child.stderr).text()
      const cancelled = cancellation.wait.then(() => {
        if (!exited) child.kill()
      })
      for (const work of [exit, stdout, stderr, cancelled]) trackDetached(work)
      try {
        const [code, out, err] = await Promise.all([exit, stdout, stderr])
        const evidence = fileURLToPath(
          new URL(
            '../../../../node_modules/.cache/native-host-auth-write-evidence/',
            import.meta.url,
          ),
        )
        await mkdir(evidence, { recursive: true })
        const prefix = join(
          evidence,
          `child-${recipe}-${point}-${basename(root)}`,
        )
        await writeFile(
          `${prefix}.command.json`,
          JSON.stringify([process.execPath, '--eval', script]),
        )
        await writeFile(`${prefix}.stdout`, out)
        await writeFile(`${prefix}.stderr`, err)
        await writeFile(`${prefix}.exit`, `${code}\n`)
        expect(code, err).toBe(19)
        expect(out).toBe('')
        expect(err).toBe('')
      } finally {
        cancellation.open()
        // Join individual streams and process even after a fail-fast rejection.
        await Promise.allSettled([exit, stdout, stderr, cancelled])
      }
      if (point === 'beforeRename') expect(await bytes(path)).toBe(text)
      else if (recipe === 'Pi-unlink') expect(await bytes(path)).toBeUndefined()
      else
        expect(JSON.parse((await bytes(path))!)).toEqual(
          removing
            ? { other: { key: 'synthetic-other' } }
            : { ...original, anthropic: activation },
        )
      const abandoned = await stages(root)
      expect(abandoned).toHaveLength(
        point === 'beforeRename' && recipe !== 'Pi-unlink' ? 1 : 0,
      )
      // A child can leave temporary files behind without replacing auth.json.
      // Read only auth.json on resume and leave temporary files for cleanup that
      // recognizes this helper's filenames.
      const fresh = await bytes(path)
      const digest = inspectNativeHostAuthEntry(
        options.host,
        fresh === undefined ? undefined : JSON.parse(fresh),
      ).digest
      const resumed = await writeNativeHostAuth({
        ...options,
        sourceDigest: digest,
      })
      expect(resumed.status).toBe(
        point === 'beforeRename'
          ? removing
            ? 'removed'
            : recipe === 'creation'
              ? 'created'
              : 'replaced'
          : 'unchanged',
      )
      expect(await stages(root)).toEqual(abandoned)
    })
  }
}
