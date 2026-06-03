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
| Commands | `/claude-cache`, `/claude-cachekeep`, `/claude-routing`, `/claude-fast`, `/claude-quota`, `/claude-dump` | `/claude-cache`, `/claude-cachekeep`, `/claude-routing`, `/claude-fast`, `/claude-quota`, `/claude-dump` |
| Quota sidebar widget | OpenCode TUI plugin via `tui.json` | Not available |
| Fallback accounts, quota routing, relay, dumps, fast mode | Supported | Supported through the same shared core and Pi sidecar |

## What CortexKit adds over the original plugin

- **Fallback Claude accounts**: keep each agent's normal Anthropic login as the primary account, then route to ordered fallback OAuth accounts on auth/quota/rate-limit failures.
- **Routing mode toggle**: use `/claude-routing fallback-first` to prefer sidecar fallback accounts before the main account.
- **Quota-aware routing**: skip main or fallback accounts when their 5-hour or 7-day Claude quota falls below your configured minimum.
- **Persistent Claude cache controls**: manage Anthropic 1-hour prompt caching from `/claude-cache` with explicit, automatic, or hybrid modes.
- **Cache keepalive**: use `/claude-cachekeep HH-HH` to pre-warm hybrid cache anchors for active sessions before the 1-hour TTL expires.
- **Fast mode toggle**: use `/claude-fast on|off` to request Anthropic fast mode for supported Opus models.
- **Live quota visibility**: use `/claude-quota` to see main and fallback quota state, reset times, and refresh errors.
- **Quota sidebar widget**: register the OpenCode TUI plugin in `tui.json` to render a live sidebar with per-account quota, routing, cache, and health state.
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
- Add `/claude-cache`, `/claude-cachekeep`, `/claude-fast`, `/claude-quota`, and `/claude-dump` commands.
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
    "failClosedOnUnknownQuota": true
  },
  "claudeCache": {
    "enabled": false,
    "mode": "explicit"
  },
  "cacheKeep": {
    "enabled": false,
    "startHour": 9,
    "endHour": 23
  },
  "dump": {
    "enabled": false
  },
  "claudeFast": {
    "enabled": false
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

The `routing` block controls `/claude-routing`, `claudeCache` controls `/claude-cache`, `cacheKeep` controls `/claude-cachekeep`, and `claudeFast` controls `/claude-fast`. The `main` field identifies OpenCode's primary auth entry; Pi keeps primary OAuth credentials in Pi's own credential store, but uses the same sidecar shape for CortexKit settings and fallback accounts.

## Fallback accounts

Fallback accounts are separate Claude OAuth accounts managed by this plugin. By default, the main account is tried first unless quota policy says it is currently unusable. Fallbacks are then tried in sidecar order when the primary request returns a configured fallback status.

Use `/claude-routing fallback-first` to prefer usable fallback accounts before the main account. Use `/claude-routing main-first` to restore the default. The command persists `routing.mode` and takes effect on the next request without restarting.

Default fallback statuses:

```json
[401, 403, 429]
```

Add and inspect OpenCode fallback accounts with the CLI:

```bash
bunx @cortexkit/opencode-anthropic-auth login personal-alt
bunx @cortexkit/opencode-anthropic-auth list
```

Prefer npm? Use `npx -y @cortexkit/opencode-anthropic-auth ...` with the same subcommands.

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

## Quota sidebar (OpenCode TUI)

OpenCode can render a live quota sidebar widget that surfaces plugin state without running a slash command. The widget is OpenCode-only; Pi has no TUI surface.

OpenCode loads TUI plugins from a separate `tui.json` (or `tui.jsonc`) file in your OpenCode config directory, not from the main `plugin` array. Register the package there:

```json
{
  "plugin": ["@cortexkit/opencode-anthropic-auth"]
}
```

Pinning is recommended, matching the main plugin entry:

```json
{
  "plugin": ["@cortexkit/opencode-anthropic-auth@1.0.0"]
}
```

After changing `tui.json`, restart OpenCode. Keep the version in `tui.json` in sync with the version in your main plugin config.

The sidebar polls plugin state and refreshes on OpenCode session and message events. It renders the following sections, styled with the active OpenCode theme tokens:

- **Quota** — per-account 5-hour and 7-day usage bars for the main account and each enabled fallback, with a status word (`active`, `blocked`, or `idle`) and the soonest reset time.
- **Routing** — the current route, standard/fast mode, and relay transport state.
- **Cache** — the 1-hour cache keepalive window and the number of tracked sessions, shown when cache keepalive is configured.
- **Health** — quota-API and token-refresh backoff countdowns. This section is hidden unless a backoff is active, and a `LIMITED` badge appears in the header.

Click the `CLAUDE` header to collapse or expand the sidebar. Collapsed, it shows the active account's 5-hour quota usage and a fast-mode row when fast mode is on; the header shows the plugin version (or a `LIMITED` badge when degraded). Collapse state is per-session and resets when OpenCode restarts.

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
- `hybrid` (recommended) removes top-level automatic caching and uses explicit anchors on the first two messages plus a moving latest-user boundary. It keeps the last stable system block in normal turns, and uses that slot for the previous user boundary when a tool-heavy step would exceed Anthropic's 20-block lookback.

In OpenCode, subagent requests do not receive 1-hour TTL caching. The plugin detects child sessions through OpenCode's `x-parent-session-id` header, strips that internal header before forwarding to Anthropic, and leaves default ephemeral caching in place for those requests.

### Cache keepalive

`/claude-cachekeep` keeps recently used hybrid-mode session caches warm while the agent process is running:

```text
/claude-cachekeep
/claude-cachekeep 09-23
/claude-cachekeep off
```

The hour range uses local 24-hour time and is start-inclusive/end-exclusive. `09-23` means cache keepalive may run from 09:00 until 22:59. Overnight windows such as `23-09` are accepted.

Cache keepalive only tracks requests when `/claude-cache` is enabled in `hybrid` mode. For each active session seen that day, the package keeps an in-memory clone of the latest rewritten Anthropic request and sends a non-streaming `max_tokens: 0` pre-warm request about five minutes before the 1-hour cache entry would expire. Nothing is written to disk except the schedule configuration.

Pre-warm requests preserve explicit cache anchors but remove response-only fields that Anthropic rejects with `max_tokens: 0`, such as streaming, enabled thinking, structured output format, and forced/any tool choice. The feature works only while OpenCode or Pi is running and the machine is awake, and cache writes are still billed when the cache entry is no longer warm.

## Claude fast mode

Both OpenCode and Pi packages can persistently request Anthropic fast mode for supported Opus models:

```text
/claude-fast
/claude-fast on
/claude-fast off
```

When enabled, supported requests add `speed: "fast"` to the Anthropic JSON body and include the `fast-mode-2026-02-01` beta header. Unsupported models are left at standard speed. Anthropic currently documents fast mode for `claude-opus-4-6`, `claude-opus-4-7`, and `claude-opus-4-8`.

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

Each request gets:

- `*.body.json` — final rewritten Anthropic request body.
- `*.relay.json` — redacted relay payload/frame metadata.
- `*.meta.json` — hashes, byte counts, diff ranges, model, `messages[0]` hash, later-message hash, and cache-relevant structure.

Dump state is persisted in the active sidecar config as `dump.enabled` (`~/.config/opencode/anthropic-auth.json` for OpenCode, `~/.pi/agent/anthropic-auth.json` for Pi). Dumps may contain prompt content and should be treated as sensitive local debugging artifacts.

## Environment variables

| Variable | Description |
| --- | --- |
| `ANTHROPIC_BASE_URL` | Override the Anthropic API endpoint. Must be HTTP(S). |
| `ANTHROPIC_INSECURE` | Set to `1` or `true` to skip TLS verification when `ANTHROPIC_BASE_URL` is set. |
| `OPENCODE_ANTHROPIC_AUTH_FILE` | Override the OpenCode sidecar config path. |
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
7. Computes final-body `cch` over the fully serialized request body.

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
./scripts/release.sh 1.8.0 --dry
```

Create and push the release tag:

```bash
./scripts/release.sh 1.8.0
```

Wait for GitHub Actions:

```bash
./scripts/wait-release.sh v1.8.0
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
