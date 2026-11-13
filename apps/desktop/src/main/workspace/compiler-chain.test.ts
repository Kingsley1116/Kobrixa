import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Worker } from "node:worker_threads";
import type { WebContents } from "electron";
import { expect, it, vi } from "vitest";
import { BuildSession, loadProject } from "@kobrixa/compiler";
import { PluginManager } from "@kobrixa/plugin-runtime";
import { BuildService } from "./build.js";
import { createBuiltinCompilers, resolveBuiltinCompiler } from "./builtin-compilers.js";
import type { BuildEvent } from "../../shared/api.js";
import {
  testBackend,
  testFrontend,
  TEST_BACKEND_DECL,
} from "../../../../../packages/compiler/src/test-build.js";
it("builds a test-only language and non-rbf target through resolution commit and deployment selection", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kobrixa-chain-"));
  let service: BuildService | undefined;
  const source = (id: string, contributes: unknown) => ({
    kind: "builtin" as const,
    policy: "required" as const,
    resources: {},
    manifest: {
      id,
      version: "1.0.0",
      apiVersion: "^1.1.0",
      runtime: { kind: "builtin" },
      contributes,
    },
  });
  const manager = await PluginManager.create({
    safeMode: false,
    locale: "en",
    launcher: vi.fn(),
    sources: [
      source("test.toy", {
        frontends: [
          {
            language: "toy",
            entryExtensions: ["toy"],
            sourceExtensions: ["toy", "inc"],
            ir: { min: 1, max: 1 },
          },
        ],
      }),
      source("test.vm", { backends: [TEST_BACKEND_DECL] }),
    ],
    store: {
      load: async () => ({ disabled: new Set(), legacyDisabledIds: new Set() }),
      save: async () => {},
    },
  });
  try {
    await writeFile(path.join(root, "main.toy"), "disk");
    await writeFile(path.join(root, "lib.inc"), "library");
    await writeFile(path.join(root, "b.dat"), new Uint8Array([2]));
    await writeFile(path.join(root, "a.dat"), new Uint8Array([1]));
    await writeFile(
      path.join(root, "kobrixa.json"),
      JSON.stringify({
        schemaVersion: 1,
        name: "demo",
        language: "toy",
        target: "toy-vm",
        entry: "main.toy",
        outputDir: "build",
        assets: ["*.dat"],
      }),
    );
    const events: BuildEvent[] = [];
    service = new BuildService(
      {
        project: async (_id, overlays, resolve) => {
          const loaded = await loadProject(root, overlays, undefined, undefined, resolve);
          if (!loaded.project) throw new Error(JSON.stringify(loaded.diagnostics));
          return loaded.project;
        },
      },
      () =>
        ({
          isDestroyed: () => false,
          send: (_channel: string, event: BuildEvent) => events.push(event),
        }) as unknown as WebContents,
      (request) => {
        expect(request.compiler.frontend.pluginId).toBe("test.toy");
        expect(request.compiler.backend.pluginId).toBe("test.vm");
        expect(request.project.sources).toEqual([
          { path: "lib.inc", content: "library" },
          { path: "main.toy", content: "overlay" },
        ]);
        const emitter = new EventEmitter();
        const backend = testBackend();
        backend.compile = async () => ({
          diagnostics: [],
          artifacts: [
            { slot: "program", data: new Uint8Array([3]) },
            { slot: "notes", data: new TextEncoder().encode("notes") },
            { slot: "map", data: new TextEncoder().encode("{}") },
          ],
        });
        void new BuildSession(testFrontend, backend, undefined, undefined, request.buildId)
          .compile(request.project)
          .then((result) => {
            emitter.emit("message", { type: "complete", result });
            emitter.emit("exit", 0);
          })
          .catch((error: unknown) => emitter.emit("error", error));
        return Object.assign(emitter, { terminate: async () => 0 }) as unknown as Worker;
      },
      (language, target) => manager.resolveCompiler(language, target),
    );
    const id = await service.start("w", { "main.toy": "overlay" });
    await vi.waitFor(() => expect(events.some((event) => event.type === "complete")).toBe(true));
    const complete = events.find(
      (event): event is Extract<BuildEvent, { type: "complete" }> => event.type === "complete",
    )!;
    expect(complete.result).toMatchObject({
      buildId: id,
      target: "toy-vm",
      success: true,
      deploy: "ev3",
    });
    expect(complete.result.artifacts.filter((item) => item.role === "aux")).toHaveLength(3);
    const files = await service.deployableArtifacts(id);
    expect(files.map((file) => [file.role, file.remotePath, [...file.bytes]])).toEqual([
      ["deploy-asset", "a.dat", [1]],
      ["deploy-asset", "b.dat", [2]],
      ["deploy-main", "demo.bin", [3]],
    ]);
  } finally {
    service?.dispose();
    await manager.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

it("publishes provider identities from the compiler snapshot", () => {
  const resolution = resolveBuiltinCompiler("bp", "ev3-native");
  if (!resolution.ok) throw new Error(resolution.message);
  expect(createBuiltinCompilers(resolution).sources).toEqual({
    frontend: "kobrixa.basic-plus",
    backend: "kobrixa.ev3",
  });
});
