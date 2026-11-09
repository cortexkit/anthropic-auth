import {
  CLAUDE_MODEL_CAPABILITIES,
  type ClaudeModelPricing,
  resolveClaudeModelCapabilities,
} from '@cortexkit/anthropic-auth-core'
import type { Model, Plugin } from '@opencode/plugin'

function effortVariants(
  efforts: readonly string[] = [],
): Model.Info['variants'] {
  return efforts.map((effort) => ({
    id: effort as Model.VariantID,
    settings: {
      effort,
      thinking: { type: 'adaptive', display: 'summarized' },
    },
  }))
}

function modelCost(pricing: ClaudeModelPricing): Model.Info['cost'][number] {
  // OC2, like OC1, has one cache-write price; use the five-minute price.
  return {
    input: pricing.input,
    output: pricing.output,
    cache: { read: pricing.cacheRead, write: pricing.cacheWrite5m },
  } as Model.Info['cost'][number]
}

function nativeCatalogueModels(): Model.Info[] {
  return CLAUDE_MODEL_CAPABILITIES.flatMap((row): Model.Info[] => {
    const catalogue = row.catalogue
    if (!catalogue) return []
    return [
      {
        id: row.id as Model.ID,
        modelID: row.id as Model.ID,
        providerID: 'anthropic' as Model.Info['providerID'],
        type: 'chat',
        family: `claude-${row.family}` as Model.Info['family'],
        name: row.name,
        // OC2 represents attachments as input modalities and reasoning as variants.
        capabilities: {
          tools: true,
          input: ['text', 'image', 'pdf'],
          output: ['text'],
          temperature: false,
        },
        variants: effortVariants(row.efforts.variants),
        time: { released: Date.parse(catalogue.releaseDate) },
        cost: [
          modelCost(catalogue.pricing),
          ...(catalogue.longContext
            ? [
                {
                  ...modelCost(catalogue.longContext.pricing),
                  tier: {
                    type: 'context' as const,
                    size: catalogue.longContext.inputTokensAbove,
                  },
                },
              ]
            : []),
        ],
        status: 'active',
        enabled: true,
        limit: {
          context: catalogue.contextWindow,
          output: catalogue.maxOutputTokens,
        },
      },
    ]
  })
}

/** Supply missing catalogue rows and adaptive-thinking effort variants. */
export function createNativeClaudeModelRules() {
  const ids = new Map<string, string>()
  const installProviderModels = (ctx: Pick<Plugin.Context, 'provider'>) =>
    ctx.provider.transform((editor) => {
      const provider = editor.get('anthropic')
      if (!provider) return
      const additions = nativeCatalogueModels().filter(
        (model) => !provider.models.has(String(model.id)),
      )
      if (!additions.length) return
      // Adding a catalogue row does not take over requests: a stock API key or
      // OpenCode's own Anthropic login still sends through OpenCode's
      // transport. Only the plugin's placeholder login (the non-secret
      // connection the plugin's sign-in methods write) routes requests to this
      // plugin's accounts.
      editor.models.set('anthropic', [
        ...provider.models.values(),
        ...additions,
      ])
    })
  const install = (ctx: Pick<Plugin.Context, 'model'>) =>
    ctx.model.transform((editor) => {
      ids.clear()
      for (const candidate of editor.list('anthropic')) {
        ids.set(String(candidate.id), String(candidate.modelID))
        const efforts = resolveClaudeModelCapabilities(candidate.modelID)
          ?.efforts.variants
        if (!efforts) continue
        editor.update('anthropic', String(candidate.id), (model) => {
          const retained = model.variants.filter(
            (variant) =>
              !efforts.some((effort) => effort === String(variant.id)),
          )
          model.variants = [...retained, ...effortVariants(efforts)]
        })
      }
    })
  return {
    install,
    installProviderModels,
    modelId: (id: string) => ids.get(id) ?? id,
  }
}
