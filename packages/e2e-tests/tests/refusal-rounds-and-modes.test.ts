import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type CapturedAnthropicRequest,
  MockAnthropicServer,
} from '../src/mock-anthropic'
import {
  completedToolId,
  fixtureFallback,
  fixtureSource,
  fixtureStream,
  matchesRefusalCredit,
  openToolId,
  thinking,
} from '../src/mock-refusal'
import { MockRelayServer } from '../src/mock-relay'
import { startOc2, startPi } from '../src/refusal-host-sessions'
import {
  type Host,
  type HostFixture,
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
const source = fixtureSource
const target = fixtureFallback
const sentinel = 'secret-fixture-credit-nJ8K4-r1'
const relayToken = 'synthetic-refusal-relay-fixture'
const beta = 'server-side-fallback-2026-07-01'
const text = (value: string) => ({ type: 'text', text: value })
const block = (value: string) => ({ block: text(value) })
const finishRefusal = { oc1: 'content-filter', oc2: 'refusal', pi: 'error' }
const finishTool = { oc1: 'tool-calls', oc2: 'tool_use', pi: 'toolUse' }
const finishSuccess = { oc1: 'stop', oc2: 'end_turn', pi: 'stop' }
type Body = CapturedAnthropicRequest['body']
type RoundEvent = {
  kind: 'round_started' | 'step_served' | 'round_ended'
  stepsLeft: number
  requestedModel: string
  servingModel: string
  category: string
  reason?: string
}

async function waitForRoundEvents(
  session: HostSession,
  done: (events: RoundEvent[]) => boolean,
) {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const diagnostics = await session.readDiagnostics!()
    expect(diagnostics).not.toContain(sentinel)
    const events = diagnostics.split('\n').flatMap((line) => {
      const match = line.match(
        /\[refusal-fallback\] (?:round_started|step_served|round_ended) (\{.*\})$/,
      )
      return match?.[1] ? [JSON.parse(match[1]) as RoundEvent] : []
    })
    if (done(events)) return events
    await Bun.sleep(50)
  }
  throw new Error('The host did not publish the expected round events')
}

const waitForRoundEnd = (session: HostSession, reason: string) =>
  waitForRoundEvents(session, (events) =>
    events.some(
      (entry) => entry.kind === 'round_ended' && entry.reason === reason,
    ),
  )

type Step = (
  body: Body,
  request: CapturedAnthropicRequest,
) => Response | undefined | Promise<Response | undefined>

function script() {
  const queue: Step[] = []
  const primary: CapturedAnthropicRequest[] = []
  const server = new MockAnthropicServer({
    respond(body, request) {
      primary.push(request)
      const next = queue.shift()
      if (next) return next(body, request)
      return Response.json(
        {
          error: {
            type: 'invalid_request_error',
            message: 'Unexpected fixture send',
          },
        },
        { status: 422 },
      )
    },
  })
  return {
    server,
    primary,
    queue,
    models: () => primary.map(({ body }) => body.model),
  }
}

function reply(
  content: Parameters<typeof fixtureStream>[0]['content'],
  options: Partial<
    Omit<Parameters<typeof fixtureStream>[0], 'model' | 'content'>
  > = {},
): Step {
  return (body) =>
    fixtureStream({
      model: String(body.model),
      content,
      stop: 'end_turn',
      ...options,
    })
}

function tool(body: Body, directory: string, id: string, open = false) {
  const name = (body.tools as Array<{ name: string }>).find((entry) =>
    /^(?:mcp_)?(?:bash|shell)$/i.test(entry.name),
  )?.name
  if (!name) throw new Error('Host did not advertise the fixture tool')
  return {
    open,
    block: {
      type: 'tool_use',
      name,
      id,
      input: {
        command: `printf '%s\\n' '${id}' >> ${JSON.stringify(join(directory, 'tool-runs'))}`,
        description: 'Record one fixture tool execution',
      },
    },
  }
}

async function runs(directory: string) {
  const file = Bun.file(join(directory, 'tool-runs'))
  return (await file.exists()) ? (await file.text()).trim().split('\n') : []
}

for (const host of Object.keys(launch) as Host[]) {
  describe.skipIf(process.platform !== 'linux')(
    `${host} refusal rounds and modes`,
    () => {
      let root: string
      let fence: string
      let installed: Awaited<ReturnType<typeof installHost>>
      beforeAll(async () => {
        root = await mkdtemp(join(tmpdir(), `refusal-rounds-${host}-`))
        fence = await writeNetworkFence(root)
        installed = await installHost(host, root)
      }, 200_000)
      afterAll(async () => {
        if (root) await rm(root, { recursive: true, force: true })
      })

      function scenario(
        name: string,
        exercise: (
          session: HostSession,
          mock: ReturnType<typeof script>,
          directory: string,
        ) => Promise<void>,
        options: Pick<
          HostFixture,
          'mode' | 'model' | 'hybridCache' | 'overlap' | 'dump'
        > & { viaRelay?: boolean } = {},
      ) {
        test(name, async () => {
          const directory = await mkdtemp(join(root, 'case-'))
          const mock = script()
          const { port, baseURL: origin } = await mock.server.start()
          const relay = options.viaRelay ? new MockRelayServer() : undefined
          let session: HostSession | undefined
          try {
            const relayAddress = await relay?.start({
              token: relayToken,
              anthropicOrigin: origin,
            })
            session = await launch[host]({
              ...installed,
              ...options,
              directory,
              fence,
              origin,
              port,
              env: offlineEnv(await hostEnv(directory)),
              shortTimeout: false,
              persistent: true,
              relay: relayAddress && { ...relayAddress, token: relayToken },
            })
            await exercise(session, mock, directory)
            expect(mock.queue).toHaveLength(0)
            expect(mock.server.tokenRequests()).toBe(0)
            if (relay)
              expect(relay.acceptedRequests()).toBe(
                mock.server.requests().length,
              )
            for (const request of mock.server.requests()) {
              expect(JSON.stringify(request.headers)).not.toContain(sentinel)
              if (request.body.fallback_credit_token === sentinel) continue
              expect(JSON.stringify(request.body)).not.toContain(sentinel)
            }
          } finally {
            await session?.close()
            await relay?.stop()
            await mock.server.stop()
            await rm(directory, { recursive: true, force: true })
          }
        }, 120_000)
      }

      for (const state of [
        'valid target',
        'missing category',
        'unseeded category',
        'no fit',
      ] as const) {
        scenario(
          `released tool calls run once, pair their results, and route correctly: ${state}`,
          async (session, mock, directory) => {
            const originModel = source
            const nextModel = state === 'valid target' ? target : originModel
            const secondId = 'toolu_refusal_completed_second'
            mock.queue.push(
              (body) =>
                fixtureStream({
                  model: String(body.model),
                  content: [
                    ...(state === 'valid target'
                      ? [block('Before the calls.')]
                      : []),
                    tool(body, directory, completedToolId),
                    tool(body, directory, secondId),
                    ...(state === 'missing category'
                      ? [{ ...block('Text still open.'), open: true }]
                      : [tool(body, directory, openToolId, true)]),
                  ],
                  stop: 'refusal',
                  category:
                    state === 'unseeded category'
                      ? 'reasoning_extraction'
                      : state === 'missing category'
                        ? null
                        : 'cyber',
                  credit: sentinel,
                  ...(state === 'no fit' && {
                    usage: {
                      input_tokens: 1_050_000,
                      cache_read_input_tokens: 0,
                      cache_creation_input_tokens: 0,
                    },
                  }),
                }),
              reply([block('After the tool results.')]),
            )
            const outcome = await session.prompt(
              'Run the fixture commands, then report the result.',
            )
            expect(mock.models()).toEqual([originModel, nextModel])
            expect(mock.primary[1]?.body).not.toHaveProperty(
              'fallback_credit_token',
            )
            const wire = wireHistory(mock.primary[1]!.body)
            expect(wire.filter(({ type }) => type === 'tool_use')).toEqual([
              { type: 'tool_use', id: completedToolId },
              { type: 'tool_use', id: secondId },
            ])
            expect(
              wire
                .filter(({ type }) => type === 'tool_result')
                .sort((a, b) => a.id!.localeCompare(b.id!)),
            ).toEqual([
              { type: 'tool_result', id: completedToolId, error: false },
              { type: 'tool_result', id: secondId, error: false },
            ])
            expect((await runs(directory)).sort()).toEqual([
              completedToolId,
              secondId,
            ])
            expect(
              assistantSteps(host, outcome.stored).map(({ finish }) => finish),
            ).toEqual([finishTool[host], finishSuccess[host]])
            expect(JSON.stringify(outcome)).not.toContain(openToolId)
            expect(JSON.stringify(outcome)).not.toContain(sentinel)
          },
        )
      }

      scenario(
        'mid-round refusal does not run or store the target’s open tool',
        async (session, mock, directory) => {
          mock.queue.push(
            reply([], { stop: 'refusal', credit: sentinel }),
            reply([block('Joined target response.')], { credited: true }),
            (body) =>
              fixtureStream({
                model: String(body.model),
                content: [
                  tool(body, directory, openToolId, true),
                  block('The target cannot continue.'),
                ],
                stop: 'refusal',
                credit: sentinel,
              }),
            reply([block('Still on target.')]),
          )
          await session.prompt('Start a recovery round.')
          const refused = await session.prompt(
            'Refuse this step with a tool open.',
          )
          expect(assistantSteps(host, refused.stored).at(-1)).toMatchObject({
            finish: finishRefusal[host],
            parts: [text('The target cannot continue.')],
          })
          const next = await session.prompt(
            'Check that the target remains active.',
          )
          expect(mock.models()).toEqual([source, target, target, target])
          expect(
            mock.primary.filter(
              ({ body }) => body.fallback_credit_token === sentinel,
            ),
          ).toHaveLength(1)
          expect(await runs(directory)).toEqual([])
          for (const physical of mock.primary)
            expect(JSON.stringify(physical.body)).not.toContain(openToolId)
          expect(JSON.stringify([refused, next])).not.toContain(sentinel)
          expect(JSON.stringify([refused, next])).not.toContain(openToolId)
        },
      )

      for (const position of ['joined retry', 'mid-round target'] as const) {
        scenario(
          `a completed tool before a ${position} refusal continues exactly once`,
          async (session, mock, directory) => {
            const retry = position === 'joined retry'
            mock.queue.push(reply([], { stop: 'refusal', credit: sentinel }))
            if (!retry)
              mock.queue.push(
                reply([block('Round installed.')], { credited: true }),
              )
            mock.queue.push(
              (body) =>
                fixtureStream({
                  model: String(body.model),
                  content: [
                    block('Text before the tool.'),
                    tool(body, directory, completedToolId),
                    tool(body, directory, openToolId, true),
                  ],
                  stop: 'refusal',
                  credit: sentinel,
                  credited: retry,
                }),
              reply([block('Answer after tool execution.')]),
            )
            const first = await session.prompt('Start the round.')
            const outcome = retry
              ? first
              : await session.prompt('Run a tool on the active target.')
            expect(mock.models()).toEqual(
              retry
                ? [source, target, source]
                : [source, target, target, target],
            )
            expect(
              assistantSteps(host, outcome.stored)
                .slice(-2)
                .map(({ finish }) => finish),
            ).toEqual([finishTool[host], finishSuccess[host]])
            expect(wireHistory(mock.primary.at(-1)!.body).slice(-2)).toEqual([
              { type: 'tool_use', id: completedToolId },
              { type: 'tool_result', id: completedToolId, error: false },
            ])
            expect(await runs(directory)).toEqual([completedToolId])
            expect(JSON.stringify(outcome)).not.toContain(openToolId)
            expect(JSON.stringify(outcome)).not.toContain(sentinel)
          },
        )
      }

      for (const viaRelay of [false, true]) {
        const transport = viaRelay ? 'HTTP relay' : 'direct'
        scenario(
          `a cold refusal at the target-scoped quota floor sends only the source request (${transport})`,
          async (session, mock) => {
            const checkedAt = Date.now()
            const general = { usedPercent: 11, remainingPercent: 89, checkedAt }
            await session.policy!.quota({
              checkedAt,
              source: 'poll',
              five_hour: general,
              seven_day: general,
              scoped: [target, 'claude-opus-5'].map((modelId) => ({
                id: `fixture-${modelId}`,
                title: modelId,
                modelName: modelId,
                modelId,
                usedPercent: 100,
                remainingPercent: 0,
                checkedAt,
              })),
            })
            mock.queue.push(
              reply([block('Cold refusal at the scoped floor.')], {
                stop: 'refusal',
              }),
              reply([block('Not in a round.')]),
            )
            const refused = await session.prompt(
              'A cold refusal, with no credit token.',
            )
            expect(mock.models()).toEqual([source])
            expect(assistantSteps(host, refused.stored).at(-1)).toMatchObject({
              finish: finishRefusal[host],
            })
            await session.prompt('Check that no fallback round was installed.')
            expect(mock.models()).toEqual([source, source])
          },
          { viaRelay },
        )

        for (const change of [
          'logout',
          'same-UUID credential replacement',
          'general quota',
          'killswitch',
        ] as const) {
          scenario(
            `${change} during the source response allows no extra send (${transport})`,
            async (session, mock) => {
              const policy = session.policy!
              const publishSettings = async (
                patch: Record<string, unknown>,
              ) => {
                await policy.settings(patch)
                await Bun.sleep(500)
              }
              if (change === 'general quota' || change === 'killswitch') {
                const checkedAt = Date.now()
                const window = {
                  usedPercent: 96,
                  remainingPercent: 4,
                  checkedAt,
                }
                const ample = {
                  usedPercent: 11,
                  remainingPercent: 89,
                  checkedAt,
                }
                await policy.quota({
                  checkedAt,
                  source: 'poll',
                  five_hour: change === 'general quota' ? window : ample,
                  seven_day: ample,
                  ...(change === 'killswitch' && {
                    scoped: [target, 'claude-opus-5'].map((modelId) => ({
                      id: `scope-${modelId}`,
                      modelId,
                      modelName: modelId,
                      title: modelId,
                      ...window,
                    })),
                  }),
                })
              }
              mock.queue.push(
                reply([block('Source refused after the authority change.')], {
                  stop: 'refusal',
                  credit: sentinel,
                  claim: true,
                  async beforeStop() {
                    switch (change) {
                      case 'logout':
                        await policy.logout()
                        break
                      case 'same-UUID credential replacement':
                        await policy.replace()
                        break
                      case 'general quota':
                        await publishSettings({
                          quota_enabled: 'on',
                          quota_minimum_remaining_five_hour: 5,
                          quota_check_interval_minutes: 0,
                        })
                        break
                      case 'killswitch':
                        await publishSettings({
                          killswitch_enabled: true,
                          killswitch_default_scoped: 4,
                        })
                        break
                    }
                  },
                }),
              )
              const refused = await session.prompt(
                `Change ${change} after dispatch.`,
              )
              expect(
                mock.models(),
                mock.primary.map(({ url }) => url).join(', '),
              ).toEqual([source])
              expect(assistantSteps(host, refused.stored).at(-1)).toMatchObject(
                {
                  finish: finishRefusal[host],
                  parts: [text('Source refused after the authority change.')],
                },
              )
              expect(JSON.stringify(refused)).not.toContain(sentinel)
            },
            { viaRelay },
          )
        }
      }

      for (const phase of [
        'source terminal',
        'retry first content',
        'retry terminal',
      ] as const) {
        scenario(
          `a mode change makes the ${phase} stale without starting a round`,
          async (session, mock, directory) => {
            const changeMode = async () => {
              await session.policy!.settings({ refusal_fallback: 'off' })
              // The hosts reload the atomically replaced settings file via a watcher.
              await Bun.sleep(500)
            }
            const prefix = block('Source text before the refusal.')
            const tail = block('Retry text already delivered.')
            mock.queue.push((body) =>
              fixtureStream({
                model: String(body.model),
                content: [prefix, tool(body, directory, openToolId, true)],
                stop: 'refusal',
                credit: sentinel,
                claim: true,
                beforeStop:
                  phase === 'source terminal' ? changeMode : undefined,
              }),
            )
            if (phase !== 'source terminal')
              mock.queue.push(
                reply([tail], {
                  credited: true,
                  beforeContent:
                    phase === 'retry first content' ? changeMode : undefined,
                  beforeStop:
                    phase === 'retry terminal' ? changeMode : undefined,
                }),
              )
            const first = await session.prompt(
              'Change settings while the stream is paused.',
            )
            expect(mock.models()).toEqual(
              phase === 'source terminal' ? [source] : [source, target],
            )
            const step = assistantSteps(host, first.stored).at(-1)
            expect(step?.finish).toBe(
              phase === 'retry terminal'
                ? finishSuccess[host]
                : finishRefusal[host],
            )
            expect(step?.parts).toEqual(
              phase === 'retry terminal'
                ? [prefix.block, tail.block]
                : [prefix.block],
            )
            expect(await runs(directory)).toEqual([])
            expect(JSON.stringify(first)).not.toContain(sentinel)
            mock.queue.push(reply([block('Source after mode transition.')]))
            await session.prompt(
              'Confirm that the stale response started no round.',
            )
            expect(mock.models().at(-1)).toBe(source)
          },
        )
      }

      for (const phase of [
        'source terminal',
        'wrong-model 400',
        'retry first content',
        'retry held tool',
        'retry after content',
        'round target 400',
      ] as const) {
        scenario(
          `callback-boundary: a newer primary supersedes the ${phase}`,
          async (session, mock, directory) => {
            // The stock prompt loop waits for this turn to finish. Send the new
            // turn through the same provider callback while the mock holds it.
            const beginNewer = async () => {
              const newer = await session.newerPrimary!(
                'Newer primary while the original is held.',
              )
              expect(JSON.stringify(newer)).toContain(
                'Newer callback completed.',
              )
              expect(JSON.stringify(newer)).not.toContain(sentinel)
            }
            const prefix = block('Older source prefix.')
            const tail = block('Older target content.')
            const oldRefuses =
              phase !== 'retry after content' && phase !== 'round target 400'
            mock.queue.push(
              reply([prefix], {
                stop: 'refusal',
                claim: true,
                credit: sentinel,
                beforeStop:
                  phase === 'source terminal' ? beginNewer : undefined,
              }),
            )
            switch (phase) {
              case 'wrong-model 400':
                mock.queue.push(async () => {
                  await beginNewer()
                  return Response.json(
                    {
                      type: 'error',
                      error: {
                        type: 'invalid_request_error',
                        message:
                          'fallback_credit_token: is not valid for model',
                      },
                    },
                    { status: 400 },
                  )
                })
                break
              case 'retry first content':
              case 'retry after content':
              case 'round target 400':
                mock.queue.push(
                  reply([tail], {
                    credited: true,
                    beforeContent:
                      phase === 'retry first content' ? beginNewer : undefined,
                    beforeStop:
                      phase === 'retry after content' ? beginNewer : undefined,
                  }),
                )
                break
              case 'retry held tool':
                mock.queue.push((body) =>
                  fixtureStream({
                    model: String(body.model),
                    content: [tool(body, directory, openToolId, true), tail],
                    stop: 'end_turn',
                    credited: true,
                    beforeBlock: async (index) => {
                      if (index === 1) await beginNewer()
                    },
                  }),
                )
                break
            }
            if (phase === 'round target 400') {
              await session.prompt(
                'Set up a live round before its target fails.',
              )
              mock.queue.push(async () => {
                await beginNewer()
                return Response.json(
                  {
                    type: 'error',
                    error: {
                      type: 'invalid_request_error',
                      message: 'Older target returned 400.',
                    },
                  },
                  { status: 400 },
                )
              })
            }
            mock.queue.push(reply([block('Newer callback completed.')]))
            const older = await session.prompt(
              'Original callback should not own the round afterward.',
            )
            const step = assistantSteps(host, older.stored).at(-1)
            if (phase === 'round target 400') {
              expect(mock.models()).toEqual([source, target, target, target])
              expect(JSON.stringify(older)).toContain(
                'Older target returned 400.',
              )
            } else {
              expect(mock.models()).toEqual(
                phase === 'source terminal'
                  ? [source, source]
                  : [source, target, source],
              )
              expect(step?.finish).toBe(
                oldRefuses ? finishRefusal[host] : finishSuccess[host],
              )
              expect(step?.parts).toEqual(
                oldRefuses ? [prefix.block] : [prefix.block, tail.block],
              )
              mock.queue.push(reply([block('New source prompt only.')]))
              await session.prompt('No round from the older callback.')
              expect(mock.models().at(-1)).toBe(source)
            }
            expect(await runs(directory)).toEqual([])
            expect(JSON.stringify(older)).not.toContain(sentinel)
            expect(JSON.stringify(older)).not.toContain(openToolId)
          },
          { overlap: true },
        )
      }

      scenario(
        'callback-boundary: a late 400 from the first round leaves the newer round intact',
        async (session, mock) => {
          // The stock prompt loop cannot replace the history while an older turn
          // is still awaiting its HTTP status. The real provider callback can.
          const oldReply = 'Round one target reply.'
          const otherTarget = 'claude-opus-5'
          mock.queue.push(
            reply([], { stop: 'refusal', credit: sentinel }),
            reply([block(oldReply)], { credited: true }),
          )
          await session.prompt(
            'Start the first round before the delayed error.',
          )
          mock.queue.push(
            async () => {
              const newer = await session.newerPrimary!(
                'Start a different round after editing the reply.',
                { from: oldReply, to: 'Edited history before round two.' },
              )
              expect(JSON.stringify(newer)).toContain(
                'The second round selected a different model.',
              )
              return Response.json(
                {
                  type: 'error',
                  error: {
                    type: 'invalid_request_error',
                    message: 'Delayed 400 from the first round.',
                  },
                },
                { status: 400 },
              )
            },
            reply([], { stop: 'refusal', credit: sentinel }),
            () =>
              Response.json(
                {
                  type: 'error',
                  error: {
                    type: 'invalid_request_error',
                    message: 'fallback_credit_token: is not valid for model',
                  },
                },
                { status: 400 },
              ),
            reply([block('The second round selected a different model.')], {
              credited: true,
            }),
          )
          const older = await session.prompt(
            'Leave the first round request pending.',
          )
          expect(mock.models()).toEqual([
            source,
            target,
            target,
            source,
            target,
            otherTarget,
          ])
          expect(JSON.stringify(older)).toContain(
            'Delayed 400 from the first round.',
          )
          const events = await waitForRoundEvents(session, (events) =>
            events.some(
              (event) =>
                event.kind === 'step_served' &&
                event.servingModel === otherTarget,
            ),
          )
          expect(
            events.map(({ kind, servingModel, stepsLeft, reason }) => ({
              kind,
              servingModel,
              stepsLeft,
              reason,
            })),
          ).toEqual([
            {
              kind: 'round_started',
              servingModel: target,
              stepsLeft: 9,
              reason: undefined,
            },
            {
              kind: 'step_served',
              servingModel: target,
              stepsLeft: 9,
              reason: undefined,
            },
            {
              kind: 'round_ended',
              servingModel: target,
              stepsLeft: 9,
              reason: 'compaction',
            },
            {
              kind: 'round_started',
              servingModel: otherTarget,
              stepsLeft: 19,
              reason: undefined,
            },
            {
              kind: 'step_served',
              servingModel: otherTarget,
              stepsLeft: 19,
              reason: undefined,
            },
          ])
        },
        { overlap: true },
      )

      scenario(
        'target 400 ends the round, resends once to source, and cannot retry again',
        async (session, mock) => {
          mock.queue.push(
            reply([], { stop: 'refusal', credit: sentinel }),
            reply([block('First target response.')], { credited: true }),
            () =>
              Response.json(
                {
                  type: 'error',
                  error: {
                    type: 'invalid_request_error',
                    message: 'Invalid request on target',
                  },
                },
                { status: 400 },
              ),
            reply([block('Source refused the resend.')], {
              stop: 'refusal',
              credit: sentinel,
            }),
            reply([block('Answer from source.')]),
          )
          await session.prompt('Start a round.')
          const refused = await session.prompt('Use the round, then resend.')
          expect(mock.models()).toEqual([source, target, target, source])
          expect(assistantSteps(host, refused.stored).at(-1)?.finish).toBe(
            finishRefusal[host],
          )
          expect(mock.primary[2]?.body.messages).toEqual(
            mock.primary[3]?.body.messages,
          )
          const next = await session.prompt('Stay on source after the resend.')
          expect(mock.models()).toEqual([
            source,
            target,
            target,
            source,
            source,
          ])
          expect(JSON.stringify([refused, next])).not.toContain(sentinel)
        },
      )

      scenario(
        'server mode round-trips the boundary and does not replay usage markers',
        async (session, mock) => {
          mock.server.script([
            {
              type: 'server_fallback',
              fromModel: source,
              toModel: target,
              partialText: 'Server source prefix.',
              thinkingText: 'Server target thinking.',
              text: 'Server target suffix.',
              usage: {
                input_tokens: 67,
                output_tokens: 19,
                cache_read_input_tokens: 777,
                cache_creation_input_tokens: 53,
              },
            },
          ])
          mock.queue.push(
            () => undefined,
            reply([block('Unabsorbed refusal.')], {
              stop: 'refusal',
              credit: sentinel,
            }),
            reply([block('Source stays selected.')]),
          )
          const joined = await session.prompt('Receive a server-side handoff.')
          const refused = await session.prompt('Receive an unabsorbed refusal.')
          const next = await session.prompt('Keep the original model selected.')
          expect(mock.models()).toEqual([source, source, source])
          for (const { body, headers } of mock.primary) {
            expect(body.fallbacks).toBe('default')
            expect(headers['anthropic-beta']?.split(',')).toContain(beta)
          }
          const stored = assistantSteps(host, joined.stored).at(-1)
          expect(stored?.usage).toEqual([
            host === 'oc2' ? 134 : 67,
            19,
            777,
            53,
          ])
          if (host !== 'pi') {
            const marker = stored?.parts.find(({ signature }) =>
              signature?.startsWith('cortexkit-server-fallback-usage-v1:'),
            )
            expect(marker?.signature?.split(/:(.*)/s)[1]).toBeDefined()
            expect(
              JSON.parse(
                marker!.signature!.slice(
                  'cortexkit-server-fallback-usage-v1:'.length,
                ),
              ),
            ).toEqual({
              iterations: [
                {
                  type: 'message',
                  model: source,
                  input_tokens: 67,
                  output_tokens: 0,
                },
                {
                  type: 'fallback_message',
                  model: target,
                  input_tokens: 67,
                  output_tokens: 19,
                },
              ],
            })
          }
          const replay = partsOnWire(mock.primary[1]!.body)
            .filter(({ role }) => role === 'assistant')
            .map(({ part }) => part)
          expect(replay.map(({ type }) => type)).toEqual([
            'text',
            'fallback',
            'thinking',
            'text',
          ])
          expect(replay[1]).toEqual({
            type: 'fallback',
            from: { model: source },
            to: { model: target },
          })
          expect(replay[2]).toMatchObject({
            type: 'thinking',
            thinking: 'Server target thinking.',
            signature: 'mock-target-thinking-signature',
          })
          expect(JSON.stringify(mock.primary[1])).not.toContain(
            'cortexkit-server-fallback-usage-v1:',
          )
          expect(assistantSteps(host, refused.stored).at(-1)?.finish).toBe(
            finishRefusal[host],
          )
          expect(JSON.stringify([joined, refused, next])).not.toContain(
            sentinel,
          )
        },
        { mode: 'server' },
      )

      scenario(
        'off mode leaves the refusal and ordinary parts intact, without a retry',
        async (session, mock) => {
          mock.queue.push(
            reply(
              [
                { block: thinking(source) },
                block('Ordinary text before refusal.'),
              ],
              {
                stop: 'refusal',
                credit: sentinel,
                claim: true,
              },
            ),
            reply([block('Source again.')]),
          )
          const refused = await session.prompt(
            'Refuse without a client or server fallback.',
          )
          const next = await session.prompt('Stay on the source.')
          expect(mock.models()).toEqual([source, source])
          for (const { body, headers } of mock.primary) {
            expect(body).not.toHaveProperty('fallbacks')
            expect(headers['anthropic-beta']?.split(',')).toContain(beta)
          }
          expect(assistantSteps(host, refused.stored).at(-1)).toEqual({
            finish: finishRefusal[host],
            usage: [11, 17, 5, 222],
            parts: [
              {
                type: 'thinking',
                text: thinking(source).thinking,
                signature: thinking(source).signature,
              },
              text('Ordinary text before refusal.'),
            ],
          })
          expect(JSON.stringify([refused, next])).not.toContain(sentinel)
        },
        { mode: 'off' },
      )

      for (const mode of ['server', 'off'] as const) {
        scenario(
          `${mode} mode ${mode === 'server' ? 'continues' : 'keeps the refusal for'} a completed tool`,
          async (session, mock, directory) => {
            mock.queue.push((body) =>
              fixtureStream({
                model: String(body.model),
                content: [tool(body, directory, completedToolId)],
                stop: 'refusal',
                credit: sentinel,
              }),
            )
            if (mode === 'server')
              mock.queue.push(reply([block('Server tool continuation.')]))
            const result = await session.prompt(
              'A completed call arrives before the refusal.',
            )
            expect(mock.models()).toEqual(
              mode === 'server' ? [source, source] : [source],
            )
            expect(
              assistantSteps(host, result.stored).map(({ finish }) => finish),
            ).toEqual(
              mode === 'server'
                ? [finishTool[host], finishSuccess[host]]
                : [finishRefusal[host]],
            )
            expect(await runs(directory)).toEqual(
              // OpenCode executes complete calls even on the untouched refusal;
              // Pi executes them only when the stop reason permits continuation.
              mode === 'server' || host !== 'pi' ? [completedToolId] : [],
            )
            expect(JSON.stringify(result)).not.toContain(sentinel)
          },
          { mode },
        )
      }

      scenario(
        'wrong-model 400 spends the sentinel credit only once on each target',
        async (session, mock) => {
          mock.queue.push(
            reply([], { stop: 'refusal', credit: sentinel }),
            () =>
              Response.json(
                {
                  type: 'error',
                  error: {
                    type: 'invalid_request_error',
                    message: 'fallback_credit_token: is not valid for model',
                  },
                },
                { status: 400 },
              ),
            reply([block('The second target accepted the credit.')], {
              credited: true,
            }),
            reply([block('A later round request uses no credit.')]),
          )
          const first = await session.prompt(
            'Try two targets in the same host request.',
          )
          const next = await session.prompt('Stay on the second target.')
          expect(mock.models()).toEqual([
            source,
            target,
            'claude-opus-5',
            'claude-opus-5',
          ])
          expect(
            mock.primary.map(({ body }) => body.fallback_credit_token),
          ).toEqual([undefined, sentinel, sentinel, undefined])
          expect(JSON.stringify([first, next])).not.toContain(sentinel)
        },
      )

      scenario(
        'a failed credited retry quoting its token leaves only the placeholder in dumps',
        async (session, mock) => {
          const placeholder = 'cortexkit-redacted-fallback-credit-token'
          mock.queue.push(
            reply([block('Source refusal before the failed retry.')], {
              stop: 'refusal',
              credit: sentinel,
              claim: true,
            }),
            () =>
              Response.json(
                {
                  type: 'error',
                  error: {
                    type: 'overloaded_error',
                    message: `Rejected credit ${sentinel}`,
                  },
                },
                { status: 529 },
              ),
            reply([block('A later source request.')]),
          )
          const refused = await session.prompt(
            'Request the retry that fails before content.',
          )
          const next = await session.prompt(
            'The failed retry must not start a round.',
          )
          expect(mock.models()).toEqual([source, target, source])
          expect(
            mock.primary.map(({ body }) => body.fallback_credit_token),
          ).toEqual([undefined, sentinel, undefined])
          expect(assistantSteps(host, refused.stored).at(-1)?.finish).toBe(
            finishRefusal[host],
          )
          expect(JSON.stringify([refused, next])).not.toContain(sentinel)
          const deadline = Date.now() + 5_000
          let dumps: Awaited<
            ReturnType<NonNullable<HostSession['readDumps']>>
          > = []
          while (Date.now() < deadline) {
            dumps = await session.readDumps!()
            if (
              dumps.some(
                ({ name, content }) =>
                  name.endsWith('.body.json') && content.includes(placeholder),
              ) &&
              dumps.some(({ name }) => name.endsWith('.response.json'))
            )
              break
            await Bun.sleep(75)
          }
          for (const dump of dumps)
            expect(dump.content, dump.name).not.toContain(sentinel)
          const inventory = dumps.map(({ name, content }) => ({
            name,
            hasPlaceholder: content.includes(placeholder),
          }))
          expect(inventory).toContainEqual(
            expect.objectContaining({
              name: expect.stringMatching(/\.body\.json$/),
              hasPlaceholder: true,
            }),
          )
          expect(inventory).toContainEqual(
            expect.objectContaining({
              name: expect.stringMatching(/\.response\.json$/),
            }),
          )
          expect(await session.readDiagnostics!()).not.toContain(sentinel)
        },
        { dump: true },
      )

      scenario(
        'switching off a live round returns to source and emits an early end',
        async (session, mock) => {
          mock.queue.push(
            reply([], { stop: 'refusal', credit: sentinel }),
            reply([block('Serving on target.')], { credited: true }),
          )
          await session.prompt('Install a live recovery round.')
          await session.policy!.settings({ refusal_fallback: 'off' })
          await Bun.sleep(500)
          mock.queue.push(
            reply([block('The source answers after switching off.')]),
          )
          await session.prompt('Exit the recovery round on the next request.')
          expect(mock.models()).toEqual([source, target, source])
          expect(await waitForRoundEnd(session, 'mode')).toMatchObject([
            {
              kind: 'round_started',
              stepsLeft: 9,
              requestedModel: source,
              servingModel: target,
              category: 'cyber',
            },
            { kind: 'step_served', stepsLeft: 9 },
            { kind: 'round_ended', reason: 'mode' },
          ])
        },
      )

      for (const credited of [true, false]) {
        for (const fits of [true, false]) {
          scenario(
            `first round request ${fits ? 'fits' : 'overflows'} after a ${credited ? 'credited prefill' : 'cold'} retry`,
            async (session, mock) => {
              const prefix = credited ? 'Source prefix. ' : ''
              const completion = 'Accepted target text.'
              // Pi reserves 4,096 tokens using its own character-based estimate.
              // The UTF-8 suffix exceeds that reserve without reducing its budget.
              const follow =
                host === 'pi'
                  ? '界'.repeat(10_000)
                  : 'Check window estimate: π and 🚲.'.repeat(12)
              const appended = [
                { role: 'assistant', content: [text(prefix + completion)] },
                { role: 'user', content: [text(follow)] },
              ]
              const appendedTokens =
                Buffer.byteLength(JSON.stringify(appended)) / 4
              let roundBudget: number | undefined
              mock.queue.push(
                reply(prefix ? [block(prefix)] : [], {
                  stop: 'refusal',
                  credit: credited ? sentinel : undefined,
                  claim: credited,
                }),
                (body, request) => {
                  // Pi's in-step retry uses its initial budget, whereas the next
                  // agent-loop request uses Pi's 32 Ki-token default.
                  roundBudget = host === 'pi' ? 32_768 : Number(body.max_tokens)
                  return reply([block(completion)], {
                    credited,
                    usage: {
                      input_tokens:
                        Math.floor(1_000_000 - roundBudget - appendedTokens) +
                        (fits ? 0 : 1) -
                        29,
                      cache_read_input_tokens: 23,
                      cache_creation_input_tokens: 6,
                    },
                  })(body, request)
                },
                reply([block('Window check complete.')]),
              )
              const joined = await session.prompt(
                'Start a round near the target’s limit.',
              )
              const next = await session.prompt(follow)
              expect(mock.models()).toEqual([
                source,
                target,
                fits ? target : source,
              ])
              const [refused, retry, after] = mock.primary.map(
                ({ body }) => body,
              )
              if (host === 'pi') expect(retry?.max_tokens).toBe(128_000)
              if (fits) expect(after?.max_tokens).toBe(roundBudget!)
              expect(retry?.fallback_credit_token).toBe(
                credited ? sentinel : undefined,
              )
              expect(retry?.messages).toEqual(
                credited
                  ? [
                      ...(refused!.messages as unknown[]),
                      { role: 'assistant', content: [text(prefix)] },
                    ]
                  : refused?.messages,
              )
              expect(
                matchesRefusalCredit(
                  refused!,
                  retry!,
                  prefix ? [text(prefix)] : [],
                ),
              ).toBe(true)
              expect(partsOnWire(after!).at(-1)).toMatchObject({
                role: 'user',
                part: text(follow),
              })
              expect(JSON.stringify([joined, next])).not.toContain(sentinel)
            },
          )
        }
      }

      for (const start of ['credited prefill', 'released tool'] as const) {
        for (const edited of [false, true]) {
          scenario(
            `latest reply ${edited ? 'edit ends' : 'append preserves'} the round after ${start}`,
            async (session, mock, directory) => {
              const original = 'Original latest target text.'
              const replacement = 'Edited latest target text.'
              if (start === 'released tool') {
                mock.queue.push((body) =>
                  fixtureStream({
                    model: String(body.model),
                    content: [tool(body, directory, completedToolId)],
                    stop: 'refusal',
                    credit: sentinel,
                  }),
                )
              } else {
                mock.queue.push(
                  reply([block('Source prefix.')], {
                    stop: 'refusal',
                    claim: true,
                    credit: sentinel,
                  }),
                )
              }
              mock.queue.push(
                reply(
                  [
                    ...(host === 'pi'
                      ? [
                          block('Keep the text before unsigned thinking.'),
                          {
                            block: {
                              type: 'thinking',
                              thinking: 'Unsigned target thinking fixture',
                            },
                            open: true,
                          },
                        ]
                      : []),
                    block(original),
                  ],
                  { credited: start === 'credited prefill' },
                ),
              )
              const startOutcome = await session.prompt(
                'Start a round and store the latest reply.',
              )
              expect(
                assistantSteps(host, startOutcome.stored).at(-1)?.parts,
              ).toContainEqual(text(original))
              if (edited) await session.editReply!(original, replacement)
              mock.queue.push(
                reply([block('Reply after the latest history check.')]),
              )
              await session.prompt('Append a new user turn.')
              expect(mock.models()).toEqual([
                source,
                target,
                edited ? source : target,
              ])
              const messages = partsOnWire(mock.primary.at(-1)!.body)
                .filter(({ role }) => role === 'assistant')
                .map(({ part }) => part)
              const thread = mock.primary.at(-1)!.body.thread as
                | { type?: string }
                | undefined
              if (thread?.type === 'continue') {
                expect(edited).toBe(false)
              } else {
                expect(
                  messages.some(
                    (part) =>
                      part.type === 'text' &&
                      part.text?.includes(edited ? replacement : original),
                  ),
                ).toBe(true)
              }
              expect(JSON.stringify(messages)).not.toContain(
                'Unsigned target thinking fixture',
              )
              expect(await runs(directory)).toEqual(
                start === 'released tool' ? [completedToolId] : [],
              )
            },
          )
        }
      }

      scenario(
        'ten target steps, then the first source request reads a kept prefix older than 20 blocks',
        async (session, mock) => {
          const prefix =
            'Kept source prefix: never replace this with the refused suffix.'
          const refused = 'Different user content on the refused request.'
          const mark = (body: Body) =>
            partsOnWire(body).find(
              ({ role, part }) => role === 'user' && part.text === prefix,
            )?.part.cache_control
          const firstRead = 8_784
          mock.queue.push(reply([block('Accepted source answer.')]))
          await session.prompt(prefix)
          const cached = mark(mock.primary[0]!.body)
          expect(cached).toMatchObject({ type: 'ephemeral' })
          mock.queue.push(reply([], { stop: 'refusal', credit: sentinel }))
          for (let step = 0; step < 10; step++) {
            mock.queue.push(
              reply(
                [
                  {
                    block: {
                      ...thinking(target),
                      signature: `target-round-${step}-a`,
                    },
                  },
                  block(`Target reply ${step}, first block.`),
                  {
                    block: {
                      ...thinking(target),
                      signature: `target-round-${step}-b`,
                    },
                  },
                  block(`Target reply ${step}, last block.`),
                ],
                { credited: step === 0 },
              ),
            )
          }
          await session.prompt(refused)
          for (let step = 1; step < 10; step++)
            await session.prompt(`Keep going through target step ${step}.`)
          expect(mock.models()).toEqual([
            source,
            source,
            ...Array(10).fill(target),
          ])
          mock.queue.push((body) =>
            reply([block('Source return.')], {
              usage: {
                input_tokens: 53,
                cache_creation_input_tokens: 0,
                cache_read_input_tokens: mark(body) ? firstRead : 0,
              },
            })(body, mock.primary.at(-1)!),
          )
          const restored = await session.prompt(
            'Return to the requested model.',
          )
          expect(mock.models().at(-1)).toBe(source)
          const returned = mock.primary.at(-1)!.body
          expect(mark(returned)).toEqual(cached)
          expect(
            wireHistory(returned).filter(
              ({ type, text }) =>
                type === 'thinking' || text?.startsWith('Target reply'),
            ),
          ).toHaveLength(40)
          expect(assistantSteps(host, restored.stored).at(-1)?.usage?.[2]).toBe(
            firstRead,
          )
          const events = await waitForRoundEnd(session, 'count')
          expect(
            events
              .filter(({ kind }) => kind === 'step_served')
              .map(({ stepsLeft }) => stepsLeft),
          ).toEqual([9, 8, 7, 6, 5, 4, 3, 2, 1, 0])
          expect(
            mock.primary.filter(
              ({ body }) => body.fallback_credit_token === sentinel,
            ),
          ).toHaveLength(1)
          expect(JSON.stringify(restored)).not.toContain(sentinel)
        },
        { hybridCache: true },
      )

      scenario(
        'source replay removes target thinking and a second round does not restore it',
        async (session, mock) => {
          const sign = (model: string, id: string) => ({
            block: { ...thinking(model), signature: id },
          })
          const s1 = sign(source, 'source-signed-round-one')
          const t1 = sign(target, 'target-signed-round-one')
          const s2 = sign(source, 'source-signed-round-two')
          const t2 = sign(target, 'target-signed-round-two')
          const signatureList = ({ body }: CapturedAnthropicRequest) =>
            wireHistory(body).flatMap(({ signature }) =>
              signature ? [signature] : [],
            )
          const badTarget: Step = () =>
            Response.json(
              {
                type: 'error',
                error: {
                  type: 'invalid_request_error',
                  message: 'Invalid target request',
                },
              },
              { status: 400 },
            )
          mock.queue.push(
            reply([s1, block('Source one.')], {
              stop: 'refusal',
              claim: true,
              credit: sentinel,
            }),
            reply([t1, block('Target one.')], { credited: true }),
            badTarget,
            reply([block('Back to source.')]),
            reply([s2, block('Source two.')], {
              stop: 'refusal',
              claim: true,
              credit: sentinel,
            }),
            reply([t2, block('Target two.')], { credited: true }),
            reply([block('Second round stays live.')]),
          )
          const first = await session.prompt(
            'Start round one with source thinking.',
          )
          await session.prompt('End round one on a target 400.')
          const second = await session.prompt(
            'Start round two with source thinking.',
          )
          await session.prompt('Continue round two.')
          expect(mock.models()).toEqual([
            source,
            target,
            target,
            source,
            source,
            target,
            target,
          ])
          expect(mock.primary.slice(2, 7).map(signatureList)).toEqual([
            [s1.block.signature, t1.block.signature],
            [s1.block.signature],
            [s1.block.signature],
            [s1.block.signature, s2.block.signature],
            [s1.block.signature, s2.block.signature, t2.block.signature],
          ])
          expect(wireHistory(mock.primary[6]!.body).slice(0, 4)).toEqual(
            wireHistory(mock.primary[5]!.body).slice(0, 4),
          )
          if (session.restart) {
            await session.restart()
            mock.queue.push(reply([block('Source after restart.')]))
            await session.prompt('Return to the source after restart.')
            expect(mock.models().at(-1)).toBe(source)
            expect(signatureList(mock.primary.at(-1)!)).toEqual([
              s1.block.signature,
              s2.block.signature,
            ])
          }
          expect(JSON.stringify([first, second])).not.toContain(sentinel)
        },
      )
    },
  )
}
