import { expect, test } from 'bun:test'
import { realpath, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname } from 'node:path'
import { createTestLifetimeSuite } from '../../packages/core/src/tests/test-lifetime.ts'
import {
  createMutationSandbox,
  type ExecutionEvent,
  exactPattern,
  executedCount,
  normalizeReport,
  type OwnedChild,
  packageSelection,
  parseExecution,
  runPackage,
  runTest,
  selectionFor,
  type Transcript,
  testEnvironment,
} from '../run-mutation-bun'

const file = 'packages/core/src/tests/fast.test.ts'
const name = 'fast mode eligibility for claude-opus-4-7[1m] is false'
const apiFile = 'packages/pi/src/tests/convert.test.ts'
const apiName =
  'buildAnthropicRequest — Fable/Mythos thinking > does not add Fable 5.1 binding controls to an API-key request'
const header = 'bun test v1.3.14 (0d9b296a)\n'

test('sandboxes import-time defaults and refuses inherited host path overrides', () => {
  const inherited = {
    PATH: '/toolchain',
    HOME: '/real-home',
    TMPDIR: '/real-tmp',
    OPENCODE_ANTHROPIC_AUTH_FILE: '/real-auth',
    OPENCODE_ANTHROPIC_AUTH_DUMP: '1',
    PI_ANTHROPIC_AUTH_FILE: '/real-pi-auth',
    PI_ANTHROPIC_AUTH_UNKNOWN_FILE: '/real-extra',
  }
  const env = testEnvironment('/sandbox', inherited)
  expect(env.HOME).toBe('/sandbox')
  expect(env.OPENCODE_ANTHROPIC_AUTH_FILE).toBe(
    '/sandbox/OPENCODE_ANTHROPIC_AUTH_FILE',
  )
  expect(env.PI_ANTHROPIC_AUTH_FILE).toBe('/sandbox/PI_ANTHROPIC_AUTH_FILE')
  expect(env.OPENCODE_ANTHROPIC_AUTH_DUMP).toBeUndefined()
  expect(env.PI_ANTHROPIC_AUTH_UNKNOWN_FILE).toBeUndefined()
  expect(env.PATH).toBe('/toolchain')
  expect(inherited.HOME).toBe('/real-home')
})
function green(selectedName = name): Transcript {
  return {
    stdout: header,
    stderr: `\nsrc/tests/fast.test.ts:\n(pass) ${selectedName} [4.73ms]\n\n 1 pass\n 8 filtered out\n 0 fail\n 1 expect() calls\nRan 1 test across 1 file. [87.00ms]\n`,
    exitCode: 0,
    signal: null,
  }
}
function red(): Transcript {
  return {
    stdout: header,
    stderr: `\nsrc/tests/fast.test.ts:\n16 | expect(isFastModeSupportedModel(model)).toBe(expected)\n                                              ^\nerror: expect(received).toBe(expected)\n\nExpected: false\nReceived: true\n\n      at <anonymous> (/checkout/packages/core/src/tests/fast.test.ts:16:43)\n(fail) ${name} [2.11ms]\n\n 0 pass\n 1 fail\n 1 expect() calls\nRan 1 test across 1 file. [110.00ms]\n`,
    exitCode: 1,
    signal: null,
  }
}

test('accepts the real pinned baseline and assertion-failure summary shapes', () => {
  expect(executedCount(name, green())).toBe(1)
  expect(executedCount(name, red())).toBe(1)
})

test('package snapshot summaries still require a verified assertion count', () => {
  const fixture = green()
  fixture.stderr = fixture.stderr.replace(
    ' 1 expect() calls',
    ' 8 snapshots, 1 expect() calls',
  )
  expect(parseExecution(undefined, fixture).count).toBe(1)
  for (const summary of [
    ' 8 snapshots',
    ' 8 snapshots, 0 expect() calls',
    ' 8 snapshots, expect() calls',
  ]) {
    expect(() =>
      parseExecution(undefined, {
        ...fixture,
        stderr: fixture.stderr.replace(
          ' 8 snapshots, 1 expect() calls',
          summary,
        ),
      }),
    ).toThrow()
  }
})

test('anchors literal punctuation and keeps Bun filter/display names distinct', () => {
  const regex = new RegExp(exactPattern(name))
  expect(regex.test(name)).toBe(true)
  expect(regex.test(name.replace('[1m]', '1m'))).toBe(false)
  expect(regex.test(`prefix ${name}`)).toBe(false)
  expect(regex.test(`${name} suffix`)).toBe(false)
  const api = selectionFor(apiFile, apiName)
  expect(api.name).toBe(
    'buildAnthropicRequest — Fable/Mythos thinking > does not add Fable 5.1 binding controls to an API-key request',
  )
  expect(api.filterName).toBe(
    'buildAnthropicRequest — Fable/Mythos thinking does not add Fable 5.1 binding controls to an API-key request',
  )
  const punctuation = 'scope (a+b)? [x] {2} ^$ . | \\ /'
  expect(new RegExp(exactPattern(punctuation)).test(punctuation)).toBe(true)
})

test('accepts the header and summary on either pipe, including CRLF', () => {
  const fixture = red()
  expect(
    executedCount(name, {
      ...fixture,
      stdout: fixture.stderr.replaceAll('\n', '\r\n'),
      stderr: header,
    }),
  ).toBe(1)
})

const invalid: { label: string; transcript: Transcript }[] = [
  {
    label: 'zero tests',
    transcript: {
      ...green(),
      stderr: ' 0 pass\n 0 fail\nRan 0 tests across 1 file. [2.00ms]\n',
    },
  },
  {
    label: 'ambiguous total',
    transcript: {
      ...green(),
      stderr: `${green().stderr}Ran 1 test across 1 file. [2.00ms]\n`,
    },
  },
  {
    label: 'mismatched total',
    transcript: {
      ...green(),
      stderr: green().stderr.replace('Ran 1 test', 'Ran 2 tests'),
    },
  },
  {
    label: 'mismatched pass count',
    transcript: {
      ...green(),
      stderr: green().stderr.replace(' 1 pass', ' 2 pass'),
    },
  },
  {
    label: 'ambiguous pass count',
    transcript: { ...green(), stderr: `${green().stderr} 1 pass\n` },
  },
  {
    label: 'multiple files',
    transcript: {
      ...green(),
      stderr: green().stderr.replace('1 file.', '2 files.'),
    },
  },
  {
    label: 'unrelated failing test',
    transcript: {
      ...red(),
      stderr: red().stderr.replace(`(fail) ${name}`, '(fail) unrelated guard'),
    },
  },
  {
    label: 'extra failing test',
    transcript: {
      ...red(),
      stderr: `${red().stderr}(fail) unrelated guard [1.00ms]\n`,
    },
  },
  { label: 'wrong child status', transcript: { ...red(), exitCode: 0 } },
  {
    label: 'compilation failure with assertion-looking source',
    transcript: {
      ...red(),
      stderr: `${red().stderr}error: Unexpected token\n`,
    },
  },
  {
    label: 'import failure with assertion-looking source',
    transcript: {
      ...red(),
      stderr: `${red().stderr}error: Cannot find module missing.ts\n`,
    },
  },
  {
    label: 'runtime failure',
    transcript: {
      ...red(),
      stderr: red().stderr.replace(
        'error: expect(received).toBe(expected)',
        'TypeError: not a function',
      ),
    },
  },
  {
    label: 'hook error after assertion',
    transcript: {
      ...red(),
      stderr: `${red().stderr}error: afterEach failed\n`,
    },
  },
  {
    label: 'hook error summary',
    transcript: { ...red(), stderr: `${red().stderr} 1 error\n` },
  },
  {
    label: 'test timeout',
    transcript: {
      ...red(),
      stderr: `${red().stderr}Test timed out after 5000ms\n`,
    },
  },
  {
    label: 'hook timeout',
    transcript: {
      ...red(),
      stderr: `${red().stderr}beforeEach hook timed out\n`,
    },
  },
  {
    label: 'unhandled error',
    transcript: { ...red(), stderr: `${red().stderr}Unhandled rejection\n` },
  },
  { label: 'signal death', transcript: { ...red(), signal: 'SIGSEGV' } },
  { label: 'crash status', transcript: { ...red(), exitCode: 139 } },
  {
    label: 'refused child invocation',
    transcript: { ...red(), exitCode: 126 },
  },
  {
    label: 'missing executable status',
    transcript: { ...red(), exitCode: 127 },
  },
  {
    label: 'absent assertion',
    transcript: {
      ...red(),
      stderr: red().stderr.replace(
        'error: expect(received).toBe(expected)',
        '',
      ),
    },
  },
  {
    label: 'zero assertions',
    transcript: {
      ...green(),
      stderr: green().stderr.replace('1 expect()', '0 expect()'),
    },
  },
  {
    label: 'skipped result',
    transcript: {
      ...green(),
      stderr: green().stderr.replace('(pass)', '(skip)'),
    },
  },
  {
    label: 'skipped count',
    transcript: { ...green(), stderr: `${green().stderr} 1 skip\n` },
  },
  { label: 'missing version', transcript: { ...green(), stdout: '' } },
  {
    label: 'unpinned version',
    transcript: { ...green(), stdout: header.replace('1.3.14', '1.3.13') },
  },
  {
    label: 'ambiguous version',
    transcript: { ...green(), stdout: `${header}${header}` },
  },
  {
    label: 'spoofed wrapper count',
    transcript: { ...green(), stdout: `${header}CKDEV executed 1 tests\n` },
  },
]
for (const { label, transcript } of invalid) {
  test(`refuses ${label} instead of counting an assertion-looking transcript`, () => {
    expect(() => executedCount(name, transcript)).toThrow()
  })
}

function bytes(text: string) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const buffer = Buffer.from(text)
      // Split within UTF-8 as well as line boundaries, retaining original bytes.
      for (const byte of buffer) controller.enqueue(Uint8Array.of(byte))
      controller.close()
    },
  })
}
function childFor(transcript: Transcript): OwnedChild {
  return {
    stdout: bytes(transcript.stdout),
    stderr: bytes(transcript.stderr),
    exited: Promise.resolve(transcript.exitCode),
    signalCode: transcript.signal,
    kill: () => {
      throw new Error('Completed fixture must not be killed')
    },
  }
}
function sinks() {
  const stdout: Uint8Array[] = []
  const stderr: Uint8Array[] = []
  return {
    out: () => Buffer.concat(stdout).toString('utf8'),
    err: () => Buffer.concat(stderr).toString('utf8'),
    stdout: (chunk: Uint8Array) => {
      stdout.push(chunk)
    },
    stderr: (chunk: Uint8Array) => {
      stderr.push(chunk)
    },
  }
}

test('preserves raw bytes on their original pipes and the genuine child status', async () => {
  for (const transcript of [green(), red()]) {
    const output = sinks()
    let argv: string[] = []
    let cwd = ''
    const status = await runTest(
      file,
      name,
      {
        ...output,
        spawn: (args, directory) => {
          argv = args
          cwd = directory
          return childFor(transcript)
        },
      },
      new AbortController().signal,
    )
    expect(status).toBe(transcript.exitCode)
    expect(output.out()).toBe(`${transcript.stdout}CKDEV executed 1 tests\n`)
    expect(output.err()).toBe(transcript.stderr)
    expect(argv).toEqual([
      process.execPath,
      'test',
      '--no-orphans',
      '--config',
      './bunfig.toml',
      './src/tests/fast.test.ts',
      '--test-name-pattern',
      exactPattern(name),
    ])
    expect(cwd).toBe(
      `${import.meta.dir.replace('/scripts/tests', '')}/packages/core`,
    )
  }
  const api = selectionFor(apiFile, apiName)
  const output = sinks()
  const transcript = green(api.name)
  expect(
    await runTest(
      apiFile,
      apiName,
      { ...output, spawn: () => childFor(transcript) },
      new AbortController().signal,
    ),
  ).toBe(0)
  expect(output.err()).toBe(transcript.stderr)
})

test('invalid names and unsafe paths refuse before spawning', async () => {
  const inputs = [
    { file, name: '' },
    { file, name: ' name' },
    { file, name: 'name ' },
    { file, name: 'name\n' },
    { file, name: 'name\u0000' },
    { file, name: 'name\u0085' },
    { file: '../fast.test.ts', name },
    { file: '/tmp/fast.test.ts', name },
    { file: 'packages/core/../pi/src/tests/convert.test.ts', name },
    { file: 'packages/core/src/tests/setup.ts', name },
    { file: 'constructor', name },
  ]
  for (const input of inputs) {
    const output = sinks()
    expect(
      await runTest(
        input.file,
        input.name,
        {
          ...output,
          spawn: () => {
            throw new Error('Must not spawn')
          },
        },
        new AbortController().signal,
      ),
    ).toBe(126)
    expect(output.err()).not.toContain('Must not spawn')
    expect(output.out()).toBe('')
  }
})

test('spawn failure is refused without a count record', async () => {
  const output = sinks()
  expect(
    await runTest(
      file,
      name,
      {
        ...output,
        spawn: () => {
          throw new Error('ENOENT')
        },
      },
      new AbortController().signal,
    ),
  ).toBe(126)
  expect(output.err()).toContain('ENOENT')
  expect(output.out()).toBe('')
})

test('all malformed transcript fixtures return 126 and preserve raw output', async () => {
  for (const { transcript } of invalid) {
    const output = sinks()
    expect(
      await runTest(
        file,
        name,
        { ...output, spawn: () => childFor(transcript) },
        new AbortController().signal,
      ),
    ).toBe(126)
    expect(output.out()).toBe(transcript.stdout)
    expect(output.err().startsWith(transcript.stderr)).toBe(true)
    expect(output.err()).toContain('CKDEV ERROR:')
  }
})

test('cancellation kills owned work before joining pending pipes and body', async () => {
  const output = sinks()
  const abort = new AbortController()
  const events: string[] = []
  let stopOut = () => {}
  let stopErr = () => {}
  let stopBody = () => {}
  const child: OwnedChild = {
    stdout: new ReadableStream({
      start(controller) {
        stopOut = () => {
          events.push('stdout done')
          controller.close()
        }
      },
    }),
    stderr: new ReadableStream({
      start(controller) {
        stopErr = () => {
          events.push('stderr done')
          controller.close()
        }
      },
    }),
    exited: new Promise((resolve) => {
      stopBody = () => {
        events.push('body done')
        resolve(137)
      }
    }),
    signalCode: 'SIGKILL',
    kill: () => {
      events.push('kill')
      stopOut()
      stopErr()
      stopBody()
    },
  }
  const running = runTest(
    file,
    name,
    { ...output, spawn: () => child },
    abort.signal,
  )
  abort.abort()
  expect(await running).toBe(126)
  expect(events).toEqual(['kill', 'stdout done', 'stderr done', 'body done'])
  expect(output.err()).toContain('Invocation cancelled')
  expect(output.out()).toBe('')
})

test('pipe failure kills owned work and all-settled joins the other pipe and exit', async () => {
  const output = sinks()
  let killed = false
  let closeOther = () => {}
  let finish = () => {}
  const child: OwnedChild = {
    stdout: new ReadableStream({
      start(controller) {
        controller.error(new Error('pipe broken'))
      },
    }),
    stderr: new ReadableStream({
      start(controller) {
        closeOther = () => {
          controller.enqueue(Buffer.from('raw tail\n'))
          controller.close()
        }
      },
    }),
    exited: new Promise((resolve) => {
      finish = () => resolve(137)
    }),
    signalCode: 'SIGKILL',
    kill: () => {
      killed = true
      closeOther()
      finish()
    },
  }
  expect(
    await runTest(
      file,
      name,
      { ...output, spawn: () => child },
      new AbortController().signal,
    ),
  ).toBe(126)
  expect(killed).toBe(true)
  expect(output.err()).toBe('raw tail\nCKDEV ERROR: Error: pipe broken\n')
})

test('exit-promise rejection terminates pending pipes before joining them', async () => {
  const output = sinks()
  let closed = false
  let closeOut = () => {}
  let closeErr = () => {}
  const child: OwnedChild = {
    stdout: new ReadableStream({
      start(controller) {
        closeOut = () => controller.close()
      },
    }),
    stderr: new ReadableStream({
      start(controller) {
        closeErr = () => controller.close()
      },
    }),
    exited: Promise.reject(new Error('wait failed')),
    signalCode: null,
    kill: () => {
      closed = true
      closeOut()
      closeErr()
    },
  }
  expect(
    await runTest(
      file,
      name,
      { ...output, spawn: () => child },
      new AbortController().signal,
    ),
  ).toBe(126)
  expect(closed).toBe(true)
  expect(output.err()).toContain('wait failed')
})

const junitStart =
  '<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="bun test" tests="2" failures="0" skipped="0">\n  <testsuite name="src/tests/fixture.test.ts">\n'
function junit(caseLines: string[]) {
  return `${junitStart}${caseLines.join('\n')}\n  </testsuite>\n</testsuites>\n`
}
function testcase(leaf: string, classname = '', suffix = ' />') {
  return `    <testcase name="${leaf}" classname="${classname}" time="0.001" file="src/tests/fixture.test.ts" line="12" assertions="1"${suffix}`
}
function event(
  name: string,
  status: 'pass' | 'fail' = 'pass',
  occurrence = 1,
  file = 'src/tests/fixture.test.ts',
): ExecutionEvent {
  return { name, status, occurrence, file }
}
function packageGreen(): Transcript {
  return {
    stdout: header,
    stderr:
      '\nsrc/tests/fixture.test.ts:\n(pass) handles timeout [1.00ms]\n(pass) scope > second [2.00ms]\n\n 2 pass\n 0 fail\n 2 expect() calls\nRan 2 tests across 1 file. [10.00ms]\n',
    exitCode: 0,
    signal: null,
  }
}

test('package events count only executed results, not a passing timeout title', () => {
  expect(executedCount(undefined, packageGreen())).toBe(2)
  expect(() => executedCount('handles timeout', packageGreen())).toThrow()
  expect(() =>
    executedCount(undefined, {
      ...packageGreen(),
      stderr: packageGreen().stderr.replace(' 2 pass', ' 3 pass'),
    }),
  ).toThrow()
  expect(() =>
    executedCount(undefined, {
      ...packageGreen(),
      stderr: packageGreen().stderr.replace('Ran 2 tests', 'Ran 3 tests'),
    }),
  ).toThrow()
})

test('normalizes only JUnit name attributes and preserves native named row identities', () => {
  const fullName =
    'buildAnthropicRequest — Fable/Mythos thinking > does not add Fable 5.1 binding controls to an API-key request'
  const caseLines = [
    testcase(
      'refuses unknown or meaningful content 0 without mutating history',
    ),
    testcase(
      'does not add Fable 5.1 binding controls to an API-key request',
      'buildAnthropicRequest — Fable/Mythos thinking',
    ),
  ]
  const raw = junit(caseLines)
  const events = [
    event('refuses unknown or meaningful content 0 without mutating history'),
    event(fullName),
  ]
  const normalized = normalizeReport(raw, events)
  expect(normalized.ids).toEqual([
    'refuses unknown or meaningful content 0 without mutating history',
    fullName,
  ])
  expect(normalized.xml).toBe(
    raw.replace(
      'name="does not add Fable 5.1 binding controls to an API-key request"',
      'name="buildAnthropicRequest — Fable/Mythos thinking &gt; does not add Fable 5.1 binding controls to an API-key request"',
    ),
  )
  expect(normalizeReport(raw, events)).toEqual(normalized)
  expect(
    normalizeReport(
      junit([
        testcase('fast mode eligibility for claude-opus-4-7[1m] is false'),
      ]),
      [event('fast mode eligibility for claude-opus-4-7[1m] is false')],
    ).ids,
  ).toEqual(['fast mode eligibility for claude-opus-4-7[1m] is false'])
})

test('XML entity and dollar punctuation normalization cannot rewrite result data', () => {
  const raw = junit([
    testcase(
      'a &amp; &quot;b&quot; &apos;c&apos; &#36;&amp; &#x41;',
      'scope &lt;x&gt;',
      '>',
    ),
    '      <failure message="expect(received).toBe(expected)"><![CDATA[Expected: false\nReceived: true]]></failure>',
    '    </testcase>',
  ])
  const normalized = normalizeReport(raw, [
    event('scope <x> > a & "b" \'c\' $& A', 'fail'),
  ])
  expect(normalized.ids).toEqual(['scope <x> > a & "b" \'c\' $& A'])
  expect(normalized.xml).toContain('classname="scope &lt;x&gt;"')
  expect(normalized.xml.slice(normalized.xml.indexOf('      <failure'))).toBe(
    raw.slice(raw.indexOf('      <failure')),
  )
})

test('repeated Bun table cases retain every result with deterministic occurrence IDs', () => {
  const raw = junit([
    testcase('Pi history empty user=%s'),
    testcase('Pi history empty user=%s', '', '>'),
    '      <failure message="original failure">original body</failure>',
    '    </testcase>',
  ])
  const events = [
    event('Pi history empty user=%s'),
    event('Pi history empty user=%s', 'fail', 2),
  ]
  const normalized = normalizeReport(raw, events)
  expect(normalized.ids).toEqual([
    'Pi history empty user=%s [case 1 at src/tests/fixture.test.ts:12]',
    'Pi history empty user=%s [case 2 at src/tests/fixture.test.ts:12]',
  ])
  expect(normalized.xml).toContain(
    '<failure message="original failure">original body</failure>',
  )
  expect(normalized.xml.match(/<testcase /g)?.length).toBe(2)
  expect(normalizeReport(raw, events)).toEqual(normalized)
  // Neither suffixed report ID equals "Pi history empty user=%s". An
  // expected-name list containing that name matches neither occurrence.
  expect(normalized.ids.includes('Pi history empty user=%s')).toBe(false)
})

test('normalization refuses final ID collisions instead of renaming around them', () => {
  const raw = junit([
    testcase('dup'),
    testcase('dup'),
    testcase('dup [case 1 at src/tests/fixture.test.ts:12]'),
  ])
  expect(() =>
    normalizeReport(raw, [
      event('dup'),
      event('dup', 'pass', 2),
      event('dup [case 1 at src/tests/fixture.test.ts:12]'),
    ]),
  ).toThrow('Colliding normalized JUnit IDs')
})

test('missing, empty, garbage and mismatched report identities refuse', () => {
  for (const raw of [
    '',
    'garbage',
    junit([]),
    junit([testcase('one')]).replace('</testsuites>', ''),
    junit([testcase('one')]).replace('classname=""', ''),
    junit([testcase('one')]).replace('name="one"', 'name="one" name="two"'),
    junit([testcase('bad &unknown;')]),
  ]) {
    expect(() => normalizeReport(raw, [event('one')])).toThrow()
  }
  expect(() =>
    normalizeReport(junit([testcase('one')]), [event('one'), event('two')]),
  ).toThrow()
})

test('native guard selection uses the actual owning package and reviewed preload config', () => {
  for (const [file, cwd, relative] of [
    [
      'packages/core/src/tests/native-runtime.test.ts',
      'packages/core',
      'src/tests/native-runtime.test.ts',
    ],
    [
      'packages/core/src/tests/native-display-profile.test.ts',
      'packages/core',
      'src/tests/native-display-profile.test.ts',
    ],
    [
      'packages/core/src/tests/native-account-runtime.test.ts',
      'packages/core',
      'src/tests/native-account-runtime.test.ts',
    ],
    [
      'packages/opencode/src/tests/index.test.ts',
      'packages/opencode',
      'src/tests/index.test.ts',
    ],
  ]) {
    if (!file || !cwd || !relative)
      throw new Error('Expected complete test selection')
    const name =
      'auth.loader > quota header harvest > pending quota routes without waiting for header publication'
    expect(selectionFor(file, name)).toEqual({
      cwd,
      file: relative,
      name,
      filterName: name.replaceAll(' > ', ' '),
    })
  }
  expect(() =>
    selectionFor('packages/opencode/src/tests/preload-sandbox.ts', 'unsafe'),
  ).toThrow('Unsafe or unsupported test file')
  expect(
    packageSelection('packages/opencode', 'tmp/mutations/opencode.xml'),
  ).toEqual({
    cwd: 'packages/opencode',
    file: 'src/tests',
    report: 'tmp/mutations/opencode.xml',
  })
})

test('package/report selection cannot escape reviewed unit configs or report paths', () => {
  expect(packageSelection('packages/core', 'tmp/mutations/core.xml')).toEqual({
    cwd: 'packages/core',
    file: 'src/tests',
    report: 'tmp/mutations/core.xml',
  })
  for (const [pkg, report] of [
    ['packages/opencode', 'tmp/mutations/core.xml'],
    ['packages/core', '../core.xml'],
    ['packages/pi', '/tmp/pi.xml'],
    ['packages/pi', 'tmp/mutations/core.xml'],
  ]) {
    expect(() => packageSelection(pkg ?? '', report ?? '')).toThrow()
  }
})

test('broad dispatch uses full package argv and writes only verified nonempty reports', async () => {
  const output = sinks()
  let actualArgv: string[] = []
  let actualIds: string[] = []
  const raw = junit([testcase('handles timeout'), testcase('second', 'scope')])
  expect(
    await runPackage(
      'packages/core',
      'tmp/mutations/core.xml',
      {
        ...output,
        spawn: (argv) => {
          actualArgv = argv
          return childFor(packageGreen())
        },
        report: {
          read: async () => raw,
          write: async (_path, normalized) => {
            actualIds = normalized.ids
          },
        },
      },
      new AbortController().signal,
    ),
  ).toBe(0)
  expect(actualArgv.slice(0, 6)).toEqual([
    process.execPath,
    'test',
    '--no-orphans',
    '--config',
    './bunfig.toml',
    './src/tests',
  ])
  expect(actualArgv).toContain('--reporter=junit')
  expect(actualArgv.some((arg) => arg.includes('test-name-pattern'))).toBe(
    false,
  )
  expect(actualIds).toEqual(['handles timeout', 'scope > second'])
  expect(output.out()).toBe(`${header}CKDEV executed 2 tests\n`)
})

test('missing and empty broad reports return 126 without a count or report write', async () => {
  for (const raw of ['', junit([]), 'not XML']) {
    const output = sinks()
    let written = false
    expect(
      await runPackage(
        'packages/core',
        'tmp/mutations/core.xml',
        {
          ...output,
          spawn: () => childFor(packageGreen()),
          report: {
            read: async () => raw,
            write: async () => {
              written = true
            },
          },
        },
        new AbortController().signal,
      ),
    ).toBe(126)
    expect(written).toBe(false)
    expect(output.out()).toBe(header)
    expect(output.err()).toContain('CKDEV ERROR:')
  }
  const output = sinks()
  expect(
    await runPackage(
      'packages/core',
      'tmp/mutations/core.xml',
      {
        ...output,
        spawn: () => childFor(packageGreen()),
        report: {
          read: async () => {
            throw new Error('ENOENT report')
          },
          write: async () => {
            throw new Error('Must not write')
          },
        },
      },
      new AbortController().signal,
    ),
  ).toBe(126)
  expect(output.err()).toContain('ENOENT report')
})

function multiRed(): Transcript {
  return {
    ...red(),
    stderr: red()
      .stderr.replace(
        'src/tests/fast.test.ts:\n',
        'src/tests/fast.test.ts:\n(pass) healthy companion [1.00ms]\n',
      )
      .replace(
        ' 0 pass\n',
        `1 tests failed:\n(fail) ${name} [2.11ms]\n\n 1 pass\n`,
      )
      .replace('Ran 1 test across', 'Ran 2 tests across'),
  }
}

test('real multi-test failure recap is verified but never counted twice', () => {
  expect(executedCount(undefined, multiRed())).toBe(2)
  expect(() => executedCount(name, multiRed())).toThrow()
  expect(() =>
    executedCount(undefined, {
      ...multiRed(),
      stderr: multiRed().stderr.replace('1 tests failed:', '2 tests failed:'),
    }),
  ).toThrow()
  expect(() =>
    executedCount(undefined, {
      ...multiRed(),
      stderr: `${multiRed().stderr}(fail) unrelated recap [2.11ms]\n`,
    }),
  ).toThrow()
  expect(() =>
    executedCount(undefined, {
      ...multiRed(),
      stderr: multiRed().stderr.replace(
        '1 tests failed:',
        '1 tests failed:\n1 tests failed:',
      ),
    }),
  ).toThrow()
})

test('package assertion failures retain a red case and a healthy companion in JUnit', async () => {
  const output = sinks()
  const raw = junit([
    testcase('healthy companion'),
    testcase(name, '', '>'),
    '      <failure message="expect(received).toBe(expected)">Expected: false; Received: true</failure>',
    '    </testcase>',
  ]).replaceAll(
    'file="src/tests/fixture.test.ts"',
    'file="src/tests/fast.test.ts"',
  )
  let written = ''
  expect(
    await runPackage(
      'packages/core',
      'tmp/mutations/core.xml',
      {
        ...output,
        spawn: () => childFor(multiRed()),
        report: {
          read: async () => raw,
          write: async (_path, normalized) => {
            written = normalized.xml
          },
        },
      },
      new AbortController().signal,
    ),
  ).toBe(1)
  expect(written).toContain(
    '<failure message="expect(received).toBe(expected)">Expected: false; Received: true</failure>',
  )
  expect(written).toContain('name="healthy companion"')
  expect(output.out()).toBe(`${header}CKDEV executed 2 tests\n`)
})

function consistencyTranscript(): Transcript {
  return {
    stdout: header,
    stderr:
      '\nsrc/tests/synthetic.test.ts:\nerror: expect(received).toBe(expected)\n(fail) selected mutation assertion [1.00ms]\n(pass) healthy companion [1.00ms]\n\n 1 pass\n 1 fail\n 2 expect() calls\nRan 2 tests across 1 file. [2.00ms]\n',
    exitCode: 1,
    signal: null,
  }
}
function consistencyXml(
  selectedFails: boolean,
  companionFails: boolean,
  selectedName = 'selected mutation assertion',
) {
  const selected = `<testcase name="${selectedName}" classname="" file="src/tests/synthetic.test.ts" line="1"${selectedFails ? '>\n<failure message="assertion" />\n</testcase>' : ' />'}`
  const companion = `<testcase name="healthy companion" classname="" file="src/tests/synthetic.test.ts" line="2"${companionFails ? '>\n<failure message="assertion" />\n</testcase>' : ' />'}`
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites tests="2" failures="${Number(selectedFails) + Number(companionFails)}">\n<testsuite name="synthetic">\n${selected}\n${companion}\n</testsuite>\n</testsuites>\n`
}
async function runConsistencyFixture(raw: string) {
  const output = sinks()
  let written = false
  let retained = ''
  const transcript = consistencyTranscript()
  const status = await runPackage(
    'packages/core',
    'tmp/mutations/core.xml',
    {
      ...output,
      spawn: () => childFor(transcript),
      report: {
        read: async () => {
          retained = raw
          return raw
        },
        write: async () => {
          written = true
        },
      },
    },
    new AbortController().signal,
  )
  return {
    status,
    written,
    retained,
    stdout: output.out(),
    stderr: output.err(),
    transcript,
  }
}

test('accepts matching console and JUnit failure attribution with a healthy companion', async () => {
  const result = await runConsistencyFixture(consistencyXml(true, false))
  expect(result.status).toBe(1)
  expect(result.written).toBe(true)
  expect(result.stdout).toBe(`${header}CKDEV executed 2 tests\n`)
})

test('refuses JUnit erased failure despite matching aggregate test count', async () => {
  const raw = consistencyXml(false, false)
  const result = await runConsistencyFixture(raw)
  expect(result.status).toBe(126)
  expect(result.written).toBe(false)
  expect(result.stdout).toBe(header)
  expect(result.stderr.startsWith(result.transcript.stderr)).toBe(true)
  expect(result.retained).toBe(raw)
})

test('refuses JUnit failure moved to the healthy companion despite matching aggregate counts', async () => {
  const raw = consistencyXml(false, true)
  const result = await runConsistencyFixture(raw)
  expect(result.status).toBe(126)
  expect(result.written).toBe(false)
  expect(result.stdout).toBe(header)
  expect(result.stderr.startsWith(result.transcript.stderr)).toBe(true)
  expect(result.retained).toBe(raw)
})

test('refuses changed JUnit identities despite matching aggregate counts and outcomes', async () => {
  const raw = consistencyXml(true, false, 'unrelated assertion')
  const result = await runConsistencyFixture(raw)
  expect(result.status).toBe(126)
  expect(result.written).toBe(false)
  expect(result.stdout).toBe(header)
  expect(result.stderr.startsWith(result.transcript.stderr)).toBe(true)
  expect(result.retained).toBe(raw)
})

test('console events retain source file, exact name, outcome and occurrence before the recap', () => {
  expect(parseExecution(undefined, multiRed()).events).toEqual([
    {
      file: 'src/tests/fast.test.ts',
      name: 'healthy companion',
      status: 'pass',
      occurrence: 1,
    },
    { file: 'src/tests/fast.test.ts', name, status: 'fail', occurrence: 1 },
  ])
})

test('refuses changed JUnit source files with unchanged names counts and outcomes', async () => {
  const raw = consistencyXml(true, false).replaceAll(
    'file="src/tests/synthetic.test.ts"',
    'file="src/tests/other.test.ts"',
  )
  const result = await runConsistencyFixture(raw)
  expect(result.status).toBe(126)
  expect(result.written).toBe(false)
  expect(result.stdout).toBe(header)
  expect(result.retained).toBe(raw)
})

test('refuses a failure shifted between repeated Bun cases at the same source location', async () => {
  const duplicateName =
    'Pi refuses meaningful assistant history locally (fixture-api-key, empty user=%s)'
  const sourceFile = 'src/tests/request-history-stream.test.ts'
  const transcript: Transcript = {
    stdout: header,
    stderr: `\n${sourceFile}:\n(pass) ${duplicateName} [1.00ms]\nerror: expect(received).toBe(expected)\n(fail) ${duplicateName} [1.00ms]\n\n1 tests failed:\n(fail) ${duplicateName} [1.00ms]\n\n 1 pass\n 1 fail\n 2 expect() calls\nRan 2 tests across 1 file. [2.00ms]\n`,
    exitCode: 1,
    signal: null,
  }
  const cases = [
    testcase(duplicateName),
    testcase(duplicateName, '', '>'),
    '      <failure type="AssertionError" />',
    '    </testcase>',
  ]
  const matching = junit(cases)
    .replaceAll('src/tests/fixture.test.ts', sourceFile)
    .replaceAll('line="12"', 'line="62"')
  const observed = parseExecution(undefined, transcript)
  expect(observed.events).toEqual([
    { name: duplicateName, file: sourceFile, status: 'pass', occurrence: 1 },
    { name: duplicateName, file: sourceFile, status: 'fail', occurrence: 2 },
  ])
  expect(normalizeReport(matching, observed.events).ids).toEqual([
    `${duplicateName} [case 1 at ${sourceFile}:62]`,
    `${duplicateName} [case 2 at ${sourceFile}:62]`,
  ])
  const moved = junit([
    testcase(duplicateName, '', '>'),
    '      <failure type="AssertionError" />',
    '    </testcase>',
    testcase(duplicateName),
  ])
    .replaceAll('src/tests/fixture.test.ts', sourceFile)
    .replaceAll('line="12"', 'line="62"')
  const output = sinks()
  let written = false
  let retained = ''
  expect(
    await runPackage(
      'packages/pi',
      'tmp/mutations/pi.xml',
      {
        ...output,
        spawn: () => childFor(transcript),
        report: {
          read: async () => {
            retained = moved
            return moved
          },
          write: async () => {
            written = true
          },
        },
      },
      new AbortController().signal,
    ),
  ).toBe(126)
  expect(written).toBe(false)
  expect(retained).toBe(moved)
  expect(output.out()).toBe(header)
  expect(output.err().startsWith(transcript.stderr)).toBe(true)
})

const filesystemTests = createTestLifetimeSuite()
filesystemTests.test(
  'credential sandbox has a private directory under system temporary storage',
  async () => {
    const sandbox = await createMutationSandbox()
    filesystemTests.deferCleanup(() =>
      rm(sandbox, { recursive: true, force: true }),
    )
    expect(await realpath(dirname(sandbox))).toBe(await realpath(tmpdir()))
    expect((await stat(sandbox)).mode & 0o777).toBe(0o700)
  },
)

test('native GitHub group headers preserve exact file identity and outcome checks', () => {
  const transcript = green()
  const grouped = {
    ...transcript,
    stderr: transcript.stderr
      .replace('src/tests/fast.test.ts:', '::group::src/tests/fast.test.ts:')
      .replace(' 1 pass', '::endgroup::\n\n 1 pass'),
  }
  expect(parseExecution(name, grouped)).toEqual(
    parseExecution(name, transcript),
  )
  expect(executedCount(name, grouped)).toBe(1)
})

test('closed GitHub groups cannot attribute unrelated result lines to an earlier file', () => {
  const transcript = green()
  const grouped = {
    ...transcript,
    stderr: transcript.stderr.replace(
      'src/tests/fast.test.ts:',
      '::group::src/tests/fast.test.ts:\n::endgroup::',
    ),
  }
  expect(() => parseExecution(name, grouped)).toThrow(
    'missing test file header',
  )
})

test('genuine negated assertion failures retain the normal selected-test contract', () => {
  const transcript = red()
  const negated = {
    ...transcript,
    stderr: transcript.stderr.replace(
      'error: expect(received).toBe(expected)',
      'error: expect(received).not.toHaveProperty(path)',
    ),
  }
  expect(executedCount(name, negated)).toBe(1)
  expect(parseExecution(name, negated).events[0]?.status).toBe('fail')
  expect(() =>
    executedCount(name, {
      ...negated,
      stderr: negated.stderr.replace(
        'not.toHaveProperty',
        'not.not.toHaveProperty',
      ),
    }),
  ).toThrow('genuine selected expect assertion')
})
