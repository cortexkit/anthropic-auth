# Copilot Instructions

Read `AGENTS.md` first — it contains project conventions, communication style, and code philosophy that apply to all work in this repo.

## Repository

Bun workspace monorepo. Bun version: `1.3.14` (from `mise.toml`).

## Release Invariants (high-risk — read before touching release files)

- This fork publishes only `@marcusrbrown/anthropic-auth-core` and `@marcusrbrown/opencode-anthropic-auth`.
- The Pi package is **not published** by this fork — keep it private.
- Preserve npm Trusted Publishing/OIDC and provenance. No fallback `NPM_TOKEN` secret.
- Do **not** add `NPM_DIST_TAG_TOKEN`.
- Do **not** reintroduce the `mb` dist-tag lane.
- Current publish behavior: `npm publish --tag latest`.
- Do **not** add `environment: npm-publish` unless both the GitHub environment and the npm Trusted Publisher config are confirmed to exist.

## Commands

Use existing package scripts only — do not invent commands:

| Purpose | Command |
|---|---|
| Type check | `bun run typecheck` |
| Tests | `bun run test` |
| Lint | `bun run lint` |
| Format check | `bun run format:check` |
| E2E tests | `bun run test:e2e` (only when OpenCode/runtime behavior changes) |

## Security / Privacy

Never commit or expose:
- `captures/` directory or any mitmproxy/system-prompt capture artifacts
- `.env*` files
- OAuth tokens, local auth/config dumps

## Testing Guidelines

- For workflow/config file edits: do **not** add tests that assert file contents. Verify syntax and behavior instead.
