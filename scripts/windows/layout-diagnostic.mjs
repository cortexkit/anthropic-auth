import { mkdir, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'

const preconditions = [
  ['config-folder-itself', / is the config folder itself$/],
  ['overlapping-folders', / contain one another$/],
  ['not-regular-file', / is not a regular file$/],
  ['other-owner', / belongs to another user$/],
  [
    'configured-path-outside-folder',
    /not to a file of its own in the config folder$/,
  ],
  ['same-file', / are the same file$/],
  ['unexpected-state-home-data', /^unexpected anthropic-auth data in /],
  ['existing-tombstone', / is already a relocation tombstone$/],
  ['unfinished-migration', / is unfinished; run setup first$/],
  ['missing-runtime-and-journal', / exists with no runtime and no journal$/],
]

function token(value) {
  return typeof value === 'string' && /^[a-zA-Z0-9_:-]{1,80}$/.test(value)
    ? value
    : undefined
}

function ioDetails(reason) {
  return {
    ioCode: reason.match(/\b(E[A-Z0-9_]+)\b/)?.[1],
    operation: reason.match(
      /\b(open|mkdir|lstat|stat|read|write|rename|unlink|rmdir|scandir|realpath|chmod|fsync)\b/,
    )?.[1],
  }
}

/** Classify in memory: neither fixture paths nor machine-global artifact paths enter receipts. */
export function summarizeLayoutReason(reason) {
  if (typeof reason !== 'string') return { kind: 'other' }
  const artifact = reason.match(/^pid \d+ of an older anthropic-auth \((.*)\)$/)
  if (artifact) {
    const name = basename(artifact[1].replaceAll('\\', '/'))
    return {
      kind: 'pre-n-artifact',
      artifactKind: /^port-\d+\.json$/.test(name)
        ? 'rpc'
        : /^\d+-.+\.json$/.test(name)
          ? 'cachekeep'
          : 'unknown',
    }
  }
  if (/^pid \d+ \(/.test(reason)) return { kind: 'holder' }
  if (/ can't be read \([^)]+\)$/.test(reason)) {
    return {
      kind: /anthropic-auth-holders\.json/.test(reason)
        ? 'holder-file'
        : 'artifact-scan',
      artifactKind: /cache[-_]?keep/i.test(reason)
        ? 'cachekeep'
        : /[\\/]rpc(?:[\\/]|$)/.test(reason)
          ? 'rpc'
          : 'unknown',
      detail: token(reason.match(/\(([^)]+)\)$/)?.[1]),
    }
  }
  const precondition = preconditions.find(([, pattern]) => pattern.test(reason))
  if (precondition) return { kind: 'precondition', condition: precondition[0] }
  if (/ can't be read$/.test(reason))
    return { kind: 'precondition', condition: 'unreadable-migration-journal' }
  if (/^OPENCODE_[A-Z_]+ is set$/.test(reason))
    return { kind: 'path-override', variable: reason.split(' ')[0] }
  if (reason === 'the config folder did not exist when this process started')
    return { kind: 'missing-config-identity' }
  if (/moving.*disabled|relocation.*disabled|moving is off/.test(reason))
    return { kind: 'move-disabled' }
  const io = ioDetails(reason)
  return { kind: io.ioCode || io.operation ? 'io-error' : 'other', ...io }
}

/** Observe move admission after the strict publication proof; failures are evidence, not qualification. */
export async function captureStateHomeLayoutDiagnostic({ core, env, root }) {
  let lastStep = 'fixture-setup'
  let lastLock
  const inputs = {
    role: 'opencode1',
    moveEnabled: true,
    homeMatchesUserProfile: env.HOME === env.USERPROFILE,
  }
  try {
    const configDir = join(root, 'layout-diagnostic-config')
    const stateBase = join(
      root,
      'layout-diagnostic-state-base',
      ...Array.from({ length: 8 }, (_, i) => `segment-${i}-${'x'.repeat(28)}`),
    )
    await mkdir(configDir, { recursive: true })
    await mkdir(stateBase, { recursive: true })
    await writeFile(join(configDir, 'opencode.json'), '{}\n')
    const fixtureEnv = {
      ...env,
      OPENCODE_CONFIG_DIR: configDir,
      XDG_STATE_HOME: stateBase,
    }
    inputs.configCreated = true
    inputs.stateHomePathLength = core.resolveStateHomeTarget({
      env: fixtureEnv,
      home: fixtureEnv.HOME,
    })?.dir.length
    lastStep = 'deciding'
    const decision = await core.decideOpenCodeStateLayout({
      role: 'opencode1',
      env: fixtureEnv,
      home: fixtureEnv.HOME,
      moveEnabled: true,
      onStep: (step) => {
        lastStep = token(step)
      },
      onLockEvent: (event) => {
        lastLock = { type: token(event.type), name: token(event.name) }
      },
    })
    try {
      return {
        diagnosticOnly: true,
        inputs,
        outcome: token(decision.kind),
        lastStep,
        lastLock,
        reasons: (decision.reasons ?? []).flatMap((reason) =>
          reason.split(/; (?=pid )/).map(summarizeLayoutReason),
        ),
      }
    } finally {
      await decision.registration?.close()
    }
  } catch (error) {
    return {
      diagnosticOnly: true,
      inputs,
      outcome: 'refused-or-error',
      lastStep,
      lastLock,
      error: {
        name: token(error?.name),
        code: token(error?.code),
        causeCode: token(error?.cause?.code),
        ...ioDetails(String(error?.message ?? '')),
      },
    }
  }
}
