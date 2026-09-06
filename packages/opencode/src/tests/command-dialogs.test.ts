import { describe, expect, test } from 'bun:test'
import type { PrimeAccountStatus } from '@cortexkit/anthropic-auth-core'
import type { AccountDialogKnobs } from '../rpc/protocol'
import {
  buildAccountDialogL1,
  buildAccountDialogOption,
  buildKillswitchThresholdSeed,
  buildManageAccountOptions,
  buildPrimeStatusRows,
  handlePrimeStatusOption,
  normalizeAccountDialogPayload,
  PRIME_DIALOG_OPTIONS,
  retainAccountDialogProjection,
} from '../tui/command-dialogs'

describe('buildKillswitchThresholdSeed', () => {
  test('preserves scoped killswitch thresholds in the TUI edit seed', () => {
    expect(
      buildKillswitchThresholdSeed(
        {
          main: { five_hour: 5, seven_day: 10, scoped: 20 },
          accounts: {
            umut: { five_hour: 3, seven_day: 8, scoped: 0 },
          },
        },
        ['umut'],
      ),
    ).toBe('main:5,10,20 umut:3,8,0')
  })

  test('falls back to main thresholds and scoped default for accounts without overrides', () => {
    expect(
      buildKillswitchThresholdSeed({ main: { five_hour: 5, seven_day: 10 } }, [
        'umut',
      ]),
    ).toBe('main:5,10,0 umut:5,10,0')
  })
})

describe('buildAccountDialogOption', () => {
  test('threads the tier label into the account row detail', () => {
    expect(
      buildAccountDialogOption({
        id: 'work',
        label: 'Work',
        role: 'fallback',
        enabled: true,
        quotaPercent: 22,
        tierLabel: 'Team · Max 5x',
        claustrumGate: 'on',
        vaultServed: true,
        vaultReauth: false,
        custodyState: 'on-vault-served',
      }),
    ).toEqual({
      title: 'Work [fallback] 22% · custody vault-served',
      value: 'work',
      description: 'Team · Max 5x',
    })
  })

  test('renders the settled custody state without exposing credentials', () => {
    const option = buildAccountDialogOption({
      id: 'work',
      label: 'Work',
      role: 'fallback',
      enabled: true,
      quotaPercent: null,
      claustrumGate: 'on',
      vaultServed: false,
      vaultReauth: true,
      custodyState: 'on-vault-reauth',
    })
    expect(option.title).toContain('custody vault reauth')
    expect(option.title).not.toContain('handle')
  })

  test('renders the cold custody state', () => {
    const option = buildAccountDialogOption({
      id: 'work',
      label: 'Work',
      role: 'fallback',
      enabled: true,
      quotaPercent: null,
      claustrumGate: 'on',
      vaultServed: false,
      vaultReauth: false,
      custodyState: 'on-cold',
    })

    expect(option.title).toContain('custody vault cold')
  })

  test('does not label the main account as custody-ineligible', () => {
    const option = buildAccountDialogOption({
      id: 'main',
      label: 'Main',
      role: 'main',
      enabled: true,
      quotaPercent: null,
      claustrumGate: 'na',
      vaultServed: false,
      vaultReauth: false,
      custodyState: 'na',
    })

    expect(option.title).not.toContain('custody n/a')
    expect(option.title).not.toContain('n/a')
  })

  test('omits custody for an older account-modal payload without custody fields', () => {
    const [oldPayloadAccount] = normalizeAccountDialogPayload({
      accounts: [
        {
          id: 'work',
          label: 'Work',
          role: 'fallback',
          enabled: true,
          quotaPercent: null,
          claustrumGate: 'off',
          vaultServed: false,
        },
      ],
    }).accounts

    expect(() => buildAccountDialogOption(oldPayloadAccount!)).not.toThrow()
    expect(buildAccountDialogOption(oldPayloadAccount!)).toEqual({
      title: 'Work [fallback] –%',
      value: 'work',
    })
  })
})

describe('buildPrimeStatusRows', () => {
  const base = {
    id: 'main',
    label: 'main',
    nextDueAt: undefined,
  } as PrimeAccountStatus

  test('renders future-due, successful prime, and active-window rows', () => {
    const futureDue = Date.now() + 60 * 60_000
    const past = Date.now() - 60_000
    const rows = buildPrimeStatusRows([
      { ...base, id: 'main', nextDueAt: futureDue },
      {
        id: 'work-alt',
        label: 'work-alt',
        nextDueAt: undefined,
        lastPrimedAt: past,
        lastResult: 'ok',
        usage: { count: 12, inputTokens: 240, outputTokens: 12, since: 1 },
        estimatedCostUsd: 0.00132,
      },
      {
        id: 'expired',
        label: 'expired',
        // active window: a past nextDueAt means the reset has happened but
        // the window already started; no row says "primed" and no future
        // prime is due.
        nextDueAt: past,
      },
    ])
    expect(rows.length).toBeGreaterThanOrEqual(4)
    expect(rows[0]).toContain('main · next prime')
    expect(rows.find((r) => r.includes('work-alt · primed'))).toBeDefined()
    expect(rows.find((r) => r.includes('12 primes'))).toBeDefined()
    expect(rows.find((r) => r.includes('— window active'))).toBeDefined()
  })

  test('error row uses "primed HH:MM err" notation', () => {
    const rows = buildPrimeStatusRows([
      {
        id: 'work-alt',
        label: 'work-alt',
        nextDueAt: undefined,
        lastPrimedAt: Date.now() - 60_000,
        lastResult: 'error',
      },
    ])
    expect(rows[0]).toContain('primed')
    expect(rows[0]).toContain('err')
  })
})

describe('openCommandDialog — claude-prime modal interaction (M6)', () => {
  test('main view exposes 4 options in spec order: Enable / Disable / Status / Back', () => {
    expect(PRIME_DIALOG_OPTIONS).toEqual([
      { title: 'Enable', value: 'on' },
      { title: 'Disable', value: 'off' },
      { title: 'Status', value: 'status' },
      { title: 'Back', value: 'back' },
    ])
  })

  test('Status view has a working Back action that returns to the main view', () => {
    let returned = false
    handlePrimeStatusOption({ value: 'back' }, () => {
      returned = true
    })
    expect(returned).toBe(true)
  })
})

const accountRows: AccountDialogKnobs['accounts'] = [
  {
    id: 'main',
    label: 'Main',
    role: 'main',
    enabled: true,
    quotaPercent: null,
    claustrumGate: 'na',
    vaultServed: false,
    vaultReauth: false,
    custodyState: 'na',
  },
  {
    id: 'work',
    label: 'Work',
    role: 'fallback',
    enabled: true,
    quotaPercent: 42,
    claustrumGate: 'on',
    vaultServed: true,
    vaultReauth: false,
    custodyState: 'on-vault-served',
  },
]

describe('openCommandDialog — global custody mode', () => {
  test('keeps the last complete account projection when an apply result has no accounts', () => {
    const projection = {
      accounts: accountRows,
      claustrumDetection: 'ready',
      custodyMode: 'claustrum',
      custodyModeKnown: true,
    }

    expect(
      retainAccountDialogProjection(projection, {
        error: 'provider unavailable',
      }),
    ).toBe(projection)
  })

  test('shows claustrum and offers local custody', () => {
    const dialog = buildAccountDialogL1({
      accounts: accountRows,
      claustrumDetection: 'ready',
      custodyMode: 'claustrum',
      custodyModeKnown: true,
    })

    expect(dialog.header).toBe('Custody mode: claustrum')
    expect(dialog.options).toContainEqual({
      title: 'Use local custody',
      value: '__custody-mode__',
    })
  })

  test('offers Claustrum custody while local', () => {
    const dialog = buildAccountDialogL1({
      accounts: accountRows,
      claustrumDetection: 'ready',
      custodyMode: 'local',
      custodyModeKnown: true,
    })

    expect(dialog.options).toContainEqual({
      title: 'Use Claustrum custody',
      value: '__custody-mode__',
    })
  })

  test('renders an absent mode as unavailable without a control', () => {
    const serverPayload: AccountDialogKnobs = {
      accounts: accountRows,
      claustrumDetection: 'ready',
      custodyMode: 'local',
      custodyModeKnown: true,
    }
    const { custodyMode: _absentMode, ...olderServerKnobs } = serverPayload
    const dialog = buildAccountDialogL1(olderServerKnobs)

    expect(dialog.header).toBe('Custody mode: unavailable from older server')
    expect(dialog.options.map((option) => option.title)).not.toContain(
      'Use Claustrum custody',
    )
    expect(dialog.options.map((option) => option.title)).not.toContain(
      'Use local custody',
    )
    expect(dialog.options).toContainEqual(
      expect.objectContaining({
        title: 'Work [fallback] 42% · custody vault-served',
      }),
    )
  })

  test('treats a mode as unavailable when its known flag is false', () => {
    const dialog = buildAccountDialogL1({
      accounts: accountRows,
      claustrumDetection: 'ready',
      custodyMode: 'claustrum',
      custodyModeKnown: false,
    })

    expect(dialog.header).toBe('Custody mode: unavailable from older server')
    expect(dialog.options.map((option) => option.title)).not.toContain(
      'Use local custody',
    )
  })

  test('keeps custody out of per-account management and main caveats', () => {
    const mainOption = buildAccountDialogL1({
      accounts: accountRows,
      claustrumDetection: 'ready',
      custodyMode: 'local',
      custodyModeKnown: true,
    }).options.find((option) => option.value === 'main')
    expect(mainOption?.title).not.toMatch(/n\/a|eligible/i)

    expect(
      buildManageAccountOptions(accountRows[1]!)
        .map((option) => option.title)
        .join('\n'),
    ).not.toMatch(/custody/i)
  })

  test('dispatches the opposite custody mode through the account command path', () => {
    const dialog = buildAccountDialogL1({
      accounts: accountRows,
      claustrumDetection: 'ready',
      custodyMode: 'claustrum',
      custodyModeKnown: true,
    })

    expect(dialog.modeAction).toEqual({
      command: 'claude-account',
      arguments: 'local',
    })
  })
})
