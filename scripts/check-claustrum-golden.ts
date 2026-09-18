import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const fixtureDir = join(
  import.meta.dir,
  '..',
  'packages/opencode/src/tests/fixtures/claustrum-golden',
)
const source = JSON.parse(
  await readFile(join(fixtureDir, 'SOURCE.json'), 'utf8'),
) as {
  repo: string
  ref: string
  paths: Record<string, string>
}

function rejectSource(reason: string): never {
  console.error(`INVALID SOURCE.json: ${reason}`)
  process.exit(1)
}

if (!source.repo) rejectSource('repo is missing')
if (!source.ref) rejectSource('ref is missing')
if (!/^[0-9a-f]{40}$/.test(source.ref)) {
  rejectSource('ref must be a 40-hex SHA')
}
const paths = Object.entries(source.paths ?? {})
if (paths.length === 0) rejectSource('paths must contain at least one entry')

for (const [name] of paths) {
  try {
    await readFile(join(fixtureDir, `${name}.json`))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      rejectSource(`vendored file is missing: ${name}.json`)
    }
    throw error
  }
}

let drifted = false
let contentUnchecked = false
for (const [name, sourcePath] of paths) {
  const url = `https://raw.githubusercontent.com/${source.repo}/${source.ref}/${sourcePath}`
  let response: Response
  try {
    response = await fetch(url)
    if (!response.ok) {
      console.error(
        `CONTENT UNCHECKED: ${name}.json could not be fetched (${response.status} ${url})`,
      )
      contentUnchecked = true
      continue
    }
    const remote = Buffer.from(await response.arrayBuffer())
    const local = await readFile(join(fixtureDir, `${name}.json`))
    if (Buffer.compare(remote, local) !== 0) {
      console.error(`CONTENT FAIL: ${name}.json differs from ${url}`)
      drifted = true
      continue
    }
  } catch (error) {
    console.error(
      `CONTENT UNCHECKED: ${name}.json could not be fetched (${error instanceof Error ? error.message : String(error)})`,
    )
    contentUnchecked = true
    continue
  }
  console.log(`CONTENT PASS: ${name}.json IDENTICAL (${source.ref})`)
}

let ancestryFailed = false
let ancestryUnchecked = false
const repositoryUrl = `https://api.github.com/repos/${source.repo}`
try {
  const repositoryResponse = await fetch(repositoryUrl, {
    headers: { Accept: 'application/vnd.github+json' },
  })
  if (!repositoryResponse.ok) {
    console.error(
      `ANCESTRY UNCHECKED: could not resolve upstream default branch (${repositoryResponse.status} ${repositoryUrl})`,
    )
    ancestryUnchecked = true
  } else {
    const repository = (await repositoryResponse.json()) as {
      default_branch?: unknown
    }
    if (
      typeof repository.default_branch !== 'string' ||
      !repository.default_branch
    ) {
      console.error(
        `ANCESTRY UNCHECKED: upstream repository did not provide a default branch (${repositoryUrl})`,
      )
      ancestryUnchecked = true
    } else {
      const branch = encodeURIComponent(repository.default_branch)
      const compareUrl = `https://api.github.com/repos/${source.repo}/compare/${branch}...${source.ref}`
      const compareResponse = await fetch(compareUrl, {
        headers: { Accept: 'application/vnd.github+json' },
      })
      if (!compareResponse.ok) {
        console.error(
          `ANCESTRY UNCHECKED: compare API could not answer (${compareResponse.status} ${compareUrl})`,
        )
        ancestryUnchecked = true
      } else {
        const comparison = (await compareResponse.json()) as {
          status?: unknown
        }
        if (
          comparison.status === 'behind' ||
          comparison.status === 'identical'
        ) {
          console.log(
            `ANCESTRY PASS: pin ${source.ref} is an ancestor of ${source.repo}@${repository.default_branch} (compare status: ${comparison.status})`,
          )
        } else if (
          comparison.status === 'ahead' ||
          comparison.status === 'diverged'
        ) {
          console.error(
            `ANCESTRY FAIL: pin ${source.ref} no longer tracks upstream ${source.repo}@${repository.default_branch} (compare status: ${comparison.status})`,
          )
          ancestryFailed = true
        } else {
          console.error(
            `ANCESTRY UNCHECKED: compare API returned an unexpected status (${String(comparison.status)})`,
          )
          ancestryUnchecked = true
        }
      }
    }
  }
} catch (error) {
  console.error(
    `ANCESTRY UNCHECKED: upstream repository or compare API failed (${error instanceof Error ? error.message : String(error)})`,
  )
  ancestryUnchecked = true
}

if (drifted || contentUnchecked || ancestryFailed || ancestryUnchecked) {
  process.exitCode = 1
}
