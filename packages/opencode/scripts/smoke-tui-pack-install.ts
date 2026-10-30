import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = join(pluginRoot, '../..')
const coreRoot = join(repoRoot, 'packages/core')
const piRoot = join(repoRoot, 'packages/pi')
const packageName = '@cortexkit/opencode-anthropic-auth'
const corePackageName = '@cortexkit/anthropic-auth-core'
type HostRuntimeFixture = {
  id: string
  label: string
  core: string
  keymap?: string
  solid: string
  solidJs: string
  additionalKeymapRuntimeModules: boolean
}

const hostRuntimeFixtures: [
  HostRuntimeFixture,
  HostRuntimeFixture,
  HostRuntimeFixture,
] = [
  {
    id: 'opencode-1-19-4',
    label: 'OpenCode 1.19.4 OpenTUI/Solid library pair',
    core: '0.4.5',
    keymap: '0.4.5',
    solid: '0.4.5',
    solidJs: '1.9.10',
    additionalKeymapRuntimeModules: true,
  },
  {
    id: 'opencode-2-0-22',
    label: 'OpenCode 2.0.22 OpenTUI/Solid library-only pair',
    core: '0.5.14',
    solid: '0.5.14',
    solidJs: '1.9.15',
    additionalKeymapRuntimeModules: false,
  },
  {
    // @opencode/plugin 2.2.0 peers on exactly @opentui/core and
    // @opentui/solid 0.7.0, and @opentui/solid 0.7.0 peers on solid-js 1.9.12.
    id: 'opencode-2-2-0',
    label: 'OpenCode 2.2.0 OpenTUI/Solid library-only pair',
    core: '0.7.0',
    solid: '0.7.0',
    solidJs: '1.9.12',
    additionalKeymapRuntimeModules: false,
  },
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

function runBounded(
  name: string,
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  quietStdout = false,
): string {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: timeoutMs,
    // Renderer signal handlers must not keep this owned child alive after its budget.
    killSignal: 'SIGKILL',
    maxBuffer: 20 * 1024 * 1024,
  })

  if (result.stdout && !quietStdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
  if (result.status !== 0) {
    fail(
      name,
      result.error?.message ??
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

async function runPackedHostRuntimeProbe(
  tempRoot: string,
  tarball: string,
  coreTarball: string,
  host: HostRuntimeFixture,
  nonCallableHelper?: string,
): Promise<void> {
  const fixtureRoot = join(tempRoot, host.id)
  const installRoot = join(fixtureRoot, 'install')
  const home = join(fixtureRoot, 'home')
  const tmp = join(fixtureRoot, 'tmp')
  const sidebarStateFile = join(fixtureRoot, 'sidebar-state.json')
  const sidebarRouteMarker = `smoke-route-${host.id}`
  const xdgCache = join(home, 'cache')
  const xdgConfig = join(home, 'config')
  const xdgData = join(home, 'data')
  const xdgState = join(home, 'state')
  const bunInstallCache = join(fixtureRoot, 'bun-install-cache')
  const cacheKeepDir = join(fixtureRoot, 'cachekeep')
  const quotaFeedDir = join(fixtureRoot, 'quota-feed')
  const dumpDir = join(fixtureRoot, 'dumps')
  const rpcDir = join(fixtureRoot, 'rpc')
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    XDG_CACHE_HOME: xdgCache,
    XDG_CONFIG_HOME: xdgConfig,
    XDG_DATA_HOME: xdgData,
    XDG_STATE_HOME: xdgState,
    TMPDIR: tmp,
    BUN_INSTALL_CACHE_DIR: bunInstallCache,
    OPENCODE_TUI_PREFERENCES_FILE: join(fixtureRoot, 'tui-preferences.jsonc'),
    OPENCODE_ANTHROPIC_AUTH_FILE: join(fixtureRoot, 'anthropic-auth.json'),
    OPENCODE_ANTHROPIC_AUTH_STATE_FILE: join(
      fixtureRoot,
      'anthropic-state.json',
    ),
    OPENCODE_ANTHROPIC_AUTH_ROUTING_STATE_FILE: join(
      fixtureRoot,
      'routing-state.json',
    ),
    OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE: join(
      fixtureRoot,
      'claustrum-enrollment.json',
    ),
    OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_CONNECTION_FILE: join(
      fixtureRoot,
      'claustrum-connection.json',
    ),
    OPENCODE_ANTHROPIC_AUTH_SIDEBAR_STATE_FILE: sidebarStateFile,
    OPENCODE_ANTHROPIC_AUTH_CACHEKEEP_REGISTRY_DIR: cacheKeepDir,
    OPENCODE_ANTHROPIC_AUTH_QUOTA_FEED_DIR: quotaFeedDir,
    OPENCODE_ANTHROPIC_AUTH_DUMP_DIR: dumpDir,
    OPENCODE_ANTHROPIC_AUTH_RPC_DIR: rpcDir,
  }

  const directories = [
    installRoot,
    home,
    tmp,
    xdgCache,
    xdgConfig,
    xdgData,
    xdgState,
    bunInstallCache,
    cacheKeepDir,
    quotaFeedDir,
    dumpDir,
    rpcDir,
  ]
  const created = await Promise.allSettled(
    directories.map((directory) => mkdir(directory, { recursive: true })),
  )
  const rejected = created.find(
    (result): result is PromiseRejectedResult => result.status === 'rejected',
  )
  if (rejected) throw rejected.reason
  await writeFile(
    sidebarStateFile,
    JSON.stringify({
      main: { quota: null },
      fallbacks: [],
      route: sidebarRouteMarker,
      lastUpdated: Date.now(),
    }),
  )
  await writeFile(
    join(installRoot, 'package.json'),
    JSON.stringify(
      {
        private: true,
        type: 'module',
        dependencies: {
          [corePackageName]: `file:${coreTarball}`,
          [packageName]: `file:${tarball}`,
          '@opentui/core': host.core,
          ...(host.keymap ? { '@opentui/keymap': host.keymap } : {}),
          '@opentui/solid': host.solid,
          'solid-js': host.solidJs,
        },
        overrides: {
          [corePackageName]: `file:${coreTarball}`,
          'solid-js': host.solidJs,
        },
      },
      null,
      2,
    ),
  )

  runBounded(
    `${host.label} host-library installation`,
    'bun',
    ['install', '--production'],
    installRoot,
    env,
    120_000,
    true,
  )

  const installedPackageRoot = join(
    installRoot,
    'node_modules',
    '@cortexkit',
    'opencode-anthropic-auth',
  )
  const runtimePackaging = run(
    'node',
    [
      '--experimental-import-meta-resolve',
      '--input-type=module',
      '-e',
      `
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { readdir, readFile, access } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = process.argv[1];
const privateEntry = fileURLToPath(import.meta.resolve('@cortexkit/private-files', pathToFileURL(join(root, 'dist/cli.js')).href));
assert(privateEntry.includes('node_modules'));
assert(!privateEntry.startsWith(join(root, 'dist')));
for (const arch of ['x64', 'arm64']) {
  await access(join(dirname(privateEntry), '../prebuilds/private-files-win32-' + arch + '.node'));
}
const names = await readdir(join(root, 'dist'), { recursive: true });
const source = (await Promise.all(names.filter(n => n.endsWith('.js')).map(n => readFile(join(root, 'dist', n), 'utf8')))).join('\\n');
assert(!source.includes('private-files-win32-'), 'private-files native loader was inlined');
assert(!source.includes('loadPrivateFilesNative'), 'private-files implementation was inlined');
assert(source.includes('@cortexkit/anthropic-auth-core'), 'Core must resolve from its installed dist');
assert(source.includes('@cortexkit/private-files'), 'shared runner must retain its runtime import');
const api = await import(pathToFileURL(privateEntry).href);
assert.equal(typeof api.verifyOwnerOnly, 'function');
console.log('packed runtime packages resolve with both Windows prebuilds; no inlined loader');
`,
      installedPackageRoot,
    ],
    installRoot,
  )
  check(
    'packed runtime packages retain their own native resources',
    runtimePackaging.includes('no inlined loader'),
  )
  const probe = `
import { createTestRenderer } from "@opentui/core/testing";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { render } from "@opentui/solid";

const packageRoot = process.argv[1];
const nonCallableHelper = process.argv[2] || "";
const includeKeymapRuntime = process.argv[3] === "keymap";
const sidebarRouteMarker = ${JSON.stringify(sidebarRouteMarker)};
const loadedPaths = [];

// Observe the packed TUI path only; the host configure helper owns runtime registration.
Bun.plugin({
  name: "observe-packed-host-tui-load",
  setup(build) {
    build.onLoad({ filter: /tui[.]tsx$/ }, async (args) => {
      loadedPaths.push(args.path.split(String.fromCharCode(92)).join("/"));
      return { contents: await readFile(args.path, "utf8"), loader: "tsx" };
    });
  },
});

const { ensureRuntimePluginSupport } = await import("@opentui/solid/runtime-plugin-support/configure");
const keymapRuntimeModules = includeKeymapRuntime
  ? (await import("@opentui/keymap/runtime-modules")).runtimeModules
  : {};
const additional = { ...keymapRuntimeModules };
if (nonCallableHelper) {
  const solidRuntime = await import("@opentui/solid");
  if (typeof solidRuntime[nonCallableHelper] !== "function") {
    throw new Error("non-callable-helper control target is absent from the real host runtime: " + nonCallableHelper);
  }
  const solidWithNonCallableHelper = {
    ...solidRuntime,
    [nonCallableHelper]: undefined,
  };
  if (
    !Object.prototype.hasOwnProperty.call(
      solidWithNonCallableHelper,
      nonCallableHelper,
    ) || typeof solidWithNonCallableHelper[nonCallableHelper] !== "undefined"
  ) {
    throw new Error("non-callable-helper control did not preserve the named export");
  }
  additional["@opentui/solid"] = solidWithNonCallableHelper;
}
ensureRuntimePluginSupport({ additional });

let entry;
try {
  entry = await import(pathToFileURL(join(packageRoot, "src/tui/entry.mjs")).href);
} catch (error) {
  if (nonCallableHelper) {
    throw new Error("non-callable-helper control failed during entry import before rendering: " + error);
  }
  throw error;
}
const entryImported = true;
if (entry.default?.id !== "cortexkit.anthropic-auth" || typeof entry.default?.tui !== "function") {
  throw new Error("packed TUI entry export shape is invalid");
}
const registeredPlugins = [];
let eventSubscriptions = 0;
let eventUnsubscriptions = 0;
const api = {
  event: {
    on() {
      eventSubscriptions++;
      return () => { eventUnsubscriptions++; };
    },
  },
  theme: {
    current: {
      accent: "#3366ff",
      background: "#000000",
      borderActive: "#ffffff",
      error: "#ff0000",
      success: "#00ff00",
      text: "#ffffff",
      textMuted: "#888888",
      warning: "#ffff00",
    },
  },
  slots: { register(plugin) { registeredPlugins.push(plugin); } },
  state: { path: { directory: packageRoot } },
  route: { current: () => ({ type: "home" }) },
};
try {
  await entry.default.tui(api);
} catch (error) {
  if (nonCallableHelper) {
    throw new Error("non-callable-helper control failed during TUI setup before rendering: " + error);
  }
  throw error;
}
const setupCompleted = true;
if (registeredPlugins.length !== 1) {
  throw new Error("packed TUI did not register exactly one host sidebar plugin");
}
const sidebar = registeredPlugins[0].slots.sidebar_content;
if (typeof sidebar !== "function") throw new Error("missing registered sidebar slot");
let completeRendererDestroy;
const rendererDestroyed = new Promise((resolve) => {
  completeRendererDestroy = resolve;
});
const testSetup = await createTestRenderer({
  width: 80,
  height: 24,
  onDestroy() { completeRendererDestroy(); },
});
let renderFailure;
let frame = testSetup.captureCharFrame();
let quotaFrame = "";
let settleSidebarFrame;
const sidebarFrame = new Promise((resolve) => { settleSidebarFrame = resolve; });
let settleQuotaFrame;
const quotaSidebarFrame = new Promise((resolve) => { settleQuotaFrame = resolve; });
const observeFrame = () => {
  try {
    const captured = testSetup.captureCharFrame();
    if (captured.includes(sidebarRouteMarker) && captured.includes("Waiting for quota")) {
      settleSidebarFrame({ frame: captured });
    }
    if (captured.includes("40% left") && captured.includes("checked 2d ago")) {
      settleQuotaFrame({ frame: captured });
    }
  } catch (error) {
    settleSidebarFrame({ error });
    settleQuotaFrame({ error });
  }
};
testSetup.renderer.on("frame", observeFrame);
let renderEntered = false;
let sidebarInvoked = false;
try {
  try {
    renderEntered = true;
    await render(() => {
      sidebarInvoked = true;
      return sidebar({}, { session_id: "smoke-session" });
    }, testSetup.renderer);
    testSetup.renderer.requestRender();
    const captured = await sidebarFrame;
    if ("error" in captured) throw captured.error;
    frame = captured.frame;
    const now = Date.now();
    await writeFile(process.env.OPENCODE_ANTHROPIC_AUTH_SIDEBAR_STATE_FILE, JSON.stringify({
      main: { quota: {
        five_hour: {
          usedPercent: 60, remainingPercent: 40,
          checkedAt: now - 2 * 86400000,
          resetsAt: new Date(now + 4 * 86400000).toISOString(),
        },
        scoped: [],
      } },
      fallbacks: [], route: sidebarRouteMarker, lastUpdated: now,
    }));
    const quotaCaptured = await quotaSidebarFrame;
    if ("error" in quotaCaptured) throw quotaCaptured.error;
    quotaFrame = quotaCaptured.frame;
  } catch (error) {
    renderFailure = error;
  }
} finally {
  testSetup.renderer.off("frame", observeFrame);
  settleSidebarFrame({ cancelled: true });
  settleQuotaFrame({ cancelled: true });
  // destroy() can defer teardown until an active frame finishes.
  testSetup.renderer.destroy();
  await rendererDestroyed;
}

const compiledLoaded = loadedPaths.some((path) => path.includes("tui-compiled"));
const rawLoaded = loadedPaths.some((path) => path.endsWith("/src/tui.tsx"));
if (!entryImported || !setupCompleted || !renderEntered || !sidebarInvoked) {
  throw new Error("packed compiled sidebar did not enter the shared renderer path");
}
if (!compiledLoaded || rawLoaded) {
  throw new Error("host renderer did not load the packed compiled TUI path");
}
if (eventSubscriptions !== eventUnsubscriptions) {
  throw new Error("sidebar renderer cleanup left host event subscriptions active");
}
if (nonCallableHelper) {
  if (!renderFailure) {
    throw new Error("sidebar rendered even though the host renderer made " + nonCallableHelper + " non-callable");
  }
  if (
    !(renderFailure instanceof TypeError) ||
    !String(renderFailure).includes(nonCallableHelper) ||
    !/not (?:a function|callable)/i.test(renderFailure.message)
  ) {
    throw new Error("sidebar failed for the wrong reason with non-callable " + nonCallableHelper + ": " + renderFailure);
  }
  console.log("non-callable-helper control failed during packed sidebar rendering: " + nonCallableHelper);
  process.exit(0);
}
if (renderFailure) throw renderFailure;
if (!frame.includes(sidebarRouteMarker) || !frame.includes("Waiting for quota")) {
  throw new Error("headless renderer output did not contain the expected sidebar nodes: " + frame);
}
if (!quotaFrame.includes("40% left") || !quotaFrame.includes("checked 2d ago") || !quotaFrame.includes("3d23h")) {
  throw new Error("packed sidebar quota figure, reset or reading age was absent: " + quotaFrame);
}
if (eventSubscriptions !== 2) {
  throw new Error("sidebar did not subscribe to both host events");
}
console.log("real host renderer captured the packed sidebar route, empty quota, 40% left, 3d23h reset and checked 2d ago");
process.exit(0);
`

  runBounded(
    `${host.label} packed TUI host-runtime probe${nonCallableHelper ? ` with non-callable ${nonCallableHelper}` : ''}`,
    'bun',
    [
      // Select Solid's reactive client before the host's imports are resolved.
      '--preload',
      '@opentui/solid/preload',
      '-e',
      probe,
      installedPackageRoot,
      nonCallableHelper ?? '',
      host.additionalKeymapRuntimeModules ? 'keymap' : '',
    ],
    installRoot,
    env,
    30_000,
  )
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

  // A fresh install of the packed OpenCode and Pi packages must hold one copy
  // of each shared CortexKit client. Two copies mean two error classes and two
  // connections, and setup's instanceof checks stop recognizing Core's errors.
  //
  // This install uses npm, the way users install these packages, not Bun.
  // `bun install --omit peer` still resolves peer dependency trees, so Pi's
  // peer dependencies (pi-ai, and the AWS SDK it depends on) made this step
  // depend on the registry being consistent: a freshly published AWS package
  // whose own dependencies were not yet published failed the whole install.
  // npm with --omit=peer installs none of those peers. Core is forced to the
  // packed tarball through overrides so no copy comes from the registry.
  const piPackStdout = run(
    'npm',
    ['pack', '--json', '--pack-destination', tempRoot],
    piRoot,
    true,
  )
  const piTarball = join(tempRoot, parsePackedFilename(piPackStdout))
  const copiesRoot = join(tempRoot, 'copies')
  await mkdir(copiesRoot, { recursive: true })
  await writeFile(
    join(copiesRoot, 'package.json'),
    JSON.stringify(
      {
        private: true,
        type: 'module',
        dependencies: {
          [corePackageName]: `file:${coreTarball}`,
          [packageName]: `file:${tarball}`,
          '@cortexkit/pi-anthropic-auth': `file:${piTarball}`,
        },
        overrides: { [corePackageName]: `file:${coreTarball}` },
      },
      null,
      2,
    ),
  )
  run(
    'npm',
    [
      'install',
      '--omit=peer',
      '--omit=dev',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
    ],
    copiesRoot,
  )
  const installedFiles = await readdir(join(copiesRoot, 'node_modules'), {
    recursive: true,
  })
  for (const client of ['claustrum-client', 'subc-client']) {
    const copies = installedFiles.filter((path) =>
      new RegExp(`(?:^|/)@cortexkit/${client}/package\\.json$`).test(path),
    )
    check(
      `packed OpenCode and Pi install one @cortexkit/${client}`,
      copies.length === 1,
      copies.join(', '),
    )
  }

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

  const compiledSidebar = join(
    installedPackageRoot,
    'src/tui-compiled/quota-sidebar.js',
  )
  check(
    'compiled shared sidebar ships in the packed package',
    existsSync(compiledSidebar),
  )
  const sidebarText = await readFile(compiledSidebar, 'utf8')
  check(
    'shared sidebar uses host runtime modules, not dependency JSX',
    sidebarText.includes('opentui:runtime-module:') &&
      !/(?:from\s*|import\s*\()['"](?:solid-js|@cortexkit\/common-auth)(?:\/[^'"]*)?['"]/.test(
        sidebarText,
      ),
  )

  const compiledText = existsSync(compiledTui)
    ? await readFile(compiledTui, 'utf8')
    : ''
  check(
    'compiled TUI imports the host runtime virtual modules',
    compiledText.includes('opentui:runtime-module:'),
  )
  check(
    'compiled TUI imports the Solid renderer helper used by the negative control',
    compiledText.includes('createComponent as _$createComponent'),
  )
  check(
    'compiled TUI imports Solid primitives through the host runtime',
    compiledText.includes('opentui:runtime-module:solid-js'),
  )
  check(
    'compiled TUI contains reactive wrapper calls',
    compiledText.includes('_$effect(') || compiledText.includes('_$insert('),
  )

  for (const host of hostRuntimeFixtures) {
    await runPackedHostRuntimeProbe(tempRoot, tarball, coreTarball, host)
    check(`${host.label} runtime invokes the packed compiled TUI`, true)
  }
  const negativeHost = {
    ...hostRuntimeFixtures[1],
    id: 'opencode-2-0-22-non-callable-create-component',
    label:
      'OpenCode 2.0.22 OpenTUI/Solid library-only non-callable-helper control',
  }
  await runPackedHostRuntimeProbe(
    tempRoot,
    tarball,
    coreTarball,
    negativeHost,
    'createComponent',
  )
  check(
    'non-callable-helper control rejects the rendered sidebar for createComponent',
    true,
  )

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
