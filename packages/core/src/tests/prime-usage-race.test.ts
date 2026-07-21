import { afterEach, expect, test } from 'bun:test'
import { exists, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { createEmptyStorage, loadAccounts, saveAccounts } from '../accounts.ts'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  )
})

async function waitForFiles(paths: string[]): Promise<void> {
  const deadline = Date.now() + 10_000
  while (
    !(await Promise.all(paths.map((path) => exists(path)))).every(Boolean)
  ) {
    if (Date.now() >= deadline)
      throw new Error('child increment barrier timed out')
    await Bun.sleep(5)
  }
}

test('concurrent process increments preserve every prime usage delta', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'prime-usage-race-'))
  tempDirs.push(directory)
  const storagePath = join(directory, 'anthropic-auth.json')
  await saveAccounts(createEmptyStorage(), storagePath)

  const accountsModule = pathToFileURL(
    join(dirname(fileURLToPath(import.meta.url)), '..', 'accounts.ts'),
  ).href
  const workerPath = join(directory, 'increment-worker.ts')
  await writeFile(
    workerPath,
    `
import { exists, writeFile } from 'node:fs/promises'
import { incrementPrimeUsagePersistent } from ${JSON.stringify(accountsModule)}

const [storagePath, barrierDir, workerId] = process.argv.slice(2)
for (let iteration = 0; iteration < 20; iteration += 1) {
  await writeFile(barrierDir + '/ready-' + workerId + '-' + iteration, '')
  const go = barrierDir + '/go-' + iteration
  while (!(await exists(go))) await Bun.sleep(1)
  await incrementPrimeUsagePersistent('main', { inputTokens: 20, outputTokens: 1 }, storagePath)
}
`,
    'utf8',
  )

  const children = ['a', 'b'].map((workerId) =>
    Bun.spawn(
      [process.execPath, workerPath, storagePath, directory, workerId],
      {
        cwd: directory,
        stdout: 'pipe',
        stderr: 'pipe',
      },
    ),
  )
  for (let iteration = 0; iteration < 20; iteration += 1) {
    await waitForFiles(
      children.map((_, index) =>
        join(directory, `ready-${index === 0 ? 'a' : 'b'}-${iteration}`),
      ),
    )
    await writeFile(join(directory, `go-${iteration}`), '', 'utf8')
  }
  const exitCodes = await Promise.all(children.map((child) => child.exited))
  if (exitCodes.some((code) => code !== 0)) {
    const errors = await Promise.all(
      children.map((child) => new Response(child.stderr).text()),
    )
    throw new Error(`increment workers failed: ${errors.join('\n')}`)
  }

  const persisted = await loadAccounts(storagePath)
  expect(persisted?.prime?.main).toMatchObject({
    count: 40,
    inputTokens: 800,
    outputTokens: 40,
  })
}, 20_000)
