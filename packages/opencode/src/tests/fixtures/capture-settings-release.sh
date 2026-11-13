#!/usr/bin/env bash
set -euo pipefail
# Create the reference locally: git archive v2.11.2 -o packages/opencode/snapshot-release-reference.tar
ROOT=$PWD
R=$(mktemp -d)
trap 'rm -rf "$R"' EXIT
tar -xf packages/opencode/snapshot-release-reference.tar -C "$R"
cp packages/opencode/src/tests/settings-snapshot-{fixture,observe}.ts "$R/packages/opencode/src/tests/"
cp packages/opencode/src/tests/opencode2-settings-readers.ts "$R/packages/opencode/src/tests/"
cp packages/opencode/src/tests/fixtures/capture-settings-release.ts "$R/packages/opencode/src/tests/fixtures/"
export R
python3 - <<'PY'
import os
from pathlib import Path
root = Path(os.environ['R'])
# Expose the release's private readers without changing their implementations.
path = root / 'packages/core/src/accounts.ts'
path.write_text(path.read_text() + '\nexport { quotaEnabled, failClosedOnUnknownQuota }\n')
path = root / 'packages/core/src/index.ts'
path.write_text(path.read_text() + "\nexport { quotaEnabled, failClosedOnUnknownQuota } from './accounts.js'\n")
PY
cd "$R"
bun install --frozen-lockfile
bun run --cwd packages/core build
bun packages/opencode/src/tests/fixtures/capture-settings-release.ts "$ROOT/packages/opencode/src/tests/fixtures/settings-2.11.2.json"
