import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { runSetupCommand, type SetupCommandOptions } from './command.ts'
import type { HarnessKind, SetupDetection } from './types.ts'

function detection(piLocalAuth = false): SetupDetection {
  return {
    opencode: {
      kind: 'opencode',
      installed: true,
      version: '1.18.31',
      configPath: '/synthetic/opencode.jsonc',
      pluginInstalled: true,
    },
    pi: {
      kind: 'pi',
      installed: true,
      version: '0.86.1',
      configPath: '/synthetic/pi',
      pluginInstalled: true,
      hasLocalAuth: piLocalAuth,
    },
    claustrum: {
      ckInstalled: true,
      ckVersion: '0.20.8',
      daemonRunning: true,
      connectionPath: '/synthetic/subc-connection.json',
    },
  }
}

/**
 * Drive the real command with injected detection, process fence, runner and
 * per-host activation. Host config writes land in a private synthetic home.
 */
async function run(
  argv: string[],
  input: {
    piLocalAuth?: boolean
    fail?: HarnessKind
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'setup-command-vault-'))
  try {
    const env: NodeJS.ProcessEnv = {
      HOME: root,
      XDG_CONFIG_HOME: join(root, '.config'),
      XDG_DATA_HOME: join(root, '.local', 'share'),
      PI_CODING_AGENT_DIR: join(root, '.pi', 'agent'),
    }
    await mkdir(join(root, '.config', 'opencode'), { recursive: true })
    await writeFile(
      join(root, '.config', 'opencode', 'opencode.jsonc'),
      '{\n  "plugin": []\n}\n',
    )
    const activations: Array<{ host: HarnessKind; consent: boolean }> = []
    const options: SetupCommandOptions = {
      env,
      fence: { listRunningHosts: async () => [] },
      runner: {
        run: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      },
      detect: async () => detection(input.piLocalAuth),
      activate: async (host, options) => {
        activations.push({ host, consent: options.removePiAnthropicAuth })
        if (host === input.fail) throw new Error('synthetic activation refusal')
        return 'committed'
      },
    }
    const code = await runSetupCommand(argv, options)
    return { code, activations }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

test('--yes alone never switches custody even when the vault daemon is available', async () => {
  const result = await run(['--yes'])
  expect(result.code).toBe(0)
  expect(result.activations).toEqual([])
})

test('--claustrum activates each selected host on its own and stops at the first failure', async () => {
  expect(await run(['--yes', '--claustrum'])).toEqual({
    code: 0,
    activations: [
      { host: 'opencode', consent: false },
      { host: 'pi', consent: false },
    ],
  })
  expect(await run(['--yes', '--claustrum'], { fail: 'opencode' })).toEqual({
    code: 1,
    activations: [{ host: 'opencode', consent: false }],
  })
})

test('a stored Pi login is removed only with the explicit --remove-pi-auth flag', async () => {
  expect(await run(['--yes', '--claustrum'], { piLocalAuth: true })).toEqual({
    code: 1,
    activations: [],
  })
  expect(
    await run(['--yes', '--claustrum', '--remove-pi-auth'], {
      piLocalAuth: true,
    }),
  ).toEqual({
    code: 0,
    activations: [
      { host: 'opencode', consent: false },
      { host: 'pi', consent: true },
    ],
  })
})
