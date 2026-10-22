import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";
import { summary } from "./declarative-ui-harness.mjs";

async function textAt(file) {
  const bytes = await readFile(file);
  return (file.endsWith(".gz") ? gunzipSync(bytes) : bytes).toString("utf8");
}

export async function analyzeLoad(matrixFile) {
  const matrix = JSON.parse(await readFile(matrixFile, "utf8"));
  assert.equal(matrix.kind, "ui-maximum-load");
  const runs = [];
  for (const entry of matrix.reports) {
    const reportPath = path.resolve(path.dirname(matrixFile), entry.path);
    const directory = path.dirname(reportPath);
    const report = JSON.parse(await textAt(reportPath));
    assert.equal(report.kind, "ui-maximum-load-run");
    assert.equal(report.composition, "composeDesktopMain/createDesktopFoundation");
    const orphanFollowup = entry.orphanFollowup
      ? JSON.parse(await textAt(path.join(directory, entry.orphanFollowup)))
      : null;
    if (orphanFollowup) assert.deepEqual(orphanFollowup.pids, report.childPids);
    const renderer = JSON.parse(
      await textAt(path.join(directory, entry.rendererEvents ?? "renderer-events.json")),
    );
    const main = (await textAt(path.join(directory, entry.mainEvents ?? "main-events.jsonl")))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const key = (row) => `${row.binding.panelInstance}:${row.revision}`;
    const accepted = new Map(
      main.filter((row) => row.kind === "apply").map((row) => [key(row), row]),
    );
    const uncertainty = Math.max(
      ...report.calibration.map(
        (sample) => sample.uncertainty + Math.abs(sample.offset - report.clock.offset),
      ),
    );
    const matched = renderer.observations.filter(
      (row) => row.kind === "apply" && accepted.has(key(row)),
    );
    const apply = matched.map(
      (row) => row.time + report.clock.offset - accepted.get(key(row)).time,
    );
    const revoke = renderer.hides.map((hide) => {
      const at = hide.at + report.clock.offset;
      const event = main.find(
        (row) =>
          row.kind === "revoke" &&
          row.binding.panelInstance === hide.panelInstance &&
          row.time >= at - uncertainty &&
          row.time <= at + 100,
      );
      return event ? event.time - at : null;
    });
    const input = renderer.inputPaints.map((row) => row.paintedAt - row.inputAt);
    const upper = (values) => values.map((value) => Math.max(0, value) + uncertainty);
    const fullHeapDelta = ["main", "renderer"].reduce(
      (total, process) =>
        total + Math.max(...report.fullHeap[process]) - Math.min(...report.baselineHeap[process]),
      0,
    );
    const retainedAfterCycles = ["main", "renderer"].reduce(
      (total, process) =>
        total + Math.max(...report.afterHeap[process]) - Math.min(...report.baselineHeap[process]),
      0,
    );
    const applySummary = apply.length ? summary(upper(apply)) : null;
    const revokeSummary =
      revoke.length && revoke.every((value) => value !== null) ? summary(upper(revoke)) : null;
    const inputSummary = input.length ? summary(input) : null;
    const rates = {};
    for (const event of accepted.values())
      rates[event.binding.panelInstance] = (rates[event.binding.panelInstance] ?? 0) + 1;
    const checks = {
      freshArtifact: report.artifact.dirty === false,
      fullDuration: report.warmupMs >= 5000 && report.durationMs >= 60000,
      fullFixture:
        report.artifact.fixture.resourceBytes === 8 * 1024 * 1024 &&
        report.fullCounters.main[0].counters.bindings === 32 &&
        report.fullCounters.main[1].counters.owners === 8,
      allBindingsUpdating:
        Object.keys(rates).length === 32 && Object.values(rates).every((n) => n > 0),
      clock: report.calibration.length >= 30 && apply.every((value) => value >= -uncertainty),
      apply:
        !!applySummary && applySummary.n >= 600 && applySummary.p95 <= 16 && applySummary.max <= 50,
      input:
        !!inputSummary &&
        inputSummary.p95 <= 100 &&
        renderer.inputPaints.every((row) => row.trusted),
      revoke:
        !!revokeSummary &&
        revokeSummary.p95 <= 50 &&
        revokeSummary.max <= 100 &&
        renderer.hides.every((row) => row.trusted),
      fullHeap: fullHeapDelta <= 64 * 1024 * 1024,
      cycles: report.cycles === 1000,
      zeroCounters:
        report.final.length === 3 &&
        report.rendererFinal.length >= 1000 &&
        [...report.final, ...report.rendererFinal].every(
          (row) =>
            Object.keys(row.counters).length === 10 &&
            Object.values(row.counters).every((value) => value === 0),
        ),
      retained: retainedAfterCycles <= 2 * 1024 * 1024,
      normalClose:
        report.normalClose && report.remainingPids.length === 0 && report.childPids.length >= 8,
      fiveSecondOrphanCheck:
        report.orphanCheckMs >= 5000 ||
        (!!orphanFollowup &&
          orphanFollowup.observedAt - orphanFollowup.reportWrittenAfterExitAt >= 5000 &&
          orphanFollowup.remainingPids.length === 0),
      noFailures: report.failures.length === 0,
    };
    runs.push({
      reportPath,
      checks,
      pass: Object.values(checks).every(Boolean),
      apply: applySummary,
      input: inputSummary,
      revoke: revokeSummary,
      missingRevokes: revoke.filter((value) => value === null).length,
      uncertainty,
      fullHeapDelta,
      retainedAfterCycles,
      durationMs: report.durationMs,
      warmupMs: report.warmupMs,
      acceptedPatches: accepted.size,
      matchedPaints: matched.length,
      acceptedPerBinding: rates,
      perBindingHz: Object.values(rates).map((n) => n / (report.durationMs / 1000)),
      rawIntervals: { apply, input, revoke },
    });
  }
  return {
    kind: "ui-maximum-load-analysis",
    matrixFile,
    artifact: matrix.artifact,
    pass: runs.length >= 3 && runs.every((run) => run.pass),
    runs,
    scope:
      "UI timing and heap only; native device motion, 30-second slow consumer, installed product and manual gates are separate",
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  assert.equal(process.argv.length, 3, "Pass the actual matrix.json path");
  const result = await analyzeLoad(path.resolve(process.argv[2]));
  const output = path.join(path.dirname(result.matrixFile), "load-analysis.json");
  await writeFile(output, JSON.stringify(result, null, 2));
  for (const run of result.runs)
    console.log(
      JSON.stringify({
        ...run,
        rawIntervals: undefined,
        acceptedPerBinding: undefined,
        perBindingHz: undefined,
      }),
    );
  console.log(`Performance gate ${result.pass ? "PASS" : "NOT PASSED"}; ${output}`);
  if (!result.pass) process.exitCode = 1;
}
