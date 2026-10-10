import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, extname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from '@babel/parser'

const PRODUCER = '@cortexkit/common-auth'
const TYPE_ASSETS = 'internal-types'
const declarationPattern = /\.d\.(?:ts|mts|cts)$/

type AstNode = { type: string; [key: string]: unknown }
interface ModuleReference {
  specifier: string
  start: number
  end: number
  kind: 'module' | 'path' | 'types'
}

function isNode(value: unknown): value is AstNode {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { type?: unknown }).type === 'string'
  )
}

function* walk(root: unknown): Generator<AstNode> {
  if (!isNode(root)) return
  yield root
  for (const [key, value] of Object.entries(root)) {
    if (key === 'loc' || key === 'extra' || key === 'comments') continue
    if (Array.isArray(value)) {
      for (const child of value) yield* walk(child)
    } else if (isNode(value)) yield* walk(value)
  }
}

/** Inspect real import syntax, including inline types and reference directives. */
export function moduleReferences(
  source: string,
  declaration = true,
): ModuleReference[] {
  const ast = parse(source, {
    sourceType: 'module',
    plugins: declaration ? [['typescript', { dts: true }]] : [],
  })
  const references: ModuleReference[] = []
  for (const node of walk(ast.program)) {
    const value = [
      'ImportDeclaration',
      'ExportNamedDeclaration',
      'ExportAllDeclaration',
      'ImportExpression',
    ].includes(node.type)
      ? node.source
      : node.type === 'TSImportType'
        ? node.argument
        : node.type === 'TSExternalModuleReference'
          ? node.expression
          : node.type === 'CallExpression' &&
              isNode(node.callee) &&
              (node.callee.type === 'Import' ||
                (node.callee.type === 'Identifier' &&
                  node.callee.name === 'require')) &&
              Array.isArray(node.arguments)
            ? node.arguments[0]
            : undefined
    if (
      isNode(value) &&
      value.type === 'StringLiteral' &&
      typeof value.value === 'string' &&
      typeof value.start === 'number' &&
      typeof value.end === 'number'
    ) {
      references.push({
        specifier: value.value,
        start: value.start,
        end: value.end,
        kind: 'module',
      })
    }
  }
  // Babel preserves directives as comments, not AST import nodes.
  for (const comment of ast.comments ?? []) {
    if (comment.type !== 'CommentLine' || comment.start == null) continue
    const match = /^\/\s*<reference\s+(path|types)\s*=\s*(["'])([^"']+)\2/.exec(
      comment.value,
    )
    if (!match?.[3]) continue
    const quoted = `${match[2]}${match[3]}${match[2]}`
    const start = comment.start + 2 + comment.value.indexOf(quoted)
    references.push({
      specifier: match[3],
      start,
      end: start + quoted.length,
      kind: match[1] === 'path' ? 'path' : 'types',
    })
  }
  return references
}

function isProducer(specifier: string): boolean {
  return specifier === PRODUCER || specifier.startsWith(`${PRODUCER}/`)
}

function contained(root: string, path: string): string {
  const local = relative(root, path)
  if (
    local === '..' ||
    local.startsWith(`..${sep}`) ||
    resolve(root, local) !== path
  ) {
    throw new Error(`Declaration dependency escapes ${root}: ${path}`)
  }
  return local
}

export async function declarationFiles(root: string): Promise<string[]> {
  return (await readdir(root, { recursive: true }))
    .filter((path) => declarationPattern.test(path))
    .sort()
    .map((path) => join(root, path))
}

/** Resolve the type file behind a relative JS/type edge; never copy runtime code. */
export async function resolveDeclaration(
  origin: string,
  reference: ModuleReference,
): Promise<string> {
  const target = resolve(dirname(origin), reference.specifier)
  const candidates =
    reference.kind === 'path' || declarationPattern.test(target)
      ? [target]
      : /\.(?:js|mjs|cjs|ts|mts|cts)$/.test(target)
        ? [
            target.replace(
              /\.(js|mjs|cjs|ts|mts|cts)$/,
              (_, extension: string) =>
                ['js', 'ts'].includes(extension)
                  ? '.d.ts'
                  : ['mjs', 'mts'].includes(extension)
                    ? '.d.mts'
                    : '.d.cts',
            ),
          ]
        : [
            `${target}.d.ts`,
            `${target}.d.mts`,
            `${target}.d.cts`,
            join(target, 'index.d.ts'),
          ]
  for (const candidate of candidates) {
    try {
      if (
        (await stat(candidate)).isFile() &&
        declarationPattern.test(candidate)
      )
        return candidate
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !('code' in error) ||
        error.code !== 'ENOENT'
      )
        throw error
    }
  }
  throw new Error(
    `${origin}: missing declaration dependency ${reference.specifier}`,
  )
}

/**
 * Preserve the published declarations verbatim except for package import edges.
 * Following every relative edge (including cycles and reference directives)
 * keeps inferred store types precise without making the dev-only producer a
 * consumer dependency. Only declarations and their license are packaged.
 */
export async function closeNativeTypeDeclarations(
  distRoot: string,
  producerRoot: string,
): Promise<number> {
  const manifest = JSON.parse(
    await readFile(join(producerRoot, 'package.json'), 'utf8'),
  ) as {
    version: string
    exports: Record<string, { types?: string }>
  }
  if (manifest.version !== '0.11.7')
    throw new Error(
      `Expected published common-auth 0.11.7, got ${manifest.version}`,
    )
  const producerDist = join(producerRoot, 'dist')
  const assets = join(distRoot, TYPE_ASSETS)
  const copied = new Set<string>()
  async function copy(path: string): Promise<string> {
    const destination = join(assets, contained(producerDist, path))
    if (copied.has(path)) return destination
    copied.add(path)
    const source = await readFile(path, 'utf8')
    const output = await rewrite(source, path, destination)
    await mkdir(dirname(destination), { recursive: true })
    await writeFile(destination, output)
    return destination
  }
  async function rewrite(
    source: string,
    origin: string,
    destination: string,
  ): Promise<string> {
    const changes: { start: number; end: number; value: string }[] = []
    for (const reference of moduleReferences(source)) {
      if (isProducer(reference.specifier)) {
        if (reference.kind !== 'module')
          throw new Error(`Unsupported producer reference directive: ${origin}`)
        const subpath = `.${reference.specifier.slice(PRODUCER.length)}`
        const types = manifest.exports[subpath]?.types
        if (!types)
          throw new Error(`No published types for ${reference.specifier}`)
        const target = resolve(producerRoot, types)
        const imported = await copy(target)
        // A declaration may use value-style imports (including classes), so
        // spell the edge as JS just as the published declarations do. TypeScript
        // resolves it to the adjacent declaration without a runtime type asset.
        let specifier = relative(dirname(destination), imported)
          .split(sep)
          .join('/')
          .replace(/\.d\.(ts|mts|cts)$/, (_, extension: string) =>
            extension === 'ts' ? '.js' : extension === 'mts' ? '.mjs' : '.cjs',
          )
        if (!specifier.startsWith('.')) specifier = `./${specifier}`
        changes.push({
          start: reference.start,
          end: reference.end,
          value: JSON.stringify(specifier),
        })
      } else if (
        reference.kind === 'path' ||
        reference.specifier.startsWith('.')
      ) {
        const target = await resolveDeclaration(origin, reference)
        if (origin.startsWith(`${producerDist}${sep}`)) await copy(target)
        else contained(distRoot, target)
      }
    }
    for (const change of changes.sort((a, b) => b.start - a.start)) {
      source =
        source.slice(0, change.start) + change.value + source.slice(change.end)
    }
    return source
  }
  for (const path of await declarationFiles(distRoot)) {
    await writeFile(
      path,
      await rewrite(await readFile(path, 'utf8'), path, path),
    )
  }
  if (copied.size > 0) {
    await writeFile(
      join(assets, 'LICENSE'),
      await readFile(join(producerRoot, 'LICENSE'), 'utf8'),
    )
  }
  return copied.size
}

/** Check every emitted module and every declaration edge, not just the barrel. */
export async function verifyNativeTypeClosure(
  distRoot: string,
): Promise<string> {
  const files = (await readdir(distRoot, { recursive: true })).filter((path) =>
    /\.(?:ts|mts|cts|js|mjs|cjs)$/.test(path),
  )
  if (!files.includes('index.d.ts') || !files.includes('index.js'))
    throw new Error(`Missing Core build in ${distRoot}`)
  let edges = 0
  for (const local of files) {
    const path = join(distRoot, local)
    const declaration = declarationPattern.test(local)
    const source = await readFile(path, 'utf8')
    // Bundler source-label comments are not dependencies. Syntax inspection also
    // catches escaped spellings that a text search would miss.
    for (const reference of moduleReferences(
      source,
      declaration || extname(local) === '.ts',
    )) {
      if (isProducer(reference.specifier))
        throw new Error(`${local}: producer specifier ${reference.specifier}`)
      if (
        declaration &&
        (reference.kind === 'path' || reference.specifier.startsWith('.'))
      ) {
        contained(distRoot, await resolveDeclaration(path, reference))
        edges++
      }
    }
  }
  return `Core closure: ${files.length} modules, ${edges} relative declaration edges, no producer dependency`
}

if (import.meta.main) {
  console.log(
    await verifyNativeTypeClosure(
      fileURLToPath(new URL('../dist', import.meta.url)),
    ),
  )
}
