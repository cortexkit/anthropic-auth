# Settings and routing reference

## Settings

Plugin settings live in the host's local account pool, or in separate `anthropic-auth-vault-settings.json` while enrolled. Change settings with a `/claude` menu action where available. Setup imports supported preferences from the old sidecar once; editing a retired `anthropic-auth.json` does not change live settings. Do not copy credential or journal bytes into a settings example. See [configuration ownership](installation.md#configuration-ownership) and the [storage map](accounts-and-routing.md#local-storage).

The imported preference fields are listed below. Values such as quota thresholds and schedules are user choices, not a complete default configuration.

| Section | Fields / purpose |
| --- | --- |
| `routing` | `mode`: `main-first`, `fallback-first`, `sticky-balanced` |
| `fallbackOn` | Retryable OAuth fallback statuses; default `[401, 403, 429]` |
| `refresh` | `enabled`, `intervalMinutes`, `refreshBeforeExpiryMinutes` |
| `quota` | `enabled`, `checkIntervalMinutes`, `refreshEveryNRequests`, `minimumRemaining`, `failClosedOnUnknownQuota`, `showToasts` |
| `quotaHeaderFeed` | `enabled`: OpenCode 1 opt-in, disabled by default; restart required |
| `killswitch` | `enabled`, `main` thresholds and per-account `accounts` overrides |
| `claudeCache` | `enabled`, `mode`: `explicit`, `automatic`, `hybrid` |
| `cacheKeep` | `enabled`, `always`, `startHour`, `endHour`, `subagents` |
| `prime` | `enabled`: opt-in quota-window priming |
| `dump`, `logging` | `enabled` request dumps; `level`: `error`, `warn`, `info`, `debug`, `trace` |
| `claudeFast` | `enabled`: supported Opus fast mode |
| `thinkingBinding` | `prefixMismatchBehavior`: `account-default`, `error`, `drop_block` |
| `turnEndNote` | `tools`: host tool names for the reply-then-housekeeping note; default `["board", "ctx_reduce"]`, `[]` disables it |
| `costZeroing` | `enabled`: OpenCode OAuth price display, true by default |
| `relay` | `enabled`, `url`, `transport` (`http` / `websocket`; when missing, inferred from the URL: `wss://` uses `websocket`, `https://` uses `http`), `fallbackToDirect`; its token is private credential state |

[Cache](cache.md), [models](models.md) and [transports](transports.md) describe the effects. `quota.showToasts: true` opts into OpenCode quota notifications. Local credential state and per-account runtime metadata are separate from preferences; quota, profile, validation and Prime state are not all in the same file.

### Reply-then-housekeeping note

On OAuth routes for Fable 5.1, Opus 5.5, Sonnet 5.5 and Haiku 5.5, the plugin adds a turn-scoped system note after the results of an assistant's housekeeping calls when its visible reply is at least 350 characters and **all** its calls are in `turnEndNote.tools`. It asks Claude not to repeat the reply it already delivered. The 350-character minimum is a safety margin for short mid-work steps, not a configurable setting. Only non-whitespace text blocks count, joined without extra separators and measured as sent; thinking does not count. API-key routes, including API-key proxies, are unchanged.

Use the tool names the host calls, such as `board`, not the OpenCode wire spelling `mcp_Board`. For a custom list, set `"turnEndNote": { "tools": ["board", "my_cleanup"] }` in the live native settings; there is no menu control. An unset list uses `board` and `ctx_reduce`; an empty list turns the note off. Changing the list can change earlier notes, so keep it stable during a conversation to preserve prompt caching.

The plugin reconstructs every earlier qualifying note with identical text and placement on every request, independently of the current tool declarations. It does not add a cache breakpoint or effort configuration to the note. There is one exception: Anthropic rejects a note immediately followed by a user message, so the plugin omits just that note if the host appends a user message without an intervening assistant message. Bytes change at that point only; earlier notes are not moved or rewritten.

## Fallback accounts and session affinity

Fallbacks are separate OAuth accounts or Anthropic-compatible API-key routes in the active custody source. By default the main account is tried first, then eligible OAuth fallbacks in order. `fallback-first` reverses that preference. `sticky-balanced` assigns a new session using remaining quota above configured minimums in five-hour, seven-day and model-scoped windows.

The balanced allocator normalizes headroom by time until reset and accounts for the initial prompt before the next quota refresh. It persists the assignment by hashed session ID across processes and restarts. **Reset routing session** clears only the current session. A user-selected model change discards its old assignment; transparent safety recovery retains the account. Existing hybrid CacheKeep sessions can seed their warm route instead of changing accounts unnecessarily.

Affinity survives network/relay failures, 5xx responses, unconfirmed 429s, quota-probe failures and relative weight changes. Sticky-balanced holds the session on its account only when every exhausted window blocking the requested model has a known future reset and the latest reset plus deterministic per-session jitter fits before the session's same-account prompt cache expires. Cache lifetime comes from 1-hour caching in any mode (one hour when enabled, otherwise five minutes; unknown TTL uses five minutes), measured from the last accepted OAuth response or successful ordinary keep-warm prewarm. Keep-warm requests for the original model during a temporary safety fallback protect a different model's cache and do not extend the active session cache lifetime. Missing or different-account activity means no hold. `/claude` → **Routing** → **Longest wait on the same account** stores `routing.maxSameAccountWait`: **Don't wait** (`0`), **15 minutes** (`15`, default), or **Until the cache expires** (`max`). The selected wait budget also bounds eligibility. Five-hour, seven-day and the requested model's scoped limits are treated alike; another model's scoped limit does not count. Unknown, invalid or past blocking resets, or a reset beyond either bound, allow migration. OpenCode 1 returns `Retry-After`; Pi waits inside the plugin only for a known, fresh reset, with the local reset time in its working message, and Escape cancels immediately. Unknown or stale reset evidence causes an immediate non-retryable refusal, not a blind wait on the fallback retry hint. After the bounded wait it refreshes quota and rechecks admission and identity before a same-account resend, or rechecks all accounts after a pool refusal. If still blocked, it ends with a non-retryable error instead of asking Pi to retry. OpenCode 2 caps each hold at 15 minutes; with `max`, later retries can hold again against the original expiry, each consuming one of the host's ten retries. OpenCode 2 holds the same way after a 429: OpenCode waits that long, then retries on the same account, which keeps its pin. It does not hold after output has started, in a session that has used both the plugin's connection and another Anthropic credential, or when the account cannot serve the model during the wait (a model-scoped limit at zero, a configured minimum remaining quota (quota floor) or a killswitch block); those move. Disabled/removed accounts, permanent re-login failures and killswitch blocks can also cause reselection. Direct Opus sessions prefer usable accounts whose Fable quota is exhausted, preserving Fable-capable quota.

### API-key fallback

API-key routes are not part of balanced first assignment. They require confirmed **general** OAuth exhaustion, not just model-specific exhaustion, stale readings, low-but-nonzero quota, unconfirmed 429s, 401 or 403. A live quota check can confirm the exhaustion after a model response reports a rate limit. Requests must be safely replayable for a retry; an already-consumed/non-replayable body returns the original response unchanged.

Routes use `Authorization: Bearer <key>` by default, or `x-api-key` when selected. An Anthropic-compatible base such as `https://api.kie.ai/claude` gains `/v1/messages` without duplicating a versioned path. Keys remain in private pool state. OpenCode CLI `login`, `api add` and `list` manage only OpenCode's local pool; add Pi accounts through Pi's menu. OpenCode's account-writing CLI commands and Pi's account-addition actions refuse local changes while the corresponding host is enrolled in the Claustrum vault. See [CLI commands](commands.md#opencode-cli).

### Token refresh

Local refresh and its persisted retry delay are bound to the refresh-token generation, so a rejected token's backoff does not block a replacement sign-in. Re-login after a permanent `invalid_grant`; **Reset account backoff** clears the matching refresh and quota backoff. The plugin refreshes credentials in its account pool, never credentials from a separate login stored by OpenCode 1. OpenCode's own handling of that separate login is outside this plugin's refresh policy.

## Quota and killswitch

Quota routing compares **remaining** percentages. `five_hour` / `seven_day` accept menu aliases `5h` / `1w`. A killswitch floor is the minimum remaining percentage required to use an account. A positive five-hour or seven-day floor blocks requests on that account when its reading is missing, regardless of `quota.failClosedOnUnknownQuota`; without a positive floor, unknown readings follow that setting. A positive `scoped` floor requires a model-specific quota reading; an explicitly empty scoped list means no separate window applies. OpenCode offers the threshold edits in **Limits**; Pi does not.

## Quota header feed

The OpenCode 1 plugin can publish quota observations from Anthropic model-response headers; the feed does not independently poll the quota API. Enable `quotaHeaderFeed.enabled` and restart. Owner-only files under `opencode-anthropic-auth/quota-header-feed` in the [system temp folder](environment.md#paths-on-windows-macos-and-linux) (`$TMPDIR` or `/tmp` on macOS and Linux, `%TEMP%` on Windows) expire after three minutes; `OPENCODE_ANTHROPIC_AUTH_QUOTA_FEED_DIR` redirects them.

The allowlisted record contains quota-window values and provenance (which values came from response headers or quota polling), observation time, configured OAuth-account count and account identity references (including a resolved Anthropic account UUID when available). It does not contain tokens, raw headers, request bodies, model IDs or refresh errors. Treat the directory as local account metadata, not an anonymous public telemetry feed.

Implementation: [settings import whitelist](../packages/core/src/native-migration-source.ts), [native account view](../packages/core/src/native-account-view.ts), [sticky routing](../packages/core/src/sticky-routing.ts), [account policy](../packages/core/src/accounts.ts), [native credential runtime](../packages/core/src/native-account-runtime.ts), [quota feed](../packages/core/src/quota-header-feed.ts), and [OpenCode publisher](../packages/opencode/src/index.ts).
