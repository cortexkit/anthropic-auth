# Commands and menus

## The /claude menu

Both hosts register one `/claude` command. It opens a menu whose actions collect their own parameters; do not append typed subcommands. Pi rejects typed arguments. Earlier separate `/claude-*` commands are no longer registered.

| Group | What it offers | Host differences |
| --- | --- | --- |
| Accounts | Account status, enable/disable, remove/reorder, reset backoff, OAuth/API-key additions, custody guidance and disconnect | Actions depend on custody |
| Quota | Quota summary and refresh | Pi shows summary only |
| Routing | Mode selection and reset current session | Both hosts |
| Limits | Killswitch enable/disable and thresholds | OpenCode only |
| Cache | Cache mode, enable/disable, keepalive schedule and subagent setting | Both hosts |
| Diagnostics | Request dumps and logging level | Both hosts |
| Extras | Fast mode, Prime status/toggle and lane start | Both hosts have fast mode and Prime status/toggles; Pi has no lane start |

In local custody, Accounts offers local management and enrollment reset, not disconnect. While enrolled, only enable/disable, reset backoff and disconnect remain. Unreadable enrollment keeps that reduced set so disconnect is available. **Custody setup guidance** explains the stopped-host requirement without changing custody.

Remove, reset-enrollment and disconnect actions require confirmation. Sign-in, API-key additions, guidance and disconnect require an interactive session. In the OpenCode TUI the command opens a dialog; Desktop/headless OpenCode posts a text summary, and Pi without a UI prints status sections only.

## OpenCode CLI

The CLI belongs to `@cortexkit/opencode-anthropic-auth`. It manages OpenCode's native local pool, not Pi's pool or vault credentials. Stop all hosts before CLI operations that change accounts or setup state.

```sh
npx @cortexkit/opencode-anthropic-auth --help
npx @cortexkit/opencode-anthropic-auth setup
npx @cortexkit/opencode-anthropic-auth login personal-alt
npx @cortexkit/opencode-anthropic-auth api add kie-opus
npx @cortexkit/opencode-anthropic-auth list
```

`login` adds an OAuth account with a verified identity. `api add` collects an API-key route; automation can supply `OPENCODE_ANTHROPIC_AUTH_API_BASE_URL`, `OPENCODE_ANTHROPIC_AUTH_API_KEY` and `OPENCODE_ANTHROPIC_AUTH_API_AUTH_HEADER`. Treat those environment values as secrets, not examples to paste into logs. Local account operations refuse while enrolled in the vault.

`relay setup` provisions a user-owned relay and saves OpenCode local settings; it is not a sign-in or Pi configuration command. See [transport setup](transports.md#relay). For setup options, dry-run limits and Pi consent, see [installation](installation.md#recommended-setup). Generation-2-only `setup --login` is refused; use [the registered OC2 pool login](opencode-2.md#setup-login-and-host-selection).
