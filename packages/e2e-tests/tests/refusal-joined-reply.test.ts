import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MockAnthropicServer } from '../src/mock-anthropic'
import {
  completedToolId,
  fixtureCredit,
  fixtureFallback,
  fixtureSource,
  followPrompt,
  matchesRefusalCredit,
  openThinking,
  openToolId,
  recoveryText,
  refusalMarker,
  RefusalMock,
  retryRefusalCredit,
  sourceText,
  targetText,
  thinking,
  toolChunkTimeoutMs,
} from '../src/mock-refusal'
import { startOc2, startPi } from '../src/refusal-host-sessions'
import {
  type Host,
  type HostSession,
  hostEnv,
  installHost,
  offlineEnv,
  startOc1,
  writeNetworkFence,
} from '../src/refusal-hosts'
import {
  assistantSteps,
  partsOnWire,
  wireHistory,
} from '../src/refusal-transcript'

const launch = { oc1: startOc1, oc2: startOc2, pi: startPi }
const scenarios = [
  [1, 'refusal before content'],
  [2, 'refusal after closed thinking'],
  [3, 'refusal after closed text'],
  [4, 'refusal after a completed tool'],
  [5, 'refusal with a tool open'],
  [6, 'refusal with thinking open'],
  [7, 'refusal with text open'],
  [8, 'retry failure before content'],
  [9, 'retry refusal after content'],
  [10, 'refusal after a completed tool and an open tool'],
  [11, 'keep-alive through a slow held tool'],
  [12, 'closed text with no prefill claim'],
  [13, 'shortened host timeout fires with no held frames'],
] as const

const text = (value: string) => ({ type: 'text', text: value })
const reason = (model: string) => ({
  type: 'thinking',
  text: thinking(model).thinking,
  signature: thinking(model).signature,
})
const tool = { type: 'tool_use', id: completedToolId }
const toolResult = { type: 'tool_result', id: completedToolId, error: false }
const continued = text('Tool continuation completed.')
const usage = {
  retry: [9, 29, 277, 0],
  source: [11, 17, 5, 222],
  continuation: [11, 29, 5, 222],
}
const stops = {
  oc1: { refusal: 'content-filter', tool: 'tool-calls', success: 'stop' },
  oc2: { refusal: 'refusal', tool: 'tool_use', success: 'end_turn' },
  pi: { refusal: 'error', tool: 'toolUse', success: 'stop' },
}

for (const host of Object.keys(launch) as Host[]) {
  describe.skipIf(process.platform !== 'linux')(`${host} joined reply`, () => {
    let root: string
    let fence: string
    let installed: Awaited<ReturnType<typeof installHost>>
    beforeAll(async () => {
      root = await mkdtemp(join(tmpdir(), `joined-refusal-${host}-`))
      fence = await writeNetworkFence(root)
      installed = await installHost(host, root)
    }, 200_000)
    afterAll(async () => {
      if (root) await rm(root, { recursive: true, force: true })
    })

    for (const [point, name] of scenarios) {
      if ((point === 11 || point === 13) && host === 'pi') continue
      test(
        name,
        async () => {
          const directory = await mkdtemp(join(root, `${point}-`))
          const toolLog = join(directory, 'tool.txt')
          const fixture = new RefusalMock((tool) => ({
            command: `printf 'executed\\n' >> ${JSON.stringify(toolLog)}`,
            ...(/bash/i.test(tool) && {
              description: 'Record one fixture execution',
            }),
          }))
          const server = new MockAnthropicServer(fixture)
          const { baseURL: origin, port } = await server.start()
          let session: HostSession | undefined
          try {
            session = await launch[host]({
              ...installed,
              origin,
              port,
              fence,
              directory,
              env: offlineEnv(await hostEnv(directory)),
              shortTimeout: point === 11 || point === 13,
            })
            const prompt = `${refusalMarker(point)} Reply in one short sentence.`
            const started = performance.now()
            const first = await session.prompt(prompt)
            const elapsed = performance.now() - started
            const steps = assistantSteps(host, first.stored)
            if (point === 13) {
              // OC1 automatically retries the timed-out step; OC2 records a failure.
              expect(
                fixture.events.map(({ kind }) => kind),
                'the idle mock must not finish',
              ).toEqual(host === 'oc1' ? ['idle-text-retried'] : [])
              if (host === 'oc1')
                expect(steps.flatMap(({ parts }) => parts)).toContainEqual(
                  text(recoveryText),
                )
              else
                expect(steps.map(({ finish }) => finish)).not.toContain(
                  stops[host].success,
                )
              expect(elapsed).toBeGreaterThanOrEqual(toolChunkTimeoutMs - 100)
              return
            }
            const firstRequests = server.requests().length
            const follow = await session.prompt(followPrompt)
            const runs = (
              await readFile(toolLog, 'utf8').catch(
                (error: NodeJS.ErrnoException) => {
                  if (error.code !== 'ENOENT') throw error
                  return ''
                },
              )
            )
              .split('\n')
              .filter(Boolean)
            const captures = server.requests()
            const generation = ({ body }: (typeof captures)[number]) =>
              body.max_tokens !== 0 &&
              !JSON.stringify(body).includes(
                'Generate a title for this conversation',
              )
            const firstTurn = captures
              .slice(0, firstRequests)
              .filter(generation)
            const nextTurn = captures.slice(firstRequests).filter(generation)
            const complete = point === 4 || point === 10 || point === 11
            const refusal = point === 8 || point === 9
            const sourceParts =
              point === 2
                ? [reason(fixtureSource)]
                : point === 9
                  ? [reason(fixtureSource), text(sourceText)]
                  : point === 6
                    ? [{ type: 'thinking', text: openThinking, signature: '' }]
                    : [3, 5, 7, 8, 9, 12].includes(point)
                      ? [text(sourceText)]
                      : []
            const retryParts =
              point === 8 ? [] : [reason(fixtureFallback), text(targetText)]
            const finish = stops[host]
            expect(
              steps,
              JSON.stringify({ cli: first.raw, stored: first.stored }),
            ).toEqual(
              complete
                ? [
                    { parts: [tool], usage: usage.source, finish: finish.tool },
                    {
                      parts: [continued],
                      usage: usage.continuation,
                      finish: finish.success,
                    },
                  ]
                : [
                    {
                      parts: [...sourceParts, ...retryParts],
                      usage: point === 8 ? usage.source : usage.retry,
                      finish: refusal ? finish.refusal : finish.success,
                    },
                  ],
            )
            expect(runs).toEqual(complete ? ['executed'] : [])
            if (point === 11)
              expect(elapsed).toBeGreaterThan(toolChunkTimeoutMs)
            expect(firstTurn.map(({ body }) => body.model)).toEqual([
              fixtureSource,
              fixtureFallback,
            ])
            expect(nextTurn).toHaveLength(1)
            expect(fixture.events.map(({ kind }) => kind)).toEqual([
              'refusal',
              complete ? 'uncredited' : 'credited',
            ])
            const [refused, next, after] = [
              firstTurn[0]?.body,
              firstTurn[1]?.body,
              nextTurn[0]?.body,
            ]
            if (!refused || !next || !after)
              throw new Error('Missing source, retry or follow-up request')
            if (refusal || host === 'pi') expect(after.model).toBe(fixtureSource)
            expect(firstTurn[0]?.headers.authorization).toMatch(
              /^Bearer sk-ant-oat01-/,
            )
            expect(firstTurn[1]?.headers.authorization).toBe(
              firstTurn[0]?.headers.authorization,
            )
            expect(partsOnWire(refused).at(-1)).toMatchObject({
              role: 'user',
              part: text(prompt),
            })
            expect(partsOnWire(after).at(-1)).toMatchObject({
              role: 'user',
              part: text(followPrompt),
            })
            if (complete) {
              expect(wireHistory(next)).toEqual([tool, toolResult])
              expect(
                partsOnWire(next).some(
                  ({ role, part }) => role === 'user' && part.text === prompt,
                ),
              ).toBe(true)
            } else {
              const prefill =
                point === 2
                  ? [thinking(fixtureSource)]
                  : point === 9
                    ? [thinking(fixtureSource), text(sourceText)]
                    : [3, 5, 7, 8].includes(point)
                      ? [text(sourceText)]
                      : []
              expect(next.fallback_credit_token).toBe(fixtureCredit)
              expect(matchesRefusalCredit(refused, next, prefill)).toBe(true)
              expect(next.messages).toEqual(
                prefill.length
                  ? [
                      ...(refused.messages as unknown[]),
                      { role: 'assistant', content: prefill },
                    ]
                  : refused.messages,
              )
            }
            for (const captured of captures) {
              const { body } = captured
              const headers = JSON.stringify(captured.headers)
              expect(headers).not.toContain(fixtureCredit)
              expect(headers).not.toContain(retryRefusalCredit)
              expect(JSON.stringify(body)).not.toContain(openThinking)
              expect(JSON.stringify(body)).not.toContain(openToolId)
              expect(JSON.stringify(body)).not.toContain(retryRefusalCredit)
              if (body !== next || complete) {
                expect(body).not.toHaveProperty('fallback_credit_token')
                expect(JSON.stringify(body)).not.toContain(fixtureCredit)
              }
              if (Array.isArray(body.messages))
                for (const { part } of partsOnWire(body))
                  if (part.type === 'thinking')
                    expect(part.signature).toBeTruthy()
            }
            const hostData = JSON.stringify([first, follow])
            expect(hostData).not.toContain(fixtureCredit)
            expect(hostData).not.toContain(retryRefusalCredit)
            expect(hostData).not.toContain(openToolId)
            if (!complete) {
              // OpenCode omits failed assistant turns. Pi restarts before the
              // follow-up, so even after a successful retry its request returns
              // to the source and drops target thinking after source thinking.
              const dropsRetryThinking =
                point === 9 || (host === 'pi' && point === 2)
              const kept = [
                ...(point === 6 ? [] : sourceParts),
                ...(dropsRetryThinking ? [text(targetText)] : retryParts),
              ]
              expect(wireHistory(after)).toEqual(
                refusal && host !== 'pi' ? [] : kept,
              )
            }
          } finally {
            await session?.close()
            await server.stop()
            await rm(directory, { recursive: true, force: true })
          }
        },
        point === 11 || point === 13 ? 125_000 : 65_000,
      )
    }
  })
}
