# Codebase Structure

A Bun workspace of TypeScript packages. This file is a map; to find a specific symbol, search the code.

## Workspace

```text
packages/
  core/         shared library (@cortexkit/anthropic-auth-core), bundles common-auth into dist/
  opencode/     OpenCode 1 and 2 plugin, TUI and setup CLI (@cortexkit/opencode-anthropic-auth)
  pi/           Pi provider extension (@cortexkit/pi-anthropic-auth)
  e2e-tests/    real OpenCode processes against mock Anthropic, relay and Claustrum servers
scripts/        gate.sh, CI unit grouping, release, version and lockfile sync, dist and Pi host checks
docs/           public user and contributor documentation
.github/        ci.yml, windows.yml (packed setup on three Windows machines), release.yaml
.cortexkit/     WORKER.md (rules for worker agents); internal-docs/ and scripts/ are ignored and never committed
```

## `packages/core/src`

- `index.ts`: the barrel. Hosts import Core by package name only.
- **Accounts and custody:**
  - `native-account-runtime.ts` is the shared account service. `native-account-view.ts` holds its secret-free views and `native-settings.ts` its settings transforms.
  - Local custody: `native-local-*.ts`, `native-refresh-coordinator.ts`, `native-runtime.ts` and `pool-*.ts` (paths, store, binding, authority).
  - Vault custody: `native-vault-*.ts`, `native-custody.ts` (the common-auth receipt adapter), `native-enrollment-authority.ts`, `claustrum.ts` and `claustrum-enrollment.ts`.
  - Host auth slots: `native-host-auth*.ts`.
  - Offline migration from 1.x sidecars: `native-migration*.ts` and `migration-source.ts`.
- **Menus:** `native-menu-model.ts`, `native-menu-executor.ts` and `native-ui.ts`. `commands/account.ts` holds the account command execution.
- **Request:**
  - Claude Code shape: `claude-code.ts`, `cch.ts` (billing header and body signature), `constants.ts` (the emulated Claude Code version and betas).
  - Per-model handling: `model-capabilities.ts` (one row per model) and `models.ts` (catalogue and pricing).
  - Mid-conversation controls: `thinking-binding.ts`, `mid-conversation-output-config.ts` (effort markers) and `turn-end-note.ts`.
  - History and transport: `request-history.ts` (structural checks), `message-threads.ts`, `request-gzip.ts`, `relay.ts`, `oauth-origin.ts` and `request-abort.ts`.
- **Routing and quota:**
  - Routing: `routing.ts` and `sticky-routing.ts`.
  - Quota policy: `killswitch.ts`, `quota-refusal.ts` and `session-cache-activity.ts`.
  - Quota readings: `quota-manager.ts`, `quota-headers.ts`, `quota-header-feed.ts`, `insula-quota.ts` and `quotas.ts`.
- **Cache:** `cache1h.ts`, `cachekeep.ts`, `cachekeep-store.ts` (restart store), `cachekeep-registry.ts` (session list) and `prime.ts`.
- **State layout:** `state-layout-*.ts`, `holder-registry.ts`, `layout-fence.ts`, `relocation-guard.ts` and `state-home-serving-guard.ts`.
- **Shared plumbing:** `logger.ts`, `logging.ts`, `dump.ts`, `json.ts` (redacting JSON parse), `sse.ts`, `owner-only.ts`, `publication-rename.ts`, `network-errors.ts` and `provider-error.ts`.
- `tests/`: Core unit tests. `test-lifetime.ts` holds the body-owned cleanup helper.
- `../scripts/`: the Core build and the declaration-closure guard for bundled common-auth types (`check-native-type-closure.ts`).

## `packages/opencode/src`

- `index.ts`: the OpenCode 1 plugin factory. It must export only `AnthropicAuthPlugin`, because OpenCode's file loader calls every exported function.
- `transform.ts`: OpenCode 1 request and stream rewriting.
- **Shared by OpenCode 1 and 2:**
  - Server fallback and OpenCode 1 recovery rounds: `server-fallback.ts`, `fable-fallback.ts`.
  - Request plumbing: `effort-history.ts` (the effort plan), `billing-lineage.ts`, `lane-start.ts`, `routing-relay.ts` (shared routing), `prompt-context.ts`.
  - Diagnostics and display: `cache-diagnostics.ts` and `sidebar-state.ts`.
- `v2/`: OpenCode 2, built to `dist/v2/server.js` and loaded through the `./server` export.
  - `setup.ts` is the entry and `source.ts` chooses accounts.
  - `adapter.ts` shapes and sends requests, and `wire.ts` holds the wire settings.
  - Also: `cachekeep.ts` and `cachekeep-store.ts`, `prime.ts`, `menu.ts`, `sidebar.ts`, `rpc.ts` and `tui.ts`.
- `setup/`: Anthropic callbacks for common-auth's shared setup runner (`command.ts`). Covers local migration and login, enrollment and vault activation.
- `cli.ts`: the `opencode-anthropic-auth` binary.
- `rpc/`: the loopback RPC server and client between the server process and the TUI.
- `tui/`: the sidebar (`claude-sidebar.tsx`, shared by OpenCode 1 and 2) and dialogs.
  - `entry.mjs` loads the precompiled `src/tui-compiled/` on current hosts, and raw TSX otherwise.
  - `tui.tsx` is OpenCode 1's TUI plugin.
- `tests/`: OpenCode unit and integration tests. `preload-sandbox.ts` isolates every path before Core loads, and `support/` holds shared fixtures.
- `../scripts/`: the TUI build, packed-install smoke tests, packed host installs for CI, and bundle checks.

## `packages/pi/src`

- `index.ts`: extension entry; registers the provider, commands and session hooks.
- `convert.ts` and `transcript.ts`: build the Anthropic body from Pi's context.
- `stream.ts` and `transport.ts`: send, relay, threads and stream mapping.
- `native.ts` and `native-commands.ts`: the account runtime and menu.
- `cachekeep.ts` and `cachekeep-claim.ts`: keep-warm, with the restart store and the per-session claim.
- Other files: `effort-history.ts`, `quota-wait.ts`, `custody.ts` and `paths.ts`.

## Where to add new code

- **A shared feature:** `packages/core/src/<feature>.ts`, exported from `index.ts`, then wired into OpenCode 1, OpenCode 2 and Pi. Every host gets the same behaviour unless a host truly can't support it, and the difference is written down.
- **A new model:** a row in `model-capabilities.ts`, and metadata in `models.ts`. Don't add per-model predicates elsewhere.
- **A menu action:** Core's menu model and executor, then each host's apply step. The user command stays `/claude`.
- **An OpenCode 2 integration point:** `v2/source.ts` or `v2/adapter.ts`, through the hooks common-auth's installer defines.
- **A TUI feature:** `packages/opencode/src/tui/`, with RPC types in `rpc/protocol.ts`.
- **A setup or CLI action:** `setup/` or `cli.ts`. It runs only with OpenCode, LiteCode and Pi stopped, and never brings back sidecar credential writers.
- **A stored format change:** keep it readable by the last published release, and add a rollback-compatibility test.

## Conventions

- Files are kebab-case.
- Tests live in each package's `tests/` folder as `*.test.ts`. End-to-end scenarios go in `packages/e2e-tests/tests/`.
- Tests never touch live state:
  - inject timers instead of patching globals;
  - bind test servers to `127.0.0.1`;
  - put dumps in a temporary `OPENCODE_ANTHROPIC_AUTH_DUMP_DIR`.
- Changelog entries go in the root `CHANGELOG.md` under `## Unreleased`.
- Use Bun 1.3.14, the version CI pins.
