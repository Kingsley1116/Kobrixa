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
