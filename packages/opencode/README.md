# CortexKit Anthropic Auth for OpenCode and Pi

Claude Pro/Max OAuth support for both [OpenCode](https://opencode.ai) and [Pi](https://pi.dev), maintained by CortexKit.

This repo is a Bun workspace monorepo with two user-facing integrations and one shared core package. The OpenCode package is a CortexKit-maintained fork of the original `@ex-machina/opencode-anthropic-auth` plugin. The Pi package is a native Pi provider extension that overrides Pi's built-in Anthropic provider. Both integrations share the same Anthropic OAuth, fallback-account, quota, prompt-cache, relay, dump, and request-signing logic through `@cortexkit/anthropic-auth-core`.

## Packages

| Package | Agent | Purpose |
| --- | --- | --- |
| `@cortexkit/opencode-anthropic-auth` | OpenCode | OpenCode plugin and CLI for Claude OAuth, request rewriting, fallback accounts, quotas, cache controls, dumps, and relay setup. |
| `@cortexkit/pi-anthropic-auth` | Pi | Pi package/extension that registers a CortexKit Anthropic provider under Pi's built-in `anthropic` provider ID. |
| `@cortexkit/anthropic-auth-core` | Shared | Reusable OAuth, account, quota, cache, relay, dump, SSE, and request-signing logic used by both integrations. |

## Support matrix

| Capability | OpenCode | Pi |
| --- | --- | --- |
| Primary Claude Pro/Max OAuth | OpenCode `/connect anthropic` | Pi `/login anthropic` |
| Provider integration point | OpenCode plugin fetch/request transform | Pi `registerProvider("anthropic")` provider override |
| Sidecar config | `~/.config/opencode/anthropic-auth.json` | `~/.pi/agent/anthropic-auth.json` |
| Runtime state | `~/.config/opencode/anthropic-auth-state.json` | next to the Pi sidecar as `anthropic-auth-state.json` |
| Commands | `/claude-cache`, `/claude-cachekeep`, `/claude-prime`, `/claude-routing`, `/claude-fast`, `/claude-quota`, `/claude-dump`, `/claude-killswitch` | `/claude-cache`, `/claude-cachekeep`, `/claude-prime` (status only), `/claude-routing`, `/claude-fast`, `/claude-quota`, `/claude-dump` |
| Fallback accounts, quota routing, killswitch, relay, dumps, fast mode | Supported | Supported through the same shared core and Pi sidecar |

## What CortexKit adds over the original plugin

- **Fallback Claude accounts**: keep each agent's normal Anthropic login as the primary account, then route to ordered fallback OAuth accounts on auth/quota/rate-limit failures.
- **Routing modes**: use `/claude-routing sticky-balanced` to distribute cold sessions by current OAuth quota headroom while keeping each session on one account, or choose `main-first` / `fallback-first` ordering.
- **Quota-aware routing**: skip main or fallback accounts when their 5-hour or 7-day Claude quota falls below your configured minimum.
- **Persistent Claude cache controls**: manage Anthropic 1-hour prompt caching from `/claude-cache` with explicit, automatic, or hybrid modes.
- **Cache keepalive**: use `/claude-cachekeep always` or `/claude-cachekeep HH-HH` to pre-warm hybrid cache anchors for active sessions before the 1-hour TTL expires.
- **Quota window priming**: opt in with `/claude-prime on` to start each 5-hour quota window about one minute after it resets instead of waiting for the next normal prompt.
- **Fast mode toggle**: use `/claude-fast on|off` to request Anthropic fast mode for supported Opus models.
- **Adaptive reasoning visibility**: request summarized adaptive thinking for Claude Fable 5, Mythos 5, and Opus 5. OpenCode receives native `low`, `medium`, `high`, `xhigh`, and `max` Opus 5 effort variants rather than legacy manual-thinking budgets.
- **Fable/Opus 5 safety fallback**: eligible OAuth requests try Anthropic's server-side safety fallback first. The plugin preserves Anthropic's fallback conversation boundary across OpenCode history and automatically starts its deterministic 10-response Opus 4.8 recovery if the response still ends in refusal. The TUI sidebar and OpenCode Desktop report the active target model and restoration. Set `OPENCODE_ANTHROPIC_AUTH_FALLBACK_MODE=legacy` to bypass the server policy and use client-side recovery exclusively.
- **Live quota visibility**: use `/claude-quota` to see main and fallback quota state, reset times, and refresh errors.
- **Killswitch**: per-account hard-block thresholds that stop requests before hitting Anthropic's rate limits, with synthetic 429 retry-after when all accounts are exhausted.
- **User-owned Cloudflare relay**: optionally provision your own Worker relay to reduce repeated client upload bytes for large OpenCode or Pi requests.
- **Claude-compatible request hardening**: final-body billing signing, safer token refresh persistence, replay-safe fallback retries, and subagent cache isolation.

## What these integrations do

- Let OpenCode and Pi use Claude Pro/Max OAuth credentials instead of an Anthropic API key.
- In OpenCode, intercept the final Anthropic request and rewrite it into the Claude-compatible shape expected by Anthropic OAuth access.
- In Pi, replace Pi's built-in Anthropic provider with a CortexKit provider override that uses the same Claude-compatible request path.
- Add Claude billing headers with stable `cc_version` and body-derived `cch` signing.
- Support fallback Claude accounts stored in a local per-agent sidecar file.
- Keep fallback OAuth tokens fresh in the background.
- Apply quota thresholds before routing to main or fallback accounts.
- Add `/claude-cache`, `/claude-cachekeep`, `/claude-prime`, `/claude-fast`, `/claude-quota`, and `/claude-dump` commands.
- Optionally relay large requests through a Cloudflare Worker owned by the user.

## Install

### OpenCode

Add the OpenCode plugin to your OpenCode configuration:

```json
{
  "plugin": ["@cortexkit/opencode-anthropic-auth"]
}
```

Pinning is strongly recommended for any OpenCode plugin:

```json
{
  "plugin": ["@cortexkit/opencode-anthropic-auth@1.0.0"]
}
```

After changing plugin config, restart OpenCode.

> [!TIP]
> If OpenCode keeps using an old build, clear OpenCode's plugin cache with `rm -rf ~/.cache/opencode` and restart.

### Pi

Install the Pi package with Pi's package manager:

```bash
pi install npm:@cortexkit/pi-anthropic-auth@1.0.0
```

For an unpinned install:

```bash
pi install npm:@cortexkit/pi-anthropic-auth
```

To try it for one run without adding it to Pi settings:

```bash
pi -e npm:@cortexkit/pi-anthropic-auth
```

The Pi package registers a CortexKit Anthropic provider extension under Pi's built-in `anthropic` provider ID. After installation, start or restart Pi and authenticate with Pi's normal login command:

```text
/login anthropic
```

Pi package state lives separately from OpenCode in:

```text
~/.pi/agent/anthropic-auth.json
```

Override the path with `PI_ANTHROPIC_AUTH_FILE`. The package also respects `PI_AGENT_DIR` when deriving the default sidecar path.

## Primary account authentication

Each integration keeps the host agent's normal Anthropic login as the primary account.

For OpenCode, use OpenCode's Anthropic auth flow:

```text
/connect anthropic
```

The primary account remains OpenCode's built-in `anthropic` auth entry. The OpenCode plugin intercepts final Anthropic requests and supplies the OAuth headers and request transforms needed for Claude Pro/Max access.

OpenCode's upstream authentication options are still supported:

- Claude Pro/Max OAuth through `claude.ai`.
- Anthropic Console OAuth that creates an API key.
- Manually entered Anthropic API key.

For Pi, install the Pi package, restart Pi, then use Pi's Anthropic login flow:

```text
/login anthropic
```

The Pi package registers under Pi's built-in `anthropic` provider ID and stores primary OAuth credentials through Pi's normal credential flow. CortexKit package state, fallback accounts, cache mode, dump mode, and relay config live in the Pi sidecar file.

## Sidecar config

OpenCode package state lives in:

```text
~/.config/opencode/anthropic-auth.json
```

Override the OpenCode path with `OPENCODE_ANTHROPIC_AUTH_FILE`.

Pi package state uses the same JSON shape but a separate file:

```text
~/.pi/agent/anthropic-auth.json
```

Override the Pi path with `PI_ANTHROPIC_AUTH_FILE`.

Example:

```json
{
  "version": 1,
  "main": { "type": "opencode", "provider": "anthropic" },
  "fallbackOn": [401, 403, 429],
  "routing": {
    "mode": "main-first"
  },
  "refresh": {
    "enabled": true,
    "intervalMinutes": 10,
    "refreshBeforeExpiryMinutes": 240
  },
  "quota": {
    "enabled": true,
    "checkIntervalMinutes": 5,
    "minimumRemaining": {
      "five_hour": 10,
      "seven_day": 20
    },
    "failClosedOnUnknownQuota": true,
    "showToasts": false
  },
  "killswitch": {
    "enabled": false,
    "main": { "five_hour": 5, "seven_day": 10, "scoped": 0 },
    "accounts": {}
  },
  "claudeCache": {
    "enabled": false,
    "mode": "explicit"
  },
  "cacheKeep": {
    "enabled": false,
    "always": false,
    "startHour": 9,
    "endHour": 23
  },
  "dump": {
    "enabled": false
  },
  "claudeFast": {
    "enabled": false
  },
  "costZeroing": {
    "enabled": true
  },
  "relay": {
    "enabled": false,
    "url": "https://opencode-anthropic-relay.example.workers.dev",
    "token": "relay-shared-secret",
    "transport": "http",
    "fallbackToDirect": true
  },
  "accounts": []
}
```

The `routing` block controls `/claude-routing`, `claudeCache` controls `/claude-cache`, `cacheKeep` controls `/claude-cachekeep`, and `claudeFast` controls `/claude-fast`. OpenCode zeroes Anthropic OAuth model costs by default because OAuth usage is quota-based; set `costZeroing.enabled` to `false` only if you want OpenCode to display the provider's model pricing instead. Set `quota.showToasts` to `true` to opt into OpenCode quota toast notifications after quota refreshes. The `main` field identifies OpenCode's primary auth entry; Pi keeps primary OAuth credentials in Pi's own credential store, but uses the same sidecar shape for CortexKit settings and fallback account labels.

Runtime data is stored separately in `anthropic-auth-state.json`: fallback OAuth tokens, API-route keys, token refresh backoff, quota snapshots, and quota API backoff. Sticky session assignments use `anthropic-auth-routing-state.json` and store only SHA-256 hashes of session IDs. Background refresh and quota checks write only runtime state, so editing `anthropic-auth.json` does not get overwritten by another running plugin instance.

## Fallback accounts

Fallback accounts are separate Claude OAuth accounts or Anthropic-compatible API-key routes managed by this plugin. By default, the main account is tried first unless quota policy says it is currently unusable. Fallbacks are then tried in sidecar order when the primary request returns a configured fallback status.

Use `/claude-routing fallback-first` to prefer usable fallback accounts before the main account, `/claude-routing main-first` to restore the default, or `/claude-routing sticky-balanced` to allocate each new session according to spendable 5-hour, 7-day, and matching model-scoped OAuth quota headroom. The command persists `routing.mode` and takes effect on the next request without restarting. `/claude-routing reset` clears only the current session's assignment so its next request is allocated again.

`sticky-balanced` normalizes quota headroom by time until reset and tracks weighted initial-prompt deficit until the next quota refresh. Assignments are persisted by hashed session ID in `anthropic-auth-routing-state.json`, shared safely across OpenCode plugin instances and restarts. Active hybrid CacheKeep sessions seed their current route when the mode is first enabled.

Affinity survives network/relay failures, 5xx responses, unconfirmed 429s, quota-probe failures, and relative quota changes. Confirmed 7-day or matching model-scoped exhaustion migrates a session. Confirmed 5-hour exhaustion migrates only when more than 15 minutes remain; otherwise the plugin retains the route and returns `Retry-After`. Fable content-filter recovery keeps Fable, Opus 4.8, and Fable prewarms on the same sticky account. Direct Opus sessions first prefer an otherwise usable account whose Fable quota is exhausted.

Default fallback statuses:

```json
[401, 403, 429]
```

Add and inspect OpenCode fallback accounts with the CLI:

```bash
bunx @cortexkit/opencode-anthropic-auth login personal-alt
bunx @cortexkit/opencode-anthropic-auth api add kie-opus
bunx @cortexkit/opencode-anthropic-auth list
```

Prefer npm? Use `npx -y @cortexkit/opencode-anthropic-auth ...` with the same subcommands.

API fallback routes use `Authorization: Bearer <key>` by default and rewrite requests to the configured Anthropic-compatible base URL. For Kie, use `https://api.kie.ai/claude` as the base URL; the plugin appends `/v1/messages` automatically. API-key routes are only eligible after direct evidence that the main OAuth quota is exhausted: a fresh token-bound quota snapshot at 0% remaining, or an actual main OAuth model response with HTTP 429 / streaming rate-limit error followed by a live quota check that confirms 0% remaining. Low-but-nonzero quota, stale cached quota, unconfirmed 429s, 401, or 403 do not trigger API-key routes. API-route keys are stored in `anthropic-auth-state.json`, while `anthropic-auth.json` keeps the route label, type, enabled flag, base URL, and auth-header mode.

OpenCode cost accounting stays simple: when the native Anthropic auth entry is OAuth, OpenCode sees zero-cost Claude OAuth models by default. If a request falls through to an API-key route, token accounting is still recorded, but OpenCode's built-in dollar cost is not route-aware. Advanced users can set `costZeroing.enabled` to `false` to show Anthropic model pricing for OAuth sessions too.

For Pi fallback accounts, write the same account JSON shape to `~/.pi/agent/anthropic-auth.json`. The CLI helper currently lives in the OpenCode package, so you can also point it at Pi's sidecar path when logging in a fallback account:

```bash
OPENCODE_ANTHROPIC_AUTH_FILE="$HOME/.pi/agent/anthropic-auth.json" \
  bunx @cortexkit/opencode-anthropic-auth login personal-alt
```

Fallback retries are only attempted when the request body is safely replayable. If the original body is non-replayable or already consumed, the plugin returns the primary response unchanged.

### Token refresh

Fallback OAuth tokens refresh in the background so idle accounts do not expire before they are needed. Refresh token rotation is persisted immediately. The plugin also re-reads the latest sidecar account before refreshing, which avoids using stale refresh-token snapshots when multiple background paths run close together.

If Anthropic reports `invalid_grant`, that fallback account must be logged in again.

## Quota-aware routing

When `quota.enabled` is true, the plugin checks Anthropic's OAuth usage endpoint and applies the configured remaining-quota thresholds to both main and fallback accounts.

Example:

```json
"minimumRemaining": {
  "five_hour": 10,
  "seven_day": 20
}
```

With this config, an account is skipped when it has less than 10% remaining in the 5-hour window or less than 20% remaining in the 7-day window. The aliases `5h` and `1w` are also accepted.

Main-account quota is cached. If the main account is known to be exhausted, the plugin skips it until the relevant reset time. If the cached main quota is stale but usable, the request proceeds and quota refresh happens in the background.

Show current quota state:

```text
/claude-quota
```

In OpenCode, this includes the main Anthropic account and sidecar fallback accounts. In Pi, the command reports sidecar fallback account quota state from `~/.pi/agent/anthropic-auth.json`.

Reset times are rendered as relative durations, such as `resets in 10m` or `resets in 1h 15m`.

## Safety fallback

Eligible Fable 5 and Opus 5 OAuth requests try Anthropic's server-side safety fallback first. The plugin sends `fallbacks: "default"` with Anthropic's server-side fallback beta, preserves fallback conversation boundaries in OpenCode history, and reports model handoffs and restoration in the TUI sidebar or OpenCode Desktop. Follow-up requests may remain on Anthropic's selected fallback model for approximately one hour.

If an eligible OAuth response still ends in refusal, CortexKit automatically starts its deterministic 10-successful-response Opus 4.8 recovery, prewarms the selected source model without the server-fallback opt-in, and then restores that model. If the refused response already completed a tool call, the plugin preserves that call and continues with its existing tool result instead of replaying the tool.

Custom API-key routes do not receive the server-side fallback beta or request field.

To bypass Anthropic's server policy and use deterministic client recovery from the first refusal, start OpenCode with:

```bash
OPENCODE_ANTHROPIC_AUTH_FALLBACK_MODE=legacy opencode
```

Legacy mode routes a refused Fable 5 or Opus 5 session through Opus 4.8 for 10 successful responses, prewarms the selected source model's cache, and then restores that model without first opting into Anthropic's server policy. Unset the variable and restart OpenCode to return to the default server-first policy with the same client recovery as a backstop.

## Killswitch

The killswitch is a per-account hard-block that stops requests when remaining quota drops below configured thresholds, even if Anthropic's API would still accept them. Unlike `minimumRemaining` (which routes to fallback accounts), the killswitch removes accounts from the routing pool entirely.

Add a `killswitch` block to the sidecar config:

```json
"killswitch": {
  "enabled": true,
  "main": {
    "five_hour": 5,
    "seven_day": 10,
    "scoped": 0
  },
  "accounts": {
    "work-alt": {
      "five_hour": 10,
      "seven_day": 20,
      "scoped": 0
    }
  }
}
```

Thresholds are remaining-percent values. With `five_hour: 5`, the account is killed when less than 5% of the 5-hour quota window remains. The optional `scoped` threshold applies to matching model-scoped quota windows (for example Fable weekly quota) and blocks when the scoped remaining percent is at or below the threshold. Accounts without an entry in `accounts` fall back to the `main` thresholds. The aliases `5h` and `1w` are also accepted.

Behavior:

- When an account is killed, it is skipped during routing. Surviving accounts are tried instead.
- When all accounts (main and all enabled fallbacks) are killed, the plugin returns a synthetic 429 response with a `retry-after` header set to the earliest quota reset time across all accounts.
- On the first request after restart, the plugin eagerly fetches main quota so the killswitch evaluates immediately.
- `/claude-quota` shows killswitch status and per-account killed/active state.

Manage the killswitch from inside OpenCode:

```text
/claude-killswitch              — show status and command cheatsheet
/claude-killswitch on           — enable with current or default thresholds
/claude-killswitch off          — disable
/claude-killswitch set all:5,10 — set all accounts to 5h≥5%, 1w≥10%
/claude-killswitch set main:3,8,0 — set main to 5h≥3%, 1w≥8%, scoped≤0%
/claude-killswitch set main:3,8,0 work-alt:5,10,0 — per-account thresholds
```

Changes made with `/claude-killswitch` are persisted to the sidecar config.

## Claude prompt cache control

Both OpenCode and Pi packages add a slash command for Anthropic's 1-hour ephemeral prompt-cache TTL:

```text
/claude-cache
/claude-cache on
/claude-cache off
/claude-cache mode explicit
/claude-cache mode automatic
/claude-cache mode hybrid
```

Without arguments, `/claude-cache` shows the current setting.

Modes:

- `explicit` keeps OpenCode's explicit cache breakpoints and adds `ttl: "1h"` to them.
- `automatic` removes block-level cache controls and sends a top-level `cache_control` object.
- `hybrid` (recommended) removes top-level automatic caching and uses explicit anchors for Magic Context's leading history plus a moving latest-user boundary. When the first message has multiple cacheable content blocks, hybrid anchors both the first and last block so a stable leading history block remains cached even if a volatile trailing block changes; otherwise it anchors the first two messages. It keeps the last stable system block in normal turns, and uses that slot for the previous user boundary when a tool-heavy step would exceed Anthropic's 20-block lookback.

In OpenCode, subagent requests do not receive 1-hour TTL caching. The plugin detects child sessions through OpenCode's `x-parent-session-id` header, strips that internal header before forwarding to Anthropic, and leaves default ephemeral caching in place for those requests.

### Cache keepalive

`/claude-cachekeep` keeps recently used hybrid-mode session caches warm while the agent process is running:

```text
/claude-cachekeep
/claude-cachekeep always
/claude-cachekeep 09-23
/claude-cachekeep off
```

`always` keeps tracked sessions warm continuously for as long as the OpenCode process remains open. Hour ranges use local 24-hour time and are start-inclusive/end-exclusive: `09-23` runs from 09:00 until 22:59, and overnight windows such as `23-09` are accepted.

Cache keepalive only tracks requests when `/claude-cache` is enabled in `hybrid` mode. For each active session seen in the configured schedule, the package keeps an in-memory clone of the latest rewritten Anthropic request and sends a non-streaming `max_tokens: 0` pre-warm request about five minutes before the 1-hour cache entry would expire. Running `/claude-cachekeep` without arguments lists every live tracked session across OpenCode projects and plugin processes.

Request bodies, headers, and tokens remain in memory. A lease-backed file under the system temporary directory shares only session IDs and cache timing for cross-instance status; records from stopped processes disappear from status after about three minutes.

Pre-warm requests preserve explicit cache anchors but remove response-only fields that Anthropic rejects with `max_tokens: 0`, such as streaming, enabled thinking, structured output format, and forced/any tool choice. The feature works only while OpenCode or Pi is running and the machine is awake, and cache writes are still billed when the cache entry is no longer warm.

## Claude quota window priming

Quota-window priming is off by default. OpenCode controls it with:

```text
/claude-prime
/claude-prime on
/claude-prime off
```

When enabled, the plugin watches each OAuth account's 5-hour quota reset. About one minute after a confirmed reset, it sends one minimal `claude-haiku-4-5` request so the next window starts without waiting for a normal prompt. Usage is measured from response accounting.

Scheduled fires happen only after the quota window has reset. If an idle account has no cached reset time, the plugin sends one bootstrap request to establish its first observed window. Atomic temporary-file claims ensure that multiple OpenCode processes sharing the same account config send only one request per account and reset.

Prime marker identities live in `anthropic-auth-state.json`. Plugin-owned refresh rotations preserve the main account's lineage, while a host credential replacement creates a new lineage. An existing main lineage without a refresh-token binding attaches to the current credential on its first check without changing identity. On upgrade, an existing fallback account receives an identity during its first prime check; that one-time marker change can send one extra request in the current window.

Pi exposes `/claude-prime` as a status-only command. Its `on` and `off` arguments are ignored; enable or disable priming from OpenCode.

### Cache diagnostics (beta)

The `cache-diagnosis-2026-04-07` beta is measure-only. It asks Anthropic to report prompt-cache diagnostics; it does not change cache controls or routing. OpenCode captures the provider's top-level response ID as an opaque string and sends it as `diagnostics.previous_message_id` on the next request in the same session. The first request sends `null`.

The `MC-CACHE-DIAG ` line is a versioned, one-line JSON record. Records and their beta side-channel are emitted only at debug level; use `/claude-logging debug` to capture them. Because emission is gated on the runtime log level, an empty record stream is ambiguous between a quiet system and a level below debug — liveness checks must cross-reference an independent activity witness (billing, usage rows, or dumps) instead of reading silence as absence of cache traffic. Version `2` contains these fields:

| Field | Type | Source |
| --- | --- | --- |
| `v` | `2` | Capture schema |
| `source` | string | Observation path; known values are `"turn"` and `"prewarm_cachekeep"`, but consumers must tolerate future values |
| `synthetic` | boolean | Whether this observation was generated by plugin machinery rather than a real turn |
| `account_id` | string | Persisted plugin-internal OAuth account identifier used by routing and the sidebar; stable across restarts and token refreshes, so consumers may key timelines on it. Opaque mixed key space (the main account is a sentinel string, fallbacks are UUIDs) — never validate its shape |
| `betas_hash` | 16-character lowercase hex | xxHash64 (seed `0`) of the sorted `anthropic-beta` list actually sent, truncated to its first 16 hexadecimal characters |
| `requested_model` | string, optional | Sent request-body model, present only when it differs from the served Anthropic response model |
| `session_id` | string | OpenCode session affinity |
| `ts_ms_received` | integer | Local response receipt time |
| `model` | string | Anthropic response |
| `is_subagent` | boolean | Original request context |
| `ttl_sent` | `"1h" \| "5m" \| null` | Last valid cache breakpoint in the sent body |
| `cache_read` | number | `usage.cache_read_input_tokens` |
| `cache_creation` | number | `usage.cache_creation_input_tokens` |
| `input_tokens` | number | `usage.input_tokens` |
| `ephemeral_5m_tokens` | number | `usage.cache_creation.ephemeral_5m_input_tokens` |
| `ephemeral_1h_tokens` | number | `usage.cache_creation.ephemeral_1h_input_tokens` |
| `message_id` | string | Anthropic response top-level `id` |
| `previous_message_id` | string \| null | Sent `diagnostics.previous_message_id` |
| `diag_state` | `"absent" \| "server_null" \| "pending" \| "populated"` | Anthropic response envelope |
| `miss_reason` | string, optional | `diagnostics.cache_miss_reason.type` |
| `cache_missed_input_tokens` | number, optional | `diagnostics.cache_miss_reason.cache_missed_input_tokens` |

`cache_missed_input_tokens` is a byte-derived, pre-tokenization magnitude indicator, not a token count: it can differ from and occasionally exceed `input_tokens`, so never difference it against usage fields.

All required usage counters must be finite, non-negative numbers. A malformed required counter rejects the whole record rather than emitting a partial receipt.

Consumers classifying these records should check `cache_read` before `miss_reason`: `cache_read > 0` is a fact and `miss_reason` is an interpretation, and facts win. On multi-turn agent traffic a populated `*_changed` reason routinely coexists with a full prefix hit (each turn appends messages), so a populated-first classifier inverts every such record into a false miss.

Known sources map to `synthetic` as follows:

| `source` | `synthetic` |
| --- | --- |
| `turn` | `false` |
| `prewarm_cachekeep` | `true` |

`synthetic` wins on conflict. A disagreement for a known source is an emitter defect: OpenCode writes one warning and still emits the record with the supplied `synthetic` value. Unknown future sources have no mapping and must not be rejected by consumers.

The first observation of each `betas_hash` in a process also writes `MC-CACHE-DIAG-BETAS {"hash":"…","betas":[…]}` at debug level on the `cache-diagnostics` logger channel. Its sorted beta list makes an observed hash interpretable without reconstructing headers; repeated hashes do not emit another side-channel line.

The trailing space in `MC-CACHE-DIAG ` is load-bearing: a record line has a space after `MC-CACHE-DIAG`, while the beta side-channel line has a hyphen. Do not trim the delimiter or write a trimming consumer. `grep -c "MC-CACHE-DIAG"` over-counts because it includes beta lines; count records with `grep -c "MC-CACHE-DIAG "` or an anchored equivalent.

The four diagnostic states are:

| State | Response shape |
| --- | --- |
| `absent` | No `diagnostics` property |
| `server_null` | `diagnostics: null` |
| `pending` | `diagnostics.cache_miss_reason: null` |
| `populated` | An object `diagnostics.cache_miss_reason` with a non-empty string `type`, including `"unavailable"` |

Only valid Message envelopes produce an `MC-CACHE-DIAG ` record. Malformed or error responses are not mapped to `absent`; they retain ordinary response handling and dumps. `ttl_sent` is reduced from the last valid breakpoint in the actual body sent. A short-gap `previous_message_not_found` result is also recorded as a canary when the previous provider ID was captured less than five minutes earlier.

`unavailable` is expected when any prompt-affecting parameter changes between requests. This includes the active Anthropic beta-header set; structured-output requests use a different beta set and can therefore produce `unavailable`. Diagnostics are scoped to the provider's cache fingerprint, organization, and workspace. Fingerprints expire, so a later request can miss after a long gap even when the body is unchanged. These records measure the result; they do not guarantee a cache hit.

Diagnostics comparison requires a cacheable prefix. Requests below the model's cacheable minimum or without cache breakpoints return `diagnostics: null` even when the request genuinely changed; consumers must gate interpretation of `null` on observed cache activity.

`diag_state` is always a string and never JSON null: `absent | server_null | pending | populated`.

Version 1 records come from the unversioned-source era and cannot distinguish prewarms from turns; consumers must treat their source as unknown and cannot split machinery from traffic retroactively. Version 2 always states the source.

When request dumps are enabled, each response gets a `.response.json` artifact containing status and parsed response metadata, but no response content. Cache keepalive prewarms are tagged `-prewarm-cachekeep` in dump filenames and metadata. If Prime prewarming is enabled in a build that supports it, those artifacts use `-prewarm-prime`. Treat request bodies and related dump files as sensitive local debugging data.

## Claude fast mode

Both OpenCode and Pi packages can persistently request Anthropic fast mode for supported Opus models:

```text
/claude-fast
/claude-fast on
/claude-fast off
```

When enabled, supported requests add `speed: "fast"` to the Anthropic JSON body and include the `fast-mode-2026-02-01` beta header. Unsupported models are left at standard speed. Anthropic currently documents fast mode for `claude-opus-4-6`, `claude-opus-4-7`, `claude-opus-4-8`, and `claude-opus-5`; Claude Fable 5 and Mythos 5 are not fast-mode models.

Fast and standard speeds do not share prompt-cache prefixes, so switching this setting can cause cache misses.

### Estimate cache savings from OpenCode history

The repo includes an OpenCode SQLite analyzer that compares estimated Claude cost under three scenarios: no prompt cache, Anthropic's default 5-minute cache, and this plugin's 1-hour cache mode.

From a repo checkout:

```bash
bun run analyze:cache -- --days 7
```

Useful variants:

```bash
# Restrict to one OpenCode session
bun run analyze:cache -- --session ses_... --days 4

# Emit machine-readable output
bun run analyze:cache -- --days 7 --json

# Use a non-default OpenCode DB path
bun run analyze:cache -- --db ~/.local/share/opencode/opencode.db --days 30
```

The script reads OpenCode usage data from `~/.local/share/opencode/opencode.db` by default. It uses recorded prompt, cache-read, cache-write, and output tokens, then estimates counterfactual 5-minute and no-cache costs from the same turns. Its pricing table includes Claude Opus 4.5 through 4.8. The default 5-minute expiry threshold is 5 minutes; override it with `--idle-threshold-min <minutes>` if needed.

This analyzer is OpenCode-specific because it reads OpenCode's local message database.

## Optional Cloudflare relay

The relay is opt-in and user-owned. CortexKit does not run shared relay infrastructure for this plugin.

When enabled, the package sends large Anthropic request bodies to a Cloudflare Worker that you own. The first request for a session sends a full body; later requests send compact patches keyed by session affinity (`x-session-affinity` in OpenCode, Pi's stream `sessionId` in Pi). The Worker reconstructs the full Anthropic `/v1/messages` request and streams Anthropic's SSE response back to the client.

New relay setups default to HTTP transport:

```json
"transport": "http"
```

HTTP is the safest release default and still sends compact full-sync/patch payloads through your Worker. WebSocket is available as an opt-in persistent session transport:

```json
"transport": "websocket"
```

WebSocket mode uses protocol v2 on `/ws`, keeps one connection per OpenCode `x-session-affinity`, and serializes same-session requests until the previous stream finishes. Existing deployed Workers must be redeployed with this package's current Worker script before `"transport": "websocket"` will work; older relay Workers only understand the legacy protocol.

Set up a relay in your Cloudflare account with the OpenCode package CLI:

```bash
CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... bunx @cortexkit/opencode-anthropic-auth relay setup
```

Or with npm:

```bash
CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... npx -y @cortexkit/opencode-anthropic-auth relay setup
```

The setup command:

1. Creates a Cloudflare KV namespace.
2. Uploads the relay Worker module.
3. Generates a relay shared secret.
4. Enables the Worker.
5. Writes the local `relay` block to `~/.config/opencode/anthropic-auth.json`.

For Pi, copy the generated `relay` block into `~/.pi/agent/anthropic-auth.json` if you want the Pi package to use the same user-owned Worker.

The Cloudflare API token is used only during setup and is not stored by the plugin. Re-running setup with the same Worker name uploads the current Worker script again; this is how existing relay Workers are upgraded for protocol changes such as WebSocket v2.

If relay setup or transport fails before streaming begins, the plugin falls back to direct Anthropic requests unless `fallbackToDirect` is set to `false`.

> [!NOTE]
> The relay reduces upload bytes from your machine to Cloudflare. Anthropic still receives the complete `/v1/messages` request from the Worker, so the relay does not reduce Anthropic input tokens or billing by itself. Use prompt caching for server-side cache benefits.

### Relay diagnostics

Relay diagnostics are written to a temp-file log:

```bash
tail -f "$(node -p 'require("node:os").tmpdir()')/opencode-anthropic-auth.log"
```

Successful relay usage logs entries such as:

```text
configured transport=websocket protocol=2
used relay transport=websocket protocol=2 mode=patch
used relay transport=http protocol=1 mode=full_sync
```

Direct fallback logs `falling back direct`.

### Request dumps

For relay/cache debugging, enable exact request dumps from inside OpenCode or Pi:

```text
/claude-dump on
/claude-dump off
/claude-dump
```

When enabled, the plugin writes artifacts under the OS temp directory:

```bash
ls "$(node -p 'require("node:os").tmpdir()')/opencode-anthropic-auth-dumps"
```

Each filename includes a sanitized session/affinity segment so dumps from different sessions are easier to find. Each request gets:

- `*.body.json` — final rewritten Anthropic request body.
- `*.meta.json` — hashes, byte counts, diff ranges, model, `messages[0]` hash, later-message hash, and cache-relevant structure.
- `*.relay.json` — redacted relay payload/frame metadata for relay requests.
- `*.request.json` — redacted direct request URL, method, and headers for direct requests.

Dump state is persisted in the active sidecar config as `dump.enabled` (`~/.config/opencode/anthropic-auth.json` for OpenCode, `~/.pi/agent/anthropic-auth.json` for Pi). Dumps may contain prompt content and should be treated as sensitive local debugging artifacts.

## Environment variables

| Variable | Description |
| --- | --- |
| `ANTHROPIC_BASE_URL` | Override the Anthropic API endpoint. Must be HTTP(S). |
| `ANTHROPIC_INSECURE` | Set to `1` or `true` to skip TLS verification when `ANTHROPIC_BASE_URL` is set. |
| `OPENCODE_ANTHROPIC_AUTH_FILE` | Override the OpenCode sidecar config path. |
| `OPENCODE_ANTHROPIC_AUTH_FALLBACK_MODE` | Set to `legacy` to bypass Anthropic's server policy and use deterministic 10-response client recovery exclusively. The default tries server-side safety fallback first and uses client recovery as a backstop. |
| `PI_ANTHROPIC_AUTH_FILE` | Override the Pi sidecar config path. |
| `PI_AGENT_DIR` | Override Pi's agent directory when deriving the default sidecar path. |
| `CLOUDFLARE_API_TOKEN` | Cloudflare token used by `bunx @cortexkit/opencode-anthropic-auth relay setup`. Not stored. |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account ID used by relay setup. |

## Request rewriting

For Claude Pro/Max OAuth requests, the plugin works at the final Anthropic wire-request layer:

1. Rewrites request URLs when `ANTHROPIC_BASE_URL` is configured.
2. Normalizes Claude-compatible OAuth headers and beta flags.
3. Removes OpenCode-specific identity text from system blocks.
4. Prepends Claude Code identity and billing-header blocks.
5. Rewrites cache controls according to `/claude-cache` mode.
6. Renames MCP tool names into Claude-compatible PascalCase form.
7. Opts eligible Fable 5 and Opus 5 OAuth requests into Anthropic's server-side safety fallback, restores stored fallback boundaries, and activates replay-safe client recovery if the response still refuses.
8. Computes final-body `cch` over the fully serialized request body.

The sanitizer is anchor-based: it removes paragraphs containing known OpenCode documentation or source anchors, performs a small set of inline replacements, and preserves the rest of the prompt including user/project instructions, tool policy, environment context, and file paths.

## Development

Workspace layout:

```text
packages/core      Shared Anthropic auth core
packages/opencode  OpenCode plugin and CLI
packages/pi        Pi package/extension
```

Install dependencies:

```bash
bun install
```

Run checks:

```bash
bun run typecheck
bun run test
bun run build
bun run lint
bun run format:check
```

### Build modes

Two build modes are available:

```bash
bun run build      # Deploy: bun build → bundled dist/ with all deps inlined (core + xxhash-wasm)
bun run build:dev  # Dev: tsc → individual dist/*.js files (requires workspace node_modules)
```

The default `build` uses `bun build` to bundle `@cortexkit/anthropic-auth-core` and all transitive dependencies into self-contained output files. No `node_modules/` needed at runtime — the plugin works via `file://` path in OpenCode config:

```json
{
  "plugin": ["file:///path/to/anthropic-auth/packages/opencode"]
}
```

`@opencode-ai/plugin` remains external (peer dep provided by OpenCode).

Inspect package contents:

```bash
bun run pack:core:dry
bun run pack:opencode:dry
bun run pack:pi:dry
```

Test a local build with OpenCode:

```bash
bun run dev
```

This builds the plugin, symlinks the output into `.opencode/plugins/`, and starts `tsc --watch`. Restart OpenCode after starting the dev script and after rebuilds.

Clean the local dev symlink with:

```bash
bun run dev:clean
```

## Release

This repo uses CortexKit's tag-driven release workflow.

Preview a release:

```bash
./scripts/release.sh 1.9.0 --dry
```

Create and push the release tag:

```bash
./scripts/release.sh 1.9.0
```

Wait for GitHub Actions:

```bash
./scripts/wait-release.sh v1.9.0
```

The release workflow runs checks, publishes the core, OpenCode, and Pi packages to npm with provenance, and creates the GitHub release.

## Troubleshooting

- Clear OpenCode's plugin cache after plugin config changes: `rm -rf ~/.cache/opencode`.
- Restart OpenCode or Pi after changing sidecar config; some settings are loaded at startup.
- If an OpenCode fallback account shows `invalid_grant`, run `bunx @cortexkit/opencode-anthropic-auth login <label>` again for that account.
- Tail relay diagnostics when debugging relay setup: `tail -f "$(node -p 'require("node:os").tmpdir()')/opencode-anthropic-auth.log"`.
- Use `/claude-quota` to inspect quota and refresh errors surfaced by the plugin.

## License

MIT
