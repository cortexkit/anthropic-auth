import { describe, expect, spyOn, test } from 'bun:test'
import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { logger } from '../logger.ts'
import { MessageThreadTailStore } from '../message-thread-tail-store.ts'
import {
  type MessageThreadInput,
  MessageThreadTracker,
  messageThreadBetas,
  messageThreadCachePrefix,
  prepareMessageThreadRequest,
} from '../message-threads.ts'

type Block = Record<string, unknown>
type Message = { role: string; content: Block[] }
const long = { type: 'ephemeral', ttl: '1h' }
const short = { type: 'ephemeral' }
const reply = { role: 'assistant', content: 'answer' }
const text = (value: string, control?: Block): Block => ({
  type: 'text',
  text: value,
  ...(control ? { cache_control: { ...control } } : {}),
})
const complete = (prepared: ReturnType<MessageThreadTracker['prepare']>) =>
  prepared.complete({
    messageId: 'msg_accepted',
    stopped: true,
    stopReason: 'end_turn',
    reply,
  })

function initial(): MessageThreadInput {
  return {
    session: 'audit-tail',
    account: 'account',
    credential: 'credential',
    betas: ['base'],
    cacheSlot: (body) => (body.system as Block[])[0],
    body: {
      model: 'claude-opus-4-8',
      system: [text('instructions', long)],
      tools: [{ name: 'read' }],
      messages: [
        {
          role: 'user',
          content: [text('prefix', long), text('history', long)],
        },
        { role: 'assistant', content: [text('prior')] },
        { role: 'user', content: [text('old full tail', long)] },
      ],
    },
  }
}

function clearMarkers(content: unknown): void {
  if (!Array.isArray(content)) return
  for (const block of content as Block[]) {
    delete block.cache_control
    if (block.type === 'tool_result') clearMarkers(block.content)
  }
}

function next(
  request: MessageThreadInput,
  control: Block = long,
): MessageThreadInput {
  const body = structuredClone(request.body)
  const messages = body.messages as Message[]
  for (const message of messages.slice(1)) clearMarkers(message.content)
  messages.push(
    { role: 'assistant', content: [text('answer')] },
    { role: 'user', content: [text(`turn ${messages.length}`, control)] },
  )
  return { ...request, body }
}

function seeded(first = initial()) {
  const tracker = new MessageThreadTracker(20, () => 0)
  complete(tracker.prepare(first))
  const continued = next(first)
  const prepared = tracker.prepare(continued)
  expect(prepared.decision.type).toBe('continue')
  complete(prepared)
  return { tracker, first, continued }
}

function fullBody(input: MessageThreadInput): unknown {
  return input.stateless
    ? input.body
    : { ...input.body, thread: { type: 'create' } }
}

function expectSkip(
  tracker: MessageThreadTracker,
  request: MessageThreadInput,
  reason: string,
) {
  const log = spyOn(logger, 'debug')
  try {
    const prepared = tracker.prepare(request)
    expect(prepared.decision.type).toBe('create')
    expect(prepared.tailMarkerAdded).toBe(false)
    expect(JSON.stringify(prepared.body)).toBe(
      JSON.stringify(fullBody(request)),
    )
    expect(
      log.mock.calls
        .filter((call) => call[1] === 'message_thread_tail_marker')
        .at(-1)?.[2],
    ).toMatchObject({ reason })
    return prepared
  } finally {
    log.mockRestore()
  }
}

async function restartFixture(acceptContinuation = true) {
  const root = await mkdtemp(join(tmpdir(), 'thread-tail-restart-'))
  let now = 1_000
  const clock = () => now
  const first = initial()
  first.betas = messageThreadBetas(new Headers({ 'anthropic-beta': 'base' }))
  const continued = next(first)
  const originalStore = new MessageThreadTailStore('opencode2', root, clock)
  const original = new MessageThreadTracker(20, clock, undefined, originalStore)
  const create = original.prepare(first)
  expect(create.decision.type).toBe('create')
  complete(create)
  const prepared = original.prepare(continued)
  expect(prepared.decision.type).toBe('continue')
  now += 100
  if (acceptContinuation) complete(prepared)
  original.forget(first.session, 'session_closed')
  await originalStore.drain()
  const store = new MessageThreadTailStore('opencode2', root, clock)
  const tracker = new MessageThreadTracker(20, clock, undefined, store)
  return {
    close: () => rm(root, { recursive: true, force: true }),
    expire: () => {
      now = 3_601_000
    },
    path: async () =>
      join(store.directory, (await readdir(store.directory))[0]!),
    store,
    first,
    request: next(continued),
    render: (request: MessageThreadInput) =>
      prepareMessageThreadRequest(tracker, {
        ...request,
        headers: new Headers({ 'anthropic-beta': 'base' }),
        bodyText: JSON.stringify(request.body),
      }),
  }
}

describe('full tails across a host restart', () => {
  test('the first create reuses the accepted full prefix without storing message text', async () => {
    const f = await restartFixture()
    try {
      const outgoing = JSON.parse((await f.render(f.request)).bodyText)
      expect(outgoing.thread).toEqual({ type: 'create' })
      expect(outgoing.messages[2].content[0].cache_control).toEqual(long)
      expect(outgoing.system[0].cache_control).toBeUndefined()
      const prefix = messageThreadCachePrefix(
        f.first.body,
        2,
        [0],
        f.first.betas,
      )
      expect(messageThreadCachePrefix(outgoing, 2, [0], f.first.betas)).toBe(
        prefix,
      )
      const path = await f.path()
      expect(await readdir(f.store.directory)).toHaveLength(1)
      const raw = await readFile(path, 'utf8')
      expect(JSON.parse(raw)).toMatchObject({
        continued: true,
        tail: { prefix, messageIndex: 2, blockPath: [0], acceptedAt: 1_000 },
      })
      for (const secret of [
        'old full tail',
        'audit-tail',
        'account',
        'credential',
      ])
        expect(raw).not.toContain(secret)
      if (process.platform !== 'win32') {
        expect((await stat(path)).mode & 0o777).toBe(0o600)
        expect((await stat(f.store.directory)).mode & 0o777).toBe(0o700)
      }
    } finally {
      await f.close()
    }
  })

  test('an accepted create alone does not make a stored tail reusable', async () => {
    const f = await restartFixture(false)
    try {
      const raw = JSON.parse(await readFile(await f.path(), 'utf8'))
      expect(raw.continued).toBe(false)
      const prepared = await f.render(f.request)
      expect(prepared.bodyText).toBe(JSON.stringify(fullBody(f.request)))
    } finally {
      await f.close()
    }
  })

  test('the restart directory retains only the newest 1,024 sessions', async () => {
    const f = await restartFixture()
    try {
      const path = await f.path()
      const raw = await readFile(path, 'utf8')
      for (let i = 0; i < 1024; i += 32) {
        await Promise.all(
          Array.from({ length: 32 }, async (_, offset) => {
            const n = i + offset
            const copy = join(
              f.store.directory,
              `${n.toString(16).padStart(64, '0')}.json`,
            )
            await writeFile(copy, raw, { mode: 0o600 })
            await utimes(copy, n + 1, n + 1)
          }),
        )
      }
      f.store.changed(f.first.session, JSON.parse(raw).tail, true)
      await f.store.drain()
      const remaining = await readdir(f.store.directory)
      expect(remaining).toHaveLength(1024)
      expect(remaining).not.toContain(`${'0'.repeat(64)}.json`)
      expect(await readFile(path, 'utf8')).toBe(raw)
    } finally {
      await f.close()
    }
  })

  test.each([
    ['prefix', 'prefix_changed'],
    ['account', 'account_changed'],
    ['credential', 'account_changed'],
    ['lifetime', 'expired'],
    ['corrupt', 'no_anchor'],
    ['missing', 'no_anchor'],
  ] as const)(
    'ignores a persisted tail on %s failure',
    async (variant, reason) => {
      const f = await restartFixture()
      const log = spyOn(logger, 'debug')
      try {
        const { request } = f
        if (variant === 'prefix')
          (request.body.messages as Message[])[0]!.content[0]!.text = 'changed'
        if (variant === 'account' || variant === 'credential')
          request[variant] = 'changed'
        if (variant === 'lifetime') f.expire()
        if (variant === 'corrupt')
          await writeFile(await f.path(), 'invalid json')
        if (variant === 'missing') await rm(await f.path())
        const prepared = await f.render(request)
        expect(prepared.bodyText).toBe(JSON.stringify(fullBody(request)))
        const event =
          reason === 'no_anchor'
            ? 'message_thread_create'
            : 'message_thread_tail_marker'
        expect(
          log.mock.calls.find((call) => call[1] === event)?.[2],
        ).toMatchObject({ reason })
        if (variant === 'lifetime') {
          await f.store.drain()
          expect(await readdir(f.store.directory)).toEqual([])
        }
      } finally {
        log.mockRestore()
        await f.close()
      }
    },
  )
})

describe('full-tail state and wire invariants', () => {
  test.each(['same lifetime', 'different lifetime'] as const)(
    'create snapshot follows actual wire after an earlier edit: %s',
    (variant) => {
      const first = initial()
      delete (first.body.system as Block[])[0]!.cache_control
      const { tracker, continued } = seeded(first)
      const rewritten = next(continued)
      ;(rewritten.body.system as Block[])[0]!.cache_control = { ...long }
      ;(rewritten.body.messages as Message[])[0]!.content[0]!.text =
        'edited before old tail'
      const full = tracker.prepare(rewritten)
      expect(full.decision.type).toBe('create')
      expect(full.tailMarkerAdded).toBe(false)
      expect(JSON.stringify(full.body)).toBe(
        JSON.stringify(fullBody(rewritten)),
      )
      complete(full)
      const following = next(
        rewritten,
        variant === 'same lifetime' ? long : short,
      )
      if (variant === 'different lifetime') {
        delete (following.body.system as Block[])[0]!.cache_control
        for (const block of (following.body.messages as Message[])[0]!.content)
          block.cache_control = { ...short }
      }
      const prepared = tracker.prepare(following)
      expect(prepared.decision.type).toBe(
        variant === 'same lifetime' ? 'continue' : 'create',
      )
      if (prepared.decision.type === 'continue')
        expect(JSON.stringify(prepared.body.system)).toBe(
          JSON.stringify(full.body.system),
        )
    },
  )

  test('mixed-lifetime continuation falls back to the untouched full create', () => {
    const first = initial()
    first.body.tools = [{ name: 'read', cache_control: { ...long } }]
    ;(first.body.system as Block[])[0]!.cache_control = { ...short }
    for (const message of first.body.messages as Message[])
      clearMarkers(message.content)
    ;(first.body.messages as Message[])[2]!.content[0]!.cache_control = {
      ...short,
    }
    const tracker = new MessageThreadTracker(20, () => 0)
    complete(tracker.prepare(first))
    const request = next(first)
    ;(request.body.system as Block[])[0]!.cache_control = { ...long }
    ;(request.body.messages as Message[]).at(-1)!.content = [
      text('one hour', long),
      text('five minutes', short),
    ]
    const before = JSON.stringify(request.body)
    const prepared = tracker.prepare(request)
    expect(prepared.decision.type).toBe('create')
    expect(prepared.tailMarkerAdded).toBe(false)
    expect(JSON.stringify(prepared.body)).toBe(
      JSON.stringify(fullBody(request)),
    )
    expect(JSON.stringify(request.body)).toBe(before)
  })

  test.each(['block keys', 'control keys', 'restored control keys'] as const)(
    'accepted fixed wire preserves %s',
    (variant) => {
      const first = initial()
      first.body.system = [
        variant === 'block keys'
          ? { type: 'text', cache_control: { ...long }, text: 'instructions' }
          : {
              type: 'text',
              text: 'instructions',
              cache_control: { ttl: '1h', type: 'ephemeral' },
            },
      ]
      const tracker = new MessageThreadTracker(20, () => 0)
      complete(tracker.prepare(first))
      const request = next(first)
      if (variant === 'restored control keys')
        delete (request.body.system as Block[])[0]!.cache_control
      const prepared = tracker.prepare(request)
      expect(prepared.decision.type).toBe('continue')
      expect(JSON.stringify(prepared.body.system)).toBe(
        JSON.stringify(first.body.system),
      )
    },
  )

  test('records the last marker from the actual replacement body', () => {
    const { tracker, continued } = seeded()
    const replacement = next(next(continued))
    clearMarkers((replacement.body.messages as Message[]).at(-1)!.content)
    ;(replacement.body.messages as Message[])[4]!.content[0]!.cache_control = {
      ...long,
    }
    replacement.cacheSlot = (body) =>
      (body.messages as Message[])[4]!.content[0]
    const full = tracker.prepare(replacement)
    expect(full.tailMarkerAdded).toBe(true)
    expect(
      (full.body.messages as Message[])[4]!.content[0]!.cache_control,
    ).toBeUndefined()
    complete(full)
    const continuedAgain = next(replacement)
    continuedAgain.cacheSlot = initial().cacheSlot
    const prepared = tracker.prepare(continuedAgain)
    expect(prepared.decision.type).toBe('continue')
    complete(prepared)
    const last = tracker.prepare(next(next(continuedAgain)))
    expect(last.tailMarkerAdded).toBe(true)
    expect(
      (last.body.messages as Message[])[2]!.content[0]!.cache_control,
    ).toEqual(long)
    expect(
      (last.body.messages as Message[])[4]!.content[0]!.cache_control,
    ).toBeUndefined()
  })

  test('records and restores a nested tool-result message marker', () => {
    const first = initial()
    ;(first.body.messages as Message[])[2]!.content = [
      {
        type: 'tool_result',
        tool_use_id: 'tool',
        content: [text('nested old tail', long), text('after nested tail')],
      },
    ]
    const { tracker, continued } = seeded(first)
    const prepared = tracker.prepare(next(next(continued)))
    expect(prepared.tailMarkerAdded).toBe(true)
    const result = (prepared.body.messages as Message[])[2]!.content[0]!
    expect((result.content as Block[])[0]!.cache_control).toEqual(long)
    expect(result.cache_control).toBeUndefined()
  })

  test('four stateless-only requests never manufacture thread history', () => {
    const tracker = new MessageThreadTracker(20, () => 0)
    let request = { ...initial(), stateless: true }
    for (let index = 0; index < 4; index++) {
      if (index > 0) request = { ...next(request), stateless: true }
      if (index === 1)
        for (const message of request.body.messages as Message[])
          clearMarkers(message.content)
      const before = JSON.stringify(request.body)
      const prepared = tracker.prepare(request)
      expect(prepared.tailMarkerAdded).toBe(false)
      expect(JSON.stringify(prepared.body)).toBe(before)
      complete(prepared)
    }
  })

  test('an unrecordable resulting layout leaves the full body untouched', () => {
    const first = initial()
    delete (first.body.messages as Message[])[0]!.content[0]!.cache_control
    first.body.tools = [
      { name: 'read', cache_control: { ...long, scope: 'global' } },
    ]
    const { tracker, continued } = seeded(first)
    expectSkip(
      tracker,
      { ...next(continued), stateless: true },
      'layout_unrecordable',
    )
  })

  test('create after create keeps the ordinary full body byte-identical', () => {
    let now = 0
    const tracker = new MessageThreadTracker(20, () => now)
    const first = initial()
    complete(tracker.prepare(first))
    now = 301_000
    expectSkip(tracker, next(first), 'no_continuation')
  })

  test.each(['betas', 'speed'] as const)(
    'changed %s fails the tail prefix check closed',
    (field) => {
      const { tracker, continued } = seeded()
      const request = { ...next(continued), stateless: true }
      if (field === 'betas') request.betas = ['base', 'different']
      else request.body.speed = 'fast'
      expectSkip(tracker, request, 'prefix_changed')
    },
  )

  test('unavailable slot reads no message prefix and clones nothing', () => {
    const { tracker, continued } = seeded()
    const body = { ...continued.body }
    Object.defineProperty(body, 'messages', {
      enumerable: true,
      get() {
        throw new Error('message prefix was read')
      },
    })
    const clone = spyOn(globalThis, 'structuredClone')
    try {
      expect(() =>
        tracker.prepare({
          ...continued,
          body,
          stateless: true,
          cacheSlot: () => undefined,
        }),
      ).not.toThrow()
      expect(clone).not.toHaveBeenCalled()
    } finally {
      clone.mockRestore()
    }
  })
})

describe('full-tail skip guard coverage', () => {
  test('no_full_tail keeps a markerless accepted full request unchanged', () => {
    const first = initial()
    for (const message of first.body.messages as Message[])
      clearMarkers(message.content)
    const { tracker, continued } = seeded(first)
    expectSkip(tracker, { ...next(continued), stateless: true }, 'no_full_tail')
  })

  test('already_marked preserves the existing exact full-tail marker', () => {
    const { tracker, continued } = seeded()
    const request = { ...next(continued), stateless: true }
    delete (request.body.messages as Message[])[0]!.content[0]!.cache_control
    ;(request.body.messages as Message[])[2]!.content[0]!.cache_control = {
      ...long,
    }
    expectSkip(tracker, request, 'already_marked')
  })

  test.each(['non-holder', 'automatic', 'over budget'] as const)(
    '%s slot guard preserves the full body',
    (variant) => {
      const { tracker, continued } = seeded()
      const request = { ...next(continued), stateless: true }
      if (variant === 'non-holder')
        request.cacheSlot = () => text('not in the body', long)
      if (variant === 'automatic') {
        for (const message of request.body.messages as Message[])
          clearMarkers(message.content)
        request.body.cache_control = { ...long }
      }
      if (variant === 'over budget')
        request.body.tools = [{ name: 'read', cache_control: { ...long } }]
      expectSkip(tracker, request, 'slot_taken')
    },
  )

  test.each(['no slot', 'non-holder', 'automatic', 'over budget'] as const)(
    'serialized %s skip preserves noncompact input bytes',
    async (variant) => {
      const headers = new Headers({ 'anthropic-beta': 'base' })
      const first = initial()
      first.betas = messageThreadBetas(headers)
      const { tracker, continued } = seeded(first)
      const request = next(next(continued))
      if (variant === 'no slot') request.cacheSlot = () => undefined
      if (variant === 'non-holder')
        request.cacheSlot = () => text('not a holder', long)
      if (variant === 'automatic') request.body.cache_control = { ...long }
      if (variant === 'over budget')
        request.body.tools = [{ name: 'read', cache_control: { ...long } }]
      const bodyText = ` \n${JSON.stringify(request.body, null, 2)}\n `
      const expected = bodyText.replace(
        /}(\s*)$/,
        ',"thread":{"type":"create"}}$1',
      )
      const prepared = await prepareMessageThreadRequest(tracker, {
        ...request,
        headers,
        bodyText,
      })
      expect(prepared.bodyText).toBe(expected)
    },
  )
})
