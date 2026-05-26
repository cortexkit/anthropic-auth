#!/usr/bin/env node
/**
 * verify-artifacts.mjs
 *
 * Verifies packed tarballs (or local package manifests) for the fork release
 * lane before publishing. Checks:
 *
 *   1. Package name and version match expected fork values.
 *   2. OpenCode dependency metadata references forked core, not upstream core.
 *   3. Required runtime/declaration files are present in the tarball.
 *   4. No stale @cortexkit/anthropic-auth-core namespace in package content
 *      (outside explicitly allowed historical documentation paths).
 *   5. PR #40 behavioral markers are present in core artifact content:
 *      - TOKEN_URL points to platform.claude.com
 *      - User-Agent header is present in refresh logic
 *      - Retry-After header parsing is present
 *      - ClaudeOAuthRefreshError class is present
 *   6. Clean install / dependency-graph smoke check via local tarball install
 *      in a temp directory (when --install-check is passed).
 *
 * Usage:
 *   node scripts/verify-artifacts.mjs [options]
 *
 * Options:
 *   --version <ver>       Expected version (default: read from packages/core/package.json)
 *   --core-tarball <path> Path to packed core tarball (default: auto-detect from pack output)
 *   --opencode-tarball <path> Path to packed OpenCode tarball
 *   --install-check       Run a clean install/dependency-graph smoke check
 *   --manifests-only      Skip tarball checks; verify local manifests only
 *   --help                Show this help
 *
 * Exit codes:
 *   0  All checks passed
 *   1  One or more checks failed
 *
 * Secret safety: this script never prints env vars, auth config, HTTP headers
 * with credentials, token values, or local credential paths. It logs only
 * package names, versions, dist-tags, file paths, and behavioral markers.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(SCRIPT_DIR, '..')

const FORK_CORE_PKG = '@marcusrbrown/anthropic-auth-core'
const FORK_OPENCODE_PKG = '@marcusrbrown/opencode-anthropic-auth'
const STALE_CORE_PKG = '@cortexkit/anthropic-auth-core'

/**
 * Paths inside a tarball that are allowed to reference the stale core name
 * (historical docs, changelogs). These are matched as substring patterns
 * against the tarball entry path.
 */
const STALE_REF_ALLOWED_PATHS = [
  'CHANGELOG',
  'changelog',
  'README',
  'readme',
  'HISTORY',
  'history',
  '.md',
]

/**
 * PR #40 behavioral markers that must be present in the core artifact.
 * Each entry is { label, pattern } where pattern is a string that must appear
 * in the built core dist content.
 */
const PR40_MARKERS = [
  {
    label: 'TOKEN_URL uses platform.claude.com',
    pattern: 'platform.claude.com',
  },
  {
    label: 'User-Agent header in refresh logic',
    pattern: 'User-Agent',
  },
  {
    label: 'Retry-After header parsing',
    pattern: 'retry-after',
  },
  {
    label: 'ClaudeOAuthRefreshError class',
    pattern: 'ClaudeOAuthRefreshError',
  },
  {
    label: 'refreshClaudeOAuthToken function',
    pattern: 'refreshClaudeOAuthToken',
  },
]

/**
 * Required files that must be present in each packed artifact.
 */
const REQUIRED_CORE_FILES = ['package/dist/index.js', 'package/dist/index.d.ts']
const REQUIRED_OPENCODE_FILES = [
  'package/dist/index.js',
  'package/dist/index.d.ts',
  'package/dist/cli.js',
]

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = argv.slice(2)
  const opts = {
    version: null,
    coreTarball: null,
    opencodeTarball: null,
    installCheck: false,
    manifestsOnly: false,
    registryTarball: false,
    registryPackage: 'all',
    help: false,
  }

  function requireValue(flag, i) {
    const value = args[i + 1]
    if (!value || value.startsWith('--')) {
      throw new Error(`Missing value for ${flag}`)
    }
    return value
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--help' || arg === '-h') {
      opts.help = true
    } else if (arg === '--install-check') {
      opts.installCheck = true
    } else if (arg === '--manifests-only') {
      opts.manifestsOnly = true
    } else if (arg === '--registry-tarball') {
      opts.registryTarball = true
    } else if (arg === '--registry-package') {
      opts.registryPackage = requireValue(arg, i)
      i++
    } else if (arg === '--version') {
      opts.version = requireValue(arg, i)
      i++
    } else if (arg === '--core-tarball') {
      opts.coreTarball = resolve(requireValue(arg, i))
      i++
    } else if (arg === '--opencode-tarball') {
      opts.opencodeTarball = resolve(requireValue(arg, i))
      i++
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }

  return opts
}

// ---------------------------------------------------------------------------
// Logging (secret-safe: no env dumps, no auth config, no token values)
// ---------------------------------------------------------------------------

let failures = 0

function pass(label) {
  console.log(`  ✓ ${label}`)
}

function fail(label, detail) {
  console.log(`  ✗ ${label}`)
  if (detail) console.log(`    ${detail}`)
  failures++
}

function section(title) {
  console.log(`\n── ${title}`)
}

// ---------------------------------------------------------------------------
// Manifest verification (local package.json files)
// ---------------------------------------------------------------------------

async function verifyManifests(expectedVersion) {
  section('Local manifest verification')

  const corePkgPath = join(REPO_ROOT, 'packages', 'core', 'package.json')
  const opencodePkgPath = join(
    REPO_ROOT,
    'packages',
    'opencode',
    'package.json',
  )
  const piPkgPath = join(REPO_ROOT, 'packages', 'pi', 'package.json')

  const corePkg = JSON.parse(await readFile(corePkgPath, 'utf-8'))
  const opencodePkg = JSON.parse(await readFile(opencodePkgPath, 'utf-8'))
  const piPkg = JSON.parse(await readFile(piPkgPath, 'utf-8'))

  // Core name
  if (corePkg.name === FORK_CORE_PKG) {
    pass(`core package name: ${corePkg.name}`)
  } else {
    fail('core package name', `expected ${FORK_CORE_PKG}, got ${corePkg.name}`)
  }

  // Core version
  if (corePkg.version === expectedVersion) {
    pass(`core version: ${corePkg.version}`)
  } else {
    fail('core version', `expected ${expectedVersion}, got ${corePkg.version}`)
  }

  // OpenCode name
  if (opencodePkg.name === FORK_OPENCODE_PKG) {
    pass(`opencode package name: ${opencodePkg.name}`)
  } else {
    fail(
      'opencode package name',
      `expected ${FORK_OPENCODE_PKG}, got ${opencodePkg.name}`,
    )
  }

  // OpenCode version
  if (opencodePkg.version === expectedVersion) {
    pass(`opencode version: ${opencodePkg.version}`)
  } else {
    fail(
      'opencode version',
      `expected ${expectedVersion}, got ${opencodePkg.version}`,
    )
  }

  // OpenCode depends on forked core
  const coreDep = opencodePkg.dependencies?.[FORK_CORE_PKG]
  if (coreDep === expectedVersion) {
    pass(`opencode depends on ${FORK_CORE_PKG}@${coreDep}`)
  } else {
    fail(
      'opencode core dependency',
      `expected ${FORK_CORE_PKG}@${expectedVersion}, got ${coreDep ?? '(missing)'}`,
    )
  }

  // OpenCode must NOT depend on stale upstream core
  const staleDep = opencodePkg.dependencies?.[STALE_CORE_PKG]
  if (!staleDep) {
    pass(`opencode has no stale ${STALE_CORE_PKG} dependency`)
  } else {
    fail(
      'stale upstream core dependency in opencode manifest',
      `${STALE_CORE_PKG}@${staleDep} must be removed`,
    )
  }

  // Pi must NOT be at the fork version
  if (piPkg.version !== expectedVersion) {
    pass(
      `pi is not at fork version (pi@${piPkg.version}, fork@${expectedVersion})`,
    )
  } else {
    fail(
      'Pi must not be at fork version',
      `pi@${piPkg.version} matches fork version — Pi is not in the fork publish lane`,
    )
  }

  // Pi must retain its upstream name
  if (piPkg.name === '@cortexkit/pi-anthropic-auth') {
    pass(`pi package name: ${piPkg.name}`)
  } else {
    fail(
      'pi package name',
      `expected @cortexkit/pi-anthropic-auth, got ${piPkg.name}`,
    )
  }
}

// ---------------------------------------------------------------------------
// Tarball extraction helpers
// ---------------------------------------------------------------------------

/**
 * Extract a .tgz tarball to a temp directory and return the path.
 * Uses the system `tar` command for reliability.
 */
function extractTarball(tarballPath) {
  const extractDir = mkdtempSync(join(tmpdir(), 'verify-artifact-'))
  const result = spawnSync('tar', ['xzf', tarballPath, '-C', extractDir], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.status !== 0) {
    throw new Error(
      `Failed to extract ${basename(tarballPath)}: ${result.stderr?.toString() ?? 'unknown error'}`,
    )
  }
  return extractDir
}

/**
 * Recursively collect all file paths under a directory.
 */
function collectFiles(dir, base = dir) {
  const entries = readdirSync(dir, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...collectFiles(full, base))
    } else {
      files.push(full.slice(base.length + 1))
    }
  }
  return files
}

/**
 * Read all text files in an extracted tarball directory and return their
 * concatenated content (for pattern scanning).
 */
async function readExtractedContent(extractDir) {
  const files = collectFiles(extractDir)
  const textExts = ['.js', '.ts', '.mjs', '.cjs', '.json', '.md', '.txt']
  const chunks = []
  for (const rel of files) {
    if (textExts.some((ext) => rel.endsWith(ext))) {
      try {
        const content = await readFile(join(extractDir, rel), 'utf-8')
        chunks.push({ path: rel, content })
      } catch {
        // Binary or unreadable — skip
      }
    }
  }
  return chunks
}

// ---------------------------------------------------------------------------
// Tarball verification
// ---------------------------------------------------------------------------

async function verifyTarball(
  tarballPath,
  expectedPkg,
  expectedVersion,
  opts = {},
) {
  const label = basename(tarballPath)
  section(`Tarball verification: ${label}`)

  if (!existsSync(tarballPath)) {
    fail(`tarball exists`, `not found: ${tarballPath}`)
    return
  }

  let extractDir
  try {
    extractDir = extractTarball(tarballPath)
  } catch (err) {
    fail('tarball extraction', err.message)
    return
  }

  try {
    const files = collectFiles(extractDir)
    const chunks = await readExtractedContent(extractDir)

    // 1. package.json name and version
    const pkgJsonChunk = chunks.find((c) => c.path === 'package/package.json')
    if (!pkgJsonChunk) {
      fail('package/package.json present in tarball')
      return
    }

    let pkg
    try {
      pkg = JSON.parse(pkgJsonChunk.content)
    } catch {
      fail('package/package.json is valid JSON')
      return
    }

    if (pkg.name === expectedPkg) {
      pass(`package name: ${pkg.name}`)
    } else {
      fail('package name', `expected ${expectedPkg}, got ${pkg.name}`)
    }

    if (pkg.version === expectedVersion) {
      pass(`package version: ${pkg.version}`)
    } else {
      fail('package version', `expected ${expectedVersion}, got ${pkg.version}`)
    }

    // 2. Required files
    const requiredFiles = opts.requiredFiles ?? []
    for (const req of requiredFiles) {
      if (files.includes(req)) {
        pass(`required file present: ${req}`)
      } else {
        fail(`required file missing: ${req}`)
      }
    }

    // 3. OpenCode-specific: dependency on forked core
    if (opts.checkCoreDep) {
      const coreDep = pkg.dependencies?.[FORK_CORE_PKG]
      if (coreDep === expectedVersion) {
        pass(`depends on ${FORK_CORE_PKG}@${coreDep}`)
      } else {
        fail(
          'core dependency',
          `expected ${FORK_CORE_PKG}@${expectedVersion}, got ${coreDep ?? '(missing)'}`,
        )
      }

      const staleDep = pkg.dependencies?.[STALE_CORE_PKG]
      if (!staleDep) {
        pass(`no stale ${STALE_CORE_PKG} dependency in tarball package.json`)
      } else {
        fail(
          'stale upstream core dependency',
          `${STALE_CORE_PKG}@${staleDep} found in tarball package.json — release invariant violated`,
        )
      }
    }

    // 4. Stale namespace scan across tarball content
    //    Allow references only in historical documentation paths.
    const staleRefs = []
    for (const { path, content } of chunks) {
      if (content.includes(STALE_CORE_PKG)) {
        const isAllowed = STALE_REF_ALLOWED_PATHS.some((p) => path.includes(p))
        if (!isAllowed) {
          staleRefs.push(path)
        }
      }
    }
    if (staleRefs.length === 0) {
      pass(`no stale ${STALE_CORE_PKG} references in non-historical content`)
    } else {
      fail(
        `stale ${STALE_CORE_PKG} references found in tarball`,
        `files: ${staleRefs.join(', ')}`,
      )
    }

    // 5. PR #40 behavioral markers (core only)
    if (opts.checkPR40Markers) {
      section('PR #40 behavioral marker checks')
      // Collect all dist JS content for scanning
      const distContent = chunks
        .filter(
          (c) => c.path.startsWith('package/dist/') && c.path.endsWith('.js'),
        )
        .map((c) => c.content)
        .join('\n')

      if (distContent.length === 0) {
        fail(
          'dist JS content found for PR #40 marker scan',
          'no dist/*.js files in tarball',
        )
      } else {
        for (const marker of PR40_MARKERS) {
          if (distContent.includes(marker.pattern)) {
            pass(`PR #40 marker: ${marker.label}`)
          } else {
            fail(
              `PR #40 marker missing: ${marker.label}`,
              `pattern '${marker.pattern}' not found in dist content`,
            )
          }
        }
      }

      // Additional: verify TOKEN_URL points to platform.claude.com (not api.anthropic.com)
      if (distContent.includes('api.anthropic.com/v1/oauth/token')) {
        fail(
          'stale TOKEN_URL',
          'dist content references api.anthropic.com/v1/oauth/token — should be platform.claude.com',
        )
      } else {
        pass('TOKEN_URL does not reference stale api.anthropic.com endpoint')
      }
    }
  } finally {
    try {
      rmSync(extractDir, { recursive: true, force: true })
    } catch {
      // Best-effort cleanup
    }
  }
}

// ---------------------------------------------------------------------------
// Pack helpers (create tarballs from workspace packages)
// ---------------------------------------------------------------------------

/**
 * Run `npm pack` in a package directory and return the path to the tarball.
 * Uses --dry-run=false to actually produce the file.
 */
function packPackage(pkgDir, outputDir) {
  const result = spawnSync('npm', ['pack', '--pack-destination', outputDir], {
    cwd: pkgDir,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.status !== 0) {
    throw new Error(
      `npm pack failed in ${pkgDir}: ${result.stderr?.toString() ?? 'unknown'}`,
    )
  }
  const stdout = result.stdout?.toString().trim() ?? ''
  // npm pack outputs the tarball filename on stdout
  const tgzName = stdout.split('\n').pop()?.trim()
  if (!tgzName)
    throw new Error(`npm pack did not output a tarball name in ${pkgDir}`)
  return join(outputDir, tgzName)
}

// ---------------------------------------------------------------------------
// Install-graph smoke check
// ---------------------------------------------------------------------------

/**
 * Install OpenCode tarball in a temp dir and verify the dependency graph
 * resolves forked core at the expected version.
 *
 * This does NOT require npm auth tokens — it installs from local tarballs.
 */
async function runInstallCheck(opencodeTarball, coreTarball, expectedVersion) {
  section('Clean install / dependency-graph smoke check')

  const installDir = mkdtempSync(join(tmpdir(), 'verify-install-'))
  try {
    // Write a minimal package.json
    await writeFile(
      join(installDir, 'package.json'),
      JSON.stringify(
        {
          name: 'verify-install-smoke',
          version: '0.0.0',
          private: true,
          dependencies: {
            [FORK_OPENCODE_PKG]: `file:${opencodeTarball}`,
            [FORK_CORE_PKG]: `file:${coreTarball}`,
          },
        },
        null,
        2,
      ),
    )

    // Run npm install with local tarballs (no registry auth needed)
    const installResult = spawnSync(
      'npm',
      ['install', '--no-save', '--prefer-offline', '--ignore-scripts'],
      {
        cwd: installDir,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          // Suppress npm update notifications and audit output
          NPM_CONFIG_UPDATE_NOTIFIER: 'false',
          NPM_CONFIG_AUDIT: 'false',
          NPM_CONFIG_FUND: 'false',
        },
      },
    )

    if (installResult.status !== 0) {
      const stderr = installResult.stderr?.toString() ?? ''
      // Filter out any lines that might contain auth/credential info
      const safeStderr = stderr
        .split('\n')
        .filter(
          (line) =>
            !line.includes('_authToken') &&
            !line.includes('//registry') &&
            !line.includes('npm ERR! code E401') &&
            !line.includes('npm ERR! code E403'),
        )
        .join('\n')
      fail('npm install with local tarballs', safeStderr.slice(0, 500))
      return
    }

    pass('npm install with local tarballs succeeded')

    // Verify the installed OpenCode package.json
    const installedOpencodePkg = join(
      installDir,
      'node_modules',
      '@marcusrbrown',
      'opencode-anthropic-auth',
      'package.json',
    )
    if (existsSync(installedOpencodePkg)) {
      const pkg = JSON.parse(await readFile(installedOpencodePkg, 'utf-8'))
      if (pkg.version === expectedVersion) {
        pass(`installed opencode version: ${pkg.version}`)
      } else {
        fail(
          'installed opencode version',
          `expected ${expectedVersion}, got ${pkg.version}`,
        )
      }
    } else {
      fail('installed opencode package.json found')
    }

    // Verify the installed core package.json
    const installedCorePkg = join(
      installDir,
      'node_modules',
      '@marcusrbrown',
      'anthropic-auth-core',
      'package.json',
    )
    if (existsSync(installedCorePkg)) {
      const pkg = JSON.parse(await readFile(installedCorePkg, 'utf-8'))
      if (pkg.name === FORK_CORE_PKG) {
        pass(`installed core name: ${pkg.name}`)
      } else {
        fail(
          'installed core name',
          `expected ${FORK_CORE_PKG}, got ${pkg.name}`,
        )
      }
      if (pkg.version === expectedVersion) {
        pass(`installed core version: ${pkg.version}`)
      } else {
        fail(
          'installed core version',
          `expected ${expectedVersion}, got ${pkg.version}`,
        )
      }
    } else {
      fail('installed core package.json found')
    }

    // Verify no stale upstream core is installed
    const staleCorePath = join(
      installDir,
      'node_modules',
      '@cortexkit',
      'anthropic-auth-core',
    )
    if (!existsSync(staleCorePath)) {
      pass(`no stale ${STALE_CORE_PKG} in installed node_modules`)
    } else {
      fail(
        'stale upstream core installed',
        `${STALE_CORE_PKG} found in node_modules — dependency graph is broken`,
      )
    }
  } finally {
    try {
      rmSync(installDir, { recursive: true, force: true })
    } catch {
      // Best-effort cleanup
    }
  }
}

// ---------------------------------------------------------------------------
// Registry tarball verification
// ---------------------------------------------------------------------------

/**
 * Download the published tarball for a package from the npm registry using
 * `npm pack <pkg>@<ver>` (which fetches from the registry without auth for
 * public packages) and run the same tarball checks against it.
 *
 * This is the "fail-closed" path for already-published artifacts: instead of
 * trusting registry metadata alone, we fetch and inspect the actual tarball.
 *
 * @param {string} pkg - npm package name (e.g. '@marcusrbrown/anthropic-auth-core')
 * @param {string} version - expected version string
 * @param {object} verifyOpts - options forwarded to verifyTarball
 */
async function verifyRegistryTarball(pkg, version, verifyOpts = {}) {
  section(`Registry tarball verification: ${pkg}@${version}`)

  const packDir = mkdtempSync(join(tmpdir(), 'verify-registry-'))
  try {
    // `npm pack <pkg>@<ver>` downloads the published tarball from the registry.
    // No auth token is required for public packages.
    const result = spawnSync(
      'npm',
      ['pack', `${pkg}@${version}`, '--pack-destination', packDir],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          NPM_CONFIG_UPDATE_NOTIFIER: 'false',
          NPM_CONFIG_AUDIT: 'false',
          NPM_CONFIG_FUND: 'false',
        },
      },
    )

    if (result.status !== 0) {
      const stderr = result.stderr?.toString() ?? ''
      fail(
        `registry tarball download for ${pkg}@${version}`,
        `npm pack exited ${result.status}: ${stderr.slice(0, 300)}`,
      )
      return
    }

    const stdout = result.stdout?.toString().trim() ?? ''
    const tgzName = stdout.split('\n').pop()?.trim()
    if (!tgzName) {
      fail(
        `registry tarball download for ${pkg}@${version}`,
        'npm pack produced no output',
      )
      return
    }

    const tarballPath = join(packDir, tgzName)
    pass(`downloaded registry tarball: ${tgzName}`)

    await verifyTarball(tarballPath, pkg, version, verifyOpts)
  } finally {
    try {
      rmSync(packDir, { recursive: true, force: true })
    } catch {
      // Best-effort cleanup
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  let opts
  try {
    opts = parseArgs(process.argv)
  } catch (err) {
    console.error(`verify-artifacts.mjs: ${err.message}`)
    process.exit(1)
  }

  if (opts.help) {
    console.log(`
verify-artifacts.mjs — Fork release artifact verification

Usage:
  node scripts/verify-artifacts.mjs [options]

Options:
  --version <ver>           Expected version (default: read from packages/core/package.json)
  --core-tarball <path>     Path to packed core tarball
  --opencode-tarball <path> Path to packed OpenCode tarball
  --install-check           Run clean install/dependency-graph smoke check
  --manifests-only          Skip tarball checks; verify local manifests only
  --registry-tarball        Also download and verify published registry tarballs
  --registry-package <pkg>  Registry package to verify: core, opencode, or all (default: all)
  --help                    Show this help

Exit codes:
  0  All checks passed
  1  One or more checks failed
`)
    process.exit(0)
  }

  // Resolve expected version
  let expectedVersion = opts.version
  if (!expectedVersion) {
    const corePkg = JSON.parse(
      await readFile(
        join(REPO_ROOT, 'packages', 'core', 'package.json'),
        'utf-8',
      ),
    )
    expectedVersion = corePkg.version
  }

  console.log(`\n╔══════════════════════════════════════════════════════╗`)
  console.log(`║  Fork artifact verification — ${expectedVersion.padEnd(22)}║`)
  console.log(`╚══════════════════════════════════════════════════════╝`)
  console.log(`  Core package:    ${FORK_CORE_PKG}`)
  console.log(`  OpenCode package: ${FORK_OPENCODE_PKG}`)
  console.log(`  Expected version: ${expectedVersion}`)

  // Always verify local manifests
  await verifyManifests(expectedVersion)

  if (opts.manifestsOnly) {
    console.log('\n(--manifests-only: skipping tarball and install checks)')
  } else {
    // Resolve or create tarballs
    let coreTarball = opts.coreTarball
    let opencodeTarball = opts.opencodeTarball

    const packDir = mkdtempSync(join(tmpdir(), 'verify-pack-'))
    let cleanupPackDir = true

    try {
      if (!coreTarball) {
        section('Packing core tarball')
        try {
          coreTarball = packPackage(
            join(REPO_ROOT, 'packages', 'core'),
            packDir,
          )
          pass(`packed: ${basename(coreTarball)}`)
        } catch (err) {
          fail('pack core', err.message)
          console.error(
            '\nNote: build packages first with `bun run build` before running this script.',
          )
          cleanupPackDir = false
        }
      }

      if (!opencodeTarball) {
        section('Packing OpenCode tarball')
        try {
          opencodeTarball = packPackage(
            join(REPO_ROOT, 'packages', 'opencode'),
            packDir,
          )
          pass(`packed: ${basename(opencodeTarball)}`)
        } catch (err) {
          fail('pack opencode', err.message)
          cleanupPackDir = false
        }
      }

      if (coreTarball) {
        await verifyTarball(coreTarball, FORK_CORE_PKG, expectedVersion, {
          requiredFiles: REQUIRED_CORE_FILES,
          checkPR40Markers: true,
        })
      }

      if (opencodeTarball) {
        await verifyTarball(
          opencodeTarball,
          FORK_OPENCODE_PKG,
          expectedVersion,
          {
            requiredFiles: REQUIRED_OPENCODE_FILES,
            checkCoreDep: true,
          },
        )
      }

      if (opts.installCheck && coreTarball && opencodeTarball) {
        await runInstallCheck(opencodeTarball, coreTarball, expectedVersion)
      } else if (opts.installCheck) {
        console.log(
          '\n(--install-check: skipped because one or more tarballs could not be packed)',
        )
      }
    } finally {
      if (cleanupPackDir) {
        try {
          rmSync(packDir, { recursive: true, force: true })
        } catch {
          // Best-effort cleanup
        }
      }
    }
  }

  // Registry tarball verification (fail-closed: download and inspect published tarballs)
  if (opts.registryTarball) {
    if (!['core', 'opencode', 'all'].includes(opts.registryPackage)) {
      fail(
        'registry package selector',
        `expected core, opencode, or all; got ${opts.registryPackage}`,
      )
    }

    if (opts.registryPackage === 'core' || opts.registryPackage === 'all') {
      await verifyRegistryTarball(FORK_CORE_PKG, expectedVersion, {
        requiredFiles: REQUIRED_CORE_FILES,
        checkPR40Markers: true,
      })
    }

    if (opts.registryPackage === 'opencode' || opts.registryPackage === 'all') {
      await verifyRegistryTarball(FORK_OPENCODE_PKG, expectedVersion, {
        requiredFiles: REQUIRED_OPENCODE_FILES,
        checkCoreDep: true,
      })
    }
  }

  // Summary
  console.log(`\n${'─'.repeat(56)}`)
  if (failures === 0) {
    console.log('✓ All artifact verification checks passed.')
    process.exit(0)
  } else {
    console.log(
      `✗ ${failures} check(s) failed. Release invariants not satisfied.`,
    )
    process.exit(1)
  }
}

main().catch((err) => {
  console.error('verify-artifacts.mjs: unexpected error:', err.message)
  process.exit(1)
})
