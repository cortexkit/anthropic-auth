# Transports and request diagnostics

Direct requests are the default. An optional user-owned Cloudflare Worker relay reduces upload bytes by sending a full body initially and session-affine patches afterwards; the Worker reconstructs the complete Anthropic request. CortexKit does not operate a shared relay, and relay compression does not reduce Anthropic input tokens by itself.

## Relay

Prepare OpenCode's local pool with [setup](installation.md#recommended-setup) before saving relay settings. Provision a Worker in your Cloudflare account with the CLI:

```sh
CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... \
  npx @cortexkit/opencode-anthropic-auth relay setup
```

In PowerShell on Windows:

```powershell
$env:CLOUDFLARE_API_TOKEN = '...'; $env:CLOUDFLARE_ACCOUNT_ID = '...'
npx @cortexkit/opencode-anthropic-auth relay setup
```

If either variable is unset, the command asks for it.

This creates a KV namespace, uploads/enables the Worker, generates a relay shared secret and saves the URL, secret and HTTP transport in OpenCode's local settings. The Cloudflare API token is used for provisioning, not stored by the plugin. Keep it and the relay secret out of reports. This command does not configure Pi: Pi's existing relay settings can be imported from its legacy `anthropic-auth.json` during Pi migration. `/claude` has no relay actions.

`relay.transport` is `http` by default. A missing transport is inferred from the URL: `wss://` (or `ws://`) uses WebSocket, `https://` (or `http://`) uses HTTP. A stored `transport` always wins over the URL. WebSocket is opt-in for OpenCode 1 and Pi, uses protocol v2 on `/ws` and requires the current Worker deployment. Redeploy an existing Worker with the same Worker name when upgrading its protocol. OpenCode 2 supports direct and HTTP only and refuses a selected WebSocket relay before dispatch.

The OpenCode 1 sidebar shows the relay and its transport only when requests can use it: relay enabled, with a URL and a stored relay secret. Without the secret, requests go direct and the sidebar shows no relay. A shown relay can still fall back to direct for a single request when the relay fails.

`relay.fallbackToDirect` allows direct fallback on relay failures before streaming; set it to `false` if direct dispatch is not acceptable. Genuine upstream authorization failures and relay failures have different provenance; a relay's own 401 must not invalidate a Claude account. Vault mode still authorizes each physical send through the vault.

## Request-body compression

Claude Code 2.1.302, the version these requests present as, gzips request bodies. OAuth requests sent directly to `api.anthropic.com` (OpenCode 1, OpenCode 2 and Pi) do the same when the body is at least 4,096 characters:

- The wire body is the signed request with its billing `cch` reset to `00000`, followed by a newline and 0 to 256 random spaces and tabs, compressed once with gzip at level 6. The request carries `content-encoding: gzip`; the runtime sets `content-length`.
- Smaller bodies, other hosts, API-key routes and relays go out uncompressed and signed. Gzip is also off whenever `HTTPS_PROXY`/`HTTP_PROXY` applies to `api.anthropic.com` (honouring `NO_PROXY`), `NODE_EXTRA_CA_CERTS` is set, or a client certificate (`CLAUDE_CODE_CLIENT_CERT`/`CLAUDE_CODE_CLIENT_KEY`) is configured.
- `CLAUDE_CODE_GZIP_REQUEST_BODIES=0` turns it off. `=1` turns it on even in those cases.
- Dumps, CacheKeep tracking and relay rescue work on the uncompressed signed body; a dump's `.body.json` is that body, not the wire bytes. OpenCode 1 and Pi CacheKeep prewarms are sent uncompressed; OpenCode 2 prewarms follow the same rule as its other sends.

If something on the way rejects a gzipped body (a 400, 403 or 415 without Anthropic's `request-id` or Cloudflare's `cf-ray`, or a 400 saying the JSON could not be parsed), OpenCode 1 and Pi resend that request once, uncompressed and signed, with the same `x-client-request-id`; the resend does not count as a retry. Any such rejection turns gzip off for the rest of the process. When a proxy (no Anthropic headers) rejected the gzipped body and Anthropic then accepted the uncompressed resend, gzip also stays off for seven days: the plugin records that in `<account file stem>-request-gzip.json` next to its account storage file, never in your settings. An ordinary API 400 is passed through unchanged.

OpenCode 2 performs the physical fetch in the host, and its retry and limit hooks see the response before the plugin could resend it. There the rejected request fails, the rejection is recognised and gzip is turned off for the process, and the next request goes out uncompressed.

Relays always send the uncompressed body to Anthropic in this release: the relay protocol hashes and patches the uncompressed text, and the Worker forwards it as is.

## Proxy routes

API-key routes can use a custom base URL and auth-header selection. The CLI's API-route inputs are listed in [commands](commands.md#opencode-cli). `ANTHROPIC_BASE_URL` can override the endpoint of API-key routes. On OpenCode 1 and OpenCode 2, Claude sign-in (OAuth) requests go only to `https://api.anthropic.com`: a provider `baseURL` or `ANTHROPIC_BASE_URL` pointing elsewhere is refused for them with a local 400, and nothing is sent. Pi already sends native OAuth only to that origin. Pi additionally supports `ANTHROPIC_CUSTOM_HEADERS`, `ANTHROPIC_MODEL` and `ANTHROPIC_DEFAULT_{SONNET,OPUS,HAIKU,FABLE}_MODEL` on API-key proxy routes; those custom-header/model overrides do not alter OAuth requests. Protected authentication and protocol headers cannot be replaced by custom headers.

Only use endpoints you trust: the route receives the request content and its configured authorization. Do not use insecure transport settings as a remedy for a credential or custody error.

## Diagnostics and dumps

Relay diagnostics are written to `opencode-anthropic-auth.log` in the [system temp folder](environment.md#paths-on-windows-macos-and-linux). To follow it on macOS or Linux:

```sh
tail -f "$(node -p 'require("node:os").tmpdir()')/opencode-anthropic-auth.log"
```

In PowerShell on Windows:

```powershell
Get-Content -Wait "$env:TEMP\opencode-anthropic-auth.log"
```

Successful entries identify transport/protocol and full-sync/patch use; `falling back direct` indicates direct fallback rather than relay success.

Enable or disable request dumps in `/claude` → **Diagnostics**. Artifacts live in the `opencode-anthropic-auth-dumps` folder inside the [system temp folder](environment.md#paths-on-windows-macos-and-linux):

| Suffix | Contents |
| --- | --- |
| `.body.json` | Final rewritten request body |
| `.meta.json` | Hashes, byte counts, diff ranges and cache-relevant structure |
| `.relay.json` | Redacted relay payload/frame metadata |
| `.request.json` | Redacted direct URL, method and headers |
| `.response.json` | Allowlisted response metadata; streamed message replies include `reply_text_edges` with each text block's index and leading/trailing whitespace and total character counts, never text or text hashes |

Dump bodies can contain prompts and tool content even when metadata is redacted. Treat them as private debugging artifacts, disable dumping when done, and sanitize anything shared. Lane-start dumps use `-start-`; CacheKeep uses `-prewarm-cachekeep-`. See [cache diagnostics](cache.md#diagnostics-and-history-analysis) and [safe troubleshooting](troubleshooting.md#requests-and-diagnostics).
