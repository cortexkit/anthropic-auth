import { join } from 'node:path'
import { MockAnthropicServer, type MockResponse } from './mock-anthropic.ts'
import { MockRelayServer } from './mock-relay.ts'
import { type SpawnedOpencode, spawnOpencode } from './opencode-runner.ts'

type SdkClient = {
  session: {
    create: (options: {
      query: { directory: string }
      body?: Record<string, unknown>
    }) => Promise<{ data?: { id: string } }>
    prompt: (options: {
      path: { id: string }
      body: {
        model: { providerID: string; modelID: string }
        parts: Array<{ type: 'text'; text: string }>
      }
    }) => Promise<{ data?: unknown }>
    messages: (options: {
      path: { id: string }
    }) => Promise<{ data?: unknown[] }>
  }
}

export type E2EHarnessOptions = {
  relay?: 'websocket' | 'http'
  quotaFeed?: boolean
  relayResponseStartDelayMs?: number
  hybridCache?: boolean
  fallbackMode?: 'server' | 'legacy'
  childTmpDir?: string
}

export class E2EHarness {
  readonly anthropic: MockAnthropicServer
  readonly relay: MockRelayServer | null
  readonly opencode: SpawnedOpencode
  readonly client: SdkClient

  private constructor(options: {
    anthropic: MockAnthropicServer
    relay: MockRelayServer | null
    opencode: SpawnedOpencode
    client: SdkClient
  }) {
    this.anthropic = options.anthropic
    this.relay = options.relay
    this.opencode = options.opencode
    this.client = options.client
  }

  static async create(options: E2EHarnessOptions = {}) {
    const anthropic = new MockAnthropicServer()
    const { baseURL } = await anthropic.start()
    let relay: MockRelayServer | null = null
    let relayConfig:
      | { url: string; token: string; transport: 'websocket' | 'http' }
      | undefined
    if (options.relay) {
      relay = new MockRelayServer()
      const started = await relay.start({
        token: 'relay-token',
        responseStartDelayMs: options.relayResponseStartDelayMs,
      })
      relayConfig = {
        url: started.url,
        token: 'relay-token',
        transport: options.relay,
      }
    }

    const opencode = await spawnOpencode({
      anthropicBaseURL: baseURL,
      relay: relayConfig,
      hybridCache: options.hybridCache,
      fallbackMode: options.fallbackMode,
      childTmpDir: options.childTmpDir,
      quotaFeed: options.quotaFeed,
    })
    const sdk = await import('@opencode-ai/sdk')
    const client = sdk.createOpencodeClient({
      baseUrl: opencode.url,
    }) as SdkClient

    return new E2EHarness({ anthropic, relay, opencode, client })
  }

  sampleFilePath() {
    return join(this.opencode.env.workdir, 'sample.txt')
  }

  script(responses: MockResponse[]) {
    this.anthropic.script(responses)
  }

  async createSession(timeoutMs = 45_000) {
    const response = await this.withTimeout(
      this.client.session.create({
        query: { directory: this.opencode.env.workdir },
      }),
      timeoutMs,
      'session.create',
    )
    if (!response.data) {
      throw new Error(
        `session.create failed\n--- stdout ---\n${this.opencode.stdout()}\n--- stderr ---\n${this.opencode.stderr()}`,
      )
    }
    return response.data.id
  }

  async sendPrompt(
    sessionId: string,
    text: string,
    timeoutMs = 45_000,
    modelID = 'claude-sonnet-4-5',
  ) {
    const result = await this.withTimeout(
      this.client.session.prompt({
        path: { id: sessionId },
        body: {
          model: { providerID: 'anthropic', modelID },
          parts: [{ type: 'text', text }],
        },
      }),
      timeoutMs,
      'session.prompt',
    )
    return result
  }

  async waitForSessionText(
    sessionId: string,
    text: string,
    timeoutMs = 30_000,
  ) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const response = await this.client.session.messages({
        path: { id: sessionId },
      })
      if (JSON.stringify(response.data ?? []).includes(text))
        return response.data
      await Bun.sleep(100)
    }
    throw new Error(
      `session notification not found: ${text}\n--- stdout ---\n${this.opencode.stdout()}\n--- stderr ---\n${this.opencode.stderr()}`,
    )
  }

  private async withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    label: string,
  ) {
    let timeout: ReturnType<typeof setTimeout> | undefined
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeout = setTimeout(
        () =>
          reject(
            new Error(
              `${label} timed out\n--- stdout ---\n${this.opencode.stdout()}\n--- stderr ---\n${this.opencode.stderr()}`,
            ),
          ),
        timeoutMs,
      )
    })
    try {
      return await Promise.race([promise, timeoutPromise])
    } finally {
      if (timeout) clearTimeout(timeout)
    }
  }

  async waitFor<T>(
    predicate: () => T | false | null | undefined,
    options: { timeoutMs?: number; intervalMs?: number; label?: string } = {},
  ): Promise<T> {
    const timeoutMs = options.timeoutMs ?? 10_000
    const intervalMs = options.intervalMs ?? 100
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const value = predicate()
      if (value) return value
      await Bun.sleep(intervalMs)
    }
    throw new Error(
      `waitFor timed out${options.label ? ` (${options.label})` : ''}\n--- stdout ---\n${this.opencode.stdout()}\n--- stderr ---\n${this.opencode.stderr()}`,
    )
  }

  async dispose() {
    await this.opencode.kill()
    await this.relay?.stop()
    await this.anthropic.stop()
  }
}
