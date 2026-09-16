import { describe, expect, test } from 'bun:test'
import { basename, win32 } from 'node:path'

import {
  __deriveCustodyManifestStaleLockPrefix,
  type CustodyHandleManifest,
  type CustodyHandleResolution,
  custodyCredentialIdFromResolution,
  readCustodyHandles,
  resolveCustodyHandle,
} from '../claustrum.ts'

describe('custody manifest stale-lock prefix', () => {
  test('derives prefixes from POSIX and Windows path basenames', () => {
    expect(
      __deriveCustodyManifestStaleLockPrefix(
        '/tmp/handles.json.lock',
        basename,
      ),
    ).toBe('handles.json.lock.stale-')
    expect(
      __deriveCustodyManifestStaleLockPrefix(
        'C:\\Users\\x\\handles.json.lock',
        win32.basename,
      ),
    ).toBe('handles.json.lock.stale-')
  })
})

describe('custodyCredentialIdFromResolution', () => {
  test("returns a resolved manifest binding's credential id verbatim, not the derived form", () => {
    // The provider-default main case: the manifest carries `oauth:anthropic`,
    // not `oauth:anthropic:main`. This is the assertion round 2's e2e test
    // could not make — it had to feed the id in by hand because the helper
    // was inline.
    const resolution: CustodyHandleResolution = {
      status: 'resolved',
      source: 'manifest',
      handle: 'ckh_a'.padEnd(47, '_'),
      credentialId: 'oauth:anthropic',
    }
    expect(custodyCredentialIdFromResolution(resolution, 'main')).toBe(
      'oauth:anthropic',
    )
  })

  test('derives from the label when the resolved source is legacy', () => {
    const resolution: CustodyHandleResolution = {
      status: 'resolved',
      source: 'legacy',
      handle: 'ckh_b'.padEnd(47, '_'),
    }
    expect(custodyCredentialIdFromResolution(resolution, 'work-alt')).toBe(
      'oauth:anthropic:work-alt',
    )
  })

  test('derives from the label when the resolution is unresolved', () => {
    const resolution: CustodyHandleResolution = {
      status: 'unresolved',
      reason: 'missing-entry',
    }
    expect(custodyCredentialIdFromResolution(resolution, 'main')).toBe(
      'oauth:anthropic:main',
    )
  })

  test("derives from the label when the manifest binding's credential id is undefined", () => {
    const resolution = {
      status: 'resolved' as const,
      source: 'manifest' as const,
      handle: 'ckh_c'.padEnd(47, '_'),
      credentialId: undefined,
    }
    expect(custodyCredentialIdFromResolution(resolution, 'main')).toBe(
      'oauth:anthropic:main',
    )
  })
})

// The manifest is a co-tenant file: a sibling plugin (`provider: 'openai'`,
// `serve: 'openai-auth'`) writes its own block in the same file, and the
// `serve`/`provider` split is what stops the two plugins from binding each
// other's handles. Provider scoping has to live in the parser because the
// sibling plugin never talks to us — it only writes the file.
describe('readCustodyHandles provider scope', () => {
  const anthropicHandle = `ckh_${'A'.repeat(43)}`
  const openaiHandle = `ckh_${'O'.repeat(43)}`
  const googleHandle = `ckh_${'G'.repeat(43)}`

  function makeManifest(provider: string, serve: string) {
    return {
      version: 1,
      providers: [
        {
          provider,
          serve,
          accounts: [],
        },
      ],
    } as const
  }

  function manifestFromParsed(
    parsed: ReturnType<typeof readCustodyHandles>,
  ): CustodyHandleManifest {
    return {
      version: 1,
      provider: parsed.provider as 'anthropic',
      serve: parsed.serve as 'anthropic-auth',
      accounts: parsed.accounts,
      superseded: parsed.superseded,
      corruptLabels: parsed.corruptLabels,
    }
  }

  function oauthAccount(label: string) {
    return { id: `uuid-${label}`, type: 'oauth' as const, refresh: 'r', label }
  }

  // (a) A real foreign id inside the anthropic block — the case the parse-time
  //     derivation check used to catch. The kind prefix (`chatgpt:`) is one
  //     the vault serves today; the rule is that `chatgpt:openai` belongs in
  //     an `openai` block, not in ours.
  test('rejects an entry whose credential id names a different provider', () => {
    const doc = makeManifest('anthropic', 'anthropic-auth')
    doc.providers[0]!.accounts.push({
      label: 'main',
      handle: anthropicHandle,
      credential_id: 'chatgpt:openai',
    })

    const parsed = readCustodyHandles(doc, 'anthropic', 'anthropic-auth')
    expect(parsed.corruptLabels).toEqual(new Set(['main']))
    expect(parsed.accounts).toEqual([])

    const result = resolveCustodyHandle({
      account: oauthAccount('main'),
      manifest: manifestFromParsed(parsed),
    })
    expect(result).toEqual({ status: 'unresolved', reason: 'corrupt-binding' })
  })

  // (b) The main case this branch exists for: the unlabelled provider-default
  //     credential id. Must still resolve — the runtime fence in
  //     custody-mode.ts is the only thing that ever proves it against the
  //     vault, but the parser must accept it verbatim.
  test("resolves the unlabelled provider-default credential id (main's id is `oauth:anthropic`)", () => {
    const doc = makeManifest('anthropic', 'anthropic-auth')
    doc.providers[0]!.accounts.push({
      label: 'main',
      handle: anthropicHandle,
      credential_id: 'oauth:anthropic',
    })

    const parsed = readCustodyHandles(doc, 'anthropic', 'anthropic-auth')
    expect(parsed.corruptLabels).toEqual(new Set())
    expect(parsed.accounts).toHaveLength(1)
    expect(parsed.accounts[0]?.credentialId).toBe('oauth:anthropic')

    const result = resolveCustodyHandle({
      account: oauthAccount('main'),
      manifest: manifestFromParsed(parsed),
    })
    expect(result).toEqual({
      status: 'resolved',
      source: 'manifest',
      handle: anthropicHandle,
      credentialId: 'oauth:anthropic',
    })
  })

  // (c) The labelled form: credential id `oauth:<provider>:<label>`.
  test('resolves a labelled credential id whose label matches the entry', () => {
    const doc = makeManifest('anthropic', 'anthropic-auth')
    doc.providers[0]!.accounts.push({
      label: 'work-alt',
      handle: anthropicHandle,
      credential_id: 'oauth:anthropic:work-alt',
    })

    const parsed = readCustodyHandles(doc, 'anthropic', 'anthropic-auth')
    expect(parsed.corruptLabels).toEqual(new Set())
    expect(parsed.accounts).toHaveLength(1)

    const result = resolveCustodyHandle({
      account: oauthAccount('work-alt'),
      manifest: manifestFromParsed(parsed),
    })
    expect(result).toEqual({
      status: 'resolved',
      source: 'manifest',
      handle: anthropicHandle,
      credentialId: 'oauth:anthropic:work-alt',
    })
  })

  // (d) The discriminating test. A label/id mismatch that is still in-provider
  //     MUST resolve: scoping by provider must not silently reintroduce the
  //     parse-time label derivation that the previous commit removed. If this
  //     goes red the parser has rebuilt the bug this branch fixed.
  test('still resolves an in-provider entry whose credential id does not derive from its label', () => {
    const doc = makeManifest('anthropic', 'anthropic-auth')
    doc.providers[0]!.accounts.push({
      label: 'work-alt',
      handle: anthropicHandle,
      credential_id: 'oauth:anthropic:something-else',
    })

    const parsed = readCustodyHandles(doc, 'anthropic', 'anthropic-auth')
    expect(parsed.corruptLabels).toEqual(new Set())
    expect(parsed.accounts).toHaveLength(1)

    const result = resolveCustodyHandle({
      account: oauthAccount('work-alt'),
      manifest: manifestFromParsed(parsed),
    })
    expect(result).toEqual({
      status: 'resolved',
      source: 'manifest',
      handle: anthropicHandle,
      credentialId: 'oauth:anthropic:something-else',
    })
  })

  // (e) The co-tenant shape: a sibling plugin's openai block in the same file
  //     must not perturb our resolution. Sanity-checks the existing
  //     `provider`/`serve` filter still works after the scope check is added.
  test('resolves ours in a co-tenant file with an openai block beside ours', () => {
    const doc = {
      version: 1,
      providers: [
        {
          provider: 'openai',
          serve: 'openai-auth',
          accounts: [
            {
              label: 'openai-main',
              handle: openaiHandle,
              credential_id: 'chatgpt:openai',
            },
          ],
        },
        {
          provider: 'anthropic',
          serve: 'anthropic-auth',
          accounts: [
            {
              label: 'main',
              handle: anthropicHandle,
              credential_id: 'oauth:anthropic',
            },
          ],
        },
      ],
    } as const

    const parsed = readCustodyHandles(doc, 'anthropic', 'anthropic-auth')
    expect(parsed.corruptLabels).toEqual(new Set())
    expect(parsed.accounts.map((a) => a.label)).toEqual(['main'])

    const result = resolveCustodyHandle({
      account: oauthAccount('main'),
      manifest: manifestFromParsed(parsed),
    })
    expect(result).toEqual({
      status: 'resolved',
      source: 'manifest',
      handle: anthropicHandle,
      credentialId: 'oauth:anthropic',
    })
  })

  // (f) The sibling plugin's real credential id. Red under the original
  //     `oauth:<provider>:<label>` rule (which would have rejected it because
  //     the kind prefix is `chatgpt:`, not `oauth:`); green under the
  //     provider-segment rule. Parser-level because the rule is shared.
  test("resolves the sibling plugin's `chatgpt:openai` id inside an openai block", () => {
    const doc = makeManifest('openai', 'openai-auth')
    doc.providers[0]!.accounts.push({
      label: 'main',
      handle: openaiHandle,
      credential_id: 'chatgpt:openai',
    })

    const parsed = readCustodyHandles(doc, 'openai', 'openai-auth')
    expect(parsed.corruptLabels).toEqual(new Set())
    expect(parsed.accounts).toHaveLength(1)
    expect(parsed.accounts[0]?.credentialId).toBe('chatgpt:openai')
    expect(parsed.accounts[0]?.label).toBe('main')
  })

  // (g) Another real kind prefix, another provider. Same shape as (f):
  //     `antigravity:google` belongs in a google block.
  test('resolves a `antigravity:google` id inside a google block', () => {
    const doc = makeManifest('google', 'google-auth')
    doc.providers[0]!.accounts.push({
      label: 'main',
      handle: googleHandle,
      credential_id: 'antigravity:google',
    })

    const parsed = readCustodyHandles(doc, 'google', 'google-auth')
    expect(parsed.corruptLabels).toEqual(new Set())
    expect(parsed.accounts).toHaveLength(1)
    expect(parsed.accounts[0]?.credentialId).toBe('antigravity:google')
    expect(parsed.accounts[0]?.label).toBe('main')
  })
})
