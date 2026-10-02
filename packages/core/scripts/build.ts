import { basename, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

interface CoreBundleOptions {
  entrypoint: string
  outfile: string
}

/** Runtime dependencies retain their package-owned resource and IPC loaders. */
const RUNTIME_EXTERNALS = ['xxhash-wasm', '@cortexkit/claustrum-client']

export async function bundleCore(options: CoreBundleOptions): Promise<void> {
  const result = await Bun.build({
    entrypoints: [options.entrypoint],
    outdir: dirname(options.outfile),
    naming: basename(options.outfile),
    target: 'node',
    format: 'esm',
    external: RUNTIME_EXTERNALS,
  })
  if (!result.success) {
    throw new AggregateError(result.logs, 'Core bundling failed')
  }
}

if (import.meta.main) {
  await bundleCore({
    entrypoint: fileURLToPath(new URL('../src/index.ts', import.meta.url)),
    outfile: fileURLToPath(new URL('../dist/index.js', import.meta.url)),
  })
}
