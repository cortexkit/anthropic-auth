import { expect, spyOn, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { inspect } from 'node:util'

import {
  hasSupervisedAuthContentSnapshot,
  inspectNativeHostAuthEntry,
  NativeHostAuthError,
  requireNoSupervisedAuthContentSnapshot,
} from '../native-host-auth.ts'

// Hand-specified canonical bytes; hashes independently pinned with Node 24 SHA-256.
const fixtures = {
  oauth: {
    json: '{"access":"synthetic-access","expires":0,"refresh":"synthetic-refresh","type":"oauth"}',
    digest: 'b006e78a28dd6ba18131eb83536a8be9919c684befbd2b30ac57df97ff8d11ed',
  },
  api: {
    json: '{"key":"synthetic-key","type":"api"}',
    digest: 'a9c8e3e0cb3a568d6985e30789e259b055f50d3b25b3876a05c7102f38a3bb1e',
  },
  piKey: {
    json: '{"key":"synthetic-key","type":"api_key"}',
    digest: '87c7cf64e78976315d895b7a2a6dfd95099eeed46cead0d83da5cd3f700fb09d',
  },
  piEnv: {
    json: '{"env":{"ANTHROPIC_API_KEY":"synthetic-env","Z":"value"},"type":"api_key"}',
    digest: '4a1cd93e4d34540a04fed380a34ab15f342e4a92d6c7702a534257ca28ba1ace',
  },
  piType: {
    json: '{"type":"api_key"}',
    digest: '8bdbf2b15baae9ecfba096133446a79e4055f9adb8a307ee863d1bc8eb6873ab',
  },
  activation: {
    json: '{"access":"","expires":0,"refresh":"claustrum-tombstone:v1:anthropic","type":"oauth"}',
    digest: '34ff5181a0466836fec63f58d91bf4d04c46ec2090ab5ed3b6c554332c4bc669',
  },
  nested: {
    json: '{"access":"synthetic-access","expires":-7.5,"extra":{"10":"ten","2":"two","a":[3,{"a":null,"z":true}],"unicode":"café 💻"},"refresh":"synthetic-refresh","type":"oauth"}',
    digest: '49704b4f0b0024550fa91412d5f4a5a710df8d64ee1b39bd5b650457115340cb',
  },
  dangerous: {
    json: '{"__proto__":{"polluted":true},"constructor":"synthetic-constructor","key":"synthetic-key","toJSON":"synthetic-toJSON","type":"api"}',
    digest: 'f22bae7b3620eae7d6fdd07fa94b5cbd04e49b5cafc6bd168ee682245517e434',
  },
  piEmpty: {
    json: '{"env":{},"key":"","type":"api_key"}',
    digest: 'e7f0c8b0d69b3777414e3500086b1db9316c1113fb79728de019fbabb950865f',
  },
  array: {
    json: '{"items":[1,2],"key":"synthetic-key","type":"api"}',
    digest: '41c42c804e85878b9f4a773499aaa41d8059d2d21f461fb6f06c47c413f1bf2a',
  },
  reversed: {
    json: '{"items":[2,1],"key":"synthetic-key","type":"api"}',
    digest: 'a1d0ef591ad02417054d74cbf35f5fe591c28131f661d0764025ab59e41e31cf',
  },
  added: {
    json: '{"key":"synthetic-key","note":"alpha","type":"api"}',
    digest: 'be2927f31d021585aa2206661f177e2b0971ecff8ac80e003c592eb6eaf93c29',
  },
  changed: {
    json: '{"key":"synthetic-key","note":"beta","type":"api"}',
    digest: '6916a73e8b04b460ce8ebd0a1d064dc1d546ea4afffc6d85ddb28ee53c8bb965',
  },
  hidden: {
    json: '{"hidden":"synthetic-hidden","key":"synthetic-key","type":"api"}',
    digest: 'd73ad1b5f439f4b059813505a7829d5695bbe6a9a7e10f04498cd9da11c2c74a',
  },
} as const

const hosts = ['opencode', 'pi'] as const
const oauth = {
  type: 'oauth',
  access: 'synthetic-access',
  refresh: 'synthetic-refresh',
  expires: 0,
}
const api = { type: 'api', key: 'synthetic-key' }

function freezeJson<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const descriptor of Object.values(
      Object.getOwnPropertyDescriptors(value),
    ))
      if (Object.hasOwn(descriptor, 'value')) freezeJson(descriptor.value)
    Object.freeze(value)
  }
  return value
}

function caughtError(call: () => unknown): NativeHostAuthError {
  let caught: unknown
  try {
    call()
  } catch (error) {
    caught = error
  }
  expect(caught).toBeInstanceOf(NativeHostAuthError)
  return caught as NativeHostAuthError
}

function assertErrorMetadata(error: NativeHostAuthError): void {
  // Bun adds source-position properties to Error; none may hold credential data.
  const allowed = new Set([
    'code',
    'message',
    'name',
    'stack',
    'column',
    'line',
    'originalColumn',
    'originalLine',
    'sourceURL',
  ])
  for (const key of Reflect.ownKeys(error))
    expect(allowed.has(key as string)).toBe(true)
  expect(Object.hasOwn(error, 'cause')).toBe(false)
  expect(inspect(error, { showHidden: true })).not.toContain('synthetic-')
  expect(JSON.stringify(error)).not.toContain('synthetic-')
}

function invalid(host: 'opencode' | 'pi', hostAuth: unknown): void {
  const error = caughtError(() => inspectNativeHostAuthEntry(host, hostAuth))
  expect(error.name).toBe('NativeHostAuthError')
  expect(error.code).toBe('invalid-source')
  expect(error.message).toBe('Invalid native host auth source.')
  assertErrorMetadata(error)
}

function assertFixture(
  host: 'opencode' | 'pi',
  entry: unknown,
  fixture: keyof typeof fixtures,
  kind: 'oauth' | 'api' | 'api_key' | 'activation',
): void {
  const input = freezeJson({ anthropic: entry })
  const before = JSON.stringify(input)
  const result = inspectNativeHostAuthEntry(host, input)
  expect(result).toEqual({ kind, digest: fixtures[fixture].digest })
  expect(result.digest).toMatch(/^[0-9a-f]{64}$/)
  expect(Object.isFrozen(result)).toBe(true)
  expect(Reflect.ownKeys(result).sort()).toEqual(['digest', 'kind'])
  expect(Object.getPrototypeOf(result)).toBe(Object.prototype)
  for (const descriptor of Object.values(
    Object.getOwnPropertyDescriptors(result),
  )) {
    expect(Object.hasOwn(descriptor, 'value')).toBe(true)
    expect(descriptor.writable).toBe(false)
    expect(descriptor.configurable).toBe(false)
    expect(descriptor.enumerable).toBe(true)
  }
  expect(JSON.stringify(result)).not.toContain('synthetic-')
  expect(inspect(result, { showHidden: true })).not.toContain('synthetic-')
  expect(() => Object.assign(result, { kind: 'absent' })).toThrow(TypeError)
  expect(JSON.stringify(input)).toBe(before)
}

test('independent canonical byte fixtures retain their pinned SHA-256 hashes', () => {
  for (const fixture of Object.values(fixtures))
    expect(
      createHash('sha256').update(fixture.json, 'utf8').digest('hex'),
    ).toBe(fixture.digest)
})

test('missing file and own entry are frozen absent results, not malformed fallbacks', () => {
  for (const host of hosts) {
    for (const source of [
      undefined,
      {},
      { other: { key: 'synthetic-other' } },
      Object.create(null),
    ]) {
      const input = freezeJson(source)
      const result = inspectNativeHostAuthEntry(host, input)
      expect(result).toEqual({ kind: 'absent', digest: 'absent' })
      expect(Object.isFrozen(result)).toBe(true)
      expect(Reflect.ownKeys(result).sort()).toEqual(['digest', 'kind'])
    }
    invalid(host, { anthropic: undefined })
  }
})

test('host-specific credential variants include Pi key-only, env-only and type-only', () => {
  for (const host of hosts) assertFixture(host, oauth, 'oauth', 'oauth')
  assertFixture('opencode', api, 'api', 'api')
  assertFixture(
    'pi',
    { type: 'api_key', key: 'synthetic-key' },
    'piKey',
    'api_key',
  )
  assertFixture(
    'pi',
    {
      type: 'api_key',
      env: { Z: 'value', ANTHROPIC_API_KEY: 'synthetic-env' },
    },
    'piEnv',
    'api_key',
  )
  assertFixture('pi', { type: 'api_key' }, 'piType', 'api_key')
  assertFixture(
    'pi',
    { type: 'api_key', key: '', env: {} },
    'piEmpty',
    'api_key',
  )
  assertFixture(
    'pi',
    {
      type: 'api_key',
      env: Object.assign(Object.create(null), {
        ANTHROPIC_API_KEY: 'synthetic-env',
        Z: 'value',
      }),
    },
    'piEnv',
    'api_key',
  )
  invalid('opencode', { anthropic: { type: 'api_key', key: 'synthetic-key' } })
  invalid('pi', { anthropic: api })
})

test('OAuth declarations permit empty strings and finite past or very large expiries', () => {
  for (const host of hosts) {
    for (const expires of [0, -1.5, Number.MAX_VALUE]) {
      const input = freezeJson({
        anthropic: { type: 'oauth', access: '', refresh: '', expires },
      })
      expect(inspectNativeHostAuthEntry(host, input).kind).toBe('oauth')
    }
  }
  expect(
    inspectNativeHostAuthEntry('opencode', {
      anthropic: { type: 'api', key: '' },
    }).kind,
  ).toBe('api')
})

test('canonical digest sorts nested keys including numeric keys and preserves Unicode', () => {
  const entry = {
    type: 'oauth',
    refresh: 'synthetic-refresh',
    expires: -7.5,
    extra: {
      unicode: 'café 💻',
      '2': 'two',
      a: [3, { z: true, a: null }],
      '10': 'ten',
    },
    access: 'synthetic-access',
  }
  for (const host of hosts) {
    assertFixture(host, entry, 'nested', 'oauth')
    assertFixture(host, JSON.parse(fixtures.nested.json), 'nested', 'oauth')
  }
})

test('digest covers added and changed own entry properties', () => {
  const initial = inspectNativeHostAuthEntry(
    'opencode',
    freezeJson({ anthropic: { ...api } }),
  )
  const added = inspectNativeHostAuthEntry(
    'opencode',
    freezeJson({ anthropic: { ...api, note: 'alpha' } }),
  )
  const changed = inspectNativeHostAuthEntry(
    'opencode',
    freezeJson({ anthropic: { ...api, note: 'beta' } }),
  )
  expect(initial.digest).toBe(fixtures.api.digest)
  expect(added.digest).toBe(fixtures.added.digest)
  expect(changed.digest).toBe(fixtures.changed.digest)
  expect(added.digest).not.toBe(initial.digest)
  expect(changed.digest).not.toBe(added.digest)
})

test('unrelated provider and root metadata changes leave the entry digest unchanged', () => {
  const sources = [
    { anthropic: oauth, other: { key: 'synthetic-other-one' }, metadata: 1 },
    {
      metadata: { extra: ['different'] },
      other: { key: 'synthetic-other-two' },
      anthropic: oauth,
    },
    { anthropic: oauth },
  ]
  for (const source of sources) {
    const before = JSON.stringify(source)
    expect(
      inspectNativeHostAuthEntry('opencode', freezeJson(source)).digest,
    ).toBe(fixtures.oauth.digest)
    expect(JSON.stringify(source)).toBe(before)
  }
})

test('array order changes the complete entry digest', () => {
  assertFixture('opencode', { ...api, items: [1, 2] }, 'array', 'api')
  assertFixture('opencode', { ...api, items: [2, 1] }, 'reversed', 'api')
  expect(fixtures.array.digest as string).not.toBe(fixtures.reversed.digest)
})

test('dangerous own keys remain JSON data without prototype pollution or toJSON calls', () => {
  const entry = JSON.parse(fixtures.dangerous.json)
  assertFixture('opencode', entry, 'dangerous', 'api')
  const nullEntry = Object.assign(Object.create(null), entry)
  const root = Object.assign(Object.create(null), { anthropic: nullEntry })
  expect(inspectNativeHostAuthEntry('opencode', freezeJson(root)).digest).toBe(
    fixtures.dangerous.digest,
  )
  expect(Object.getPrototypeOf(entry)).toBe(Object.prototype)
  expect(Object.hasOwn(Object.prototype, 'polluted')).toBe(false)
  let toJSONCalls = 0
  invalid('opencode', {
    anthropic: {
      ...api,
      toJSON: () => {
        toJSONCalls++
        return {}
      },
    },
  })
  expect(toJSONCalls).toBe(0)
})

test('non-enumerable own JSON data is fenced without being returned as hidden material', () => {
  const entry = { ...api }
  Object.defineProperty(entry, 'hidden', { value: 'synthetic-hidden' })
  assertFixture('opencode', entry, 'hidden', 'api')
  invalid('opencode', {
    anthropic: Object.defineProperty({ ...api }, 'hidden', {
      value: undefined,
    }),
  })
})

test('exact four-property tombstone is activation on both hosts, never OAuth', () => {
  const entry = JSON.parse(fixtures.activation.json)
  for (const host of hosts)
    assertFixture(host, entry, 'activation', 'activation')
})

test('placeholder-like OAuth entries refuse beyond the exact activation shape', () => {
  const entry = JSON.parse(fixtures.activation.json)
  const malformed = [
    { ...entry, refresh: 'claustrum-tombstone:v1:other' },
    { ...entry, access: 'synthetic-nonempty' },
    { ...entry, expires: 1 },
    { ...entry, extra: null },
    { ...entry, refresh: 'claustrum-tombstone:' },
    { ...entry, refresh: 'claustrum-tombstone:v2:anthropic' },
    { ...entry, refresh: 'claustrum-tombstone:any-other-form' },
  ]
  for (const host of hosts)
    for (const candidate of malformed)
      invalid(host, freezeJson({ anthropic: candidate }))
})

test('broad placeholder prefix refuses access, refresh and key on every credential shape', () => {
  const shapes = [
    { host: 'opencode' as const, entry: oauth },
    { host: 'pi' as const, entry: oauth },
    { host: 'opencode' as const, entry: api },
    { host: 'pi' as const, entry: { type: 'api_key' } },
  ]
  for (const { host, entry } of shapes) {
    for (const field of ['access', 'refresh', 'key'])
      for (const value of [
        'claustrum-tombstone:',
        'claustrum-tombstone:v1:anthropic',
        'claustrum-tombstone:alternative',
      ])
        invalid(host, freezeJson({ anthropic: { ...entry, [field]: value } }))
  }
})

test('malformed roots and entry frames refuse with fixed token-free errors', () => {
  for (const host of hosts) {
    for (const root of [
      null,
      [],
      'synthetic-root',
      0,
      false,
      () => {},
      new Date(0),
      new Map(),
      Object.setPrototypeOf([], null),
    ])
      invalid(host, root)
    for (const entry of [
      null,
      undefined,
      [],
      'synthetic-entry',
      0,
      true,
      {},
      { type: 'unknown-synthetic-type' },
      new Date(0),
    ])
      invalid(host, { anthropic: entry })
  }
  for (const host of [undefined, null, 'unknown', 'PI', 0]) {
    const error = caughtError(() =>
      inspectNativeHostAuthEntry(host as 'pi', undefined),
    )
    expect(error.code).toBe('invalid-source')
    expect(error.message).toBe('Invalid native host auth source.')
  }
})

test('required OAuth fields are own declarations and have exact JSON types', () => {
  for (const host of hosts) {
    for (const field of ['type', 'access', 'refresh', 'expires']) {
      const missing: Record<string, unknown> = { ...oauth }
      delete missing[field]
      invalid(host, { anthropic: missing })
      invalid(host, {
        anthropic: Object.assign(
          Object.create({ [field]: oauth[field as keyof typeof oauth] }),
          missing,
        ),
      })
      for (const value of [
        undefined,
        null,
        {},
        [],
        false,
        field === 'expires' ? '0' : 1,
      ])
        invalid(host, { anthropic: { ...oauth, [field]: value } })
    }
    for (const expires of [NaN, Infinity, -Infinity])
      invalid(host, { anthropic: { ...oauth, expires } })
    invalid(host, Object.create({ anthropic: oauth }))
  }
})

test('OpenCode requires an own string key and Pi rejects malformed present optional fields', () => {
  invalid('opencode', { anthropic: { type: 'api' } })
  invalid('opencode', {
    anthropic: Object.assign(Object.create({ key: 'synthetic-inherited' }), {
      type: 'api',
    }),
  })
  for (const key of [undefined, null, false, 1, [], {}]) {
    invalid('opencode', { anthropic: { type: 'api', key } })
    invalid('pi', { anthropic: { type: 'api_key', key } })
  }
  for (const env of [
    undefined,
    null,
    [],
    'synthetic-env',
    1,
    false,
    new Date(0),
    { KEY: null },
    { KEY: 1 },
    { KEY: {} },
  ])
    invalid('pi', { anthropic: { type: 'api_key', env } })
  invalid('pi', {
    anthropic: {
      type: 'api_key',
      env: Object.create({ KEY: 'synthetic-inherited' }),
    },
  })
})

test('unsupported nested JSON values and cycles refuse, shared acyclic data is allowed', () => {
  for (const extra of [
    undefined,
    NaN,
    Infinity,
    -Infinity,
    1n,
    Symbol('synthetic-symbol'),
    () => {},
    new Date(0),
    new Map(),
    new Set(),
    new Uint8Array([1]),
  ])
    invalid('opencode', { anthropic: { ...api, extra: { nested: extra } } })
  const cyclic: Record<string, unknown> = { ...api }
  cyclic.self = cyclic
  invalid('opencode', { anthropic: cyclic })
  const arrayCycle: unknown[] = []
  arrayCycle.push(arrayCycle)
  invalid('opencode', { anthropic: { ...api, extra: arrayCycle } })
  const shared = freezeJson({ x: true })
  expect(
    inspectNativeHostAuthEntry('opencode', {
      anthropic: { ...api, a: shared, b: shared },
    }).kind,
  ).toBe('api')
})

test('sparse arrays and extra array properties refuse instead of losing own data', () => {
  const sparse = new Array(1)
  const extra = Object.assign([1], { hidden: true })
  const hidden = Object.defineProperty([1], 'hidden', { value: true })
  const undefinedElement = [undefined]
  for (const items of [sparse, extra, hidden, undefinedElement])
    invalid('opencode', { anthropic: { ...api, items } })
})

test('symbols, accessors and reflective failures refuse without getter execution or raw causes', () => {
  let getterCalls = 0
  const getter = {
    get: () => {
      getterCalls++
      throw new Error('synthetic-getter-secret')
    },
  }
  const rootGetter = Object.defineProperty({}, 'anthropic', getter)
  const fieldGetter = Object.defineProperty({ ...api }, 'key', getter)
  const nestedGetter = Object.defineProperty({}, 'extra', getter)
  const envGetter = Object.defineProperty({}, 'KEY', getter)
  const arrayGetter = Object.defineProperty([1], '0', getter)
  for (const root of [
    rootGetter,
    { anthropic: fieldGetter },
    { anthropic: { ...api, nested: nestedGetter } },
    { anthropic: { type: 'api_key', env: envGetter } },
    { anthropic: { ...api, array: arrayGetter } },
    { anthropic: api, [Symbol('synthetic-root-symbol')]: true },
    { anthropic: { ...api, [Symbol('synthetic-entry-symbol')]: true } },
    {
      anthropic: {
        ...api,
        nested: { [Symbol('synthetic-nested-symbol')]: true },
      },
    },
    {
      anthropic: {
        ...api,
        nested: Object.assign([1], {
          [Symbol('synthetic-array-symbol')]: true,
        }),
      },
    },
    new Proxy(
      {},
      {
        ownKeys: () => {
          throw new Error('synthetic-reflect-secret')
        },
      },
    ),
  ])
    invalid('opencode', root)
  invalid('pi', { anthropic: { type: 'api_key', env: envGetter } })
  expect(getterCalls).toBe(0)
})

test('snapshot absence passes using only the explicit environment argument', () => {
  for (const env of [
    freezeJson({}),
    freezeJson({ OPENCODE_AUTH_CONTENT: undefined }),
  ]) {
    expect(hasSupervisedAuthContentSnapshot(env)).toBe(false)
    expect(requireNoSupervisedAuthContentSnapshot(env)).toBeUndefined()
  }
})

test('snapshot presence refuses empty, malformed, null-text and ordinary content without parsing', () => {
  const parse = spyOn(JSON, 'parse').mockImplementation(() => {
    throw new Error('Unexpected parsing')
  })
  try {
    for (const content of [
      '',
      '{synthetic-malformed',
      'null',
      '{"anthropic":{"key":"synthetic-snapshot"}}',
    ]) {
      const env = freezeJson({ OPENCODE_AUTH_CONTENT: content })
      expect(hasSupervisedAuthContentSnapshot(env)).toBe(true)
      const error = caughtError(() =>
        requireNoSupervisedAuthContentSnapshot(env),
      )
      expect(error.code).toBe('supervised-auth-snapshot')
      expect(error.message).toBe(
        'Local login cannot be verified while OPENCODE_AUTH_CONTENT is set. Run setup without OPENCODE_AUTH_CONTENT in the environment.',
      )
      assertErrorMetadata(error)
    }
    expect(parse).not.toHaveBeenCalled()
  } finally {
    parse.mockRestore()
  }
})

test('pure calls do not read clocks, use HTTP, log inputs or inspect snapshot values', () => {
  const fail = () => {
    throw new Error('Unexpected impure call')
  }
  const spies = [
    spyOn(Date, 'now').mockImplementation(fail),
    spyOn(performance, 'now').mockImplementation(fail),
    spyOn(globalThis, 'fetch').mockImplementation(
      Object.assign(fail, { preconnect: fail }),
    ),
    spyOn(console, 'log').mockImplementation(fail),
    spyOn(console, 'warn').mockImplementation(fail),
    spyOn(console, 'error').mockImplementation(fail),
    spyOn(console, 'info').mockImplementation(fail),
    spyOn(console, 'debug').mockImplementation(fail),
  ]
  let reads = 0
  const env = new Proxy(
    { OPENCODE_AUTH_CONTENT: 'synthetic-snapshot' },
    {
      get: (target, key) => {
        expect(key).toBe('OPENCODE_AUTH_CONTENT')
        reads++
        return target.OPENCODE_AUTH_CONTENT
      },
      ownKeys: fail,
    },
  )
  try {
    for (const host of hosts) {
      expect(
        inspectNativeHostAuthEntry(host, freezeJson({ anthropic: oauth })).kind,
      ).toBe('oauth')
      invalid(host, { anthropic: null })
    }
    expect(hasSupervisedAuthContentSnapshot(env)).toBe(true)
    expect(
      caughtError(() => requireNoSupervisedAuthContentSnapshot(env)).code,
    ).toBe('supervised-auth-snapshot')
    expect(reads).toBe(2)
    for (const spy of spies) expect(spy).not.toHaveBeenCalled()
  } finally {
    for (const spy of spies) spy.mockRestore()
  }
})
