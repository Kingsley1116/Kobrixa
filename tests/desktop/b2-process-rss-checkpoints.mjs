// Controller only. A missing snapshot stays null, including on interrupted trials.
import { readFile } from "node:fs/promises";
import path from "node:path";

export async function checkpointReport(directory, workload) {
  async function rows(name) {
    try {
      return (await readFile(path.join(directory, name), "utf8"))
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
  }
  const trace = await rows("rss.jsonl");
  let peak = null;
  for (const row of trace)
    if (
      row.kind === "sample" &&
      ["work", "cleanup", "idle"].includes(row.phase) &&
      (!peak || row.bytes > peak.bytes)
    )
      peak = row;
  const main = await rows("main-diagnostics.jsonl.checkpoints.jsonl");
  const worker = await rows("worker-diagnostics.jsonl.checkpoints.jsonl");
  const checkpoints = [];
  function select(label, count) {
    const matches = ({ trigger }) =>
      trigger.label === label &&
      trigger.count === count &&
      (label !== "peak" ||
        (peak &&
          trigger.seq === peak.seq &&
          trigger.at === peak.at &&
          trigger.bytes === peak.bytes));
    const snapshot = (rows) => {
      const row = rows.find(matches);
      if (!row) return null;
      const baseline = rows.find((r) => r.trigger.label === "baseline-end");
      const memoryDeltaBytes = baseline
        ? Object.fromEntries(
            Object.entries(row.memory).map(([key, value]) => [key, value - baseline.memory[key]]),
          )
        : null;
      return { ...row, deliveryLagMs: row.at - row.trigger.at, memoryDeltaBytes };
    };
    checkpoints.push({ label, count, main: snapshot(main), persistence: snapshot(worker) });
  }
  select("baseline-end");
  if (workload === "rss-import") {
    for (const label of ["import-committed", "public-readback"])
      for (let count = 10; count <= 50; count += 10) select(label, count);
  }
  select("peak");
  select("work-end");
  select("retained-end");
  return { sampleStreamEnded: trace.at(-1)?.kind === "end", peak, checkpoints };
}
