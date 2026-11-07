import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  findHostImportViolations,
  verifyPiDistRuntimeImports,
  verifyStandaloneCliRuntimeImports,
} from './check-pi-dist-imports.ts'

const ALLOWED = `import { calculateCost, createAssistantMessageEventStream } from '@earendil-works/pi-ai'`

function violations(source: string) {
  return findHostImportViolations(source, 'stream.js')
}

describe('Pi dist host-import guard', () => {
  test('accepts the allowed names, including quoted and aliased forms', () => {
    expect(violations(ALLOWED)).toEqual([])
    expect(
      violations(
        `import { "calculateCost" as cost } from '@earendil-works/pi-ai'`,
      ),
    ).toEqual([])
    expect(
      violations(`import { calculateCost as c } from '@oh-my-pi/pi-ai'`),
    ).toEqual([])
  })

  test('rejects a disallowed name in a second clause for the same specifier', () => {
    expect(
      violations(
        `${ALLOWED}\nimport { collapseSystemMessages } from '@earendil-works/pi-ai'`,
      ),
    ).toEqual([
      "stream.js: '@earendil-works/pi-ai' exports 'collapseSystemMessages' to this build, but the host's compat surface is not guaranteed to",
    ])
  })

  test('rejects a quoted unsupported name beside allowed imports', () => {
    expect(
      violations(
        `${ALLOWED}\nimport { "collapseSystemMessages" as collapse } from '@earendil-works/pi-ai'`,
      ),
    ).toEqual([
      "stream.js: '@earendil-works/pi-ai' exports 'collapseSystemMessages' to this build, but the host's compat surface is not guaranteed to",
    ])
  })

  test('rejects side-effect imports, even beside named ones', () => {
    expect(violations(`${ALLOWED}\nimport '@earendil-works/pi-ai'`)).toEqual([
      "stream.js: side-effect import of '@earendil-works/pi-ai' loads the host's copy",
    ])
  })

  test('rejects default, namespace, star re-export and dynamic imports', () => {
    for (const source of [
      `import piAi from '@earendil-works/pi-ai'`,
      `import * as piAi from '@earendil-works/pi-ai'`,
      `import piAi, { calculateCost } from '@earendil-works/pi-ai'`,
      `export * from '@earendil-works/pi-ai'`,
      `export * as piAi from '@earendil-works/pi-ai'`,
      `export async function load() { return import('@earendil-works/pi-ai') }`,
    ]) {
      expect(violations(source)).toContain(
        "stream.js: '@earendil-works/pi-ai' must be imported only by name, not as a namespace, default or dynamic import",
      )
    }
  })

  test('rejects template-literal and computed dynamic import specifiers that evade static host checks', () => {
    expect(
      violations(
        'export async function load() { return import(`@earendil-works/pi-ai`) }',
      ),
    ).toContain(
      'stream.js: runtime dynamic import cannot be verified against the host SDK allowlist',
    )
    expect(
      violations('export async function load(name) { return import(name) }'),
    ).toContain(
      'stream.js: runtime dynamic import cannot be verified against the host SDK allowlist',
    )
  })

  test('rejects relative dynamic imports that bypass the Pi extension loader', () => {
    for (const specifier of ['./prime.js', '../shared.js']) {
      expect(
        violations(
          `export async function load() { return import('${specifier}') }`,
        ),
      ).toEqual([
        `stream.js: relative dynamic import '${specifier}' bypasses Pi's extension loader; use a static import`,
      ])
    }
    expect(violations(`import { prime } from './prime.js'`)).toEqual([])
    expect(
      violations(
        `// import('./prime.js')\nconst text = "import('../shared.js')"`,
      ),
    ).toEqual([])
    expect(
      findHostImportViolations(
        `export const load = () => import('./prime.js')`,
        'cli.js',
        'standalone-cli',
      ),
    ).toEqual([])
  })

  test('rejects a disallowed name re-exported from the host', () => {
    expect(
      violations(`export { normalizeContext } from '@earendil-works/pi-ai'`),
    ).toEqual([
      "stream.js: '@earendil-works/pi-ai' exports 'normalizeContext' to this build, but the host's compat surface is not guaranteed to",
    ])
  })

  test('rejects any runtime import from another host package root', () => {
    for (const specifier of [
      '@earendil-works/pi-tui',
      '@earendil-works/pi-coding-agent',
      '@mariozechner/pi-tui',
    ]) {
      expect(violations(`import { x } from '${specifier}'`)).toEqual([
        `stream.js: runtime import from '${specifier}' — port what is needed locally (see packages/pi/src/transcript.ts)`,
      ])
    }
  })

  test('holds the legacy pi-ai scope to the same allowlist', () => {
    expect(
      violations(`import { calculateCost } from '@mariozechner/pi-ai'`),
    ).toEqual([])
    expect(
      violations(`import { normalizeContext } from '@mariozechner/pi-ai'`),
    ).toEqual([
      "stream.js: '@mariozechner/pi-ai' exports 'normalizeContext' to this build, but the host's compat surface is not guaranteed to",
    ])
  })

  // The guard reads emitted JavaScript, where TypeScript has already erased
  // type-only imports, so they never reach it.
  test('ignores non-host packages and import text in comments or strings', () => {
    expect(
      violations(
        [
          `import { loadAccounts } from '@cortexkit/anthropic-auth-core'`,
          `// import { collapseSystemMessages } from '@earendil-works/pi-ai'`,
          `const text = "import { normalizeContext } from '@earendil-works/pi-ai'"`,
        ].join('\n'),
      ),
    ).toEqual([])
  })

  test('CI and release verify the built Pi import surface before publication', async () => {
    const root = join(import.meta.dir, '..')
    for (const workflow of [
      '.github/workflows/ci.yml',
      '.github/workflows/release.yaml',
    ]) {
      const source = await readFile(join(root, workflow), 'utf8')
      const build = source.indexOf('bun run build')
      const test = source.indexOf(
        'bun test scripts/check-pi-dist-imports.test.ts',
      )
      const guard = source.indexOf('bun run check:pi-dist-imports')
      expect(build).toBeGreaterThan(-1)
      expect(test).toBeGreaterThan(build)
      expect(guard).toBeGreaterThan(test)
      if (workflow.endsWith('release.yaml')) {
        expect(guard).toBeLessThan(source.indexOf('publish-npm:'))
      }
    }
  })

  test('fails when the dist directory holds no JavaScript', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'pi-dist-guard-'))
    try {
      await expect(verifyPiDistRuntimeImports(empty)).rejects.toThrow(
        'No JavaScript',
      )
      await writeFile(join(empty, 'index.js'), ALLOWED)
      await expect(verifyPiDistRuntimeImports(empty)).resolves.toContain(
        '1 files',
      )
    } finally {
      await rm(empty, { recursive: true, force: true })
    }
  })

  test('the Pi dist scan rejects relative dynamic imports in nested emitted modules', async () => {
    await withModules(
      {
        'index.js': `export { load } from './nested/native.js'`,
        'nested/native.js': `export const load = () => import('../prime.js')`,
        'prime.js': 'export const prime = true',
      },
      async (root) => {
        await expect(verifyPiDistRuntimeImports(root)).rejects.toThrow(
          "nested/native.js: relative dynamic import '../prime.js' bypasses Pi's extension loader; use a static import",
        )
      },
    )
  })
})

const AGENT_DIR = `import { getAgentDir } from '@earendil-works/pi-coding-agent'`

async function withModules(
  modules: Record<string, string>,
  check: (root: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'runtime-import-guard-'))
  try {
    for (const [name, source] of Object.entries(modules)) {
      const file = join(root, name)
      await mkdir(dirname(file), { recursive: true })
      await writeFile(file, source)
    }
    await check(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

describe('entry-point host SDK import boundaries', () => {
  test('allows only named getAgentDir from the Pi coding-agent SDK', () => {
    for (const source of [
      AGENT_DIR,
      `import { getAgentDir as dir } from '@earendil-works/pi-coding-agent'`,
      `import { 'getAgentDir' as dir } from '@earendil-works/pi-coding-agent'`,
      `export { getAgentDir as dir } from '@earendil-works/pi-coding-agent'`,
    ]) {
      expect(findHostImportViolations(source, 'commands.js')).toEqual([])
    }
  })

  test('does not allow unknown SDK names or missing transcript helpers', () => {
    for (const source of [
      `import { getAgentDir, unknown } from '@earendil-works/pi-coding-agent'`,
      `${AGENT_DIR}; import { unknown } from '@earendil-works/pi-coding-agent'`,
      `export { 'unknown' as helper } from '@earendil-works/pi-coding-agent'`,
      `import { getAgentDir } from '@earendil-works/pi-ai'`,
      `import { collapseSystemMessages } from '@earendil-works/pi-ai'`,
      `import { normalizeContext } from '@earendil-works/pi-ai'`,
    ]) {
      expect(
        findHostImportViolations(source, 'commands.js').length,
      ).toBeGreaterThan(0)
    }
  })

  test('does not allow opaque or side-effect coding-agent SDK imports in Pi', () => {
    for (const source of [
      `import sdk from '@earendil-works/pi-coding-agent'`,
      `import sdk, { getAgentDir } from '@earendil-works/pi-coding-agent'`,
      `import * as sdk from '@earendil-works/pi-coding-agent'`,
      `import '@earendil-works/pi-coding-agent'`,
      `export * from '@earendil-works/pi-coding-agent'`,
      `export * as sdk from '@earendil-works/pi-coding-agent'`,
      `async function load() { return import('@earendil-works/pi-coding-agent') }`,
      'async function load() { return import(`@earendil-works/pi-coding-agent`) }',
      `async function load(name) { return import(name) }`,
    ]) {
      expect(
        findHostImportViolations(source, 'commands.js').length,
      ).toBeGreaterThan(0)
    }
  })

  test('keeps the full Pi dist scan while allowing getAgentDir in commands', async () => {
    await withModules({ 'commands.js': AGENT_DIR }, async (root) => {
      await expect(verifyPiDistRuntimeImports(root)).resolves.toContain(
        '1 files',
      )
      await mkdir(join(root, 'nested'))
      await writeFile(
        join(root, 'nested', 'unsupported.js'),
        `import { collapseSystemMessages } from '@earendil-works/pi-ai'`,
      )
      await expect(verifyPiDistRuntimeImports(root)).rejects.toThrow(
        'collapseSystemMessages',
      )
    })
  })

  test('rejects getAgentDir directly in the standalone CLI entry point', async () => {
    await withModules({ 'cli.js': AGENT_DIR }, async (root) => {
      await expect(
        verifyStandaloneCliRuntimeImports(join(root, 'cli.js')),
      ).rejects.toThrow(
        "cli.js: standalone CLI must not import host Pi SDK '@earendil-works/pi-coding-agent'",
      )
    })
  })

  test('rejects otherwise-allowed Pi exports under every host scope in the CLI', async () => {
    for (const scope of ['earendil-works', 'oh-my-pi', 'mariozechner']) {
      for (const source of [
        `import { getAgentDir } from '@${scope}/pi-coding-agent'`,
        `import { calculateCost, createAssistantMessageEventStream } from '@${scope}/pi-ai'`,
        `export { getAgentDir } from '@${scope}/pi-coding-agent'`,
        `import * as sdk from '@${scope}/pi-coding-agent'`,
        `import sdk from '@${scope}/pi-coding-agent'`,
        `import '@${scope}/pi-coding-agent'`,
        `export * from '@${scope}/pi-coding-agent'`,
        `async function load() { return import('@${scope}/pi-coding-agent') }`,
        `import { unknown } from '@${scope}/pi-tui'`,
      ]) {
        await withModules({ 'cli.js': source }, async (root) => {
          await expect(
            verifyStandaloneCliRuntimeImports(join(root, 'cli.js')),
          ).rejects.toThrow('standalone CLI must not import host Pi SDK')
        })
      }
    }
  })

  test('rejects getAgentDir transitively through relative imports and re-exports', async () => {
    for (const bridge of [
      `import './nested/host.js'`,
      `export { getAgentDir } from './nested/host.js'`,
      `export * from './nested/host.js'`,
    ]) {
      await withModules(
        {
          'cli.js': `import './bridge.js'`,
          'bridge.js': bridge,
          'nested/host.js': AGENT_DIR,
        },
        async (root) => {
          await expect(
            verifyStandaloneCliRuntimeImports(join(root, 'cli.js')),
          ).rejects.toThrow(
            "nested/host.js: standalone CLI must not import host Pi SDK '@earendil-works/pi-coding-agent'",
          )
        },
      )
    }
  })

  test('rejects getAgentDir in a constant dynamic chunk reached from a nested module', async () => {
    await withModules(
      {
        'cli.js': `export * from './nested/bridge.js'`,
        'nested/bridge.js': `export async function load() { return import('../host.js') }`,
        'host.js': AGENT_DIR,
      },
      async (root) => {
        await expect(
          verifyStandaloneCliRuntimeImports(join(root, 'cli.js')),
        ).rejects.toThrow(
          "host.js: standalone CLI must not import host Pi SDK '@earendil-works/pi-coding-agent'",
        )
      },
    )
  })

  test('rejects unverifiable dynamic CLI edges instead of silently skipping them', async () => {
    await withModules(
      { 'cli.js': `export async function load(name) { return import(name) }` },
      async (root) => {
        await expect(
          verifyStandaloneCliRuntimeImports(join(root, 'cli.js')),
        ).rejects.toThrow('runtime dynamic import cannot be verified')
      },
    )
  })

  test('ignores unrelated emitted plugin modules and handles shared cyclic chunks', async () => {
    await withModules(
      {
        'cli.js': `import './nested/bridge.js'; export * from './shared.js'`,
        'nested/bridge.js': `export * from '../shared.js'`,
        'shared.js': `import './nested/bridge.js'; import { readFile } from 'node:fs/promises'`,
        'plugin.js': AGENT_DIR,
      },
      async (root) => {
        await expect(
          verifyStandaloneCliRuntimeImports(join(root, 'cli.js')),
        ).resolves.toContain('3 reachable files')
      },
    )
  })

  test('fails closed for missing CLI entry points or reachable chunks', async () => {
    await withModules({}, async (root) => {
      await expect(
        verifyStandaloneCliRuntimeImports(join(root, 'cli.js')),
      ).rejects.toThrow('Missing standalone CLI module')
      await writeFile(join(root, 'cli.js'), `import './missing.js'`)
      await expect(
        verifyStandaloneCliRuntimeImports(join(root, 'cli.js')),
      ).rejects.toThrow('missing.js')
    })
  })
})
