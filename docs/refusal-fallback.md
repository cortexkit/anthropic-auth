# Refusal fallback

OpenCode 1, OpenCode 2 and Pi use **client fallback by default** on eligible Claude subscription requests. The plugin can retry a model refusal inside the same request and temporarily serve the session on another model. This is separate from [account routing and paid API-key fallback](accounts-and-routing.md).

## Choose a mode

Set `refusal_fallback` in your [shared user settings file](settings-file.md), `anthropic-auth.jsonc`. It takes one value for all hosts using that file, with no project, host or model override. For example, to use Anthropic's server-side fallback:

```jsonc
{
  "schema_version": 1,
  "refusal_fallback": "server"
}
```

| Value | Behavior on eligible subscription requests |
| --- | --- |
| `client` (default) | The plugin handles eligible refusals. It can retry the refused step in place and then continue on the serving model for a limited number of responses. It does not ask Anthropic to do server-side fallback. |
| `server` | Anthropic handles fallback. The plugin preserves Anthropic's fallback boundary and per-attempt usage. It does not retry a refusal or start a round. |
| `off` | Neither the plugin nor Anthropic is asked to retry refusals. The refusal passes through, with any fallback credit token redacted. |

The mode does not enable OAuth fallback on paid API-key or custom provider routes. In `client` and `off`, eligible OAuth requests still advertise Anthropic's fallback beta but omit the `fallbacks` body field. Only `server` sends `fallbacks: "default"`.

Running hosts that watch the shared file pick up edits without a restart. A mode change ends any live client round on the next primary request. Keep-warm continues to follow the session's cache policy.

### Migrating from environment variables

The user setting replaces both retired switches. Neither variable has any effect now:

- **OpenCode 1:** if you used `OPENCODE_ANTHROPIC_AUTH_FALLBACK_MODE=legacy`, use `client` for the new shared client behavior. The old server-first policy with a client backstop is no longer available; use `server` for Anthropic-only fallback.
- **OpenCode 2:** if you used `OPENCODE_ANTHROPIC_AUTH_CONTENT_FILTER_FALLBACK=legacy` to disable fallback, use `off`. To keep Anthropic-only fallback, use `server`.

## What happens in client mode

Only a response that ends with a refusal can trigger client fallback. A refusal content block by itself does not trigger it. The plugin retries only when there is a supported route for that model and refusal category, the request fits the serving model, and the same OAuth account can send it without waiting. Anthropic can include a fallback credit with the refusal that lets the retry reuse the cached prefix. The plugin keeps the credit private. Without a credit, a retry can still go ahead, but cache writes can be billed normally.

Which models can serve a refused step, tried in this order:

| Requested model | Biology refusal | Cybersecurity refusal |
| --- | --- | --- |
| Fable 5, Fable 5.1, Fable 5.2 | Opus 5, then Opus 4.8 | Opus 4.8, then Opus 5 |
| Opus 5.5 | Opus 4.8, then Opus 5 | Opus 4.8, then Opus 5 |
| Opus 5 | Opus 4.8 | Opus 4.8 |

Other models (Opus 4.8, Sonnet, Haiku and Mythos) have no client fallback, and their refusals stand.

The plugin joins retry output to the current response, so the host does not start a separate step. If no retry can deliver content, the original refusal stands. For a still-current refusal after a completed tool call, the plugin instead finishes the step as `tool_use` without retrying. The completed call runs once, and its result goes with the next request. An unfinished call held from the refused attempt is not released to the host.

A successful retry counts as the first response of a round. If the round starts after a completed tool call instead, it starts with the next request and has its full length left. Rounds last **10, 20, then 40 completed responses** if refusals keep recurring, and never grow past 40. Ten consecutive clean primary responses on the requested model reset the next round to 10. The plugin returns to the requested model when the round ends; it can return early after a settings, account or model change, history compaction, or if the serving model can no longer take the request. Host notices and Status tell you the requested and serving models, the category and the number of steps left.

### Returning to the requested model

During a round, keep-warm still targets only the requested model's last accepted prefix, if the session is being kept warm. Each accepted primary step resets the warm budget without replacing that prefix. The serving model's cache is refreshed by the round's requests, not by keep-warm.

The next primary request returns to the requested model if the time since the last accepted round step exceeds the cache lifetime sent with that step: one hour or five minutes (five minutes if it had no cache marker). Before a deferred round serves its first step, the clock starts at the refusal that created it. Titles and compaction requests do not refresh that clock. An idle end advances the next round's length just like using all its steps.

When the first request back extends the kept prefix, it carries a cache marker at that prefix so Anthropic can read the cache again. A restart also ends the round; the requested model's saved prefix and warm budget can be restored and warmed normally.

On requests to the requested model, the plugin removes recorded fallback-model thinking wherever it follows that requested model's thinking in the same turn. It checks every turn, not only the latest one, and the record survives restarts. Pi and OpenCode 2 save the record on shutdown.

### Usage and billing

For a joined response, the host sees **only the serving model's usage**, including its input, output, cache-read and cache-write counters. The plugin merges the retry's starting and final usage so tools sizing the conversation do not count both attempts as one context. The refused attempt is reported separately in billing reports and logs; the host's joined usage is not a bill for both sends. Pi prices the joined step at the serving model's rates when available.

This differs from `server` mode, where Anthropic's top-level usage can include both attempts. See [server-mode per-attempt usage](request-rewriting.md#server-mode-per-attempt-usage) if you need the serving model's context size from a server-fallback step.
