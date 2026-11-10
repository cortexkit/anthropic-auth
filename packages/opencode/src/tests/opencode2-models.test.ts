import { expect, test } from 'bun:test'
import { CLAUDE_MODEL_CAPABILITIES } from '@cortexkit/anthropic-auth-core'
import type { Model, Plugin } from '@opencode/plugin'
import { createNativeClaudeModelRules } from '../v2/models'

function hostModel(modelID = 'claude-fable-5-1'): Model.Info {
  // Metadata from models.dev's Fable 5.1 row via OC2's modelInfo conversion.
  return {
    id: modelID,
    modelID,
    providerID: 'anthropic',
    type: 'chat',
    family: 'claude-fable',
    name: 'Claude Fable 5.1',
    capabilities: {
      tools: true,
      input: ['text', 'image', 'pdf'],
      output: ['text'],
      temperature: false,
    },
    variants: [],
    time: { released: Date.parse('2026-09-01') },
    cost: [{ input: 10, output: 50, cache: { read: 0.25, write: 12.5 } }],
    status: 'active',
    enabled: true,
    limit: { context: 1_000_000, output: 128_000 },
  } as unknown as Model.Info
}

async function providerCatalogue(inventory: Record<string, Model.Info[]>) {
  const writes: string[] = []
  const models = new Map(
    Object.entries(inventory).map(([provider, rows]) => [
      provider,
      new Map(rows.map((row) => [String(row.id), row])),
    ]),
  )
  const rules = createNativeClaudeModelRules()
  await rules.installProviderModels({
    provider: {
      transform: async (
        apply: Parameters<Plugin.Context['provider']['transform']>[0],
      ) => {
        apply({
          get: (provider: string) => {
            const rows = models.get(provider)
            return rows ? { models: rows } : undefined
          },
          models: {
            set: (provider: string, rows: readonly Model.Info[]) => {
              writes.push(provider)
              models.set(
                provider,
                new Map(rows.map((row) => [String(row.id), row])),
              )
            },
          },
        } as never)
        return { dispose: async () => {} }
      },
    },
  } as never)
  return { models, writes }
}

test('OC2 fills missing Anthropic catalogue rows with table limits, prices and effort variants', async () => {
  const host = hostModel()
  const { models, writes } = await providerCatalogue({ anthropic: [host] })
  expect(writes).toEqual(['anthropic'])
  expect(models.get('anthropic')?.get(host.id)).toBe(host)
  expect(models.get('anthropic')?.get('claude-fable-5-2')).toMatchObject({
    id: 'claude-fable-5-2',
    modelID: 'claude-fable-5-2',
    providerID: 'anthropic',
    type: 'chat',
    family: 'claude-fable',
    name: 'Claude Fable 5.2',
    limit: { context: 1_000_000, output: 128_000 },
    cost: [{ input: 8, output: 40, cache: { read: 0.2, write: 10 } }],
    time: { released: Date.parse('2026-11-09') },
    capabilities: {
      tools: true,
      input: ['text', 'image', 'pdf'],
      output: ['text'],
      temperature: false,
    },
    variants: ['low', 'medium', 'high', 'xhigh', 'max'].map((effort) => ({
      id: effort,
      settings: {
        effort,
        thinking: { type: 'adaptive', display: 'summarized' },
      },
    })),
  })
})

test('OC2 preserves an existing exact host row including its different price', async () => {
  const host = {
    ...hostModel('claude-fable-5-2'),
    name: 'Host-owned Fable',
    cost: [{ input: 123, output: 456, cache: { read: 7, write: 8 } }],
    variants: [{ id: 'host', settings: { effort: 'low' } }],
  } as unknown as Model.Info
  const before = structuredClone(host)
  const { models } = await providerCatalogue({ anthropic: [host] })
  expect(models.get('anthropic')?.get('claude-fable-5-2')).toBe(host)
  expect(host).toEqual(before)
})

test('OC2 leaves other providers untouched and never creates an absent Anthropic provider', async () => {
  const other = hostModel('other-model')
  const { models, writes } = await providerCatalogue({ other: [other] })
  expect(writes).toEqual([])
  expect(models.get('other')?.get('other-model')).toBe(other)
  expect(models.has('anthropic')).toBe(false)
  const both = await providerCatalogue({ anthropic: [], other: [other] })
  expect(both.writes).toEqual(['anthropic'])
  expect([...both.models.get('other')!.values()]).toEqual([other])
  expect(both.models.get('other')!.get('other-model')).toBe(other)
})

test('OC2 adds only rows with catalogues, including limited Mythos rows as on OC1', async () => {
  const { models } = await providerCatalogue({ anthropic: [] })
  expect([...models.get('anthropic')!.keys()]).toEqual(
    CLAUDE_MODEL_CAPABILITIES.filter((row) => row.catalogue).map(
      (row) => row.id,
    ),
  )
  expect(models.get('anthropic')!.has('claude-mythos-5')).toBe(true)
  expect(models.get('anthropic')!.has('claude-mythos-5-1')).toBe(true)
  expect(models.get('anthropic')!.has('claude-opus-5')).toBe(false)
})

test('OC2 matches existing models by exact id rather than a dated alias', async () => {
  const host = hostModel('claude-fable-5-2-20261109')
  const { models } = await providerCatalogue({ anthropic: [host] })
  expect(models.get('anthropic')?.get(host.id)).toBe(host)
  expect(models.get('anthropic')!.has('claude-fable-5-2')).toBe(true)
})

test('OC2 does not replace an already complete host inventory', async () => {
  const rows = CLAUDE_MODEL_CAPABILITIES.filter((row) => row.catalogue).map(
    (row) => hostModel(row.id),
  )
  const { models, writes } = await providerCatalogue({ anthropic: rows })
  expect(writes).toEqual([])
  expect([...models.get('anthropic')!.values()]).toEqual(rows)
})

test.each([
  'claude-fable-5-2',
  'claude-fable-5-2-20261109',
  'claude-mythos-5-1',
  'claude-mythos-5-1-20260901',
  'claude-mythos-5-2',
  'claude-mythos-5-2-20261109',
])(
  'OC2 adds adaptive effort variants to host catalogue model %s',
  (modelID) => {
    const candidate = {
      id: `anthropic/${modelID}`,
      modelID,
      variants: [{ id: 'custom', settings: { effort: 'low' } }],
    }
    const rules = createNativeClaudeModelRules()
    rules.install({
      model: {
        transform: (apply: (editor: unknown) => void) =>
          apply({
            list: () => [candidate],
            update: (
              _provider: string,
              _id: string,
              mutate: (model: typeof candidate) => void,
            ) => mutate(candidate),
          }),
      },
    } as never)
    expect(rules.modelId(candidate.id)).toBe(modelID)
    expect(candidate.variants).toEqual([
      { id: 'custom', settings: { effort: 'low' } },
      ...['low', 'medium', 'high', 'xhigh', 'max'].map((effort) => ({
        id: effort,
        settings: {
          effort,
          thinking: { type: 'adaptive', display: 'summarized' },
        },
      })),
    ])
  },
)

test('OC2 registers missing Mythos 5.1 and 5.2 rows with adaptive effort variants', async () => {
  const { models } = await providerCatalogue({ anthropic: [] })
  for (const id of ['claude-mythos-5-1', 'claude-mythos-5-2']) {
    const row = models.get('anthropic')?.get(id)
    expect<unknown>(row?.variants).toEqual(
      ['low', 'medium', 'high', 'xhigh', 'max'].map((effort) => ({
        id: effort,
        settings: {
          effort,
          thinking: { type: 'adaptive', display: 'summarized' },
        },
      })),
    )
  }
  expect(models.get('anthropic')?.get('claude-mythos-5-2')).toMatchObject({
    name: 'Claude Mythos 5.2',
    family: 'claude-mythos',
    limit: { context: 1_000_000, output: 128_000 },
    cost: [{ input: 8, output: 40, cache: { read: 0.2, write: 10 } }],
    time: { released: Date.parse('2026-11-09') },
  })
})
