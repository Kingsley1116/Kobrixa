# Native UI load and slow snapshot observations

This is scoped B1 evidence, not Stage 3 or P160 publication approval. The actual
`composeDesktopMain/createDesktopFoundation`, production preload, pane/status
components and renderer singleton run with the formal fake device provider.
The visible test shell is not the full workbench. Resources use CJK diagnostic
glyphs; emoji rendering and physical hardware are not established here.

## Three maximum-load runs

Command: `node tests/desktop/declarative-ui-motion-run.mjs --load`, exit 0.
The runner captured clean commit `842aa56` before building the measured binaries;
full SHA and binary hashes are in the original matrix. Three fresh native
processes load 16 panels, 16 statuses, 256 nodes/depth 8 per panel and exactly
8 MiB of JSON resources. All 32 bindings update. The serialized producer waits
at least 100 ms after acknowledgment; observed rates are approximately 9.4 Hz
per binding, not exactly ten accepted patches per second. Individual counts and
rates remain in `load-analysis.json`.

| Repeat | Steady duration | Apply n / p95 / max (ms) | Native input p95 (ms) | Hide→revoke p95 (ms) | Full heap delta | Residual after 1,000 cycles |
| --- | --- | --- | --- | --- | --- | --- |
| 0 | 60,687.83 ms | 9,652 / 4.51 / 17.31 | 23.0 | 1.87 | 8,035,000 B | 997,956 B |
| 1 | 60,735.87 ms | 9,659 / 4.73 / 19.81 | 28.7 | 1.97 | 8,050,804 B | 962,668 B |
| 2 | 60,631.37 ms | 9,678 / 4.45 / 17.89 | 26.2 | 1.89 | 7,565,488 B | 953,012 B |

Each repeat has at least five seconds warmup, 30 cross-process clock calibration
samples, real trusted native input and 69 native hide actions. Apply joins actual
main acceptance and renderer commit by binding/revision. Input uses two animation
callbacks as a conservative paint opportunity. Clock uncertainty is included in
apply/revoke upper bounds. Actual device stop dispatch is covered by the separate
native motion evidence, not inferred from UI callbacks.

Heap uses V8 main and CDP renderer full GC, three samples per point, not RSS.
Cold empty, warmed empty, full and after-cycle snapshots are retained. The residual
compares the warmed empty catalog to disposed/unlinked state; cold JIT/schema
compilation growth is still visible in the raw cold samples. All counters from
the three registered main instances and 1,034 renderer instances are zero after
cleanup. Each process exits normally. The original runner checked absence
immediately after exit; the separately timestamped `orphan-followup.json` records
another actual PID check more than five seconds after the post-exit report write.

`matrix.json` changes only raw-file references for portability. Original reports,
matrix, main trace and renderer observations are retained verbatim in gzip form.
`retained-files.json` contains raw and compressed hashes. The 24 large heap files
are retained locally, compressed, under the exact ignored controller-evidence
paths recorded in that index; they are **not included in Git**. Total compressed
retention, including the heaps, is 80,155,289 bytes. These heap paths must be
preserved or transferred with the receipt if another machine reviews it.

Recalculate thresholds from retained observations:

```sh
node tests/desktop/declarative-ui-load-report.mjs docs/superpowers/evidence/2026-10-23-3b1-ui-load/matrix.json
```

## Thirty-second slow renderer

Command: `node tests/desktop/declarative-ui-motion-run.mjs --slow-consumer`, exit 0.
The artifact is dirty `842aa56`, including the subsequently committed observer;
its exact binary hashes are retained in `slow/report.json.gz`. Only the test
transport delays genuine snapshot replies by 800 ms. Production validation,
store, preload and React components remain unchanged.

The 30,021.43 ms interval records 119 samples and 2,432 held/released snapshot
observations. The actual invalid `-` numeric draft and focus survive updates;
revision jumps recover. Each state retains at most four events/64 KiB, and at
most one snapshot reply per binding is outstanding. Closing while a reply is
held does not resurrect the old instance. Explicit reopen produces a new
instance, which advances from revision 0 to 5. Main/renderer counters end at
zero, normal close succeeds, and the actual 5,002.55 ms orphan check finds no PID.

This establishes renderer snapshot backpressure. Shared SDK event overflow and
motion disposition are separately documented in the native motion stress
evidence; it does not establish a 30-second SDK callback backlog experiment.

The report-only tests re-read these observations; they do not perform experiments:

```sh
KOBRIXA_UI_LOAD_REPORT=docs/superpowers/evidence/2026-10-23-3b1-ui-load/matrix.json KOBRIXA_UI_SLOW_REPORT=docs/superpowers/evidence/2026-10-23-3b1-ui-load/slow/report.json.gz node --test --test-name-pattern='(three actual native|actual 30-second)' tests/desktop/declarative-ui-load.test.mjs
```

Both actual receipt checks pass, zero skipped. Independent review, full packaged
workbench regression, delivered OS clean installation, manual accessibility,
actual persistence and later product/hardware acceptance retain their own status.
