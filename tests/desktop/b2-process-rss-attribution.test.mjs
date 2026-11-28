import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { sample } from "./b2-process-rss-attribution-probe.mjs";

test("checkpoint includes process and isolate counters with their native units", () => {
  const { memory, heap, code, spaces, threadId, maxRSSKiB } = sample();
  assert.equal(threadId, 0);
  for (const key of ["rss", "heapTotal", "heapUsed", "external", "arrayBuffers"])
    assert.ok(Number.isSafeInteger(memory[key]) && memory[key] >= 0);
  assert.ok(heap.total_physical_size > 0 && heap.used_heap_size > 0);
  assert.ok(code.code_and_metadata_size > 0 && maxRSSKiB > 0);
  assert.ok(spaces.some((s) => s.space_name === "new_space"));
});

test("snapshot edge cut excludes weak references and shared objects", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "w16a-snapshot-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const before = path.join(dir, "before"),
    after = path.join(dir, "after");
  // root owns AtomicStore and a shared object. lastImport owns its own object
  // plus strong/shared and weak outgoing edges. Node offsets are in words.
  const data = {
    snapshot: {
      meta: {
        node_fields: ["type", "name", "self_size", "edge_count"],
        node_types: [["synthetic", "object"]],
        edge_fields: ["type", "name_or_index", "to_node"],
        edge_types: [["property", "weak"]],
      },
    },
    strings: ["root", "AtomicStore", "lastImport", "Object", "other"],
    nodes: [0, 0, 0, 2, 1, 1, 10, 1, 1, 3, 20, 2, 1, 3, 30, 0, 1, 3, 40, 0],
    edges: [0, 1, 4, 0, 4, 12, 0, 2, 8, 0, 4, 12, 1, 4, 16],
  };
  await writeFile(before, JSON.stringify(data));
  data.nodes[10] = 48;
  await writeFile(after, JSON.stringify(data));
  const script = fileURLToPath(
    new URL("./b2-process-rss-attribution-snapshots.mjs", import.meta.url),
  );
  const report = JSON.parse(
    execFileSync(process.execPath, [script, before, after], { encoding: "utf8" }),
  );
  assert.equal(report.netShallow, 28);
  assert.equal(report.before[0].exclusiveStrongBytes, 20);
  assert.equal(report.after[0].exclusiveStrongBytes, 48);
});
