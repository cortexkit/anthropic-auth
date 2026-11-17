#!/usr/bin/env bash
# Runs what GitHub CI runs for a pull request, so a push is confirmed by CI
# rather than discovering failures there. Run it on remote Linux jobs with
# network access, from the repository root.
#
#   bash scripts/gate.sh fast            # fast checks only, seconds
#   bash scripts/gate.sh lane <name>     # one CI suite job, on its own machine
#   bash scripts/gate.sh lanes           # list the lane names
#   bash scripts/gate.sh all             # fast checks, then every lane here
#
# CI runs each suite job on its own machine, and several tests are timed at
# 5 s, so the faithful way is `fast`, then one remote job per lane, all at
# once (runon: "linux,4c,net" each; e2e and the OpenCode shards benefit from
# more). `all` runs the lanes on one machine, GATE_JOBS (default 3) at a time,
# and can miss those 5 s deadlines under load.
#
# Every mode ends with GATE_OK <commit> only when it passed. The Windows
# packed-setup job needs Windows runners and stays a GitHub CI job.
set -uo pipefail

root=$(git rev-parse --show-toplevel)
cd "$root"
commit=$(git rev-parse HEAD)

# One name per CI suite job.
lane_names="e2e unit-opencode-1-of-4 unit-opencode-2-of-4 unit-opencode-3-of-4 unit-opencode-4-of-4 unit-core-1-of-1 unit-pi-1-of-1 unit-opencode-miniflare packaging"
if [ "${1:-}" = lanes ]; then
  tr ' ' '\n' <<<"$lane_names"
  exit 0
fi
logs=${GATE_LOG_DIR:-$(mktemp -d)}
mkdir -p "$logs"

# CI pins Bun 1.3.14 through mise; the build servers keep that exact binary
# beside a newer default, so put it first on PATH for every nested script.
if [ -x /usr/local/bin/bun-1.3.14 ]; then
  bin=$(mktemp -d)
  ln -s /usr/local/bin/bun-1.3.14 "$bin/bun"
  export PATH="$bin:$PATH"
fi
bun_version=$(bun --version)
if [ "$bun_version" != "1.3.14" ]; then
  echo "gate: needs Bun 1.3.14, found $bun_version" >&2
  exit 1
fi

step() {
  local name=$1
  shift
  local started=$SECONDS
  if "$@" >"$logs/$name.log" 2>&1; then
    printf 'ok    %-28s %4ss\n' "$name" $((SECONDS - started))
  else
    printf 'FAIL  %-28s %4ss  (log: %s)\n' "$name" $((SECONDS - started)) "$logs/$name.log"
    tail -n 40 "$logs/$name.log"
    exit 1
  fi
}

check_wire_vectors() {
  # Same check as CI: the vendored vectors must equal commons at the commit
  # pinned in SOURCE, byte for byte.
  local dir=packages/opencode/src/tests/fixtures/claude-oauth-wire
  local repo commit_pin path commons status=0
  repo=$(sed -n 's/^repository=//p' "$dir/SOURCE")
  commit_pin=$(sed -n 's/^commit=//p' "$dir/SOURCE")
  path=$(sed -n 's/^path=//p' "$dir/SOURCE")
  [[ -n "$repo" && -n "$path" && "$commit_pin" =~ ^[0-9a-f]{40}$ ]] || return 1
  commons=$(mktemp -d)
  git -C "$commons" init -q
  git -C "$commons" fetch -q --depth 1 "$repo" "$commit_pin" || return 1
  for file in README.md vectors.json SHA256SUMS; do
    git -C "$commons" show "FETCH_HEAD:$path/$file" | cmp -s - "$dir/$file" || {
      echo "$dir/$file differs from $repo at $commit_pin"
      status=1
    }
  done
  return $status
}

fail_context() {
  # Bun prints each failure's error just before its (fail) line.
  if ! grep -a -B 12 -E '^\(fail\)' "$1" | head -n 60; then
    grep -a -E 'error TS[0-9]+' "$1" | head -n 15 || tail -n 30 "$1"
  fi
}

fast_checks() {
  step install bun install --frozen-lockfile
  step oc1-config-fixture npm ci --prefix packages/e2e-tests/fixtures/opencode1-config-deps --ignore-scripts --no-audit --no-fund
  step workspace-lock bun run check:workspace-lock
  step cortexkit-layout scripts/check-cortexkit-layout.sh
  step format bun run format:check
  step lint bun run lint
  step types bun run types
  step wire-vectors check_wire_vectors
  step build bun run build
}

prepare_hosts() {
  hosts="$logs/packed-hosts"
  step packed-hosts bun packages/opencode/scripts/install-packed-hosts.ts "$hosts"
  export ANTHROPIC_AUTH_PACKED_HOSTS="$hosts"
  export ANTHROPIC_AUTH_E2E_OPENCODE_CONFIG_DEPS="$root/packages/e2e-tests/fixtures/opencode1-config-deps"
}

packaging_checks() {
  bun test --cwd packages/opencode scripts/check-bundle-globals.test.ts &&
    bun test scripts/windows packages/opencode/scripts/runtime-packaging.test.ts &&
    bun test scripts/check-pi-dist-imports.test.ts &&
    bun run check:pi-dist-imports &&
    bun run --cwd packages/core test:scripts &&
    bun run check:claustrum-golden &&
    bun test scripts/check-test-count-floors.test.ts &&
    TUI_SMOKE_SKIP_BUILD=1 bun run --cwd packages/opencode smoke:tui &&
    bun run test:pi-host
}


counts="$logs/unit-counts"
mkdir -p "$counts"

lane_command() {
  case $1 in
    e2e) bun run test:e2e ;;
    packaging) packaging_checks ;;
    unit-*)
      local rest=${1#unit-} suite shard
      suite=${rest%%-*}
      shard=${rest#*-}
      shard=${shard//-of-//}
      bun scripts/ci-unit-tests.ts --suite "$suite" --shard "$shard" --output-dir "$counts"
      ;;
    *) echo "gate: unknown lane $1" >&2; return 2 ;;
  esac
}

mode=${1:-all}
case $mode in
  fast)
    echo "gate: $commit fast checks, logs in $logs"
    fast_checks
    echo "GATE_OK $commit fast"
    exit 0
    ;;
  lane)
    name=${2:?lane name required; see: bash scripts/gate.sh lanes}
    echo "gate: $commit lane $name, logs in $logs"
    step install bun install --frozen-lockfile
    step oc1-config-fixture npm ci --prefix packages/e2e-tests/fixtures/opencode1-config-deps --ignore-scripts --no-audit --no-fund
    step build bun run build
    case $name in e2e | unit-opencode-*) prepare_hosts ;; esac
    # Run the lane in a copy, as `all` does. A remote job seals the tracked
    # checkout read-only, and some tests open tracked files for writing even
    # when they only read them (Bun's snapshot files, `bun pm` on a
    # package.json), so they fail in place. The copy under the log folder is
    # writable.
    dir="$logs/lanes/$name"
    mkdir -p "$logs/lanes"
    cp -a "$root/." "$dir"
    if (cd "$dir" && lane_command "$name") >"$logs/$name.log" 2>&1; then
      echo "GATE_OK $commit lane $name"
      exit 0
    fi
    echo "FAIL  $name"
    fail_context "$logs/$name.log"
    exit 1
    ;;
  all) ;;
  *) echo "gate: usage: gate.sh [fast | lane <name> | lanes | all]" >&2; exit 2 ;;
esac

echo "gate: $commit, logs in $logs"
echo "== fast checks"
fast_checks
echo "== suites"
prepare_hosts
max_jobs=${GATE_JOBS:-3}
lane_root="$logs/lanes"
mkdir -p "$lane_root"
lanes=()
for name in $lane_names; do
  while [ "$(jobs -rp | wc -l)" -ge "$max_jobs" ]; do sleep 1; done
  # Each lane gets its own copy of the built checkout, because Core's test
  # lifecycle deletes and rebuilds packages/core/dist, which the other lanes
  # import.
  dir="$lane_root/$name"
  cp -a "$root/." "$dir"
  lanes+=("$name")
  (
    cd "$dir" && lane_command "$name"
    echo $? >"$logs/$name.rc"
  ) >"$logs/$name.log" 2>&1 &
done
wait

failed=0
for name in "${lanes[@]}"; do
  if [ "$(cat "$logs/$name.rc" 2>/dev/null)" = 0 ]; then
    printf 'ok    %s\n' "$name"
  else
    printf 'FAIL  %s  (log: %s)\n' "$name" "$logs/$name.log"
    fail_context "$logs/$name.log"
    failed=1
  fi
done
[ "$failed" = 0 ] || { echo "gate: FAILED at $commit"; exit 1; }

# The floor compares against the merge target, as the PR job does.
base=$(git merge-base HEAD origin/main 2>/dev/null || true)
if [ -n "$base" ]; then
  step test-count-floors bun scripts/check-test-count-floors.ts --base-ref "$base" --counts-dir "$counts"
else
  echo "gate: origin/main unknown, so the test-count floor was not checked" >&2
  exit 1
fi
echo "GATE_OK $commit"
