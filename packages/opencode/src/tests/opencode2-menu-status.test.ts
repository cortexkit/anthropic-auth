import { expect, test } from 'bun:test'
import type {
  NativeAccountRuntime,
  NativeAccountSnapshot,
} from '@cortexkit/anthropic-auth-core'
import type { Plugin } from '@opencode/plugin/tui'
import { createNativeMenuCapabilities } from '../v2/menu'
import type { NativeSource } from '../v2/source'
import { setupAnthropicTui } from '../v2/tui'

const GUIDANCE_COMMAND =
  'opencode auth login anthropic --method native-claude-oauth'

const statusFor = async (snapshot: NativeAccountSnapshot) => {
  const capabilities = createNativeMenuCapabilities({
    runtime: {
      read: async () => snapshot,
      vault: {
        refresh: async () => undefined,
        read: async () => ({ view: 'synthetic-view' }),
      },
    } as unknown as NativeAccountRuntime,
    source: {} as NativeSource,
    start: async () => {},
  })
  try {
    return await capabilities.readStatus('account')
  } finally {
    capabilities.close()
  }
}

const snapshotWith = (
  mode: NativeAccountSnapshot['mode'],
  accounts: NativeAccountSnapshot['accounts'],
): NativeAccountSnapshot => ({
  mode,
  settings: {},
  policyStorage: { version: 1, accounts: [] },
  accounts,
})

test('account status names each account once and prints a route only under a label', async () => {
  const status = await statusFor(
    snapshotWith('local', [
      { id: 'main', type: 'oauth', source: 'local', enabled: false },
      {
        id: 'synthetic-fallback',
        label: 'Personal',
        type: 'oauth',
        source: 'local',
        enabled: true,
      },
      {
        id: 'unlabelled-fallback',
        type: 'oauth',
        source: 'local',
        enabled: true,
      },
    ]),
  )
  expect(status).toBe(
    [
      'Main account: disabled, oauth, local',
      'Personal [fallback]: enabled, oauth, local',
      '  Route: synthetic-fallback',
      'Fallback unlabelled-fallback: enabled, oauth, local',
    ].join('\n'),
  )
})

test('a labelled main account prints its label, role and route', async () => {
  const status = await statusFor(
    snapshotWith('local', [
      {
        id: 'main',
        label: 'Work',
        type: 'oauth',
        source: 'local',
        enabled: true,
      },
    ]),
  )
  expect(status).toBe('Work [main]: enabled, oauth, local\n  Route: main')
})

test('local account status shows the pool connection guidance only without a main account', async () => {
  const fallback = {
    id: 'synthetic-fallback',
    type: 'oauth',
    source: 'local',
    enabled: true,
  } as const
  const withoutMain = await statusFor(snapshotWith('local', [fallback]))
  expect(withoutMain).toContain(GUIDANCE_COMMAND)
  expect(withoutMain).toContain(
    "Quota refresh checks the pool; it does not check OpenCode's Anthropic connection.",
  )
  const empty = await statusFor(snapshotWith('local', []))
  expect(empty).toContain('No native Claude accounts.')
  expect(empty).toContain(GUIDANCE_COMMAND)
  const withMain = await statusFor(
    snapshotWith('local', [
      { id: 'main', type: 'oauth', source: 'local', enabled: false },
      fallback,
    ]),
  )
  expect(withMain).not.toContain(GUIDANCE_COMMAND)
  expect(withMain).not.toContain('Quota refresh checks the pool')
})

test('vault account status never shows the pool connection guidance', async () => {
  const fallback = {
    id: 'synthetic-fallback',
    type: 'oauth',
    source: 'vault',
    enabled: true,
  } as const
  for (const accounts of [
    [],
    [fallback],
    [{ ...fallback, id: 'main' }, fallback],
  ]) {
    const status = await statusFor(snapshotWith('claustrum', accounts))
    expect(status).not.toContain('native-claude-oauth')
    expect(status).not.toContain('Quota refresh checks the pool')
  }
})

test('View status opens all section lines without dispatching an account action', async () => {
  const lines = [
    'Work [main]: disabled, oauth, local',
    'Personal [fallback]: enabled, oauth, local',
    'First-time model access: connect Anthropic with the native pool login.',
  ]
  const section = {
    id: 'Accounts',
    title: 'Accounts',
    slot: 'accounts',
    lines,
    items: [],
    actions: [
      { id: 'add-oauth-start', label: 'Start OAuth sign-in', knobs: [] },
    ],
  }
  const menu = { command: 'claude', title: 'Claude', sections: [section] }
  const alerts: Array<{ title: string; message: string }> = []
  const commands: Array<{ id: string; run: () => Promise<void> }> = []
  let selections = 0
  let applications = 0
  const cleanup = await setupAnthropicTui({
    location: { directory: '/synthetic/project' },
    client: {
      rpc: () => ({
        open: async () => ({ command: 'claude', menu }),
        events: { on: () => () => {} },
        apply: async () => {
          applications++
          throw new Error('Unexpected action')
        },
      }),
    },
    keymap: {
      layer(factory: () => { commands: typeof commands }) {
        commands.push(...factory().commands)
      },
    },
    ui: {
      router: {
        current: () => ({ type: 'session', sessionID: 'synthetic-session' }),
      },
      dialog: {
        async select(options: {
          options: Array<{ title: string; value: unknown }>
        }) {
          selections++
          if (selections === 1) return section
          if (selections === 2) {
            const status = options.options.find(
              (option) => option.title === 'View status',
            )
            expect(status).toBeDefined()
            return status!.value
          }
          return undefined
        },
        async alert(options: { title: string; message: string }) {
          alerts.push(options)
        },
        // The menu sizes each select it opens.
        set() {},
      },
    },
  } as unknown as Plugin.Context)
  try {
    await commands.find((command) => command.id === 'cortexkit.claude')!.run()
    expect(alerts).toEqual([
      { title: 'Accounts status', message: lines.join('\n') },
    ])
    expect(applications).toBe(0)
    expect(selections).toBe(3)
  } finally {
    cleanup()
  }
})

test('a settings status without a settings snapshot names the settings file, not a pending promise', async () => {
  const capabilities = createNativeMenuCapabilities({
    runtime: {
      read: async () => snapshotWith('local', []),
      getSettingsPath: async () => '/synthetic/anthropic-auth-pool.json',
      getRelayStatusNotes: () => [],
    } as unknown as NativeAccountRuntime,
    source: {} as NativeSource,
    start: async () => {},
  })
  try {
    const status = await capabilities.readStatus('routing')
    expect(status).toContain(
      'Settings file: /synthetic/anthropic-auth-pool.json',
    )
    expect(status).not.toContain('[object Promise]')
  } finally {
    capabilities.close()
  }
})
