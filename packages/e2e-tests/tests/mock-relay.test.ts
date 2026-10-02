import { expect, test } from 'bun:test'
import { MockRelayServer } from '../src/mock-relay.ts'

test('mock relay exclusively owns its advertised IPv4 endpoint', async () => {
  const relay = new MockRelayServer()
  const { port, url } = await relay.start()
  let duplicate: ReturnType<typeof Bun.serve> | undefined
  let refusal: unknown
  try {
    try {
      duplicate = Bun.serve({
        hostname: '127.0.0.1', port,
        fetch: () => new Response('wrong listener'),
      })
    } catch (error) {
      refusal = error
    }
    // A wildcard IPv6 listener permits this second IPv4 bind on macOS, so
    // requests can reach the wrong server despite using the advertised port.
    expect(duplicate).toBeUndefined()
    expect(refusal).toHaveProperty('code', 'EADDRINUSE')
    const response = await fetch(url)
    expect(response.status).toBe(404)
    expect(await response.text()).toBe('not found')
  } finally {
    await duplicate?.stop(true)
    await relay.stop()
  }
})
