import { afterEach, expect, test } from 'bun:test'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { E2EHarness } from '../src/harness.ts'

const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6T3sAAAAASUVORK5CYII='
const cases = [
  {
    name: 'off',
    mural: false,
    delta: '<session-history-since>history</session-history-since>',
  },
  {
    name: 'history',
    mural: true,
    delta: '<session-history-since>history</session-history-since>',
  },
  {
    name: 'memory updates',
    mural: true,
    delta: '<memory-updates>delta</memory-updates>',
  },
  { name: 'placeholder', mural: true, delta: 'No additional history.' },
]

let harness: E2EHarness | null = null

afterEach(async () => {
  const finished = harness
  harness = null
  await finished?.dispose()
})

type WireBlock = {
  type: string
  text?: string
  source?: { type?: string; media_type?: string; data?: string }
  cache_control?: unknown
}

test('anchors the mural and following delta after real OpenCode message lowering', async () => {
  harness = await E2EHarness.create({
    hybridCache: true,
    beforeSpawn: async (env) => {
      const configPath = join(env.configDir, 'opencode.json')
      const config = JSON.parse(await readFile(configPath, 'utf8'))
      const fixturePath = join(env.configDir, 'mural-prefix.mjs')
      await writeFile(
        fixturePath,
        `const cases = ${JSON.stringify(cases)}
export default async () => ({
  'experimental.chat.messages.transform': async (_input, output) => {
    const current = output.messages.findLast((message) => message.info.role === 'user')
    const part = current?.parts.find((part) => part.type === 'text')
    const selected = cases.find((entry) => part?.text === 'mural wire fixture: ' + entry.name)
    if (!selected) return
    const baseId = current.info.id + '_base'
    const deltaId = current.info.id + '_delta'
    const baseText = '<project-docs>stable docs</project-docs>' + (selected.mural ? '\\n<memory-mural>The project memory mural image follows.</memory-mural>' : '')
    const base = {
      info: { ...current.info, id: baseId, syntheticHead: true },
      parts: [
        { ...part, id: part.id + '_base', messageID: baseId, text: baseText, synthetic: true },
        ...(selected.mural ? [{ id: part.id + '_image', sessionID: current.info.sessionID, messageID: baseId, type: 'file', mime: 'image/png', url: 'data:image/png;base64,${PNG}', synthetic: true }] : []),
      ],
    }
    const delta = {
      info: { ...current.info, id: deltaId, syntheticHead: true },
      parts: [{ ...part, id: part.id + '_delta', messageID: deltaId, text: selected.delta, synthetic: true }],
    }
    output.messages.unshift(base, delta)
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
  expect(((await health.json()) as { version: string }).version).toMatch(/^1\./)

  for (const entry of cases) {
    const prompt = `mural wire fixture: ${entry.name}`
    current.script([
      { type: 'text', text: 'Wire fixture completed.' },
      { type: 'text', text: 'Wire fixture continued.' },
    ])
    const sessionId = await current.createSession()
    const result = await current.sendPrompt(sessionId, prompt)
    expect(JSON.stringify(result)).toContain('Wire fixture completed.')
    await current.sendPrompt(sessionId, prompt)
    const requests = current.anthropic.requests().filter((request) => {
      const body = JSON.stringify(request.body)
      return (
        request.body.max_tokens !== 0 &&
        body.includes(prompt) &&
        !body.includes('Generate a title for this conversation')
      )
    })
    expect(requests).toHaveLength(2)
    const request = requests[1]
    if (!request) throw new Error('No generation request reached the mock')
    const body = request.body
    const messages = body.messages as Array<{
      role: string
      content: WireBlock[]
    }>
    const firstMessage = messages[0]
    if (!firstMessage) throw new Error('No first message reached the mock')
    expect(firstMessage.role).toBe('user')
    const content = firstMessage.content
    expect(content.map((block) => block.type)).toEqual(
      entry.mural
        ? ['text', 'image', 'text', 'text']
        : ['text', 'text', 'text'],
    )
    const deltaIndex = entry.mural ? 2 : 1
    expect(content[deltaIndex]?.text).toBe(entry.delta)
    const control = { type: 'ephemeral', ttl: '1h' }
    expect(content[deltaIndex]?.cache_control).toEqual(control)
    if (entry.mural) {
      expect(content[0]?.cache_control).toBeUndefined()
      expect(content[1]?.cache_control).toEqual(control)
      expect(content[1]?.source).toEqual({
        type: 'base64',
        media_type: 'image/png',
        data: PNG,
      })
    } else {
      expect(content[0]?.cache_control).toEqual(control)
    }
    // OpenCode merges the injected records with the first real user. That
    // older user's text is not a prefix cache boundary; the user after the
    // completed assistant owns the separate moving anchor.
    expect(content.at(-1)?.text).toBe(prompt)
    expect(content.at(-1)?.cache_control).toBeUndefined()
    const latest = messages.at(-1)
    expect(latest?.role).toBe('user')
    expect(latest?.content).toHaveLength(1)
    expect(latest?.content[0]?.cache_control).toEqual(control)
    const systems = body.system as Array<{ cache_control?: unknown }>
    expect(systems.filter((block) => block.cache_control)).toHaveLength(1)
    expect(content.filter((block) => block.cache_control)).toHaveLength(2)
    expect(body.cache_control).toBeUndefined()
  }
}, 120_000)
