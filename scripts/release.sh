#!/usr/bin/env bash
set -euo pipefail

# release.sh — Tag and push a new marcusrbrown fork release (core + OpenCode)
#
# Usage:
#   ./scripts/release.sh --version 1.2.2-mb.2
#   ./scripts/release.sh --version 1.2.2-mb.2 --dry-run

usage() {
  cat <<'EOF'
Usage: ./scripts/release.sh --version <version> [--dry|--dry-run] [--yes|--force]
  e.g. ./scripts/release.sh --version 1.2.2-mb.2 --dry-run
EOF
}

VERSION=""
DRY=false
FORCE=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --version)
      if [[ $# -lt 2 || -z "${2:-}" || "${2:-}" == --* ]]; then
        echo "Error: missing value for --version"
        usage
        exit 1
      fi
      VERSION="$2"
      shift 2
      ;;
    --dry|--dry-run)
      DRY=true
      shift
      ;;
    --yes|--force)
      FORCE=true
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Error: unknown argument '$1'"
      usage
      exit 1
      ;;
  esac
done

if [[ -z "$VERSION" ]]; then
  echo "Error: missing required --version"
  usage
  exit 1
fi

if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.]+)?(\+[a-zA-Z0-9.]+)?$ ]]; then
  echo "Error: '$VERSION' is not valid semver (expected X.Y.Z or X.Y.Z-prerelease)"
  exit 1
fi

TAG="v$VERSION"

LOCAL_TAG_COMMIT=""
if git rev-parse "$TAG" >/dev/null 2>&1; then
  LOCAL_TAG_COMMIT=$(git rev-list -n1 "$TAG")
  HEAD_COMMIT=$(git rev-parse HEAD)
  if [[ "$LOCAL_TAG_COMMIT" != "$HEAD_COMMIT" ]]; then
    echo "Error: local tag '$TAG' points to $LOCAL_TAG_COMMIT, expected HEAD $HEAD_COMMIT"
    exit 1
  fi
fi

if [[ -n "$(git status --porcelain)" ]]; then
  echo "Error: working tree is not clean — commit or stash changes first"
  git status --short
  exit 1
fi

BRANCH=$(git branch --show-current)
# Allow main, master, or the fork default branch (marcusrbrown/main).
if [[ "$BRANCH" != "main" && "$BRANCH" != "master" && "$BRANCH" != "marcusrbrown/main" ]]; then
  if [[ "$FORCE" == true ]]; then
    echo "Warning: releasing from '$BRANCH' (forced via --yes/--force)"
  elif [[ -n "${CI:-}" || ! -t 0 ]]; then
    echo "Error: refusing to release from '$BRANCH' without --yes/--force in non-interactive mode"
    exit 1
  else
    echo "Warning: releasing from '$BRANCH' (not main/master/marcusrbrown/main)"
    read -rp "Continue? [y/N] " confirm
    if [[ "$confirm" != "y" && "$confirm" != "Y" ]]; then
      echo "Aborted."
      exit 1
    fi
  fi
fi

echo ""
echo "  Releasing marcusrbrown fork packages $TAG"
echo "  (core: @marcusrbrown/anthropic-auth-core, OpenCode: @marcusrbrown/opencode-anthropic-auth)"
echo "  ─────────────────────────────────────────────────────────────────────────────────────────"
echo ""

if [[ "$DRY" == true ]]; then
  echo "→ Version sync validation (dry run):"
  node scripts/version-sync.mjs "$VERSION" --dry-run
  echo ""
  echo "[DRY RUN] Would tag $TAG and push the current committed state to origin."
  echo "[DRY RUN] CI would then: test → publish core (latest tag) → verify core → publish OpenCode (latest tag) → verify → GitHub release"
  exit 0
fi

echo "→ Running pre-release checks..."
echo ""

echo "  bun lint..."
bun run lint 2>&1 || { echo "Error: Lint failed"; exit 1; }

echo "  bun typecheck..."
bun run typecheck 2>&1 || { echo "Error: Typecheck failed"; exit 1; }

echo "  bun test..."
bun run test 2>&1 || { echo "Error: Tests failed"; exit 1; }

echo "  bun build..."
bun run build 2>&1 || { echo "Error: Build failed"; exit 1; }

echo "  ✓ All checks passed"
echo ""

echo "→ Validating version sync state for $VERSION (manifests must already match)..."
node scripts/version-sync.mjs "$VERSION" --validate
echo "  ✓ Version sync validated"
echo ""

echo "→ Creating tag $TAG..."
if [[ -z "$LOCAL_TAG_COMMIT" ]]; then
  git tag -a "$TAG" -m "Release $TAG"
fi
echo ""

echo "→ Pushing to origin..."
if git push --atomic origin "$BRANCH" "$TAG"; then
  :
else
  REMOTE_TAG_COMMIT=$(git ls-remote --tags origin "refs/tags/$TAG^{}" | awk '{print $1}' | head -n1)
  if [[ -z "$REMOTE_TAG_COMMIT" ]]; then
    REMOTE_TAG_COMMIT=$(git ls-remote --tags origin "refs/tags/$TAG" | awk '{print $1}' | head -n1)
  fi
  HEAD_COMMIT=$(git rev-parse HEAD)
  if [[ "$REMOTE_TAG_COMMIT" == "$HEAD_COMMIT" ]]; then
    echo "  ✓ Remote tag $TAG already points at HEAD; treating as success."
    git push origin "$BRANCH"
  else
    echo "Error: failed to push $TAG atomically and remote tag does not match HEAD"
    exit 1
  fi
fi
echo ""

echo "  ✓ Released $TAG"
echo "  → GitHub Actions will now:"
echo "      1. test (typecheck, build, unit, e2e, lint)"
echo "      2. publish @marcusrbrown/anthropic-auth-core with --tag latest"
echo "      3. verify core registry metadata and latest dist-tag"
echo "      4. publish @marcusrbrown/opencode-anthropic-auth with --tag latest"
echo "      5. verify OpenCode registry metadata, latest dist-tag, and core dependency"
echo "      6. create GitHub release"
echo "  → Watch: https://github.com/marcusrbrown/cortexkit_anthropic-auth/actions"
