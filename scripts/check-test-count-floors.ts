import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'

const packageNames = ['core', 'opencode', 'pi'] as const
type PackageName = (typeof packageNames)[number]
type Floors = Record<PackageName, number>

type LoweringMarker = {
  reason: string
  lowering: Partial<Record<PackageName, { from: number; to: number }>>
}

type FloorDocument = {
  floors: Floors
  measurement: {
    head: string
    dirtyPaths: number
  }
}

type Options = {
  baseRef?: string
  counts?: Floors
  floorFile: string
}

const decoder = new TextDecoder()

function packageScope(value: object | undefined): string {
  const packages = value ? Object.keys(value).sort() : []
  return packages.length > 0 ? packages.join(',') : 'none'
}

function verdict(status: string, scope: string, detail: string): string {
  return `VERDICT: ${status} packages=${scope} (${detail})`
}

function fail(message: string): never {
  throw new Error(message)
}

function parseFloors(raw: string, source: string): Floors {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    fail(`${source} is not valid JSON`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    fail(`${source} must be an object`)
  }

  const record = parsed as Record<string, unknown>
  const keys = Object.keys(record).sort()
  if (keys.join(',') !== [...packageNames].sort().join(',')) {
    fail(`${source} must contain exactly: ${packageNames.join(', ')}`)
  }

  const floors = {} as Floors
  for (const packageName of packageNames) {
    const value = record[packageName]
    if (
      typeof value !== 'number' ||
      !Number.isSafeInteger(value) ||
      value <= 0
    ) {
      fail(`${source}.${packageName} must be a positive integer`)
    }
    floors[packageName] = value
  }
  return floors
}

function parseFloorDocument(raw: string, source: string): FloorDocument {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    fail(`${source} is not valid JSON`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    fail(`${source} must be an object`)
  }

  const document = parsed as { floors?: unknown; measurement?: unknown }
  if (!document.floors || typeof document.floors !== 'object') {
    fail(`${source}.floors must be an object`)
  }
  if (!document.measurement || typeof document.measurement !== 'object') {
    fail(`${source}.measurement must be an object`)
  }
  const measurement = document.measurement as {
    head?: unknown
    dirtyPaths?: unknown
  }
  if (
    typeof measurement.head !== 'string' ||
    !/^[0-9a-f]{40}$/.test(measurement.head)
  ) {
    fail(`${source}.measurement.head must be a 40-hex SHA`)
  }
  const dirtyPaths = measurement.dirtyPaths
  if (
    typeof dirtyPaths !== 'number' ||
    !Number.isSafeInteger(dirtyPaths) ||
    dirtyPaths < 0
  ) {
    fail(`${source}.measurement.dirtyPaths must be a non-negative integer`)
  }
  return {
    floors: parseFloors(JSON.stringify(document.floors), `${source}.floors`),
    measurement: {
      head: measurement.head,
      dirtyPaths,
    },
  }
}

function parseOptions(args: string[]): Options {
  const options: Options = { floorFile: '.ci/test-count-floors.json' }
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index]
    const value = args[index + 1]
    if (value === undefined || value.startsWith('--')) {
      fail(`missing value for ${flag}`)
    }

    if (flag === '--base-ref') options.baseRef = value
    else if (flag === '--counts')
      options.counts = parseFloors(value, '--counts')
    else if (flag === '--floor-file') options.floorFile = value
    else fail(`unknown argument: ${flag}`)
    index += 1
  }
  if (isAbsolute(options.floorFile))
    fail('--floor-file must be relative to the repository root')
  return options
}

async function readFloorDocument(floorFile: string): Promise<FloorDocument> {
  return parseFloorDocument(await readFile(floorFile, 'utf8'), floorFile)
}

function readMergeTargetFloors(
  baseRef: string,
  floorFile: string,
): FloorDocument | undefined {
  const result = Bun.spawnSync(['git', 'show', `${baseRef}:${floorFile}`], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (result.exitCode !== 0) return undefined
  return parseFloorDocument(
    decoder.decode(result.stdout),
    `${baseRef}:${floorFile}`,
  )
}

function stampError(
  document: FloorDocument,
  subject: string,
  label: string,
): string | undefined {
  if (document.measurement.dirtyPaths !== 0) {
    return `${label} floor was measured with ${document.measurement.dirtyPaths} dirty paths`
  }
  const result = Bun.spawnSync(
    ['git', 'merge-base', '--is-ancestor', document.measurement.head, subject],
    { stdout: 'pipe', stderr: 'pipe' },
  )
  if (result.exitCode === 0) return undefined
  if (result.exitCode === 1) {
    return `${label} measurement head ${document.measurement.head} is not an ancestor of ${subject}`
  }
  return `could not validate ${label} measurement head ${document.measurement.head} against ${subject}`
}

async function readLoweringMarker(): Promise<LoweringMarker | undefined> {
  const markerFile = '.ci/allow-test-count-floor-lowering.json'
  if (!existsSync(markerFile)) return undefined

  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(markerFile, 'utf8'))
  } catch {
    fail(`${markerFile} is not valid JSON`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    fail(`${markerFile} must be an object`)
  }

  const marker = parsed as {
    reason?: unknown
    lowering?: unknown
  }
  if (typeof marker.reason !== 'string' || marker.reason.trim().length === 0) {
    fail(`${markerFile}.reason must be a non-empty string`)
  }
  if (
    !marker.lowering ||
    typeof marker.lowering !== 'object' ||
    Array.isArray(marker.lowering)
  ) {
    fail(`${markerFile}.lowering must be an object`)
  }

  const lowering = marker.lowering as Record<string, unknown>
  const parsedLowering: LoweringMarker['lowering'] = {}
  for (const [packageName, values] of Object.entries(lowering)) {
    if (!packageNames.includes(packageName as PackageName)) {
      fail(`${markerFile}.lowering has an unknown package: ${packageName}`)
    }
    if (!values || typeof values !== 'object' || Array.isArray(values)) {
      fail(`${markerFile}.lowering.${packageName} must be an object`)
    }
    const { from, to } = values as { from?: unknown; to?: unknown }
    if (
      typeof from !== 'number' ||
      typeof to !== 'number' ||
      !Number.isSafeInteger(from) ||
      !Number.isSafeInteger(to)
    ) {
      fail(
        `${markerFile}.lowering.${packageName} requires integer from and to values`,
      )
    }
    parsedLowering[packageName as PackageName] = { from, to }
  }
  return { reason: marker.reason, lowering: parsedLowering }
}

function markerError(
  marker: LoweringMarker | undefined,
  lowered: PackageName[],
  branchFloors: Floors,
  targetFloors: Floors,
): string | undefined {
  if (!marker) return 'no deliberate-lowering marker'

  const marked = Object.keys(marker.lowering).sort()
  if (marked.join(',') !== [...lowered].sort().join(',')) {
    return `marker must name exactly: ${lowered.join(', ')}`
  }
  for (const packageName of lowered) {
    const entry = marker.lowering[packageName]
    if (
      !entry ||
      entry.from !== targetFloors[packageName] ||
      entry.to !== branchFloors[packageName]
    ) {
      return `${packageName} marker must declare from ${targetFloors[packageName]} to ${branchFloors[packageName]}`
    }
  }
  return undefined
}

function measureTests(): Floors {
  const commands: Record<PackageName, string[]> = {
    core: ['bun', 'test', 'src/tests'],
    opencode: ['bun', 'test', 'src/tests'],
    pi: ['bun', 'test', 'src/tests'],
  }
  const floors = {} as Floors

  for (const packageName of packageNames) {
    console.log(`MEASURE: ${packageName}`)
    const result = Bun.spawnSync(commands[packageName], {
      cwd: join('packages', packageName),
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const output = `${decoder.decode(result.stdout)}${decoder.decode(result.stderr)}`
    if (result.exitCode !== 0) {
      process.stdout.write(output)
      fail(`${packageName} test command exited ${result.exitCode}`)
    }
    const match = output.match(/^\s*(\d+) pass\s*$/m)
    if (!match) fail(`could not parse ${packageName} test count`)
    floors[packageName] = Number(match[1])
    console.log(`MEASURED: ${packageName} ${floors[packageName]}`)
  }
  return floors
}

async function main() {
  const options = parseOptions(process.argv.slice(2))
  let branchDocument: FloorDocument
  try {
    branchDocument = await readFloorDocument(options.floorFile)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      console.error(
        verdict(
          'FAIL',
          'none',
          `NONCOMPLIANT SOURCE: branch floor file is missing: ${options.floorFile}`,
        ),
      )
      process.exitCode = 1
      return
    }
    throw error
  }
  if (!options.baseRef) {
    console.error(
      verdict(
        'UNCHECKED',
        packageScope(branchDocument.floors),
        'merge target ref was not provided',
      ),
    )
    process.exitCode = 2
    return
  }

  const targetDocument = readMergeTargetFloors(
    options.baseRef,
    options.floorFile,
  )
  if (!targetDocument) {
    console.error(
      verdict(
        'UNCHECKED',
        packageScope(branchDocument.floors),
        `could not resolve merge target floor ${options.baseRef}:${options.floorFile}`,
      ),
    )
    process.exitCode = 2
    return
  }

  const branchStampError = stampError(branchDocument, 'HEAD', 'branch')
  if (branchStampError) {
    console.error(
      verdict(
        'UNCHECKED',
        packageScope(branchDocument.floors),
        branchStampError,
      ),
    )
    process.exitCode = 2
    return
  }
  const targetStampError = stampError(
    targetDocument,
    options.baseRef,
    'merge target',
  )
  if (targetStampError) {
    console.error(
      verdict(
        'UNCHECKED',
        packageScope(branchDocument.floors),
        targetStampError,
      ),
    )
    process.exitCode = 2
    return
  }

  const counts = options.counts ?? measureTests()
  const scope = packageScope(counts)
  if (scope === 'none') {
    console.error(verdict('UNCHECKED', scope, 'no packages were evaluated'))
    process.exitCode = 2
    return
  }
  const branchFloors = branchDocument.floors
  const targetFloors = targetDocument.floors
  const failures: string[] = []
  for (const packageName of packageNames) {
    if (counts[packageName] < branchFloors[packageName]) {
      failures.push(
        `COUNT: ${packageName} measured ${counts[packageName]} < branch floor ${branchFloors[packageName]}`,
      )
    } else {
      console.log(
        `COUNT: ${packageName} measured ${counts[packageName]} >= branch floor ${branchFloors[packageName]}`,
      )
    }
  }

  const lowered = packageNames.filter(
    (packageName) => branchFloors[packageName] < targetFloors[packageName],
  )
  const marker = await readLoweringMarker()
  const invalidMarker = markerError(marker, lowered, branchFloors, targetFloors)
  for (const packageName of packageNames) {
    if (lowered.includes(packageName)) continue
    console.log(
      `RATCHET: ${packageName} branch floor ${branchFloors[packageName]} >= merge target floor ${targetFloors[packageName]}`,
    )
  }
  if (lowered.length > 0 && invalidMarker) {
    for (const packageName of lowered) {
      failures.push(
        `RATCHET: ${packageName} branch floor ${branchFloors[packageName]} < merge target floor ${targetFloors[packageName]} (${invalidMarker})`,
      )
    }
  } else if (lowered.length > 0 && marker) {
    for (const packageName of lowered) {
      console.log(
        `RATCHET: ${packageName} branch floor ${branchFloors[packageName]} < merge target floor ${targetFloors[packageName]}; deliberate lowering authorized: ${marker.reason}`,
      )
    }
  }

  if (failures.length > 0) {
    for (const failure of failures) console.error(failure)
    console.error(verdict('FAIL', scope, 'test-count floor check failed'))
    process.exitCode = 1
    return
  }
  console.log(verdict('PASS', scope, 'test counts and floor ratchet satisfied'))
}

try {
  await main()
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  console.error(
    verdict('FAIL', 'none', 'test-count floor check rejected invalid input'),
  )
  process.exitCode = 1
}
