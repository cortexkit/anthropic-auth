# Vault custody

Claustrum is a local credential-vault service. Each host explicitly proposes enrollment as `anthropic-auth-opencode` or `anthropic-auth-pi`; the vault operator can approve a different name. Its enrollment record, not an account setting, selects vault custody. OpenCode and Pi can be enrolled, disconnected or revoked independently.

## Setup

Vault setup needs [Claustrum v0.2.0](https://github.com/cortexkit/claustrum/releases/tag/v0.2.0) or newer, which needs subc-core 0.20.83 or newer. Older Claustrum versions can't connect plugins, and setup stops with a message saying so.

Stop all OpenCode, LiteCode and Pi processes. With `ck` installed and the Claustrum daemon running, run:

```sh
npx @cortexkit/opencode-anthropic-auth setup --claustrum
```

The shared runner owns the per-host enrollment ceremony. Anthropic callbacks then ensure the host-specific grant to read the `anthropic-native` category, discover inventory and require a verified default Claude account. If that default is unverified, sign in through the vault and rerun setup; setup does not import local tokens into the vault.

Setup grants the principal named by the enrollment's `approvedName`, using the proposed default only when no approved name is recorded. If setup reports no read grant, its recovery command names that principal. To grant access by hand, use the approved principal shown in `/claude` → **Accounts**. For example, if the operator approved OpenCode as `anthropic-auth-opencode-v2`, run:

```sh
ck auth grant --principal enrolled:anthropic-auth-opencode-v2 --selector-kind category --selector anthropic-native --operation read
```

A second host of the same kind, such as another OpenCode installation, is approved with its own `--name` (for example `ck auth enroll approve --request-id <id> --name anthropic-auth-opencode-2`), and its grant names that same name.

Do not substitute `anthropic-auth-opencode` or `anthropic-auth-pi` unless that is this installation's approved name (or its default when no approved name was recorded). If a read grant reaches no Claude login, run `ck auth reclassify --from-registry` and check the logins with `ck auth status` before rerunning setup.

If setup fails after enrollment is approved, the host stays connected to the vault. Run setup again to finish connecting. Or, in that host, run `/claude` → **Accounts** → **Disconnect from the vault** to undo it. Local settings do not undo enrollment.

For noninteractive setup, add `--yes`. If Pi has stored Anthropic auth, explicit `--remove-pi-auth` consent is also required; `--yes` alone is not consent. Do not combine `--login` with `--claustrum`. Dry runs invoke no callbacks and do not validate inventory or consent.

Vault setup leaves local pool files, journals, runtime metadata and session pins unchanged, even if those local files are malformed. It never reads or writes OpenCode 1 auth in generation-2-only setup and never opens a host database. See [custody storage](custody-state-machine.md#storage) for the separate vault namespace.

## Host activation

- OpenCode 1: choose **Claude via credential vault**. An occupied separate Anthropic login is refused; remove it with OpenCode's own tools before choosing the vault option, or disconnect instead. The plugin writes only an inert placeholder into an empty slot.
- OpenCode 2: choose **Claude vault accounts**. It returns the plugin's non-secret marker through the host API; setup does not create a connection.
- Pi: a stored OAuth or API-key login would take precedence. With consent, setup moves that slot into a private stash and installs an inert marker. The original login is preserved for disconnect.

No placeholder can authorize a request. Each native model send, quota/profile query and cache or Prime request obtains scoped vault authorization. A revoked, unavailable or unreadable enrollment never falls back to local accounts. Ordinary host API-key routes that the plugin does not own keep stock host behavior.

## Accounts while enrolled

`/claude` → **Accounts** shows that accounts are managed in the vault. Enable/disable, reset backoff and disconnect remain available; local sign-in, API-key additions, removal, reordering and enrollment reset do not. New vault accounts added with `ck auth login --provider anthropic` are discovered without a host restart.

Local accounts remain unchanged and hidden while enrolled. A failed vault authorization does not unlock them. Enrollment files are owner-only; overrides are `OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE` and `PI_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE`. The [authority table](custody-state-machine.md#authority) covers approved state without a token and unreadable records.

## Disconnect and recovery

Run `/claude` → **Accounts** → **Disconnect from the vault** and confirm. The action is also offered when enrollment cannot be read. A successful disconnect removes the host's local enrollment files, not the vault's approval. Ask a vault operator to revoke that approval in Claustrum separately.

Disconnect can clear malformed enrollment data. It refuses unsafe storage or a record for another host or plugin. Check the named host's enrollment path, file ownership and private permissions. Use safe storage. Do not delete enrollment files by hand or change ownership to bypass a refusal. Stop other setup or disconnect attempts before retrying a busy action.

OpenCode's stored sign-ins are not read or changed by disconnect. Pi first restores its stashed slot byte-for-byte, then ends enrollment. If a different Pi login occupies the slot, disconnect refuses and preserves the stash, current login and enrollment instead of overwriting either login.

A successful disconnect returns to local custody but does not migrate or initialize a pool. If no local authority exists, stop the hosts and run local setup. For OpenCode 2, follow [empty initialization](opencode-2.md#empty-initialization). **Reset host enrollment**, available only in local custody, clears eligible denied/blocked ceremony state; it neither enrolls nor disconnects an approved host. Only setup proposes and polls enrollment.
