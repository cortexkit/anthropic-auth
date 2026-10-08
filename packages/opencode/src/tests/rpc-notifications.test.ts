import { beforeEach, describe, expect, test } from 'bun:test'
import {
  drainNotifications,
  isTuiConnected,
  pushNotification,
  resetNotificationsForTest,
} from '../rpc/notifications'
import type { OpenDialogPayload } from '../rpc/protocol'

const payload = (command: OpenDialogPayload['command']): OpenDialogPayload => ({
  command,
  text: 'x',
  knobs: {},
})

describe('notifications', () => {
  beforeEach(() => resetNotificationsForTest())

  test('single claude menus retain their discriminator and per-session drain fence', () => {
    const menu = { command: 'claude', title: 'Claude', sections: [] }
    pushNotification({ command: 'claude', menu }, 'session-a')
    pushNotification({ command: 'claude', menu }, 'session-b')
    const notices = drainNotifications(0, 'session-a')
    expect(notices).toHaveLength(1)
    expect(notices[0]).toMatchObject({
      type: 'open-menu',
      sessionId: 'session-a',
      payload: { command: 'claude', menu },
    })
    expect(drainNotifications(notices[0]?.id ?? 0, 'session-a')).toEqual([])
    expect(drainNotifications(0, 'session-b')).toHaveLength(1)
  })

  test('menu producers cannot publish a legacy command alias', () => {
    expect(() =>
      pushNotification(
        {
          command: 'claude-account',
          menu: { command: 'claude-account', title: 'Legacy', sections: [] },
        },
        's1',
      ),
    ).toThrow('Only the claude menu')
    expect(drainNotifications(0, 's1')).toEqual([])
  })

  test('a session-scoped drain prunes only its own acknowledged notices', () => {
    pushNotification(payload('claude-quota'), 's1')
    pushNotification(payload('claude-dump'), 's2')

    const s1 = drainNotifications(0, 's1')
    expect(drainNotifications(s1[0]?.id ?? 0, 's1')).toEqual([])
    expect(drainNotifications(0, 's2').map((n) => n.payload.command)).toEqual([
      'claude-dump',
    ])
  })

  test('push then drain returns the item once, ordered', () => {
    pushNotification(payload('claude-quota'), 's1')
    pushNotification(payload('claude-fast'), 's1')
    const first = drainNotifications(0, 's1')
    expect(first.map((n) => n.payload.command)).toEqual([
      'claude-quota',
      'claude-fast',
    ])
    expect(first[0]?.id).toBeLessThan(first[1]?.id as number)
    const second = drainNotifications(first[1]?.id as number, 's1')
    expect(second).toEqual([])
  })

  test('every queued notice carries its session id and stays scoped to it', () => {
    pushNotification(payload('claude-quota'), 's1')
    pushNotification(payload('claude-dump'), 's2')
    const s1 = drainNotifications(0, 's1')

    expect(s1).toHaveLength(1)
    expect(s1[0]?.sessionId).toBe('s1')
    expect(s1.map((n) => n.payload.command)).toEqual(['claude-quota'])
    expect(drainNotifications(0, 's2').map((n) => n.payload.command)).toEqual([
      'claude-dump',
    ])
  })

  test('isTuiConnected reflects a recent drain within the window', () => {
    expect(isTuiConnected('s1')).toBe(false)
    drainNotifications(0, 's1')
    expect(isTuiConnected('s1')).toBe(true)
  })

  test('a drain only marks its own session as connected', () => {
    drainNotifications(0, 's2')
    expect(isTuiConnected('s1')).toBe(false)
    expect(isTuiConnected('s2')).toBe(true)
    // @ts-expect-error isTuiConnected requires a session id
    expect(isTuiConnected()).toBe(false)
  })

  test('queue cap evicts oldest beyond 100', () => {
    for (let i = 0; i < 130; i++)
      pushNotification(payload('claude-quota'), 's1')
    const all = drainNotifications(0, 's1')
    expect(all.length).toBe(100)
  })

  test('producers and drains reject a missing session id', () => {
    expect(() => {
      // @ts-expect-error pushNotification requires a session id
      pushNotification(payload('claude-quota'))
    }).toThrow('sessionId is required')
    expect(() => {
      // @ts-expect-error drainNotifications requires a session id
      drainNotifications(0)
    }).toThrow('sessionId is required')
  })
})
