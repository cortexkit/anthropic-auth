import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { CUSTODY_HANDLE_PATTERN } from './constants.ts'

// -- Level ----------------------------------------------------------------

export type LogLevel = 'error' | 'warn' | 'info' | 'debug' | 'trace'

const LEVEL_ORDER: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
  trace: 4,
}

const VALID_LEVELS = new Set<string>(Object.keys(LEVEL_ORDER))

function parseLogLevel(value: string | undefined): LogLevel | null {
  if (!value) return null
  const normalized = value.trim().toLowerCase()
  return VALID_LEVELS.has(normalized) ? (normalized as LogLevel) : null
}

const envLevel = parseLogLevel(process.env.OPENCODE_ANTHROPIC_AUTH_LOG_LEVEL)
let currentLevel: LogLevel = envLevel ?? 'info'

export function setLogLevel(level: LogLevel): void {
  currentLevel = level
}

export function getLogLevel(): LogLevel {
  return currentLevel
}

export { parseLogLevel }

// -- Emission control ------------------------------------------------------

export function shouldEmit(level: LogLevel): boolean {
  return LEVEL_ORDER[level] <= LEVEL_ORDER[currentLevel]
}

// -- File path -------------------------------------------------------------

const LOG_FILE =
  process.env.OPENCODE_ANTHROPIC_AUTH_LOG_FILE ??
  path.join(os.tmpdir(), 'opencode-anthropic-auth.log')

export function getLogFilePath(): string {
  return LOG_FILE
}

// -- Rotation --------------------------------------------------------------

const MAX_FILE_SIZE = 5 * 1024 * 1024 // 5 MB
const MAX_GENERATIONS = 3

function rotateLogFile(): void {
  try {
    if (!fs.existsSync(LOG_FILE)) return
    const stat = fs.statSync(LOG_FILE)
    if (stat.size < MAX_FILE_SIZE) return
  } catch {
    return
  }
  try {
    for (let i = MAX_GENERATIONS; i >= 1; i--) {
      const oldPath = i === 1 ? LOG_FILE : `${LOG_FILE}.${i - 1}`
      const newPath = `${LOG_FILE}.${i}`
      try {
        if (i === MAX_GENERATIONS) {
          try {
            fs.unlinkSync(newPath)
          } catch {
            // .3 might not exist
          }
        }
        if (fs.existsSync(oldPath)) {
          fs.renameSync(oldPath, newPath)
        }
      } catch {
        // Rotation best-effort — never throw
      }
    }
  } catch {
    // Rotation must never throw
  }
}

// -- Redaction ------------------------------------------------------------

export const SECRET_KEY_EXACT =
  /^(authorization|x-api-key|cookie|set-cookie|refresh|access|token|handle)$/i

export function isSecretKey(key: string): boolean {
  if (SECRET_KEY_EXACT.test(key)) return true
  const k = key.toLowerCase().replace(/[-_]/g, '')
  if (k.includes('apikey')) return true
  if (k.endsWith('secret') || k.endsWith('password')) return true
  if (k.endsWith('token') && !k.endsWith('tokens')) return true
  return false
}

const REDACT_VALUE_PATTERNS = [
  /Bearer\s+\S+/,
  /sk-[A-Za-z0-9-]+/,
  /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/,
  CUSTODY_HANDLE_PATTERN,
]

function isRedactableValue(value: unknown): boolean {
  if (typeof value !== 'string') return false
  return REDACT_VALUE_PATTERNS.some((pattern) => pattern.test(value))
}

export function redactPayload(
  payload?: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (payload == null || Object.keys(payload).length === 0) return undefined

  const seen = new WeakSet<object>()

  function walk(value: unknown): unknown {
    if (value == null || typeof value !== 'object') {
      if (isRedactableValue(value)) return '***REDACTED***'
      return value
    }
    if (seen.has(value)) return '[Circular]'
    seen.add(value)
    try {
      if (Array.isArray(value)) return value.map(walk)

      const obj = value as Record<string, unknown>
      const result: Record<string, unknown> = {}
      for (const [key, entry] of Object.entries(obj)) {
        if (isSecretKey(key)) {
          result[key] = '***REDACTED***'
          continue
        }
        result[key] = walk(entry)
      }
      return result
    } finally {
      seen.delete(value)
    }
  }

  return walk(payload) as Record<string, unknown>
}

// -- Line formatting ------------------------------------------------------

export function formatLogLine(
  level: LogLevel,
  channel: string,
  message: string,
  payload?: Record<string, unknown>,
): string {
  const now = new Date().toISOString()
  const levelUpper = level.toUpperCase().padEnd(5)
  const channelSegment = channel ? ` [${channel}]` : ''
  const payloadJson = (() => {
    try {
      const redacted = redactPayload(payload)
      const withPid = redacted
        ? { ...redacted, pid: process.pid }
        : { pid: process.pid }
      return ` ${JSON.stringify(withPid)}`
    } catch {
      return ` {"pid":${process.pid},"payload":"[unserializable]"}`
    }
  })()

  return `[${now}] ${levelUpper}${channelSegment} ${message}${payloadJson}`
}

// -- Test-capture sink ----------------------------------------------------

export type LogTestRecord = {
  level: LogLevel
  channel: string
  message: string
  payload?: Record<string, unknown>
}

let testSink: ((record: LogTestRecord) => void) | null = null

export function __setLogTestSink(
  sink: ((record: LogTestRecord) => void) | null,
) {
  testSink = sink
}

// -- Leveled API ----------------------------------------------------------

function emit(
  level: LogLevel,
  channel: string,
  message: string,
  payload?: Record<string, unknown>,
): void {
  if (!shouldEmit(level)) return
  if (testSink) {
    try {
      testSink({ level, channel, message, payload: redactPayload(payload) })
    } catch {
      // Sink must never throw into production.
    }
  }
  if (isTestEnv) return
  try {
    const line = `${formatLogLine(level, channel, message, payload)}\n`
    buffer.push(line)
    if (buffer.length >= BUFFER_SIZE_LIMIT) {
      flush()
    } else {
      scheduleFlush()
    }
  } catch {
    // Logging must never throw.
  }
}

export const logger = {
  error(channel: string, message: string, payload?: Record<string, unknown>) {
    emit('error', channel, message, payload)
  },
  warn(channel: string, message: string, payload?: Record<string, unknown>) {
    emit('warn', channel, message, payload)
  },
  info(channel: string, message: string, payload?: Record<string, unknown>) {
    emit('info', channel, message, payload)
  },
  debug(channel: string, message: string, payload?: Record<string, unknown>) {
    emit('debug', channel, message, payload)
  },
  trace(channel: string, message: string, payload?: Record<string, unknown>) {
    emit('trace', channel, message, payload)
  },
}

// -- Buffered writes ------------------------------------------------------

const isTestEnv = process.env.NODE_ENV === 'test'
const FLUSH_INTERVAL_MS = 500
const BUFFER_SIZE_LIMIT = 50

let buffer: string[] = []
let flushTimer: ReturnType<typeof setTimeout> | null = null

function flush(): void {
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  if (buffer.length === 0) return
  const data = buffer.join('')
  buffer = []
  try {
    rotateLogFile()
    fs.appendFileSync(LOG_FILE, data)
  } catch {
    // Logging must never throw.
  }
}

function scheduleFlush(): void {
  if (flushTimer) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    flush()
  }, FLUSH_INTERVAL_MS)
}

// -- Back-compat shims ----------------------------------------------------

const CHANNEL_REGEX = /^\[([\w-]+)\]\s*/

export function log(message: string, data?: unknown): void {
  if (!shouldEmit('debug')) return
  if (isTestEnv) return

  try {
    let channel = ''
    let msg = message
    const match = message.match(CHANNEL_REGEX)
    if (match) {
      channel = match[1] ?? ''
      msg = message.slice(match[0].length)
    }

    let payload: Record<string, unknown> | undefined
    if (data != null) {
      if (data instanceof Error) {
        payload = {
          error: `${data.message}${data.stack ? `\n${data.stack}` : ''}`,
        }
      } else if (typeof data === 'object') {
        payload = data as Record<string, unknown>
      }
    }

    emit('debug', channel, msg, payload)
  } catch {
    // Logging must never throw.
  }
}

export function relayLog(message: string, data?: unknown): void {
  if (!shouldEmit('debug')) return
  if (isTestEnv) return
  try {
    let payload: Record<string, unknown> | undefined
    if (data != null) {
      if (typeof data === 'object' && !(data instanceof Error)) {
        payload = data as Record<string, unknown>
      }
    }
    emit('debug', 'relay', message, payload)
  } catch {
    // Logging must never throw.
  }
}

// -- Exit flush -----------------------------------------------------------

if (!isTestEnv) {
  process.on('exit', flush)
}
