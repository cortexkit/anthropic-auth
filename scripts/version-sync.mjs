#!/usr/bin/env node

/**
 * Synchronize fork-lane package versions from an explicit version or git tag.
 *
 * Fork publish set: @marcusrbrown/anthropic-auth-core + @marcusrbrown/opencode-anthropic-auth
 * Pi (@cortexkit/pi-anthropic-auth) is intentionally excluded from the fork publish lane.
 *
 * Usage:
 *   node scripts/version-sync.mjs 1.8.0
 *   node scripts/version-sync.mjs --from-tag
 *   node scripts/version-sync.mjs 1.8.0 --dry-run
 *   node scripts/version-sync.mjs 1.8.0 --validate
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// VERSION_SYNC_ROOT is a test-only env override that redirects the script to a
// fixture directory instead of the real workspace. Never set this in production.
const root =
  process.env.VERSION_SYNC_ROOT ??
  join(dirname(fileURLToPath(import.meta.url)), '..')
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[\w.]+)?(?:\+[\w.]+)?$/

/**
 * Fork publish set: packages that are versioned and published together in the fork lane.
 * Pi is explicitly excluded — it remains @cortexkit/pi-anthropic-auth and is not published
 * under the @marcusrbrown scope.
 */
const FORK_PUBLISH_SET = [
  {
    path: join(root, 'packages', 'core', 'package.json'),
    name: '@marcusrbrown/anthropic-auth-core',
  },
  {
    path: join(root, 'packages', 'opencode', 'package.json'),
    name: '@marcusrbrown/opencode-anthropic-auth',
    /** Dependency on forked core that must be kept in sync. */
    forkCoreDep: '@marcusrbrown/anthropic-auth-core',
  },
]

/**
 * Pi is workspace-adjacent but not in the fork publish lane.
 * We track it only to assert it is NOT bumped to the fork version.
 */
const PI_PACKAGE = {
  path: join(root, 'packages', 'pi', 'package.json'),
  name: '@cortexkit/pi-anthropic-auth',
}

function parseArgs(argv) {
  const args = argv.slice(2)
  let version = null
  let fromTag = false
  let dryRun = false
  let validate = false

  for (const arg of args) {
    if (arg === '--from-tag') {
      fromTag = true
    } else if (arg === '--dry-run') {
      dryRun = true
    } else if (arg === '--validate') {
      validate = true
    } else if (!version && !arg.startsWith('-')) {
      version = arg
    } else {
      console.error(`Unknown argument: ${arg}`)
      process.exit(1)
    }
  }

  if (fromTag) {
    const ref = process.env.GITHUB_REF_NAME
    if (!ref) {
      console.error('--from-tag requires GITHUB_REF_NAME environment variable')
      process.exit(1)
    }
    version = ref.replace(/^v/, '')
  }

  if (!version) {
    console.error(
      'Usage: version-sync.mjs <version> [--dry-run] [--validate]\n' +
        '       version-sync.mjs --from-tag [--dry-run] [--validate]',
    )
    process.exit(1)
  }

  if (!SEMVER_RE.test(version)) {
    console.error(`Invalid semver version: '${version}'`)
    process.exit(1)
  }

  return { version, dryRun, validate }
}

/**
 * Validate that committed manifests already match the target version.
 * Exits non-zero if any fork-lane package is out of sync.
 * Used by CI to ensure version-sync mutations are committed before publish.
 */
function validateCommittedState(version) {
  console.log(
    `Validating committed manifest state for fork lane at ${version}\n`,
  )
  let valid = true

  for (const entry of FORK_PUBLISH_SET) {
    if (!existsSync(entry.path)) {
      console.error(`  MISSING: ${entry.path}`)
      valid = false
      continue
    }
    const pkg = JSON.parse(readFileSync(entry.path, 'utf-8'))
    const rel = entry.path.slice(root.length + 1)

    if (pkg.name !== entry.name) {
      console.error(
        `  FAIL ${rel}: name is '${pkg.name}', expected '${entry.name}'`,
      )
      valid = false
    } else if (pkg.version !== version) {
      console.error(
        `  FAIL ${rel}: version is '${pkg.version}', expected '${version}'`,
      )
      valid = false
    } else {
      console.log(`  OK   ${rel}: ${pkg.name}@${pkg.version}`)
    }

    if (entry.forkCoreDep) {
      const actual = pkg.dependencies?.[entry.forkCoreDep]
      if (actual !== version) {
        console.error(
          `  FAIL ${rel}: ${entry.forkCoreDep} is '${actual ?? '(missing)'}', expected '${version}'`,
        )
        valid = false
      } else {
        console.log(`  OK   ${rel}: ${entry.forkCoreDep}@${actual}`)
      }
    }
  }

  // Assert Pi is NOT at the fork version.
  if (existsSync(PI_PACKAGE.path)) {
    const pi = JSON.parse(readFileSync(PI_PACKAGE.path, 'utf-8'))
    const rel = PI_PACKAGE.path.slice(root.length + 1)
    if (pi.version === version) {
      console.error(
        `  FAIL ${rel}: Pi version is '${pi.version}' — Pi must not be bumped to the fork release version`,
      )
      valid = false
    } else {
      console.log(
        `  OK   ${rel}: Pi at '${pi.version}' (not in fork publish lane)`,
      )
    }
  }

  if (!valid) {
    console.error(
      '\nValidation failed: committed manifests do not match the expected fork lane state.\n' +
        'Run version-sync.mjs without --validate to apply changes, then commit before publishing.',
    )
    process.exit(1)
  }

  console.log('\nValidation passed.')
}

const { version, dryRun, validate } = parseArgs(process.argv)

if (validate) {
  validateCommittedState(version)
  process.exit(0)
}

console.log(
  `${dryRun ? '[DRY RUN] ' : ''}Syncing fork-lane package versions to ${version}\n` +
    `Fork publish set: ${FORK_PUBLISH_SET.map((e) => e.name).join(', ')}\n` +
    `Excluded from fork lane: ${PI_PACKAGE.name}\n`,
)

for (const entry of FORK_PUBLISH_SET) {
  if (!existsSync(entry.path)) {
    console.error(`Package file not found: ${entry.path}`)
    process.exit(1)
  }

  const pkg = JSON.parse(readFileSync(entry.path, 'utf-8'))
  const relativePath = entry.path.slice(root.length + 1)

  // Verify the package name matches the expected fork-lane name.
  if (pkg.name !== entry.name) {
    console.error(
      `${relativePath}: package name mismatch — found '${pkg.name}', expected '${entry.name}'\n` +
        `Run Unit 1 (package identity rewrite) before version-sync.`,
    )
    process.exit(1)
  }

  let changed = false

  if (pkg.version === version) {
    console.log(`${relativePath}: version already at target`)
  } else {
    console.log(`${relativePath}: version ${pkg.version} → ${version}`)
    pkg.version = version
    changed = true
  }

  if (entry.forkCoreDep) {
    const currentCoreVersion = pkg.dependencies?.[entry.forkCoreDep]
    if (currentCoreVersion !== version) {
      console.log(
        `${relativePath}: ${entry.forkCoreDep} ${currentCoreVersion ?? '(missing)'} → ${version}`,
      )
      pkg.dependencies = {
        ...pkg.dependencies,
        [entry.forkCoreDep]: version,
      }
      changed = true
    } else {
      console.log(`${relativePath}: ${entry.forkCoreDep} already at target`)
    }
  }

  if (!changed) {
    console.log(`${relativePath}: (already synced)`)
    continue
  }

  if (!dryRun) {
    writeFileSync(entry.path, `${JSON.stringify(pkg, null, 2)}\n`, 'utf-8')
  }
}

// Explicitly confirm Pi was not touched.
console.log(`\n${PI_PACKAGE.name}: not in fork publish lane — skipped`)

console.log(`\n${dryRun ? '[DRY RUN] ' : ''}Done.`)
