import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import {
  pluginManifestSchema,
  deviceDeclarationProblems,
  uiDeclarationProblems,
  validateUiResourceV2,
  uiBytes,
  type PanelResourceV2,
} from "@kobrixa/plugin-protocol";
const root = new URL("../../../../../plugins/sensor-lab/", import.meta.url);
const read = (path: string): unknown => JSON.parse(readFileSync(new URL(path, root), "utf8"));
it("admits the shipped bilingual public-only Lab resources against the actual command manifest", () => {
  const manifest = pluginManifestSchema.parse(read("kobrixa-plugin.json"));
  expect(deviceDeclarationProblems(manifest)).toEqual([]);
  expect(uiDeclarationProblems(manifest)).toEqual([]);
  expect(manifest.permissions).not.toContain("devices.control");
  expect(manifest.permissions).toEqual([
    "devices.read",
    "ui.panels",
    "ui.status",
    "ui.clipboard",
    "storage.read",
    "storage.write",
    "storage.export",
  ]);
  const context = {
    pluginId: manifest.id,
    commands: manifest.contributes!.commands!.filter((c) => c.invocation === "context-v1"),
    panels: manifest.contributes!.panels!,
  };
  for (const path of ["ui/panel.json", "ui/status.json"]) {
    const resource = read(path);
    const result = validateUiResourceV2(resource, context, uiBytes(resource));
    expect(result).toMatchObject({ ok: true });
  }
});
it("keeps four shared charts and raw comparisons within eight datasets with host-owned Stop", () => {
  const panel = read("ui/panel.json") as PanelResourceV2;
  expect(panel.formSync).toBe(true);
  expect(Object.keys(panel.datasets)).toHaveLength(8);
  const charts = panel.nodes.filter((n) => n.type === "lineChart");
  expect(charts.filter((n) => n.timeView === "default")).toHaveLength(4);
  expect(charts.filter((n) => n.timeView === "inspect")).toHaveLength(4);
  expect(new Set(charts.map((n) => n.cursorGroup)).size).toBe(1);
  expect(new Set(charts.map((n) => JSON.stringify(n.onCursor))).size).toBe(1);
  expect(charts[0]!.onCursor.readings).toHaveLength(8);
  expect(panel.nodes.find((n) => n.id === "stop")).toMatchObject({
    action: { kind: "core", action: "stopRecording" },
  });
  // Incomplete numeric drafts remain editable; applying parses/validates the model.
  for (const field of ["source-a", "source-b", "target-a", "target-b", "zero-offset"])
    expect(panel.fields[field]!.schema.type).toBe("string");
});
