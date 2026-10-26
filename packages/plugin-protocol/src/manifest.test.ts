import { describe, expect, it } from "vitest";
import { pluginManifestSchema } from "./index.js";

const valid = {
  id: "acme.line-count",
  version: "1.0.0",
  apiVersion: "^1.0.0",
  displayName: { en: "Line count", "zh-TW": "行數統計" },
  runtime: { kind: "python", entry: "main.py" },
  activationEvents: ["onCommand:acme.line-count.run"],
  permissions: ["ui.notifications"],
  contributes: { commands: [{ id: "acme.line-count.run", title: "Count lines" }] },
};
const accepts = (value: unknown) => pluginManifestSchema.safeParse(value).success;

describe("plugin manifest", () => {
  it("accepts a complete manifest and unknown forward-compatible fields", () => {
    expect(accepts(valid)).toBe(true);
    expect(accepts({ ...valid, "x-future": true })).toBe(true);
    expect(accepts({ ...valid, contributes: { ...valid.contributes, views: [] } })).toBe(true);
  });
  it("rejects entries that leave the plugin folder", () => {
    for (const entry of ["../escape.py", "/abs.py", "dir/../x.py", ".hidden/x.py", "a\\b.py", ""])
      expect(accepts({ ...valid, runtime: { kind: "python", entry } }), entry).toBe(false);
  });
  it("requires lowercase namespaced ids without trailing newlines", () => {
    for (const id of ["Acme.plugin", "acme", "acme.plugin\n", "acme..plugin", "acme.-x"])
      expect(accepts({ ...valid, id }), JSON.stringify(id)).toBe(false);
  });
  it("rejects control characters in titles and unknown permissions", () => {
    expect(
      accepts({
        ...valid,
        contributes: { commands: [{ id: "acme.line-count.run", title: "a\u0007" }] },
      }),
    ).toBe(false);
    expect(accepts({ ...valid, permissions: ["fs.write"] })).toBe(false);
  });
  it("bounds the number of commands", () => {
    const commands = Array.from({ length: 65 }, (_, index) => ({
      id: `acme.line-count.c${index}`,
      title: "x",
    }));
    expect(accepts({ ...valid, contributes: { commands } })).toBe(false);
  });
});

import { uiDeclarationProblems, staticLanguageDeclarationProblems } from "./manifest.js";
it("U02 distinguishes source errors from quarantined resource headers", () => {
  const value = {
    id: "acme.ui",
    version: "1.0.0",
    apiVersion: "^1.6.0",
    runtime: { kind: "node", entry: "main.js" },
    permissions: ["ui.panels"],
    contributes: {
      panels: [
        {
          id: "acme.ui.main",
          title: { en: "Panel" },
          location: "right",
          resource: { version: 99, path: "../outside.json" },
        },
      ],
    },
  };
  const manifest = pluginManifestSchema.parse(value);
  expect(uiDeclarationProblems(manifest)).toEqual([]);
  expect(
    uiDeclarationProblems(pluginManifestSchema.parse({ ...value, permissions: [] })),
  ).not.toEqual([]);
  expect(
    uiDeclarationProblems(
      pluginManifestSchema.parse({ ...value, activationEvents: ["onPanel:foreign.ui.panel"] }),
    ),
  ).not.toEqual([]);
  for (const key of ["panels", "status"]) {
    const parsed = pluginManifestSchema.parse({
      ...value,
      runtime: { kind: "static" },
      contributes: { [key]: [] },
    });
    expect(staticLanguageDeclarationProblems(parsed).some((message) => message.includes(key))).toBe(
      true,
    );
  }
});

it("makes settings a known strict packaged JSON contribution", () => {
  const base = {
    id: "test.settings",
    version: "1.0.0",
    apiVersion: "^1.7.0",
    runtime: { kind: "node", entry: "main.cjs" },
    permissions: ["settings.read", "settings.write"],
  };
  expect(
    pluginManifestSchema.safeParse({
      ...base,
      contributes: { settings: { version: 1, path: "settings/preferences.json" } },
    }).success,
  ).toBe(true);
  for (const settings of [
    { version: 2, path: "settings.json" },
    { version: 1, path: "../settings.json" },
    { version: 1, path: "/settings.json" },
    { version: 1, path: "https://invalid/settings.json" },
    { version: 1, path: "settings.json", extra: true },
  ])
    expect(pluginManifestSchema.safeParse({ ...base, contributes: { settings } }).success).toBe(
      false,
    );
});

import { permissionSchema } from "./common.js";
it("adds precisely the six persistence permissions to the cumulative registry", () => {
  expect([...permissionSchema.options].sort()).toEqual(
    [
      "ui.notifications",
      "devices.read",
      "devices.connect",
      "devices.control",
      "ui.panels",
      "ui.status",
      "settings.read",
      "settings.write",
      "storage.read",
      "storage.write",
      "storage.export",
      "ui.clipboard",
    ].sort(),
  );
});
