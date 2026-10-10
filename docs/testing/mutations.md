# Mutation proofs for request guards

`mutations.toml` records ten deliberately bounded runtime breaks against named
assertions. Run it only in an isolated checkout: `ckdev-mutate` edits its working
checkout; it does **not** create a scratch worktree. Never reset/check out a target
while replay is active, and never point builds at a live host installation.

## Toolchain and scope

Use Bun **1.3.14** and **ckdev-mutate 0.9.2**, pinned to the [CortexKit Commons repository](https://github.com/cortexkit/commons)
at `b491012199d98b09fd167e00783df297d35a62b8` (the reviewed release).
`ckdev-mutate 0.9.2` passes descriptive test names as single arguments, including
interior spaces, and reads JUnit results from the full owning-package test run.
The rows need no alternate test names or compatibility layer.

Install the runner under the checkout-local ignored directory
`node_modules/.cache/ckdev-mutate-0.9.2`. Keep `CARGO_HOME`, `CARGO_TARGET_DIR` and the
install `--root` there, and do not overwrite a global executable. The command
below installs ckdev-mutate 0.9.2 from that exact source revision:

```sh
CARGO_HOME="$PWD/node_modules/.cache/ckdev-mutate-0.9.2/cargo-home" \
CARGO_TARGET_DIR="$PWD/node_modules/.cache/ckdev-mutate-0.9.2/target" \
cargo install --locked --git https://github.com/cortexkit/commons \
  --rev b491012199d98b09fd167e00783df297d35a62b8 \
  --root "$PWD/node_modules/.cache/ckdev-mutate-0.9.2/install" cortexkit-mutate
```

Verify that `ckdev-mutate --version` reports 0.9.2 and its Cargo install metadata
records revision `b491012199d98b09fd167e00783df297d35a62b8`. Put its install `bin`
directory and Bun 1.3.14 on `PATH`, including for nested build scripts.

These proofs send no HTTP requests to model providers and use no real credentials.
They do not change existing application tests, CI workflows, dependencies or
sibling repositories.

| Control | Runtime break | Existing assertion |
| --- | --- | --- |
| `history-refuses-meaningful-assistant` | Treat meaningful assistant trailers as removable empty trailers. | `refuses unknown or meaningful content 0 without mutating history` in Core request-history tests. |
| `fast-excludes-opus-46-47` | Widen `claude-opus-4-8` to `claude-opus-4-`, incorrectly enabling fast mode for Opus 4.6 and 4.7. | Core asserts that fast mode is not supported for Opus 4.6, 4.7 and `4.7[1m]`. |
| `thinking-binding-excludes-api-key` | Call `applyThinkingBindingControls(body, 'drop_block')` even when Pi has no OAuth identity, bypassing the check that excludes API-key routes. | `buildAnthropicRequest — Fable/Mythos thinking > does not add Fable 5.1 binding controls to an API-key request`. |
| `header-routing-current-credential-epoch` | Accept pending quota from a replaced login. | The next request must use the replacement OAuth token, not a paid API key. |
| `header-routing-raw-exhaustion-proof` | Treat raw utilization of 0.995 as exhausted. | Display rounding must not permit paid API fallback. |
| `local-quota-survives-token-refresh` | Reject writes containing only quota when the token rotates, although the account UUID and credential epoch are unchanged. | The account's quota must survive refresh; writes containing other metadata must still require the original token version. |
| `local-metadata-requires-token-version` | Apply the account-only quota exception to writes that also contain other metadata. | Writes containing metadata from the old token must still be refused after refresh, even when they also contain quota. |
| `runtime-read-no-follow` | Follow a symlink installed between inspection and opening. | The runtime reader must reject the symlink. |
| `runtime-read-opened-mode` | Ignore the opened file's permissions. | A replacement with mode 0644 must be rejected. |
| `runtime-read-opened-owner` | Ignore the opened file's owner. | A foreign owner on the opened handle must be rejected. |

The `thinking-binding-excludes-api-key` guard is owned by Pi's converter at its
`applyThinkingBindingControls` call boundary. Pi imports the built Core helper,
which has no credential-route parameter. Changing Core's `account-default`
behavior alone would not reach Pi's API-key assertion because Pi never calls
`applyThinkingBindingControls` without an OAuth identity. The mutation adds that
call outside the identity gate while leaving OAuth metadata untouched.

## Current-source builds and exact dispatch

The root `prebuild` in `mutations.toml` runs `bun run --cwd packages/core build` from the
Git root. Replay rebuilds Core from the current clean source before baselines,
from the current mutated source before each mutation's test dispatch, and from
the exactly restored source at session end. Pi converter tests import Core's
dist. Reusing clean-source dist for a mutant is not evidence that the intended
assertion caught the mutation.
Run Core and host tests sequentially, never concurrently with another Core build.

Named commands receive the fixed repository-relative test-file path and the full
Bun descriptive name as separate argv elements, with no shell interpolation:

```sh
bun scripts/run-mutation-bun.ts packages/core/src/tests/fast.test.ts \
  'fast mode eligibility for claude-opus-4-7[1m] is false'
```

The wrapper accepts only the five reviewed owning test files. It rejects empty,
control-character and boundary-whitespace names and unsafe/unsupported paths.
Bun prints nested scopes separated by ` > `, but its name filter joins those
scopes with spaces. The wrapper applies that observed convention, escapes regex
metacharacters, and anchors the entire filter. The printed result must still
match the original descriptive name exactly.

Each child uses the real Bun executable, explicit package cwd and package
`bunfig.toml`. Existing package preloads remain active. Import-time defaults are
sandboxed before spawn, inherited host overrides are cleared, and the sandbox is
removed only after child exit and both pipes settle. Cancellation kills owned
child work before waiting for those joins. No global timers are replaced.

Raw stdout/stderr stay on their original pipes. A single `CKDEV executed 1 tests`
record is emitted only for a verified pinned-Bun result with exactly one executed
test, matching pass/fail totals, a positive assertion count, the intended exact
name and a normal 0/1 status. A failing result must contain the selected normal
`expect` assertion diagnostic. Compilation/import/build errors, hook errors, timeouts,
crashes, signals, spawn failures, extra tests and ambiguous/zero summaries refuse
with status **126**. These failures are not evidence that the intended assertion
caught the mutation. Filtered, discovered and skipped tests are not counted.
At the end of a run with multiple failures, Bun prints each failed result again.
The wrapper compares these repeated lines with the original failure lines and
does not count them as additional test executions.

## Proof procedure and retained evidence

Run `scripts/tests/run-mutation-bun.test.ts` and the scripts typecheck:

```sh
bun test scripts/tests/run-mutation-bun.test.ts
./node_modules/.bin/tsc -p tsconfig.scripts.json
```

Keep the first raw stdout, stderr and exit status for every baseline, mutant and
restored run in an ignored checkout directory such as `tmp/mutation-proof`.
Record each target's original SHA-256, and compare the restored source bytes with
the original Git bytes as well as the hash. Each mutation anchor must occur
exactly once. `NON-VACUITY BREAK` comments appear in the catalogue's replacement
strings to mark temporary mutants; they must not remain in restored source.

For direct proofs, stage the exact live targets first, verify an empty unstaged
`git diff --stat`, apply one catalogue mutation and retain its non-empty diff.
Rebuild `packages/core` from the current mutated source, run every named expected assertion,
and independently run healthy companion assertions. Restore only after dispatch is finished with
`git checkout -- <target> && touch <target>`, verify empty unstaged diff and the
original source hash, then rebuild Core from the restored source. Never use stash.

The history companion checks that only provably empty trailing assistant messages
are removed from the owned history array, preserving the preceding user message.
Other healthy companions verify that fast mode remains supported for Opus
4.8/5/5.5 and that Pi still adds binding controls to signed-thinking OAuth
requests:
`buildAnthropicRequest — Fable/Mythos thinking > adds Fable 5.1 binding controls when compacted history replays signed thinking`.

A named-only proof does **not** observe package breadth. Under `--broad`, each
row runs its full owning unit directory: Core, OpenCode or Pi. Each uses its own
package cwd/config in a separate sequential Bun process and requires a clean
current baseline. These are unit-package domains, not workspace or E2E audits.
Core guards also affect OpenCode and Pi; auditing Core alone does **not** prove
absence of host/workspace collateral.

The supported fields are `broad_command`, `broad_report` and `broad_id = "{name}"`.
Bun creates fresh JUnit XML at the owning package's `tmp/mutations/core.xml`,
`tmp/mutations/opencode.xml` or `tmp/mutations/pi.xml`.
The runner deletes the selected report before every invocation and validates the
complete XML, expected identities and baseline failures. Missing, empty, garbage,
ambiguous or mismatched reports are refused. Such reports are not evidence that
the intended assertion caught the mutation.

### JUnit identity normalization

Real Bun 1.3.14 XML uses a leaf `name` and a describe `classname`; top-level tests
have an empty classname. Core has three duplicated leaf names in different
classes, and Pi has two repeated table-test names where Bun leaves `%s` unexpanded.
One unconditional `{classname} > {name}` template would also prepend ` > ` to
Core's top-level row IDs. The wrapper therefore changes **only** each testcase's
`name` attribute to the full descriptive name (a nonempty classname followed by
` > ` and the leaf, otherwise the leaf alone). Classnames, suite totals, case
order, statuses, failure/error bodies and all other bytes remain unchanged.

Before changing name attributes or emitting a verified count, the wrapper compares
every testcase with the corresponding observed console event in execution order:
the source file, full descriptive name, pass/fail outcome and occurrence number
must agree. Matching aggregate counts alone are insufficient. XML that erases a
failure, moves it to another test or changes case identities returns 126; its raw
console output and original XML are retained without publishing a normalized
report. The source line used in a duplicate ID comes from Bun's original JUnit
attribute, and the occurrence is checked against the observed console order.

Repeated full names receive a deterministic document-order suffix:
` [case N at file:line]`. This distinguishes Bun's repeated table-case occurrences,
not their parameter values. No alias table or production test rename is involved.
The three rows' expected names are unique and remain exactly unchanged. A repeated
expected name would lose that exact identity and the runner must refuse it as
missing, rather than guess which occurrence guards the row. Final normalized-ID
collisions also refuse. Self-tests cover these collisions, native row identity,
entities, dollar punctuation and byte-preservation of failure bodies. Complete
XML structural validation remains the official runner's responsibility.

The wrapper retains raw and normalized XML, matched IDs, argv/cwd/status and raw
child stdout/stderr in separate invocation folders under `tmp/mutations/audits`.
A successful JUnit audit sets the runner JSON field `breadth_observed` to `true`.
Command-row targets are
exactly JUnit classnames (including the empty Core top-level classname), not
files. Same-class collateral remains CAUGHT; other classes can yield
CAUGHT_BROADLY. Those observed failures are evidence, not a claim of unchanged
behavior outside the declared package.

The verified `history-refuses-meaningful-assistant` replay also fails 13 other
Core assertions in the same empty JUnit classname, while the empty-assistant
removal companion stays green. The `fast-excludes-opus-46-47` and
`thinking-binding-excludes-api-key` replays have no newly red collateral in their
declared unit-package audits. All three rows are CAUGHT; these outcomes do not
extend the coverage domains above.

Run the final supported gates sequentially:

```sh
ckdev-mutate --version
ckdev-mutate check
ckdev-mutate run --all --broad --report tmp/mutations/rows.json
```

Retain the first raw output when a check fails, diagnose the failure before
rerunning an affected check, and do not treat compile errors, timeouts or crashes
as evidence that the intended assertion caught the mutation.

Keep a durable archive of the raw console transcripts and original report bytes,
the source hashes and exact-byte restoration checks, the staged source diff, and
the runner's row reports. Store the archive outside ephemeral build caches so
reviewers can inspect the evidence and source comments before a commit. CI
integration is separate from this catalogue.

## Automated replay

The read-only `Mutation guards` workflow uses a separate checkout from the regular
CI job. Pull requests run `ckdev-mutate run --diff <base>`, comparing the committed
base to `HEAD`. The runner selects changed row targets, guarding test files and
parsed catalogue entries. Root prebuild changes also select all rows.

Changes to the Bun wrapper, its self-tests, the CI driver/workflow or shared test
configuration force `--all`, because the runner does not follow helper dependencies.
Main pushes run all named checks. Scheduled and manually requested jobs also use
`--broad` for full Core/Pi package audits. These domains still exclude OpenCode,
workspace-wide and process E2E collateral.

The CI driver verifies the runner version and requires tests to detect each
mutation (`CAUGHT`, `CAUGHT_BROADLY` or `HUB`), rather than accepting skipped or
equivalent rows. Full replays must report every configured row. A PR with no affected
rows may report an empty selection; it is not recorded as a caught mutation.
Reports, invocation/status records and raw test evidence are uploaded even when
a replay fails. Runner installation is pinned to the public commons revision and
kept in checkout-local ignored storage; no private repository token is required.
