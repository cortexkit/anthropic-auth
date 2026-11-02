# Worker notes for anthropic-auth

## Running tests

- Use Bun 1.3.14. CI and releases pin it; the remote Linux runner's default Bun is newer.
- Run builds and suites on the remote Linux runner (`runon: linux,4c`). It already has Bun 1.3.14 at `/usr/local/bin/bun-1.3.14`. Do not download a runtime. In each remote job, put it first on PATH so nested scripts use it too:

  ```sh
  D=$(mktemp -d); ln -s /usr/local/bin/bun-1.3.14 "$D/bun"; export PATH="$D:$PATH"; bun --version
  ```

- Remote jobs receive your checkout's source files, but not ignored files and not your local build output. Build Core in the same job before any test that imports it: `bun run --cwd packages/core build`.
- Files under the ignored `.cortexkit/` folder never reach a remote job. Keep probes and fixtures that a remote job must run outside it, or pass them inline.
- Plain remote jobs have no network. Add `,net` (`runon: linux,4c,net`) for anything that needs the npm registry or GitHub, such as the gate's fast checks or the packed-host check (`smoke:tui`).
- The runner is shared. When it is busy, unrelated tests can time out. Report each first failure as you saw it and say whether it touches your change; do not rerun until green and do not raise deadlines.
- A worker's local shell is sandboxed and cannot read the parent worktrees folder, so local package builds can fail with `CouldntReadCurrentDirectory`. Prefer the remote runner.

## Which checks to run

- Run the filtered tests for the code you touched on the remote runner. Use `bun test <files>` in the package, after building Core in the same job.
- Before you deliver, run `bash scripts/gate.sh fast` on `runon: linux,4c,net`. It runs CI's fast checks (lockfile, layout, format, lint, types, wire vectors, build) in about 20 s and ends with `GATE_OK <commit> fast`. Put that line in your report. A formatting or type error there would fail CI's first job.
- For a bug fix, show once that the new test fails without the fix. Remote Linux jobs cannot change tracked files, so a revert made inside the job fails and the test quietly runs against the fix. Instead, in the same job, copy the checkout to `$TMPDIR` (`cp -R . "$TMPDIR/red"`), undo the fix in that copy, and run the test there; or do it locally.
- Don't write mutation proofs or lists of deliberate code breaks, don't run the full suites, and don't repeat a run. GitHub CI runs the full Core, OpenCode and Pi suites on every PR, and its result decides the merge.
- In your report, list what you ran and what you left to CI.
