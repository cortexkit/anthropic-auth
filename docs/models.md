# Models, thinking and fast mode

## Model catalog

The Pi extension offers the following models in its Anthropic provider catalog. OpenCode adds native definitions for the newer families and retains OpenCode's other Anthropic models. A catalog entry does not grant account access; Mythos 5 and 5.1 are limited-access models.

| Family | Native API IDs |
| --- | --- |
| Fable 5 / 5.1 | `claude-fable-5`, `claude-fable-5-1` |
| Mythos 5 / 5.1 | `claude-mythos-5`, `claude-mythos-5-1` |
| Opus 5 / 5.5 | `claude-opus-5`, `claude-opus-5-5` |
| Sonnet 5 / 5.5 | `claude-sonnet-5`, `claude-sonnet-5-5` |
| Haiku 5.5 | `claude-haiku-5-5` |
| Earlier Pi entries | `claude-opus-4-8`, `claude-opus-4-5`, `claude-sonnet-4-5` |

Fable/Mythos 5 and 5.1, Opus 5/5.5, Sonnet 5/5.5 and Haiku 5.5 use a 1M-token context and 128K maximum output in the catalog. Optional quota priming still uses the minimal Haiku 4.5 request, not Haiku 5.5.

### Haiku 5.5 pricing

Standard input/output rates are $0.10/$0.50 per million tokens. Above 100K total input tokens, including cached input, **all** request rates increase fivefold; the higher rate applies to the whole request, not just tokens above the threshold.

| Per-million-token rate | Up to 100K input | Above 100K input |
| --- | --- | --- |
| Input | $0.10 | $0.50 |
| Output | $0.50 | $2.50 |
| Cache read | $0.01 | $0.05 |
| Five-minute cache write | $0.125 | $0.625 |
| One-hour cache write | $0.20 | $1.00 |

OpenCode 1 and 2 show zero model prices by default when signed in with OAuth because subscription use is quota-based. API-key prices are unchanged. Set `cost_zeroing_enabled: false` in the shared settings file (or `costZeroing.enabled: false` in a legacy account file) to show catalogue prices. This does not make OpenCode's dollar accounting route-aware when a paid fallback serves a request. Pi's catalog includes a higher Haiku pricing tier above 100K input tokens, counting cached input toward that threshold; its displayed costs remain estimates, not billing receipts.

## Adaptive thinking and effort

Fable/Mythos reasoning uses `thinking: { type: "adaptive", display: "summarized" }` with `output_config.effort`, not manual `budget_tokens`. Opus 5/5.5 and Sonnet 5/5.5 also request summarized adaptive thinking so the host can display reasoning.

OpenCode exposes native `low`, `medium`, `high`, `xhigh` and `max` effort variants for Fable 5.1, Opus 5/5.5, Sonnet 5.5 and Haiku 5.5. On OAuth routes, effort changes for Fable 5.1, Opus 5.5 and Sonnet 5.5 are carried as empty mid-conversation system messages with `output_config.effort`, under `per-turn-control-2026-07-01`, rather than rewriting the cached prefix. Opus 5.5 and Sonnet 5.5 need adaptive thinking for this; Sonnet 5.5 `between_tools` keeps the host's top-level effort. Opus 5, Haiku 5.5 and Mythos 5.1 still change the top-level effort; Haiku 5.5 carries the per-turn-control beta to match Claude Code but does not receive effort markers. OpenCode 2 supplies its own system messages recording each effort change at that point in the conversation; the plugin does not insert a second copy of those effort-change system messages or alter earlier cached history.

- **Opus 5.5:** adaptive thinking is always on. Disabled thinking and manual budgets are replaced with summarized adaptive thinking. Forced tool choice is removed.
- **Opus 5:** an explicit disabled-thinking request is preserved; incompatible `xhigh`/`max` effort is capped to `high`.
- **Sonnet 5.5:** OpenCode preserves an explicit no-up-front-thinking request as bare `between_tools`, with effort capped to `high`. Pi's simple-provider options cannot express that mode, so Pi exposes `low` through `max`, not `off` or unsupported `minimal`, and sends summarized adaptive thinking.
- **Haiku 5.5:** OpenCode preserves explicit disabled thinking and caps incompatible `xhigh`/`max` effort to `high`. Manual budgets and sampling parameters are removed; forced tool choice remains supported. Pi sends summarized adaptive thinking with `low` through `max`, not `off` or unsupported `minimal`.

## Thinking-prefix mismatch controls

Anthropic associates replayed reasoning blocks with the messages, instructions and tools that preceded them. Editing that earlier content can make the saved thinking signature disagree with the request's prefix. In the host's plugin preferences, `thinkingBinding.prefixMismatchBehavior` selects how Anthropic handles a change to that earlier prefix on OAuth Fable 5.1, Opus 5.5, Sonnet 5.5 and Haiku 5.5 continuations:

| Value | Effect |
| --- | --- |
| `account-default` | Send no local override; use Anthropic's account settings |
| `error` | Ask Anthropic to reject a prefix mismatch |
| `drop_block` | Ask Anthropic to discard mismatched thinking blocks |

For an explicit `error` or `drop_block` value, the plugin sends the selected server policy as `thinking.block_binding`, but only when adaptive thinking replays a signed `thinking` or nonempty `redacted_thinking` block. The field does not apply to Sonnet's `between_tools` mode or a first turn without replayed thinking. OAuth main requests advertise the thinking-binding beta even without a binding field, matching Claude Code 2.1.302; advertising support alone does not select a server policy. See [settings ownership](configuration.md#settings).

## OAuth beta lists

Beta selection follows the request class, not the presence of tools or companion body fields. Conversation turns use Claude Code 2.1.302's main list, including `thinking-binding-controls-2026-08-01`. Auxiliary one-token, non-streaming quota probes without thinking, tools or structured output use the smaller quota list; other auxiliary requests use the title/summary list, including `redact-thinking-2026-02-12`. JSON-schema requests additionally advertise structured output; fast mode and context-window feature betas retain their request-dependent selection.

The main list sends `per-turn-control-2026-07-01` for Sonnet 5.5, Opus 5.5, Fable 5.1 and Haiku 5.5, but not Opus 4.8. Haiku 5.5 places `claude-code-20250219` after the prompt-caching-scope beta. The obsolete mid-conversation-system and mid-conversation-output-config betas are absent, as are the advisor-tool and separate fallback-credit betas. [Refusal fallback](refusal-fallback.md) uses `server-side-fallback-2026-07-01` on eligible OAuth requests in all three modes; only `server` also sends `fallbacks: "default"`.

The beta lists match the capture, including `thinking-display-updates-2026-08-18` on main requests. Our bodies keep `thinking.display: "summarized"` where Claude Code sends `"updates"`, because `"updates"` streams no thinking text. The beta alone does not suppress summarized thinking. The binding fields and effort-marker bodies are unchanged.

## Claude fast mode

Both hosts persist **Enable fast mode** / **Disable fast mode** from `/claude` → **Extras**. **Fast mode status** shows the setting. Supported Opus requests add `speed: "fast"` and the `fast-mode-2026-02-01` beta header; unsupported models stay at standard speed.

The supported IDs are `claude-opus-4-8`, `claude-opus-5` and `claude-opus-5-5`. Fable/Mythos 5 and 5.1 are not fast-mode models. Fast and standard speeds do not share prompt-cache prefixes, so switching can cause cache misses.

Implementation: [model constants and rates](../packages/core/src/models.ts), [Pi catalog](../packages/pi/src/index.ts), [Pi conversion](../packages/pi/src/convert.ts), [OpenCode variants](../packages/opencode/src/index.ts), [OpenCode normalization](../packages/opencode/src/transform.ts), [thinking binding](../packages/core/src/thinking-binding.ts), and [fast-model selection](../packages/core/src/constants.ts).
