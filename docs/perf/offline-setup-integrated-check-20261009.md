# Offline setup integration check — 2026-10-09

## Result

**Partial verification.** The reviewed six-file source merge is preserved. With the pinned runtime supplied by the remote build service, the offline frozen install, Core build, and all three bounded setup test files passed. The requested OpenCode typecheck exited 1 on five TS2339 property-access diagnostics in two existing test files outside the six-file merge. No unrelated files were changed to address them; the report records the failure and exact next action for full verification.

## Source integration

A no-commit, no-fast-forward merge of `d3220b8dee7745b10a508c720a2d30879e593b17` into the `f27e80fb6a00cdb6365e0cb6faa7ea407f849fd9` worktree staged exactly the six reviewed setup helper and test paths. The staged diff was 590 insertions and 12 deletions. Each working-tree file's Git blob hash matched the same path in `d3220b8dee7745b10a508c720a2d30879e593b17`; no helper contents were changed. The destination already contains the source commit's parent; merging adds only the six helper changes, rather than replacing the destination with the older source branch. The source merge was committed locally as `abe365778c3c2a2d9681d8b5849ba3514b1d9a6e`.

## Remote runtime check

The requested remote command was:

```sh
set +e; printf 'pwd: '; pwd; printf 'bun --version: '; bun --version; rc=$?; printf 'exit_status=%s\n' "$rc"; exit "$rc"
```

The first `bun --version` check on `ck-motor` reported **1.4.2** (exit 0), the runner's default version. The runner's maintainer confirmed that automatic dependency installation before the job still uses Bun 1.4.2. The maintainer supplied `/usr/local/bin/bun-1.3.14` and reported verifying it against the official release `SHASUMS256`. This worker did not download or install that asset. The remote job verified `/usr/local/bin/bun-1.3.14 --version` as **1.3.14** (exit 0), then used a temporary private `PATH` symlink for plain `bun` commands. It explicitly verified 1.3.14 through both the binary and `PATH` before each build/test/typecheck entry. The initial direct registry attempt was stopped after `curl: (6) Could not resolve host: registry.npmjs.org`; no further outbound network request was made.

The remote job ran `bun-1.3.14 install --frozen-lockfile --offline` successfully: 517 installs across 570 packages, no changes. The Core build passed, copying 32 declaration assets and reporting a 99-module closure. The only test command was `bun test packages/opencode/src/setup/native-enrollment.test.ts packages/opencode/src/setup/native-paths.test.ts packages/opencode/src/setup/process-fence.test.ts`: 8 passed, 0 failed, 35 expectations across 3 files.

`bun run --cwd packages/opencode typecheck` failed (exit 1) under TypeScript 7.0.2 with five TS2339 diagnostics: missing `text` at `src/tests/account-command.test.ts:1008,1009,1029` and missing `knobs` at `src/tests/index.test.ts:754,760` on `CommandDialogPayload | OpenDialogPayload`. Both diagnostic files are unchanged relative to base `f27e80f`; neither is among the six merged paths. Scoped AFT diagnostics for `packages/opencode/src/setup` reported 0 errors and 0 warnings, with four `await`-has-no-effect hints in setup tests.

Raw output and statuses for the preflight and network attempts are in `tmp/offline-setup-integrated-check-20261009/remote-runs.txt`; the pinned job's raw output is in `tmp/offline-setup-integrated-check-20261009/remote-pinned-gates.txt`. Exact inline job bodies are preserved in `remote-command.sh` and `remote-pinned-command.sh`. Source-identity hashes and merge scope are recorded at `source-comparison.txt`. All evidence paths are relative to this verification worktree. They are under the repository's ignored `tmp/` directory and are not included in the report commit; the parent retains a separate copy.

## Gates and outcome

- `bun-1.3.14 install --frozen-lockfile --offline` — passed; Bun 1.3.14 reported `Checked 517 installs across 570 packages (no changes)`.
- `bun run --cwd packages/core build` — passed under verified Bun 1.3.14; output reported 32 published declaration assets and a 99-module, 287-edge closure.
- `bun test packages/opencode/src/setup/native-enrollment.test.ts packages/opencode/src/setup/native-paths.test.ts packages/opencode/src/setup/process-fence.test.ts` — passed under verified Bun 1.3.14; 8 tests across 3 files, 0 failures, 35 expectations.
- `bun run --cwd packages/opencode typecheck` — failed (exit 1) under TypeScript 7.0.2 with five TS2339 property errors in `src/tests/account-command.test.ts` and `src/tests/index.test.ts`. These files are unchanged from base and outside the six-file merge; the diagnostics do not name any changed setup path. No broader workaround was attempted.

The worktree preparation reported a successful `bun run build` before the reviewed setup helpers were integrated; that result is not used as evidence for this report. Before rerunning the OpenCode typecheck, `account-command.test.ts` must distinguish the legacy dialog payload before reading its `text` field; `index.test.ts` must do the same before reading `knobs`. The union also permits the new native menu payload, which has neither field. Both files are unchanged from the verification base; no pre-merge typecheck result was captured, so this run alone does not establish when the errors first appeared. No full test suites, application starts, live credentials, global toolchain installation, or runtime bump were used.
