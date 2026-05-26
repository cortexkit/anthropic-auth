import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRIPT = join(import.meta.dir, 'release.sh')

let tempDir: string

beforeEach(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'release-test-'))
})

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true })
})

async function makeFakeBin(name: string, content: string) {
  const dir = join(tempDir, 'bin')
  await mkdir(dir, { recursive: true })
  const file = join(dir, name)
  await writeFile(file, content)
  await chmod(file, 0o755)
  return dir
}

async function runRelease(args: string[], binDir: string) {
  const proc = Bun.spawn(['bash', SCRIPT, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'pipe',
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
      CI: '1',
    },
    cwd: tempDir,
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { stdout, stderr, exitCode }
}

describe('scripts/release.sh', () => {
  test('rejects unknown args', async () => {
    const binDir = await makeFakeBin('git', '#!/usr/bin/env bash\necho main\n')
    const { exitCode, stdout, stderr } = await runRelease(
      ['--version', '1.2.3', '--nope'],
      binDir,
    )
    expect(exitCode).not.toBe(0)
    expect(`${stdout}${stderr}`).toContain('Usage:')
  })

  test('fails closed on non-default branch in CI without --yes', async () => {
    const binDir = await makeFakeBin(
      'git',
      `#!/usr/bin/env bash
if [[ "$1" == "branch" && "$2" == "--show-current" ]]; then
  echo feature/fix
elif [[ "$1" == "rev-parse" && "$2" == "v1.2.3" ]]; then
  exit 1
elif [[ "$1" == "status" && "$2" == "--porcelain" ]]; then
  exit 0
else
  exit 0
fi
`,
    )
    const { exitCode, stdout, stderr } = await runRelease(
      ['--version', '1.2.3'],
      binDir,
    )
    expect(exitCode).not.toBe(0)
    expect(`${stdout}${stderr}`).toContain('--yes')
  })
})
