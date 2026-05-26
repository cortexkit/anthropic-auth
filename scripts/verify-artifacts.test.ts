/**
 * Tests for scripts/verify-artifacts.mjs
 *
 * Tests the artifact verification logic using synthetic tarballs and manifests.
 * Run with: bun test scripts/verify-artifacts.test.ts
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ---------------------------------------------------------------------------
// Constants (must match verify-artifacts.mjs)
// ---------------------------------------------------------------------------

const FORK_CORE_PKG = '@marcusrbrown/anthropic-auth-core'
const FORK_OPENCODE_PKG = '@marcusrbrown/opencode-anthropic-auth'
const STALE_CORE_PKG = '@cortexkit/anthropic-auth-core'
const FORK_VERSION = '1.2.2-mb.2'

const SCRIPT_PATH = join(import.meta.dir, 'verify-artifacts.mjs')

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Run verify-artifacts.mjs with given args and return { exitCode, stdout, stderr }.
 */
function runVerify(args: string[]): {
  exitCode: number
  stdout: string
  stderr: string
} {
  const result = spawnSync('node', [SCRIPT_PATH, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env },
  })
  return {
    exitCode: result.status ?? 1,
    stdout: result.stdout?.toString() ?? '',
    stderr: result.stderr?.toString() ?? '',
  }
}

/**
 * Create a minimal tarball (.tgz) from a directory using system tar.
 * Returns the path to the created tarball.
 */
function createTarball(sourceDir: string, outputPath: string): void {
  const result = spawnSync(
    'tar',
    ['czf', outputPath, '-C', sourceDir, 'package'],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  if (result.status !== 0) {
    throw new Error(`tar failed: ${result.stderr?.toString()}`)
  }
}

/**
 * Build a synthetic package directory structure for tarball creation.
 */
async function buildPackageDir(
  dir: string,
  pkg: Record<string, unknown>,
  distFiles: Record<string, string> = {},
): Promise<void> {
  const pkgDir = join(dir, 'package')
  const distDir = join(pkgDir, 'dist')
  await mkdir(distDir, { recursive: true })
  await writeFile(join(pkgDir, 'package.json'), JSON.stringify(pkg, null, 2))
  for (const [name, content] of Object.entries(distFiles)) {
    await writeFile(join(distDir, name), content)
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let tempDir: string

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'verify-artifacts-test-'))
})

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// --manifests-only tests (no tarball needed)
// ---------------------------------------------------------------------------

describe('--manifests-only: local manifest verification', () => {
  test('passes with correct real workspace manifests', () => {
    // The real workspace should already have correct manifests from Unit 1.
    const { exitCode, stdout } = runVerify([
      '--manifests-only',
      '--version',
      FORK_VERSION,
    ])
    expect(exitCode).toBe(0)
    expect(stdout).toContain(FORK_CORE_PKG)
    expect(stdout).toContain(FORK_OPENCODE_PKG)
    expect(stdout).toContain('✓')
  })

  test('reports correct package names and versions', () => {
    const { stdout } = runVerify([
      '--manifests-only',
      '--version',
      FORK_VERSION,
    ])
    expect(stdout).toContain(`core package name: ${FORK_CORE_PKG}`)
    expect(stdout).toContain(`core version: ${FORK_VERSION}`)
    expect(stdout).toContain(`opencode version: ${FORK_VERSION}`)
  })

  test('reports no stale upstream core dependency', () => {
    const { stdout } = runVerify([
      '--manifests-only',
      '--version',
      FORK_VERSION,
    ])
    expect(stdout).toContain(`no stale ${STALE_CORE_PKG} dependency`)
  })

  test('reports Pi is not at fork version', () => {
    const { stdout } = runVerify([
      '--manifests-only',
      '--version',
      FORK_VERSION,
    ])
    expect(stdout).toContain('pi is not at fork version')
  })

  test('fails with wrong expected version', () => {
    const { exitCode, stdout } = runVerify([
      '--manifests-only',
      '--version',
      '9.9.9-mb.99',
    ])
    expect(exitCode).toBe(1)
    expect(stdout).toContain('✗')
  })
})

// ---------------------------------------------------------------------------
// Tarball verification tests
// ---------------------------------------------------------------------------

describe('tarball verification: core artifact', () => {
  test('happy path: valid core tarball passes all checks', async () => {
    const pkgDir = join(tempDir, 'core-pkg')
    const tarball = join(tempDir, 'core.tgz')

    // PR #40 markers must be present in dist content
    const distContent = [
      'const TOKEN_URL = "https://platform.claude.com/v1/oauth/token"',
      'const userAgent = "axios/1.13.6"',
      'headers["User-Agent"] = userAgent',
      'const retryAfter = response.headers.get("retry-after")',
      'class ClaudeOAuthRefreshError extends Error {}',
      'async function refreshClaudeOAuthToken(input) {}',
    ].join('\n')

    await buildPackageDir(
      pkgDir,
      {
        name: FORK_CORE_PKG,
        version: FORK_VERSION,
        main: './dist/index.js',
        types: './dist/index.d.ts',
      },
      {
        'index.js': distContent,
        'index.d.ts': 'export declare function refreshClaudeOAuthToken(): void',
      },
    )
    createTarball(pkgDir, tarball)

    const { stdout: stdout2 } = runVerify([
      '--version',
      FORK_VERSION,
      '--core-tarball',
      tarball,
      '--opencode-tarball',
      tarball, // reuse core tarball as placeholder; opencode checks will fail on name
    ])

    // Core tarball checks should pass; opencode name check will fail (expected)
    expect(stdout2).toContain(`package name: ${FORK_CORE_PKG}`)
    expect(stdout2).toContain(`package version: ${FORK_VERSION}`)
    expect(stdout2).toContain(
      'PR #40 marker: TOKEN_URL uses platform.claude.com',
    )
    expect(stdout2).toContain(
      'PR #40 marker: User-Agent header in refresh logic',
    )
    expect(stdout2).toContain('PR #40 marker: Retry-After header parsing')
    expect(stdout2).toContain('PR #40 marker: ClaudeOAuthRefreshError class')
    expect(stdout2).toContain('PR #40 marker: refreshClaudeOAuthToken function')
  })

  test('fails when core tarball has stale upstream package name', async () => {
    const pkgDir = join(tempDir, 'stale-core-pkg')
    const tarball = join(tempDir, 'stale-core.tgz')

    await buildPackageDir(
      pkgDir,
      { name: STALE_CORE_PKG, version: FORK_VERSION },
      { 'index.js': 'export {}', 'index.d.ts': 'export {}' },
    )
    createTarball(pkgDir, tarball)

    const { exitCode, stdout } = runVerify([
      '--version',
      FORK_VERSION,
      '--core-tarball',
      tarball,
      '--opencode-tarball',
      tarball,
    ])

    expect(exitCode).toBe(1)
    expect(stdout).toContain('✗')
    // Should fail on package name check (detail is on the next line)
    expect(stdout).toContain('package name')
    expect(stdout).toContain(`expected ${FORK_CORE_PKG}`)
  })

  test('fails when PR #40 markers are missing from core dist', async () => {
    const pkgDir = join(tempDir, 'no-pr40-pkg')
    const tarball = join(tempDir, 'no-pr40.tgz')

    // Dist content without PR #40 markers
    await buildPackageDir(
      pkgDir,
      { name: FORK_CORE_PKG, version: FORK_VERSION },
      {
        'index.js':
          'export const TOKEN_URL = "https://api.anthropic.com/v1/oauth/token"',
        'index.d.ts': 'export {}',
      },
    )
    createTarball(pkgDir, tarball)

    const { exitCode, stdout } = runVerify([
      '--version',
      FORK_VERSION,
      '--core-tarball',
      tarball,
      '--opencode-tarball',
      tarball,
    ])

    expect(exitCode).toBe(1)
    // Should fail on stale TOKEN_URL
    expect(stdout).toContain('stale TOKEN_URL')
    // Should fail on missing markers
    expect(stdout).toContain('PR #40 marker missing')
  })

  test('fails when stale namespace appears in non-historical dist content', async () => {
    const pkgDir = join(tempDir, 'stale-ref-pkg')
    const tarball = join(tempDir, 'stale-ref.tgz')

    await buildPackageDir(
      pkgDir,
      { name: FORK_CORE_PKG, version: FORK_VERSION },
      {
        'index.js': `import { foo } from "@cortexkit/anthropic-auth-core"`,
        'index.d.ts': 'export {}',
      },
    )
    createTarball(pkgDir, tarball)

    const { exitCode, stdout } = runVerify([
      '--version',
      FORK_VERSION,
      '--core-tarball',
      tarball,
      '--opencode-tarball',
      tarball,
    ])

    expect(exitCode).toBe(1)
    expect(stdout).toContain(
      `stale ${STALE_CORE_PKG} references found in tarball`,
    )
  })
})

describe('tarball verification: opencode artifact', () => {
  test('fails when opencode tarball depends on stale upstream core', async () => {
    const corePkgDir = join(tempDir, 'core-pkg')
    const coreTarball = join(tempDir, 'core.tgz')
    const opencodePkgDir = join(tempDir, 'opencode-pkg')
    const opencodeTarball = join(tempDir, 'opencode.tgz')

    const pr40Content = [
      'const TOKEN_URL = "https://platform.claude.com/v1/oauth/token"',
      'headers["User-Agent"] = "axios/1.13.6"',
      'response.headers.get("retry-after")',
      'class ClaudeOAuthRefreshError extends Error {}',
      'async function refreshClaudeOAuthToken(input) {}',
    ].join('\n')

    await buildPackageDir(
      corePkgDir,
      { name: FORK_CORE_PKG, version: FORK_VERSION },
      { 'index.js': pr40Content, 'index.d.ts': 'export {}' },
    )
    createTarball(corePkgDir, coreTarball)

    // OpenCode with stale upstream core dependency
    await buildPackageDir(
      opencodePkgDir,
      {
        name: FORK_OPENCODE_PKG,
        version: FORK_VERSION,
        dependencies: {
          [STALE_CORE_PKG]: FORK_VERSION, // stale!
        },
      },
      {
        'index.js': 'export {}',
        'index.d.ts': 'export {}',
        'cli.js': '#!/usr/bin/env node',
      },
    )
    createTarball(opencodePkgDir, opencodeTarball)

    const { exitCode, stdout } = runVerify([
      '--version',
      FORK_VERSION,
      '--core-tarball',
      coreTarball,
      '--opencode-tarball',
      opencodeTarball,
    ])

    expect(exitCode).toBe(1)
    expect(stdout).toContain('stale upstream core dependency')
    expect(stdout).toContain(STALE_CORE_PKG)
  })

  test('fails when opencode tarball is missing required files', async () => {
    const corePkgDir = join(tempDir, 'core-pkg')
    const coreTarball = join(tempDir, 'core.tgz')
    const opencodePkgDir = join(tempDir, 'opencode-pkg')
    const opencodeTarball = join(tempDir, 'opencode.tgz')

    const pr40Content = [
      'const TOKEN_URL = "https://platform.claude.com/v1/oauth/token"',
      'headers["User-Agent"] = "axios/1.13.6"',
      'response.headers.get("retry-after")',
      'class ClaudeOAuthRefreshError extends Error {}',
      'async function refreshClaudeOAuthToken(input) {}',
    ].join('\n')

    await buildPackageDir(
      corePkgDir,
      { name: FORK_CORE_PKG, version: FORK_VERSION },
      { 'index.js': pr40Content, 'index.d.ts': 'export {}' },
    )
    createTarball(corePkgDir, coreTarball)

    // OpenCode missing cli.js
    await buildPackageDir(
      opencodePkgDir,
      {
        name: FORK_OPENCODE_PKG,
        version: FORK_VERSION,
        dependencies: { [FORK_CORE_PKG]: FORK_VERSION },
      },
      {
        'index.js': 'export {}',
        'index.d.ts': 'export {}',
        // cli.js intentionally missing
      },
    )
    createTarball(opencodePkgDir, opencodeTarball)

    const { exitCode, stdout } = runVerify([
      '--version',
      FORK_VERSION,
      '--core-tarball',
      coreTarball,
      '--opencode-tarball',
      opencodeTarball,
    ])

    expect(exitCode).toBe(1)
    expect(stdout).toContain('required file missing: package/dist/cli.js')
  })
})

// ---------------------------------------------------------------------------
// --help
// ---------------------------------------------------------------------------

describe('--help', () => {
  test('exits 0 and prints usage', () => {
    const { exitCode, stdout } = runVerify(['--help'])
    expect(exitCode).toBe(0)
    expect(stdout).toContain('verify-artifacts.mjs')
    expect(stdout).toContain('--version')
    expect(stdout).toContain('--install-check')
  })
})

describe('argument parsing', () => {
  test('rejects unknown flags', () => {
    const { exitCode, stderr } = runVerify(['--wat'])
    expect(exitCode).not.toBe(0)
    expect(stderr).toContain('Unknown argument')
  })

  test('rejects missing flag values', () => {
    const { exitCode, stderr } = runVerify(['--version'])
    expect(exitCode).not.toBe(0)
    expect(stderr).toContain('Missing value for --version')
  })
})
