# Features and host support

`@cortexkit/opencode-anthropic-auth` is the OpenCode 1/2 plugin and setup CLI, maintained as a fork of the original `@ex-machina/opencode-anthropic-auth` plugin. `@cortexkit/pi-anthropic-auth` is a native Pi extension: it replaces the implementation of Pi's built-in Anthropic provider while keeping its `anthropic` provider ID and model IDs. Both use `@cortexkit/anthropic-auth-core` for OAuth, account storage, quota, caching, relay and signing.

## Support matrix

| Capability | OpenCode | Pi |
| --- | --- | --- |
| Claude Pro/Max OAuth | Native pool shared by OpenCode 1 and 2 | Separate native pool |
| Claustrum vault accounts | Optional enrollment | Optional enrollment |
| Provider integration | OpenCode 1 fetch/request transform; OpenCode 2 registered provider source | `registerProvider("anthropic")` |
| Default pool | `~/.config/opencode/anthropic-auth-pool.json` | `~/.pi/agent/anthropic-auth-pool.json` |
| Legacy migration source | `~/.config/opencode/anthropic-auth.json` | `~/.pi/agent/anthropic-auth.json` |
| Accounts, routing, cache and diagnostics controls | `/claude` menu | `/claude` menu |
| Quota refresh and killswitch edits | Menu actions | Summary only; no killswitch edits |
| Prime quota-window scheduler | Status and on/off actions | Status and on/off actions |
| Lane start | Menu action | Not available |
| Quota sidebar | OpenCode 1 and OpenCode 2 TUI | Not available |
| Cloudflare relay | HTTP; OpenCode 1 also supports WebSocket | HTTP or WebSocket |

`~` is your home folder; on Windows it is `%USERPROFILE%`, so the default OpenCode pool is `%USERPROFILE%\.config\opencode\anthropic-auth-pool.json`. See [paths on each OS](environment.md#paths-on-windows-macos-and-linux).

[Setup](installation.md#recommended-setup) prepares the selected hosts and records which credential store they may use before sign-in. OpenCode 2 has its own [login and transport boundaries](opencode-2.md); OpenCode 1's host-local quota-feed publisher and deterministic client safety recovery are not OpenCode 2 features.

## What CortexKit adds over the original plugin

CortexKit adds account and request controls beyond OpenCode's or Pi's single built-in login:

- **Fallback accounts and quota-aware routing:** ordered OAuth accounts and API-key routes, minimum remaining-quota thresholds, and `sticky-balanced` session affinity. See [accounts](accounts-and-routing.md) and the [routing reference](configuration.md#fallback-accounts-and-session-affinity).
- **Cache controls:** explicit, automatic or hybrid prompt-cache placement, optional keepalive, and opt-in quota-window priming. [Cache controls](cache.md) explain the schedules and billed synthetic requests.
- **Quota visibility and limits:** per-account status, OpenCode quota refresh and killswitch thresholds, the quota sidebar, and OpenCode 1's optional sanitized [quota header feed](configuration.md#quota-header-feed).
- **Model controls:** adaptive reasoning summaries, effort levels, fast mode and OpenCode 1 safety fallback. See [models](models.md) and [safety fallback](request-rewriting.md#safety-fallback-opencode-1).
- **Optional custody and transport:** Claustrum is a local credential-vault service that can supply accounts instead of the local pool; a user-owned Cloudflare Worker can relay request bodies. See [vault custody](vault.md) and [transports](transports.md).
- **Claude-compatible request shaping:** identity and billing headers, final-body signing, tool replay and prompt-cache placement. See [request rewriting](request-rewriting.md#request-rewriting).

## What the integrations do

OAuth requests use the native pool or an enrolled vault. A host's fixed, non-secret activation marker only selects the plugin; it is never used as a credential. Local refresh, account state and request authorization belong to the native runtime. The plugin shapes outgoing requests for Claude OAuth and provides one `/claude` menu for account and request controls. Pi's provider replacement uses that same credential runtime without changing Pi's provider ID.

Implementation: [OpenCode 1](../packages/opencode/src/index.ts), [OpenCode 2](../packages/opencode/src/v2/setup.ts), [Pi](../packages/pi/src/index.ts), and [Pi menus](../packages/pi/src/commands.ts).
