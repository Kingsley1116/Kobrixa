import { expect, it, vi } from "vitest";
import type { ProjectManifest } from "@kobrixa/compiler";
import type { LanguageServiceResolution } from "@kobrixa/plugin-runtime";
import { LanguageBindings } from "./language-binding.js";

const manifest: ProjectManifest = {
  schemaVersion: 1,
  name: "test",
  language: "case",
  target: "missing-vm",
  entry: "main.csx",
  outputDir: "out",
  assets: [],
};
const resolution = (generation = 0): LanguageServiceResolution => ({
  ok: true,
  generation,
  frontend: {
    pluginId: "test.case",
    sourceKey: "builtin:test.case",
    contribution: {
      language: "case",
      entryExtensions: ["csx"],
      sourceExtensions: ["csx"],
      ir: { min: 1, max: 1 },
    },
  },
  declaration: { language: "case", extensions: ["csx"], capabilities: ["analysis"] },
});
it("advances for generation and routing but not document revisions", () => {
  const bindings = new LanguageBindings({ "test.case:case": { capabilities: ["analysis"] } });
  const one = bindings.select("w", manifest, resolution());
  expect(bindings.select("w", { ...manifest, name: "renamed" }, resolution()).epoch).toBe(
    one.epoch,
  );
  const two = bindings.select("w", manifest, resolution(1));
  expect(two.epoch).toBeGreaterThan(one.epoch);
  const three = bindings.select("w", { ...manifest, entry: "next.csx" }, resolution(1));
  expect(three.epoch).toBeGreaterThan(two.epoch);
  expect(bindings.restart("w")!.epoch).toBeGreaterThan(three.epoch);
  expect(bindings.select("other", manifest, resolution()).epoch).toBeGreaterThan(three.epoch);
});
it("marks missing factories and capability mismatches as conflict without changing plugin state", () => {
  const log = vi.fn();
  const selected = resolution();
  const bindings = new LanguageBindings({}, log);
  expect(bindings.select("w", manifest, selected)).toMatchObject({
    availability: { kind: "unavailable", reason: "conflict", language: "case" },
    conflicts: ["test.case"],
  });
  expect(log).toHaveBeenCalledOnce();
  expect(selected).toEqual(resolution());
  const incompatible = new LanguageBindings({ "test.case:case": { capabilities: [] } }, log);
  expect(incompatible.select("w", manifest, selected).availability.kind).toBe("unavailable");
});
it("distinguishes missing, conflicts and available transitions with detached snapshots", () => {
  const bindings = new LanguageBindings({ "test.case:case": { capabilities: ["analysis"] } });
  const one = bindings.select("w", manifest, resolution());
  if (one.availability.kind !== "available") throw new Error("Expected binding");
  one.availability.binding.extensions.push("json");
  expect(bindings.get("w")?.availability).toMatchObject({ binding: { extensions: ["csx"] } });
  expect(bindings.select("w", manifest, resolution()).availability).toMatchObject({
    binding: { extensions: ["csx"] },
  });
  const missing = bindings.select("w", manifest, {
    ok: false,
    reason: "missing",
    language: "case",
    conflicts: [],
  });
  expect(missing).toMatchObject({
    availability: { kind: "unavailable", reason: "missing", language: "case" },
    conflicts: [],
  });
  const conflict = bindings.select("w", manifest, {
    ok: false,
    reason: "conflict",
    language: "case",
    conflicts: ["test.case", "test.other"],
  });
  expect(conflict).toMatchObject({
    availability: { kind: "unavailable", reason: "conflict", language: "case" },
    conflicts: ["test.case", "test.other"],
  });
  expect(conflict.epoch).toBeGreaterThan(missing.epoch);
  const recovered = bindings.select("w", manifest, resolution());
  expect(recovered.epoch).toBeGreaterThan(missing.epoch);
  expect(recovered.epoch).toBeGreaterThan(conflict.epoch);
  expect(recovered.availability).toMatchObject({ binding: { extensions: ["csx"] } });
});
it("keeps epochs monotonic across routing, restarts and workspace removal", () => {
  const bindings = new LanguageBindings({ "test.case:case": { capabilities: ["analysis"] } });
  const one = bindings.select("w", manifest, resolution(), "first-root");
  expect(one.epoch).toBeGreaterThan(0);
  const routed = bindings.select("w", manifest, resolution(), "second-root");
  expect(routed.epoch).toBeGreaterThan(one.epoch);
  const output = bindings.select(
    "w",
    { ...manifest, outputDir: "build" },
    resolution(),
    "second-root",
  );
  expect(output.epoch).toBeGreaterThan(routed.epoch);
  const restarted = bindings.restart("w")!;
  expect(restarted.epoch).toBeGreaterThan(output.epoch);
  expect(restarted.availability).toMatchObject({ binding: { epoch: restarted.epoch } });
  expect(
    bindings.select("w", { ...manifest, outputDir: "build" }, resolution(), "second-root"),
  ).toEqual(restarted);
  bindings.forget("w");
  expect(bindings.get("w")).toBeUndefined();
  expect(bindings.restart("w")).toBeUndefined();
  expect(bindings.select("w", manifest, resolution()).epoch).toBeGreaterThan(restarted.epoch);
});
