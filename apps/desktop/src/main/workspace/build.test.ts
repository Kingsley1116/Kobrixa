import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { EventEmitter } from "node:events";
import { build } from "esbuild";
import type { WebContents } from "electron";
import { BuildError, loadProject } from "@kobrixa/compiler";
import { inspectRbf } from "@kobrixa/backend-ev3";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import type { BuildEvent } from "../../shared/api.js";
import { BuildService } from "./build.js";
import { resolveBuiltinCompiler } from "./builtin-compilers.js";
import { PreviewRuntime } from "../../preview/runtime.js";
import type { BuildRequest } from "./build-protocol.js";
import type { SimulationPrepareResult } from "../../shared/simulator.js";

let workerRoot: string;
let root: string;
let service: BuildService;
let workers: Worker[];
let events: BuildEvent[];
let destroyed: boolean;
let onEvent: ((event: BuildEvent) => void) | undefined;
beforeAll(async () => {
  workerRoot = await realpath(await mkdtemp(path.join(tmpdir(), "kobrixa-build-worker-")));
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
  root = await realpath(await mkdtemp(path.join(tmpdir(), "kobrixa-build-")));
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

it("asks the plugin registry for the project's frontend", async () => {
  const requests: BuildRequest[] = [];
  service.dispose();
  service = new BuildService(
    { project: async (_id, overlays) => (await loadProject(root, overlays, "main.bp")).project! },
    () =>
      ({
        isDestroyed: () => false,
        send: (_channel: string, event: BuildEvent) => events.push(event),
      }) as unknown as WebContents,
    (request) => {
      requests.push(request);
      return new Worker(path.join(workerRoot, "worker.cjs"), { workerData: request });
    },
    resolveBuiltinCompiler,
  );
  await service.start("project", {});
  await vi.waitFor(() => expect(events.some((event) => event.type === "complete")).toBe(true), {
    timeout: 15000,
  });
  expect(requests[0]!.compiler).toMatchObject({
    frontend: { pluginId: "kobrixa.basic-plus" },
    backend: { pluginId: "kobrixa.ev3" },
    ir: 1,
  });
  expect(events.find((event) => event.type === "complete")).toMatchObject({
    result: { success: true },
  });
});

it("does not open a worker when a provider is missing or incompatible", async () => {
  for (const code of ["BUILD1001", "BUILD1002"] as const) {
    service.dispose();
    const create = vi.fn(() => {
      throw new Error("must not start worker");
    });
    service = new BuildService(
      { project: async (_id, overlays) => (await loadProject(root, overlays, "main.bp")).project! },
      () =>
        ({
          isDestroyed: () => false,
          send: (_channel: string, event: BuildEvent) => events.push(event),
        }) as unknown as WebContents,
      create,
      () => ({ ok: false, code, message: "provider unavailable" }),
    );
    const id = await service.start("project", {});
    expect(await result(id)).toMatchObject({
      success: false,
      artifacts: [],
      diagnostics: [expect.objectContaining({ code })],
    });
    expect(create).not.toHaveBeenCalled();
    expect(service.busy).toBe(false);
  }
});

it.each([new Error("worker failure"), "worker failure"])(
  "reports worker error %s",
  async (error) => {
    service.dispose();
    service = new BuildService(
      { project: async (_id, overlays) => (await loadProject(root, overlays, "main.bp")).project! },
      () =>
        ({
          isDestroyed: () => false,
          send: (_channel: string, event: BuildEvent) => events.push(event),
        }) as unknown as WebContents,
      () => {
        // Keep the worker alive until the test injects its error, even on fast machines.
        const worker = new Worker("setInterval(() => {}, 1000)", { eval: true });
        workers.push(worker);
        return worker;
      },
    );
    const id = await service.start("project", {});
    await vi.waitFor(() => expect(workers).toHaveLength(1));
    workers[0]!.emit("error", error);
    expect(await result(id)).toMatchObject({
      success: false,
      diagnostics: [expect.objectContaining({ code: "BUILD9000", message: "worker failure" })],
    });
    expect(service.busy).toBe(false);
  },
);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

it("supersedes delayed simulation compilers and waits for termination through rapid replacements", async () => {
  const loaded = await loadProject(root, new Map(), "main.bp");
  const firstTermination = deferred<number>();
  const created: Array<{
    emitter: EventEmitter;
    request: BuildRequest;
    terminate: ReturnType<typeof vi.fn>;
  }> = [];
  service.dispose();
  service = new BuildService(
    { project: async () => loaded.project! },
    () => undefined,
    (request) => {
      const emitter = new EventEmitter();
      const index = created.length;
      const terminate = vi.fn(() => (index === 0 ? firstTermination.promise : Promise.resolve(0)));
      created.push({ emitter, request, terminate });
      return Object.assign(emitter, { terminate }) as unknown as Worker;
    },
  );
  const cancelledFirst = service
    .prepareSimulation("project", {}, ["main.bp"])
    .catch((error: Error) => error);
  await vi.waitFor(() => expect(created).toHaveLength(1));
  const cancelledSecond = service
    .prepareSimulation("project", {}, ["main.bp"])
    .catch((error: Error) => error);
  const latest = service.prepareSimulation("project", {}, ["main.bp"]);
  await Promise.resolve();
  expect(created).toHaveLength(1);
  expect(created[0]!.terminate).toHaveBeenCalledTimes(1);
  expect(Atomics.load(new Int32Array(created[0]!.request.cancellation), 0)).toBe(1);
  const response: SimulationPrepareResult = {
    success: true,
    diagnostics: [],
    prepared: { programs: {} },
  };
  created[0]!.emitter.emit("message", { type: "simulation", result: response });
  firstTermination.resolve(0);
  expect(await cancelledFirst).toMatchObject({ name: "AbortError" });
  expect(await cancelledSecond).toMatchObject({ name: "AbortError" });
  await vi.waitFor(() => expect(created).toHaveLength(2));
  expect(service.busy).toBe(true);
  created[1]!.emitter.emit("message", { type: "simulation", result: response });
  expect(await latest).toEqual(response);
  expect(created[1]!.terminate).toHaveBeenCalledTimes(1);
  expect(service.busy).toBe(false);
});

it("cancels preparation ownership while source capture is pending and ignores its late result", async () => {
  const loaded = await loadProject(root, new Map(), "main.bp");
  const capture = deferred<NonNullable<typeof loaded.project>>();
  const project = vi.fn().mockReturnValueOnce(capture.promise).mockResolvedValue(loaded.project!);
  const create = vi.fn((request: BuildRequest) => {
    const worker = new Worker(path.join(workerRoot, "worker.cjs"), {
      workerData: request,
      execArgv: [],
    });
    workers.push(worker);
    return worker;
  });
  service.dispose();
  service = new BuildService({ project }, () => undefined, create);
  const cancelled = service
    .prepareSimulation("project", {}, ["main.bp"])
    .catch((error: Error) => error);
  await vi.waitFor(() => expect(project).toHaveBeenCalledTimes(1));
  const next = service.prepareSimulation("project", {}, ["main.bp"]);
  expect(await cancelled).toMatchObject({ name: "AbortError" });
  expect((await next).success).toBe(true);
  capture.resolve(loaded.project!);
  await Promise.resolve();
  expect(create).toHaveBeenCalledTimes(1);
  expect(service.busy).toBe(false);
});

it("explicitly cancels active simulation preparation and disposes a pending capture", async () => {
  const loaded = await loadProject(root, new Map(), "main.bp");
  const capture = deferred<NonNullable<typeof loaded.project>>();
  const project = vi.fn().mockResolvedValueOnce(loaded.project!).mockReturnValue(capture.promise);
  const emitter = new EventEmitter();
  const terminate = vi.fn(async () => 0);
  const create = vi.fn(() => Object.assign(emitter, { terminate }) as unknown as Worker);
  service.dispose();
  service = new BuildService({ project }, () => undefined, create);
  const active = service
    .prepareSimulation("project", {}, ["main.bp"])
    .catch((error: Error) => error);
  await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1));
  service.cancelSimulation("project");
  service.cancelSimulation("project");
  expect(await active).toMatchObject({ name: "AbortError" });
  expect(terminate).toHaveBeenCalledTimes(1);
  const pending = service
    .prepareSimulation("project", {}, ["main.bp"])
    .catch((error: Error) => error);
  await vi.waitFor(() => expect(project).toHaveBeenCalledTimes(2));
  service.dispose();
  expect(await pending).toMatchObject({ name: "AbortError" });
  expect(service.busy).toBe(false);
  capture.resolve(loaded.project!);
  await Promise.resolve();
  expect(create).toHaveBeenCalledTimes(1);
});

it("prepares multiple independent program entries without changing project or build outputs", async () => {
  await writeFile(path.join(root, "other.bp"), "value = 22\n");
  const id = await service.start("project", {});
  const built = await result(id);
  const original = await Promise.all(built.artifacts.map((artifact) => readFile(artifact.path)));
  const prepared = await service.prepareSimulation("project", { "main.bp": "value = 11\n" }, [
    "main.bp",
    "other.bp",
    "main.bp",
  ]);
  expect(prepared.success).toBe(true);
  if (!prepared.success) return;
  expect(Object.keys(prepared.prepared.programs)).toEqual(["main.bp", "other.bp"]);
  for (const [entry, value] of [
    ["main.bp", 11],
    ["other.bp", 22],
  ] as const) {
    const runtime = new PreviewRuntime(prepared.prepared.programs[entry]!.ir);
    runtime.resume();
    expect(runtime.runSlice(1000, 0).globals.value).toBe(value);
  }
  expect(await readFile(path.join(root, "main.bp"), "utf8")).toBe("LCD.Clear()\n");
  expect(await Promise.all(built.artifacts.map((artifact) => readFile(artifact.path)))).toEqual(
    original,
  );
  expect(service.busy).toBe(false);
});

it("rejects missing entries and fails the whole preparation when any program is invalid", async () => {
  expect(await service.prepareSimulation("project", {}, ["../outside.bp"])).toMatchObject({
    success: false,
  });
  await writeFile(path.join(root, "broken.bp"), "If Then\n");
  const result = await service.prepareSimulation("project", {}, ["main.bp", "broken.bp"]);
  expect(result.success).toBe(false);
  expect(
    result.diagnostics.some((item) => item.file === "broken.bp" && item.severity === "error"),
  ).toBe(true);
  expect(await readdir(root)).not.toContain("build");
});

it("prepares an all-builtin match without a program and rejects more than four entries", async () => {
  expect(await service.prepareSimulation("project", {}, [])).toMatchObject({
    success: true,
    prepared: { programs: {} },
  });
  expect(await service.prepareSimulation("project", {}, Array(5).fill("main.bp"))).toMatchObject({
    success: false,
  });
});

it("captures original resources once and never rereads changed files into a prepared program", async () => {
  await writeFile(
    path.join(root, "kobrixa.json"),
    JSON.stringify({
      schemaVersion: 1,
      name: "assets",
      language: "bp",
      target: "ev3-native",
      entry: "main.bp",
      assets: ["data.bin"],
      outputDir: "build",
    }),
  );
  await writeFile(path.join(root, "data.bin"), new Uint8Array([1, 2, 3]));
  const result = await service.prepareSimulation("project", {}, ["main.bp"]);
  expect(result.success).toBe(true);
  await writeFile(path.join(root, "data.bin"), new Uint8Array([9]));
  if (result.success)
    expect(result.prepared.programs["main.bp"]!.files["data.bin"]).toEqual([1, 2, 3]);
  expect(await readdir(root)).not.toContain("build");
  await writeFile(path.join(root, "data.bin"), new Uint8Array(1024 * 1024 + 1));
  await expect(service.prepareSimulation("project", {}, ["main.bp"])).rejects.toThrow("1 MiB");
  expect(service.busy).toBe(false);
});

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
  const artifact = original.artifacts.find((item) => item.role === "deploy-main")!;
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
  await vi.waitFor(() => expect(workers).toHaveLength(1));
  await workers[0]!.terminate();
  expect(await result(id)).toMatchObject({ success: false, diagnostics: [{ code: "BUILD9000" }] });
  expect(service.busy).toBe(false);
  expect((await result(await service.start("project", {}))).success).toBe(true);
});

it("previews the exact compiled source snapshot even after artifacts are overwritten", async () => {
  const id = await service.start("project", { "main.bp": 'LCD.Write(0, 0, "snapshot")\n' }, true);
  expect((await result(id)).success).toBe(true);
  const original = service.preview(id);
  expect(JSON.stringify(original)).toContain("snapshot");
  const next = await service.start("project", { "main.bp": 'LCD.Write(0, 0, "changed")\n' });
  expect((await result(next)).success).toBe(true);
  expect(service.preview(id)).toEqual(original);
  original.ir.program.name = "mutated caller";
  expect(service.preview(id).ir.program.name).not.toBe("mutated caller");
  expect(() => service.preview(next)).toThrow("no offline preview snapshot");
  const failed = await service.start("project", { "main.bp": "Unknown.Do()\n" }, true);
  expect((await result(failed)).success).toBe(false);
  expect(() => service.preview(failed)).toThrow("no offline preview snapshot");
});

it("retains only the latest requested preview and rejects snapshots after disposal", async () => {
  const first = await service.start("project", {}, true);
  await result(first);
  const next = await service.start("project", {}, true);
  await result(next);
  expect(() => service.preview(first)).toThrow("no offline preview snapshot");
  expect(service.preview(next).ir.version).toBe(1);
  service.dispose();
  expect(() => service.preview(next)).toThrow("no offline preview snapshot");
});

it("copies bounded project assets into the preview without exposing host paths", async () => {
  const asset = Buffer.from([2, 0, 1, 0, 3]);
  await writeFile(path.join(root, "picture.rgf"), asset);
  await writeFile(
    path.join(root, "kobrixa.json"),
    JSON.stringify({
      schemaVersion: 1,
      name: "preview-assets",
      language: "bp",
      entry: "main.bp",
      target: "ev3-native",
      assets: ["*.rgf"],
      outputDir: "build",
    }),
  );
  const id = await service.start("project", {}, true);
  expect((await result(id)).success).toBe(true);
  expect(service.preview(id).files).toEqual({ "picture.rgf": [...asset] });
  await writeFile(path.join(root, "picture.rgf"), Buffer.alloc(1024 * 1024 + 1));
  const oversized = await service.start("project", {}, true);
  expect((await result(oversized)).success).toBe(true);
  expect(() => service.preview(oversized)).toThrow("1 MiB");
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

it("reports project load failures through complete events without rejecting start", async () => {
  service.dispose();
  const create = vi.fn(() => {
    throw new Error("must not start worker");
  });
  service = new BuildService(
    {
      project: async () => {
        throw new BuildError("BUILD1003", "Invalid project.");
      },
    },
    () =>
      ({
        isDestroyed: () => false,
        send: (_channel: string, event: BuildEvent) => events.push(event),
      }) as unknown as WebContents,
    create,
  );
  const id = await service.start("project", {});
  expect(await result(id)).toMatchObject({
    buildId: id,
    success: false,
    artifacts: [],
    diagnostics: [expect.objectContaining({ code: "BUILD1003" })],
  });
  expect(create).not.toHaveBeenCalled();
  expect(service.busy).toBe(false);
});

it("preserves BUILD1001 from a missing built-in factory in the bundled worker", async () => {
  service.dispose();
  service = new BuildService(
    { project: async (_id, overlays) => (await loadProject(root, overlays, "main.bp")).project! },
    () =>
      ({
        isDestroyed: () => false,
        send: (_channel: string, event: BuildEvent) => events.push(event),
      }) as unknown as WebContents,
    (request) => {
      const worker = new Worker(path.join(workerRoot, "worker.cjs"), { workerData: request });
      workers.push(worker);
      return worker;
    },
    (language, target) => {
      const snapshot = resolveBuiltinCompiler(language, target);
      if (!snapshot.ok) throw new Error(snapshot.message);
      return { ...snapshot, backend: { ...snapshot.backend, pluginId: "test.missing" } };
    },
  );
  expect(await result(await service.start("project", {}))).toMatchObject({
    success: false,
    artifacts: [],
    diagnostics: [expect.objectContaining({ code: "BUILD1001" })],
  });
});

it("keeps queued builds busy, captures compiler snapshots once, and skips cancelled workers", async () => {
  service.dispose();
  const snapshot = resolveBuiltinCompiler("bp", "ev3-native");
  if (!snapshot.ok) throw new Error(snapshot.message);
  const resolve = vi.fn(() => snapshot);
  const created: Array<{ request: BuildRequest; worker: EventEmitter }> = [];
  service = new BuildService(
    { project: async (_id, overlays) => (await loadProject(root, overlays, "main.bp")).project! },
    () =>
      ({
        isDestroyed: () => false,
        send: (_channel: string, event: BuildEvent) => events.push(event),
      }) as unknown as WebContents,
    (request) => {
      const worker = Object.assign(new EventEmitter(), { terminate: vi.fn(async () => 0) });
      created.push({ request, worker });
      return worker as unknown as Worker;
    },
    resolve,
  );
  const first = await service.start("project", {});
  await vi.waitFor(() => expect(created).toHaveLength(1));
  const cancelled = await service.start("project", {});
  const third = await service.start("project", {});
  expect(service.busy).toBe(true);
  expect(created).toHaveLength(1);
  expect(resolve).toHaveBeenCalledTimes(3);
  snapshot.backend.pluginId = "test.changed-after-capture";
  service.cancel(cancelled);
  created[0]!.worker.emit("message", {
    type: "complete",
    result: { buildId: first, target: "ev3-native", success: true, artifacts: [], diagnostics: [] },
  });
  expect(await result(cancelled)).toMatchObject({
    success: false,
    artifacts: [],
    diagnostics: [expect.objectContaining({ code: "BUILD0001" })],
  });
  await vi.waitFor(() => expect(created).toHaveLength(2));
  expect(created[1]!.request.buildId).toBe(third);
  expect(created[1]!.request.compiler.backend.pluginId).toBe("kobrixa.ev3");
  expect(resolve).toHaveBeenCalledTimes(3);
  expect(service.busy).toBe(true);
  created[1]!.worker.emit("message", {
    type: "complete",
    result: { buildId: third, target: "ev3-native", success: true, artifacts: [], diagnostics: [] },
  });
  expect((await result(third)).success).toBe(true);
  expect(service.busy).toBe(false);
});
