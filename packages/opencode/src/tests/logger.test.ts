import { describe, expect, test } from 'bun:test'
import {
  buildLoggingStatusSummary,
  executeLoggingCommand,
  formatLogLine,
  getLogLevel,
  isSecretKey,
  type LogLevel,
  parseLoggingCommandAction,
  parseLogLevel,
  redactPayload,
  setLogLevel,
  shouldEmit,
} from '@cortexkit/anthropic-auth-core'

// Save and restore log level before/after tests
let savedLevel: LogLevel

function saveLevel() {
  savedLevel = getLogLevel()
}

function restoreLevel() {
  setLogLevel(savedLevel)
}

// -- shouldEmit -----------------------------------------------------------

describe('shouldEmit', () => {
  test('info config: error/warn/info emit, debug/trace do not', () => {
    saveLevel()
    try {
      setLogLevel('info')
      expect(shouldEmit('error')).toBe(true)
      expect(shouldEmit('warn')).toBe(true)
      expect(shouldEmit('info')).toBe(true)
      expect(shouldEmit('debug')).toBe(false)
      expect(shouldEmit('trace')).toBe(false)
    } finally {
      restoreLevel()
    }
  })

  test('trace config: all levels emit', () => {
    saveLevel()
    try {
      setLogLevel('trace')
      expect(shouldEmit('error')).toBe(true)
      expect(shouldEmit('warn')).toBe(true)
      expect(shouldEmit('info')).toBe(true)
      expect(shouldEmit('debug')).toBe(true)
      expect(shouldEmit('trace')).toBe(true)
    } finally {
      restoreLevel()
    }
  })

  test('error config: only error emits', () => {
    saveLevel()
    try {
      setLogLevel('error')
      expect(shouldEmit('error')).toBe(true)
      expect(shouldEmit('warn')).toBe(false)
      expect(shouldEmit('info')).toBe(false)
      expect(shouldEmit('debug')).toBe(false)
      expect(shouldEmit('trace')).toBe(false)
    } finally {
      restoreLevel()
    }
  })

  test('warn config: error/warn emit, rest do not', () => {
    saveLevel()
    try {
      setLogLevel('warn')
      expect(shouldEmit('error')).toBe(true)
      expect(shouldEmit('warn')).toBe(true)
      expect(shouldEmit('info')).toBe(false)
      expect(shouldEmit('debug')).toBe(false)
      expect(shouldEmit('trace')).toBe(false)
    } finally {
      restoreLevel()
    }
  })

  test('debug config: error/warn/info/debug emit, trace does not', () => {
    saveLevel()
    try {
      setLogLevel('debug')
      expect(shouldEmit('error')).toBe(true)
      expect(shouldEmit('warn')).toBe(true)
      expect(shouldEmit('info')).toBe(true)
      expect(shouldEmit('debug')).toBe(true)
      expect(shouldEmit('trace')).toBe(false)
    } finally {
      restoreLevel()
    }
  })
})

// -- setLogLevel / getLogLevel roundtrip ----------------------------------

describe('setLogLevel / getLogLevel', () => {
  test('roundtrip', () => {
    saveLevel()
    try {
      setLogLevel('debug')
      expect(getLogLevel()).toBe('debug')
      setLogLevel('warn')
      expect(getLogLevel()).toBe('warn')
      setLogLevel('trace')
      expect(getLogLevel()).toBe('trace')
      setLogLevel('info')
      expect(getLogLevel()).toBe('info')
    } finally {
      restoreLevel()
    }
  })
})

// -- parseLogLevel ---------------------------------------------------------

describe('parseLogLevel', () => {
  test('valid levels', () => {
    expect(parseLogLevel('error')).toBe('error')
    expect(parseLogLevel('warn')).toBe('warn')
    expect(parseLogLevel('info')).toBe('info')
    expect(parseLogLevel('debug')).toBe('debug')
    expect(parseLogLevel('trace')).toBe('trace')
  })

  test('case insensitive + whitespace', () => {
    expect(parseLogLevel('ERROR')).toBe('error')
    expect(parseLogLevel('  debug  ')).toBe('debug')
    expect(parseLogLevel('Trace')).toBe('trace')
  })

  test('invalid returns null', () => {
    expect(parseLogLevel('verbose')).toBe(null)
    expect(parseLogLevel('')).toBe(null)
    expect(parseLogLevel(undefined)).toBe(null)
    expect(parseLogLevel('log')).toBe(null)
  })
})

// -- isSecretKey -----------------------------------------------------------

describe('isSecretKey', () => {
  test('exact matches (SECRET_KEY_EXACT)', () => {
    expect(isSecretKey('authorization')).toBe(true)
    expect(isSecretKey('Authorization')).toBe(true)
    expect(isSecretKey('x-api-key')).toBe(true)
    expect(isSecretKey('cookie')).toBe(true)
    expect(isSecretKey('set-cookie')).toBe(true)
    expect(isSecretKey('refresh')).toBe(true)
    expect(isSecretKey('access')).toBe(true)
    expect(isSecretKey('token')).toBe(true)
  })

  test('apikey variants', () => {
    expect(isSecretKey('apiKey')).toBe(true)
    expect(isSecretKey('api_key')).toBe(true)
    expect(isSecretKey('xApiKey')).toBe(true)
  })

  test('ends with secret/password', () => {
    expect(isSecretKey('clientSecret')).toBe(true)
    expect(isSecretKey('myPassword')).toBe(true)
    expect(isSecretKey('db_password')).toBe(true)
  })

  test('ends with token but not tokens', () => {
    expect(isSecretKey('accessToken')).toBe(true)
    expect(isSecretKey('refreshToken')).toBe(true)
    expect(isSecretKey('bearerToken')).toBe(true)
    expect(isSecretKey('relayToken')).toBe(true)
    // token COUNTS must NOT be redacted
    expect(isSecretKey('input_tokens')).toBe(false)
    expect(isSecretKey('cached_tokens')).toBe(false)
    expect(isSecretKey('output_tokens')).toBe(false)
    expect(isSecretKey('tokens')).toBe(false)
  })

  test('safe keys', () => {
    expect(isSecretKey('sessionKey')).toBe(false)
    expect(isSecretKey('cacheKey')).toBe(false)
    expect(isSecretKey('lastAccessAt')).toBe(false)
    expect(isSecretKey('accountId')).toBe(false)
    expect(isSecretKey('status')).toBe(false)
    expect(isSecretKey('mode')).toBe(false)
    expect(isSecretKey('level')).toBe(false)
    expect(isSecretKey('pid')).toBe(false)
  })
})

// -- redactPayload ---------------------------------------------------------

describe('redactPayload', () => {
  test('undefined payload returns undefined', () => {
    expect(redactPayload(undefined)).toBe(undefined)
  })

  test('empty payload returns undefined', () => {
    expect(redactPayload({})).toBe(undefined)
  })

  test('redacts known secret keys', () => {
    const result = redactPayload({
      accessToken: 'secret123',
      refreshToken: 'secret456',
      authorization: 'Bearer xyz',
    })
    expect(result?.accessToken).toBe('***REDACTED***')
    expect(result?.refreshToken).toBe('***REDACTED***')
    expect(result?.authorization).toBe('***REDACTED***')
  })

  test('redacts apiKey and api_key', () => {
    const result = redactPayload({ apiKey: 'abc', api_key: 'def' })
    expect(result?.apiKey).toBe('***REDACTED***')
    expect(result?.api_key).toBe('***REDACTED***')
  })

  test('redacts clientSecret', () => {
    const result = redactPayload({ clientSecret: 'secret' })
    expect(result?.clientSecret).toBe('***REDACTED***')
  })

  test('redacts value patterns under innocent keys', () => {
    const result = redactPayload({
      meta: 'Bearer sk-ant-api03-xxxxxxxxxxxxx',
      key: 'sk-ant-abc123',
      jwt: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
    })
    expect(result?.meta).toBe('***REDACTED***')
    expect(result?.key).toBe('***REDACTED***')
    expect(result?.jwt).toBe('***REDACTED***')
  })

  test('redacts custody handles by key and value', () => {
    const handle = `ckh_${'H'.repeat(43)}`
    const result = redactPayload({ handle, nested: { value: handle } })
    expect(result).toEqual({
      handle: '***REDACTED***',
      nested: { value: '***REDACTED***' },
    })
  })

  test('keeps safe keys unchanged', () => {
    const result = redactPayload({
      input_tokens: 500,
      cached_tokens: 100,
      output_tokens: 200,
      sessionKey: 'abc',
      cacheKey: 'def',
      lastAccessAt: 1234567890,
      accountId: 'acc-1',
      status: 'ok',
      mode: 'hybrid',
      level: 'info',
      pid: 12345,
    })
    expect(result?.input_tokens).toBe(500)
    expect(result?.cached_tokens).toBe(100)
    expect(result?.output_tokens).toBe(200)
    expect(result?.sessionKey).toBe('abc')
    expect(result?.cacheKey).toBe('def')
    expect(result?.lastAccessAt).toBe(1234567890)
    expect(result?.accountId).toBe('acc-1')
  })

  test('recurses into nested objects', () => {
    const result = redactPayload({
      outer: {
        nested: {
          accessToken: 'should-be-redacted',
        },
      },
    })
    const outer = result?.outer as Record<string, unknown>
    const nested = outer?.nested as Record<string, unknown>
    expect(nested?.accessToken).toBe('***REDACTED***')
  })

  test('recurses into arrays', () => {
    const result = redactPayload({
      items: [{ accessToken: 'redact-me' }, { name: 'safe' }],
    })
    const items = result?.items
    expect(Array.isArray(items)).toBe(true)
    const arr = (items as Array<Record<string, unknown>>)!
    expect(arr[0]!.accessToken).toBe('***REDACTED***')
    expect(arr[1]!.name).toBe('safe')
  })

  test('handles circular objects without throwing', () => {
    const circular: Record<string, unknown> = { a: 1 }
    circular.self = circular
    const result = redactPayload(circular)
    expect(result).not.toBe(undefined)
    expect(result?.a).toBe(1)
    expect(result?.self).toBe('[Circular]')
  })

  test('secret-key takes precedence over [Circular] marker', () => {
    const inner: Record<string, unknown> = {}
    inner.self = inner
    const payload = { token: inner }
    const result = redactPayload(payload)
    expect(result?.token).toBe('***REDACTED***')
  })

  test('handles array cycles', () => {
    const arr: unknown[] = []
    arr.push(arr)
    const result = redactPayload({ items: arr })
    const items = result?.items
    expect(Array.isArray(items)).toBe(true)
    expect((items as unknown[])[0]).toBe('[Circular]')
  })

  test('diamond object: shared ref in siblings serializes fully (not [Circular])', () => {
    const shared = { v: 1 }
    const result = redactPayload({ a: shared, b: shared })
    expect(result?.a).toEqual({ v: 1 })
    expect(result?.b).toEqual({ v: 1 })
    expect(result?.a).not.toBe('[Circular]')
    expect(result?.b).not.toBe('[Circular]')
  })

  test('diamond array: shared array in siblings serializes fully', () => {
    const shared = [1, 2]
    const result = redactPayload({ a: shared, b: shared })
    expect(result?.a).toEqual([1, 2])
    expect(result?.b).toEqual([1, 2])
    expect(result?.a).not.toBe('[Circular]')
    expect(result?.b).not.toBe('[Circular]')
  })

  test('circular still works (regression)', () => {
    const c: Record<string, unknown> = { x: 1 }
    c.self = c
    const result = redactPayload(c)
    expect(result?.x).toBe(1)
    expect(result?.self).toBe('[Circular]')
  })

  test('secret-key precedence over cyclic-or-shared objects', () => {
    const inner: Record<string, unknown> = {}
    inner.self = inner
    const payload = { token: inner }
    const result = redactPayload(payload)
    expect(result?.token).toBe('***REDACTED***')
  })
})

// -- formatLogLine ---------------------------------------------------------

describe('formatLogLine', () => {
  test('shape includes ISO8601 UTC timestamp, level, channel, message', () => {
    const line = formatLogLine('info', 'testchan', 'hello world')
    // [2026-06-18T...] INFO  [testchan] hello world {"pid":...}
    expect(line).toMatch(/^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\]/)
    expect(line).toContain('INFO ')
    expect(line).toContain('[testchan]')
    expect(line).toContain('hello world')
    expect(line).toContain('"pid"')
    expect(line).toContain(String(process.pid))
  })

  test('auto-injects pid into payload', () => {
    const line = formatLogLine('warn', 'auth', 'test', { accountId: 'acc-1' })
    expect(line).toContain('"accountId"')
    expect(line).toContain('"pid"')
    expect(line).toContain(String(process.pid))
  })

  test('includes pid even when no payload', () => {
    const line = formatLogLine('error', 'transport', 'connection lost')
    expect(line).toContain('"pid"')
    expect(line).toContain(String(process.pid))
  })

  test('redacts sensitive payload keys', () => {
    const line = formatLogLine('debug', 'auth', 'token check', {
      accessToken: 'secret123',
      accountId: 'acc-1',
    })
    expect(line).toContain('***REDACTED***')
    expect(line).not.toContain('secret123')
    expect(line).toContain('acc-1')
  })

  test('level is uppercase padded to 5', () => {
    const line = formatLogLine('warn', 'ch', 'msg')
    // "WARN " — 4 chars + 1 space = 5
    const match = line.match(/\] (WARN |ERROR|INFO |DEBUG|TRACE) \[/)
    expect(match).not.toBeNull()
    expect(match![1]!.length).toBe(5)
  })

  test('empty channel omits brackets segment', () => {
    const line = formatLogLine('info', '', 'no channel')
    // After the level, should go straight to message
    expect(line).toContain('INFO  no channel')
  })

  test('does not throw on circular payload', () => {
    const circular: Record<string, unknown> = { a: 1 }
    circular.self = circular
    const line = formatLogLine('info', 'test', 'circular msg', circular)
    expect(line.length).toBeGreaterThan(0)
    expect(line).toContain('[Circular]')
    expect(line).toContain('circular msg')
  })

  test('degrades BigInt payload to [unserializable] instead of throwing', () => {
    const line = formatLogLine('info', 'test', 'msg', {
      n: BigInt(10),
    } as Record<string, unknown>)
    expect(line.length).toBeGreaterThan(0)
    expect(line).toContain('[unserializable]')
    expect(line).toContain('msg')
    expect(line).toContain('"pid"')
  })

  test('degrades throwing-getter payload to [unserializable] instead of throwing', () => {
    const payload = {
      a: 1,
      get bad() {
        throw new Error('boom')
      },
    }
    const line = formatLogLine('info', 'test', 'msg', payload)
    expect(line.length).toBeGreaterThan(0)
    expect(line).toContain('[unserializable]')
    expect(line).toContain('msg')
    expect(line).toContain('"pid"')
  })
})

// -- parseLoggingCommandAction ----------------------------------------------

describe('parseLoggingCommandAction', () => {
  test('empty args returns status', () => {
    expect(parseLoggingCommandAction('')).toEqual({ type: 'status' })
    expect(parseLoggingCommandAction('  ')).toEqual({ type: 'status' })
  })

  test('valid levels', () => {
    expect(parseLoggingCommandAction('error')).toEqual({
      type: 'level',
      level: 'error',
    })
    expect(parseLoggingCommandAction('warn')).toEqual({
      type: 'level',
      level: 'warn',
    })
    expect(parseLoggingCommandAction('info')).toEqual({
      type: 'level',
      level: 'info',
    })
    expect(parseLoggingCommandAction('debug')).toEqual({
      type: 'level',
      level: 'debug',
    })
    expect(parseLoggingCommandAction('trace')).toEqual({
      type: 'level',
      level: 'trace',
    })
  })

  test('case insensitive', () => {
    expect(parseLoggingCommandAction('ERROR')).toEqual({
      type: 'level',
      level: 'error',
    })
    expect(parseLoggingCommandAction('Debug')).toEqual({
      type: 'level',
      level: 'debug',
    })
  })

  test('extra tokens return usage', () => {
    expect(parseLoggingCommandAction('error now')).toEqual({ type: 'usage' })
    expect(parseLoggingCommandAction('info please')).toEqual({ type: 'usage' })
  })

  test('unknown level returns usage', () => {
    expect(parseLoggingCommandAction('verbose')).toEqual({ type: 'usage' })
    expect(parseLoggingCommandAction('silent')).toEqual({ type: 'usage' })
  })
})

// -- executeLoggingCommand --------------------------------------------------

describe('executeLoggingCommand', () => {
  test('status shows current level', () => {
    const text = executeLoggingCommand({ argumentsText: '', level: 'debug' })
    expect(text).toContain('Claude Log Level')
    expect(text).toContain('debug')
  })

  test('set level returns updated text', () => {
    const text = executeLoggingCommand({
      argumentsText: 'trace',
      level: 'info',
    })
    expect(text).toContain('Claude Log Level Updated')
    expect(text).toContain('trace')
  })

  test('usage returns usage text', () => {
    const text = executeLoggingCommand({
      argumentsText: 'verbose',
      level: 'info',
    })
    expect(text).toContain('Usage')
  })
})

// -- buildLoggingStatusSummary ----------------------------------------------

describe('buildLoggingStatusSummary', () => {
  test('has status title and current level', () => {
    const text = buildLoggingStatusSummary({ level: 'warn' })
    expect(text).toContain('Claude Log Level')
    expect(text).toContain('warn')
  })

  test('defaults to info', () => {
    const text = buildLoggingStatusSummary()
    expect(text).toContain('info')
  })
})
