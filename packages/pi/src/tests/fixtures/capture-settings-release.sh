#!/usr/bin/env bash
set -euo pipefail
# First create the archive locally: git archive v2.11.2 -o packages/pi/snapshot-release-reference.tar
# Run with Bun 1.3.14 on Linux. The archive and output paths are relative to the checkout root.
ROOT=$PWD
R=$(mktemp -d)
trap 'rm -rf "$R"' EXIT
tar -xf packages/pi/snapshot-release-reference.tar -C "$R"
cp packages/pi/src/tests/settings-snapshot-{fixture,observe}.ts "$R/packages/pi/src/tests/"
cp packages/pi/src/tests/fixtures/capture-settings-release.ts "$R/packages/pi/src/tests/fixtures/"
export R
python3 - <<'PY'
import os
from pathlib import Path
root = Path(os.environ['R'])
# Expose existing private readers without changing their implementations.
for name, symbol in [('native.ts', 'requestPolicy as __piRequestPolicyForTest'), ('stream.ts', 'getPiRoutingServices as __getPiRoutingServicesForTest')]:
    path = root / 'packages/pi/src' / name
    path.write_text(path.read_text() + '\nexport { ' + symbol + ' }\n')
# Keep the release's private Core readers intact as well.
path = root / 'packages/core/src/accounts.ts'
path.write_text(path.read_text() + '\nexport { quotaEnabled, failClosedOnUnknownQuota }\n')
path = root / 'packages/core/src/index.ts'
path.write_text(path.read_text() + "\nexport { quotaEnabled, failClosedOnUnknownQuota } from './accounts.js'\n")
PY
cd "$R"
bun install --frozen-lockfile
bun run --cwd packages/core build
bun packages/pi/src/tests/fixtures/capture-settings-release.ts "$ROOT/packages/pi/src/tests/fixtures/settings-2.11.2.json"
