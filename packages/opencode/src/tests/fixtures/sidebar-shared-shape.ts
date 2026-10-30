import { expect } from 'bun:test'
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { version } from '../../../package.json'

export interface SidebarFrameLine {
  text: string
  spans: { text: string; fg: string; dim: boolean; bold: boolean }[]
}

export function sharedShapeSidebarState(
  now = Date.now(),
  sessionId = 'quota-render-test',
) {
  const window = (used: number) => ({
    usedPercent: used,
    remainingPercent: 100 - used,
    checkedAt: now,
  })
  return {
    main: {
      quota: { five_hour: window(60), seven_day: window(20) },
      quotaBackedOff: true,
      quotaBackoffUntil: now + 10 * 60_000,
    },
    fallbacks: [
      {
        id: 'idle',
        label: 'very-long-idle-account-name',
        enabled: true,
        needsReauth: false,
        quota: { five_hour: window(10), seven_day: window(10) },
      },
      {
        id: 'locked',
        label: 'locked',
        enabled: true,
        needsReauth: true,
        stateLine: 'sign in again',
        quotaDated: true,
        quota: { five_hour: window(30) },
      },
    ],
    activeId: 'main',
    route: 'main-first',
    fastMode: true,
    fableRecoveries: [
      { sessionId, mode: 'opus', remaining: 2, changedAt: now },
    ],
    cacheKeep: { window: '1h', enabled: true, trackedSessions: 2 },
    prime: { enabled: true, accounts: [] },
    lastUpdated: now,
  }
}

export function expectCollapsedStyle(
  lines: SidebarFrameLine[],
  name: string,
  quota: string,
  emphasized: boolean,
  quotaColor = 'rgba(0.00, 1.00, 0.00, 1.00)',
) {
  const line = lines.find((line) =>
    line.text.trimStart().startsWith(`${name} `),
  )
  expect(line).toBeDefined()
  const label = line?.spans.find((span) => span.text.includes(name))
  const figure = line?.spans.find((span) => span.text.includes(quota))
  expect(label).toMatchObject({
    fg: emphasized
      ? 'rgba(1.00, 1.00, 1.00, 1.00)'
      : 'rgba(0.53, 0.53, 0.53, 1.00)',
    dim: false,
    bold: false,
  })
  expect(figure).toMatchObject({
    fg: emphasized ? quotaColor : 'rgba(0.53, 0.53, 0.53, 1.00)',
    dim: false,
    bold: emphasized,
  })
}

export function expectSharedSidebarShape(
  frame: string,
  lines: SidebarFrameLine[],
  width: number,
  collapsed: boolean,
) {
  expect(frame).not.toMatch(/[\u2500-\u257f]/)
  expect(frame).not.toContain('LIMITED')
  const header = frame.split('\n')[0] ?? ''
  expect(header.trimStart()).toStartWith(`${collapsed ? '▶' : '▼'} CLAUDE `)
  expect(header).toEndWith(`v${version}`)
  expect(Bun.stringWidth(header)).toBe(width)
  const row = (left: string, right: string) =>
    left +
    ' '.repeat(width - Bun.stringWidth(left) - Bun.stringWidth(right)) +
    right
  const expectedHeader = row(` ${collapsed ? '▶' : '▼'} CLAUDE `, `v${version}`)
  if (collapsed) {
    const idleName =
      width === 36
        ? 'very-long-id…'
        : width === 37
          ? 'very-long-idl…'
          : 'very-long-idle-acc…'
    expect(
      frame
        .trimEnd()
        .split('\n')
        .map((line) => line.trimEnd()),
    ).toEqual([
      expectedHeader,
      row('main', '5h 40% · 7d 80% left ●'),
      row(idleName, '5h 90% · 7d 90% left ●'),
      row('locked', '5h 70% left ⊘'),
      row('Mode', 'fast'),
      row('Recovery', 'Opus 4.8 · 2 left'),
    ])
    const rows = frame.split('\n').filter((line) => /[●⊘]\s*$/.test(line))
    expect(rows).toHaveLength(3)
    expect(rows[0]?.trimEnd()).toMatch(/^main +5h 40% · 7d 80% left ●$/)
    expect(rows[1]?.trimEnd()).toMatch(
      /^very-long-.*… +5h 90% · 7d 90% left ●$/,
    )
    expect(rows[2]?.trimEnd()).toMatch(/^locked +5h 70% left ⊘$/)
    for (const row of rows) expect(Bun.stringWidth(row.trimEnd())).toBe(width)
    const glyphColors = lines
      .filter((line) => /[●⊘]\s*$/.test(line.text))
      .map((line) => line.spans.find((span) => /[●⊘]\s*$/.test(span.text))?.fg)
    expect(glyphColors).toEqual([
      'rgba(0.00, 1.00, 0.00, 1.00)',
      'rgba(0.53, 0.53, 0.53, 1.00)',
      'rgba(1.00, 1.00, 0.00, 1.00)',
    ])
    expectCollapsedStyle(
      lines,
      'main',
      '5h 40%',
      true,
      'rgba(1.00, 1.00, 0.00, 1.00)',
    )
    expectCollapsedStyle(lines, 'locked', '5h 70%', false)
    for (const [label, value, color] of [
      ['Mode', 'fast', 'rgba(0.20, 0.40, 1.00, 1.00)'],
      ['Recovery', 'Opus 4.8 · 2 left', 'rgba(1.00, 1.00, 0.00, 1.00)'],
    ] as const)
      expect(
        lines
          .find((line) => line.text.startsWith(label))
          ?.spans.find((span) => span.text.includes(value))?.fg,
      ).toBe(color)
  } else {
    expect(
      frame
        .trimEnd()
        .split('\n')
        .map((line) => line.trimEnd()),
    ).toEqual([
      expectedHeader,
      '',
      'Quota',
      row('main', 'active'),
      '5h ██████░░░░ 40% left',
      '7d ██░░░░░░░░ 80% left',
      '',
      row('very-long-idle-account-name', 'idle'),
      '5h █░░░░░░░░░ 90% left',
      '7d █░░░░░░░░░ 90% left',
      '',
      row('locked', 'dated'),
      'sign in again',
      '5h ███░░░░░░░ 70% left',
      '',
      'Routing',
      row('Route', 'main-first'),
      row('Mode', 'fast'),
      row('Relay', '—'),
      row('Recovery', 'Opus 4.8 · 2 left'),
      '',
      'Cache',
      row('1h cache', '1h · on'),
      row('Tracked', '2'),
      row('Prime', 'on'),
      '',
      'Health',
      row('Quota API', 'backoff 10m'),
    ])
    expect(frame).not.toContain('7d —')
    for (const section of ['Quota', 'Routing', 'Cache', 'Health'])
      expect(frame).toContain(section)
    for (const detail of ['sign in again', 'Quota API', '1h cache', 'Prime'])
      expect(frame).toContain(detail)
  }
}

export function captureSharedSidebarFrame(
  host: string,
  width: number,
  collapsed: boolean,
  frame: string,
) {
  // An explicit output path lets the render tests produce reviewable text frames.
  const path = process.env.SIDEBAR_FRAME_CAPTURE
  if (!path) return
  mkdirSync(dirname(path), { recursive: true })
  const text = frame
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .trimEnd()
  appendFileSync(
    path,
    `=== ${host} | ${width} columns | ${collapsed ? 'collapsed' : 'expanded'} ===\n${text}\n\n`,
  )
}
