import { expect, test } from 'bun:test'
import {
  CacheKeepPrewarmError,
  classifyCacheKeepFailure,
} from '../cachekeep-failure.ts'
import { NativeAccountRefusal } from '../native-account-refusal.ts'
import { NativeCustodyError } from '../native-custody.ts'

test.each([
  ['AbortError', new DOMException('credential SECRET', 'AbortError')],
  ['TimeoutError', new DOMException('credential SECRET', 'TimeoutError')],
  ['TypeError', new TypeError('credential SECRET')],
  [
    'ECONNRESET',
    Object.assign(new Error('credential SECRET'), { code: 'ECONNRESET' }),
  ],
  [
    'EAI_AGAIN',
    new TypeError('credential SECRET', {
      cause: { code: 'EAI_AGAIN', message: 'SECRET' },
    }),
  ],
  ['UND_ERR_SOCKET', { code: 'UND_ERR_SOCKET', message: 'SECRET' }],
  ['unknown', { code: 'UND_ERR_SECRET', name: 'SECRET', message: 'SECRET' }],
  ['unknown', new Error('SECRET ECONNRESET AbortError')],
] as const)(
  'classified errors retain only the closed class %s',
  (failureClass, original) => {
    const error = new CacheKeepPrewarmError('send', original)
    expect(error).toMatchObject({ stage: 'send', class: failureClass })
    expect(classifyCacheKeepFailure(error, 'response')).toEqual({
      stage: 'send',
      class: failureClass,
    })
    expect(error.cause).toBeUndefined()
    expect(JSON.stringify(error)).not.toContain('SECRET')
    expect(error.message).not.toContain('SECRET')
    expect(error.stack).not.toContain('SECRET')
  },
)

test('native custody and policy reasons have an authorization stage and no native error text', () => {
  for (const [original, failureClass] of [
    [new NativeCustodyError('route-declined'), 'route-declined'],
    [new NativeAccountRefusal('account-policy'), 'account-policy'],
  ] as const) {
    original.message = 'SECRET native credential'
    const error = new CacheKeepPrewarmError('send', original)
    expect(error).toMatchObject({ stage: 'authorization', class: failureClass })
    expect(JSON.stringify(error)).not.toContain('SECRET')
    expect(error.message).not.toContain('SECRET')
  }
})

test('HTTP status wins over response read errors without copying provider body text', () => {
  const error = new CacheKeepPrewarmError(
    'response',
    new Error('SECRET provider body'),
    500,
  )
  expect(error).toMatchObject({ stage: 'response', class: 500 })
  expect(JSON.stringify(error)).not.toContain('SECRET')
  expect(error.message).not.toContain('SECRET')
})

test('unrecognized properties and throwing getters cannot escape the closed classifier', () => {
  const error = new CacheKeepPrewarmError('send', new Error('SECRET'))
  Object.assign(error, { class: 'SECRET', stage: 'SECRET' })
  expect(classifyCacheKeepFailure(error, 'send')).toEqual({
    stage: 'send',
    class: 'unknown',
  })
  expect(
    classifyCacheKeepFailure(
      {
        get name() {
          throw new Error('SECRET')
        },
      },
      'authorization',
    ),
  ).toEqual({ stage: 'authorization', class: 'unknown' })
})

test('an accessor cannot substitute credential text after its value was allowlisted', () => {
  for (const [key, first] of [
    ['name', 'AbortError'],
    ['code', 'ECONNRESET'],
  ] as const) {
    let reads = 0
    const original = Object.defineProperty({}, key, {
      get: () => (++reads === 1 ? first : 'SECRET credential'),
    })
    expect(classifyCacheKeepFailure(original, 'send')).toEqual({
      stage: 'send',
      class: first,
    })
    expect(reads).toBe(1)
  }
})
