import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const root = fileURLToPath(new URL("../../", import.meta.url));
export const fixture = new URL("./fixtures/declarative-ui/", import.meta.url);
export async function readFixtures() {
  const [manifest, panel, status] = await Promise.all(
    ["kobrixa-plugin.json", "panel.json", "status.json"].map(async (name) =>
      JSON.parse(await readFile(new URL(name, fixture), "utf8")),
    ),
  );
  return { manifest, panel, status };
}
export function maximumPanel(input) {
  const panel = structuredClone(input);
  // The original root is depth 8; seven new ancestors make depth observable.
  let child = panel.root;
  for (let n = 6; n >= 0; n--) {
    const id = `ancestor-${n}`;
    panel.nodes.push({ id, type: "group", layout: "stack", children: [child] });
    child = id;
  }
  panel.root = child;
  // Move the original root's leaves to depth 8, not 9.
  const oldRoot = panel.nodes.find((n) => n.id === input.root);
  const deepest = panel.nodes.find((n) => n.id === "ancestor-6");
  deepest.children = oldRoot.children;
  panel.nodes = panel.nodes.filter((n) => n.id !== oldRoot.id);
  let number = 0;
  for (const group of panel.nodes.filter((n) => n.type === "group")) {
    while (group.children.length < 32 && panel.nodes.length < 256) {
      const id = `fill-${number++}`;
      group.children.push(id);
      panel.nodes.push({
        id,
        type: "text",
        emphasis: "normal",
        value: { text: { en: "🙂界".repeat(32) } },
      });
    }
  }
  // Seven ancestors have room for 7*31 extra leaves; add shallow groups for the rest.
  const outer = panel.nodes.find((n) => n.id === panel.root);
  while (panel.nodes.length < 256) {
    const displaced = outer.children.pop();
    const id = `bucket-${number++}`;
    outer.children.push(id);
    const group = { id, type: "group", layout: "stack", children: [displaced] };
    panel.nodes.push(group);
    while (group.children.length < 32 && panel.nodes.length < 256) {
      const leaf = `fill-${number++}`;
      group.children.push(leaf);
      panel.nodes.push({
        id: leaf,
        type: "text",
        emphasis: "normal",
        value: { text: { en: "界🙂".repeat(32) } },
      });
    }
  }
  return panel;
}
export function mutations(panel) {
  const make = (id, change) => {
    const resource = structuredClone(panel);
    change(resource);
    return { id, resource };
  };
  return [
    make("unknown-node", (r) => {
      r.nodes[1].type = "webview";
    }),
    make("extra-field", (r) => {
      r.nodes[1].html = "<script>throw 1</script>";
    }),
    make("missing-en", (r) => {
      r.nodes[1].value.text = { "zh-TW": "缺少英文" };
    }),
    make("cycle", (r) => {
      r.nodes[0].children.push(r.root);
    }),
    make("orphan", (r) => {
      r.nodes.push({ id: "orphan", type: "help", value: { text: { en: "orphan" } } });
    }),
    make("duplicate", (r) => {
      r.nodes[2].id = r.nodes[1].id;
    }),
    make("missing-reference", (r) => {
      r.nodes[1].value = { ref: { scope: "data", key: "absent" } };
    }),
    make("condition", (r) => {
      r.nodes[1].visibleWhen = { op: "all", items: [] };
    }),
    make("prototype", (r) => {
      Object.defineProperty(r.data, "__proto__", {
        value: { schema: { type: "boolean", nullable: false }, initial: true },
        enumerable: true,
      });
    }),
  ];
}
export function padJson(value, size) {
  const text = JSON.stringify(value);
  const remaining = size - Buffer.byteLength(text, "utf8");
  assert.ok(remaining >= 0, "fixture itself exceeds the resource byte budget");
  return text + " ".repeat(remaining);
}
export async function materialize(
  directory,
  { sources = 1, maximum = false, language = "js" } = {},
) {
  assert.ok(Number.isInteger(sources) && sources >= 1 && sources <= 8);
  const original = await readFixtures();
  const directories = [];
  for (let n = 0; n < sources; n++) {
    const id = `acceptance.ui-${n}`;
    const leaf = path.join(directory, `ui-${n}`);
    await mkdir(leaf, { recursive: true });
    const replace = (value) => JSON.parse(JSON.stringify(value).replaceAll("acceptance.ui", id));
    const manifest = replace(original.manifest);
    if (language === "python") manifest.runtime = { kind: "python", entry: "consumer.py" };
    const panel = replace(maximum ? maximumPanel(original.panel) : original.panel);
    const status = replace(original.status);
    manifest.contributes.panels = [0, 1].map((i) => ({
      id: `${id}.panel-${i}`,
      title: { en: `UI acceptance ${n}/${i}`, "zh-TW": `UI 驗收 ${n}/${i}` },
      location: "right",
      resource: { version: 1, path: `panel-${i}.json` },
    }));
    manifest.contributes.status = [0, 1].map((i) => ({
      id: `${id}.status-${i}`,
      title: { en: `UI status ${n}/${i}` },
      resource: { version: 1, path: `status-${i}.json` },
    }));
    for (const [kind, resource] of [
      ["panel", panel],
      ["status", status],
    ]) {
      for (const i of [0, 1])
        await writeFile(
          path.join(leaf, `${kind}-${i}.json`),
          maximum ? padJson(resource, 256 * 1024) : JSON.stringify(resource),
        );
    }
    await writeFile(path.join(leaf, "kobrixa-plugin.json"), JSON.stringify(manifest));
    const python = await readFile(new URL("consumer.py", fixture), "utf8");
    await writeFile(path.join(leaf, "consumer.py"), python.replaceAll("acceptance.ui", id));
    directories.push(leaf);
  }
  return directories;
}
export function summary(values) {
  assert.ok(Array.isArray(values) && values.length > 0);
  assert.ok(values.every((n) => Number.isFinite(n) && n >= 0));
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (fraction) => sorted[Math.ceil(sorted.length * fraction) - 1];
  return { n: sorted.length, p50: percentile(0.5), p95: percentile(0.95), max: sorted.at(-1) };
}
export function assertMeasurements(report) {
  assert.equal(report.kind, "real-ui-measurement");
  assert.equal(report.source, "controller-observed");
  for (const name of ["artifact", "os", "arch", "cpu", "filesystem", "node", "electron", "locale"])
    assert.ok(typeof report[name] === "string" && report[name].length > 0, name);
  assert.ok(report.ramBytes > 0);
  assert.match(report.gc, /collectGarbage.*main GC/);
  assert.ok(report.proof.length >= 3);
  assert.equal(report.memoryMetric, "post-GC retained heap");
  assert.equal(report.clock.method, "performance.timeOrigin + performance.now");
  assert.ok(report.clock.samples >= 30);
  assert.ok(Number.isFinite(report.clock.uncertaintyMs) && report.clock.uncertaintyMs >= 0);
  assert.deepEqual(report.diagnosticOwners, ["T2", "T3", "T5", "T6", "T7"]);
  for (const kind of ["apply", "revoke", "stop-dispatch"])
    assert.ok(Number.isInteger(report.observations[kind]) && report.observations[kind] > 0, kind);
  assert.deepEqual(report.fixture, {
    panels: 16,
    statuses: 16,
    nodesPerPanel: 256,
    depth: 8,
    resourceBytes: 8 * 1024 * 1024,
    patchHz: 10,
  });
  assert.ok(report.repeats.length >= 3);
  for (const run of report.repeats) {
    assert.ok(run.warmupMs >= 5000 && run.durationMs >= 60000 && run.patches >= 600);
    assert.ok(
      Number.isFinite(run.clockUncertaintyMs) &&
        run.clockUncertaintyMs >= report.clock.uncertaintyMs,
    );
    const upper = (values) => values.map((value) => value + run.clockUncertaintyMs);
    assert.ok(summary(upper(run.applyMs)).p95 <= 16 && summary(upper(run.applyMs)).max <= 50);
    summary(run.stopDispatchMs); // Required observation, no invented stop latency budget.
    assert.ok(summary(upper(run.inputMs)).p95 <= 100);
    assert.ok(summary(upper(run.revokeMs)).p95 <= 50 && summary(upper(run.revokeMs)).max <= 100);
    assert.ok(Number.isFinite(run.mainHeapDelta) && Number.isFinite(run.rendererHeapDelta));
    assert.ok(run.mainHeapDelta + run.rendererHeapDelta <= 64 * 1024 * 1024);
  }
  assert.equal(report.cycles, 1000);
  assert.deepEqual(report.live, {
    owners: 0,
    bindings: 0,
    subscriptions: 0,
    queuedEvents: 0,
    queuedBytes: 0,
    timers: 0,
    pendingInvocations: 0,
    actionTokens: 0,
    resourceReaders: 0,
    workerJobs: 0,
  });
  assert.ok(
    Number.isFinite(report.retainedAfterCycles) && report.retainedAfterCycles <= 2 * 1024 * 1024,
  );
  assert.equal(report.normalClose, true);
  assert.ok(report.orphanCheckMs >= 5000);
  assert.deepEqual(report.remainingPids, []);
}
