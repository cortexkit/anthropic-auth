---
applyTo: ".github/workflows/release.yaml,scripts/release.sh,scripts/version-sync.mjs,scripts/verify-artifacts.mjs,scripts/*release*.test.ts,scripts/*artifact*.test.ts,packages/*/package.json"
---

# Release Instructions

These rules apply whenever you edit release workflows, scripts, or package manifests.

## Published Packages

This fork publishes **only**:
- `@marcusrbrown/anthropic-auth-core`
- `@marcusrbrown/opencode-anthropic-auth`

The Pi package is private and must **not** be published.

## Permissions

- Preserve least-privilege permissions throughout.
- Only publish jobs should have `id-token: write`.
- All other jobs use `contents: read` or narrower.

## npm Publishing

- Preserve npm Trusted Publishing/OIDC and provenance — do not remove or bypass.
- Do **not** add a fallback `NPM_TOKEN` secret.
- Do **not** add `NPM_DIST_TAG_TOKEN`.
- Do **not** reintroduce the `mb` dist-tag lane.
- Current publish behavior: `npm publish --tag latest`.
- Do **not** add `environment: npm-publish` unless both the GitHub repository environment and the npm Trusted Publisher configuration are confirmed to exist.

## Testing

Do **not** add tests that assert file contents for workflow or config edits. Verify syntax and behavior instead.
