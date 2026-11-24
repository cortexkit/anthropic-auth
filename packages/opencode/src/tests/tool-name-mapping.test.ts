import { describe, expect, test } from 'bun:test'
import { createTestLifetimeSuite } from '../../../core/src/tests/test-lifetime'
import {
  createStrippedStream,
  NON_STREAMING_DIAGNOSTICS_MAX_BYTES,
  rewriteRequestBody,
  stripToolPrefix,
  type ToolNameMap,
} from '../transform'

const lifetimes = createTestLifetimeSuite()

async function prepare(
  names: readonly string[],
  sessionId = 'tool-mapping-test',
) {
  let toolNameMap: ToolNameMap | undefined
  const body = await rewriteRequestBody(
    JSON.stringify({
      model: 'claude-opus-4-6',
      max_tokens: 1024,
      stream: true,
      tools: names.map((name) => ({
        name,
        description: `Use ${name}`,
        input_schema: { type: 'object', properties: {} },
      })),
      tool_choice: { type: 'tool', name: names[0] },
      messages: [{ role: 'user', content: 'Use the requested tool.' }],
    }),
    {
      sessionId,
      onToolNameMap: (map) => {
        toolNameMap = map
      },
    },
  )
  return { body: JSON.parse(body), toolNameMap }
}

function streamOf(names: string[], chunkSize: number) {
  const frames = names
    .map((name, index) => {
      const data = {
        type: 'content_block_start',
        index,
        content_block: {
          type: 'tool_use',
          id: `toolu_${index}`,
          name,
          input: {},
        },
      }
      return `event: content_block_start\ndata: ${JSON.stringify(data)}\n\n`
    })
    .join('')
  const bytes = new TextEncoder().encode(frames)
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (let offset = 0; offset < bytes.length; offset += chunkSize) {
          controller.enqueue(bytes.slice(offset, offset + chunkSize))
        }
        controller.close()
      },
    }),
    { headers: { 'content-type': 'text/event-stream' } },
  )
}

async function restore(
  request: Awaited<ReturnType<typeof prepare>>,
  names: string[],
  chunkSize = 7,
) {
  const text = await createStrippedStream(streamOf(names, chunkSize), {
    toolNameMap: request.toolNameMap,
  }).text()
  return text
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice(6)).content_block.name as string)
}

function traceOwnedReader(source: ReadableStream<Uint8Array>) {
  const reads: Promise<unknown>[] = []
  const cancels: Promise<void>[] = []
  const closures: Promise<void>[] = []
  const releases: (() => void)[] = []
  const getReader = source.getReader.bind(source)
  Object.defineProperty(source, 'getReader', {
    value: () => {
      const reader = getReader()
      const read = reader.read.bind(reader)
      const cancel = reader.cancel.bind(reader)
      releases.push(reader.releaseLock.bind(reader))
      closures.push(reader.closed)
      void reader.closed.catch(() => {})
      reader.read = () => {
        const work = read()
        reads.push(work)
        void work.catch(() => {})
        return work
      }
      reader.cancel = (reason) => {
        const work = cancel(reason)
        cancels.push(work)
        void work.catch(() => {})
        return work
      }
      return reader
    },
  })
  return {
    reads,
    cancels,
    async drain() {
      for (const work of reads) await Promise.allSettled([work])
      for (const work of cancels) await Promise.allSettled([work])
      for (const work of closures) await Promise.allSettled([work])
      for (const release of releases) release()
    },
  }
}

describe('request-bound response tool names', () => {
  test('round-trips a native tool addition and prefixes the removal of a declared tool', async () => {
    const inputSchema = { type: 'object', properties: {} }
    const content = [
      {
        type: 'tool_addition',
        tool: {
          type: 'tool_definition',
          definition: {
            name: 'ReadNotes',
            description: 'Read notes',
            input_schema: inputSchema,
          },
        },
      },
      {
        type: 'tool_removal',
        tool: { type: 'tool_reference', name: 'knowhow' },
      },
    ]
    let toolNameMap: ToolNameMap | undefined
    const body = JSON.parse(
      await rewriteRequestBody(
        JSON.stringify({
          model: 'claude-opus-4-6',
          max_tokens: 1024,
          tools: [{ name: 'knowhow', input_schema: inputSchema }],
          messages: [
            { role: 'user', content: 'Use the requested tool.' },
            { role: 'system', content },
            { role: 'user', content: 'Read the notes.' },
          ],
        }),
        {
          onToolNameMap: (map) => {
            toolNameMap = map
          },
        },
      ),
    )
    expect(body.tools[0].name).toBe('mcp_Knowhow')
    expect(body.messages[1].content).toEqual([
      {
        type: 'tool_addition',
        tool: {
          type: 'tool_definition',
          definition: {
            name: 'mcp_ReadNotes',
            description: 'Read notes',
            input_schema: inputSchema,
          },
        },
      },
      {
        type: 'tool_removal',
        tool: { type: 'tool_reference', name: 'mcp_Knowhow' },
      },
    ])
    expect(toolNameMap?.declaredHostNames).toEqual(new Set(['ReadNotes']))
    expect(await restore({ body, toolNameMap }, ['mcp_ReadNotes'])).toEqual([
      'ReadNotes',
    ])
  })

  test('refuses oversized hazardous JSON instead of invoking another host tool', async () => {
    const request = await prepare(['search', 'mcp_Search'])
    const response = createStrippedStream(
      Response.json({
        type: 'message',
        content: [
          {
            type: 'tool_use',
            name: request.body.tool_choice.name,
            input: { query: 'x'.repeat(NON_STREAMING_DIAGNOSTICS_MAX_BYTES) },
          },
        ],
      }),
      { responseMode: 'json', toolNameMap: request.toolNameMap },
    )
    await expect(response.text()).rejects.toThrow(
      'Response tool-name mapping could not be validated safely',
    )
  })

  test('refuses non-injective hazardous wire names instead of passing a host alias', async () => {
    const request = await prepare(['search', 'Search', 'mcp_Search'])
    const response = createStrippedStream(
      Response.json({
        type: 'message',
        content: [{ type: 'tool_use', name: 'mcp_Search', input: {} }],
      }),
      { responseMode: 'json', toolNameMap: request.toolNameMap },
    )
    await expect(response.text()).rejects.toThrow(
      'Response tool-name mapping could not be validated safely',
    )
  })

  test('maps repeated message discriminators with host JSON semantics', async () => {
    const request = await prepare(['search', 'mcp_Search'])
    const text =
      '{"type":"message","type":"message","content":[{"type":"tool_use","name":"mcp_Search","input":{}}]}'
    const response = createStrippedStream(new Response(text), {
      responseMode: 'json',
      toolNameMap: request.toolNameMap,
    })
    expect(await response.json()).toEqual({
      type: 'message',
      content: [{ type: 'tool_use', name: 'search', input: {} }],
    })
  })

  test('retains safe ambiguous aliases as unknown host tool names', async () => {
    const request = await prepare(['aft_search', 'ctx_search'])
    expect(await restore(request, ['mcp_Search'])).toEqual(['mcp_Search'])
  })

  test('retains declarations and hazardous emitted names before ambiguity erases mappings', async () => {
    const request = await prepare(['search', 'Search', 'mcp_Search'])
    expect([...request.toolNameMap!.declaredHostNames]).toEqual([
      'search',
      'Search',
      'mcp_Search',
    ])
    expect([...request.toolNameMap!.hazardousWireNames]).toEqual(['mcp_Search'])
    expect(request.toolNameMap!.get('mcp_Search')).toBeNull()
  })

  test('uses last effective JSON routing fields without touching ignored values or arguments', async () => {
    const request = await prepare(['search', 'mcp_Search'])
    const text =
      '{"type":"error","type":"message","content":[{"type":"tool_use","name":"ignored"}],"content":[{"type":"text","type":"tool_use","name":"mcp_Mcp_Search","name":"mcp_Search","input":{"name":"mcp_Search","name":"argument"}}]}'
    const response = createStrippedStream(new Response(text), {
      responseMode: 'json',
      toolNameMap: request.toolNameMap,
    })
    expect(await response.text()).toBe(
      text.replace('"name":"mcp_Search","input"', '"name":"search","input"'),
    )
    const ignored =
      '{"type":"message","content":[{"type":"tool_use","name":"mcp_Search"}],"content":[{"type":"tool_use","type":"text","name":"mcp_Search"}]}'
    expect(
      await createStrippedStream(new Response(ignored), {
        responseMode: 'json',
        toolNameMap: request.toolNameMap,
      }).text(),
    ).toBe(ignored)
  })

  test('uses last effective SSE routing fields and preserves earlier duplicate values', async () => {
    const request = await prepare(['search', 'mcp_Search'])
    const frame =
      'data: {"type":"error","type":"content_block_start","content_block":{"type":"tool_use","name":"ignored"},"content_block":{"type":"text","type":"tool_use","name":"mcp_Mcp_Search","name":"mcp_Search","input":{"name":"mcp_Search"}}}\n\n'
    expect(
      await createStrippedStream(new Response(frame), {
        toolNameMap: request.toolNameMap,
      }).text(),
    ).toBe(
      frame.replace('"name":"mcp_Search","input"', '"name":"search","input"'),
    )
    const ignored =
      'data: {"type":"content_block_start","content_block":{"type":"tool_use","name":"mcp_Search"},"content_block":{"type":"tool_use","name":"mcp_Search","name":"unknown"}}\n\n'
    expect(
      await createStrippedStream(new Response(ignored), {
        toolNameMap: request.toolNameMap,
      }).text(),
    ).toBe(ignored)
  })

  test('refuses hazardous parse failures and unsupported routing instead of passing wire aliases', async () => {
    const request = await prepare(['search', 'mcp_Search'])
    for (const text of [
      '{"type":"message","content":[{"type":"tool_use","name":"mcp_Search"}],',
      '{"type":"message","type":"future","content":[{"type":"tool_use","name":"mcp_Search"}]}',
    ]) {
      await expect(
        createStrippedStream(new Response(text), {
          responseMode: 'json',
          toolNameMap: request.toolNameMap,
        }).text(),
      ).rejects.toThrow(
        'Response tool-name mapping could not be validated safely',
      )
    }
    for (const text of [
      'data: {"type":"content_block_start","content_block":{"type":"tool_use","name":"mcp_Search"}\n\n',
      'event: future\ndata: {"type":"content_block_start","content_block":{"type":"tool_use","name":"mcp_Search"}}\n\n',
    ]) {
      await expect(
        createStrippedStream(new Response(text), {
          toolNameMap: request.toolNameMap,
        }).text(),
      ).rejects.toThrow(
        'Response tool-name mapping could not be validated safely',
      )
    }
  })

  test('refuses oversized hazardous SSE before its frame or subsequent bytes escape', async () => {
    const request = await prepare(['search', 'mcp_Search'])
    const text =
      'data: ' +
      JSON.stringify({
        type: 'content_block_start',
        content_block: {
          type: 'tool_use',
          name: 'mcp_Search',
          input: { query: 'x'.repeat(NON_STREAMING_DIAGNOSTICS_MAX_BYTES) },
        },
      }) +
      '\n\n'
    await expect(
      createStrippedStream(new Response(text), {
        toolNameMap: request.toolNameMap,
      }).text(),
    ).rejects.toThrow(
      'Response tool-name mapping could not be validated safely',
    )
  })

  lifetimes.test(
    'joins the refused reader without waiting for its held cancellation hook',
    async () => {
      const request = await prepare(['search', 'Search', 'mcp_Search'])
      const releaseHook = lifetimes.gate()
      let hookWork: Promise<void> | undefined
      let bodyWork: Promise<string> | undefined
      let hookSettled = false
      let cancelled = 0
      let owned: ReturnType<typeof traceOwnedReader> | undefined
      lifetimes.deferCleanup(async () => {
        releaseHook.open()
        if (hookWork) {
          await Promise.allSettled([hookWork])
          expect(hookSettled).toBe(true)
        }
        if (bodyWork) await Promise.allSettled([bodyWork])
        await owned?.drain()
      })
      const source = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              'data: {"type":"content_block_start","content_block":{"type":"tool_use","name":"mcp_Search"}}\n\n',
            ),
          )
        },
        cancel() {
          cancelled++
          hookWork = releaseHook.wait.then(() => {
            hookSettled = true
          })
          return hookWork
        },
      })
      owned = traceOwnedReader(source)
      const response = createStrippedStream(new Response(source), {
        toolNameMap: request.toolNameMap,
      })
      bodyWork = response.text()
      const bodyResult = bodyWork.then(
        (value) => value,
        (error: unknown) => error,
      )
      lifetimes.deferCleanup(async () => {
        await bodyResult
      })
      expect(await bodyResult).toMatchObject({
        name: 'UnsafeToolNameResponseError',
        message: 'Response tool-name mapping could not be validated safely',
      })
      expect(cancelled).toBe(1)
      expect(hookWork).toBeInstanceOf(Promise)
      expect(hookSettled).toBe(false)
      expect(source.locked).toBe(false)
      expect(owned.reads).toHaveLength(1)
      expect(owned.cancels).toHaveLength(1)
    },
  )

  lifetimes.test(
    'cancellation failures and rejected reader closure cannot replace the fixed refusal',
    async () => {
      const request = await prepare(['search', 'Search', 'mcp_Search'])
      for (const preErrored of [false, true]) {
        let cancelWork: Promise<void> | undefined
        let bodyWork: Promise<string> | undefined
        let owned: ReturnType<typeof traceOwnedReader> | undefined
        lifetimes.deferCleanup(async () => {
          if (cancelWork) await Promise.allSettled([cancelWork])
          if (bodyWork) await Promise.allSettled([bodyWork])
          await owned?.drain()
        })
        const source = new ReadableStream<Uint8Array>(
          {
            pull(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  'data: {"type":"content_block_start","content_block":{"type":"tool_use","name":"mcp_Search"}}\n\n',
                ),
              )
              if (preErrored)
                controller.error(new Error('private provider closure prose'))
            },
            cancel() {
              cancelWork = Promise.reject(
                new Error('private provider cancel prose'),
              )
              return cancelWork
            },
          },
          { highWaterMark: 0 },
        )
        owned = traceOwnedReader(source)
        bodyWork = createStrippedStream(new Response(source), {
          toolNameMap: request.toolNameMap,
        }).text()
        const result = bodyWork.then(
          (value) => value,
          (error: unknown) => error,
        )
        lifetimes.deferCleanup(async () => {
          await result
        })
        expect(await result).toMatchObject({
          name: 'UnsafeToolNameResponseError',
          message: 'Response tool-name mapping could not be validated safely',
        })
        expect(source.locked).toBe(false)
      }
    },
  )

  test('restores the exact forced wire name before an original host alias', async () => {
    const request = await prepare(['search', 'mcp_Search'])
    expect(
      request.body.tools.map((tool: { name: string }) => tool.name),
    ).toEqual(['mcp_Search', 'mcp_Mcp_Search'])
    expect(request.body.tool_choice).toEqual({
      type: 'tool',
      name: 'mcp_Search',
    })
    const response = createStrippedStream(
      Response.json({
        content: [
          {
            type: 'tool_use',
            id: 'synthetic',
            name: request.body.tool_choice.name,
            input: {},
          },
        ],
      }),
      { responseMode: 'json', toolNameMap: request.toolNameMap },
    )
    expect(await response.json()).toEqual({
      content: [
        { type: 'tool_use', id: 'synthetic', name: 'search', input: {} },
      ],
    })
  })

  test('preserves tool arguments and unrelated JSON name fields', async () => {
    const request = await prepare(['create_file'])
    const input = {
      name: 'file',
      nested: { name: 'File' },
      items: [{ name: 'mcp_Create_file' }],
      text: '{"name":"mcp_Create_file"}',
      canonical: { name: 'create_file' },
    }
    const response = createStrippedStream(
      Response.json({
        name: 'mcp_Create_file',
        content: [
          {
            type: 'tool_use',
            id: 'mcp_Create_file',
            name: 'mcp_Create_file',
            input,
          },
          { type: 'text', name: 'mcp_Create_file', text: 'mcp_Create_file' },
        ],
        metadata: { content: [{ type: 'tool_use', name: 'mcp_Create_file' }] },
      }),
      { responseMode: 'json', toolNameMap: request.toolNameMap },
    )
    expect(await response.json()).toEqual({
      name: 'mcp_Create_file',
      content: [
        { type: 'tool_use', id: 'mcp_Create_file', name: 'create_file', input },
        { type: 'text', name: 'mcp_Create_file', text: 'mcp_Create_file' },
      ],
      metadata: { content: [{ type: 'tool_use', name: 'mcp_Create_file' }] },
    })
  })

  test('retains ordinary read wire round trips', async () => {
    const request = await prepare(['read'])
    const response = createStrippedStream(
      Response.json({
        content: [{ type: 'tool_use', name: 'mcp_Read', input: {} }],
      }),
      { responseMode: 'json', toolNameMap: request.toolNameMap },
    )
    expect(await response.json()).toEqual({
      content: [{ type: 'tool_use', name: 'read', input: {} }],
    })
    expect(await restore(request, ['mcp_Read', 'read'])).toEqual([
      'read',
      'read',
    ])
  })

  test('exact host and wire names beat competing namespace suffixes', async () => {
    const names = ['search', 'move', 'delete', 'import']
    const request = await prepare([
      ...names,
      ...names.map((name) => `aft_${name}`),
      'ctx_search',
      'ast_grep_search',
    ])
    expect(
      request.body.tools.map((tool: { name: string }) => tool.name),
    ).toEqual([
      'mcp_Search',
      'mcp_Move',
      'mcp_Delete',
      'mcp_Import',
      'mcp_Aft_search',
      'mcp_Aft_move',
      'mcp_Aft_delete',
      'mcp_Aft_import',
      'mcp_Ctx_search',
      'mcp_Ast_grep_search',
    ])
    expect(request.body.tool_choice).toEqual({
      type: 'tool',
      name: 'mcp_Search',
    })
    expect(
      await restore(request, [
        'mcp_Search',
        'search',
        'mcp_Move',
        'move',
        'mcp_Delete',
        'delete',
        'mcp_Import',
        'import',
        'mcp_Aft_search',
        'aft_search',
        'mcp_Ctx_search',
        'mcp_Ast_grep_search',
      ]),
    ).toEqual([
      'search',
      'search',
      'move',
      'move',
      'delete',
      'delete',
      'import',
      'import',
      'aft_search',
      'aft_search',
      'ctx_search',
      'ast_grep_search',
    ])
  })

  test.each(['aft_search', 'ctx_search', 'ast_grep_search'])(
    'recovers a unique short name only from declared %s',
    async (name) => {
      const request = await prepare([name])
      expect(
        await restore(request, ['mcp_Search', 'search', 'Search']),
      ).toEqual([name, name, name])
    },
  )

  test.each([
    { tools: ['aft_search', 'ctx_search'] },
    { tools: ['aft_search', 'ast_grep_search'] },
    { tools: ['ctx_search', 'ast_grep_search'] },
    { tools: ['aft_search', 'ctx_search', 'ast_grep_search'] },
  ])('leaves ambiguous short names unresolved for %j', async ({ tools }) => {
    const request = await prepare(tools)
    expect(await restore(request, ['mcp_Search', 'search', 'Search'])).toEqual([
      'mcp_Search',
      'search',
      'Search',
    ])
  })

  test('does not map absent tools, historical tools or a missing request binding', async () => {
    const request = await prepare(['bash'])
    const unknown = [
      'search',
      'mcp_Search',
      'mcp_Aft_search',
      'aft_search',
      'mcp_Move',
    ]
    expect(await restore(request, unknown)).toEqual(unknown)
    const historyOnly = await rewriteRequestBody(
      JSON.stringify({
        messages: [
          {
            role: 'assistant',
            content: [
              { type: 'tool_use', id: 'old', name: 'aft_search', input: {} },
            ],
          },
          { role: 'user', content: 'Continue.' },
        ],
      }),
      {
        onToolNameMap: (map) => {
          request.toolNameMap = map
        },
      },
    )
    expect(JSON.parse(historyOnly).messages[0].content[0].name).toBe(
      'mcp_Aft_search',
    )
    expect(await restore(request, unknown)).toEqual(unknown)
    expect(stripToolPrefix('{"name":"mcp_Bash"}')).toBe('{"name":"mcp_Bash"}')
  })

  test('preserves exact case, already-prefixed names and forced tool-choice round trips', async () => {
    const names = ['ReadFile', 'StructuredOutput', 'mcp_search', 'aft_search']
    const request = await prepare(names)
    expect(
      request.body.tools.map((tool: { name: string }) => tool.name),
    ).toEqual([
      'mcp_ReadFile',
      'mcp_StructuredOutput',
      'mcp_Mcp_search',
      'mcp_Aft_search',
    ])
    expect(request.body.tool_choice).toEqual({
      type: 'tool',
      name: 'mcp_ReadFile',
    })
    expect(
      await restore(request, [
        'mcp_ReadFile',
        'ReadFile',
        'readFile',
        'mcp_StructuredOutput',
        'mcp_Mcp_search',
        'mcp_search',
        'mcp_Aft_search',
      ]),
    ).toEqual([
      'ReadFile',
      'ReadFile',
      'ReadFile',
      'StructuredOutput',
      'mcp_search',
      'mcp_search',
      'aft_search',
    ])
  })

  test('gives exact emitted names precedence over original host aliases in SSE', async () => {
    const request = await prepare(['search', 'mcp_Search', 'aft_search'])
    expect(
      await restore(request, ['mcp_Search', 'mcp_Mcp_Search', 'search']),
    ).toEqual(['search', 'mcp_Search', 'search'])
  })

  test('leaves a colliding capitalized wire name unresolved without losing exact host names', async () => {
    const request = await prepare(['search', 'Search'])
    expect(
      await restore(request, ['mcp_Search', 'mcp_search', 'search', 'Search']),
    ).toEqual(['mcp_Search', 'mcp_search', 'search', 'Search'])
  })

  test('isolates concurrent requests within a session and across sessions', async () => {
    const requests = await Promise.all([
      prepare(['aft_search'], 'same-session'),
      prepare(['ctx_search'], 'same-session'),
      prepare(['ast_grep_search'], 'other-session'),
      prepare(['bash'], 'other-session'),
    ])
    expect(
      await Promise.all(
        requests.map((request) => restore(request, ['mcp_Search'])),
      ),
    ).toEqual([
      ['aft_search'],
      ['ctx_search'],
      ['ast_grep_search'],
      ['mcp_Search'],
    ])
  })

  test('handles every byte split in names and preserves JSON response mapping', async () => {
    const request = await prepare(['aft_search', 'read'])
    expect(
      await restore(request, ['mcp_Search', 'mcp_Read', 'read'], 1),
    ).toEqual(['aft_search', 'read', 'read'])
    const response = createStrippedStream(
      Response.json({
        content: [
          {
            type: 'tool_use',
            id: 'toolu_json',
            name: 'mcp_Aft_search',
            input: {},
          },
        ],
      }),
      { toolNameMap: request.toolNameMap, responseMode: 'json' },
    )
    expect(await response.json()).toEqual({
      content: [
        { type: 'tool_use', id: 'toolu_json', name: 'aft_search', input: {} },
      ],
    })
  })

  test.each(['\n', '\r\n', '\r'])(
    'patches only SSE tool names with every-byte %j splitting',
    async (ending) => {
      const request = await prepare(['create_file'])
      const data = [
        '{"type":"content_block_start", "name":"File",',
        '"content_block":{"input":{"name":"file","nested":{"name":"File"},"items":[{"name":"mcp_Create_file"}],"text":"{\\"name\\":\\"file\\"}"},',
        '"name"  :  "mcp_Create_file", "type":"tool_use", "id":"mcp_Create_file"}}',
      ]
      const frame =
        '\ufeff: début 🧪\n' +
        'id: mcp_Create_file\n' +
        'event: content_block_start\n' +
        data.map((line) => `data: ${line}\n`).join('') +
        '\n'
      const text = frame.replaceAll('\n', ending)
      const expected = text.replace(
        '"name"  :  "mcp_Create_file"',
        '"name"  :  "create_file"',
      )
      const bytes = new TextEncoder().encode(text)
      const response = createStrippedStream(
        new Response(
          new ReadableStream({
            start(controller) {
              for (const byte of bytes) controller.enqueue(Uint8Array.of(byte))
              controller.close()
            },
          }),
        ),
        { toolNameMap: request.toolNameMap },
      )
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(
        new TextEncoder().encode(expected),
      )
    },
  )

  test('preserves JSON bytes outside tool-name values with every-byte splitting', async () => {
    const request = await prepare(['create_file'])
    const text =
      '{ "type":"message", "content" : [{"name" : "mcp_Create_file", "input":{"name":"File","items":[{"name":"file"}]},"type":"tool_use"}], "name":"mcp_Create_file" }'
    const bytes = new TextEncoder().encode(text)
    const response = createStrippedStream(
      new Response(
        new ReadableStream({
          start(controller) {
            for (const byte of bytes) controller.enqueue(Uint8Array.of(byte))
            controller.close()
          },
        }),
      ),
      { responseMode: 'json', toolNameMap: request.toolNameMap },
    )
    expect(await response.text()).toBe(
      text.replace('"name" : "mcp_Create_file"', '"name" : "create_file"'),
    )
  })

  test('keeps canonical, unknown, malformed and non-tool SSE frames byte-identical', async () => {
    const request = await prepare(['create_file'])
    const frames = [
      'event: content_block_start\ndata: {"type":"content_block_start","content_block":{"type":"tool_use","name":"create_file","input":{"name":"file"}}}\n\n',
      'event: future\ndata: {"type":"content_block_start","content_block":{"type":"tool_use","name":"mcp_Create_file"}}\n\n',
      'event: error\ndata: {"type":"error","name":"file","content_block":{"type":"tool_use","name":"mcp_Create_file"}}\n\n',
      'data: {"type":"future","name":"mcp_Create_file","content_block":{"type":"tool_use","name":"mcp_Create_file"}}\n\n',
      'data: {"type":"content_block_start","type":"error","content_block":{"type":"tool_use","name":"mcp_Create_file"}}\n\n',
      'data: {"type":"content_block_start","content_block":{"type":"text","name":"mcp_Create_file","text":"file"}}\n\n',
      'data: {"type":"content_block_delta","delta":{"name":"File","partial_json":"{\\"name\\":\\"file\\"}"}}\n\n',
      'data: {"type":"content_block_start","content_block":{"type":"tool_use","name":"mcp_Absent","input":{"name":"file"}}}\n\n',
      'data: {"type":"content_block_start","content_block":{"type":"tool_use","name":"mcp_Create_file"}\n\n',
    ].join('')
    const bytes = new TextEncoder().encode(frames)
    const response = createStrippedStream(
      new Response(
        new ReadableStream({
          start(controller) {
            for (let offset = 0; offset < bytes.length; offset += 3)
              controller.enqueue(bytes.slice(offset, offset + 3))
            controller.close()
          },
        }),
      ),
      { toolNameMap: request.toolNameMap },
    )
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes)
  })

  test('keeps canonical and unknown JSON documents byte-identical', async () => {
    const request = await prepare(['create_file'])
    for (const text of [
      '{"content":[{"type":"tool_use","name":"create_file","input":{"name":"file"}}]}',
      '{"type":"error","content":[{"type":"tool_use","name":"mcp_Create_file"}]}',
      '{"type":"future","content":[{"type":"tool_use","name":"mcp_Create_file"}]}',
      '{"type":"message","type":"error","content":[{"type":"tool_use","name":"mcp_Create_file"}]}',
      '{"metadata":{"content":[{"type":"tool_use","name":"mcp_Create_file"}]},"name":"File"}',
      '{"content":[{"type":"text","name":"mcp_Create_file"},{"type":"tool_use","name":"unknown"}]}',
      '{"content":[{"type":"tool_use","name":"mcp_Create_file"}],',
    ]) {
      expect(
        await createStrippedStream(new Response(text), {
          responseMode: 'json',
          toolNameMap: request.toolNameMap,
        }).text(),
      ).toBe(text)
    }
  })

  test('preserves initial BOM bytes without changing response observers', async () => {
    const request = await prepare(['read'])
    const message = { type: 'message', id: 'msg_observed', content: [] }
    for (const mode of ['json', 'sse']) {
      const text =
        '\ufeff' +
        (mode === 'json'
          ? JSON.stringify(message)
          : `data: ${JSON.stringify({ type: 'message_start', message })}\n\n`)
      const seen: Record<string, unknown>[] = []
      const response = createStrippedStream(new Response(text), {
        toolNameMap: request.toolNameMap,
        ...(mode === 'json' ? { responseMode: 'json' } : {}),
        onMessageResponse: (value) => seen.push(value),
        onMessageStart: (value) => seen.push(value),
      })
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(
        new TextEncoder().encode(text),
      )
      expect(seen).toEqual([message])
    }
  })

  test.each(['json', 'sse'] as const)(
    'passes oversized %s through unchanged without losing later bytes',
    async (mode) => {
      const request = await prepare(['create_file'])
      const large = JSON.stringify({
        type: 'message',
        content: [
          {
            type: 'tool_use',
            name: 'mcp_Create_file',
            input: {
              name: 'file',
              text: 'x'.repeat(NON_STREAMING_DIAGNOSTICS_MAX_BYTES),
            },
          },
        ],
      })
      const text =
        mode === 'json'
          ? large
          : `data: ${large}\n\ndata: {"type":"content_block_start","content_block":{"type":"tool_use","name":"mcp_Create_file"}}\n\n`
      const bytes = new TextEncoder().encode(text)
      const response = createStrippedStream(
        new Response(
          new ReadableStream({
            start(controller) {
              for (let offset = 0; offset < bytes.length; offset += 1024 * 1024)
                controller.enqueue(bytes.slice(offset, offset + 1024 * 1024))
              controller.close()
            },
          }),
        ),
        {
          toolNameMap: request.toolNameMap,
          ...(mode === 'json' ? { responseMode: 'json' } : {}),
        },
      )
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes)
    },
  )
})
