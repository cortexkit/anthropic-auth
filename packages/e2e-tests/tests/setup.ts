import { beforeEach } from 'bun:test'

// These tests call Core in this process (fixture preparation, relay reads)
// with account stores in temporary folders chosen with environment variables,
// never in the operating system account's default place. Skip the relay
// location check for them, as the Core, OpenCode and Pi test preloads do; the
// OpenCode processes they start get the same setting from a test plugin.
const RELAY_ACCOUNT_HOME = Symbol.for(
  'cortexkit.anthropic-auth.test-only.relay-account-home',
)
const relayAccountHome = globalThis as Record<symbol, unknown>
relayAccountHome[RELAY_ACCOUNT_HOME] = 'unchecked'
beforeEach(() => {
  relayAccountHome[RELAY_ACCOUNT_HOME] = 'unchecked'
})
