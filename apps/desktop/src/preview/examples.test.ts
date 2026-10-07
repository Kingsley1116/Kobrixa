import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { BasicPlusFrontend } from "@kobrixa/basic-plus";
import { loadProject } from "@kobrixa/compiler";
import { describe, expect, it } from "vitest";
import { PreviewRuntime } from "./runtime.js";
import { VirtualDevice } from "./virtual-device.js";

async function runExample(relative: string) {
  const root = fileURLToPath(new URL(`../../../../examples/${relative}/`, import.meta.url));
  const loaded = await loadProject(root);
  expect(loaded.diagnostics).toEqual([]);
  expect(loaded.project).toBeDefined();
  const project = loaded.project!;
  const compiled = await new BasicPlusFrontend().compile(project, new AbortController().signal);
  expect(compiled.diagnostics).toEqual([]);
  expect(compiled.ir).toBeDefined();
  const ir = compiled.ir!;
  const files = Object.fromEntries(
    await Promise.all(
      project.assets.map(async (asset) => [asset.path, [...(await readFile(asset.absolutePath))]]),
    ),
  );
  const device = new VirtualDevice({
    files,
    ...(ir.program.runtimeDirectory ? { runtimeDirectory: ir.program.runtimeDirectory } : {}),
  });
  const runtime = new PreviewRuntime(ir, device);
  runtime.resume();
  let state = runtime.getSnapshot();
  for (let tick = 0; tick < 250 && state.status === "running"; tick++)
    state = runtime.runSlice(1200, 20);
  expect(state.error).toBeUndefined();
  expect(state.status).toBe("completed");
  return state;
}

describe("offline preview bundled curriculum", () => {
  it("preserves output arguments and renders the language lesson", async () => {
    const state = await runExample("language/function-outputs");
    expect(state.globals).toMatchObject({ doubled: -6, label: "Negative: " });
    expect(state.device.lcd.pixels.some(Boolean)).toBe(true);
    expect(state.device.events.some((event) => event.detail.includes("Marker: 7"))).toBe(true);
  });

  it("passes the unsigned byte lesson's embedded assertions", async () => {
    const state = await runExample("language/byte-workbench");
    expect(state.globals).toMatchObject({ high: 128, a: 165, b: 15 });
    expect(state.device.events.some((event) => event.detail.includes("Byte checks passed"))).toBe(
      true,
    );
  });

  it("reproduces one-based text slicing edge cases", async () => {
    const state = await runExample("language/text-search");
    expect(state.globals).toMatchObject({
      position: 4,
      state: "ready",
      prefix: "EV3",
      tail: "dy",
      empty: "",
    });
  });

  it("computes the matrix lesson's numeric result", async () => {
    const state = await runExample("collections/matrix-product");
    expect(state.globals.product).toEqual([19, 22, 43, 50]);
  });

  it("finishes both mutex-protected counters without losing increments", async () => {
    const state = await runExample("concurrency/shared-counters");
    expect(state.globals).toMatchObject({ count: 7, done: 2 });
    expect(state.device.events.some((event) => event.detail.includes("Count: 7"))).toBe(true);
  });

  it("round-trips a mixed text, byte and floating-point record in virtual files", async () => {
    const state = await runExample("files/typed-record");
    expect(state.globals).toMatchObject({ label: "sample", version: 175, loaded: [1.5, -2, 8] });
    expect(
      state.device.files.some((file) => file.path.endsWith("typed-record.dat") && file.size > 12),
    ).toBe(true);
  });

  it("loads real project bitmap and sound resources into the isolated device", async () => {
    const state = await runExample("media/original-media");
    expect(state.device.lcd.pixels.some(Boolean)).toBe(true);
    expect(state.device.events.some((event) => event.operation === "LCD.BmpFile")).toBe(true);
    expect(state.device.events.some((event) => event.operation === "Speaker.Play")).toBe(true);
    expect(state.device.speaker.busy).toBe(false);
    expect(state.elapsedMs).toBeGreaterThan(100);
  });
});
