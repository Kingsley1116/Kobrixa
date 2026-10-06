import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { build } from "esbuild";
import type { WebContents } from "electron";
import { loadProject } from "@kobrixa/compiler";
import { inspectRbf } from "@kobrixa/backend-ev3";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import type { BuildEvent } from "../../shared/api.js";
import { BuildService } from "./build.js";

let workerRoot: string;
let root: string;
let service: BuildService;
let workers: Worker[];
let events: BuildEvent[];
let destroyed: boolean;
let onEvent: ((event: BuildEvent) => void) | undefined;
beforeAll(async () => {
  workerRoot = await mkdtemp(path.join(tmpdir(), "kobrixa-build-worker-"));
  await build({
    entryPoints: [fileURLToPath(new URL("./build-worker.ts", import.meta.url))],
    outfile: path.join(workerRoot, "worker.cjs"),
    bundle: true,
    platform: "node",
    format: "cjs",
  });
});
afterAll(() => rm(workerRoot, { recursive: true, force: true }));
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "kobrixa-build-"));
  await writeFile(path.join(root, "main.bp"), "LCD.Clear()\n");
  workers = [];
  events = [];
  destroyed = false;
  onEvent = undefined;
  service = new BuildService(
    {
      project: async (id, overlays) => {
        if (id !== "project") throw new Error("Unknown workspace.");
        const loaded = await loadProject(root, overlays, "main.bp");
        if (!loaded.project) throw new Error("Invalid project.");
        return loaded.project;
      },
    },
    () =>
      ({
        isDestroyed: () => destroyed,
        send: (_channel: string, event: BuildEvent) => {
          events.push(event);
          onEvent?.(event);
        },
      }) as unknown as WebContents,
    (request) => {
      const worker = new Worker(path.join(workerRoot, "worker.cjs"), {
        workerData: request,
        execArgv: [],
      });
      workers.push(worker);
      return worker;
    },
  );
});
afterEach(async () => {
  service.dispose();
  await Promise.all(workers.map((worker) => worker.terminate()));
  await rm(root, { recursive: true, force: true });
});

async function result(id: string) {
  await vi.waitFor(
    () =>
      expect(events.some((event) => event.type === "complete" && event.buildId === id)).toBe(true),
    { timeout: 15000 },
  );
  const complete = events.filter((event) => event.type === "complete" && event.buildId === id);
  expect(complete).toHaveLength(1);
  return (complete[0] as Extract<BuildEvent, { type: "complete" }>).result;
}

it("builds unsaved sources in the packaged worker and keeps progress IDs consistent", async () => {
  const id = await service.start("project", { "main.bp": "LCD.Clear()\nLCD.Update()\n" });
  expect(service.busy).toBe(true);
  expect((await result(id)).success).toBe(true);
  expect(inspectRbf(await service.artifactBytes(id)).objectCount).toBe(1);
  expect(events.every((event) => event.buildId === id && event.workspaceId === "project")).toBe(
    true,
  );
  expect(
    events
      .filter((event) => event.type === "progress")
      .every((event) => event.progress.buildId === id),
  ).toBe(true);
  expect(service.busy).toBe(false);
});

it("keeps the main event loop responsive while compiling a large program", async () => {
  let ticks = 0;
  let compiling = false;
  onEvent = (event) => {
    if (event.type === "progress" && event.progress.stage === "frontend") compiling = true;
  };
  const timer = setInterval(() => {
    if (compiling) ticks++;
  }, 1);
  try {
    const id = await service.start("project", { "main.bp": "LCD.Clear()\n".repeat(30000) });
    expect((await result(id)).success).toBe(true);
    expect(ticks).toBeGreaterThan(2);
  } finally {
    clearInterval(timer);
  }
}, 20000);

it("cancels synchronous compiler work without replacing the previous successful artifact", async () => {
  const first = await service.start("project", {});
  const original = await result(first);
  const artifact = original.artifacts.find((item) => item.kind === "rbf")!;
  const bytes = await readFile(artifact.path);
  onEvent = (event) => {
    if (event.type === "progress" && event.progress.stage === "frontend")
      service.cancel(event.buildId);
  };
  const cancelled = await service.start("project", { "main.bp": "LCD.Clear()\n".repeat(100000) });
  expect(await result(cancelled)).toMatchObject({
    success: false,
    artifacts: [],
    diagnostics: [{ code: "BUILD0001" }],
  });
  expect(await readFile(artifact.path)).toEqual(bytes);
  expect((await readdir(path.dirname(artifact.path))).some((name) => name.endsWith(".tmp"))).toBe(
    false,
  );
  expect(service.artifacts(cancelled)).toEqual([]);
  onEvent = undefined;
  expect((await result(await service.start("project", {}))).success).toBe(true);
}, 20000);

it("reports worker exit once, releases the busy gate, and allows the next build", async () => {
  const id = await service.start("project", { "main.bp": "LCD.Clear()\n".repeat(30000) });
  await workers[0]!.terminate();
  expect(await result(id)).toMatchObject({ success: false, diagnostics: [{ code: "BUILD9000" }] });
  expect(service.busy).toBe(false);
  expect((await result(await service.start("project", {}))).success).toBe(true);
});

it("returns compiler diagnostics without deployable output", async () => {
  const id = await service.start("project", { "main.bp": "Unknown.Do()\n" });
  expect(await result(id)).toMatchObject({ success: false, diagnostics: [{ code: "BP3001" }] });
  await expect(service.artifactBytes(id)).rejects.toThrow("no deployable");
});

it("does not send into destroyed windows and rejects new builds after disposal", async () => {
  destroyed = true;
  await service.start("project", {});
  await vi.waitFor(() => expect(service.busy).toBe(false));
  expect(events).toEqual([]);
  service.dispose();
  await expect(service.start("project", {})).rejects.toThrow("disposed");
});
