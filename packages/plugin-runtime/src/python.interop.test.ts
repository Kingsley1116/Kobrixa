import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PluginManager, spawnPluginProcess, type PluginNotice } from "./index.js";
import { findPython } from "./test-python.js";

const python = findPython();
const repository = fileURLToPath(new URL("../../../", import.meta.url));
let root: string;
beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "kobrixa-python-"));
});
afterAll(() => rm(root, { recursive: true, force: true }));

describe.skipIf(!python)("Python plugin interop", () => {
  it("runs the Python sample from a folder with spaces and Chinese characters", async () => {
    const directory = path.join(root, "插件 測試", "hello-python");
    await cp(path.join(repository, "plugins/samples/hello-python"), directory, { recursive: true });
    const notices: PluginNotice[] = [];
    const manager = await PluginManager.create({
      sources: [{ kind: "development", directory }],
      store: { load: async () => new Set(), save: async () => {} },
      safeMode: false,
      locale: "zh-TW",
      launcher: (plugin) =>
        spawnPluginProcess(python!, ["-u", plugin.entry], {
          cwd: plugin.directory,
          env: {
            ...process.env,
            PYTHONPATH: path.join(repository, "sdks/python"),
            PYTHONIOENCODING: "utf-8",
          },
        }),
    });
    manager.onEvent((event) => {
      if (event.type === "notice") notices.push(event.notice);
    });
    expect(await manager.executeCommand("kobrixa-samples.hello-python.greet")).toEqual({
      ok: true,
    });
    expect(notices.map((notice) => [notice.pluginId, notice.message])).toEqual([
      ["kobrixa-samples.hello-python", "來自 Python 插件的問候"],
    ]);
    await manager.shutdown();
    expect(manager.state().plugins[0]!.running).toBe(false);
  });
});
