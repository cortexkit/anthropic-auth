# Request rewriting and safety fallback

## Request rewriting

For Claude Pro/Max OAuth requests, the plugin changes outgoing HTTP headers and bodies after OpenCode constructs the request and before dispatch to Anthropic:

1. Check the destination. OAuth requests go only to `https://api.anthropic.com`: if a provider `baseURL` or `ANTHROPIC_BASE_URL` points anywhere else, the plugin refuses the request locally with a 400 and sends nothing. `ANTHROPIC_BASE_URL` still applies to API-key routes. The one exception is a [custom gateway](settings-file.md#custom-gateway) set in your own user settings file: model requests then go to it, as full uncompressed requests, with only the URL and the gateway headers changed. A project file, provider `baseURL` or environment variable can never set or widen it.
2. Normalize Claude-compatible OAuth headers and beta flags.
3. Remove OpenCode-specific identity text from system blocks.
4. Prepend Claude Code identity and billing-header blocks.
5. Rewrite cache controls according to the configured cache mode.
6. Rename MCP tools into Claude-compatible PascalCase form, with response names mapped back to the host.
7. Apply the [configured refusal fallback mode](refusal-fallback.md) on eligible OAuth requests, restoring stored fallback boundaries in `server` mode.
8. Compute final-body `cch`, the billing signature, from the fully shaped request using the signer's canonicalization: reset the billing placeholder and normalize the model/token-limit fields before hashing.

The sanitizer is anchor-based: it removes paragraphs containing known OpenCode documentation/source anchors, applies a small set of inline replacements and preserves the remaining prompt, including user/project instructions, tool policy, environment context and file paths.

Model-family normalization supplies [adaptive thinking and effort](models.md#adaptive-thinking-and-effort). Billing metadata uses the Claude Code identity string and version bundled with the plugin (currently 2.1.302). `cc_prompt_id` identifies the user turn across tool-loop requests, and `cc_prev_req` records the previous request in that lineage. With a prompt id, the block also carries `cc_turn_origin=human` and `cc_prompt_index`/`cc_turn_index`: the number of user prompts in the conversation, which a tool-result follow-up keeps. The prompt id is repeated in the `x-claude-code-prompt-id` header, and `x-claude-code-request-class` is `main`, or `auxiliary` for title, summary and quota-window (`prime`) requests. Large bodies to `api.anthropic.com` are [gzipped on the wire](transports.md#request-body-compression) as Claude Code 2.1.302 sends them. OpenCode 2 registers an Anthropic provider source with the host and uses the shared request transform, instead of OpenCode 1's auth-loader fetch wrapper.

Pi replaces the Anthropic provider implementation and converts its transcript, tools and system prompt to the signed Claude-compatible request shape described above. Pi's ordinary subscription requests use the same billing lineage and turn indexes as OpenCode 1 and 2. Cache keep-warm requests, quota-window Prime requests and requests for a forked conversation stay outside the active turn's chain. When the converter recognizes Pi's standard documentation section, that paragraph is moved into a separate cached block before the first user's text. If the section layout is unrecognized, the prompt is moved as a whole rather than placing the documentation in top-level `system[]`, where Anthropic rejects it. Tool replay and origin-aware thinking-signature filtering preserve compatible Anthropic thinking and remove incompatible OpenAI reasoning signatures.

OpenCode 1, OpenCode 2 and Pi send paid API-key requests without adding a Claude Code identity, changing tool names, or signing the body. The plugin still checks the message history, removes internal markers and OAuth-only fallback fields and persona betas, and applies the API route's endpoint, header and model overrides. See [environment overrides](environment.md#api-endpoint-and-proxy-routes).

## Refusal fallback

OpenCode 1, OpenCode 2 and Pi default to `client`: Core can join a retry into the current response and reports only the serving model's usage to the host. Refused attempts are reported separately for billing. See [refusal fallback](refusal-fallback.md) for the shared setting, mode choices and how temporary fallback rounds work.

### Server-mode per-attempt usage

On a server-fallback step, Anthropic's top-level `usage` is the **billed sum of both attempts**. The plugin leaves that usage unchanged. Do not use that total as the final model's context size.

The supported per-iteration breakdown is a separate hidden reasoning part, emitted after the answer's content blocks and before the terminal `message_delta`. Its thinking text is two word joiners (`"\u2060\u2060"`), and its Anthropic signature has this format:

```text
cortexkit-server-fallback-usage-v1:{"iterations":[{"type":"message","model":"claude-opus-5-5","input_tokens":100,"output_tokens":0,"cache_read_input_tokens":400000,"cache_creation_input_tokens":500},{"type":"fallback_message","model":"claude-opus-4-8","input_tokens":120,"output_tokens":80,"cache_read_input_tokens":390000,"cache_creation_input_tokens":10480}]}
```

Read the signature from the stored reasoning part: `metadata.anthropic.signature` on OpenCode 1. On OpenCode 2 it's the reasoning item's `native.signature` (2.2 and later), or the signature inside its `state` record on 2.0.x. The plugin sends each marker's signature in a single `signature_delta`, and OpenCode stores it byte for byte. Parse the JSON after `cortexkit-server-fallback-usage-v1:`. `iterations` preserves the order of Anthropic's `usage.iterations`; each entry contains `type` (`message` or `fallback_message`), `model`, `input_tokens`, `output_tokens`, and optional `cache_read_input_tokens` and `cache_creation_input_tokens` (absent cache counts mean zero). To size the final fallback context, use the last `fallback_message` entry's input plus cache-read plus cache-write counts, **not** the sum over iterations. Output remains separate.

The usage marker is present only on fallback steps, including turns that continue on server fallback without a new boundary block. It accepts at most eight iterations, model IDs of at most 128 ASCII characters, nonnegative safe-integer token counts, and a JSON payload of at most 4096 bytes. Unknown fields are omitted; invalid or oversized breakdowns produce no usage marker rather than a partial or misleading breakdown. Top-level usage is still forwarded unchanged in those cases.

This usage-only marker is distinct from the `cortexkit-server-fallback-v1:` conversation boundary. Before every subsequent send, the plugin removes usage markers entirely, even with server fallback disabled or on an API-key route. It restores the original conversation-boundary marker to the same Anthropic `fallback` block only on requests that still use server fallback.

OpenCode 1 does not persist the provider's finish metadata on step records. OpenCode 2's parser retains raw usage in its usage metadata, but step settlement projects it to numeric tokens and discards the breakdown. Both OpenCode versions keep the breakdown in the hidden per-attempt usage marker described above. Pi also supports `server` mode and restores the fallback boundary on replay; the usage marker is never sent back to Anthropic.

## Implementation

- [OpenCode wire shaping and sanitizer](../packages/opencode/src/transform.ts)
- [OpenCode 1 dispatch and lineage](../packages/opencode/src/index.ts)
- [Server fallback boundaries](../packages/core/src/server-fallback.ts)
- [Client fallback rounds](../packages/core/src/refusal-fallback-round.ts) and [stream joining](../packages/core/src/refusal-fallback-stream.ts)
- [OpenCode 2 wire options](../packages/opencode/src/v2/wire.ts) and [adapter](../packages/opencode/src/v2/adapter.ts)
- [Pi conversion](../packages/pi/src/convert.ts) and [transcript replay](../packages/pi/src/transcript.ts)
- [Final-body signing](../packages/core/src/cch.ts)
