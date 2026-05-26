---
date: 2026-05-25
topic: fork-core-opencode-publish
---

# Fork Core and OpenCode Publish Requirements

## Summary

Set up the fork so `@marcusrbrown/anthropic-auth-core` and `@marcusrbrown/opencode-anthropic-auth` can be published together at `1.2.2-mb.2`, preserving upstream-style synced versions while making the PR #40 OAuth refresh fixes available through the forked OpenCode plugin.

---

## Problem Frame

The first fork publish shipped `@marcusrbrown/opencode-anthropic-auth@1.2.2-mb.1`, but the shared core package remained named and referenced as `@cortexkit/anthropic-auth-core@1.2.2`. Some PR #40 OAuth refresh fixes landed in core, so the current forked OpenCode package can still be tied to the upstream core package instead of a fork-controlled core publish. That is the pre-change problem state, not an acceptable outcome for the next fork release.

This creates a release integrity problem: the OpenCode fork version suggests the PR #40 fix set is fork-owned and pinned, but part of the executable dependency chain is still outside the fork namespace and has no matching `-mb.X` release.

---

## Actors

- A1. Fork maintainer: Publishes and verifies fork packages under the `@marcusrbrown` npm scope.
- A2. OpenCode plugin user: Installs a pinned fork package expecting the PR #40 refresh fixes to be included.
- A3. Release automation: Builds, versions, and publishes packages from the monorepo release lane.
- A4. Pi package: The existing `@cortexkit/pi-anthropic-auth` workspace package that consumes the shared core package but is not part of this fork publish scope.

---

## Key Flows

- F1. Synced fork publish
  - **Trigger:** A new fork release is needed after PR #40 has been applied.
  - **Actors:** A1, A3
  - **Steps:** Prepare both fork package manifests for the same `-mb.X` version, update dependency and lockfile metadata, verify package contents, publish core first, confirm npm can resolve the exact core version, publish OpenCode second, tag and release from the same source revision with the matching version.
  - **Outcome:** npm exposes both fork packages at `1.2.2-mb.2`, and OpenCode depends on the forked core package at the same version with verified PR #40 fix content.
  - **Covered by:** R1, R2, R3, R4, R6, R7, R8, R11, R12

- F2. Pinned OpenCode install
  - **Trigger:** A2 installs `@marcusrbrown/opencode-anthropic-auth@1.2.2-mb.2`.
  - **Actors:** A2
  - **Steps:** npm resolves the OpenCode package, resolves its core dependency, and a fresh install/smoke check runs the plugin/runtime using the PR #40 refresh behavior.
  - **Outcome:** The installed dependency graph uses `@marcusrbrown/anthropic-auth-core@1.2.2-mb.2` rather than `@cortexkit/anthropic-auth-core`.
  - **Covered by:** R2, R3, R5, R8, R11, R12

---

## Requirements

**Package identity and versioning**
- R1. The core package must be publishable as `@marcusrbrown/anthropic-auth-core`.
- R2. The next fork release must set both `@marcusrbrown/anthropic-auth-core` and `@marcusrbrown/opencode-anthropic-auth` to `1.2.2-mb.2`; core intentionally skips `1.2.2-mb.1`.
- R3. OpenCode must depend on `@marcusrbrown/anthropic-auth-core@1.2.2-mb.2` for the `1.2.2-mb.2` publish.
- R4. The package metadata, workspace lockfile, source imports, tests, and declaration/runtime build outputs must consistently use the forked core package name where OpenCode consumes core.
- R5. The release process must preserve upstream-style synced versions for the forked core + OpenCode publish pair going forward.

**Release lane**
- R6. The fork release lane must build and dry-run/package both fork packages before publishing, including inspection of packed manifests and dependency metadata.
- R7. The publish order must make the core package available and npm-resolvable at `@marcusrbrown/anthropic-auth-core@1.2.2-mb.2` before publishing OpenCode.
- R8. The git tag, GitHub release, npm package versions, and npm tarballs must all correspond to the same source revision as `v1.2.2-mb.2` / `1.2.2-mb.2`.
- R9. Fork prerelease publishes must use the `mb` npm dist-tag unless intentionally promoted otherwise.
- R10. The package metadata, docs, and release notes must no longer imply that forked OpenCode users should consume `@cortexkit/anthropic-auth-core` for this release line.
- R11. The release verification must prove the packed or published artifacts include the PR #40 refresh fix set and do not retain stale OpenCode-to-core dependency metadata.
- R12. A fresh install or equivalent dependency-graph smoke check must verify `@marcusrbrown/opencode-anthropic-auth@1.2.2-mb.2` resolves `@marcusrbrown/anthropic-auth-core@1.2.2-mb.2`.

**Scope control**
- R13. Pi should remain `@cortexkit/pi-anthropic-auth` and outside the fork publish scope; if release tooling must touch Pi metadata, it must preserve Pi's public package identity and exclude Pi from fork publishing.
- R14. CI/release workflow changes should be limited to supporting the fork core + OpenCode release lane, not redesigning the upstream release system.
- R15. Release credential handling must use the existing trusted npm auth path without adding tokens to repo files, logs, docs, or release notes.

---

## Acceptance Examples

- AE1. **Covers R1, R2, R7.** Given no existing npm package for `@marcusrbrown/anthropic-auth-core`, when the `1.2.2-mb.2` release is prepared, core is published first as a public package at `1.2.2-mb.2` and `npm view @marcusrbrown/anthropic-auth-core@1.2.2-mb.2` resolves before OpenCode publish begins.
- AE2. **Covers R2, R3, R4, R6.** Given `@marcusrbrown/opencode-anthropic-auth@1.2.2-mb.2` is packed or published, when its dependency metadata and lockfile-derived install graph are inspected, they reference `@marcusrbrown/anthropic-auth-core@1.2.2-mb.2`.
- AE3. **Covers R8.** Given the release is complete, when npm, git tags, GitHub releases, and npm tarball metadata are inspected, the visible release identifiers all use `1.2.2-mb.2` with no mismatched `1.2.2-mb.1` core release or source revision drift.
- AE4. **Covers R11, R12.** Given the release artifacts are packed or published, when a fresh install or dependency-graph smoke check is run, it verifies the forked OpenCode package resolves the forked core package and contains the PR #40 refresh fix set.
- AE5. **Covers R13, R14.** Given the release lane is updated, when reviewing the diff, Pi remains `@cortexkit/pi-anthropic-auth` and is not published as a fork package.
- AE6. **Covers R9.** Given the release is published, when npm dist-tags are inspected, `mb` points to `1.2.2-mb.2` for the forked packages unless an explicit promotion decision was made.

---

## Success Criteria

- Installing `@marcusrbrown/opencode-anthropic-auth@1.2.2-mb.2` resolves a fork-controlled core dependency containing the PR #40 refresh fixes.
- The release handoff is explicit enough that planning does not need to invent package names, version numbers, publish order, or scope boundaries.
- Future fork releases can continue with synced `-mb.X` versions without repeating one-off manual edits.
- Published artifacts can be traced back to the same source revision and verified from npm, not just from local package manifests.

---

## Scope Boundaries

- Do not publish `@marcusrbrown/anthropic-auth-core@1.2.2-mb.1`; core starts at `1.2.2-mb.2` to match the next OpenCode fork release.
- Do not claim the OpenCode bundle alone solves the issue; dependency metadata and release artifacts must be correct too.
- Do not migrate Pi into the fork scope unless release tooling requires it.
- Do not version-sync Pi to `1.2.2-mb.2` unless planning proves it is unavoidable for repository tooling; if unavoidable, do not publish Pi as a fork package.
- Do not switch to a different release system unless the current script/workflow path cannot support the fork lane cleanly.
- Do not change OAuth behavior beyond carrying the already-cherry-picked PR #40 fixes into correctly published fork packages.

---

## Key Decisions

- Use the release lane scope: set up fork core + OpenCode as the synced publish pair at `1.2.2-mb.2`, including version-sync/release config as needed.
- Keep `-mb.X` fork suffix versioning for every fork publish.
- Publish prerelease fork packages with the `mb` dist-tag unless intentionally promoting a fork package to `latest`.
- Keep Pi out of the fork publish scope; any Pi changes are only allowed to keep shared repository tooling functional.

---

## Dependencies / Assumptions

- The repository currently has no published `@marcusrbrown/anthropic-auth-core` package on npm.
- Current package discovery found OpenCode still depending on `@cortexkit/anthropic-auth-core@1.2.2` in `packages/opencode/package.json`.
- Current package discovery found release/version tooling references in `scripts/version-sync.mjs` and `.github/workflows/release.yaml` that are still CortexKit-oriented.
- Current package discovery found Pi consuming `@cortexkit/anthropic-auth-core`; that dependency may require a planning decision if the core workspace package name changes locally.
- npm publishing credentials for the `@marcusrbrown` scope are available locally or in the intended release environment.

---

## Outstanding Questions

### Deferred to Planning

- [Affects R5, R13][Technical] Decide whether version-sync should preserve Pi at `1.2.2` while syncing only the fork publish pair, or whether Pi package metadata must move to `1.2.2-mb.2` without publishing to keep repository tooling functional.
- [Affects R6, R14][Technical] Decide whether the release should be executed manually for `1.2.2-mb.2` first, then automate, or update the workflow before publishing; either path must satisfy the artifact verification requirements.
