import { afterEach, expect, test } from 'bun:test'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { E2EHarness } from '../src/harness.ts'

let harness: E2EHarness | null = null

afterEach(async () => {
  const finished = harness
  harness = null
  await finished?.dispose()
})

test('refuses a completed assistant tail after a downstream transform removes the newest user', async () => {
  let tracePath = ''
  harness = await E2EHarness.create({
    beforeSpawn: async (env) => {
      const configPath = join(env.configDir, 'opencode.json')
      const config = JSON.parse(await readFile(configPath, 'utf8'))
      const fixturePath = join(env.configDir, 'empty-newest-user.mjs')
      tracePath = join(env.configDir, 'empty-newest-user-fired.json')
      await writeFile(
        fixturePath,
        `import { writeFile } from 'node:fs/promises'
export const EmptyNewestUser = async () => ({
  'experimental.chat.messages.transform': async (_input, output) => {
    const latestUser = output.messages.findLast((message) => message.info.role === 'user')
    if (!latestUser?.parts.some((part) => part.type === 'text' && part.text === 'empty newest user boundary fixture')) return
    const latestAssistant = output.messages.findLast((message) => message.info.role === 'assistant')
    await writeFile(${JSON.stringify(tracePath)}, JSON.stringify({
      assistantFinish: latestAssistant?.info.finish,
      assistantTextLengths: latestAssistant?.parts.filter((part) => part.type === 'text').map((part) => part.text.length),
      userPartsBefore: latestUser.parts.length,
    }))
    latestUser.parts = []
  },
})
`,
      )
      config.plugin = [pathToFileURL(fixturePath).href, ...config.plugin]
      await writeFile(configPath, JSON.stringify(config))
    },
  })
  const current = harness
  const health = await fetch(`${current.opencode.url}/global/health`)
  expect(health.status).toBe(200)
  const host = (await health.json()) as { version?: string }
  expect(host.version).toMatch(/^1\./)
  current.script([
    { type: 'text', text: 'Completed original answer.' },
    { type: 'text', text: 'Unsafe replay must not reach this response.' },
  ])
  const sessionId = await current.createSession()
  const first = await current.sendPrompt(
    sessionId,
    'Answer the original synthetic question.',
    45_000,
    'claude-opus-5-5',
  )
  expect(JSON.stringify(first.data)).toContain('Completed original answer.')

  const failure = await current.sendPrompt(
    sessionId,
    'empty newest user boundary fixture',
    45_000,
    'claude-opus-5-5',
  )
  const trace = JSON.parse(await readFile(tracePath, 'utf8')) as {
    assistantFinish: string
    assistantTextLengths: number[]
    userPartsBefore: number
  }
  expect(trace.assistantFinish).toBe('stop')
  expect(trace.assistantTextLengths.some((length) => length > 0)).toBe(true)
  expect(trace.userPartsBefore).toBeGreaterThan(0)

  const generations = current.anthropic
    .requests()
    .filter(
      (request) =>
        request.body.model === 'claude-opus-5-5' &&
        request.body.max_tokens !== 0 &&
        !JSON.stringify(request.body).includes(
          'Generate a title for this conversation',
        ),
    )
  expect(generations).toHaveLength(1)

  const info = (
    failure.data as
      | {
          info?: {
            error?: {
              name?: string
              data?: {
                statusCode?: number
                isRetryable?: boolean
                message?: string
              }
            }
          }
        }
      | undefined
  )?.info
  expect(info?.error?.name).toBe('APIError')
  expect(info?.error?.data?.statusCode).toBe(400)
  expect(info?.error?.data?.isRetryable).toBe(false)
  expect(info?.error?.data?.message).toContain('assistant')
  expect(JSON.stringify(failure.data)).not.toContain(
    'Unsafe replay must not reach this response.',
  )

  const statuses = await current.client.session.status()
  expect(statuses.data).toBeDefined()
  expect(statuses.data?.[sessionId]?.type).not.toBe('retry')
}, 90_000)
