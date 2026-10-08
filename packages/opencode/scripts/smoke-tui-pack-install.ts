import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = join(pluginRoot, '../..')
const coreRoot = join(repoRoot, 'packages/core')
const packageName = '@cortexkit/opencode-anthropic-auth'
const corePackageName = '@cortexkit/anthropic-auth-core'
const runtimeSpecifiers = [
  '@opentui/core',
  '@opentui/core/testing',
  '@opentui/solid',
  '@opentui/solid/components',
  '@opentui/solid/jsx-runtime',
  '@opentui/solid/jsx-dev-runtime',
  'solid-js',
  'solid-js/store',
]

let failures = 0
function check(name: string, condition: boolean, detail?: string): void {
  if (condition) {
    console.log(`  ok  ${name}`)
  } else {
    failures++
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

function fail(name: string, detail: string): never {
  check(name, false, detail)
  throw new Error(`${name}: ${detail}`)
}

function run(
  command: string,
  args: string[],
  cwd: string,
  quietStdout = false,
): string {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 20 * 1024 * 1024,
  })

  if (result.stdout && !quietStdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
  if (result.status !== 0) {
    fail(
      `${command} ${args.join(' ')}`,
      `exited with ${result.status ?? 'unknown status'}`,
    )
  }
  return result.stdout
}

function parsePackedFilename(stdout: string): string {
  try {
    const packed = JSON.parse(stdout.trim()) as Array<{ filename?: string }>
    const filename = packed[0]?.filename
    if (typeof filename === 'string' && filename.length > 0) return filename
  } catch {
    // npm may print warnings around JSON; fall back to its tarball line.
  }

  const fallback = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.endsWith('.tgz'))
    .at(-1)
  if (fallback) return fallback
  fail('npm pack reports a tarball', stdout.trim() || 'no stdout')
}

const tempRoot = await mkdtemp(join(tmpdir(), 'anthropic-auth-tui-pack-'))
const installRoot = join(tempRoot, 'install')

try {
  if (process.env.TUI_SMOKE_SKIP_BUILD !== '1') {
    run('bun', ['run', 'build'], repoRoot)
  }

  const packStdout = run(
    'npm',
    ['pack', '--json', '--pack-destination', tempRoot],
    pluginRoot,
    true,
  )
  const tarball = join(tempRoot, parsePackedFilename(packStdout))
  check('npm pack produced a tarball', existsSync(tarball), tarball)

  // Release CI validates the new version before that version of core exists on
  // npm. Pack core locally too so this remains a real isolated installation
  // without depending on an already-published workspace version.
  const corePackStdout = run(
    'npm',
    ['pack', '--json', '--pack-destination', tempRoot],
    coreRoot,
    true,
  )
  const coreTarball = join(tempRoot, parsePackedFilename(corePackStdout))
  check(
    'npm pack produced a core tarball',
    existsSync(coreTarball),
    coreTarball,
  )

  await mkdir(installRoot, { recursive: true })
  await writeFile(
    join(installRoot, 'package.json'),
    JSON.stringify(
      {
        private: true,
        type: 'module',
        dependencies: {
          [corePackageName]: `file:${coreTarball}`,
          [packageName]: `file:${tarball}`,
        },
        overrides: {
          [corePackageName]: `file:${coreTarball}`,
        },
      },
      null,
      2,
    ),
  )
  run('bun', ['install', '--production'], installRoot)

  const installedPackageRoot = join(
    installRoot,
    'node_modules',
    '@cortexkit',
    'opencode-anthropic-auth',
  )
  // Exercise the published CLI under Node, not just source imports under Bun.
  // A split bundle can strand a CommonJS relative require in dist even when
  // the TUI loads correctly (e.g. jsonc-parser's ./impl/format wrapper).
  const installedCli = join(installedPackageRoot, 'dist/cli.js')
  check('CLI ships in the packed package', existsSync(installedCli))
  const cliHelp = run(
    process.env.CLI_SMOKE_NODE_BIN || 'node',
    [installedCli, '--help'],
    installRoot,
  )
  check('packed CLI exposes setup', cliHelp.includes('setup'))

  const compiledTui = join(installedPackageRoot, 'src/tui-compiled/tui.tsx')
  check('compiled TUI ships in the packed package', existsSync(compiledTui))

  const compiledText = existsSync(compiledTui)
    ? await readFile(compiledTui, 'utf8')
    : ''
  check(
    'compiled TUI imports the host runtime virtual modules',
    compiledText.includes('opentui:runtime-module:'),
  )
  check(
    'compiled TUI contains reactive wrapper calls',
    compiledText.includes('_$effect(') || compiledText.includes('_$insert('),
  )

  const stubbedRuntimeProbe = `
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { readFile } from "node:fs/promises";

const packageRoot = process.argv[1];
const runtimeSpecifiers = ${JSON.stringify(runtimeSpecifiers)};
const mid = (specifier) => "opentui:runtime-module:" + encodeURIComponent(specifier);
const resolved = new Map(runtimeSpecifiers.map((specifier) => [specifier, import.meta.resolve(specifier)]));

Bun.plugin({
  name: "opentui-runtime-module-stubs",
  setup(build) {
    for (const specifier of runtimeSpecifiers) {
      const target = resolved.get(specifier);
      build.module(mid(specifier), () => ({
        loader: "js",
        contents: "export * from " + JSON.stringify(target) + ";\\n" +
          "import * as namespace from " + JSON.stringify(target) + ";\\n" +
          "export default ('default' in namespace ? namespace.default : namespace);\\n",
      }));
    }
  },
});

const loadedPaths = [];
Bun.plugin({
  name: "observe-compiled-tui-load",
  setup(build) {
    build.onLoad({ filter: /tui[.]tsx$/ }, async (args) => {
      loadedPaths.push(args.path.split(String.fromCharCode(92)).join("/"));
      return { contents: await readFile(args.path, "utf8"), loader: "tsx" };
    });
  },
});
process.env.OPENCODE_TUI_PREFERENCES_FILE = join(packageRoot, "absent-smoke-preferences.jsonc");
process.env.OPENCODE_ANTHROPIC_AUTH_RPC_DIR = join(packageRoot, "absent-smoke-rpc");
const entry = await import(pathToFileURL(join(packageRoot, "src/tui/entry.mjs")).href);
if (entry.default?.id !== "cortexkit.anthropic-auth" || typeof entry.default?.tui !== "function") {
  throw new Error("compiled TUI entry export shape is invalid");
}
let registrations = 0;
await entry.default.tui({
  slots: { register(value) { if (typeof value.slots.sidebar_content !== "function") throw new Error("missing sidebar"); registrations++; } },
  state: { path: { directory: packageRoot } },
  route: { current: () => ({ type: "home" }) },
});
if (registrations !== 1 || !loadedPaths.some((path) => path.includes("tui-compiled")) || loadedPaths.some((path) => path.endsWith("/src/tui.tsx"))) {
  throw new Error("compiled TUI invocation used the wrong loader path");
}
console.log("stubbed runtime probe invoked the actual compiled TUI path");
process.exit(0);
`
  run('bun', ['-e', stubbedRuntimeProbe, installedPackageRoot], installRoot)
  check('stubbed host runtime imports the compiled TUI path', true)

  const rawFallbackProbe = `
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { readFile } from "node:fs/promises";

const packageRoot = process.argv[1];
const loadedPaths = [];
Bun.plugin({
  name: "observe-raw-tui-load",
  setup(build) {
    build.onLoad({ filter: /tui[.]tsx$/ }, async (args) => {
      loadedPaths.push(args.path.split(String.fromCharCode(92)).join("/"));
      return { contents: await readFile(args.path, "utf8"), loader: "tsx" };
    });
  },
});
process.env.OPENCODE_TUI_PREFERENCES_FILE = join(packageRoot, "absent-smoke-preferences.jsonc");
process.env.OPENCODE_ANTHROPIC_AUTH_RPC_DIR = join(packageRoot, "absent-smoke-rpc");
const entry = await import(pathToFileURL(join(packageRoot, "src/tui/entry.mjs")).href);
if (entry.default?.id !== "cortexkit.anthropic-auth" || typeof entry.default?.tui !== "function") {
  throw new Error("raw TUI fallback export shape is invalid");
}
let registrations = 0;
await entry.default.tui({
  slots: { register(value) { if (typeof value.slots.sidebar_content !== "function") throw new Error("missing sidebar"); registrations++; } },
  state: { path: { directory: packageRoot } },
  route: { current: () => ({ type: "home" }) },
});
if (registrations !== 1 || !loadedPaths.some((path) => path.endsWith("/src/tui.tsx")) || loadedPaths.some((path) => path.includes("tui-compiled"))) {
  throw new Error("bare Bun TUI invocation did not use the raw TSX fallback");
}
console.log("bare Bun invoked the actual raw TSX fallback");
process.exit(0);
`
  run('bun', ['-e', rawFallbackProbe, installedPackageRoot], installRoot)
  check('bare Bun imports the raw-TSX fallback', true)
} finally {
  if (process.env.KEEP_TUI_PACK_SMOKE !== '1') {
    await rm(tempRoot, { recursive: true, force: true })
  } else {
    console.log(`kept smoke temp dir: ${tempRoot}`)
  }
}

if (failures > 0) {
  console.error(`\nsmoke-tui-pack-install: ${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nsmoke-tui-pack-install: all checks passed')
