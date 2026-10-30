import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const sourceRoot = join(pluginRoot, 'src')
const outputRoot = join(sourceRoot, 'tui-compiled')
const sharedSidebarSpecifier = '@cortexkit/common-auth/quota-sidebar'
const sharedSidebarOutput = join(outputRoot, 'quota-sidebar.js')
const rawSharedSidebarOutput = join(sourceRoot, 'tui/quota-sidebar.js')
const shippedSourceFiles = [
  'tui.tsx',
  'tui/command-dialogs.tsx',
  'tui/claude-sidebar.tsx',
  'tui/sign-in-link.tsx',
  'tui/menu-status.tsx',
  'sidebar-state.ts',
  'tui-preferences.ts',
  'rpc/rpc-client.ts',
  'rpc/rpc-dir.ts',
  'rpc/port-file.ts',
  'rpc/protocol.ts',
] as const
const runtimeSpecifiers = new Set([
  '@opentui/core',
  '@opentui/core/testing',
  '@opentui/solid',
  '@opentui/solid/components',
  '@opentui/solid/jsx-runtime',
  '@opentui/solid/jsx-dev-runtime',
  'solid-js',
  'solid-js/store',
])

type TransformSolidSource = (
  code: string,
  options: {
    filename: string
    moduleName: string
    resolvePath: (specifier: string) => string | null
  },
) => Promise<string>

type SolidTransformModule = {
  transformSolidSource?: TransformSolidSource
}

function runtimeModuleId(specifier: string): string {
  return `opentui:runtime-module:${encodeURIComponent(specifier)}`
}

function asTransformSolidSource(
  mod: SolidTransformModule,
  from: string,
): TransformSolidSource {
  if (typeof mod.transformSolidSource !== 'function') {
    throw new Error(
      `@opentui/solid transform loaded from ${from} without transformSolidSource`,
    )
  }
  return mod.transformSolidSource
}

async function importTransformModule(
  specifier: string,
): Promise<SolidTransformModule> {
  return (await import(specifier)) as SolidTransformModule
}

async function resolveSolidTransformPath(): Promise<string> {
  const packageJsonSpecifier = '@opentui/solid/package.json'
  const errors: string[] = []

  try {
    const packageJsonUrl = import.meta.resolve(packageJsonSpecifier)
    return join(
      dirname(fileURLToPath(packageJsonUrl)),
      'scripts/solid-transform.js',
    )
  } catch (error) {
    errors.push(
      `import.meta.resolve: ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  try {
    const require = createRequire(import.meta.url)
    return join(
      dirname(require.resolve(packageJsonSpecifier)),
      'scripts/solid-transform.js',
    )
  } catch (error) {
    errors.push(
      `require.resolve: ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  throw new Error(
    `Unable to resolve @opentui/solid transform (${errors.join('; ')})`,
  )
}

async function loadTransformSolidSource(): Promise<TransformSolidSource> {
  const bareTransformSpecifier = '@opentui/solid/scripts/solid-transform.js'

  try {
    return asTransformSolidSource(
      await importTransformModule(bareTransformSpecifier),
      bareTransformSpecifier,
    )
  } catch {
    const transformPath = await resolveSolidTransformPath()
    return asTransformSolidSource(
      await importTransformModule(pathToFileURL(transformPath).href),
      transformPath,
    )
  }
}

async function compileTsx(
  transformSolidSource: TransformSolidSource,
  sourceFile: string,
  outputFile: string,
): Promise<void> {
  const code = await readFile(sourceFile, 'utf8')
  const compiled = await transformSolidSource(code, {
    filename: sourceFile,
    moduleName: runtimeModuleId('@opentui/solid'),
    resolvePath: (specifier) => {
      if (runtimeSpecifiers.has(specifier)) return runtimeModuleId(specifier)
      if (specifier === './quota-sidebar.js')
        return `./${relative(dirname(outputFile), sharedSidebarOutput).replaceAll('\\', '/')}`
      return null
    },
  })

  await mkdir(dirname(outputFile), { recursive: true })
  await writeFile(outputFile, compiled)
}

const transformSolidSource = await loadTransformSolidSource()
await rm(outputRoot, { recursive: true, force: true })

// Both entry paths ship the frame and quota helpers, not dependency JSX. Only
// the older raw-source fallback binds normal package imports instead of the
// host's virtual registry; neither bundle includes Solid or OpenTUI itself.
async function bundleSharedSidebar(outputFile: string, hostRuntime: boolean) {
  const sharedSidebarBuild = await Bun.build({
    entrypoints: [fileURLToPath(import.meta.resolve(sharedSidebarSpecifier))],
    target: 'bun',
    format: 'esm',
    external: [...runtimeSpecifiers],
    plugins: [
      {
        name: 'shared-sidebar-host-runtime',
        setup(build) {
          build.onResolve({ filter: /^opentui:runtime-module:/ }, (args) => ({
            path: args.path,
            external: true,
          }))
          build.onLoad({ filter: /\.tsx$/ }, async (args) => ({
            contents: await transformSolidSource(
              await readFile(args.path, 'utf8'),
              {
                filename: args.path,
                moduleName: hostRuntime
                  ? runtimeModuleId('@opentui/solid')
                  : '@opentui/solid',
                resolvePath: (specifier) =>
                  hostRuntime && runtimeSpecifiers.has(specifier)
                    ? runtimeModuleId(specifier)
                    : null,
              },
            ),
            loader: 'ts',
          }))
        },
      },
    ],
  })
  if (!sharedSidebarBuild.success)
    throw new AggregateError(
      sharedSidebarBuild.logs,
      'Shared sidebar build failed',
    )
  if (sharedSidebarBuild.outputs.length !== 1)
    throw new Error('Expected one bundled shared sidebar module')
  await mkdir(dirname(outputFile), { recursive: true })
  await writeFile(outputFile, await sharedSidebarBuild.outputs[0]!.text())
}
await bundleSharedSidebar(sharedSidebarOutput, true)
await bundleSharedSidebar(rawSharedSidebarOutput, false)

for (const relativePath of shippedSourceFiles) {
  const sourceFile = join(sourceRoot, relativePath)
  const outputFile = join(outputRoot, relativePath)
  await mkdir(dirname(outputFile), { recursive: true })

  if (sourceFile.endsWith('.tsx')) {
    // OpenTUI skips its Solid compile-time transform for packages loaded from
    // node_modules. Precompile JSX reactivity while binding all Solid/OpenTUI
    // imports to the host's process-wide virtual runtime registry.
    await compileTsx(transformSolidSource, sourceFile, outputFile)
  } else {
    await copyFile(sourceFile, outputFile)
  }
}

console.log(
  `build-tui: wrote ${shippedSourceFiles.length + 1} file(s) to ${relative(pluginRoot, outputRoot)} and the raw sidebar bundle`,
)
