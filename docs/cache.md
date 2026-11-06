# Cache, keepalive and quota priming

Prompt caching, cache keepalive and quota-window priming do different jobs. Enabling one does not enable the others, and synthetic requests can incur usage.

## Cache modes

Use `/claude` → **Cache** to enable caching and choose `claudeCache.mode`:

- `explicit`: use explicit prompt-cache placement.
- `automatic`: use automatic cache behavior.
- `hybrid`: combine placement strategies; CacheKeep tracks hybrid-cache sessions.

Cache settings do not reduce the complete input that Anthropic receives through a relay. A relay can send smaller patches between your machine and its Worker, but Anthropic still receives the reconstructed full request. Cache hits, not those smaller uploads, determine server-side cache benefits.

## CacheKeep

CacheKeep keeps recently used hybrid-cache sessions warm while their host process is running. Choose **Keep cache warm always**, **Cache keep window**, or **Disable cache keep** in the Cache menu. The window uses local hours; `always` remains active across midnight. Subagent keepalive can be controlled separately.

About five minutes before a one-hour cache lifetime expires, CacheKeep sends a `max_tokens: 0` prewarm through the selected account's custody path. Failure preserves the known expiry and can schedule a bounded retry while the cache may still be alive. A [documented session registry](cachekeep-registry.md#cachekeep-session-registry) in the CortexKit data folder aggregates session/cache timing across processes without publishing request bodies, headers or tokens. Stopped sessions retain metadata until cache expiry; missing or stale leases mean unknown, not expired. Closing the host stops that process's keepalive work.

## Prime and lane start

Prime is opt-in quota-window priming. OpenCode's **Extras** group can enable or disable it; Pi reports status only. After a confirmed five-hour reset, Prime checks fresh quota and limits, then approximately one minute after reset can send a minimal `claude-haiku-4-5` request. Cross-process claims prevent duplicate priming for the same account/reset. This is a real request, not a quota API trick or a guarantee of free usage.

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
