import { afterEach, expect, test } from 'bun:test'
import { pathToFileURL } from 'node:url'
import {
  buildPiOAuthMessagesUrl,
  fetchPiOAuth,
  requirePiOAuthOrigin,
} from '../transport.ts'

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

test.each([
  'https://unapproved.invalid',
  'http://api.anthropic.com',
  'https://api.anthropic.com:8443',
  'https://user:secret@api.anthropic.com',
  'blob:https://api.anthropic.com/opaque',
  'not a URL',
])('native OAuth URL parser refuses recipient %s', (url) => {
  expect(() => requirePiOAuthOrigin(url)).toThrow(
    'official Anthropic HTTPS origin',
  )
})

test('official versioned and default-port OAuth URLs keep the fixed Messages path', () => {
  expect(buildPiOAuthMessagesUrl('https://api.anthropic.com/v1').href).toBe(
    'https://api.anthropic.com/v1/messages?beta=true',
  )
  expect(buildPiOAuthMessagesUrl('HTTPS://API.ANTHROPIC.COM:443').href).toBe(
    'https://api.anthropic.com/v1/messages?beta=true',
  )
})

test('guarded OAuth fetch overrides caller redirect-follow and refuses foreign recipients without dispatch', async () => {
  const sent: Array<{ url: string; redirect: RequestInit['redirect'] }> = []
  globalThis.fetch = Object.assign(
    async (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      sent.push({ url: String(input), redirect: init?.redirect })
      return new Response('{}')
    },
    { preconnect: originalFetch.preconnect },
  )
  await fetchPiOAuth('https://api.anthropic.com/api/oauth/profile', {
    redirect: 'follow',
  })
  await expect(
    fetchPiOAuth('https://unapproved.invalid/profile'),
  ).rejects.toThrow('official Anthropic HTTPS origin')
  expect(sent).toEqual([
    { url: 'https://api.anthropic.com/api/oauth/profile', redirect: 'error' },
  ])
})

test('Node Pi gzip cuts retain physical encoded bytes across concurrent same-URL fetches', async () => {
  // Bun rejects truncated gzip instead of exposing Node's clean, zero-byte EOF.
  const child = Bun.spawn(
    [
      Bun.which('node')!,
      '--experimental-transform-types',
      '--input-type=module',
      '-e',
      `
import { createServer } from 'node:http'
import { performance } from 'node:perf_hooks'
import { gzipSync } from 'node:zlib'
import { fetchPiStreamResponse } from ${JSON.stringify(pathToFileURL(`${import.meta.dir}/../transport.ts`).href)}
import { createAnthropicStreamCompletion, createProviderErrorResponseScope } from '@cortexkit/anthropic-auth-core'
// A full global timeline must not prevent per-fetch observers from working.
performance.setResourceTimingBufferSize(1)
const header = Buffer.from('1f8b0800000000000003', 'hex')
const warm = gzipSync('data: {"type":"message_stop"}\\n\\n')
const server = createServer((request, response) => {
  response.writeHead(200, { 'content-type': 'text/event-stream', 'content-encoding': 'gzip', 'transfer-encoding': 'chunked' })
  response.flushHeaders()
  const scenario = request.headers['x-scenario']
  setTimeout(() => response.end(scenario === 'header' ? header : scenario === 'warm' ? warm : undefined), scenario === 'header' ? 30 : 5)
})
server.listen(0, '127.0.0.1')
await new Promise(resolve => server.once('listening', resolve))
const url = 'http://127.0.0.1:' + server.address().port + '/v1/messages'
async function consume(scenario) {
  const physical = await fetchPiStreamResponse(url, { headers: { 'x-scenario': scenario } })
  const response = createProviderErrorResponseScope([], 'event-stream').redactResponse(physical)
  const completion = createAnthropicStreamCompletion(response)
  for await (const chunk of response.body) completion.push(chunk)
  const error = completion.finish()
  return error ? { code: error.code, message: error.message, diagnostics: error.diagnostics } : null
}
try {
  await consume('warm')
  const results = await Promise.all([consume('header'), consume('empty'), consume('warm')])
  const unmatched = await fetchPiStreamResponse(url, {}, async () => new Response(''))
  const unknown = createAnthropicStreamCompletion(unmatched).finish().diagnostics
  await unmatched.body.cancel()
  console.log(JSON.stringify({ results, unknown, bufferSize: performance.getEntriesByType('resource').length }))
} finally {
  server.close()
  server.closeAllConnections()
}
`,
    ],
    { cwd: import.meta.dir, stdout: 'pipe', stderr: 'pipe' },
  )
  const deadline = setTimeout(() => child.kill(), 15_000)
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect({ exitCode, stderr: exitCode === 0 ? '' : stderr }).toEqual({
      exitCode: 0,
      stderr: '',
    })
    const { results, unknown, bufferSize } = JSON.parse(stdout.trim())
    expect(results[0]).toMatchObject({
      code: 'ECONNRESET',
      message:
        'Anthropic connection reset: stream ended before message_stop (ECONNRESET)',
      diagnostics: {
        encoded_body_bytes: 10,
        decoded_body_bytes: 0,
        response_bytes: 0,
        sse_events: 0,
      },
    })
    expect(results[1].diagnostics).toMatchObject({
      encoded_body_bytes: 0,
      decoded_body_bytes: 0,
      response_bytes: 0,
      sse_events: 0,
    })
    expect(results[2]).toBeNull()
    expect(unknown).not.toHaveProperty('encoded_body_bytes')
    expect(unknown).not.toHaveProperty('decoded_body_bytes')
    expect(bufferSize).toBe(1)
  } finally {
    clearTimeout(deadline)
    child.kill()
    await child.exited
  }
}, 20_000)
