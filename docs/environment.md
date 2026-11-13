# Environment variables

## Paths on Windows, macOS and Linux

Path conventions depend on the artifact. In these docs:

- `~` is your home folder: `~` on macOS and Linux, `%USERPROFILE%` on Windows (for example `C:\Users\you`). So `~/.config/opencode/` is `%USERPROFILE%\.config\opencode\` on Windows, not `%APPDATA%`, and Pi's `~/.pi/agent/` is `%USERPROFILE%\.pi\agent\`. OpenCode keeps its own config and cache folders under the same rule.
- Shared user settings are different from the host's account paths: they live at `$HOME/.config/cortexkit/anthropic-auth.jsonc` on Linux and macOS, or `%APPDATA%\cortexkit\anthropic-auth.jsonc` on Windows. An absolute `XDG_CONFIG_HOME` takes precedence on every OS: `$XDG_CONFIG_HOME/cortexkit/anthropic-auth.jsonc`, or `%XDG_CONFIG_HOME%\cortexkit\anthropic-auth.jsonc` on Windows. See [both Windows locations and fallback rules](settings-file.md#location).
- `XDG_CONFIG_HOME`, `XDG_DATA_HOME` and `XDG_STATE_HOME` are used on every OS, Windows included. They are usually unset on Windows and macOS. Relative `XDG_CONFIG_HOME` values are ignored for shared settings.
- The system temp folder is the one Node's `os.tmpdir()` returns: `$TMPDIR` on macOS, `$TMPDIR` or else `/tmp` on Linux, and `%TEMP%` on Windows. A path written as `$TMPDIR/...` means that folder.
- To set a variable for one command, a POSIX shell (macOS, Linux, Git Bash) puts it before the command: `NAME=value npx ...`. In PowerShell, set it first with `$env:NAME = 'value'`, then run the command; it stays set until that PowerShell window closes.

## API endpoint and proxy routes

| Variable | Effect |
| --- | --- |
| `ANTHROPIC_BASE_URL` | Override the Anthropic endpoint with an HTTP(S) URL on API-key routes. Claude sign-in (OAuth) requests go only to `https://api.anthropic.com`, so OpenCode refuses them while this points elsewhere |
| `ANTHROPIC_INSECURE` | OpenCode 1 TLS opt-out: `1` or `true`, effective only with `ANTHROPIC_BASE_URL`; avoid outside controlled diagnostics |
| `ANTHROPIC_CUSTOM_HEADERS` | Add proxy metadata on API-key routes; ignored for OAuth |
| `ANTHROPIC_MODEL` | Default proxy alias for any `claude-*` model |
| `ANTHROPIC_DEFAULT_SONNET_MODEL` | Alias for `claude-sonnet-*` |
| `ANTHROPIC_DEFAULT_OPUS_MODEL` | Alias for `claude-opus-*` |
| `ANTHROPIC_DEFAULT_HAIKU_MODEL` | Alias for `claude-haiku-*` |
| `ANTHROPIC_DEFAULT_FABLE_MODEL` | Alias for `claude-fable-*` and `claude-mythos-*` |

Model aliases apply only to API-key/proxy routes; a family-specific alias takes precedence over `ANTHROPIC_MODEL`. OAuth requests retain their model identity and Claude Code headers.

`ANTHROPIC_CUSTOM_HEADERS` accepts a JSON object or comma/newline-separated `name: value` entries. Invalid or protected entries reject the entire configuration with a redacted warning. Authentication (`Authorization`, `x-api-key`), Anthropic protocol (`anthropic-beta`, `anthropic-version`), body-framing (such as `Content-Length`) and internal correlation headers (such as `x-session-affinity`) cannot be overridden.

Base URL paths are preserved: `https://proxy.example/anthropic` targets `/anthropic/v1/messages`; `https://proxy.example/anthropic/v2` targets `/anthropic/v2/messages`. Version segments are not duplicated; unrelated paths ending in `/messages` are not rewritten. See [transports](transports.md#proxy-routes).

## Storage, custody and host paths

A legacy sidecar is an old migration-source file. The native account files store account definitions, relay settings and quota metadata (pool), per-account metadata (runtime) and setup/migration authority (journal); see the [file map](accounts-and-routing.md#local-storage). Moved user settings live in the [shared JSONC file](settings-file.md), not those stores, except in legacy mode and [separate installs](settings-file.md#separate-installs). Sidebar preferences remain in `tui-preferences.jsonc`.

| Variable | Effect |
| --- | --- |
| `ANTHROPIC_AUTH_SETTINGS_FILE` | Absolute path to the shared user settings JSONC file for OpenCode 1, OpenCode 2 and Pi; empty or relative values are ignored and logged once. Opts into that file even with a host store override; the move reads only the acting host's resolved stores |
| `OPENCODE_ANTHROPIC_AUTH_FILE` | OpenCode legacy sidecar path; its directory determines native pool/runtime/journal paths |
| `PI_ANTHROPIC_AUTH_FILE` | Pi legacy sidecar path; its directory determines Pi's native paths |
| `OPENCODE_ANTHROPIC_AUTH_STATE_FILE` | Legacy credential-state source for migration; also used by legacy Pi source resolution |
| `OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE` | OpenCode owner-only enrollment-token path; the companion state path is derived beside it |
| `PI_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE` | Pi enrollment-token path and derived companion state path |
| `OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_CONNECTION_FILE` | OpenCode Claustrum connection file |
| `PI_ANTHROPIC_AUTH_CLAUSTRUM_CONNECTION_FILE` | Pi Claustrum connection file |
| `CLAUSTRUM_SUBC_CONNECTION` | Shared fallback connection-file override |
| `OPENCODE_ANTHROPIC_AUTH_ROUTING_STATE_FILE` | OpenCode local routing destination when initializing/migrating |
| `PI_ANTHROPIC_AUTH_ROUTING_STATE_FILE` | Pi local routing destination when initializing/migrating |
| `OPENCODE_CONFIG_DIR` | OpenCode config directory override |
| `OPENCODE_TUI_PREFERENCES_FILE` | Full path override for the optional shared `tui-preferences.jsonc` |
| `PI_CODING_AGENT_DIR`, `PI_AGENT_DIR` | Pi extension default storage directory, in that precedence order |
| `XDG_CONFIG_HOME` | Base for the default OpenCode config directory and, when absolute, the shared settings file at `cortexkit/anthropic-auth.jsonc` on every OS |
| `XDG_DATA_HOME` | Base for OpenCode's data directory used to resolve OpenCode 1 `auth.json` during setup, and for the [CacheKeep session registry and restart store](cachekeep-registry.md#location-and-permissions) |
| `XDG_STATE_HOME` | Base for default enrollment files, `cortexkit/anthropic-auth/<host>-enrollment.json`; otherwise `~/.local/state` (`%USERPROFILE%\.local\state` on Windows) |

A completed import records its routing destination in the journal; serving uses that recorded path rather than retroactively relocating it when an override changes. See [local storage](accounts-and-routing.md#local-storage). Pi SDK login-path resolution uses `PI_CODING_AGENT_DIR` (including home expansion), not the extension-only `PI_AGENT_DIR` fallback; the two are not interchangeable for host auth.

## Host behavior and diagnostics

| Variable | Effect |
| --- | --- |
| `OPENCODE_ANTHROPIC_AUTH_FALLBACK_MODE` | OpenCode 1: `legacy` skips Anthropic's server fallback and uses client safety recovery; default tries the server first, then client recovery |
| `OPENCODE_ANTHROPIC_AUTH_CONTENT_FILTER_FALLBACK` | OpenCode 2 wire policy: `legacy` disables its server-side fallback opt-in; it does not enable OC1's client recovery |
| `OPENCODE_ANTHROPIC_AUTH_CACHEKEEP_REGISTRY_DIR` | OpenCode 1 and 2 [CacheKeep session registry](cachekeep-registry.md#location-and-permissions) directory override |
| `PI_ANTHROPIC_AUTH_CACHEKEEP_REGISTRY_DIR` | Pi [CacheKeep session registry](cachekeep-registry.md#location-and-permissions) directory override |
| `OPENCODE_ANTHROPIC_AUTH_QUOTA_FEED_DIR` | OpenCode 1 quota-header-feed lease directory; publishing still requires `quota_header_feed_enabled` |
| `OPENCODE_ANTHROPIC_AUTH_RPC_DIR` | OpenCode TUI menu bridge's port/token directory; default is per-project under OpenCode state |
| `OPENCODE_ANTHROPIC_AUTH_PERF` | `1` enables structural request/relay/stream performance instrumentation |
| `CLAUDE_CODE_GZIP_REQUEST_BODIES` | Claude Code's own switch for [request-body gzip](transports.md#request-body-compression): `0` or `false` sends every OAuth body uncompressed; `1` or `true` gzips even behind a proxy, custom CA or client certificate, or while the seven-day latch is set; unset follows Claude Code's default |
| `HTTPS_PROXY`, `HTTP_PROXY` (and lower-case), `NO_PROXY` | A proxy that applies to `api.anthropic.com` turns request-body gzip off, as in Claude Code |
| `NODE_EXTRA_CA_CERTS`, `CLAUDE_CODE_CLIENT_CERT`, `CLAUDE_CODE_CLIENT_KEY` | A custom CA or a client certificate turns request-body gzip off, as in Claude Code |

The [sidebar guide](sidebar.md#tui-preferences), [quota feed](configuration.md#quota-header-feed), [safety fallback](request-rewriting.md#safety-fallback-opencode-1) and [dump guide](transports.md#diagnostics-and-dumps) explain scope and sensitive artifacts. The OpenCode TUI menu bridge accepts connections only from the local machine (`127.0.0.1`) and requires its bearer token.

## CLI inputs

| Variable | Effect |
| --- | --- |
| `OPENCODE_ANTHROPIC_AUTH_API_BASE_URL` | API fallback base URL for `api add` |
| `OPENCODE_ANTHROPIC_AUTH_API_KEY` | Secret API fallback key for `api add` |
| `OPENCODE_ANTHROPIC_AUTH_API_AUTH_HEADER` | `authorization-bearer` or `x-api-key` for `api add` |
| `CLOUDFLARE_API_TOKEN` | Token used to create/update the Cloudflare relay Worker with `npx @cortexkit/opencode-anthropic-auth relay setup`; not stored as relay settings |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account ID for relay setup |

Treat secret environment values as credentials; do not include them in logs or issue reports.

Implementation: [proxy headers](../packages/core/src/custom-headers.ts), [model remapping](../packages/core/src/model-remap.ts), [OpenCode endpoint handling](../packages/opencode/src/transform.ts), [host setup paths](../packages/opencode/src/setup/paths.ts), [native setup paths](../packages/opencode/src/setup/native-paths.ts), [Pi paths](../packages/pi/src/paths.ts), [enrollment paths](../packages/core/src/claustrum-enrollment.ts), [OpenCode 2 wire policy](../packages/opencode/src/v2/wire.ts), and [CLI inputs](../packages/opencode/src/cli.ts).
