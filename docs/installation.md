# Installation and configuration

`@cortexkit/opencode-anthropic-auth` supplies the OpenCode 1/2 plugin and setup CLI. `@cortexkit/pi-anthropic-auth` supplies the Pi extension. Both use the shared native account runtime, but each host has its own account storage and vault enrollment.

## Recommended setup

Stop every OpenCode, LiteCode and Pi process before running:

```sh
npx @cortexkit/opencode-anthropic-auth setup
```

The setup CLI delegates host detection, OpenCode generation selection and package registration to common-auth's shared setup runner. Its Anthropic-specific callbacks establish local account authority or activate vault custody. Generation 1 means OpenCode 1, generation 2 means OpenCode 2, and `both` configures their shared pool. Offline means the hosts are stopped, not that network access is disabled: sign-in, package installation and vault enrollment can require network or daemon access. Do not restart hosts until setup has finished.

| Option | Meaning |
| --- | --- |
| `--yes`, `-y` | Select every found host, including Pi. Run without `--yes` to choose hosts. This does not select vault custody or grant Pi auth-removal consent. |
| `--dry-run` | Preview registration and callback names without running callbacks, signing in, enrolling or writing the local authority journal |
| `--opencode=1`, `--opencode=2`, `--opencode=both` | Choose the OpenCode generation; `both` shares one OpenCode pool and operation |
| `--no-claustrum` | Run local setup. This does not disconnect enrolled hosts. |
| `--claustrum` | Explicitly enroll selected hosts in the vault |
| `--login` | Explicit local OpenCode 1/Pi sign-in; cannot be combined with `--claustrum` or generation 2 alone |
| `--remove-pi-auth` | Explicit consent for setup to remove/move aside Pi's stored Anthropic login |
| `--help`, `-h` | List every option setup accepts, then exit without checking or changing anything |

The two argument-level refusals (`--login --claustrum` and `--login --opencode=2`) also apply to dry runs. Callback checks for journal/destination conflicts, Pi consent and verified vault inventory do not run in a dry run, so a successful preview is not proof that the real run will proceed.

Local setup refuses on a vault-enrolled host. In each named host, run `/claude` → **Accounts** → **Disconnect from the vault**. Then run local setup again. Old local settings from 1.x do not disconnect a host. `--opencode` chooses a generation; it does not exclude Pi. Run without `--yes` to choose hosts.

A real run checks all selected hosts before the first host writes, including consent to move/remove Pi's stored Anthropic login and conflicts between host storage paths. Hosts cannot share native storage paths. A later per-host failure does not roll back hosts that have already completed.

## After setup

- OpenCode 1: open `/claude`, then **Accounts** to manage the native pool.
- OpenCode 2: connect Anthropic with **Claude Pro / Max (native account pool)** through `/connect` before adding more accounts in `/claude` → **Accounts**; follow the [OpenCode 2 setup steps](opencode-2.md#empty-initialization).
- Pi: use Pi's Anthropic login for local sign-in, or `/claude` → **Accounts** for additional accounts.

For vault custody, use the host's vault option instead. See [OpenCode 2](opencode-2.md#empty-initialization), [local accounts](accounts-and-routing.md#local-storage) and [vault setup](vault.md#setup) before choosing a sign-in method.

## Manual host registration

Registration alone does not migrate credentials or initialize authority. The recommended setup above also enforces stopped-host checks and is still needed to establish local authority or enroll in the vault.

For OpenCode, add the package to the main `opencode.jsonc` or `opencode.json` plugin array, preserving other entries:

```json
{
  "plugin": ["@cortexkit/opencode-anthropic-auth"]
}
```

Restart OpenCode after changing its config. Setup handles the separate TUI sidebar registration for generation 1 and `both`; generation 2 registers only the main config. Do not copy generation-1 sidebar registration into an OpenCode 2-only installation.

Install Pi's extension with:

```sh
pi install npm:@cortexkit/pi-anthropic-auth
```

For a one-run extension load, use `pi -e npm:@cortexkit/pi-anthropic-auth`. Neither command substitutes for authority setup or consent to move an existing Pi login. See [troubleshooting](troubleshooting.md#installation-and-startup) if the host still loads an older package.

## Configuration ownership

Change settings in the shared [`anthropic-auth.jsonc` settings file](settings-file.md) or through the [single `/claude` menu](commands.md#the-claude-menu), never by editing credentials or the journal. Credentials and private runtime state stay in their own files; the [custody file map](custody-state-machine.md#storage) describes them. `OPENCODE_ANTHROPIC_AUTH_FILE` and `PI_ANTHROPIC_AUTH_FILE` select legacy sidecar locations; native pool, runtime and journal files are placed beside those sources. The sidecars are not live legacy credential stores.

The setup runner is bundled through `@cortexkit/anthropic-auth-core`, the shared authentication library. The OpenCode CLI does not add a runtime dependency on common-auth; [dependency ownership](opencode-2.md#dependency-ownership) explains the boundary.
