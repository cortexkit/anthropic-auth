---
title: Fix fork core and OpenCode publish lane
type: fix
status: active
date: 2026-05-25
origin: docs/brainstorms/2026-05-25-fork-core-opencode-publish-requirements.md
deepened: 2026-05-25
---

# Fix fork core and OpenCode publish lane

## Overview

Prepare the fork release lane so `@marcusrbrown/anthropic-auth-core` and `@marcusrbrown/opencode-anthropic-auth` publish together at `1.2.2-mb.2`, with OpenCode resolving the forked core package and the published artifacts proving the PR #40 OAuth refresh fixes are present.

The work is a package identity + release integrity fix, not an OAuth behavior change. PR #40 is already in the fork; the missing piece is making the dependency graph and release artifacts match the forked package line.

## Problem Frame

The current fork publish only moved OpenCode to `@marcusrbrown/opencode-anthropic-auth@1.2.2-mb.1`. The shared core package still declares and resolves as `@cortexkit/anthropic-auth-core@1.2.2`, even though part of the PR #40 fix set landed in core (see origin: `docs/brainstorms/2026-05-25-fork-core-opencode-publish-requirements.md`).

That leaves the forked OpenCode install pinned to a fork package but dependent on an upstream-scoped core package. The next release must close that namespace/version gap without dragging Pi into the fork publish scope.

## Requirements Trace

- R1. Publish core as `@marcusrbrown/anthropic-auth-core`.
- R2. Set both fork packages to `1.2.2-mb.2`; do not publish core as `1.2.2-mb.1`.
- R3. Make OpenCode depend on `@marcusrbrown/anthropic-auth-core@1.2.2-mb.2`.
- R4. Keep package metadata, lockfile, imports, tests, and build outputs consistent with the forked core name where OpenCode consumes core.
- R5. Preserve synced `-mb.X` versions for the forked core + OpenCode publish pair going forward.
- R6. Build and dry-run/package both fork packages before publishing, including manifest/dependency inspection.
- R7. Publish core before OpenCode and require npm to resolve exact core version first.
- R8. Tie git tag, GitHub release, npm package versions, and npm tarballs to the same source revision.
- R9. Use the `mb` npm dist-tag for fork prerelease publishes unless intentionally promoting otherwise.
- R10. Remove fork-facing docs/metadata implications that users should consume `@cortexkit/anthropic-auth-core` for this release line.
- R11. Verify artifacts contain the PR #40 refresh fix set and do not retain stale OpenCode-to-core dependency metadata.
- R12. Verify a fresh install or equivalent dependency graph resolves OpenCode to forked core at the same version.
- R13. Keep Pi as `@cortexkit/pi-anthropic-auth`, outside fork publish scope; touch Pi only as needed for workspace tooling.
- R14. Limit CI/release workflow changes to supporting the fork core + OpenCode release lane.
- R15. Do not introduce release credential leakage.

## Scope Boundaries

- Do not change OAuth refresh behavior beyond carrying the already-cherry-picked PR #40 code into correctly published artifacts.
- Do not publish `@marcusrbrown/anthropic-auth-core@1.2.2-mb.1`.
- Do not publish Pi under `@marcusrbrown`.
- Do not redesign the release system or switch release tooling.
- Do not hide release risk behind local bundle checks; registry/package metadata must be verified.

## Context & Research

### Relevant Code and Patterns

- `packages/core/package.json` currently declares `@cortexkit/anthropic-auth-core@1.2.2`.
- `packages/opencode/package.json` already declares `@marcusrbrown/opencode-anthropic-auth@1.2.2-mb.1`, but still depends on `@cortexkit/anthropic-auth-core@1.2.2`.
- `packages/pi/package.json` remains `@cortexkit/pi-anthropic-auth@1.2.2` and depends on the current core package name.
- `packages/opencode/src/*` and `packages/opencode/src/tests/*` import `@cortexkit/anthropic-auth-core` directly.
- `packages/pi/src/*` imports `@cortexkit/anthropic-auth-core` directly.
- `scripts/version-sync.mjs` is the centralized version sync mechanism, but it hard-codes the old core package name and mutates core, OpenCode, and Pi together.
- `scripts/release.sh` gates releases with lint, typecheck, test, and build, then commits/tags/pushes.
- `.github/workflows/release.yaml` currently publishes packages in a matrix, which is unsafe for OpenCode because the forked core package must exist first.
- `scripts/wait-release.sh` currently watches `cortexkit/anthropic-auth`, not the fork repo.
- Root scripts already expose `pack:core:dry` and `pack:opencode:dry` for package dry-run checks.

### Institutional Learnings

- No `docs/solutions/` directory exists in this repo.
- Recent fork docs established `@marcusrbrown/opencode-anthropic-auth@1.2.2-mb.1`; this release extends that fork versioning pattern to core.

### External References

- npm scoped packages require `--access public` for public scoped publishes.
- npm prerelease/fork publishes should use an explicit dist-tag; use `mb` here.
- Publish dependencies before dependents; do not rely on workspace/matrix publish ordering.
- Verify packed contents and post-publish registry metadata rather than trusting local manifests alone.

## Key Technical Decisions

- **Rename core publicly and locally:** `packages/core/package.json` should declare `@marcusrbrown/anthropic-auth-core`; this is the package that will publish.
- **Treat core identity as full publish metadata, not just `name`:** core needs fork repository metadata and public publish affordances equivalent to OpenCode, including `publishConfig.access` and trusted-publishing readiness for `@marcusrbrown/anthropic-auth-core`.
- **Update Pi imports/dependency for local build only:** Pi remains `@cortexkit/pi-anthropic-auth` and is not published, but its core dependency/imports may need to point at `@marcusrbrown/anthropic-auth-core` so workspace typecheck/build still works after the core package rename. If this happens, it is a local fork-workspace compatibility choice, not a public Pi release decision.
- **Exclude Pi from fork publish/version sync:** version-sync should have explicit fork-lane semantics for the core + OpenCode publish set. Pi should not be bumped to `1.2.2-mb.2` unless implementation proves it is unavoidable, and Pi must still be excluded from publish jobs and artifact verification.
- **Use ordered release jobs:** replace matrix publishing with ordered core → verify core → OpenCode publishing. Prefer separate GitHub Actions jobs so trusted publishing still gets package-scoped OIDC tokens.
- **Treat CI version sync as validation, not hidden mutation:** the release tag commit should already contain the release versions, namespace graph, and lockfile. CI may verify sync state, but publish jobs should fail rather than publish tarballs created from uncommitted CI mutations.
- **Use least-privilege release permissions:** default workflow permissions should be read-only. Only publish jobs need `id-token: write`; only the GitHub release job needs `contents: write`. Do not add fallback npm token secrets.
- **Verify real artifacts before user-facing tag exposure:** pack/dry-run checks are necessary but not sufficient; the release lane must verify registry metadata, dist-tags, tarball/package metadata, and a clean dependency graph. For this fork lane, publish directly to `mb` only after exhaustive pre-publish tarball validation; a temporary staging tag is intentionally not the default because `mb` is already the fork prerelease channel and extra tag choreography increases recovery complexity.
- **Create/confirm the GitHub release after npm verification:** GitHub release creation should not mark the release successful before core/OpenCode publish and final artifact/install verification succeed.

## Open Questions

### Resolved During Planning

- **Should Pi be renamed or published under the fork scope?** No. Pi stays `@cortexkit/pi-anthropic-auth` and is excluded from fork publishing. Touch Pi only if needed to keep workspace tooling buildable after the core package rename.
- **Should release automation change before publishing `1.2.2-mb.2`?** Yes. The current matrix can publish OpenCode before core exists, so release automation needs ordered core/OpenCode publishing before this release is considered safe.
- **Should `mb` be used on reruns/partial recovery?** Yes. Reruns must verify and normalize dist-tags, not only skip already-published versions.

### Deferred to Implementation

- **Exact verification implementation:** The implementer may choose shell steps or a small script, but verification must inspect packed/published metadata and prove the dependency graph.
- **Exact source-level import grouping:** Final import organization should follow formatter/typechecker output after package-name rewrites.
- **npm scope readiness:** Confirm the `@marcusrbrown` scope and both package names are authorized for the chosen public trusted-publishing/provenance path before release day.

## Release Invariants

The release is go only if these invariants can be proven before publish and re-proven after publish:

- `@marcusrbrown/anthropic-auth-core@1.2.2-mb.2` is either absent or already published with verified expected metadata.
- `@marcusrbrown/opencode-anthropic-auth@1.2.2-mb.2` is either absent or already published with verified expected metadata.
- Core and OpenCode committed package manifests both declare version `1.2.2-mb.2`.
- OpenCode depends on `@marcusrbrown/anthropic-auth-core@1.2.2-mb.2`, not `@cortexkit/anthropic-auth-core`.
- Release jobs check out the tag commit and fail if `HEAD` differs from the release tag commit.
- Published npm `mb` dist-tags for both fork packages point to `1.2.2-mb.2`.
- `latest` is not changed for either fork package unless explicitly approved.
- Pi remains `@cortexkit/pi-anthropic-auth` and is not included in fork publish jobs.
- Git tag, GitHub release, package versions, package tarballs, workflow source revision, and provenance/source commit all refer to the same release revision.
- Release verification evidence is captured from npm registry/artifacts and clean install/dependency graph checks, not only from local workspace files.
- Verification evidence contains package names, versions, dist-tags, provenance/source revision, and dependency graph only; it excludes environment variables, auth config fields, HTTP headers, local credential paths, and full debug logs.

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

```mermaid
flowchart LR
  A[Prepare v1.2.2-mb.2] --> B[Sync fork core + OpenCode versions]
  B --> C[Build and pack-verify core + OpenCode]
  C --> D[Publish core with mb tag]
  D --> E[Verify core resolves from npm]
  E --> F[Publish OpenCode with mb tag]
  F --> G[Verify dist-tags, tarballs, dependency graph]
  G --> H[Create/confirm GitHub release]
```

## Implementation Units

- [ ] **Unit 1: Rewrite package identity and dependency graph**

**Goal:** Make the workspace consistently consume forked core while preserving Pi's public package identity.

**Requirements:** R1, R2, R3, R4, R10, R13

**Dependencies:** None

**Files:**
- Modify: `packages/core/package.json`
- Modify: `packages/opencode/package.json`
- Modify if required for workspace build: `packages/pi/package.json`
- Modify: `packages/opencode/src/cli.ts`
- Modify: `packages/opencode/src/index.ts`
- Modify: `packages/opencode/src/transform.ts`
- Modify: `packages/opencode/src/tests/*.ts`
- Modify if required for workspace build: `packages/pi/src/*.ts`
- Modify: `bun.lock`

**Approach:**
- Rename the core package to `@marcusrbrown/anthropic-auth-core` and set it to `1.2.2-mb.2`.
- Add fork repository metadata and public publish config to core so it is publish-ready under the `@marcusrbrown` scope.
- Set OpenCode to `1.2.2-mb.2` and point its dependency at `@marcusrbrown/anthropic-auth-core@1.2.2-mb.2`.
- Update source/test imports for OpenCode to use the forked core package name.
- Keep Pi package name/version out of the fork publish scope, but update its dependency/imports if required for TypeScript/Bun workspace resolution after core is renamed.
- Regenerate the lockfile through the repo's package manager so workspace resolution matches manifests.

**Execution note:** Add characterization checks before broad string replacement: capture the current list of old core imports, then verify the post-change list only contains allowed historical/docs references.

**Patterns to follow:**
- Existing package export fields in `packages/core/package.json` and `packages/opencode/package.json`.
- Existing TypeScript imports in `packages/opencode/src/*` and `packages/pi/src/*`.

**Test scenarios:**
- Integration: root typecheck sees OpenCode and Pi resolve `@marcusrbrown/anthropic-auth-core` after the core package rename.
- Integration: OpenCode package metadata declares `@marcusrbrown/anthropic-auth-core@1.2.2-mb.2`.
- Edge case: repo-wide search for `@cortexkit/anthropic-auth-core` leaves only allowed historical changelog/docs references, not OpenCode runtime dependency metadata.

**Verification:**
- Root typecheck/build succeeds.
- OpenCode tests still pass.
- The lockfile contains the forked core workspace package and no stale OpenCode dependency on the old core name.

- [ ] **Unit 2: Make version sync fork-aware**

**Goal:** Preserve synced fork versions for core + OpenCode without dragging Pi into the fork publish lane.

**Requirements:** R2, R3, R4, R5, R13, R14

**Dependencies:** Unit 1

**Files:**
- Modify: `scripts/version-sync.mjs`
- Create: `scripts/version-sync.test.ts`
- Modify: `package.json`

**Approach:**
- Replace hard-coded CortexKit package assumptions with explicit fork-lane semantics and a fork publish set: core + OpenCode.
- Keep dependency rewrite logic aware of `@marcusrbrown/anthropic-auth-core`.
- Make the script validate committed manifest state cleanly so CI does not silently publish uncommitted version-sync mutations.
- Avoid bumping Pi to the fork release version unless implementation proves workspace tooling cannot function otherwise.
- Add lightweight tests around version-sync behavior using temporary package fixtures rather than mutating real package manifests.
- Update the root test script, or add an equivalent script invoked by the release validation path, so `scripts/version-sync.test.ts` actually runs in normal validation while preserving existing OpenCode test coverage.

**Patterns to follow:**
- Existing CLI-style argument parsing and dry-run behavior in `scripts/version-sync.mjs`.
- Existing Bun test style in `packages/opencode/src/tests/*.ts`.

**Test scenarios:**
- Happy path: syncing `1.2.2-mb.2` updates fork core + OpenCode versions and OpenCode's forked core dependency.
- Edge case: dry-run reports intended changes without writing fixture files.
- Edge case: Pi package metadata is not bumped/published by default.
- Error path: invalid semver still exits non-zero.

**Verification:**
- The new version-sync tests pass.
- `scripts/version-sync.mjs 1.2.2-mb.2 --dry-run` reports the expected fork pair behavior.

- [ ] **Unit 3: Order and harden the release workflow**

**Goal:** Make CI publish core before OpenCode, always with the `mb` tag and artifact verification gates.

**Requirements:** R6, R7, R8, R9, R11, R12, R14, R15

**Dependencies:** Units 1 and 2

**Files:**
- Modify: `.github/workflows/release.yaml`
- Modify: `scripts/release.sh`
- Modify: `scripts/wait-release.sh`

**Approach:**
- Replace matrix publishing with ordered publish jobs or equivalent sequencing: test → publish core → verify core → publish OpenCode → verify final release state.
- Ensure every publish/verification job checks out the exact tag commit and fails if the checked-out revision does not match the release tag.
- Keep trusted publishing package-scoped by using separate publish jobs where possible.
- Restrict workflow permissions so only publish jobs can request OIDC tokens and only the GitHub release job can write release contents.
- Require npm trusted-publishing package mappings or environments to bind the expected repo, workflow, job/environment, and package name for `@marcusrbrown/anthropic-auth-core` and `@marcusrbrown/opencode-anthropic-auth`.
- Add `--tag mb` to fork prerelease publishes.
- Ensure already-published checks do not skip verification or dist-tag reconciliation.
- Fail if committed manifests/lockfile do not already match the release version and namespace graph.
- Update release script messaging for the fork lane and allow `marcusrbrown/main` as the expected release branch/default branch shape.
- Update wait-release repo targeting to the fork repo, or make it configurable with the fork as default.
- Move GitHub release creation/confirmation behind successful npm publish and final artifact/install verification.

**Go/No-Go gates:**
- Before publishing core, verify fork package manifests, lockfile, OpenCode dependency metadata, Pi publish exclusion, trusted publishing/provenance configuration, and secret-free logs/artifacts.
- After publishing core, before publishing OpenCode, verify exact core registry resolution, public visibility, `mb` dist-tag, provenance/source commit if expected, and tarball metadata.
- OpenCode publish is no-go if any core registry or tarball check fails.
- Rerun publish is no-go if an already-published core package fails the full expected-metadata, provenance/source, dist-tag, and tarball-content checks.

**Patterns to follow:**
- Existing `release.yaml` setup/test/build structure.
- Existing `scripts/release.sh` pre-release gating and version-sync handoff.
- Existing `scripts/wait-release.sh` polling shape.

**Test scenarios:**
- Config scenario: workflow publishes core and OpenCode in dependency order, not a parallel matrix.
- Config scenario: publish steps include public access, provenance, and `mb` dist-tag.
- Recovery scenario: if core already exists, workflow still verifies core registry state before OpenCode publish.
- Recovery scenario: if a version already exists, workflow still verifies or normalizes dist-tags instead of silently succeeding.
- Security scenario: non-publish jobs do not have `id-token: write`, and no fallback npm token secret is introduced.
- Source integrity scenario: publish jobs fail when the checked-out commit differs from the release tag commit.

**Verification:**
- Workflow YAML remains syntactically valid.
- Release dry-run still previews version sync without committing.
- Release script output no longer claims Pi is published in the fork lane.
- GitHub release creation does not run before final npm artifact verification succeeds.

- [ ] **Unit 4: Add artifact and install-graph verification**

**Goal:** Prove the release artifacts, not just local manifests, contain the intended package names, versions, dependencies, and PR #40 fix content.

**Requirements:** R6, R8, R11, R12, R15

**Dependencies:** Units 1-3

**Files:**
- Modify: `package.json`
- Modify: `.github/workflows/release.yaml`
- Create or modify: `scripts/*`

**Approach:**
- Add reusable verification for packed manifests/tarballs that checks package name, version, dependency metadata, and expected file inclusion.
- Include a clean install or dependency-graph smoke check for OpenCode resolving forked core at `1.2.2-mb.2`.
- Include a behavior-oriented artifact check that the PR #40 refresh fix set is present in core/OpenCode artifacts. Prefer a synthetic/mocked refresh-flow smoke check against packed or installed artifacts plus artifact metadata checks over brittle source-line assertions.
- Exercise the deterministic mocked refresh seam from the packed or installed artifact when feasible: the check should hit the refresh flow without real OAuth credentials and assert the expected refreshed-token behavior introduced by PR #40. If that seam cannot be reused cleanly, artifact verification must at minimum scan built package contents for the package metadata and non-secret behavioral markers that changed in PR #40, and document the weaker proof before release.
- Keep verification free of npm tokens or secret output.

**Patterns to follow:**
- Existing root package pack scripts.
- Existing release workflow verification style using npm registry queries.

**Test scenarios:**
- Happy path: packed core artifact reports `@marcusrbrown/anthropic-auth-core@1.2.2-mb.2`.
- Happy path: packed OpenCode artifact reports dependency on `@marcusrbrown/anthropic-auth-core@1.2.2-mb.2`.
- Error path: verification fails if OpenCode package metadata references `@cortexkit/anthropic-auth-core`.
- Error path: verification fails if any forked core/OpenCode packed artifact contains `@cortexkit/anthropic-auth-core` outside explicitly allowed historical documentation.
- Integration: clean install/dependency graph resolves OpenCode to forked core at the same version.
- Security: verification evidence redacts or excludes authorization headers, refresh tokens, account IDs, npm auth config, token-like values, and local credential paths.

**Verification:**
- Verification script or workflow step fails closed on stale namespace/version metadata.
- Local dry-run package checks succeed for core and OpenCode.
- Verification fails closed if package names, versions, dependencies, required runtime/declaration files, PR #40 fix evidence, or credential hygiene checks do not match the release invariants.

- [ ] **Unit 5: Update fork-facing docs and release notes**

**Goal:** Make public docs and changelogs reflect the core + OpenCode fork publish pair and the `1.2.2-mb.2` install pin.

**Requirements:** R2, R7, R9, R10, R13

**Dependencies:** Units 1-4

**Files:**
- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Modify: `packages/core/README.md`
- Modify: `packages/opencode/README.md`
- Modify: `packages/opencode/CHANGELOG.md`
- Modify only if fork-facing guidance is stale: `packages/pi/README.md`
- Modify if fork-facing guidance is stale: `packages/e2e-tests/README.md`

**Approach:**
- Update fork-facing package names and install pins to `1.2.2-mb.2`.
- Document that the fork release pair is core + OpenCode; Pi remains upstream-scoped and out of fork publishing.
- Keep historical changelog entries for CortexKit/upstream releases intact, but avoid making current fork install guidance point at upstream core.
- Ensure release notes for `1.2.2-mb.2` mention the core package publish and dependency graph fix, not only OpenCode.

**Patterns to follow:**
- Existing fork note style in `README.md` and `packages/opencode/README.md`.
- Existing changelog format in `CHANGELOG.md` and `packages/opencode/CHANGELOG.md`.

**Test scenarios:**
- Docs scenario: repo-wide docs search shows current install guidance uses `@marcusrbrown/opencode-anthropic-auth@1.2.2-mb.2`.
- Docs scenario: current fork package tables include `@marcusrbrown/anthropic-auth-core` where core is described.
- Edge case: historical changelog mentions of `@cortexkit/anthropic-auth-core` remain clearly historical.

**Verification:**
- Repo-wide grep confirms stale fork-facing core references are removed or explicitly historical.
- Documentation references match package manifests and npm publish plan.

- [ ] **Unit 6: Execute release validation and publish `1.2.2-mb.2`**

**Goal:** Complete the release only after all local and registry verification gates pass.

**Requirements:** R2, R6, R7, R8, R9, R11, R12, R15

**Dependencies:** Units 1-5

**Files:**
- Modify: package/release files changed by Units 1-5 only

**Approach:**
- Run the repo's pre-release validation suite after implementation.
- Confirm core and OpenCode dry-run/package contents before publishing.
- Publish/tag using the fork release lane so core lands before OpenCode.
- Verify npm package versions, dist-tags, package visibility, Git tag, GitHub release, and clean install/dependency graph after publish.
- If a partial publish occurs, rerun idempotently: verify already-published core, fix tags if needed, then continue with OpenCode.
- If package contents are wrong after publish, stop and recover forward with a new fork version; do not attempt to overwrite immutable npm artifacts.

**Patterns to follow:**
- Existing fork release convention: npm version `1.2.2-mb.2`, git/GitHub release tag `v1.2.2-mb.2`, npm dist-tag `mb`.

**Test scenarios:**
- Release scenario: core exists at `1.2.2-mb.2` before OpenCode publish starts.
- Release scenario: both fork packages expose `mb -> 1.2.2-mb.2` after publish.
- Release scenario: installing `@marcusrbrown/opencode-anthropic-auth@1.2.2-mb.2` resolves fork core at `1.2.2-mb.2`.
- Recovery scenario: if OpenCode publish fails after core publish, rerun does not republish core but still verifies it before proceeding.
- Recovery scenario: if any package already exists with invalid immutable metadata, the release stops and a new fork version is required.

**Verification:**
- Local validation, workflow validation, npm registry checks, and install smoke check all pass before the release is considered done.

## System-Wide Impact

- **Interaction graph:** package manifests, lockfile, source imports, version-sync script, release workflow, docs, and npm registry state must agree on the forked core package name.
- **Error propagation:** release automation should fail closed when core is not resolvable, dependency metadata is stale, dist-tags are wrong, or artifact checks fail.
- **State lifecycle risks:** npm publishes are immutable; a bad `name@version` cannot be overwritten, so pre-publish artifact checks matter more than post-hoc fixes.
- **API surface parity:** runtime code should remain behaviorally unchanged; only package identity/dependency resolution changes.
- **Integration coverage:** unit tests alone do not prove publish correctness; pack/tarball inspection and clean install graph checks are required.
- **Unchanged invariants:** Pi remains a CortexKit-named package and is not published in the fork lane.

## Release Go/No-Go Checklist

### Pre-Publish Required

- Implementation Units 1-5 are complete.
- Local package manifests, lockfile, source imports, tests, and docs agree on fork core + OpenCode at `1.2.2-mb.2`.
- Core package artifact inspection passes.
- OpenCode package artifact inspection passes.
- OpenCode artifact declares dependency on `@marcusrbrown/anthropic-auth-core@1.2.2-mb.2`.
- PR #40 fix presence is verified from packed or installed artifacts without real OAuth credentials.
- Clean install/dependency graph check passes against package artifacts or the registry candidate.
- Release workflow source revision matches the intended git tag/release revision.
- Trusted publishing/provenance path is confirmed for both fork package names.
- No secret/token output appears in release logs or artifacts.
- Partial-publish recovery plan has been reviewed.

### Publish Sequence

- Publish core package only.
- Verify core registry metadata, visibility, dist-tag, provenance/source commit, and tarball metadata.
- Publish OpenCode package only.
- Verify OpenCode registry metadata, visibility, dist-tag, provenance/source commit, and tarball metadata.
- Verify fresh install graph resolves OpenCode to forked core at the same version.
- Confirm git tag and GitHub release match npm package versions and release revision.

### Post-Publish Required

- Both fork packages resolve at `1.2.2-mb.2`.
- Both `mb` dist-tags point to `1.2.2-mb.2`.
- Neither `latest` dist-tag changed unintentionally.
- OpenCode dependency metadata does not reference `@cortexkit/anthropic-auth-core`.
- Installed dependency graph contains `@marcusrbrown/anthropic-auth-core@1.2.2-mb.2`.
- Published artifacts include the expected PR #40 fix content.
- Release evidence is recorded without secrets before closing the issue.

## Partial Publish Recovery

| State | User Impact | Allowed Recovery | Forbidden Action |
|------|-------------|------------------|------------------|
| Nothing published | None | Fix locally and retry full release | None |
| Core published, OpenCode not published | Low; core is unused unless installed directly | Continue only after full core metadata/tags/provenance/source/tarball contamination check passes, then publish OpenCode | Do not attempt to overwrite core or publish OpenCode against uncertain core state |
| Core published with wrong `mb` tag only | Medium; tag installs may resolve wrong version | Move `mb` tag to `1.2.2-mb.2` after verifying package metadata | Do not republish same version |
| Core published with wrong package metadata | High; immutable bad package | Stop release and cut a new fork version after documenting the contaminated version | Do not publish OpenCode against known-bad core |
| OpenCode published, core missing/unresolvable | Critical; broken install graph | Stop and recover only if exact expected core metadata can still be satisfied; otherwise cut a new OpenCode version | Do not promote `latest`; do not hide the broken version |
| Both published, wrong dist-tag | Medium | Correct dist-tags and verify install graph | Do not republish same versions |
| Both published, OpenCode depends on upstream core | Critical; release failed invariant | Deprecate or bury bad version if appropriate and release a new fork version | Do not claim `1.2.2-mb.2` succeeded |

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| OpenCode publishes before forked core exists | Ordered release jobs with an explicit core registry resolution gate before OpenCode publish |
| Pi breaks after core package rename | Update Pi dependency/imports only enough to keep workspace builds passing; do not rename or publish Pi |
| Dist-tag accidentally points users at the wrong release | Always publish with `--tag mb` and verify/reconcile dist-tags after publish |
| Published tarball metadata differs from local manifests | Inspect packed/published package metadata and run a clean install/dependency graph check |
| Release workflow rerun skips already-published packages and hides bad state | Reruns must still verify artifacts and tags even when publish is skipped |
| npm credential leakage | Keep auth in npm/GitHub trusted publishing paths; never write tokens to repo files, logs, docs, or release notes |
| Publish jobs inherit broader permissions than needed | Scope `id-token: write` to publish jobs and `contents: write` to the GitHub release job only |
| Bad immutable package metadata is published | Treat the version as contaminated and recover forward with a new fork version |
| Pi accidentally enters fork publish lane | Add release/version-sync assertions that Pi is never in the publish set, never receives fork dist-tags, and is verified only for build compatibility |

## Documentation / Operational Notes

- Release notes for `v1.2.2-mb.2` should explicitly say the fork now publishes both core and OpenCode, and OpenCode depends on forked core.
- Keep `@cortexkit/*` mentions only where they are historical or Pi-specific.
- After release, record exact npm view/dist-tag/install verification evidence before considering the issue closed.
- Immediately after publish, verify npm metadata, dist-tags, clean install graph, GitHub release/source trace, and secret hygiene. Recheck later only if user reports or registry state looks unstable; do not turn this scoped fix into an ongoing release-monitoring program.
- If verification logs or evidence include real secrets, treat it as an incident: stop publishing, rotate affected credentials, and remove exposure where possible before continuing.

## Sources & References

- **Origin document:** [docs/brainstorms/2026-05-25-fork-core-opencode-publish-requirements.md](../brainstorms/2026-05-25-fork-core-opencode-publish-requirements.md)
- Related code: `packages/core/package.json`
- Related code: `packages/opencode/package.json`
- Related code: `packages/pi/package.json`
- Related code: `scripts/version-sync.mjs`
- Related code: `scripts/release.sh`
- Related code: `scripts/wait-release.sh`
- Related code: `.github/workflows/release.yaml`
- Related code: `bun.lock`
- Related PR: `cortexkit/anthropic-auth#40`
