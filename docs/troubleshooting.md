# Troubleshooting

## Installation and startup

- **Setup says a host is running:** stop all OpenCode, LiteCode and Pi processes, not only the current terminal, then rerun setup. Do not bypass the process fence or start a host before setup finishes.
- **OpenCode still loads an old plugin:** restart after config changes. If it still loads stale package bytes, clear OpenCode's plugin cache at `~/.cache/opencode` (`%USERPROFILE%\.cache\opencode` on Windows) and restart. Do not delete account files or the journal as a cache remedy.
- **Generation-2 `setup --login` refuses:** this is intentional. Run [empty initialization](opencode-2.md#empty-initialization), start OpenCode and choose **Claude Pro / Max (native account pool)**. If Pi is also found, `--yes` selects both; use interactive host deselection for a Pi-only login.
- **A dry run succeeds but the real run refuses:** previews execute no callbacks. Real-run authority, consent, path-alias and vault-inventory checks can still refuse; see [setup options](installation.md#recommended-setup).

## Local accounts and migration

`migration-required` means local authority has not been established. Stop the hosts and run setup for the selected generation. `migration-incomplete` means a pre-commit journal must be resumed with the matching inputs; do not delete it to force fresh setup. Version-5 journals have no rollback path.

For an `invalid_grant` account, re-login through Accounts. If legacy main-account identity cannot be proved during OpenCode 1 migration, use the explicit stopped-host recovery:

```sh
npx @cortexkit/opencode-anthropic-auth setup --login --no-claustrum
```

`setup --login` does not perform an OpenCode 2-only login. Use the registered OpenCode 2 login instead when generation 2 is selected.

`pool-populated` prevents direct legacy import over native account data. Shared OC1 setup can skip import instead; do not copy tokens from the separate host slot into the pool. If Accounts shows that OpenCode's separate Anthropic login is unused, add that account through Accounts if needed or remove the separate login with OpenCode's own tools. Orphan metadata or quota-only state does not make a usable OAuth account; requests still refuse. See [the admission table](custody-state-machine.md#opencode-1).

`settings-changed` on a version-5 import resume means the captured native preferences no longer match. Preserve the files for diagnosis rather than overwriting settings or editing the digest. For `journal-conflict`, invalid journals or unsafe paths, correct the underlying mismatch without fabricating authority. [Upgrade and recovery](releases.md#upgrade-and-recovery) explains the compatibility boundary.

## Vault custody

Local setup names hosts that are still connected to the vault. In each named host, run `/claude` → **Accounts** → **Disconnect from the vault**. Then run local setup again. Old local settings from 1.x do not undo enrollment. An unreadable enrollment does not allow local sign-in. Disconnect can clear malformed data, but unsafe storage or a record for another host can refuse. Check the host's enrollment path, ownership and private permissions. Do not delete or copy enrollment files between hosts.

If OpenCode holds a separate Anthropic login while enrolled, remove that login using OpenCode's tools and choose the vault method, or disconnect. If vault setup reports no verified default Claude account, sign in through the vault and rerun setup; a local token cannot satisfy that check.

Pi setup requires explicit stored-login consent. A missing stash or conflicting current Pi slot is a preservation refusal, not an invitation to delete either login. Keep the stash, slot and enrollment intact and resolve the conflict before retrying. [Vault disconnect](vault.md#disconnect-and-recovery) describes the restore order.

## Requests and diagnostics

### Quota refresh works but Anthropic model requests fail in OpenCode 2

The `/claude` menu manages the plugin's account pool. Adding an account there and refreshing its quota do not select the plugin as OpenCode's Anthropic connection. A separate built-in OAuth or API-key connection can still be handling model requests, including their retries and final **Session failed** error.

1. In OpenCode, run `/connect`, then choose Anthropic → **Claude Pro / Max (native account pool)** and complete the browser sign-in; from a terminal, run `opencode auth login anthropic --method native-claude-oauth`. If Anthropic is already connected, `/connect` → Anthropic opens its account list: make sure the plugin's connection is the active Anthropic account. Running the pool login again replaces the pool's main account.
2. Select an `anthropic/` model and send a short message.
3. Open `/claude` → **Accounts** → **View status** to check the main and fallback accounts. If a request still fails, check quota and the actual provider error. HTTP 429 can also mean a real provider rate limit; reconnecting does not bypass one.

For a fresh installation, complete the [main-account connection](opencode-2.md#empty-initialization) before adding fallback accounts.

**Moving from OpenCode 1 to OpenCode 2.3 or later:** on its first start with a new database, OpenCode 2.3 imports OpenCode 1's `auth.json`. After OpenCode 1 setup, the Anthropic entry there is the plugin's inert marker: an OAuth entry with an empty access token and a `claustrum-tombstone:` refresh value. OpenCode 2 imports it as an ordinary Anthropic sign-in and can make it the active connection. That connection does not route to the plugin, so model requests fail even though `/claude` shows your accounts. To fix it, connect once with the plugin's own method as in step 1 above and make sure that connection is the active Anthropic account. Your accounts and settings are not affected.

### Other request failures

Check `/claude` for custody, account, routing and quota status first. Unknown quota, positive remaining-quota floors and model-scoped exhaustion can block an account even when it has a token. Resetting a session pin is not a way to bypass limits.

For transport failures, inspect the [relay log](transports.md#diagnostics-and-dumps); direct fallback is not relay success. OpenCode 2 cannot use WebSocket relay. Enable dumps only for a bounded investigation, and redact prompts, tool content and credentials before sharing them. Silence in debug-only cache records does not prove no traffic. Never investigate by running tests or setup against a live user database or live credentials.
