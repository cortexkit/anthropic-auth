import { describe, expect, test } from 'bun:test'
import {
  FABLE_FALLBACK_MODEL_ID,
  FABLE_FALLBACK_TURNS,
  FableFallbackManager,
} from '../fable-fallback'

function body(model = 'claude-fable-5') {
  return JSON.stringify({
    model,
    messages: [{ role: 'user', content: 'hello' }],
  })
}

describe('FableFallbackManager', () => {
  test('leaves Fable unchanged until its content filter activates a session', () => {
    const manager = new FableFallbackManager()
    const plan = manager.plan('session-a', body())

    expect(plan).toMatchObject({
      requestedModel: 'claude-fable-5',
      effectiveModel: 'claude-fable-5',
      downgraded: false,
    })
    expect(JSON.parse(plan!.bodyText).model).toBe('claude-fable-5')
  })

  test('routes the next ten successful Fable requests to Opus 4.8', () => {
    const manager = new FableFallbackManager()
    const filtered = manager.plan('session-a', body())!
    expect(manager.activate(filtered, 'fable-account')).toBe(
      FABLE_FALLBACK_TURNS,
    )

    for (
      let remaining = FABLE_FALLBACK_TURNS - 1;
      remaining >= 0;
      remaining--
    ) {
      const plan = manager.plan('session-a', body())!
      expect(plan.downgraded).toBe(true)
      expect(plan.effectiveModel).toBe(FABLE_FALLBACK_MODEL_ID)
      expect(plan.cacheAccountId).toBe('fable-account')
      expect(JSON.parse(plan.bodyText).model).toBe(FABLE_FALLBACK_MODEL_ID)
      expect(manager.complete(plan)).toEqual({ counted: true, remaining })
    }

    const restored = manager.plan('session-a', body())!
    expect(restored.downgraded).toBe(false)
    expect(JSON.parse(restored.bodyText).model).toBe('claude-fable-5')
  })

  test('rebinds an active recovery cycle when sticky routing must migrate accounts', () => {
    const manager = new FableFallbackManager()
    manager.activate(manager.plan('session-a', body())!, 'old-account')
    const lateOldRoute = manager.plan('session-a', body())!
    const migrated = manager.plan('session-a', body())!

    expect(manager.bindRecoveryAccount(migrated, 'new-account')).toBe(true)
    expect(migrated.cacheAccountId).toBe('new-account')
    expect(manager.recoveryAccount(lateOldRoute)).toBe('new-account')
    manager.complete(lateOldRoute, {
      fingerprint: 'old-account-anchor',
      messageIndex: 1,
      messageCount: 2,
      oauthAccountId: 'old-account',
    })
    expect(manager.plan('session-a', body())).toMatchObject({
      cacheAccountId: 'new-account',
      standbyCacheAnchor: undefined,
    })
  })

  test('retains the newest Opus cache anchor across a restored Fable period', () => {
    const manager = new FableFallbackManager()
    manager.activate(manager.plan('session-a', body())!)

    for (let index = 0; index < FABLE_FALLBACK_TURNS; index++) {
      const plan = manager.plan('session-a', body())!
      expect(
        manager.complete(plan, {
          fingerprint: `anchor-${index}`,
          messageIndex: 10 + index * 2,
          messageCount: 11 + index * 2,
          oauthAccountId: 'opus-account',
        }).counted,
      ).toBe(true)
    }

    const restored = manager.plan('session-a', body())!
    expect(restored).toMatchObject({
      downgraded: false,
      standbyCacheAnchor: {
        fingerprint: 'anchor-9',
        messageIndex: 28,
        messageCount: 29,
        oauthAccountId: 'opus-account',
      },
    })

    manager.activate(restored, 'fable-account')
    const nextCycle = manager.plan('session-a', body())!
    expect(nextCycle).toMatchObject({
      downgraded: true,
      cacheAccountId: 'fable-account',
      standbyCacheAnchor: restored.standbyCacheAnchor,
    })
  })

  test('does not replace a newer compacted standby anchor with an older concurrent response', () => {
    const manager = new FableFallbackManager()
    manager.activate(manager.plan('session-a', body())!)
    const older = manager.plan('session-a', body())!
    const newer = manager.plan('session-a', body())!

    manager.complete(newer, {
      fingerprint: 'newer',
      messageIndex: 4,
      messageCount: 5,
      oauthAccountId: 'main',
    })
    manager.complete(older, {
      fingerprint: 'older',
      messageIndex: 10,
      messageCount: 11,
      oauthAccountId: 'main',
    })

    expect(
      manager.plan('session-a', body())?.standbyCacheAnchor?.fingerprint,
    ).toBe('newer')
  })

  test('does not count failed attempts or duplicate completions', () => {
    const manager = new FableFallbackManager()
    manager.activate(manager.plan('session-a', body())!)
    const failed = manager.plan('session-a', body())!

    expect(manager.remaining('session-a')).toBe(10)
    expect(manager.complete(failed)).toEqual({ counted: true, remaining: 9 })
    expect(manager.complete(failed)).toEqual({ counted: false, remaining: 9 })
  })

  test('keeps downgrade state isolated by session and ignores other models', () => {
    const manager = new FableFallbackManager()
    manager.activate(manager.plan('session-a', body())!)

    expect(manager.plan('session-a', body())?.downgraded).toBe(true)
    expect(manager.plan('session-b', body())?.downgraded).toBe(false)
    expect(manager.plan('session-a', body('claude-opus-4-8'))).toBeNull()
    expect(manager.plan(undefined, body())).toBeNull()
  })

  test('a new filter cycle does not let an older Opus response decrement it', () => {
    const manager = new FableFallbackManager()
    const initial = manager.plan('session-a', body())!
    manager.activate(initial)
    const oldOpus = manager.plan('session-a', body())!

    // Simulate a later Fable probe being filtered again while an old Opus request
    // is still in flight.
    const probe = { ...initial }
    manager.activate(probe)

    expect(manager.complete(oldOpus)).toEqual({ counted: false, remaining: 10 })
  })

  test('routes dated Fable snapshot to Opus 4.8 after filter activation', () => {
    const manager = new FableFallbackManager()
    const datedModel = 'claude-fable-5-20260608'
    const filtered = manager.plan('session-a', body(datedModel))!
    expect(manager.activate(filtered, 'fable-account')).toBe(
      FABLE_FALLBACK_TURNS,
    )

    const plan = manager.plan('session-a', body(datedModel))!
    expect(plan.downgraded).toBe(true)
    expect(plan.requestedModel).toBe(datedModel)
    expect(plan.effectiveModel).toBe(FABLE_FALLBACK_MODEL_ID)
    expect(JSON.parse(plan.bodyText).model).toBe(FABLE_FALLBACK_MODEL_ID)
  })
})

describe('FableFallbackManager — Opus 5 recovery parity', () => {
  test('leaves Opus 5 unchanged until its content filter activates a session', () => {
    const manager = new FableFallbackManager()
    const plan = manager.plan('session-a', body('claude-opus-5'))

    expect(plan).toMatchObject({
      requestedModel: 'claude-opus-5',
      effectiveModel: 'claude-opus-5',
      downgraded: false,
    })
    expect(JSON.parse(plan!.bodyText).model).toBe('claude-opus-5')
  })

  test('matches the claude-opus-5-fast catalog variant', () => {
    const manager = new FableFallbackManager()
    const plan = manager.plan('session-a', body('claude-opus-5-fast'))

    expect(plan).toMatchObject({
      requestedModel: 'claude-opus-5-fast',
      effectiveModel: 'claude-opus-5-fast',
      downgraded: false,
    })
  })

  test('matches the dated claude-opus-5-20260701 snapshot', () => {
    const manager = new FableFallbackManager()
    const plan = manager.plan('session-a', body('claude-opus-5-20260701'))

    expect(plan).toMatchObject({
      requestedModel: 'claude-opus-5-20260701',
      effectiveModel: 'claude-opus-5-20260701',
      downgraded: false,
    })
  })

  test('routes the next ten successful Opus 5 requests to Opus 4.8', () => {
    const manager = new FableFallbackManager()
    const filtered = manager.plan('session-a', body('claude-opus-5'))!
    expect(manager.activate(filtered, 'opus5-account')).toBe(
      FABLE_FALLBACK_TURNS,
    )

    for (
      let remaining = FABLE_FALLBACK_TURNS - 1;
      remaining >= 0;
      remaining--
    ) {
      const plan = manager.plan('session-a', body('claude-opus-5'))!
      expect(plan.downgraded).toBe(true)
      expect(plan.requestedModel).toBe('claude-opus-5')
      expect(plan.effectiveModel).toBe(FABLE_FALLBACK_MODEL_ID)
      expect(plan.cacheAccountId).toBe('opus5-account')
      expect(JSON.parse(plan.bodyText).model).toBe(FABLE_FALLBACK_MODEL_ID)
      expect(manager.complete(plan)).toEqual({ counted: true, remaining })
    }

    const restored = manager.plan('session-a', body('claude-opus-5'))!
    expect(restored.downgraded).toBe(false)
    expect(restored.requestedModel).toBe('claude-opus-5')
    expect(JSON.parse(restored.bodyText).model).toBe('claude-opus-5')
  })

  test('keeps Opus 5 downgrade state isolated by session and ignores other models', () => {
    const manager = new FableFallbackManager()
    manager.activate(manager.plan('session-a', body('claude-opus-5'))!)

    expect(manager.plan('session-a', body('claude-opus-5'))?.downgraded).toBe(
      true,
    )
    expect(manager.plan('session-b', body('claude-opus-5'))?.downgraded).toBe(
      false,
    )
    expect(manager.plan('session-a', body('claude-opus-4-8'))).toBeNull()
    expect(manager.plan('session-a', body('claude-mythos-5'))).toBeNull()
    expect(manager.plan('session-a', body('claude-sonnet-5'))).toBeNull()
    expect(manager.plan(undefined, body('claude-opus-5'))).toBeNull()
  })

  test('rebinds an active Opus 5 recovery cycle when sticky routing migrates accounts', () => {
    const manager = new FableFallbackManager()
    manager.activate(manager.plan('session-a', body('claude-opus-5'))!, 'old')
    const lateOldRoute = manager.plan('session-a', body('claude-opus-5'))!
    const migrated = manager.plan('session-a', body('claude-opus-5'))!

    expect(manager.bindRecoveryAccount(migrated, 'new')).toBe(true)
    expect(migrated.cacheAccountId).toBe('new')
    expect(manager.recoveryAccount(lateOldRoute)).toBe('new')
  })

  test('retains the newest Opus 5 cache anchor across a restored period', () => {
    const manager = new FableFallbackManager()
    manager.activate(manager.plan('session-a', body('claude-opus-5'))!)

    for (let index = 0; index < FABLE_FALLBACK_TURNS; index++) {
      const plan = manager.plan('session-a', body('claude-opus-5'))!
      expect(
        manager.complete(plan, {
          fingerprint: `anchor-${index}`,
          messageIndex: 10 + index * 2,
          messageCount: 11 + index * 2,
          oauthAccountId: 'fallback-account',
        }).counted,
      ).toBe(true)
    }

    const restored = manager.plan('session-a', body('claude-opus-5'))!
    expect(restored).toMatchObject({
      downgraded: false,
      requestedModel: 'claude-opus-5',
      standbyCacheAnchor: {
        fingerprint: 'anchor-9',
        messageIndex: 28,
        messageCount: 29,
        oauthAccountId: 'fallback-account',
      },
    })

    manager.activate(restored, 'opus5-account')
    const nextCycle = manager.plan('session-a', body('claude-opus-5'))!
    expect(nextCycle).toMatchObject({
      downgraded: true,
      cacheAccountId: 'opus5-account',
      standbyCacheAnchor: restored.standbyCacheAnchor,
    })
  })

  test('Opus 5 recovery does not touch unrelated sessions', () => {
    const manager = new FableFallbackManager()
    manager.activate(manager.plan('session-a', body('claude-opus-5'))!)

    const otherSession = manager.plan('session-b', body('claude-opus-5'))
    expect(otherSession).toMatchObject({
      requestedModel: 'claude-opus-5',
      effectiveModel: 'claude-opus-5',
      downgraded: false,
    })
  })
})
