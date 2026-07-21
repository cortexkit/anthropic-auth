# @cortexkit/pi-anthropic-auth

Pi package for CortexKit Anthropic OAuth support. It overrides Pi's built-in `anthropic` provider with a CortexKit provider extension backed by the shared `@cortexkit/anthropic-auth-core` package.

The Pi provider catalog includes Claude Fable 5 (`claude-fable-5`), limited-access Claude Mythos 5 (`claude-mythos-5`), Claude Opus 4.8, Claude Opus 4.5, Claude Sonnet 4.5, and Claude Sonnet 5 (`claude-sonnet-5`). Fable/Mythos reasoning uses Anthropic adaptive thinking with `thinking.display: "summarized"` and `output_config.effort`; the package does not send rejected manual `thinking.budget_tokens` for those models.

This package is part of the CortexKit Anthropic Auth monorepo, which supports both OpenCode (`@cortexkit/opencode-anthropic-auth`) and Pi (`@cortexkit/pi-anthropic-auth`) through the same shared core logic.

## Install

Install with Pi's package manager:

```bash
pi install npm:@cortexkit/pi-anthropic-auth@1.0.0
```

For an unpinned install:

```bash
pi install npm:@cortexkit/pi-anthropic-auth
```

To try it for one run without changing Pi settings:

```bash
pi -e npm:@cortexkit/pi-anthropic-auth
```

Restart Pi after installing, then authenticate through Pi's normal login flow:

```text
/login anthropic
```

## Sidecar config

Pi state is stored separately from OpenCode at:

```text
~/.pi/agent/anthropic-auth.json
```

Override the path with `PI_ANTHROPIC_AUTH_FILE`. The package also respects `PI_AGENT_DIR` when deriving the default sidecar path.

The sidecar uses the same JSON shape as the OpenCode package, including `routing`, `claudeCache`, `cacheKeep`, `prime`, `claudeFast`, `dump`, `relay`, and fallback `accounts` blocks. Runtime OAuth/quota state is stored in `anthropic-auth-state.json`; sticky session assignments are stored separately in `anthropic-auth-routing-state.json` with SHA-256-hashed session IDs.

## Commands

```text
/claude-cache
/claude-cache on
/claude-cache off
/claude-cache mode explicit
/claude-cache mode automatic
/claude-cache mode hybrid

/claude-cachekeep
/claude-cachekeep always
/claude-cachekeep 09-23
/claude-cachekeep off

/claude-prime
/claude-prime on
/claude-prime off

/claude-dump
/claude-dump on
/claude-dump off

/claude-fast
/claude-fast on
/claude-fast off

/claude-routing
/claude-routing main-first
/claude-routing fallback-first
/claude-routing sticky-balanced
/claude-routing reset

/claude-quota
```

`/claude-quota` reports sidecar OAuth fallback quota state from `~/.pi/agent/anthropic-auth.json`. `/claude-routing fallback-first` prefers usable OAuth fallback accounts before the main account; `/claude-routing main-first` restores the default. `/claude-routing sticky-balanced` assigns each Pi session to an OAuth account according to current 5-hour, 7-day, and matching model-scoped quota headroom, then persists that assignment across transient failures and process restarts. `/claude-routing reset` clears the current Pi session's assignment. Direct Opus sessions prefer usable accounts whose Fable quota is exhausted. API-key routes use the same sidecar shape as OpenCode and are sent directly to their configured Anthropic-compatible base URL, such as Kie's `https://api.kie.ai/claude`, but Pi only uses them after the main OAuth model response reports HTTP 429 or a streaming rate-limit error and a live quota check confirms 0% remaining. `/claude-cachekeep always` keeps active hybrid caches warm while Pi remains open; `/claude-cachekeep HH-HH` limits prewarms to a local time window. Both send `max_tokens: 0` pre-warm requests about five minutes before the 1-hour TTL expires. Running `/claude-cachekeep` without arguments lists live tracked sessions across Pi processes through a temporary lease registry that stores only session IDs and cache timing. `/claude-fast on` adds Anthropic `speed: "fast"` plus the `fast-mode-2026-02-01` beta header for supported Opus models (`claude-opus-4-6`, `claude-opus-4-7`, `claude-opus-4-8`, and `claude-opus-5`).

### Claude quota window priming

Priming is off by default. When enabled from OpenCode with `/claude-prime on`, it watches each OAuth account's 5-hour quota reset and sends one minimal `claude-haiku-4-5` request about one minute after a confirmed reset. This starts the next window without waiting for a normal prompt. Usage is measured from response accounting.

For an idle account with no cached reset time, one bootstrap request establishes the first observed window. Atomic temporary-file claims limit multiple processes sharing an account config to one request per account and reset.

Prime marker identities live in `anthropic-auth-state.json`. Plugin-owned refresh rotations preserve the main account's lineage, while a host credential replacement creates a new lineage. An existing main lineage without a refresh-token binding attaches to the current credential on its first check without changing identity. On upgrade, an existing fallback account receives an identity during its first prime check; that one-time marker change can send one extra request in the current window.

Pi's `/claude-prime` command displays status only. The `on` and `off` arguments are ignored; toggling priming requires OpenCode.

## Relay

The Pi package can use the same user-owned Cloudflare relay config as the OpenCode package. The relay setup helper currently lives in the OpenCode package CLI:

```bash
CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... bunx @cortexkit/opencode-anthropic-auth relay setup
```

For Pi, copy the generated `relay` block into `~/.pi/agent/anthropic-auth.json`.

## License

MIT
