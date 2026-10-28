import { describe, expect, test } from 'bun:test'
import { win32 } from 'node:path'
import { windowsLongPath } from '../windows-long-path.ts'

function longWin32Path(length = 300): string {
  const base = 'C:\\Users\\runner\\state'
  const filler = 'x'.repeat(Math.max(0, length - base.length - 10))
  return win32.join(base, `${filler}.json`)
}

describe('windowsLongPath', () => {
  test('prefixes a long absolute Windows path', () => {
    const long = longWin32Path(300)
    expect(long.length).toBeGreaterThan(260)
    expect(win32.isAbsolute(long)).toBe(true)
    const prefixed = windowsLongPath(long, 'win32')
    expect(prefixed.startsWith('\\\\?\\')).toBe(true)
    expect(prefixed).toBe(`\\\\?\\${win32.resolve(long)}`)
  })

  test('leaves short Windows paths unchanged', () => {
    const short = 'C:\\Users\\runner\\state\\file.json'
    expect(windowsLongPath(short, 'win32')).toBe(short)
  })

  test('leaves already-prefixed paths unchanged', () => {
    const long = longWin32Path(300)
    const prefixed = windowsLongPath(long, 'win32')
    expect(windowsLongPath(prefixed, 'win32')).toBe(prefixed)
  })

  test('leaves POSIX paths unchanged', () => {
    const long = `/tmp/${'x'.repeat(300)}.json`
    expect(windowsLongPath(long, 'linux')).toBe(long)
    expect(windowsLongPath(long, 'darwin')).toBe(long)
  })

  test('leaves relative Windows paths unchanged', () => {
    const relative = `state\\${'x'.repeat(300)}.json`
    expect(win32.isAbsolute(relative)).toBe(false)
    expect(windowsLongPath(relative, 'win32')).toBe(relative)
  })

  test('handles UNC long paths', () => {
    const unc = `\\\\server\\share\\${'x'.repeat(300)}.json`
    const prefixed = windowsLongPath(unc, 'win32')
    expect(prefixed.startsWith('\\\\?\\UNC\\')).toBe(true)
  })
})
