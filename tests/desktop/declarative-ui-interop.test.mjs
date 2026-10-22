import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readFixtures, materialize, maximumPanel, mutations } from "./declarative-ui-harness.mjs";

const types = [
  "group",
  "text",
  "help",
  "textInput",
  "number",
  "range",
  "choice",
  "boolean",
  "action",
  "holdAction",
  "status",
  "alert",
  "progress",
  "keyValue",
];

test(
  "U06/U07/U13: actual MessagePort and Python stdio receipts",
  {
    skip: process.env.KOBRIXA_UI_REPORT
      ? false
      : "controller must run Electron; helper-only run is not acceptance",
  },
  async () => {
    const report = JSON.parse(await readFile(process.env.KOBRIXA_UI_REPORT, "utf8"));
    assert.equal(report.kind, "ui-transport");
    assert.equal(report.mockHost, true);
    assert.deepEqual(report.results.map((row) => row.language).sort(), ["js", "python"]);
    assert.deepEqual(report.remainingPids, []);
    for (const row of report.results) {
      assert.deepEqual(row.initializeKeys, [
        "apiVersion",
        "grantedPermissions",
        "locale",
        "pluginId",
      ]);
      assert.equal(row.apiVersion, "1.6.0");
      assert.equal(row.legacy, null);
      assert.deepEqual(row.negotiated, { commandEnvelopeVersions: [1], uiResourceVersions: [1] });
      assert.equal(row.duplicateCalls, 1);
      assert.equal(row.managementHasBinding, false);
      assert.equal(row.managementHasMotion, false);
      assert.equal(row.unicode, "🙂界");
      assert.equal(row.callbackError, "PLUGIN_E_COMMAND_FAILED");
      assert.equal(row.callbackStarted, true);
      assert.ok(row.logs.some((line) => line.includes(`UI_CALLBACK_WAIT:${row.cancellationId}`)));
      assert.equal(row.cancelled, true);
      assert.equal(row.afterCancellationCalls, 2);
      assert.equal(row.exited, true);
      assert.ok(Number.isSafeInteger(row.pid) && row.pid > 0);
      assert.ok(row.wire.some((item) => item.message.method === "$/cancelRequest"));
    }
  },
);

test("U01/U15: fixture uses every v1 component and real number/choice/hold arguments", async () => {
  const { manifest, panel, status } = await readFixtures();
  assert.equal(manifest.apiVersion, "^1.6.0");
  assert.deepEqual([...new Set(panel.nodes.map((n) => n.type))].sort(), types.sort());
  assert.equal(panel.fields.speed.schema.type, "number");
  assert.equal(panel.fields.mode.schema.type, "enum");
  assert.deepEqual(panel.nodes.find((n) => n.type === "holdAction").arguments, {
    speed: { ref: { scope: "form", key: "speed" } },
    mode: { ref: { scope: "form", key: "mode" } },
  });
  assert.deepEqual(Object.keys(status).sort(), ["data", "kind", "text", "tone"]);
  assert.equal(panel.nodes.find((n) => n.id === "text").value.text.en, "<b>literal, not HTML</b>");
});

test("U02/U03: independent malformed fixtures cannot mutate the valid baseline", async () => {
  const { panel } = await readFixtures();
  const before = JSON.stringify(panel);
  const cases = mutations(panel);
  assert.deepEqual(
    cases.map((c) => c.id),
    [
      "unknown-node",
      "extra-field",
      "missing-en",
      "cycle",
      "orphan",
      "duplicate",
      "missing-reference",
      "condition",
      "prototype",
    ],
  );
  assert.equal(new Set(cases.map((c) => JSON.stringify(c.resource))).size, cases.length);
  assert.equal(JSON.stringify(panel), before);
  const maximum = maximumPanel(panel);
  assert.equal(maximum.nodes.length, 256);
  const byId = new Map(maximum.nodes.map((n) => [n.id, n]));
  const seen = new Set();
  function walk(id, depth) {
    assert.ok(depth <= 8);
    assert.ok(!seen.has(id));
    seen.add(id);
    const node = byId.get(id);
    assert.ok(node);
    if (node.type === "group") {
      assert.ok(node.children.length >= 1 && node.children.length <= 32);
      return Math.max(depth, ...node.children.map((child) => walk(child, depth + 1)));
    }
    return depth;
  }
  assert.equal(walk(maximum.root, 1), 8);
  assert.equal(seen.size, 256);
});

test("U03: capacity fixture has 16 panels, 16 statuses, exactly 8 MiB UTF-8 resources", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ui-capacity-test-"));
  try {
    const paths = await materialize(directory, { sources: 8, maximum: true });
    let panels = 0,
      statuses = 0,
      total = 0;
    for (const directory of paths) {
      const manifest = JSON.parse(
        await readFile(path.join(directory, "kobrixa-plugin.json"), "utf8"),
      );
      panels += manifest.contributes.panels.length;
      statuses += manifest.contributes.status.length;
      let sourceBytes = 0;
      for (const item of [...manifest.contributes.panels, ...manifest.contributes.status]) {
        const raw = await readFile(path.join(directory, item.resource.path));
        assert.equal(raw.length, 256 * 1024);
        JSON.parse(raw.toString("utf8"));
        sourceBytes += raw.length;
      }
      assert.equal(sourceBytes, 1024 * 1024);
      total += sourceBytes;
    }
    assert.deepEqual(
      { panels, statuses, total },
      { panels: 16, statuses: 16, total: 8 * 1024 * 1024 },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Python browser fixture clones manifest and registered command identity together", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ui-python-identity-"));
  try {
    const [leaf] = await materialize(directory, { language: "python" });
    const manifest = JSON.parse(await readFile(path.join(leaf, "kobrixa-plugin.json"), "utf8"));
    const consumer = await readFile(path.join(leaf, "consumer.py"), "utf8");
    assert.deepEqual(manifest.runtime, { kind: "python", entry: "consumer.py" });
    for (const command of manifest.contributes.commands)
      assert.ok(consumer.includes(`"${command.id}"`));
    assert.equal(consumer.includes('"acceptance.ui.activate"'), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("AM-19: actual shared validator rejects identical malformed resources and byte +1", async () => {
  const { validateUiResource } = await import("../../packages/plugin-protocol/dist/index.js");
  const { manifest, panel } = await readFixtures();
  const context = {
    pluginId: manifest.id,
    commands: manifest.contributes.commands,
    panels: manifest.contributes.panels,
  };
  const validate = (resource, bytes = Buffer.byteLength(JSON.stringify(resource), "utf8")) =>
    validateUiResource(resource, context, bytes);
  assert.equal(validate(panel).ok, true);
  assert.equal(validate(panel, 256 * 1024).ok, true);
  assert.equal(validate(panel, 256 * 1024 + 1).ok, false);
  for (const { id, resource } of mutations(panel)) assert.equal(validate(resource).ok, false, id);
  assert.equal(validate(maximumPanel(panel)).ok, true);
  const overNodes = maximumPanel(panel);
  overNodes.nodes.push({
    id: "one-too-many",
    type: "text",
    emphasis: "normal",
    value: { text: { en: "extra" } },
  });
  assert.equal(validate(overNodes).ok, false);
});
