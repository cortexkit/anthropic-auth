import { expect, test } from 'bun:test'
import {
  type ProcessStartReads,
  processStartedAtMs,
} from '../holder-registry.ts'

function linuxReads(ticks = '250'): ProcessStartReads {
  return {
    platform: 'linux',
    exec: async (file, args) => {
      expect([file, args]).toEqual(['getconf', ['CLK_TCK']])
      return ticks
    },
    readFile: async (path) => {
      if (path === '/proc/stat')
        return 'cpu 1 2 3\nbtime 1700000000\nprocesses 12\n'
      expect(path).toBe('/proc/123/stat')
      // Fields 3 through 21 precede start ticks (field 22).
      return `123 (worker (with spaces)) S ${Array(18).fill('0').join(' ')} 1250 0\n`
    },
  }
}

test('Linux process start combines fixture boot time and ticks using CLK_TCK', async () => {
  expect(await processStartedAtMs(123, linuxReads())).toBe(1_700_000_005_000)
})

test('Linux process start falls back to 100 ticks when getconf is unavailable', async () => {
  const reads = linuxReads()
  reads.exec = async () => {
    throw new Error('unavailable')
  }
  expect(await processStartedAtMs(123, reads)).toBe(1_700_000_012_500)
  expect(await processStartedAtMs(123, linuxReads('invalid'))).toBe(
    1_700_000_012_500,
  )
})

test('macOS process start parses a fixture lstart as UTC with one-second resolution', async () => {
  const reads: ProcessStartReads = {
    platform: 'darwin',
    readFile: async () => {
      throw new Error('unexpected read')
    },
    exec: async (file, args) => {
      expect([file, args]).toEqual(['ps', ['-o', 'lstart=', '-p', '123']])
      return ' Thu Nov  5 09:20:02 2026\n'
    },
  }
  expect(await processStartedAtMs(123, reads)).toBe(
    Date.UTC(2026, 10, 5, 9, 20, 2),
  )
  reads.exec = async () => 'unreadable'
  expect(await processStartedAtMs(123, reads)).toBeNull()
})

test('unreadable process metadata, unsupported platforms and invalid pids return unknown', async () => {
  const reads = linuxReads()
  reads.readFile = async () => {
    throw new Error('EACCES')
  }
  expect(await processStartedAtMs(123, reads)).toBeNull()
  reads.readFile = async () => 'malformed stat'
  expect(await processStartedAtMs(123, reads)).toBeNull()
  reads.platform = 'win32'
  reads.exec = async () => {
    throw new Error('unexpected command')
  }
  expect(await processStartedAtMs(123, reads)).toBeNull()
  expect(await processStartedAtMs(-1, linuxReads())).toBeNull()
})
