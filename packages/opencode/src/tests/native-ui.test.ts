import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import type {
  CommandApplyRequest,
  CommandApplyResult,
  CommandDialogPayload,
} from '@cortexkit/common-auth/commands'
import type {
  TuiDialogConfirmProps,
  TuiDialogPromptProps,
  TuiDialogSelectProps,
} from '@opencode-ai/plugin/tui'
import { testRender } from '@opentui/solid'
import type { JSX } from 'solid-js'
import { createNativeUi } from '../../../core/src/native-ui.ts'
import { openNativeMenuDialog } from '../tui/command-dialogs.tsx'

test('dual TUI entry exposes both default host methods without eagerly loading OC1 TSX', () => {
  const entry = fileURLToPath(new URL('../tui/entry.mjs', import.meta.url))
  // Node cannot load the legacy TSX entry. Importing this actual module under
  // Node therefore proves that the SDK2 import path does not eagerly load it.
  const probe = spawnSync(
    'node',
    [
      '--input-type=module',
      '-e',
      `
    const entry = await import(process.argv[1]);
    if (entry.default.tui !== entry.tui || entry.default.setup !== entry.setup)
      throw new Error('Default and named host methods must agree');
    console.log(JSON.stringify({ id: entry.default.id, tui: typeof entry.default.tui, setup: typeof entry.default.setup }));
  `,
      entry,
    ],
    { encoding: 'utf8' },
  )
  expect(probe.status).toBe(0)
  const exported: unknown = JSON.parse(probe.stdout)
  expect(exported).toEqual({
    id: 'cortexkit.anthropic-auth',
    tui: 'function',
    setup: 'function',
  })
})

async function harness() {
  const menu = createNativeUi({
    host: 'opencode',
    interactive: true,
    dispatch: async () => ({ ok: true, text: 'Applied' }),
    readStatus: async (command) => `${command}: honest status`,
  })
  const payload = await menu.open({ sessionId: 'a', notify() {} })
  const requests: CommandApplyRequest[] = []
  const toasts: string[] = []
  let select:
    | {
        title: string
        options: { title: string; value: string }[]
        onSelect: (option: { title: string; value: string }) => void
      }
    | undefined
  let prompt: TuiDialogPromptProps | undefined
  let confirm: TuiDialogConfirmProps | undefined
  let render: (() => JSX.Element) | undefined
  let currentSession = true
  let cleared = 0
  const api = {
    ui: {
      dialog: {
        size: 'xlarge' as const,
        depth: 0,
        open: true,
        setSize() {},
        replace(fn: () => JSX.Element) {
          render = fn
        },
        clear() {
          cleared++
        },
      },
      toast(options: { message: string }) {
        toasts.push(options.message)
      },
      DialogSelect<Value>(props: TuiDialogSelectProps<Value>) {
        select = {
          title: props.title,
          options: props.options.map((option) => ({
            title: option.title,
            value: String(option.value),
          })),
          onSelect(option) {
            const original = props.options.find(
              (entry) => String(entry.value) === option.value,
            )
            if (original) props.onSelect?.(original)
          },
        }
        return null
      },
      DialogPrompt(props: TuiDialogPromptProps) {
        prompt = props
        return props.description?.() ?? null
      },
      DialogConfirm(props: TuiDialogConfirmProps) {
        confirm = props
        return null
      },
    },
  }
  let apply: (request: CommandApplyRequest) => Promise<CommandApplyResult> =
    async (request) => {
      requests.push(request)
      return menu.apply(request, { sessionId: 'a', notify() {} })
    }
  let pending: Promise<CommandApplyResult> | undefined
  const invoke = (request: CommandApplyRequest) => {
    pending = apply(request)
    return pending
  }
  const draw = async () => {
    select = undefined
    prompt = undefined
    confirm = undefined
    if (!render) throw new Error('No dialog render')
    const frame = await testRender(render)
    await frame.flush()
    frame.renderOnce()
    const text = frame
      .captureSpans()
      .lines.map((line) => line.spans.map((span) => span.text).join(''))
      .join('\n')
    frame.renderer.destroy()
    return text
  }
  const choose = (value: string) => {
    const option = select?.options.find((entry) => entry.value === value)
    if (!option) throw new Error(`Missing option ${value}`)
    select?.onSelect?.(option)
  }
  openNativeMenuDialog(api, payload, invoke, () => currentSession)
  return {
    payload,
    requests,
    toasts,
    draw,
    choose,
    async settle() {
      try {
        await pending
      } catch {
        // The renderer already reports IPC failure to the user. Suppress only
        // the rejection from the test harness observing that handled promise.
      }
      await Promise.resolve()
    },
    get select() {
      return select
    },
    get prompt() {
      return prompt
    },
    get confirm() {
      return confirm
    },
    get cleared() {
      return cleared
    },
    leave() {
      currentSession = false
    },
    setApply(callback: typeof apply) {
      apply = callback
    },
    reopen(next: CommandDialogPayload) {
      openNativeMenuDialog(api, next, invoke, () => currentSession)
    },
  }
}

test('single Claude dialog displays all sections, honest status and every action', async () => {
  const h = await harness()
  await h.draw()
  expect(h.select?.title).toBe('Claude')
  expect(h.select?.options.map((option) => option.title)).toEqual([
    'Accounts',
    'Quota',
    'Routing',
    'Limits',
    'Cache',
    'Diagnostics',
    'Extras',
    'Close',
  ])
  h.choose('Cache')
  expect(await h.draw()).toContain('cachekeep: honest status')
  expect(h.select?.options.map((option) => option.value)).toEqual([
    'action:cache-on',
    'action:cache-off',
    'action:cache-mode',
    'action:cachekeep-always',
    'action:cachekeep-off',
    'action:cachekeep-window',
    'action:cachekeep-subagents',
    '__back',
  ])
  h.choose('__back')
  await h.draw()
  h.choose('__close')
  expect(h.cleared).toBe(1)
})

test('renderer collects API key, label, baseURL and authHeader without seeding secrets', async () => {
  const h = await harness()
  await h.draw()
  h.choose('Accounts')
  await h.draw()
  h.choose('action:add-apikey')
  expect(await h.draw()).toContain('This host prompt displays input')
  expect(h.prompt?.value).toBe('')
  h.prompt?.onConfirm?.('synthetic-ui-key')
  await h.draw()
  h.prompt?.onConfirm?.('two word label')
  await h.draw()
  h.prompt?.onConfirm?.('https://example.invalid/api')
  await h.draw()
  h.choose('x-api-key')
  await h.settle()
  await h.draw()
  expect(h.requests).toEqual([
    {
      command: 'claude',
      sectionId: 'Accounts',
      actionId: 'add-apikey',
      values: {
        apiKey: 'synthetic-ui-key',
        label: 'two word label',
        baseURL: 'https://example.invalid/api',
        authHeader: 'x-api-key',
      },
    },
  ])
  expect(h.toasts).toEqual(['Applied'])
  expect(h.select?.title).toBe('Accounts')
})

test('renderer confirmation cancellation prevents removal and clears collected input', async () => {
  const h = await harness()
  await h.draw()
  h.choose('Accounts')
  await h.draw()
  h.choose('action:remove')
  await h.draw()
  h.prompt?.onConfirm?.('vault:oauth:team')
  await h.draw()
  expect(h.confirm?.message).toContain('Remove')
  h.confirm?.onCancel?.()
  await h.draw()
  expect(h.requests).toEqual([])
  h.choose('action:remove')
  await h.draw()
  h.prompt?.onConfirm?.('vault:oauth:team')
  await h.draw()
  h.confirm?.onConfirm?.()
  await h.settle()
  await h.draw()
  expect(h.requests).toEqual([
    {
      command: 'claude',
      sectionId: 'Accounts',
      actionId: 'remove',
      values: { id: 'vault:oauth:team' },
      confirmed: true,
    },
  ])
})

test('renderer keeps structured scoped thresholds and full opaque account IDs', async () => {
  const h = await harness()
  await h.draw()
  h.choose('Limits')
  await h.draw()
  h.choose('action:killswitch-set')
  await h.draw()
  const rows =
    '[{"account":"vault:oauth:anthropic:team","fh":5,"sd":10,"scoped":27}]'
  h.prompt?.onConfirm?.(rows)
  await h.settle()
  await h.draw()
  expect(h.requests[0]?.values).toEqual({ entries: rows })
})

test('renderer validates hours and preserves overnight windows', async () => {
  const h = await harness()
  await h.draw()
  h.choose('Cache')
  await h.draw()
  h.choose('action:cachekeep-window')
  await h.draw()
  h.prompt?.onConfirm?.('24')
  expect(h.requests).toEqual([])
  expect(h.toasts[0]).toContain('number in range')
  h.prompt?.onConfirm?.('23')
  await h.draw()
  h.prompt?.onConfirm?.('7')
  await h.settle()
  await h.draw()
  expect(h.requests[0]?.values).toEqual({ startHour: 23, endHour: 7 })
})

test('stale session callbacks cannot submit an action', async () => {
  const h = await harness()
  await h.draw()
  h.choose('Accounts')
  await h.draw()
  h.choose('action:remove')
  await h.draw()
  h.prompt?.onConfirm?.('opaque-id')
  await h.draw()
  h.leave()
  h.confirm?.onConfirm?.()
  expect(h.requests).toEqual([])
})

test('late results after a route change cannot toast or replace another session dialog', async () => {
  const h = await harness()
  let resolve: ((result: CommandApplyResult) => void) | undefined
  h.setApply((request) => {
    h.requests.push(request)
    return new Promise((done) => {
      resolve = done
    })
  })
  await h.draw()
  h.choose('Cache')
  await h.draw()
  h.choose('action:cache-on')
  expect(h.requests).toHaveLength(1)
  h.leave()
  resolve?.({
    command: 'claude',
    ok: true,
    text: 'late secret-free result',
    menu: h.payload.menu,
  })
  await h.settle()
  expect(h.toasts).toEqual([])
})

test('failed IPC is generic and duplicate clicks do not repeat an effect', async () => {
  const h = await harness()
  let reject: ((reason: Error) => void) | undefined
  h.setApply((request) => {
    h.requests.push(request)
    return new Promise((_resolve, fail) => {
      reject = fail
    })
  })
  await h.draw()
  h.choose('Cache')
  await h.draw()
  h.choose('action:cache-on')
  h.choose('action:cache-on')
  expect(h.requests).toHaveLength(1)
  reject?.(new Error('synthetic-secret-error'))
  await h.settle()
  await h.draw()
  expect(h.toasts).toEqual(['Menu apply unavailable; outcome unknown.'])
})
