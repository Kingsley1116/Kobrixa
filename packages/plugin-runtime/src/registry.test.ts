import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadPlugins } from "./index.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "kobrixa-plugins-"));
});
afterEach(() => rm(root, { recursive: true, force: true }));

const manifest = (overrides: Record<string, unknown> = {}) => ({
  id: "acme.hello",
  version: "1.0.0",
  apiVersion: "^1.0.0",
  runtime: { kind: "python", entry: "main.py" },
  activationEvents: ["onCommand:acme.hello.greet"],
  permissions: ["ui.notifications"],
  contributes: { commands: [{ id: "acme.hello.greet", title: "Greet" }] },
  ...overrides,
});
async function plugin(name: string, value: unknown, entry = "main.py", prefix = "") {
  const directory = path.join(root, name);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "kobrixa-plugin.json"), prefix + JSON.stringify(value));
  await writeFile(path.join(directory, entry), "");
  return { kind: "development" as const, directory };
}
const builtin = {
  kind: "builtin" as const,
  manifest: {
    id: "kobrixa.basic-plus",
    version: "1.0.0",
    apiVersion: "^1.0.0",
    runtime: { kind: "builtin" },
    contributes: { frontends: [{ language: "bp" }] },
  },
};
const none = { disabled: new Set<string>(), safeMode: false };

describe("loadPlugins", () => {
  it("loads development plugins from folders with spaces and non-ASCII names", async () => {
    const [loaded] = await loadPlugins([await plugin("插件 測試", manifest())], none);
    expect(loaded).toMatchObject({ id: "acme.hello", status: "enabled", problems: [] });
    expect(loaded!.entry).toMatch(/main\.py$/);
  });
  it("accepts a UTF-8 byte order mark written by Windows editors", async () => {
    const [loaded] = await loadPlugins([await plugin("bom", manifest(), "main.py", "﻿")], none);
    expect(loaded!.status).toBe("enabled");
  });
  it("marks disabled and safe-mode plugins before contributions load", async () => {
    const source = await plugin("a", manifest());
    expect(
      (await loadPlugins([source], { disabled: new Set(["acme.hello"]), safeMode: false }))[0],
    ).toMatchObject({ status: "disabled", disabledBy: "user" });
    expect((await loadPlugins([source], { disabled: new Set(), safeMode: true }))[0]).toMatchObject(
      { status: "disabled", disabledBy: "safe-mode" },
    );
    expect(
      (
        await loadPlugins([builtin], { disabled: new Set(["kobrixa.basic-plus"]), safeMode: true })
      )[0]!.status,
    ).toBe("enabled");
  });
  it.each([
    ["PLUGIN_E_API_VERSION", { apiVersion: "^2.0.0" }],
    ["PLUGIN_E_RUNTIME_NOT_ALLOWED", { runtime: { kind: "builtin" } }],
    ["PLUGIN_E_FRONTEND_REQUIRES_BUILTIN", { contributes: { frontends: [{ language: "bp" }] } }],
    [
      "PLUGIN_E_COMMAND_NAMESPACE",
      { contributes: { commands: [{ id: "other.greet", title: "x" }] }, activationEvents: [] },
    ],
    [
      "PLUGIN_E_DUPLICATE_COMMAND",
      {
        contributes: {
          commands: [
            { id: "acme.hello.a", title: "x" },
            { id: "acme.hello.a", title: "y" },
          ],
        },
        activationEvents: [],
      },
    ],
    ["PLUGIN_E_ACTIVATION", { activationEvents: ["onCommand:acme.hello.missing"] }],
    ["PLUGIN_E_MANIFEST", { id: "Bad" }],
  ])("reports %s", async (code, overrides) => {
    const [loaded] = await loadPlugins([await plugin("p", manifest(overrides))], none);
    expect(loaded!.status).toBe("invalid");
    expect(loaded!.problems.map((problem) => problem.code)).toContain(code);
  });
  // Windows users may not have permission to create symlinks.
  it.skipIf(process.platform === "win32")(
    "rejects a missing entry and an entry symlinked outside the folder",
    async () => {
      const missing = await plugin(
        "missing",
        manifest({ runtime: { kind: "python", entry: "nope.py" } }),
      );
      expect((await loadPlugins([missing], none))[0]!.problems[0]!.code).toBe("PLUGIN_E_ENTRY");
      const outside = path.join(root, "outside.py");
      await writeFile(outside, "");
      const linked = await plugin(
        "linked",
        manifest({ runtime: { kind: "python", entry: "link.py" } }),
        "unused.py",
      );
      await symlink(outside, path.join(linked.directory, "link.py"));
      expect((await loadPlugins([linked], none))[0]!.problems[0]!.code).toBe("PLUGIN_E_ENTRY");
    },
  );
  it("reports unreadable folders, oversized and non-JSON manifests", async () => {
    const results = await loadPlugins(
      [
        { kind: "development", directory: path.join(root, "absent") },
        await plugin("big", { padding: "x".repeat(70 * 1024) }),
      ],
      none,
    );
    expect(results.map((item) => item.problems[0]?.code)).toEqual([
      "PLUGIN_E_MANIFEST",
      "PLUGIN_E_MANIFEST",
    ]);
  });
  it("rejects a command id that another plugin already contributes", async () => {
    const first = await plugin(
      "hello",
      manifest({
        activationEvents: [],
        contributes: { commands: [{ id: "acme.hello.extra.run", title: "x" }] },
      }),
    );
    const second = await plugin(
      "extra",
      manifest({
        id: "acme.hello.extra",
        activationEvents: [],
        contributes: { commands: [{ id: "acme.hello.extra.run", title: "y" }] },
      }),
    );
    const results = await loadPlugins([first, second], {
      disabled: new Set(["acme.hello"]),
      safeMode: false,
    });
    // The first plugin is disabled but still owns the id, so enabling it later cannot collide.
    expect(results.map((item) => item.status)).toEqual(["disabled", "invalid"]);
    expect(results[1]!.problems[0]!.code).toBe("PLUGIN_E_DUPLICATE_COMMAND");
  });
  it("keeps the first plugin when ids collide and protects built-in ids", async () => {
    const results = await loadPlugins(
      [
        builtin,
        await plugin(
          "spoof",
          manifest({ id: "kobrixa.basic-plus", activationEvents: [], contributes: {} }),
        ),
      ],
      none,
    );
    expect(results.map((item) => item.status)).toEqual(["enabled", "invalid"]);
    expect(results[1]!.problems[0]!.code).toBe("PLUGIN_E_DUPLICATE_ID");
  });
  it("throws on an invalid built-in manifest", async () => {
    await expect(loadPlugins([{ kind: "builtin", manifest: { id: "x" } }], none)).rejects.toThrow(
      /built-in/i,
    );
  });
});
