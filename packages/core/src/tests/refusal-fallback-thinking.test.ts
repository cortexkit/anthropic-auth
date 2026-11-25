import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RefusalFallbackRoundEngine } from '../refusal-fallback-round.ts'
import {
  RecoveryThinkingStore,
  recoveryThinkingDigest,
} from '../refusal-fallback-thinking.ts'

const sessionId = 'thinking-session'
const family = 'fable-5-2'
const digest = (signature: string) =>
  recoveryThinkingDigest('thinking', signature)!

test('the first source request waits past 100 ms for an existing thinking record', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'thinking-read-'))
  const reading = Promise.withResolvers<void>()
  const unblock = Promise.withResolvers<void>()
  let first: Promise<string> | undefined
  try {
    const original = new RecoveryThinkingStore({ directory })
    original.record(sessionId, family, digest('target-signature'))
    await original.flush()
    const thinkingStore = new RecoveryThinkingStore({
      directory,
      ownerOnly: {
        platform: 'win32',
        privateFiles: {
          verifyOwnerOnly: async () => ({ ok: true }),
          readPrivateFile: async (path) => {
            reading.resolve()
            await unblock.promise
            return readFile(path)
          },
        },
      },
    })
    const engine = new RefusalFallbackRoundEngine(undefined, { thinkingStore })
    const model = 'claude-fable-5-2'
    const source = {
      type: 'thinking',
      thinking: 'source',
      signature: 'source-signature',
    }
    const target = {
      type: 'thinking',
      thinking: 'target',
      signature: 'target-signature',
    }
    const text = { type: 'text', text: 'reply' }
    const bodyText = JSON.stringify({
      model,
      messages: [
        { role: 'user', content: 'prompt' },
        { role: 'assistant', content: [source, target, text] },
      ],
    })
    let prepared = false
    first = engine.loadThinking(sessionId).then(() => {
      prepared = true
      return engine.plan({
        sessionId,
        requestedModel: model,
        bodyText,
        kind: 'primary',
        mode: 'client',
      }).bodyText
    })
    await reading.promise
    await Bun.sleep(150)
    expect(prepared).toBe(false)
    unblock.resolve()
    expect(JSON.parse(await first).messages[1].content).toEqual([source, text])
  } finally {
    unblock.resolve()
    await first
    await rm(directory, { recursive: true, force: true })
  }
})

test('consecutive flushes from overlapping thinking stores preserve both new digests', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'thinking-merge-'))
  try {
    const original = new RecoveryThinkingStore({ directory })
    const [d, a, b] = ['baseline', 'process-a', 'process-b'].map(digest) as [
      string,
      string,
      string,
    ]
    original.record(sessionId, family, d)
    await original.flush()
    const left = new RecoveryThinkingStore({ directory })
    const right = new RecoveryThinkingStore({ directory })
    await Promise.all([
      left.loadSession(sessionId),
      right.loadSession(sessionId),
    ])
    expect([...left.peek(sessionId, family)!.keys()]).toEqual([d])
    expect([...right.peek(sessionId, family)!.keys()]).toEqual([d])
    left.record(sessionId, family, a)
    right.record(sessionId, family, b)
    await left.flush()
    await right.flush()
    const restarted = new RecoveryThinkingStore({ directory })
    await restarted.loadSession(sessionId)
    expect(new Set(restarted.peek(sessionId, family)?.keys())).toEqual(
      new Set([d, a, b]),
    )
    const file = `${createHash('sha256').update(sessionId).digest('hex')}.json`
    expect(JSON.parse(await readFile(join(directory, file), 'utf8'))).toEqual({
      version: 1,
      families: { [family]: expect.arrayContaining([d, a, b]) },
    })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
