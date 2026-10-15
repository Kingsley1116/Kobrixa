import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { WebContents } from "electron";
import { loadProject } from "@kobrixa/compiler";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { BuildEvent } from "../../shared/api.js";
import { BuildService } from "./build.js";
import { WorkspaceService } from "./workspace.js";

const showOpenDialog = vi.hoisted(() => vi.fn());
vi.mock("electron", () => ({
  app: { getPath: () => tmpdir() },
  dialog: { showOpenDialog },
  shell: { trashItem: vi.fn() },
}));

let root: string;
let workspace: WorkspaceService;
let workspaceId: string;
let service: BuildService;
let events: BuildEvent[];
const createWorker = vi.fn(() => {
  throw new Error("must not start worker");
});
const manifest = {
  schemaVersion: 1,
  name: "project-load",
  language: "bp",
  target: "ev3-native",
  entry: "main.bp",
  assets: [],
  outputDir: "build",
};
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "kobrixa-project-load-"));
  await writeFile(path.join(root, "main.bp"), "LCD.Clear()\n");
  await writeFile(path.join(root, "kobrixa.json"), JSON.stringify(manifest));
  showOpenDialog.mockResolvedValue({ filePaths: [root] });
  workspace = new WorkspaceService({ userDataPath: () => path.join(root, "user-data") });
  workspaceId = (await workspace.open())!.id;
  events = [];
  createWorker.mockClear();
  service = new BuildService(
    workspace,
    () =>
      ({
        isDestroyed: () => false,
        send: (_channel: string, event: BuildEvent) => events.push(event),
      }) as unknown as WebContents,
    createWorker,
  );
});
afterEach(async () => {
  service.dispose();
  await rm(root, { recursive: true, force: true });
});

const cases = [
  { label: "invalid JSON", raw: "{", code: "MAN1001" },
  {
    label: "manifest typo",
    raw: JSON.stringify({ ...manifest, schemaVersion: "1" }),
    code: "MAN1001",
  },
  {
    label: "multiple invalid fields",
    raw: JSON.stringify({ ...manifest, schemaVersion: "1", name: "" }),
    code: "MAN1001",
  },
  {
    label: "missing entry",
    raw: JSON.stringify({ ...manifest, entry: "missing.bp" }),
    code: "MAN1002",
  },
  {
    label: "outputDir contains source root",
    raw: JSON.stringify({ ...manifest, outputDir: "." }),
    code: "MAN1004",
  },
  {
    label: "unsupported entry extension",
    raw: JSON.stringify({ ...manifest, entry: "main.txt" }),
    code: "MAN1002",
  },
];

it.each(cases.flatMap((item) => ["build", "simulation"].map((mode) => ({ ...item, mode }))))(
  "preserves $code for $label in $mode without a worker",
  async ({ raw, code, mode }) => {
    await writeFile(path.join(root, "main.txt"), "LCD.Clear()\n");
    await writeFile(path.join(root, "kobrixa.json"), raw);
    const loaded = await loadProject(root);
    if (mode === "build") {
      const buildId = await service.start(workspaceId, {});
      const completed = events.filter((event) => event.type === "complete");
      expect(completed).toHaveLength(1);
      expect(completed[0]).toMatchObject({
        buildId,
        result: { success: false, artifacts: [], diagnostics: loaded.diagnostics },
      });
      expect(service.artifacts(buildId)).toEqual([]);
    } else {
      expect(await service.prepareSimulation(workspaceId, {}, ["main.bp"])).toEqual({
        success: false,
        diagnostics: loaded.diagnostics,
      });
    }
    expect(loaded.diagnostics.every((item) => item.code === code)).toBe(true);
    expect(loaded.diagnostics.length).toBeGreaterThan(0);
    expect(createWorker).not.toHaveBeenCalled();
    expect(service.busy).toBe(false);
  },
);

it.each(["BUILD1001", "BUILD1002"] as const)(
  "preserves %s with a single displayed prefix",
  async (code) => {
    service.dispose();
    service = new BuildService(
      workspace,
      () =>
        ({
          isDestroyed: () => false,
          send: (_channel: string, event: BuildEvent) => events.push(event),
        }) as unknown as WebContents,
      createWorker,
      () => ({
        ok: false,
        code,
        message: "Provider resolution failed.",
      }),
    );
    await service.start(workspaceId, {});
    const completed = events.find((event) => event.type === "complete");
    expect(completed?.result.diagnostics).toEqual([
      expect.objectContaining({ code, message: "Provider resolution failed." }),
    ]);
    const simulation = await service.prepareSimulation(workspaceId, {}, ["main.bp"]);
    expect(simulation.success).toBe(false);
    expect(simulation.diagnostics).toEqual([
      expect.objectContaining({ code, message: "Provider resolution failed." }),
    ]);
    expect(createWorker).not.toHaveBeenCalled();
    expect(service.busy).toBe(false);
  },
);
