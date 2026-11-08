# Cache, keepalive and quota priming

Prompt caching, cache keepalive and quota-window priming do different jobs. Enabling one does not enable the others, and synthetic requests can incur usage.

## Cache modes

Use `/claude` → **Cache** to enable caching and choose `claudeCache.mode`:

- `explicit`: use explicit prompt-cache placement.
- `automatic`: use automatic cache behavior.
- `hybrid`: combine placement strategies; CacheKeep tracks hybrid-cache sessions.

Cache settings do not reduce the complete input that Anthropic receives through a relay. A relay can send smaller patches between your machine and its Worker, but Anthropic still receives the reconstructed full request. Cache hits, not those smaller uploads, determine server-side cache benefits.

## CacheKeep

CacheKeep keeps recently used hybrid-cache sessions warm while their host process is running. Choose **Keep cache warm always**, **Cache keep window**, or **Disable cache keep** in the Cache menu. The window uses local hours; `always` remains active across midnight but stops after 24 warm attempts without an accepted real request. A real request resets that bound; warming and restarting do not. Subagent keepalive can be controlled separately.

About five minutes before a one-hour cache lifetime expires, CacheKeep sends a `max_tokens: 0` prewarm using the selected account. Checks are scheduled for the earliest target's due time, with a one-minute interval as a backstop. Due prewarms run one at a time, earliest safe-start deadline first. Failure preserves the known expiry and can schedule a bounded retry while the cache may still be alive. A [documented session registry](cachekeep-registry.md#cachekeep-session-registry) in the CortexKit data folder aggregates session/cache timing across processes without publishing request bodies, headers or tokens. Stopped sessions retain metadata until cache expiry; missing or stale leases mean unknown, not expired. Closing the host stops that process's keepalive work.

OpenCode 2 and Pi privately save accepted keep-warm targets across restarts. A restarted Pi head resumes warming its own session at session startup, even while idle and before any new request; a per-session process claim prevents duplicate warming. Only still-live caches on the same eligible login are restored. See the [private restart store](cachekeep-registry.md#location-and-permissions) for storage locations and ownership rules.

### Per-session runner policy

For OAuth sessions, Prefrontal can choose a prompt-cache lifetime (`none`, five minutes, or one hour) and `off | hours | always | auto` warming through Thalamus. For sessions launched through Thalamus, Prefrontal chooses `auto` unless it selects another warming mode; this does not change local defaults, menus or commands. The policy is read synchronously on each request. Without Thalamus, with an invalid policy, or with an omitted field, the corresponding local setting remains in force. In particular, a TTL-only policy does not turn local warming on or silently select `auto`. API-key routes keep their own settings and receive no runner cache reports.

Cache markers are `cache_control` fields on the request body or its content blocks; placement chooses which prefixes they mark as cacheable. Lifetime overrides preserve the host's selected explicit, automatic or hybrid placement and normalize every selected marker to that lifetime. `none` removes host-added markers as well. A policy may enable short/long caching even when local one-hour caching is off, but a lifetime with no eligible marker is reported as zero. A valid explicit warming mode overrides local hybrid/enabled and subagent opt-outs for that session only; replay still requires a safe captured prefix, the same eligible login and the existing 32-target / 64 MiB memory bounds. A refreshed policy cannot relabel an older replay: a conflicting lifetime/layout retires that target until a real request captures the new layout. A short TTL-only cache can expire before the unchanged local one-hour warm cadence; it is never stretched to fit that cadence.

| Runner mode | Warming rule |
| --- | --- |
| `off` | Do not warm; normal requests may still cache. |
| `hours` | Use the supplied minute-resolution `{from,to,tz}` window, including overnight windows. Start is inclusive and end exclusive. Stop with `outside-hours` if the next warm would fall outside it; do not wait until tomorrow. At most 24 reserved warm attempts since a real request. |
| `always` | No hours or idle-time cutoff, but the same 24-attempt bound, also for the local **Keep cache warm always** setting. |
| `auto` | Warm only while cumulative successful warm cost plus the next warm is strictly cheaper than recreating the prefix. Equality stops with `cost-cap`; there is no 24-count cap. Missing catalogue/usage facts use an idle bound of one hour for main sessions or 30 minutes for subagents, measured from the last accepted real request; the exact boundary is allowed, and exceeding it stops with `idle`. |

Priced `auto` uses cache-read rate × prefix tokens for the next warm and the applied lifetime's cache-write rate × prefix tokens for recreation. Prefix tokens are the last accepted response's cache-read plus cache-write usage, not uncached input: a warm replays the identical prefix. These amounts are carried in consistent micro-USD units (USD-per-million-token rate × tokens), so stored counters remain inspectable. Cost increases only after a successful warm. Planned warms are due 30 seconds before expiry, with a five-second final safety margin for supported lifetimes. The attempt timeout is limited to the remaining lifetime minus that margin; nothing starts inside it. Local warming keeps its existing cadence.

Count reservations happen before each physical attempt, including retries. Failed attempts retain their slot and can conservatively stop warming early. With restart persistence enabled, the reservation must commit immediately to an owner-only file before dispatch; a transient write failure skips that warm and can retry only before cache expiry. A durable-write refusal skips dispatch and rolls back the unsent in-memory reservation. Dispatched attempts keep their slot. The same private write records an unresolved dispatch's admitted cost; after a crash that cost counts as spent unless a failure was saved. A successful warm adds exactly its admitted cost, without changing the last real response's pricing baseline. If an unsafe folder disables the entire store for the process, the store neither writes nor restores there: warming stays memory-only and enforces all bounds, including the 24-warm-attempt cap, in memory. Legacy local `hours` keeps its existing memory-only behavior. Old records without the new bounds cannot start planned or `always` warming until a real request. After an in-process plugin reload onto a keep-warm manager retained in memory from a pre-policy plugin version, legacy warming continues through the older manager, using only the methods it has; planned warming needs the new reservation step that older manager lacks, so it waits for a server restart. Disabling local hybrid warming removes local targets immediately, but its one-per-transition restart-store sweep runs detached; requests and warm dispatches never await that bookkeeping.

### Runner reports and attribution limits

OpenCode 1, OpenCode 2 and Pi report `cache_touch` after each accepted ordinary OAuth response, even when warming is off or refused, and after each successful active-cache warm. Reports contain only `{kind:'cache_touch', at, ttl_ms, source}`: integer epoch milliseconds, the longest lifetime actually sent (`0`, `300000` or `3600000`), and `response | warm`. Without an override, reporting the longest of mixed markers tells the runner when every prefix can be gone. Reports are detached after host hand-off and never delay or block a response; a disconnected bridge, not auth, resends its newest failed touch before its next ordinary report. A touch estimates expiry, not a guaranteed cache hit.

`cache_warm_stopped` contains `{kind:'cache_warm_stopped', at, reason}` and is emitted only for a session that actually warmed. Reasons are exactly `cost-cap`, `count-cap`, `outside-hours`, `session-ended`, `unsupported`, `evicted`, `stopped`, `account-changed`, `expired` and `idle`. `count-cap`, not `idle`, describes the 24-attempt stop. `idle` is reserved for legacy/unpriced-auto idle limits. A policy refusal is `unsupported`; a disappeared/invalid previously applied runner plan is `session-ended`.

When content-filter recovery switches a session to Opus 4.8 temporarily, the original model's saved prefix can be warmed separately so it remains available when the session switches back. These source warms remain separate cache targets, with their own 24-attempt bound where applicable. Explicit `off` and `none` stop them too. Source warms do not move the active session's cache clock or emit its touch/stop reports: the shared report has no target/model attribution, so a source warm cannot establish the active model's cache lifetime. Prime remains separate and has no session cache reports.

## Prime and lane start

Prime is opt-in quota-window priming. The **Extras** group in OpenCode and Pi can enable or disable it and shows each account's next due time and last result. After a confirmed five-hour reset, Prime checks fresh quota and limits, then approximately one minute after reset can send a minimal `claude-haiku-4-5` request. Cross-process claims prevent duplicate priming for the same verified Claude account/reset, even when OpenCode and Pi (or two OpenCode installs) use separate account files. Accounts without a verified identity are deduplicated only within the same account storage. This is a real request, not a quota API trick or a guarantee of free usage. Prime is stateless: it creates neither a message thread nor a keep-warm target, and stops when the host shuts down.

OpenCode's **Fire lane start** is an explicit one-shot action. It inserts a visible synthetic lane-start marker and runs a one-token request through normal routing, custody, limits, cache shaping and transport. It is also billed usage; it neither enables Prime nor installs an automatic schedule. Pi does not expose lane start.

## Diagnostics and history analysis

Cache diagnostics are measure-only and require debug logging for their structured records. No records is not proof of no traffic. Use `/claude` → **Diagnostics** for logging and dumps; [dump handling](transports.md#diagnostics-and-dumps) explains the sensitive artifacts.

The repository's history analyzer reads an OpenCode SQLite database; unlike setup, it intentionally accesses a database. Run it from a repository checkout:

```sh
bun run analyze:cache -- --days 7
bun run analyze:cache -- --session ses_EXAMPLE
bun run analyze:cache -- --days 7 --json
bun run analyze:cache -- --db /path/to/disposable-opencode.db --days 7
```

`--idle-threshold-min` changes the idle-gap threshold used for estimates. These are retrospective estimates, not a billing oracle or proof that keepalive would have succeeded. Use a disposable copy for investigation rather than pointing test automation at a live host database.

See [accounts and quota](accounts-and-routing.md#quota-and-limits) for limits that can prevent warming, and [development](development.md#verification) for fixture-only test gates.
