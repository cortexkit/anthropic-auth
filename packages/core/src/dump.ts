import { createHash, randomBytes } from 'node:crypto'
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { extractBillingHeaderCCH } from './cch.ts'
import { isSecretKey, logger, relayLog } from './logger.ts'

type DumpHeaders = ConstructorParameters<typeof Headers>[0]

export const CLAUDE_DUMP_COMMAND_NAME = 'claude-dump'

const DUMP_STATUS_TITLE = '## Claude Dump Status'
const DUMP_ENABLED_TITLE = '## Claude Dump Enabled'
const DUMP_DISABLED_TITLE = '## Claude Dump Disabled'
const DUMP_USAGE_TITLE = '## Claude Dump Usage'
const DUMP_USAGE =
  'Usage: `/claude-dump`, `/claude-dump on`, or `/claude-dump off`.'
const DUMP_DIR_ENV = 'OPENCODE_ANTHROPIC_AUTH_DUMP_DIR'
const DUMP_MAX_BYTES_ENV = 'OPENCODE_ANTHROPIC_AUTH_DUMP_MAX_BYTES'
const DEFAULT_DUMP_DIR = join(tmpdir(), 'opencode-anthropic-auth-dumps')
const DEFAULT_DUMP_MAX_BYTES = 512 * 1024 * 1024
const DUMP_SWEEP_INTERVAL_MS = 5 * 60 * 1000
const DUMP_SWEEP_NEWNESS_FLOOR_MS = 60 * 1000
const DUMP_PARTIAL_STALE_MS = 10 * 60 * 1000
const DUMP_ARTIFACT_SUFFIX_PATTERN =
  /\.(body|meta|relay|request|response)\.json$/
// Earlier builds emitted five-digit counters; current counters grow without truncation.
const DUMP_ARTIFACT_ID_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-\d{5,}-(.+)$/
const DUMP_SEGMENT_PATTERN = '[a-zA-Z0-9._-]'
const DIRECT_DUMP_PATTERN = new RegExp(
  `^${DUMP_SEGMENT_PATTERN}{1,80}-direct(?:-${DUMP_SEGMENT_PATTERN}{1,80})?$`,
)
const RELAY_DUMP_PATTERN = new RegExp(
  `^${DUMP_SEGMENT_PATTERN}{1,80}-(?:http|websocket)-p[12]-(?:full_sync|patch)$`,
)
const DIRECT_DUMP_SUFFIX_PATTERN = new RegExp(
  `^-direct(?:-${DUMP_SEGMENT_PATTERN}{1,80})?$`,
)
const RELAY_DUMP_SUFFIX_PATTERN =
  /^-(?:http|websocket)-p[12]-(?:full_sync|patch)$/

let dumpEnabled = false
let nextDumpId = 0
let lastDumpSweepAt = 0

const DIRECT_DUMP_PREVIOUS_BODY_LIMIT = 100
const directDumpPreviousBodies = new Map<string, string>()

export type DumpCommandAction =
  | { type: 'status' }
  | { type: 'enable' }
  | { type: 'disable' }
  | { type: 'usage' }

export type DumpTag = 'cachekeep' | 'start'

export type DumpHandle = {
  responsePath: string
  tag?: DumpTag
}

export function isDumpEnabled() {
  return dumpEnabled
}

export function setDumpEnabled(enabled: boolean) {
  dumpEnabled = enabled
}

export function resetDumpState() {
  dumpEnabled = false
  nextDumpId = 0
  lastDumpSweepAt = 0
  directDumpPreviousBodies.clear()
}

export function getDumpDirectory() {
  return process.env[DUMP_DIR_ENV] || DEFAULT_DUMP_DIR
}

function getDumpMaxBytes() {
  const configured = Number(process.env[DUMP_MAX_BYTES_ENV])
  return Number.isFinite(configured) && configured >= 0
    ? Math.floor(configured)
    : DEFAULT_DUMP_MAX_BYTES
}

function isConfiguredDumpDirectory(path: string) {
  return resolve(path) === resolve(getDumpDirectory())
}

function isDumpArtifactFileName(name: string) {
  const stem = name.replace(DUMP_ARTIFACT_SUFFIX_PATTERN, '')
  if (stem === name) return false
  const match = DUMP_ARTIFACT_ID_PATTERN.exec(stem)
  const requestPath = match?.[1]
  if (!requestPath) return false
  return (
    DIRECT_DUMP_PATTERN.test(requestPath) ||
    RELAY_DUMP_PATTERN.test(requestPath)
  )
}

function isDumpPartialFileName(name: string) {
  if (!name.endsWith('.partial')) return false
  const partialStem = name.slice(0, -8)
  if (isDumpArtifactFileName(partialStem)) return true
  const separator = partialStem.lastIndexOf('.')
  if (separator < 0) return false
  const nonce = partialStem.slice(separator + 1)
  return (
    /^[a-f0-9]{24}$/.test(nonce) &&
    isDumpArtifactFileName(partialStem.slice(0, separator))
  )
}

export async function writeDumpFile(path: string, contents: string) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const nonce = randomBytes(12).toString('hex')
    const partialPath = `${path}.${nonce}.partial`
    let created = false
    try {
      await writeFile(partialPath, contents, { encoding: 'utf8', flag: 'wx' })
      created = true
      await rename(partialPath, path)
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue
      if (created) await unlink(partialPath).catch(() => {})
      throw error
    }
  }
  return false
}

/**
 * Caps completed dump artifacts in the configured directory. A zero-byte cap
 * disables sweeping. Custom directories may contain unrelated files: only
 * recognized final artifact names and stale partials are eligible. Symlinks,
 * fresh partial writes, and files younger than the newness floor remain
 * protected.
 */
export async function sweepDumpDirectory(options: {
  dumpDir?: string
  maxBytes?: number
  protectedPaths?: readonly string[]
  now?: number
  minAgeMs?: number
  partialStaleMs?: number
}) {
  const dumpDir = options.dumpDir ?? getDumpDirectory()
  const maxBytes = options.maxBytes ?? getDumpMaxBytes()
  const now = options.now ?? Date.now()
  const minAgeMs = options.minAgeMs ?? DUMP_SWEEP_NEWNESS_FLOOR_MS
  const partialStaleMs = options.partialStaleMs ?? DUMP_PARTIAL_STALE_MS
  const emptyResult = { removed: 0, freedBytes: 0 }
  if (!isConfiguredDumpDirectory(dumpDir) || maxBytes <= 0) return emptyResult

  try {
    const dumpDirStats = await lstat(dumpDir)
    if (dumpDirStats.isSymbolicLink()) return emptyResult
    const protectedPaths = new Set(
      (options.protectedPaths ?? []).map((path) => resolve(path)),
    )
    const entries = await readdir(dumpDir, { withFileTypes: true })
    const files: {
      path: string
      size: number
      mtimeMs: number
      partial: boolean
      artifactGroup?: string
    }[] = []

    await Promise.all(
      entries.map(async (entry) => {
        if (!entry.isFile()) return
        const partial = isDumpPartialFileName(entry.name)
        if (!partial && !isDumpArtifactFileName(entry.name)) return
        const path = join(dumpDir, entry.name)
        try {
          const stats = await lstat(path)
          if (!stats.isFile() || stats.isSymbolicLink()) return
          files.push({
            path,
            size: stats.size,
            mtimeMs: stats.mtimeMs,
            partial,
            ...(!partial && {
              artifactGroup: entry.name.replace(
                DUMP_ARTIFACT_SUFFIX_PATTERN,
                '',
              ),
            }),
          })
        } catch {
          // Files can disappear while concurrent dump requests finish.
        }
      }),
    )

    let totalBytes = files.reduce((total, file) => total + file.size, 0)
    let removed = 0
    let freedBytes = 0
    const removeFile = async (file: (typeof files)[number]) => {
      try {
        await unlink(file.path)
        totalBytes -= file.size
        freedBytes += file.size
        removed += 1
      } catch {
        // Dump cleanup is best-effort and must not affect request handling.
      }
    }

    // Partials are not usable dump records. Reclaim stale ones independently,
    // including while the completed-artifact set is already below the cap.
    const partials = files
      .filter((file) => file.partial)
      .sort(
        (left, right) =>
          left.mtimeMs - right.mtimeMs || left.path.localeCompare(right.path),
      )
    for (const file of partials) {
      if (protectedPaths.has(resolve(file.path))) continue
      if (now - file.mtimeMs < partialStaleMs) continue
      await removeFile(file)
    }

    const artifactGroups = new Map<
      string,
      { files: (typeof files)[number][]; newestMtimeMs: number }
    >()
    for (const file of files) {
      if (file.partial || !file.artifactGroup) continue
      const group = artifactGroups.get(file.artifactGroup) ?? {
        files: [],
        newestMtimeMs: 0,
      }
      group.files.push(file)
      group.newestMtimeMs = Math.max(group.newestMtimeMs, file.mtimeMs)
      artifactGroups.set(file.artifactGroup, group)
    }

    const completedGroups = [...artifactGroups.entries()].sort(
      ([leftName, left], [rightName, right]) =>
        left.newestMtimeMs - right.newestMtimeMs ||
        leftName.localeCompare(rightName),
    )
    for (const [, group] of completedGroups) {
      if (totalBytes <= maxBytes) break
      if (now - group.newestMtimeMs < minAgeMs) continue
      if (group.files.some((file) => protectedPaths.has(resolve(file.path)))) {
        continue
      }
      for (const file of group.files) await removeFile(file)
    }

    if (removed > 0) {
      logger.debug('dump', 'removed old dump files', { removed, freedBytes })
    }
    return { removed, freedBytes }
  } catch {
    return emptyResult
  }
}

function scheduleDumpSweep(dumpDir: string, protectedPaths: readonly string[]) {
  const now = Date.now()
  if (now - lastDumpSweepAt < DUMP_SWEEP_INTERVAL_MS) return
  lastDumpSweepAt = now
  void sweepDumpDirectory({ dumpDir, protectedPaths }).catch(() => {})
}

export function parseDumpCommandAction(
  argumentsText: string,
): DumpCommandAction {
  const normalized = argumentsText.trim().split(/\s+/).filter(Boolean)
  if (normalized.length === 0) return { type: 'status' }
  if (normalized.length === 1 && normalized[0] === 'on')
    return { type: 'enable' }
  if (normalized.length === 1 && normalized[0] === 'off')
    return { type: 'disable' }
  return { type: 'usage' }
}

export function buildDumpStatusSummary(input?: { enabled?: boolean }) {
  const enabled = input?.enabled ?? dumpEnabled
  return [
    DUMP_STATUS_TITLE,
    '',
    `- Enabled: ${enabled ? 'enabled' : 'disabled'}`,
    `- Directory: ${getDumpDirectory()}`,
    '- Persisted: ~/.config/opencode/anthropic-auth.json',
    '- Captures: final rewritten Anthropic body in direct and relay modes; request/relay metadata is redacted',
    '- Warning: body dumps may contain prompt/session content; turn this off after debugging',
  ].join('\n')
}

export function executeDumpCommand(input: {
  argumentsText: string
  enabled?: boolean
}) {
  const action = parseDumpCommandAction(input.argumentsText)
  const enabled = input.enabled ?? dumpEnabled

  if (action.type === 'status') return buildDumpStatusSummary({ enabled })

  if (action.type === 'enable') {
    return [
      DUMP_ENABLED_TITLE,
      '',
      buildDumpStatusSummary({ enabled: true }),
    ].join('\n')
  }

  if (action.type === 'disable') {
    return [
      DUMP_DISABLED_TITLE,
      '',
      buildDumpStatusSummary({ enabled: false }),
    ].join('\n')
  }

  return [
    DUMP_USAGE_TITLE,
    '',
    DUMP_USAGE,
    '',
    buildDumpStatusSummary({ enabled }),
  ].join('\n')
}

function shortAffinity(affinity: string) {
  return affinity.length <= 16 ? affinity : `${affinity.slice(0, 12)}…`
}

function dumpFileSessionSegment(affinity: string, maxLength = 80) {
  const normalized = affinity
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (!normalized) return 'session-unknown'
  return normalized.length <= maxLength
    ? normalized
    : normalized.slice(0, maxLength)
}

function dumpRequestSegment(input: {
  transport: 'direct' | 'http' | 'websocket'
  protocol?: 1 | 2
  mode?: 'full_sync' | 'patch'
  route?: string
}) {
  if (input.transport !== 'direct') {
    return `${input.transport}-p${input.protocol}-${input.mode}`
  }
  const route = input.route ? `-${dumpFileSessionSegment(input.route)}` : ''
  return `direct${route}`
}

function dumpTagSegment(tag: DumpTag | undefined) {
  if (tag === 'cachekeep') return '-prewarm-cachekeep'
  if (tag === 'start') return '-start'
  return ''
}

function directDumpPreviousKey(input: {
  affinity?: string | null
  route?: string
  url?: string
}) {
  const affinity = input.affinity?.trim()
  if (affinity) return `session:${affinity}`
  return `request:${input.route ?? 'direct'}:${input.url ?? ''}`
}

function dumpBodyTagForAffinity(
  name: string,
  affinity: string,
): DumpTag | null | undefined {
  if (!name.endsWith('.body.json')) return undefined
  const stem = name.replace(DUMP_ARTIFACT_SUFFIX_PATTERN, '')
  const requestPath = DUMP_ARTIFACT_ID_PATTERN.exec(stem)?.[1]
  if (
    !requestPath ||
    (!DIRECT_DUMP_PATTERN.test(requestPath) &&
      !RELAY_DUMP_PATTERN.test(requestPath))
  ) {
    return undefined
  }

  const cachekeepTag = dumpTagSegment('cachekeep')
  const candidates: Array<{ prefix: string; tag: DumpTag | null }> = [
    { prefix: dumpFileSessionSegment(affinity), tag: null },
    {
      prefix: `${dumpFileSessionSegment(affinity, 80 - cachekeepTag.length)}${cachekeepTag}`,
      tag: 'cachekeep',
    },
  ]
  for (const candidate of candidates) {
    if (!requestPath.startsWith(`${candidate.prefix}-`)) continue
    const suffix = requestPath.slice(candidate.prefix.length)
    if (
      DIRECT_DUMP_SUFFIX_PATTERN.test(suffix) ||
      RELAY_DUMP_SUFFIX_PATTERN.test(suffix)
    ) {
      return candidate.tag
    }
  }
  return undefined
}

async function loadLatestDumpBody(input: {
  affinity?: string | null
}): Promise<string | undefined> {
  const affinity = input.affinity?.trim()
  if (!affinity) return undefined

  const dumpDir = getDumpDirectory()
  let names: string[]
  try {
    names = await readdir(dumpDir)
  } catch {
    return undefined
  }
  const candidates = names
    .map((name) => ({ name, tag: dumpBodyTagForAffinity(name, affinity) }))
    .filter(
      (candidate): candidate is { name: string; tag: DumpTag | null } =>
        candidate.tag !== undefined,
    )
    .sort((a, b) => b.name.localeCompare(a.name))
  for (const candidate of candidates) {
    try {
      const path = join(dumpDir, candidate.name)
      const metadataPath = path.replace(/\.body\.json$/, '.meta.json')
      if (!(await lstat(path)).isFile()) continue
      const metadata = JSON.parse(await readFile(metadataPath, 'utf8')) as {
        session?: unknown
        tag?: unknown
      }
      if (
        metadata.session !== shortAffinity(affinity) ||
        (candidate.tag === null
          ? metadata.tag != null
          : metadata.tag !== candidate.tag)
      ) {
        continue
      }
      return await readFile(path, 'utf8')
    } catch {
      // A concurrent sweep can remove the newest artifact; try its predecessor.
    }
  }
  return undefined
}

function rememberDirectDumpBody(key: string, bodyText: string) {
  if (!directDumpPreviousBodies.has(key)) {
    while (directDumpPreviousBodies.size >= DIRECT_DUMP_PREVIOUS_BODY_LIMIT) {
      const oldest = directDumpPreviousBodies.keys().next().value
      if (oldest === undefined) break
      directDumpPreviousBodies.delete(oldest)
    }
  }
  directDumpPreviousBodies.set(key, bodyText)
}

function headersToRecord(headers: DumpHeaders | undefined) {
  if (headers == null) return undefined
  return Object.fromEntries(new Headers(headers).entries())
}

function hashText(value: string) {
  return createHash('sha256').update(value).digest('hex')
}

function cchToken(bodyText: string) {
  return extractBillingHeaderCCH(bodyText)
}

function diffSummary(previousBodyText: string | undefined, bodyText: string) {
  if (previousBodyText == null) return null
  if (previousBodyText === bodyText) {
    return {
      changed: false,
      firstByte: -1,
      lastPreviousByte: -1,
      lastCurrentByte: -1,
      previousBytes: previousBodyText.length,
      currentBytes: bodyText.length,
    }
  }

  let firstByte = 0
  while (
    firstByte < previousBodyText.length &&
    firstByte < bodyText.length &&
    previousBodyText[firstByte] === bodyText[firstByte]
  ) {
    firstByte += 1
  }

  let previousTail = previousBodyText.length - 1
  let currentTail = bodyText.length - 1
  while (
    previousTail >= firstByte &&
    currentTail >= firstByte &&
    previousBodyText[previousTail] === bodyText[currentTail]
  ) {
    previousTail -= 1
    currentTail -= 1
  }

  return {
    changed: true,
    firstByte,
    lastPreviousByte: previousTail,
    lastCurrentByte: currentTail,
    changedPreviousBytes: previousTail - firstByte + 1,
    changedCurrentBytes: currentTail - firstByte + 1,
    previousBytes: previousBodyText.length,
    currentBytes: bodyText.length,
  }
}

function parseBody(bodyText: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(bodyText)
    return parsed != null &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed)
      ? parsed
      : null
  } catch (error) {
    relayLog(
      `dump body parse failed: ${error instanceof Error ? error.message : String(error)}`,
    )
    return null
  }
}

function hashJson(value: unknown) {
  return hashText(JSON.stringify(value))
}

function bodyStructureSummary(bodyText: string) {
  const parsed = parseBody(bodyText)
  if (!parsed) return { parseable: false as const }
  const messages = Array.isArray(parsed.messages) ? parsed.messages : []
  const system = Array.isArray(parsed.system) ? parsed.system : []
  const message0 = messages[0]
  const messagesAfter0 = messages.slice(1)

  return {
    parseable: true as const,
    model: typeof parsed.model === 'string' ? parsed.model : undefined,
    stream: parsed.stream,
    systemCount: system.length,
    messagesCount: messages.length,
    systemHash: hashJson(system),
    message0Hash: message0 === undefined ? null : hashJson(message0),
    message0Bytes: message0 === undefined ? 0 : JSON.stringify(message0).length,
    messagesAfter0Hash: hashJson(messagesAfter0),
    messagesAfter0Bytes: JSON.stringify(messagesAfter0).length,
    cch: cchToken(bodyText),
  }
}

function redactForDump(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactForDump)
  if (value == null || typeof value !== 'object') return value

  const redacted: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value)) {
    const lower = key.toLowerCase()
    if (
      lower === 'authorization' ||
      lower === 'x-api-key' ||
      lower === 'cookie' ||
      lower === 'set-cookie' ||
      isSecretKey(key)
    ) {
      redacted[key] = '[redacted]'
      continue
    }
    redacted[key] = redactForDump(entry)
  }
  return redacted
}

async function dumpRequest(input: {
  affinity?: string | null
  transport: 'direct' | 'http' | 'websocket'
  protocol?: 1 | 2
  mode?: 'full_sync' | 'patch'
  route?: string
  status?: number
  error?: string
  bodyText: string
  previousBodyText?: string
  payload?: unknown
  relayBytes?: number
  tag?: DumpTag
  request?: {
    url?: string
    method?: string
    headers?: DumpHeaders
  }
}) {
  if (!dumpEnabled) return null
  nextDumpId += 1
  const affinity = input.affinity?.trim() || 'session-unknown'
  const tagSegment = dumpTagSegment(input.tag)
  const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${String(nextDumpId).padStart(6, '0')}-${dumpFileSessionSegment(affinity, 80 - tagSegment.length)}${tagSegment}-${dumpRequestSegment(input)}`
  const dumpDir = getDumpDirectory()
  const prefix = join(dumpDir, id)
  const files: {
    body: string
    metadata: string
    response: string
    relay?: string
    request?: string
  } = {
    body: `${prefix}.body.json`,
    metadata: `${prefix}.meta.json`,
    response: `${prefix}.response.json`,
  }
  if (input.payload !== undefined) files.relay = `${prefix}.relay.json`
  if (input.request !== undefined) files.request = `${prefix}.request.json`

  try {
    await mkdir(dumpDir, { recursive: true })
    const previousBodyText =
      input.previousBodyText ?? (await loadLatestDumpBody(input))
    const metadata = {
      id,
      createdAt: new Date().toISOString(),
      session: shortAffinity(affinity),
      transport: input.transport,
      protocol: input.protocol,
      mode: input.mode,
      route: input.route,
      status: input.status,
      error: input.error,
      tag: input.tag,
      bodyBytes: input.bodyText.length,
      relayBytes: input.relayBytes,
      bodyHash: hashText(input.bodyText),
      diff: diffSummary(previousBodyText, input.bodyText),
      body: bodyStructureSummary(input.bodyText),
      files,
    }

    const writes = [
      writeDumpFile(files.body, input.bodyText),
      writeDumpFile(files.metadata, `${JSON.stringify(metadata, null, 2)}\n`),
    ]

    if (input.payload !== undefined && files.relay) {
      writes.push(
        writeDumpFile(
          files.relay,
          `${JSON.stringify(redactForDump(input.payload), null, 2)}\n`,
        ),
      )
    }

    if (input.request !== undefined && files.request) {
      writes.push(
        writeDumpFile(
          files.request,
          `${JSON.stringify(
            redactForDump({
              ...input.request,
              headers: headersToRecord(input.request.headers),
            }),
            null,
            2,
          )}\n`,
        ),
      )
    }

    await Promise.all(writes)
    scheduleDumpSweep(dumpDir, Object.values(files))

    relayLog(
      `dumped request id=${id} session=${shortAffinity(affinity)} body=${files.body} meta=${files.metadata}`,
    )
  } catch (error) {
    relayLog(
      `dump failed: ${error instanceof Error ? error.message : String(error)}`,
    )
    return null
  }
  return {
    responsePath: files.response,
    ...(input.tag ? { tag: input.tag } : {}),
  }
}

export async function dumpDirectRequest(input: {
  affinity?: string | null
  route?: string
  status?: number
  error?: string
  bodyText: string
  url?: string
  method?: string
  headers?: DumpHeaders
  tag?: DumpTag
}): Promise<DumpHandle | null> {
  if (!dumpEnabled) return null
  const previousKey = directDumpPreviousKey(input)
  const previousBodyText = directDumpPreviousBodies.get(previousKey)
  const handle = await dumpRequest({
    affinity: input.affinity,
    transport: 'direct',
    route: input.route,
    status: input.status,
    error: input.error,
    bodyText: input.bodyText,
    previousBodyText,
    request: {
      url: input.url,
      method: input.method,
      headers: input.headers,
    },
    tag: input.tag,
  })
  rememberDirectDumpBody(previousKey, input.bodyText)
  return handle
}

export async function dumpRelayRequest(input: {
  affinity: string
  transport: 'http' | 'websocket'
  protocol: 1 | 2
  mode: 'full_sync' | 'patch'
  status?: number
  bodyText: string
  previousBodyText?: string
  payload: unknown
  relayBytes: number
  tag?: DumpTag
}): Promise<DumpHandle | null> {
  return dumpRequest({
    affinity: input.affinity,
    transport: input.transport,
    protocol: input.protocol,
    mode: input.mode,
    status: input.status,
    bodyText: input.bodyText,
    previousBodyText: input.previousBodyText,
    payload: input.payload,
    relayBytes: input.relayBytes,
    tag: input.tag,
  })
}

export async function dumpResponseArtifact(
  handle: DumpHandle | null,
  input: { status: number; message: unknown; complete?: boolean },
): Promise<void> {
  if (!handle) return
  const message =
    input.message != null &&
    typeof input.message === 'object' &&
    !Array.isArray(input.message)
      ? (input.message as Record<string, unknown>)
      : {}
  const artifact: Record<string, unknown> = {
    status: input.status,
    stream_complete: input.complete ?? true,
  }
  if (typeof message.id === 'string' && message.id.length > 0)
    artifact.message_id = message.id
  if (typeof message.model === 'string' && message.model.length > 0)
    artifact.model = message.model
  if (Object.hasOwn(message, 'usage')) artifact.usage = message.usage
  if (Object.hasOwn(message, 'diagnostics'))
    artifact.diagnostics = message.diagnostics
  if (typeof message.stop_reason === 'string' && message.stop_reason.length > 0)
    artifact.stop_reason = message.stop_reason
  try {
    await writeDumpFile(
      handle.responsePath,
      `${JSON.stringify(artifact, null, 2)}\n`,
    )
  } catch (error) {
    relayLog(
      `dump response failed: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}
