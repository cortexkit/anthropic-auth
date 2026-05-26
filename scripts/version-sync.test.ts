/**
 * Tests for scripts/version-sync.mjs
 *
 * Spawns the real script against temporary fixture directories via the
 * VERSION_SYNC_ROOT env override. No implementation logic is duplicated here.
 *
 * Run with: bun test scripts/version-sync.test.ts
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SCRIPT = join(import.meta.dir, 'version-sync.mjs')
const FORK_VERSION = '1.2.2-mb.2'
const NEXT_VERSION = '1.2.2-mb.3'

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function coreManifest(version = FORK_VERSION) {
  return `${JSON.stringify(
    { name: '@marcusrbrown/anthropic-auth-core', version },
    null,
    2,
  )}\n`
}

function opencodeManifest(version = FORK_VERSION, coreDep = FORK_VERSION) {
  return `${JSON.stringify(
    {
      name: '@marcusrbrown/opencode-anthropic-auth',
      version,
      dependencies: { '@marcusrbrown/anthropic-auth-core': coreDep },
    },
    null,
    2,
  )}\n`
}

function piManifest(version = '1.2.2') {
  return `${JSON.stringify(
    {
      name: '@cortexkit/pi-anthropic-auth',
      version,
      dependencies: { '@marcusrbrown/anthropic-auth-core': FORK_VERSION },
    },
    null,
    2,
  )}\n`
}

// ---------------------------------------------------------------------------
// Fixture directory setup
// ---------------------------------------------------------------------------

let tempDir: string

beforeEach(async () => {
  tempDir = (await Bun.file(join(tmpdir(), 'version-sync-test-')).exists())
    ? join(tmpdir(), `version-sync-test-${Date.now()}`)
    : join(tmpdir(), `version-sync-test-${Date.now()}`)

  // Create the workspace layout the script expects.
  await mkdir(join(tempDir, 'packages', 'core'), { recursive: true })
  await mkdir(join(tempDir, 'packages', 'opencode'), { recursive: true })
  await mkdir(join(tempDir, 'packages', 'pi'), { recursive: true })
})

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Helper: spawn the real script with VERSION_SYNC_ROOT pointing at tempDir
// ---------------------------------------------------------------------------

async function runScript(
  args: string[],
  fixtures: { core?: string; opencode?: string; pi?: string } = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  // Write fixtures
  if (fixtures.core !== undefined) {
    await writeFile(
      join(tempDir, 'packages', 'core', 'package.json'),
      fixtures.core,
    )
  }
  if (fixtures.opencode !== undefined) {
    await writeFile(
      join(tempDir, 'packages', 'opencode', 'package.json'),
      fixtures.opencode,
    )
  }
  if (fixtures.pi !== undefined) {
    await writeFile(
      join(tempDir, 'packages', 'pi', 'package.json'),
      fixtures.pi,
    )
  }

  const proc = Bun.spawn(['node', SCRIPT, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, VERSION_SYNC_ROOT: tempDir },
  })

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])

  return { stdout, stderr, exitCode }
}

// ---------------------------------------------------------------------------
// Sync tests
// ---------------------------------------------------------------------------

describe('version-sync sync mode', () => {
  test('bumps core and opencode versions to target', async () => {
    const { exitCode, stdout } = await runScript([NEXT_VERSION], {
      core: coreManifest(FORK_VERSION),
      opencode: opencodeManifest(FORK_VERSION, FORK_VERSION),
      pi: piManifest('1.2.2'),
    })

    expect(exitCode).toBe(0)
    expect(stdout).toContain(NEXT_VERSION)

    const core = JSON.parse(
      await readFile(
        join(tempDir, 'packages', 'core', 'package.json'),
        'utf-8',
      ),
    )
    expect(core.version).toBe(NEXT_VERSION)

    const opencode = JSON.parse(
      await readFile(
        join(tempDir, 'packages', 'opencode', 'package.json'),
        'utf-8',
      ),
    )
    expect(opencode.version).toBe(NEXT_VERSION)
  })

  test('Pi package is not bumped and is explicitly excluded from fork lane', async () => {
    const { exitCode, stdout } = await runScript([NEXT_VERSION], {
      core: coreManifest(FORK_VERSION),
      opencode: opencodeManifest(FORK_VERSION, FORK_VERSION),
      pi: piManifest('1.2.2'),
    })

    expect(exitCode).toBe(0)
    expect(stdout).toContain('not in fork publish lane')

    const pi = JSON.parse(
      await readFile(join(tempDir, 'packages', 'pi', 'package.json'), 'utf-8'),
    )
    expect(pi.version).toBe('1.2.2')
    expect(pi.name).toBe('@cortexkit/pi-anthropic-auth')
  })

  test('already-synced packages report no changes', async () => {
    const { exitCode, stdout } = await runScript([FORK_VERSION], {
      core: coreManifest(FORK_VERSION),
      opencode: opencodeManifest(FORK_VERSION, FORK_VERSION),
      pi: piManifest(),
    })

    expect(exitCode).toBe(0)
    expect(stdout).toContain('already at target')
  })

  test('dry-run does not write files', async () => {
    const { exitCode, stdout } = await runScript([NEXT_VERSION, '--dry-run'], {
      core: coreManifest(FORK_VERSION),
      opencode: opencodeManifest(FORK_VERSION, FORK_VERSION),
      pi: piManifest('1.2.2'),
    })

    expect(exitCode).toBe(0)
    expect(stdout).toContain('[DRY RUN]')

    // Files must remain at original version.
    const core = JSON.parse(
      await readFile(
        join(tempDir, 'packages', 'core', 'package.json'),
        'utf-8',
      ),
    )
    expect(core.version).toBe(FORK_VERSION)
  })
})

// ---------------------------------------------------------------------------
// Validate mode tests
// ---------------------------------------------------------------------------

describe('version-sync validate mode', () => {
  test('passes when committed manifests match target version', async () => {
    const { exitCode, stdout } = await runScript([FORK_VERSION, '--validate'], {
      core: coreManifest(FORK_VERSION),
      opencode: opencodeManifest(FORK_VERSION, FORK_VERSION),
      pi: piManifest('1.2.2'),
    })

    expect(exitCode).toBe(0)
    expect(stdout).toContain('OK')
    expect(stdout).not.toContain('FAIL')
  })

  test('fails when core version is out of sync', async () => {
    const { exitCode, stderr } = await runScript([FORK_VERSION, '--validate'], {
      core: coreManifest('1.2.2-mb.1'), // stale
      opencode: opencodeManifest(FORK_VERSION, FORK_VERSION),
      pi: piManifest('1.2.2'),
    })

    expect(exitCode).toBe(1)
    expect(stderr).toContain('FAIL')
  })

  test('fails when Pi is accidentally at the fork version', async () => {
    const { exitCode, stderr } = await runScript([FORK_VERSION, '--validate'], {
      core: coreManifest(FORK_VERSION),
      opencode: opencodeManifest(FORK_VERSION, FORK_VERSION),
      pi: piManifest(FORK_VERSION), // Pi must NOT be at fork version
    })

    expect(exitCode).toBe(1)
    expect(stderr).toContain('Pi must not be bumped')
  })

  test('fails when OpenCode core dep is out of sync', async () => {
    const { exitCode, stderr } = await runScript([FORK_VERSION, '--validate'], {
      core: coreManifest(FORK_VERSION),
      opencode: opencodeManifest(FORK_VERSION, '1.2.2-mb.1'), // stale dep
      pi: piManifest('1.2.2'),
    })

    expect(exitCode).toBe(1)
    expect(stderr).toContain('FAIL')
    expect(stderr).toContain('@marcusrbrown/anthropic-auth-core')
  })
})

// ---------------------------------------------------------------------------
// CLI argument parsing (subprocess against real workspace — no fixture root)
// ---------------------------------------------------------------------------

describe('version-sync CLI argument parsing', () => {
  test('exits non-zero for invalid semver', async () => {
    const proc = Bun.spawn(['node', SCRIPT, 'not-a-version'], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const stderr = await new Response(proc.stderr).text()
    const exitCode = await proc.exited
    expect(exitCode).not.toBe(0)
    expect(stderr).toContain('Invalid semver')
  })

  test('exits non-zero when no version is provided', async () => {
    const proc = Bun.spawn(['node', SCRIPT], { stdout: 'pipe', stderr: 'pipe' })
    const exitCode = await proc.exited
    expect(exitCode).not.toBe(0)
  })

  test('dry-run against real workspace reports fork pair without writing', async () => {
    const proc = Bun.spawn(['node', SCRIPT, '1.2.2-mb.2', '--dry-run'], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const stdout = await new Response(proc.stdout).text()
    const exitCode = await proc.exited

    expect(exitCode).toBe(0)
    expect(stdout).toContain('[DRY RUN]')
    expect(stdout).toContain('@marcusrbrown/anthropic-auth-core')
    expect(stdout).toContain('@marcusrbrown/opencode-anthropic-auth')
    expect(stdout).toContain('not in fork publish lane')
    // Pi must not appear as a sync target.
    expect(stdout).not.toContain('pi-anthropic-auth: version')
  })
})
