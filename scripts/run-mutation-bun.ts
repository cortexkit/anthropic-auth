import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

// Credential fixtures check every ancestor. Use system temporary storage,
// not a checkout that may have a legitimate group-writable parent.
export async function createMutationSandbox() {
  return mkdtemp(resolve(tmpdir(), 'anthropic-auth-mutation-'))
}

export function testEnvironment(
  sandbox: string,
  inherited: Record<string, string | undefined>,
) {
  const env: Record<string, string | undefined> = {
    ...inherited,
    NO_COLOR: '1',
    FORCE_COLOR: '0',
  }
  // Set child account, log and cache paths before imports can capture them.
  // Clear inherited host overrides so tests cannot write to operator files.
  for (const key of Object.keys(env)) {
    if (
      key.startsWith('OPENCODE_ANTHROPIC_AUTH_') ||
      key.startsWith('PI_ANTHROPIC_AUTH_')
    )
      delete env[key]
  }
  for (const key of [
    'HOME',
    'TMPDIR',
    'XDG_CONFIG_HOME',
    'XDG_DATA_HOME',
    'XDG_CACHE_HOME',
    'XDG_STATE_HOME',
    'XDG_RUNTIME_DIR',
    'OPENCODE_CONFIG_DIR',
    'PI_AGENT_DIR',
    'PI_CODING_AGENT_DIR',
  ])
    env[key] = sandbox
  for (const key of [
    'OPENCODE_ANTHROPIC_AUTH_FILE',
    'OPENCODE_ANTHROPIC_AUTH_STATE_FILE',
    'OPENCODE_ANTHROPIC_AUTH_LOG_FILE',
    'OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE',
    'OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_CONNECTION_FILE',
    'PI_ANTHROPIC_AUTH_FILE',
    'PI_ANTHROPIC_AUTH_ROUTING_STATE_FILE',
    'PI_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE',
  ])
    env[key] = resolve(sandbox, key)
  for (const key of [
    'OPENCODE_ANTHROPIC_AUTH_DUMP_DIR',
    'OPENCODE_ANTHROPIC_AUTH_QUOTA_FEED_DIR',
    'OPENCODE_ANTHROPIC_AUTH_CACHEKEEP_REGISTRY_DIR',
    'OPENCODE_ANTHROPIC_AUTH_RPC_DIR',
    'PI_ANTHROPIC_AUTH_CACHEKEEP_REGISTRY_DIR',
  ])
    env[key] = resolve(sandbox, key)
  return env
}

export function selectionFor(file: string, name: string) {
  if (
    !name ||
    name.trim() !== name ||
    [...name].some(
      (char) =>
        char.charCodeAt(0) < 32 ||
        (char.charCodeAt(0) >= 127 && char.charCodeAt(0) <= 159),
    )
  )
    throw new Error('Invalid full test name')
  // Limit execution to the owning files and their reviewed package preloads.
  // Accepting arbitrary paths could load a test with different safety setup.
  if (
    ![
      'packages/core/src/tests/request-history.test.ts',
      'packages/core/src/tests/fast.test.ts',
      'packages/core/src/tests/native-runtime.test.ts',
      'packages/opencode/src/tests/index.test.ts',
      'packages/pi/src/tests/convert.test.ts',
    ].includes(file)
  )
    throw new Error(`Unsafe or unsupported test file: ${file}`)
  const cwd = file.startsWith('packages/core/')
    ? 'packages/core'
    : file.startsWith('packages/opencode/')
      ? 'packages/opencode'
      : 'packages/pi'
  return {
    cwd,
    file: file.slice(cwd.length + 1),
    name,
    // Bun joins describe scopes with spaces for filtering, but prints " > ".
    filterName: name.replaceAll(' > ', ' '),
  }
}

export function exactPattern(name: string) {
  return `^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`
}

export type Transcript = {
  stdout: string
  stderr: string
  exitCode: number
  signal: string | null
}

export type ExecutionEvent = {
  name: string
  file: string
  status: 'pass' | 'fail'
  occurrence: number
}

// Count Bun's (pass) and (fail) lines, excluding filtered or discovered tests.
// A command selecting one named test must produce one matching result.
export function parseExecution(
  name: string | undefined,
  transcript: Transcript,
) {
  const { stdout, stderr, exitCode, signal } = transcript
  if (signal || (exitCode !== 0 && exitCode !== 1))
    throw new Error('Child did not exit normally with a test status')
  const text = `${stdout}\n${stderr}`
  if (text.includes('CKDEV executed'))
    throw new Error('Reserved count record in child output')
  const lines = text.split(/\r?\n/)
  const matches = (pattern: RegExp) =>
    lines.filter((line) => pattern.test(line))
  if (
    matches(/^bun test /).length !== 1 ||
    matches(/^bun test v1\.3\.14 \([a-f0-9]+\)$/).length !== 1
  )
    throw new Error('Missing or ambiguous pinned Bun header')
  // Bun's final failure list repeats earlier (fail) lines. Require the same
  // lines in the same order; do not count them twice.
  const recapIndexes = lines.flatMap((line, index) =>
    /^\d+ tests failed:$/.test(line) ? [index] : [],
  )
  if (recapIndexes.length > 1) throw new Error('Ambiguous failure recap')
  const recapIndex = recapIndexes[0]
  const eventLines =
    recapIndex === undefined ? lines : lines.slice(0, recapIndex)
  const results = eventLines.filter((line) => /^\((?:pass|fail)\) /.test(line))
  if (recapIndex !== undefined) {
    const actualFailures = results.filter((line) => line.startsWith('(fail) '))
    const recap = lines
      .slice(recapIndex + 1)
      .filter((line) => /^\((?:pass|fail)\) /.test(line))
    if (
      Number(lines[recapIndex]?.split(' ')[0]) !== actualFailures.length ||
      recap.length !== actualFailures.length ||
      recap.some((line, index) => line !== actualFailures[index])
    )
      throw new Error('Mismatched failure recap')
  }
  let testFile: string | undefined
  const ordinals = new Map<string, number>()
  const events: ExecutionEvent[] = []
  for (const line of eventLines) {
    const fileHeader =
      /^(?:::group::)?(src\/tests\/[^:\r\n]+\.test\.ts):$/.exec(line)
    if (fileHeader) {
      testFile = fileHeader[1]
      continue
    }
    if (line === '::endgroup::') {
      testFile = undefined
      continue
    }
    if (!/^\((?:pass|fail)\) /.test(line)) continue
    const match = /^\((pass|fail)\) (.+) \[\d+(?:\.\d+)?(?:ms|s)\]$/.exec(line)
    const status = match?.[1]
    const testName = match?.[2]
    if (!testFile || !testName || (status !== 'pass' && status !== 'fail'))
      throw new Error('Malformed test result or missing test file header')
    const occurrence = (ordinals.get(testName) ?? 0) + 1
    ordinals.set(testName, occurrence)
    events.push({ status, name: testName, file: testFile, occurrence })
  }
  if (
    name !== undefined &&
    (events.length !== 1 ||
      events[0]?.name !== name ||
      events[0]?.status !== (exitCode === 0 ? 'pass' : 'fail'))
  )
    throw new Error('Mismatched test name or status')
  const count = (word: string) => {
    const entries = matches(new RegExp(`^ \\d+ ${word}$`))
    if (entries.length !== 1)
      throw new Error(`Missing or ambiguous ${word} count`)
    const value = Number(entries[0]?.trim().split(' ')[0])
    if (!Number.isSafeInteger(value))
      throw new Error('Overflowed summary count')
    return value
  }
  const passed = count('pass')
  const failed = count('fail')
  const total = passed + failed
  if (
    !total ||
    total !== events.length ||
    passed !== events.filter((event) => event.status === 'pass').length ||
    failed !== events.filter((event) => event.status === 'fail').length ||
    (exitCode === 0) !== (failed === 0)
  )
    throw new Error('Mismatched executed summary')
  const totals = matches(/^Ran \d+ tests? across \d+ files?\. /)
  const summary =
    /^Ran (\d+) tests? across ([1-9]\d*) files?\. \[\d+(?:\.\d+)?(?:ms|s)\]$/.exec(
      totals[0] ?? '',
    )
  if (
    totals.length !== 1 ||
    !summary ||
    Number(summary[1]) !== total ||
    (name !== undefined && Number(summary[2]) !== 1)
  )
    throw new Error('Missing, zero or ambiguous executed total')
  const expects = matches(/^ (?:\d+ snapshots?, )?\d+ expect\(\) calls$/)
  if (
    expects.length !== 1 ||
    !/^ (?:\d+ snapshots?, )?[1-9]\d* expect\(\) calls$/.test(expects[0] ?? '')
  )
    throw new Error('No verified assertion executed')
  const errors = matches(/^error:/)
  if (
    errors.length !== failed ||
    errors.some(
      (line) =>
        !/^error: expect\(received\)\.(?:not\.)?[A-Za-z]+\([^\r\n]*\)$/.test(
          line,
        ),
    )
  )
    throw new Error('Not a genuine selected expect assertion failure')
  if (
    matches(
      /^(?:Test .*timed? out|(?:beforeEach|afterEach|beforeAll|afterAll).*|Unhandled.*)/i,
    ).length
  )
    throw new Error('Timeout, hook or unhandled error')
  // An assertion in beforeEach/afterEach can resemble a test failure. Check
  // surrounding error text for setup/cleanup failures and timeouts, not
  // unrelated passing names such as "handles timeout".
  for (const [index, line] of lines.entries()) {
    if (!line.startsWith('(fail) ')) continue
    let start = index - 1
    while (
      start >= 0 &&
      !/^\((?:pass|fail)\) |\.test\.ts:$/.test(lines[start] ?? '')
    )
      start--
    const block = lines.slice(start + 1, index).join('\n')
    if (
      /timed? out|timeout|unhandled|beforeEach|afterEach|beforeAll|afterAll/i.test(
        block,
      )
    )
      throw new Error('Timeout, hook or unhandled error')
  }
  if (
    matches(/^ \d+ (?:error|errors|skip|todo)/).length ||
    matches(/^\((?:skip|todo)\) /).length ||
    /^(?:SyntaxError|ReferenceError|TypeError|ResolveMessage|BuildMessage):|^.*error between tests/m.test(
      text,
    )
  )
    throw new Error('Compilation, import, skipped test or runtime error')
  return { count: total, events }
}

export function executedCount(
  name: string | undefined,
  transcript: Transcript,
): number {
  return parseExecution(name, transcript).count
}

function decodeAttribute(value: string) {
  const entity = /&(?:amp|lt|gt|quot|apos|#\d+|#x[\da-fA-F]+);/g
  if (value.replace(entity, '').includes('&'))
    throw new Error('Unsupported XML entity')
  return value.replace(entity, (match) => {
    switch (match) {
      case '&amp;':
        return '&'
      case '&lt;':
        return '<'
      case '&gt;':
        return '>'
      case '&quot;':
        return '"'
      case '&apos;':
        return "'"
      default:
        return String.fromCodePoint(
          match.startsWith('&#x')
            ? Number.parseInt(match.slice(3, -1), 16)
            : Number(match.slice(2, -1)),
        )
    }
  })
}

function encodeAttribute(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

// Bun writes one testcase opening tag per line. Only its name is changed;
// outcomes, failure messages, classnames, totals and order stay byte-exact.
// ckdev-mutate then validates the complete XML before grading the mutation.
export function normalizeReport(
  raw: string,
  events: readonly ExecutionEvent[],
) {
  if (
    !raw.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n') ||
    !raw.trimEnd().endsWith('</testsuites>')
  )
    throw new Error('Missing or unsupported Bun JUnit document')
  const lines = raw.split('\n')
  const cases = lines.flatMap((line, index) => {
    if (!/^\s*<testcase\b/.test(line)) return []
    const opening = /^(\s*<testcase )([^<>]+?)(\s*\/?>)$/.exec(line)
    if (!opening) throw new Error('Malformed testcase opening tag')
    const attributes = opening[2] ?? ''
    const pairs = [...attributes.matchAll(/([a-z]+)="([^"]*)"/g)]
    if (
      attributes.replace(/([a-z]+)="([^"]*)"/g, '').trim() ||
      new Set(pairs.map((pair) => pair[1])).size !== pairs.length
    )
      throw new Error('Malformed or duplicate testcase attributes')
    const attrs: Record<string, string> = Object.fromEntries(
      pairs.map((pair) => [pair[1], decodeAttribute(pair[2] ?? '')]),
    )
    if (
      !attrs.name ||
      attrs.classname === undefined ||
      !attrs.file ||
      !/^\d+$/.test(attrs.line ?? '')
    )
      throw new Error('Missing testcase identity attributes')
    const name = attrs.classname
      ? `${attrs.classname} > ${attrs.name}`
      : attrs.name
    let status: 'pass' | 'fail' = 'pass'
    if (!(opening[3] ?? '').trim().startsWith('/')) {
      const closing = lines.findIndex(
        (line, position) =>
          position > index && /^\s*<\/testcase>\s*$/.test(line),
      )
      if (closing < 0) throw new Error('Unclosed testcase')
      const children = lines.slice(index + 1, closing)
      if (
        children.some((line) => /^\s*<(?:testcase|error|skipped)\b/.test(line))
      )
        throw new Error('Unsupported or erroneous testcase contents')
      const failures = children.filter((line) => /^\s*<failure\b/.test(line))
      if (failures.length > 1) throw new Error('Ambiguous testcase failure')
      if (failures.length === 1) status = 'fail'
      else if (children.some((line) => line.trim()))
        throw new Error('Unsupported testcase contents')
    }
    return [
      {
        index,
        name,
        file: attrs.file,
        status,
        location: `${attrs.file}:${attrs.line}`,
      },
    ]
  })
  if (!cases.length || cases.length !== events.length)
    throw new Error(
      'JUnit testcase count does not match executed console events',
    )
  const counts = new Map<string, number>()
  for (const entry of cases)
    counts.set(entry.name, (counts.get(entry.name) ?? 0) + 1)
  const ordinals = new Map<string, number>()
  const ids: string[] = []
  for (const [index, entry] of cases.entries()) {
    const ordinal = (ordinals.get(entry.name) ?? 0) + 1
    ordinals.set(entry.name, ordinal)
    const event = events[index]
    if (
      !event ||
      event.name !== entry.name ||
      event.file !== entry.file ||
      event.status !== entry.status ||
      event.occurrence !== ordinal
    )
      throw new Error(
        'JUnit identity or outcome does not match console execution',
      )
    // Bun leaves %s unexpanded in "Pi refuses meaningful assistant history locally
    // (sk-ant-oat-fixture-history, empty user=%s)" and "Pi refuses meaningful
    // assistant history locally (fixture-api-key, empty user=%s)". Each observed
    // occurrence needs a distinct report ID. Catalogue assertions have unique
    // names, so their exact named selections keep those names unchanged.
    const id =
      counts.get(entry.name) === 1
        ? entry.name
        : `${entry.name} [case ${ordinal} at ${entry.location}]`
    ids.push(id)
    lines[entry.index] = (lines[entry.index] ?? '').replace(
      /\bname="[^"]*"/,
      () => `name="${encodeAttribute(id)}"`,
    )
  }
  if (new Set(ids).size !== ids.length)
    throw new Error('Colliding normalized JUnit IDs')
  return { xml: lines.join('\n'), ids }
}

export function packageSelection(pkg: string, report: string) {
  if (
    !['packages/core', 'packages/opencode', 'packages/pi'].includes(pkg) ||
    report !== `tmp/mutations/${pkg.slice('packages/'.length)}.xml`
  )
    throw new Error('Unsafe package or broad report path')
  return { cwd: pkg, file: 'src/tests', report }
}

export type OwnedChild = {
  stdout: ReadableStream<Uint8Array>
  stderr: ReadableStream<Uint8Array>
  exited: Promise<number>
  readonly signalCode: string | null
  kill: () => void
}
type Dependencies = {
  spawn: (argv: string[], cwd: string) => OwnedChild
  stdout: (bytes: Uint8Array) => void
  stderr: (bytes: Uint8Array) => void
  completed?: (
    transcript: Transcript,
    argv: string[],
    cwd: string,
  ) => Promise<void>
  report?: {
    read: (path: string) => Promise<string>
    write: (
      path: string,
      normalized: { xml: string; ids: string[] },
      transcript: Transcript,
      argv: string[],
    ) => Promise<void>
  }
}

export async function runTest(
  file: string,
  name: string,
  dependencies: Dependencies,
  signal: AbortSignal,
): Promise<number> {
  return runInvocation({ file, name }, dependencies, signal)
}

export async function runPackage(
  pkg: string,
  report: string,
  dependencies: Dependencies,
  signal: AbortSignal,
): Promise<number> {
  return runInvocation({ pkg, report }, dependencies, signal)
}

async function runInvocation(
  request: { file: string; name: string } | { pkg: string; report: string },
  dependencies: Dependencies,
  signal: AbortSignal,
): Promise<number> {
  const reportError = (error: unknown) => {
    dependencies.stderr(Buffer.from(`CKDEV ERROR: ${String(error)}\n`))
    return 126
  }
  try {
    const selected =
      'pkg' in request
        ? packageSelection(request.pkg, request.report)
        : selectionFor(request.file, request.name)
    if (signal.aborted) throw new Error('Invocation cancelled before spawn')
    const argv = [
      process.execPath,
      'test',
      '--no-orphans',
      '--config',
      './bunfig.toml',
      `./${selected.file}`,
      ...('report' in selected
        ? [
            '--reporter=junit',
            `--reporter-outfile=${resolve(import.meta.dir, '..', selected.report)}`,
          ]
        : ['--test-name-pattern', exactPattern(selected.filterName)]),
    ]
    const child = dependencies.spawn(
      argv,
      resolve(import.meta.dir, '..', selected.cwd),
    )
    let terminated = false
    const cancel = () => {
      if (terminated) return
      terminated = true
      child.kill()
    }
    signal.addEventListener('abort', cancel, { once: true })
    if (signal.aborted) cancel()
    const consume = async (
      stream: ReadableStream<Uint8Array>,
      emit: (bytes: Uint8Array) => void,
    ) => {
      const chunks: Uint8Array[] = []
      try {
        for await (const chunk of stream) {
          emit(chunk)
          chunks.push(chunk)
        }
        return new TextDecoder('utf-8', { fatal: true }).decode(
          Buffer.concat(chunks),
        )
      } catch (error) {
        // Terminate the Bun test process before waiting for its stdout reader,
        // stderr reader and exit promise to finish after a reader failure.
        cancel()
        throw error
      }
    }
    try {
      const results = await Promise.allSettled([
        consume(child.stdout, dependencies.stdout),
        consume(child.stderr, dependencies.stderr),
        child.exited.catch((error: unknown) => {
          cancel()
          throw error
        }),
      ])
      const [out, err, exit] = results
      if (out.status === 'rejected') throw out.reason
      if (err.status === 'rejected') throw err.reason
      if (exit.status === 'rejected') throw exit.reason
      const transcript = {
        stdout: out.value,
        stderr: err.value,
        exitCode: exit.value,
        signal: child.signalCode,
      }
      await dependencies.completed?.(transcript, argv, selected.cwd)
      if (signal.aborted) throw new Error('Invocation cancelled')
      // Retain Bun's raw XML even if exact console event identity, executed-count
      // or child-status validation refuses the run; the rejected bytes explain
      // the failure without publishing a verified normalized report.
      const raw =
        'report' in selected && dependencies.report
          ? await dependencies.report.read(selected.report)
          : undefined
      const execution = parseExecution(
        'name' in selected ? selected.name : undefined,
        transcript,
      )
      if ('report' in selected) {
        if (!dependencies.report) throw new Error('No broad report writer')
        if (raw === undefined) throw new Error('Missing broad report')
        const normalized = normalizeReport(raw, execution.events)
        await dependencies.report.write(
          selected.report,
          normalized,
          transcript,
          argv,
        )
      }
      dependencies.stdout(
        Buffer.from(`CKDEV executed ${execution.count} tests\n`),
      )
      return exit.value
    } finally {
      signal.removeEventListener('abort', cancel)
    }
  } catch (error) {
    return reportError(error)
  }
}

if (import.meta.main) {
  const controller = new AbortController()
  let sandbox: string | undefined
  let artifactDir: string | undefined
  const cancel = () => controller.abort()
  process.on('SIGINT', cancel)
  process.on('SIGTERM', cancel)
  try {
    const broad = process.argv[2] === '--broad'
    if (Bun.version !== '1.3.14' || process.argv.length !== (broad ? 5 : 4)) {
      process.stderr.write(
        'CKDEV ERROR: requires Bun 1.3.14 and either file/name or --broad package/report\n',
      )
      process.exitCode = 126
    } else {
      const tmp = resolve(import.meta.dir, '..', 'tmp')
      await mkdir(tmp, { recursive: true })
      if ((await lstat(tmp)).isSymbolicLink())
        throw new Error('Unsafe temporary directory')
      if (broad) packageSelection(process.argv[3] ?? '', process.argv[4] ?? '')
      else selectionFor(process.argv[2] ?? '', process.argv[3] ?? '')
      const reports = resolve(tmp, 'mutations')
      await mkdir(reports, { recursive: true })
      if ((await lstat(reports)).isSymbolicLink())
        throw new Error('Unsafe report directory')
      const audits = resolve(reports, 'audits')
      await mkdir(audits, { recursive: true })
      if ((await lstat(audits)).isSymbolicLink())
        throw new Error('Unsafe audit directory')
      artifactDir = await mkdtemp(
        resolve(audits, broad ? 'package-' : 'named-'),
      )
      const retained = artifactDir
      sandbox = await createMutationSandbox()
      const env = testEnvironment(sandbox, process.env)
      const dependencies: Dependencies = {
        spawn: (argv, cwd) => {
          const child = Bun.spawn(argv, {
            cwd,
            stdout: 'pipe',
            stderr: 'pipe',
            env,
          })
          return {
            stdout: child.stdout,
            stderr: child.stderr,
            exited: child.exited,
            get signalCode() {
              return child.signalCode
            },
            kill: () => {
              child.kill('SIGKILL')
            },
          }
        },
        stdout: (bytes) => {
          process.stdout.write(bytes)
        },
        stderr: (bytes) => {
          process.stderr.write(bytes)
        },
        completed: async (transcript, argv, cwd) => {
          await Promise.allSettled([
            writeFile(resolve(retained, 'stdout.raw'), transcript.stdout),
            writeFile(resolve(retained, 'stderr.raw'), transcript.stderr),
            writeFile(
              resolve(retained, 'invocation.json'),
              JSON.stringify(
                {
                  argv,
                  cwd,
                  exitCode: transcript.exitCode,
                  signal: transcript.signal,
                },
                null,
                2,
              ),
            ),
          ]).then((results) => {
            for (const result of results)
              if (result.status === 'rejected') throw result.reason
          })
        },
        report: {
          read: async (path) => {
            const absolute = resolve(import.meta.dir, '..', path)
            const stat = await lstat(absolute)
            if (!stat.isFile() || stat.isSymbolicLink())
              throw new Error('Unsafe broad report file')
            const raw = await readFile(absolute)
            await writeFile(resolve(retained, 'report.raw.xml'), raw)
            return new TextDecoder('utf-8', { fatal: true }).decode(raw)
          },
          write: async (path, normalized) => {
            await writeFile(
              resolve(import.meta.dir, '..', path),
              normalized.xml,
            )
            await writeFile(resolve(retained, 'report.xml'), normalized.xml)
            await writeFile(
              resolve(retained, 'matched-ids.json'),
              JSON.stringify(normalized.ids, null, 2),
            )
          },
        },
      }
      process.exitCode = broad
        ? await runPackage(
            process.argv[3] ?? '',
            process.argv[4] ?? '',
            dependencies,
            controller.signal,
          )
        : await runTest(
            process.argv[2] ?? '',
            process.argv[3] ?? '',
            dependencies,
            controller.signal,
          )
    }
  } catch (error) {
    process.stderr.write(`CKDEV ERROR: ${String(error)}\n`)
    process.exitCode = 126
  } finally {
    process.off('SIGINT', cancel)
    process.off('SIGTERM', cancel)
    try {
      if (sandbox) await rm(sandbox, { recursive: true, force: true })
      if (artifactDir)
        await writeFile(
          resolve(artifactDir, 'wrapper-status.json'),
          JSON.stringify({ exitCode: process.exitCode ?? 0 }),
        )
    } catch (error) {
      // Raw-output/status-file writes or temporary test-directory cleanup must
      // refuse with 126 on failure, even when the Bun test assertion ran and a
      // completed child already emitted its genuine assertion and count record.
      process.stderr.write(`CKDEV ERROR: cleanup failed: ${String(error)}\n`)
      process.exitCode = 126
    }
  }
}
