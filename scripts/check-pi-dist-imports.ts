import { readdir, readFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { parse } from '@babel/parser'

/**
 * Host SDK packages whose bare specifier a Pi host rewrites.
 *
 * A pi extension is loaded through the host's extension loader, which serves
 * these specifiers from the host's own bundled compatibility surface rather than
 * the `@earendil-works/*` version the extension was built against. Oh My Pi
 * answers them with its `@oh-my-pi/pi-ai` fork plus `legacy-pi-ai-shim.ts`, and
 * that fork has no transcript-replay helpers, so importing them at runtime threw
 * `Export named 'collapseSystemMessages' not found in module
 * 'omp-legacy-pi-bundled:@oh-my-pi/pi-ai'` while the extension loaded and no
 * request was ever built (v1.23.0).
 *
 * Type-only imports are safe, because TypeScript erases them, so this checks the
 * shipped JavaScript. Transcript helpers missing from the host's compatibility
 * surface are ported locally instead (packages/pi/src/transcript.ts).
 */
const HOST_PI_PACKAGE = /^@(?:earendil-works|oh-my-pi|mariozechner)\/(.+)$/

/**
 * Host runtime imports this extension relies on, and why each cannot be ported:
 * the object must be the host's own, or must match the host's own accounting.
 * The pi-ai exports use the host's legacy compat surface, not the build-time
 * SDK's transcript helpers. getAgentDir uses the real host SDK to locate its
 * auth.json rather than reconstructing the host's directory settings.
 * Standalone CLI modules may not use any of these imports.
 */
const ALLOWED_HOST_RUNTIME_IMPORTS: Record<string, readonly string[]> = {
  '@oh-my-pi/pi-ai': [
    // The stream handed back to the host must be the host's event-stream class.
    'createAssistantMessageEventStream',
    // Costs must use the host's pricing so its usage reporting agrees.
    'calculateCost',
  ],
  '@oh-my-pi/pi-coding-agent': [
    // Slot restoration must find auth.json in the host's actual agent directory.
    'getAgentDir',
  ],
}

type AstNode = { type: string; [key: string]: unknown }

function isNode(value: unknown): value is AstNode {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { type?: unknown }).type === 'string'
  )
}

/** Name of an import/export binding, which may be an identifier or a string. */
function moduleExportName(node: unknown): string | undefined {
  if (!isNode(node)) return undefined
  if (node.type === 'Identifier' && typeof node.name === 'string')
    return node.name
  if (node.type === 'StringLiteral' && typeof node.value === 'string')
    return node.value
  return undefined
}

function stringValue(node: unknown): string | undefined {
  return isNode(node) &&
    node.type === 'StringLiteral' &&
    typeof node.value === 'string'
    ? node.value
    : undefined
}

function parseModule(source: string, origin: string): AstNode {
  const program: unknown = parse(source, { sourceType: 'module' }).program
  if (!isNode(program) || !Array.isArray(program.body)) {
    throw new Error(`${origin}: could not read the module body`)
  }
  return program
}

function dynamicImportArgument(node: AstNode): unknown {
  return node.type === 'ImportExpression'
    ? node.source
    : node.type === 'CallExpression' &&
        isNode(node.callee) &&
        node.callee.type === 'Import'
      ? (node.arguments as unknown[])[0]
      : undefined
}

/** Every node in the program, for dynamic imports that can appear anywhere. */
function* walk(root: AstNode): Generator<AstNode> {
  const stack: AstNode[] = [root]
  while (stack.length > 0) {
    const node = stack.pop() as AstNode
    yield node
    for (const [key, value] of Object.entries(node)) {
      if (key === 'loc' || key === 'extra') continue
      if (Array.isArray(value)) {
        for (const item of value) if (isNode(item)) stack.push(item)
      } else if (isNode(value)) {
        stack.push(value)
      }
    }
  }
}

/**
 * Violations in one emitted module, found from its syntax tree rather than from
 * its import spelling, so quoted export names, repeated statements, re-exports
 * and dynamic imports are all seen. Imports inside comments and strings are not
 * statements and are ignored.
 */
export function findHostImportViolations(
  source: string,
  origin: string,
  runtime: 'pi-extension' | 'standalone-cli' = 'pi-extension',
): string[] {
  // Walked structurally: only node `type` fields and the few properties read
  // below are relied on, so the full @babel/types surface is not needed.
  const program = parseModule(source, origin)
  const findings: string[] = []
  const check = (specifier: string, names: string[] | 'opaque' | 'bare') => {
    const matched = HOST_PI_PACKAGE.exec(specifier)
    if (!matched) return
    if (runtime === 'standalone-cli') {
      findings.push(
        `${origin}: standalone CLI must not import host Pi SDK '${specifier}'`,
      )
      return
    }
    const allowed = ALLOWED_HOST_RUNTIME_IMPORTS[`@oh-my-pi/${matched[1]}`]
    if (
      !allowed ||
      (matched[1] === 'pi-coding-agent' &&
        Array.isArray(names) &&
        names.some((name) => !allowed.includes(name)))
    ) {
      findings.push(
        `${origin}: runtime import from '${specifier}' — port what is needed locally (see packages/pi/src/transcript.ts)`,
      )
      return
    }
    if (names === 'bare') {
      findings.push(
        `${origin}: side-effect import of '${specifier}' loads the host's copy`,
      )
      return
    }
    if (names === 'opaque') {
      findings.push(
        `${origin}: '${specifier}' must be imported only by name, not as a namespace, default or dynamic import`,
      )
      return
    }
    for (const name of names) {
      if (!allowed.includes(name)) {
        findings.push(
          `${origin}: '${specifier}' exports '${name}' to this build, but the host's compat surface is not guaranteed to`,
        )
      }
    }
  }

  for (const statement of (program.body as unknown[]).filter(isNode)) {
    if (statement.type === 'ImportDeclaration') {
      const specifier = stringValue(statement.source)
      if (specifier === undefined || statement.importKind === 'type') continue
      const specifiers = (statement.specifiers as AstNode[]) ?? []
      if (specifiers.length === 0) {
        check(specifier, 'bare')
        continue
      }
      if (specifiers.some((entry) => entry.type !== 'ImportSpecifier')) {
        check(specifier, 'opaque')
      }
      check(
        specifier,
        specifiers
          .filter(
            (entry) =>
              entry.type === 'ImportSpecifier' && entry.importKind !== 'type',
          )
          .map((entry) => moduleExportName(entry.imported) ?? ''),
      )
    } else if (statement.type === 'ExportNamedDeclaration') {
      const specifier = stringValue(statement.source)
      if (specifier === undefined || statement.exportKind === 'type') continue
      const specifiers = (statement.specifiers as AstNode[]) ?? []
      if (specifiers.some((entry) => entry.type !== 'ExportSpecifier')) {
        check(specifier, 'opaque')
      }
      check(
        specifier,
        specifiers
          .filter((entry) => entry.type === 'ExportSpecifier')
          .map((entry) => moduleExportName(entry.local) ?? ''),
      )
    } else if (statement.type === 'ExportAllDeclaration') {
      const specifier = stringValue(statement.source)
      if (specifier !== undefined) check(specifier, 'opaque')
    }
  }

  for (const node of walk(program)) {
    const argument = dynamicImportArgument(node)
    if (argument === undefined) continue
    const specifier = stringValue(argument)
    if (specifier !== undefined) {
      // Relative dynamic imports bypass Pi's extension loader. Node then loads
      // the target graph itself, losing the loader's JSON and SDK handling.
      if (
        runtime === 'pi-extension' &&
        (specifier.startsWith('./') || specifier.startsWith('../'))
      ) {
        findings.push(
          `${origin}: relative dynamic import '${specifier}' bypasses Pi's extension loader; use a static import`,
        )
      }
      check(specifier, 'opaque')
    } else {
      // Template literals and computed specifiers may resolve to a host SDK
      // at runtime. We cannot prove their targets from emitted JavaScript, so
      // reject them rather than silently letting an unsupported import ship.
      findings.push(
        `${origin}: runtime dynamic import cannot be verified ${runtime === 'pi-extension' ? 'against the host SDK allowlist' : 'for the standalone CLI'}`,
      )
    }
  }

  // A module can import the same specifier more than once.
  return [...new Set(findings)]
}

/** Relative runtime edges include lazy chunks, not just top-level imports. */
function relativeRuntimeImports(source: string, origin: string): string[] {
  const imports = new Set<string>()
  for (const node of walk(parseModule(source, origin))) {
    const specifier = stringValue(
      node.type === 'ImportDeclaration' ||
        node.type === 'ExportNamedDeclaration' ||
        node.type === 'ExportAllDeclaration'
        ? node.source
        : dynamicImportArgument(node),
    )
    if (specifier?.startsWith('./') || specifier?.startsWith('../')) {
      imports.add(specifier)
    }
  }
  return [...imports]
}

export async function verifyStandaloneCliRuntimeImports(
  entryPoint = join(
    import.meta.dir,
    '..',
    'packages',
    'opencode',
    'dist',
    'cli.js',
  ),
): Promise<string> {
  const root = dirname(resolve(entryPoint))
  const pending = [resolve(entryPoint)]
  const visited = new Set<string>()
  const findings: string[] = []
  while (pending.length > 0) {
    const file = pending.pop() as string
    if (visited.has(file)) continue
    visited.add(file)
    let source: string
    try {
      source = await readFile(file, 'utf8')
    } catch {
      throw new Error(
        `Missing standalone CLI module ${relative(process.cwd(), file)}: run \`bun run build\` first`,
      )
    }
    const origin = relative(root, file)
    findings.push(...findHostImportViolations(source, origin, 'standalone-cli'))
    for (const specifier of relativeRuntimeImports(source, origin)) {
      pending.push(resolve(dirname(file), specifier))
    }
  }
  if (findings.length > 0) {
    throw new Error(
      `Standalone CLI reaches into host Pi SDK packages at runtime:\n${findings
        .map((finding) => `  ${finding}`)
        .join('\n')}`,
    )
  }
  return `${relative(process.cwd(), entryPoint)}: ${visited.size} reachable files, no host Pi SDK runtime imports`
}

export async function verifyPiDistRuntimeImports(
  distRoot = join(import.meta.dir, '..', 'packages', 'pi', 'dist'),
): Promise<string> {
  let files: string[]
  try {
    files = (await readdir(distRoot, { recursive: true }))
      .filter((entry) => entry.endsWith('.js'))
      .map((entry) => join(distRoot, entry))
  } catch {
    throw new Error(
      `Missing ${relative(process.cwd(), distRoot)}: run \`bun run build\` first`,
    )
  }
  if (files.length === 0) {
    throw new Error(
      `No JavaScript in ${relative(process.cwd(), distRoot)}: run \`bun run build\` first`,
    )
  }

  const findings: string[] = []
  for (const file of files) {
    findings.push(
      ...findHostImportViolations(
        await readFile(file, 'utf8'),
        relative(distRoot, file),
      ),
    )
  }

  if (findings.length > 0) {
    throw new Error(
      `Pi extension runtime import violations:\n${findings
        .map((finding) => `  ${finding}`)
        .join('\n')}`,
    )
  }
  return `packages/pi/dist: ${files.length} files, host runtime imports held to the reviewed compat surface`
}

if (import.meta.main) {
  try {
    console.log(await verifyPiDistRuntimeImports())
    console.log(await verifyStandaloneCliRuntimeImports())
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
