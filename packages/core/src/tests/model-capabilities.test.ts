import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  CLAUDE_MODEL_CAPABILITIES,
  getClaudeModelCapabilities,
  resolveClaudeModelCapabilities,
} from '../model-capabilities.ts'
import {
  CLAUDE_FABLE_MYTHOS_5_1_MODEL_IDS,
  CLAUDE_FABLE_MYTHOS_5_MODEL_IDS,
  CLAUDE_FABLE_MYTHOS_5_MODEL_SPECS,
} from '../models.ts'
import { nativeQuotaModelScope } from '../native-quota-codec.ts'

const snapshot = JSON.parse(
  readFileSync(
    join(import.meta.dir, 'fixtures', 'model-capabilities-snapshot.json'),
    'utf8',
  ),
) as { models: Record<string, unknown> }

describe('model capability table', () => {
  test('Fable 5.2 resolves ahead of the Fable 5 prefix, including suffixed ids', () => {
    for (const id of ['claude-fable-5-2', 'claude-fable-5-2-20261109[1m]']) {
      expect(resolveClaudeModelCapabilities(id)).toMatchObject({
        id: 'claude-fable-5-2',
        name: 'Claude Fable 5.2',
        thinkingModes: ['adaptive'],
        rejectsForcedToolChoice: true,
        efforts: {
          variants: ['low', 'medium', 'high', 'xhigh', 'max'],
          default: 'medium',
        },
        effortMarkers: 'always',
        turnEndNote: true,
        thinkingBindingControls: true,
        serverSideFallback: true,
        refusalRecoveryFamily: 'fable-5-2',
        scopedQuota: 'fable',
        fastMode: false,
        catalogue: {
          releaseDate: '2026-11-09',
          contextWindow: 1_000_000,
          maxOutputTokens: 128_000,
          pricing: {
            input: 8,
            output: 40,
            cacheRead: 0.2,
            cacheWrite5m: 10,
            cacheWrite1h: 16,
          },
        },
      })
    }
  })

  test('ids are unique', () => {
    const ids = CLAUDE_MODEL_CAPABILITIES.map((row) => row.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  test('every row is covered by the recorded behaviour snapshot', () => {
    // A new row must be added to the snapshot test's probe list, so its
    // decisions are recorded and reviewed with the row.
    for (const row of CLAUDE_MODEL_CAPABILITIES) {
      expect(Object.keys(snapshot.models)).toContain(row.id)
    }
  })

  test('each row resolves to itself, including [1m] and dated ids', () => {
    for (const row of CLAUDE_MODEL_CAPABILITIES) {
      expect(resolveClaudeModelCapabilities(row.id)).toBe(row)
      expect(resolveClaudeModelCapabilities(`${row.id}[1m]`)).toBe(row)
      expect(resolveClaudeModelCapabilities(`${row.id}-20260101`)).toBe(row)
    }
  })

  test('ids outside the table resolve to nothing', () => {
    for (const model of [
      'claude-opus-4-8',
      'claude-sonnet-4-5',
      'claude-haiku-4-5',
      'claude-haiku-5-5-fast',
      'claude-fable',
      'claude-fable-6',
      'claude-fable-51',
      undefined,
      42,
    ]) {
      expect(resolveClaudeModelCapabilities(model)).toBeUndefined()
    }
  })

  test('an unlisted Fable 5.x id resolves to the Fable 5 row until it has its own row', () => {
    // `claude-fable-5` accepts any `-` suffix, so a new Fable 5.x id silently
    // inherits Fable 5's decisions. Adding a row for the new id makes it win
    // (longest id), and this expectation must then change with it.
    expect(resolveClaudeModelCapabilities('claude-fable-5-5')?.id).toBe(
      'claude-fable-5',
    )
    expect(resolveClaudeModelCapabilities('claude-mythos-5-5')?.id).toBe(
      'claude-mythos-5',
    )
  })

  test('the Fable and Mythos id lists match the Fable and Mythos rows', () => {
    const rows = CLAUDE_MODEL_CAPABILITIES.filter(
      (row) => row.family === 'fable' || row.family === 'mythos',
    )
    expect<string[]>([...CLAUDE_FABLE_MYTHOS_5_MODEL_IDS]).toEqual(
      rows.map((row) => row.id),
    )
    expect(Object.keys(CLAUDE_FABLE_MYTHOS_5_MODEL_SPECS)).toEqual(
      rows.map((row) => row.id),
    )
    for (const id of CLAUDE_FABLE_MYTHOS_5_1_MODEL_IDS) {
      expect(getClaudeModelCapabilities(id).family).toMatch(/^(fable|mythos)$/)
    }
  })

  test('scopedQuota agrees with the quota code, which matches substrings', () => {
    for (const row of CLAUDE_MODEL_CAPABILITIES) {
      const scope = nativeQuotaModelScope(row.id)
      expect(row.scopedQuota ?? null).toBe(
        scope === 'fable' || scope === 'mythos' ? scope : null,
      )
    }
  })

  test('refusal recovery keys are the row id without its claude- prefix', () => {
    for (const row of CLAUDE_MODEL_CAPABILITIES) {
      if (row.refusalRecoveryFamily) {
        expect<string>(row.refusalRecoveryFamily).toBe(
          row.id.replace(/^claude-/, ''),
        )
      }
    }
  })
})
