import { expect, test } from 'bun:test'
import {
  CustodyStateMismatchError,
  reconcileCustodyStartup,
} from '../custody-mode.ts'

test('committed native local and enrolled vault custody require inert activation', () => {
  expect(
    reconcileCustodyStartup({
      mode: 'L',
      main: 'T',
      fallbacks: 'R',
      evidence: 'V',
      authority: 'committed',
    }).verdict,
  ).toBe('LOCAL_SERVE')
  expect(
    reconcileCustodyStartup({
      mode: 'C',
      main: 'T',
      fallbacks: 'T',
      evidence: 'V',
      authority: 'retired',
    }).verdict,
  ).toBe('CLAUSTRUM_SERVE')
  for (const input of [
    { mode: 'C', main: 'T', fallbacks: 'M', evidence: 'V' },
    { mode: 'C', main: 'R', fallbacks: 'T', evidence: 'V' },
    { mode: 'C', main: 'T', fallbacks: 'T', evidence: 'N' },
    { mode: 'L', main: 'R', fallbacks: 'R', evidence: 'V' },
    { mode: 'L', main: 'T', fallbacks: 'R', evidence: 'N' },
  ] as const) {
    expect(() =>
      reconcileCustodyStartup({ ...input, authority: 'committed' }),
    ).toThrow(CustodyStateMismatchError)
  }
})

test('activation and roster cannot bypass the committed migration journal', () => {
  for (const input of [
    { mode: 'L', main: 'T', fallbacks: 'R', evidence: 'V' },
    { mode: 'C', main: 'T', fallbacks: 'T', evidence: 'V' },
  ] as const) {
    expect(() => reconcileCustodyStartup(input)).toThrow('MIGRATION_REQUIRED')
  }
})
