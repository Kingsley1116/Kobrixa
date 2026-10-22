import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { developmentSourceKey, loadPlugins, readSource, sourceKeySchema } from "./index.js";

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
  policy: "required" as const,
  resources: {},
  manifest: {
    id: "kobrixa.basic-plus",
    version: "1.0.0",
    apiVersion: "^1.0.0",
    runtime: { kind: "builtin" },
    contributes: {
      frontends: [
        {
          language: "bp",
          entryExtensions: ["bp"],
          sourceExtensions: ["bp", "bpi", "bpm"],
          ir: { min: 1, max: 1 },
        },
      ],
    },
  },
};
const none = { disabled: new Set<string>(), safeMode: false };

describe("loadPlugins", () => {
  it.each([
    { languageServices: [] },
    { languageServices: [{ language: "bp", extensions: ["bp"], capabilities: ["analysis"] }] },
  ])(
    "rejects development languageServices even when empty: $languageServices",
    async ({ languageServices }) => {
      const source = await plugin(
        "language",
        manifest({ activationEvents: [], contributes: { languageServices } }),
      );
      const [loaded] = await loadPlugins([source], none);
      expect(loaded?.status).toBe("invalid");
      expect(loaded?.problems.map((p) => p.code)).toContain(
        "PLUGIN_E_LANGUAGE_SERVICE_REQUIRES_BUILTIN",
      );
    },
  );
  it("rejects a built-in language declaration without its frontend", async () => {
    await expect(
      readSource(
        {
          kind: "builtin",
          policy: "required",
          resources: {},
          manifest: {
            id: "test.language",
            version: "1.0.0",
            apiVersion: "^1.3.0",
            runtime: { kind: "builtin" },
            contributes: {
              languageServices: [
                { language: "bp", extensions: ["bp"], capabilities: ["analysis"] },
              ],
            },
          },
        },
        { safeMode: false },
      ),
    ).rejects.toThrow("Invalid built-in plugin manifest");
  });
  it("rejects the reserved kobrixa.core identity", async () => {
    const [loaded] = await loadPlugins(
      [
        await plugin(
          "core",
          manifest({
            id: "kobrixa.core",
            activationEvents: ["onCommand:kobrixa.core.greet"],
            contributes: { commands: [{ id: "kobrixa.core.greet", title: "Greet" }] },
          }),
        ),
      ],
      none,
    );
    expect(loaded).toMatchObject({ status: "invalid" });
    expect(loaded!.problems.map((item) => item.code)).toContain("PLUGIN_E_RESERVED_ID");
  });
  it("keeps the built-in plugin when a development plugin reuses its id", async () => {
    const impostor = await plugin(
      "impostor",
      manifest({
        id: "kobrixa.basic-plus",
        activationEvents: ["onCommand:kobrixa.basic-plus.greet"],
        contributes: { commands: [{ id: "kobrixa.basic-plus.greet", title: "Greet" }] },
      }),
    );
    for (const order of [
      [builtin, impostor],
      [impostor, builtin],
    ]) {
      const loaded = await loadPlugins(order, none);
      const real = loaded.find((item) => item.source === "builtin")!;
      const fake = loaded.find((item) => item.source === "development")!;
      expect(real.status).toBe("enabled");
      expect(fake.problems.map((item) => item.code)).toContain("PLUGIN_E_DUPLICATE_ID");
    }
  });
  it("reserves the same identity the compiler stamps as core", async () => {
    const { RESERVED_PLUGIN_IDS } = await import("./index.js");
    expect([...RESERVED_PLUGIN_IDS]).toEqual(["kobrixa.core"]);
  });
  it("loads development plugins from folders with spaces and non-ASCII names", async () => {
    const [loaded] = await loadPlugins([await plugin("插件 測試", manifest())], none);
    expect(loaded).toMatchObject({ id: "acme.hello", status: "enabled", problems: [] });
    expect(loaded!.entry).toMatch(/main\.py$/);
  });
  it("accepts a UTF-8 byte order mark written by Windows editors", async () => {
    const [loaded] = await loadPlugins([await plugin("bom", manifest(), "main.py", "﻿")], none);
    expect(loaded!.status).toBe("enabled");
  });
  it("marks disabled plugins by source key and skips reading folders in safe mode", async () => {
    const source = await plugin("a", manifest());
    const key = developmentSourceKey(source.directory);
    expect(
      (await loadPlugins([source], { disabled: new Set([key]), safeMode: false }))[0],
    ).toMatchObject({ sourceKey: key, status: "disabled", disabledBy: "user" });
    // A manifest id no longer disables anything: identity is the source, not the id.
    expect(
      (await loadPlugins([source], { disabled: new Set(["acme.hello"]), safeMode: false }))[0]!
        .status,
    ).toBe("enabled");
    const [safe] = await loadPlugins([source], { disabled: new Set(), safeMode: true });
    expect(safe).toMatchObject({
      sourceKey: key,
      id: "a",
      status: "disabled",
      disabledBy: "safe-mode",
      unread: true,
      problems: [],
    });
    expect(safe!.manifest).toBeUndefined();
    const [userDisabled] = await loadPlugins([source], {
      disabled: new Set([key]),
      safeMode: true,
    });
    expect(userDisabled).toMatchObject({ status: "disabled", disabledBy: "user" });
    expect(
      (
        await loadPlugins([builtin], {
          disabled: new Set(["builtin:kobrixa.basic-plus"]),
          safeMode: true,
        })
      )[0],
    ).toMatchObject({ sourceKey: "builtin:kobrixa.basic-plus", status: "enabled" });
  });
  it("never reads a missing folder in safe mode", async () => {
    const [safe] = await loadPlugins(
      [{ kind: "development", directory: path.join(root, "absent") }],
      { disabled: new Set(), safeMode: true },
    );
    expect(safe).toMatchObject({ status: "disabled", disabledBy: "safe-mode", problems: [] });
  });
  it("derives stable, valid source keys without touching the file system", () => {
    const key = developmentSourceKey(path.join(root, "x"));
    expect(key).toMatch(/^dev:[0-9a-f]{16}$/);
    expect(developmentSourceKey(path.join(root, "y", "..", "x"))).toBe(key);
    expect(sourceKeySchema.safeParse(key).success).toBe(true);
    expect(sourceKeySchema.safeParse("builtin:kobrixa.basic-plus").success).toBe(true);
    expect(sourceKeySchema.safeParse("dev:../../etc").success).toBe(false);
  });
  it("reads one source on its own without deciding conflicts", async () => {
    const read = await readSource(await plugin("solo", manifest()), { safeMode: false });
    expect(read).toMatchObject({ id: "acme.hello", source: "development", problems: [] });
    expect(read).not.toHaveProperty("status");
  });
  it.each([
    ["PLUGIN_E_API_VERSION", { apiVersion: "^2.0.0" }],
    ["PLUGIN_E_RUNTIME_NOT_ALLOWED", { runtime: { kind: "builtin" } }],
    ["PLUGIN_E_FRONTEND_REQUIRES_BUILTIN", { contributes: { frontends: [] } }],
    ["PLUGIN_E_BACKEND_REQUIRES_BUILTIN", { contributes: { backends: [] } }],
    [
      "PLUGIN_E_BACKEND_REQUIRES_BUILTIN",
      {
        contributes: {
          backends: [
            {
              target: "test-vm",
              ir: { min: 1, max: 1 },
              capabilities: {},
              artifacts: [],
            },
          ],
        },
      },
    ],
    [
      "PLUGIN_E_FRONTEND_REQUIRES_BUILTIN",
      {
        contributes: {
          frontends: [
            {
              language: "bp",
              entryExtensions: ["bp"],
              sourceExtensions: ["bp", "bpi", "bpm"],
              ir: { min: 1, max: 1 },
            },
          ],
        },
      },
    ],
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
  it.each([
    [
      "Frontend IR range is empty.",
      {
        frontends: [
          {
            language: "test",
            entryExtensions: ["test"],
            sourceExtensions: ["test"],
            ir: { min: 2, max: 1 },
          },
        ],
      },
    ],
    [
      "Entry extensions must be a subset of source extensions.",
      {
        frontends: [
          {
            language: "test",
            entryExtensions: ["test"],
            sourceExtensions: ["inc"],
            ir: { min: 1, max: 1 },
          },
        ],
      },
    ],
    [
      "Backend IR range is empty.",
      {
        backends: [{ target: "test-vm", ir: { min: 2, max: 1 }, capabilities: {}, artifacts: [] }],
      },
    ],
    [
      "A deployable backend requires exactly one required deploy-main.",
      {
        backends: [
          {
            target: "test-vm",
            ir: { min: 1, max: 1 },
            capabilities: { deploy: "ev3" },
            artifacts: [],
          },
        ],
      },
    ],
  ])("rejects compiler declaration semantics: %s", async (message, contributes) => {
    const [loaded] = await loadPlugins(
      [await plugin("semantics", manifest({ activationEvents: [], contributes }))],
      none,
    );
    expect(loaded!.status).toBe("invalid");
    expect(loaded!.problems).toContainEqual({ code: "PLUGIN_E_MANIFEST", message });
    await expect(
      readSource(
        {
          kind: "builtin",
          policy: "required",
          resources: {},
          manifest: manifest({ runtime: { kind: "builtin" }, activationEvents: [], contributes }),
        },
        { safeMode: false },
      ),
    ).rejects.toThrow(message);
  });
  it("invalidates the whole external backend plugin even with valid commands", async () => {
    const value = manifest();
    const [loaded] = await loadPlugins(
      [
        await plugin("backend", {
          ...value,
          contributes: {
            ...value.contributes,
            backends: [
              { target: "test-vm", ir: { min: 1, max: 1 }, capabilities: {}, artifacts: [] },
            ],
          },
        }),
      ],
      none,
    );
    expect(loaded!.status).toBe("invalid");
    expect(loaded!.problems).toEqual([
      {
        code: "PLUGIN_E_BACKEND_REQUIRES_BUILTIN",
        message: "Compiler backends can only be contributed by built-in plugins in this version.",
      },
    ]);
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
      disabled: new Set([developmentSourceKey(first.directory)]),
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
    await expect(
      loadPlugins(
        [{ kind: "builtin", policy: "required", resources: {}, manifest: { id: "x" } }],
        none,
      ),
    ).rejects.toThrow(/built-in/i);
  });
});

it.each([[], null, "wrong", 1, { id: "kobrixa.device-ev3" }].map((value) => [value]))(
  "F01 rejects every external own deviceProviders value before normal parsing: %j",
  async (deviceProviders) => {
    const source = await plugin("provider-impostor", {
      ...manifest(),
      runtime: { kind: "builtin" },
      permissions: ["devices.provide"],
      contributes: { deviceProviders, languageServices: [] },
    });
    const [loaded] = await loadPlugins([source], none);
    expect(loaded).toMatchObject({ status: "invalid" });
    expect(loaded!.problems.map((item) => item.code)).toEqual([
      "PLUGIN_E_DEVICE_PROVIDER_REQUIRES_BUILTIN",
    ]);
  },
);
it("F20 applies disable and safe mode only to optional builtins", async () => {
  const optional = {
    ...builtin,
    policy: "optional" as const,
    manifest: {
      id: "kobrixa.device-ev3",
      version: "1.0.0",
      apiVersion: "^1.5.0",
      runtime: { kind: "builtin" },
    },
  };
  const required = { ...builtin, policy: "required" as const };
  const sources = [required, optional];
  expect(
    (await loadPlugins(sources, { disabled: new Set(), safeMode: true })).map(
      (entry) => entry.status,
    ),
  ).toEqual(["enabled", "disabled"]);
  expect(
    (
      await loadPlugins(sources, {
        disabled: new Set(["builtin:kobrixa.device-ev3"]),
        safeMode: false,
      })
    ).map((entry) => entry.status),
  ).toEqual(["enabled", "disabled"]);
  expect((await loadPlugins(sources, none)).map((entry) => entry.status)).toEqual([
    "enabled",
    "enabled",
  ]);
});
it("F20 never grants required policy when host policy is absent", async () => {
  const source = { ...builtin } as unknown as Parameters<typeof readSource>[0];
  Reflect.deleteProperty(source, "policy");
  const loaded = await readSource(source, { safeMode: false });
  expect(loaded.problems.map((item) => item.code)).toContain("PLUGIN_E_MANIFEST");
});
