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

### Where the relay is read from

A relay is used only when the account settings it is saved in are in their default place for your operating system account: `~/.config/opencode/` for OpenCode (with its state files wherever the state-folder move put them), and `~/.pi/agent/` for Pi (`%USERPROFILE%\.config\opencode\` and `%USERPROFILE%\.pi\agent\` on Windows). The home folder is looked up from the operating system account, never from `HOME`, `USERPROFILE` or another environment variable. This applies in local, vault and Thalamus-hosted mode.

When an environment variable moves the account settings elsewhere (for example `OPENCODE_ANTHROPIC_AUTH_FILE`, `OPENCODE_CONFIG_DIR`, `XDG_CONFIG_HOME`, `PI_ANTHROPIC_AUTH_FILE` or `PI_CODING_AGENT_DIR`), or the home folder cannot be found, a relay saved there is ignored and requests go directly to Anthropic, whatever `relay.fallbackToDirect` says. A repository's `.env` can set those variables, and in vault and hosted mode your Claude sign-in does not live in those settings, so a relay they name could otherwise receive it. The plugin logs one warning, and `/claude` Status shows `Relay ignored: account settings are not in their default location` on OpenCode 1, OpenCode 2 and Pi. `relay setup` refuses with `Relay not saved: account settings are not in their default location` rather than save a relay that would be ignored.

In vault and Thalamus-hosted mode, the vault settings and state files a relay is read from must be regular files: if either is a symbolic link, the relay is ignored, because a link could be pointed somewhere else after the check. The location is checked again every time the relay is read. If the home folder cannot be found, Status shows `Relay ignored: the operating system account's home folder could not be found` instead, and the lookup is tried again after about a minute. On Windows the home folder is the profile folder Windows records for your account, which also works over SSH and in scheduled tasks. The lookup runs `whoami.exe` and `reg.exe` from `C:\Windows\System32`, so on a Windows installed in another folder the home folder cannot be found and the relay is ignored.

Pi keeps its state beside its account file. When `OPENCODE_ANTHROPIC_AUTH_STATE_FILE` is set, Pi's state is read from where that variable says, which is not Pi's default place, so Pi does not use a relay while it is set.

### Plain-text relays and proxy settings

A relay on a plain `http://` or `ws://` URL is not used while `HTTP_PROXY` or `http_proxy` is set, unless each of `NO_PROXY` and `no_proxy` that is set lists the relay's host. An empty one lists no host. (Bun and Node read these two variables differently; Node with `NODE_USE_ENV_PROXY=1` lets an empty `no_proxy` override `NO_PROXY`, so the plugin only treats a host as exempt when every set variable exempts it.) The relay request carries your Claude sign-in, and those variables would send it through the named proxy in plain text; a repository's `.env` can set them. The settings are checked when a request starts and again right before every plain-text send to the relay, including a retry and the HTTP attempt after a failed WebSocket. Nothing is sent to the relay. With `relay.fallbackToDirect` on, the request goes directly to Anthropic, as when the relay cannot be reached; with it off, the request fails with `Relay refused: a proxy setting would carry plain-http requests`. The plugin logs one warning and `/claude` Status shows that line on OpenCode 1, OpenCode 2 and Pi. `https://` and `wss://` relays are not affected.

A `ws://` relay stays plain text: its WebSocket connects to `ws://`, and when the WebSocket fails, the HTTP attempt goes to the same host over `http://` (a `wss://` relay uses `https://`). After the relay URL or secret changes, the next request opens a new WebSocket with the new values.

`relay.transport` is `http` by default. A missing transport is inferred from the URL: `wss://` (or `ws://`) uses WebSocket, `https://` (or `http://`) uses HTTP. A stored `transport` wins over the URL, with one exception: a `ws://` or `wss://` URL stored with `transport` `http` is refused as invalid relay settings, as in earlier releases. Store `websocket` for such a URL, or use its `http://` or `https://` form. WebSocket is opt-in for OpenCode 1 and Pi, uses protocol v2 on `/ws` and requires the current Worker deployment. Redeploy an existing Worker with the same Worker name when upgrading its protocol. OpenCode 2 supports direct and HTTP only and refuses a selected WebSocket relay before dispatch.

The OpenCode 1 sidebar shows the relay and its transport only when requests can use it: relay enabled, with a URL and a stored relay secret. Without the secret, requests go direct and the sidebar shows no relay. A shown relay can still fall back to direct for a single request when the relay fails.

`relay.fallbackToDirect` allows direct fallback on relay failures before streaming; set it to `false` if direct dispatch is not acceptable. Genuine upstream authorization failures and relay failures have different provenance; a relay's own 401 must not invalidate a Claude account. Vault mode still authorizes each physical send through the vault.

## Request-body compression

Claude Code 2.1.302, the version these requests present as, gzips request bodies. OAuth requests sent directly to `api.anthropic.com` (OpenCode 1, OpenCode 2 and Pi) do the same when the body is at least 4,096 characters:

- The wire body is the signed request with its billing `cch` reset to `00000`, followed by a newline and 0 to 256 random spaces and tabs, compressed once with gzip at level 6. The request carries `content-encoding: gzip`; the runtime sets `content-length`.
- Smaller bodies, other hosts (including a [custom gateway](settings-file.md#custom-gateway)), API-key routes and relays go out uncompressed and signed. Gzip is also off whenever `HTTPS_PROXY`/`HTTP_PROXY` applies to `api.anthropic.com` (honouring `NO_PROXY`), `NODE_EXTRA_CA_CERTS` is set, or a client certificate (`CLAUDE_CODE_CLIENT_CERT`/`CLAUDE_CODE_CLIENT_KEY`) is configured.
- `CLAUDE_CODE_GZIP_REQUEST_BODIES=0` turns it off. `=1` turns it on even in those cases.
- Dumps, CacheKeep tracking and relay rescue work on the uncompressed signed body; a dump's `.body.json` is that body, not the wire bytes. Direct CacheKeep prewarms follow the same gzip rule on all three hosts; gateway prewarms stay uncompressed. OpenCode 1 and Pi resend an eligible prewarm uncompressed if the gzipped send is rejected.

If something on the way rejects a gzipped body (a 400, 403 or 415 without Anthropic's `request-id` or Cloudflare's `cf-ray`, or a 400 saying the JSON could not be parsed), OpenCode 1 and Pi resend that request once, uncompressed and signed, with the same `x-client-request-id`; the resend does not count as a retry. Any such rejection turns gzip off for the rest of the process. When a proxy (no Anthropic headers) rejected the gzipped body and Anthropic then accepted the uncompressed resend, gzip also stays off for seven days: the plugin records that in `<account file stem>-request-gzip.json` next to its account storage file, never in your settings. An ordinary API 400 is passed through unchanged.

OpenCode 2 performs the physical fetch in the host, and its retry and limit hooks see the response before the plugin could resend it. There the rejected request fails, the rejection is recognised and gzip is turned off for the process, and the next request goes out uncompressed.

Relays always send the uncompressed body to Anthropic in this release: the relay protocol hashes and patches the uncompressed text, and the Worker forwards it as is.

## Proxy routes

API-key routes can use a custom base URL and auth-header selection. The CLI's API-route inputs are listed in [commands](commands.md#opencode-cli). `ANTHROPIC_BASE_URL` applies only when the API-key request has no route URL. On OpenCode 1, OpenCode 2 and Pi, a saved paid route always uses its stored URL, even if it was saved with the default Anthropic URL. All three hosts honor `ANTHROPIC_MODEL` and `ANTHROPIC_DEFAULT_{SONNET,OPUS,HAIKU,FABLE}_MODEL` on API-key proxy routes. Pi also supports `ANTHROPIC_CUSTOM_HEADERS` there, without changing OAuth requests. Protected authentication and protocol headers cannot be replaced by custom headers.

On OpenCode 1 and OpenCode 2, Claude sign-in (OAuth) requests go only to `https://api.anthropic.com`: a provider `baseURL` or `ANTHROPIC_BASE_URL` pointing elsewhere is refused for them with a local 400, and nothing is sent. Pi sends native OAuth only to that origin. The only other destination for OAuth model requests is a [custom gateway](settings-file.md#custom-gateway) in your own user settings file, on OpenCode 1, OpenCode 2 and Pi; it replaces the relay for those requests and never applies to sign-in, refresh or usage requests. OAuth requests never follow redirects and always check TLS certificates: `ANTHROPIC_INSECURE` applies only to OpenCode 1 API-key routes.

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
