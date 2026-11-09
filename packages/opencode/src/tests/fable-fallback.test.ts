import { describe, expect, test } from 'bun:test'
import {
  FABLE_FALLBACK_MODEL_ID,
  FABLE_FALLBACK_TURNS,
  FableFallbackManager,
  type FableSourceWarmInit,
  parseSourceWarmTargetId,
  recoverableRefusalFamily,
  sourceWarmTargetId,
} from '../fable-fallback'
import { createStrippedStream } from '../transform'

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

  test('recognizes OpenCode 1m-qualified recoverable model ids', () => {
    const manager = new FableFallbackManager()
    for (const model of [
      'claude-fable-5[1m]',
      'claude-fable-5-1[1m]',
      'claude-opus-5[1m]',
    ]) {
      const plan = manager.plan(`session-${model}`, body(model))
      expect(plan?.requestedModel).toBe(model)
      expect(plan?.downgraded).toBe(false)
      expect(manager.activate(plan!)).toBe(FABLE_FALLBACK_TURNS)
    }
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

  test('keeps a recovery alive when its in-flight plan is touched before capacity pruning', () => {
    const manager = new FableFallbackManager()
    for (let index = 0; index < 128; index++) {
      manager.activate(manager.plan(`session-${index}`, body())!)
    }

    // plan() LRU-touches the recovery before returning the downgraded request.
    const inFlight = manager.plan('session-0', body())!
    expect(inFlight.downgraded).toBe(true)
    manager.activate(manager.plan('session-128', body())!)

    expect(manager.complete(inFlight)).toEqual({ counted: true, remaining: 9 })
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

    expect(manager.remaining(failed)).toBe(10)
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

  test('tracks Fable and Opus 5 recovery independently in the same session', () => {
    const manager = new FableFallbackManager()
    const fable = manager.plan('session-a', body('claude-fable-5'))!
    manager.activate(fable, 'fable-account')

    const healthyOpus = manager.plan('session-a', body('claude-opus-5'))!
    expect(healthyOpus).toMatchObject({
      requestedModel: 'claude-opus-5',
      effectiveModel: 'claude-opus-5',
      downgraded: false,
    })
    expect(JSON.parse(healthyOpus.bodyText).model).toBe('claude-opus-5')

    manager.activate(healthyOpus, 'opus-account')
    const downgradedFable = manager.plan('session-a', body('claude-fable-5'))!
    const downgradedOpus = manager.plan('session-a', body('claude-opus-5'))!

    expect(downgradedFable).toMatchObject({
      requestedModel: 'claude-fable-5',
      effectiveModel: FABLE_FALLBACK_MODEL_ID,
      cacheAccountId: 'fable-account',
      downgraded: true,
    })
    expect(downgradedOpus).toMatchObject({
      requestedModel: 'claude-opus-5',
      effectiveModel: FABLE_FALLBACK_MODEL_ID,
      cacheAccountId: 'opus-account',
      downgraded: true,
    })
    expect(downgradedFable.cycle).not.toBe(downgradedOpus.cycle)
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

    expect(manager.complete(oldOpus)).toEqual({ counted: false, remaining: 20 })
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

  test('keeps Fable 5.1 recovery state independent from Fable 5', () => {
    const manager = new FableFallbackManager()
    const fable5 = manager.plan('session-a', body('claude-fable-5'))!
    manager.activate(fable5, 'fable5-account')

    const fable51 = manager.plan('session-a', body('claude-fable-5-1'))!
    expect(fable51).toMatchObject({
      requestedModel: 'claude-fable-5-1',
      effectiveModel: 'claude-fable-5-1',
      downgraded: false,
    })
    manager.activate(fable51, 'fable51-account')

    const fable5Recovery = manager.plan('session-a', body('claude-fable-5'))!
    const fable51Recovery = manager.plan('session-a', body('claude-fable-5-1'))!
    expect(fable5Recovery.downgraded).toBe(true)
    expect(fable51Recovery.downgraded).toBe(true)
    expect(fable5Recovery.cycle).not.toBe(fable51Recovery.cycle)
    expect(fable5Recovery.cacheAccountId).toBe('fable5-account')
    expect(fable51Recovery.cacheAccountId).toBe('fable51-account')
  })
})

describe('refusal recovery backoff', () => {
  function finishRound(manager: FableFallbackManager, responses: number) {
    for (let index = 0; index < responses; index++) {
      const plan = manager.plan('session-a', body('claude-opus-5-5'))!
      expect(plan.downgraded).toBe(true)
      expect(manager.complete(plan)).toEqual({
        counted: true,
        remaining: responses - index - 1,
      })
    }
    expect(manager.plan('session-a', body('claude-opus-5-5'))?.downgraded).toBe(
      false,
    )
  }

  test('backs off source attempts after 10, 20, then 40 completed responses', () => {
    const manager = new FableFallbackManager()
    for (const responses of [10, 20, 40]) {
      const source = manager.plan('session-a', body('claude-opus-5-5'))!
      expect(manager.activate(source, 'account')).toBe(responses)
      finishRound(manager, responses)
      // Successful source tool responses do not clear the refusal history.
      for (let index = 0; index < 2; index++) {
        const sourceToolResponse = manager.plan(
          'session-a',
          body('claude-opus-5-5'),
        )!
        expect(sourceToolResponse.downgraded).toBe(false)
        expect(manager.completeSource(sourceToolResponse)).toBe(true)
      }
    }
  })

  test('caps every further recovery round at 40 and always retries the source', () => {
    const manager = new FableFallbackManager()
    for (const responses of [10, 20, 40, 40, 40, 40]) {
      expect(
        manager.activate(
          manager.plan('session-a', body('claude-opus-5-5'))!,
          'account',
        ),
      ).toBe(responses)
      finishRound(manager, responses)
    }
  })

  test('resets to 10 only after 10 consecutive successful source responses', () => {
    const manager = new FableFallbackManager()
    manager.activate(manager.plan('session-a', body('claude-opus-5-5'))!)
    finishRound(manager, 10)
    for (let index = 0; index < 9; index++) {
      const plan = manager.plan('session-a', body('claude-opus-5-5'))!
      expect(manager.completeSource(plan)).toBe(true)
      expect(manager.completeSource(plan)).toBe(false)
    }
    expect(
      manager.activate(manager.plan('session-a', body('claude-opus-5-5'))!),
    ).toBe(20)
    finishRound(manager, 20)
    for (let index = 0; index < 10; index++) {
      expect(
        manager.completeSource(
          manager.plan('session-a', body('claude-opus-5-5'))!,
        ),
      ).toBe(true)
    }
    expect(
      manager.activate(manager.plan('session-a', body('claude-opus-5-5'))!),
    ).toBe(10)
  })

  test('ignores stale source completions and clears all family state on session reset', () => {
    const manager = new FableFallbackManager()
    manager.activate(manager.plan('session-a', body('claude-opus-5-5'))!)
    finishRound(manager, 10)
    const staleSource = manager.plan('session-a', body('claude-opus-5-5'))!
    manager.activate(manager.plan('session-a', body('claude-opus-5-5'))!)
    finishRound(manager, 20)
    expect(manager.completeSource(staleSource)).toBe(false)
    for (let index = 0; index < 9; index++) {
      manager.completeSource(
        manager.plan('session-a', body('claude-opus-5-5'))!,
      )
    }
    expect(
      manager.activate(manager.plan('session-a', body('claude-opus-5-5'))!),
    ).toBe(40)
    const staleOpus = manager.plan('session-a', body('claude-opus-5-5'))!
    manager.activate(manager.plan('session-a', body('claude-fable-5'))!)
    manager.clearSession('session-a')
    expect(manager.complete(staleOpus).counted).toBe(false)
    for (const model of ['claude-opus-5-5', 'claude-fable-5']) {
      const plan = manager.plan('session-a', body(model))!
      expect(plan.downgraded).toBe(false)
      expect(manager.activate(plan)).toBe(10)
    }
  })

  test('active source requests preserve re-refusal history beyond 24 hours', () => {
    let now = 0
    const manager = new FableFallbackManager(() => now)
    manager.activate(manager.plan('session-a', body('claude-opus-5-5'))!)
    finishRound(manager, 10)
    for (let hour = 1; hour <= 30; hour++) {
      now = hour * 60 * 60_000
      expect(
        manager.plan('session-a', body('claude-opus-5-5'))?.downgraded,
      ).toBe(false)
    }
    expect(
      manager.activate(manager.plan('session-a', body('claude-opus-5-5'))!),
    ).toBe(20)
  })

  test('backoff is isolated by session and source family', () => {
    const manager = new FableFallbackManager()
    manager.activate(manager.plan('session-a', body('claude-opus-5-5'))!)
    finishRound(manager, 10)
    expect(
      manager.activate(manager.plan('session-a', body('claude-opus-5-5'))!),
    ).toBe(20)
    expect(
      manager.activate(manager.plan('session-b', body('claude-opus-5-5'))!),
    ).toBe(10)
    expect(
      manager.activate(manager.plan('session-a', body('claude-opus-5'))!),
    ).toBe(10)
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

test('tracks Fable 5.2 recovery independently from Fable 5.1 in the same session', () => {
  expect(recoverableRefusalFamily('claude-fable-5-2')).toBe('fable-5-2')
  expect(parseSourceWarmTargetId('source-warm:session-a:fable-5-2')).toEqual({
    sessionId: 'session-a',
    family: 'fable-5-2',
  })
  const manager = new FableFallbackManager()
  manager.activate(
    manager.plan('session-a', body('claude-fable-5-1'))!,
    '5.1-account',
  )
  const healthy52 = manager.plan('session-a', body('claude-fable-5-2'))!
  expect(healthy52).toMatchObject({
    effectiveModel: 'claude-fable-5-2',
    downgraded: false,
  })
  manager.activate(healthy52, '5.2-account')
  const recovered51 = manager.plan('session-a', body('claude-fable-5-1'))!
  const recovered52 = manager.plan('session-a', body('claude-fable-5-2'))!
  expect(recovered51).toMatchObject({
    effectiveModel: FABLE_FALLBACK_MODEL_ID,
    cacheAccountId: '5.1-account',
    downgraded: true,
  })
  expect(recovered52).toMatchObject({
    effectiveModel: FABLE_FALLBACK_MODEL_ID,
    cacheAccountId: '5.2-account',
    downgraded: true,
  })
  expect(recovered51.cycle).not.toBe(recovered52.cycle)
})

test('tracks Opus 5.5 recovery independently from Opus 5 in the same session', () => {
  const manager = new FableFallbackManager()
  const opus5 = manager.plan('session-a', body('claude-opus-5'))!
  manager.activate(opus5, 'opus-5-account')

  const healthyOpus55 = manager.plan('session-a', body('claude-opus-5-5'))!
  expect(healthyOpus55).toMatchObject({
    requestedModel: 'claude-opus-5-5',
    effectiveModel: 'claude-opus-5-5',
    downgraded: false,
  })

  manager.activate(healthyOpus55, 'opus-5-5-account')
  const downgradedOpus5 = manager.plan('session-a', body('claude-opus-5'))!
  const downgradedOpus55 = manager.plan('session-a', body('claude-opus-5-5'))!

  expect(downgradedOpus5).toMatchObject({
    requestedModel: 'claude-opus-5',
    effectiveModel: FABLE_FALLBACK_MODEL_ID,
    cacheAccountId: 'opus-5-account',
    downgraded: true,
  })
  expect(downgradedOpus55).toMatchObject({
    requestedModel: 'claude-opus-5-5',
    effectiveModel: FABLE_FALLBACK_MODEL_ID,
    cacheAccountId: 'opus-5-5-account',
    downgraded: true,
  })
  expect(downgradedOpus5.cycle).not.toBe(downgradedOpus55.cycle)
})

test('counts only terminal completed responses, including tool_use, on either model', async () => {
  const manager = new FableFallbackManager()
  manager.activate(manager.plan('session-a', body('claude-opus-5-5'))!)
  const respond = async (reason?: string) => {
    const plan = manager.plan('session-a', body('claude-opus-5-5'))!
    const stream = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_test"}}\n\n',
      ...(reason
        ? [
            `event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: reason } })}\n\n`,
          ]
        : []),
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ].join('')
    await createStrippedStream(new Response(stream), {
      onComplete: () => {
        if (plan.downgraded) manager.complete(plan)
        else manager.completeSource(plan)
      },
    }).text()
    return plan
  }
  expect(manager.remaining(await respond())).toBe(10)
  expect(manager.remaining(await respond('refusal'))).toBe(10)
  for (let index = 0; index < 10; index++) await respond('tool_use')
  expect(manager.plan('session-a', body('claude-opus-5-5'))?.downgraded).toBe(
    false,
  )
  for (let index = 0; index < 9; index++) await respond('tool_use')
  await respond()
  await respond('tool_use')
  expect(
    manager.activate(manager.plan('session-a', body('claude-opus-5-5'))!),
  ).toBe(10)
})

test('a provider fallback response does not count as a clean source response', () => {
  const manager = new FableFallbackManager()
  manager.activate(manager.plan('session-a', body('claude-opus-5-5'))!)
  for (let index = 0; index < 10; index++)
    manager.complete(manager.plan('session-a', body('claude-opus-5-5'))!)
  for (let index = 0; index < 9; index++)
    manager.completeSource(manager.plan('session-a', body('claude-opus-5-5'))!)
  expect(
    manager.completeSource(
      manager.plan('session-a', body('claude-opus-5-5'))!,
      false,
    ),
  ).toBe(false)
  manager.completeSource(manager.plan('session-a', body('claude-opus-5-5'))!)
  expect(
    manager.activate(manager.plan('session-a', body('claude-opus-5-5'))!),
  ).toBe(20)
})

test('only a changed primary selection clears recovery, not another family using the session', () => {
  const manager = new FableFallbackManager()
  expect(manager.resetForModelChange('session-a', 'claude-opus-5-5')).toBe(
    false,
  )
  manager.activate(manager.plan('session-a', body('claude-opus-5-5'))!)
  manager.activate(manager.plan('session-a', body('claude-fable-5'))!)
  expect(manager.resetForModelChange('session-a', 'claude-opus-5-5')).toBe(
    false,
  )
  expect(manager.plan('session-a', body('claude-opus-5-5'))?.downgraded).toBe(
    true,
  )
  expect(manager.plan('session-a', body('claude-fable-5'))?.downgraded).toBe(
    true,
  )
  expect(manager.resetForModelChange('session-a', 'claude-sonnet-4-6')).toBe(
    true,
  )
  expect(manager.plan('session-a', body('claude-opus-5-5'))?.downgraded).toBe(
    false,
  )
  expect(manager.plan('session-a', body('claude-fable-5'))?.downgraded).toBe(
    false,
  )
})

describe('FableFallbackManager source-warm keeps', () => {
  function keep(
    overrides: Partial<FableSourceWarmInit> = {},
  ): FableSourceWarmInit {
    return {
      bodyText: body('claude-opus-5-5'),
      oauthAccountId: 'main',
      accountIdentity: 'account-uuid-1',
      sentAt: 1_000,
      model: 'claude-opus-5-5',
      firstAnchorFingerprint: 'anchor-fp',
      url: 'https://api.anthropic.com/v1/messages?beta=true',
      headers: { authorization: 'Bearer token' },
      ...overrides,
    }
  }

  function activateWithKeep(
    manager: FableFallbackManager,
    session = 'session-a',
    model = 'claude-opus-5-5',
  ) {
    const plan = manager.plan(session, body(model))!
    expect(manager.activate(plan, 'main', keep({ model }))).toBe(
      FABLE_FALLBACK_TURNS,
    )
    return plan
  }

  test('source warm target ids round-trip and reject foreign ids', () => {
    expect(sourceWarmTargetId('ses_a', 'opus-5-5')).toBe(
      'source-warm:ses_a:opus-5-5',
    )
    expect(parseSourceWarmTargetId('source-warm:ses_a:opus-5-5')).toEqual({
      sessionId: 'ses_a',
      family: 'opus-5-5',
    })
    expect(parseSourceWarmTargetId('ses_a')).toBeNull()
    expect(parseSourceWarmTargetId('source-warm:ses_a')).toBeNull()
    expect(parseSourceWarmTargetId('source-warm:ses_a:nope')).toBeNull()
  })

  test('activate keeps the source with a zeroed idle count', () => {
    const manager = new FableFallbackManager()
    const plan = activateWithKeep(manager)
    const warm = manager.sourceWarmFor(plan.recoveryKey)
    expect(warm).toMatchObject({
      oauthAccountId: 'main',
      model: 'claude-opus-5-5',
      warmsSinceUserTurn: 0,
    })
    expect(manager.sourceWarmForTarget('source-warm:session-a:opus-5-5')).toBe(
      warm,
    )
    expect(manager.hasSourceWarmForSession('session-a')).toBe(true)
    expect(manager.hasSourceWarmForSession('session-b')).toBe(false)
  })

  test('a new round replaces the previous keep', () => {
    const manager = new FableFallbackManager()
    const first = activateWithKeep(manager)
    expect(manager.sourceWarmFor(first.recoveryKey)?.bodyText).toContain(
      'claude-opus-5-5',
    )
    // Finish the round, then refuse again: the keep comes from the new send.
    for (let index = 0; index < FABLE_FALLBACK_TURNS; index++)
      manager.complete(manager.plan('session-a', body('claude-opus-5-5'))!)
    const second = manager.plan('session-a', body('claude-opus-5-5'))!
    manager.activate(second, 'main', keep({ bodyText: body('claude-opus-5') }))
    expect(manager.sourceWarmFor(second.recoveryKey)?.bodyText).toContain(
      '"claude-opus-5"',
    )
  })

  test('a served source drops the keep but keeps the backoff', () => {
    const manager = new FableFallbackManager()
    activateWithKeep(manager)
    for (let index = 0; index < FABLE_FALLBACK_TURNS; index++)
      manager.complete(manager.plan('session-a', body('claude-opus-5-5'))!)
    const probe = manager.plan('session-a', body('claude-opus-5-5'))!
    expect(probe.downgraded).toBe(false)
    expect(manager.completeSource(probe)).toBe(true)
    expect(manager.sourceWarmFor(probe.recoveryKey)).toBeUndefined()
    expect(manager.hasSourceWarmForSession('session-a')).toBe(false)
    // The refusal history survives the dropped keep: refusing again
    // escalates the round instead of resetting it.
    expect(
      manager.activate(manager.plan('session-a', body('claude-opus-5-5'))!),
    ).toBe(20)
  })

  test('account migration drops the keep', () => {
    const manager = new FableFallbackManager()
    activateWithKeep(manager)
    const migrated = manager.plan('session-a', body('claude-opus-5-5'))!
    expect(manager.bindRecoveryAccount(migrated, 'fallback-1')).toBe(true)
    expect(manager.sourceWarmFor(migrated.recoveryKey)).toBeUndefined()
    expect(manager.dropSourceWarmForTarget('bogus')).toBe(false)
  })

  test('model change and session clear drop the keep', () => {
    const manager = new FableFallbackManager()
    expect(manager.resetForModelChange('session-a', 'claude-opus-5-5')).toBe(
      false,
    )
    activateWithKeep(manager)
    expect(manager.resetForModelChange('session-a', 'claude-opus-5')).toBe(true)
    expect(manager.hasSourceWarmForSession('session-a')).toBe(false)
    activateWithKeep(manager)
    manager.clearSession('session-a')
    expect(manager.hasSourceWarmForSession('session-a')).toBe(false)
  })

  test('sent warms count up and a new user turn resets the count', () => {
    const manager = new FableFallbackManager()
    const plan = activateWithKeep(manager)
    expect(manager.noteSourceWarmSent(plan.recoveryKey)).toBe(1)
    expect(manager.noteSourceWarmSent(plan.recoveryKey)).toBe(2)
    expect(manager.noteSourceWarmSent('missing')).toBeUndefined()
    expect(
      manager.noteSourceWarmSentForTarget('source-warm:session-a:opus-5-5'),
    ).toBe(3)
    // The first observed turn key is recorded, not counted as a reset.
    expect(manager.noteSourceWarmUserTurn('session-a', 'prompt-1')).toBe(false)
    expect(manager.sourceWarmFor(plan.recoveryKey)).toMatchObject({
      warmsSinceUserTurn: 3,
      lastUserTurnKey: 'prompt-1',
    })
    // Repeating the same turn changes nothing.
    expect(manager.noteSourceWarmUserTurn('session-a', 'prompt-1')).toBe(false)
    expect(manager.sourceWarmFor(plan.recoveryKey)?.warmsSinceUserTurn).toBe(3)
    // A new turn resets the idle count back to zero.
    expect(manager.noteSourceWarmUserTurn('session-a', 'prompt-2')).toBe(true)
    expect(manager.sourceWarmFor(plan.recoveryKey)?.warmsSinceUserTurn).toBe(0)
    // Other sessions are untouched.
    expect(manager.noteSourceWarmUserTurn('session-b', 'prompt-9')).toBe(false)
  })

  test('dropSourceWarm keeps the recovery round itself', () => {
    const manager = new FableFallbackManager()
    const plan = activateWithKeep(manager)
    expect(manager.dropSourceWarm(plan.recoveryKey)).toBe(true)
    expect(manager.dropSourceWarm(plan.recoveryKey)).toBe(false)
    expect(manager.plan('session-a', body('claude-opus-5-5'))?.downgraded).toBe(
      true,
    )
    expect(
      manager.dropSourceWarmForTarget('source-warm:session-a:opus-5-5'),
    ).toBe(false)
  })
})
