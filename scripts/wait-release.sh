#!/usr/bin/env bash
# Wait for the GitHub Actions release workflow to complete for a given tag.
# Usage: ./scripts/wait-release.sh v1.2.2-mb.2 [--max-wait <seconds>] [--repo <owner/repo>]
# Polls every 5 seconds, exits 0 on success, 1 on failure, 2 on timeout.
#
# Defaults to the marcusrbrown fork repo. Override with --repo or RELEASE_REPO env var.

set -euo pipefail

TAG=""
MAX_WAIT="${MAX_WAIT_SECONDS:-900}"
# Default to the fork repo; override with --repo flag or RELEASE_REPO env var.
REPO="${RELEASE_REPO:-marcusrbrown/cortexkit_anthropic-auth}"
INTERVAL=5

while [[ $# -gt 0 ]]; do
  case "$1" in
    --max-wait)
      MAX_WAIT="$2"
      shift 2
      ;;
    --repo)
      REPO="$2"
      shift 2
      ;;
    -*)
      echo "Unknown flag: $1" >&2
      exit 64
      ;;
    *)
      if [[ -z "$TAG" ]]; then
        TAG="$1"
      else
        echo "Unexpected positional argument: $1" >&2
        exit 64
      fi
      shift
      ;;
  esac
done

if [[ -z "$TAG" ]]; then
  echo "Usage: wait-release.sh <tag> [--max-wait <seconds>] [--repo <owner/repo>]" >&2
  exit 64
fi

echo "⏳ Waiting for release workflow on ${TAG} in ${REPO} (max ${MAX_WAIT}s)..."

START_TIME=$(date +%s)

while true; do
  NOW=$(date +%s)
  ELAPSED=$((NOW - START_TIME))
  if (( ELAPSED >= MAX_WAIT )); then
    echo "⏱  Timed out after ${ELAPSED}s waiting for workflow to complete."
    echo "   Check: https://github.com/${REPO}/actions"
    exit 2
  fi

  RUN_JSON=$(gh run list --repo "$REPO" --workflow release.yaml --branch "$TAG" --limit 1 --json status,conclusion,databaseId 2>/dev/null || echo "[]")

  STATUS=$(echo "$RUN_JSON" | jq -r '.[0].status // "not_found"')
  CONCLUSION=$(echo "$RUN_JSON" | jq -r '.[0].conclusion // ""')
  RUN_ID=$(echo "$RUN_JSON" | jq -r '.[0].databaseId // ""')

  if [ "$STATUS" = "not_found" ]; then
    echo "  [+${ELAPSED}s] Workflow not started yet..."
    sleep "$INTERVAL"
    continue
  fi

  if [ "$STATUS" = "completed" ]; then
    if [ "$CONCLUSION" = "success" ]; then
      echo "✅ Release workflow succeeded (run ${RUN_ID})"
      echo "   https://github.com/${REPO}/actions/runs/${RUN_ID}"
      exit 0
    else
      echo "❌ Release workflow failed: conclusion=${CONCLUSION} (run ${RUN_ID})"
      echo "   https://github.com/${REPO}/actions/runs/${RUN_ID}"
      exit 1
    fi
  fi

  echo "  [+${ELAPSED}s] Status: ${STATUS} (run ${RUN_ID})"
  sleep "$INTERVAL"
done
