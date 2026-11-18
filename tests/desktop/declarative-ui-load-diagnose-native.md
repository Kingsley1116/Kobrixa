# Native motion load comparison

Run once per platform on the same idle foreground desktop, using CI's native dependencies, Node 24.22.2, pinned package manager 10.15.0 and Electron 44.7.0. On Linux give the whole sequence one Xvfb session. Use Bash (Git Bash on Windows). Supply a fresh absolute directory outside any checkout in `RUN` and the absolute pinned `node_modules/pnpm/bin/pnpm.cjs` in `PM_CLI`. These are orchestrator commands, including the local detached measurement commits. Nothing is pushed.

```bash
set -eu
src=$(git rev-parse --show-toplevel)
: "${RUN:?new external directory}" "${PM_CLI:?pinned CLI entry}"
mkdir "$RUN"
test "$(node "$PM_CLI" --version)" = 10.15.0
test "$(node -v)" = v24.22.2
cd "$src"
git worktree add --detach "$RUN/A" 842aa56
git worktree add --detach "$RUN/B" 8d1a7fa
git worktree add --detach "$RUN/C" 8d1a7fa
test "$(git rev-parse candidate/plugin-ui-push-snapshot)" = "$(git rev-parse 3ddd552)"
git diff --binary 3ddd552^ 3ddd552 > "$RUN/candidate.patch"
git -C "$RUN/C" apply --index "$RUN/candidate.patch"
test "$(git -C "$RUN/C" diff --cached --name-only)" = "$(git diff --name-only 3ddd552^ 3ddd552)"
test "$(git diff --name-only 3ddd552^ 3ddd552 | wc -l | tr -d ' ')" = 8
git -C "$RUN/C" commit -m 'measurement: apply eight-file push snapshot delta'

for id in A B C; do (
  cd "$RUN/$id"
  git rev-parse HEAD > "$RUN/$id-product.sha"
  # Same load fixture, foreground handling, observers and probes on all three.
  # Keep revision-specific composition/build driver and preload.
  for f in load-main.ts load-fixture.ts load-renderer.tsx load-report.mjs \
    load-diagnose-main.ts load-diagnose-renderer.ts slow-main.ts; do
    cp "$src/tests/desktop/declarative-ui-$f" tests/desktop/
    git add -- "tests/desktop/declarative-ui-$f"
  done
  git commit -m 'measurement: common P2 load harness'
  git rev-parse HEAD > "$RUN/$id-measurement.sha"
  node "$PM_CLI" install --frozen-lockfile
  node node_modules/typescript/bin/tsc -b packages/*/tsconfig.json frontends/*/tsconfig.json
  if test -f tools/release/journal-win32.mjs && test "$(node -p 'process.platform')" = win32; then
    node tools/release/journal-win32.mjs
  fi
  node node_modules/electron/install.js
  test "$(node -p "require('./node_modules/electron/package.json').version")" = 44.7.0
  node tools/release/build-desktop.mjs
  test -z "$(git status --porcelain)"
) > "$RUN/build-$id.log" 2>&1; done

scheduler="$src/tests/desktop/declarative-ui-load-diagnose-compare.mjs"
for mode in ordinary profile; do
  export KOBRIXA_UI_LOAD_DIAGNOSE=0
  if test "$mode" = profile; then export KOBRIXA_UI_LOAD_DIAGNOSE=1; fi
  rc=0
  node "$scheduler" "$RUN/$mode" "$RUN/A" "$RUN/B" "$RUN/C" || rc=$?
  echo "$rc" > "$RUN/$mode/exit-code"
done
for trial in "$RUN"/profile/*/kobrixa-ui-motion-*/load-*; do
  if test -f "$trial/report.json"; then
    node "$src/tests/desktop/declarative-ui-load-diagnose.mjs" "$trial" > "$trial/worst.log"
  fi
done
```

Each mode schedules A/B/C, B/C/A, C/A/B with one Electron workload at a time. Keep the entire external directory, including both schedules, exit codes, logs, artifact hashes, every fresh profile and every partial trial. Measurement SHAs include the shared harness and are recorded separately from product SHAs. The historical A driver predates the five-second follow-up and aggregate verifier. Its zero driver exit cannot establish current acceptance. To analyze an ordinary matrix, run `node tests/desktop/declarative-ui-load-report.mjs /absolute/path/to/matrix.json` from this worktree. A profiled B/C driver reaches the existing composition assertion after retaining its three trials and exits nonzero. Inspect individual logs for earlier failures. Neither a diagnostic exit nor a historical orphan gap is a pass. Final unprofiled three-desktop acceptance and any product fix remain outstanding.
