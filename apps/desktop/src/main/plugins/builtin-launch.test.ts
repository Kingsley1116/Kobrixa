import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  resolveBuiltinLaunch,
  validateBuiltinLeaf,
  parseBuiltinResourceIndex,
} from "./builtin-launch.js";
import type { BuiltinResourceIndex } from "@kobrixa/plugin-runtime";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture(packaged = false) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "kobrixa-installed-")));
  roots.push(root);
  const buildRoot = path.join(root, "compiled");
  const appPath = path.join(root, "app.asar");
  const leaf = packaged
    ? path.join(root, "app.asar.unpacked/.vite/build/plugins/motor-test")
    : path.join(buildRoot, "plugins/motor-test");
  await mkdir(leaf, { recursive: true });
  const files = new Map<string, Buffer>([
    ["main.cjs", Buffer.from("'use strict';\n")],
    [
      "kobrixa-plugin.json",
      Buffer.from(
        JSON.stringify({
          id: "kobrixa.motor-test",
          version: "1.0.0",
          apiVersion: "^1.6.0",
          runtime: { kind: "node", entry: "main.cjs" },
        }),
      ),
    ],
  ]);
  for (const [name, data] of files) await writeFile(path.join(leaf, name), data);
  const reindex = async () => {
    const index: BuiltinResourceIndex = {
      version: 1,
      pluginId: "kobrixa.motor-test",
      files: [...files]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([name, data]) => ({
          path: name,
          bytes: data.length,
          sha256: createHash("sha256").update(data).digest("hex"),
        })),
    };
    await writeFile(path.join(leaf, "resource-index.json"), JSON.stringify(index));
  };
  await reindex();
  const input = {
    sourceKey: "builtin:kobrixa.motor-test",
    pluginId: "kobrixa.motor-test",
    slug: "motor-test",
    packaged,
    appPath,
    buildRoot,
  };
  return { root, leaf, input, files, reindex };
}

describe("installed launch (U14, B1-RF5)", () => {
  it("pins the 32-file structural limit independently of current manifest declaration counts", () => {
    const files = Array.from({ length: 32 }, (_, index) => ({
      path: `r${index}.json`,
      bytes: 0,
      sha256: "0".repeat(64),
    }));
    expect(
      parseBuiltinResourceIndex({ version: 1, pluginId: "acme.fixture", files }).files,
    ).toHaveLength(32);
    expect(() =>
      parseBuiltinResourceIndex({
        version: 1,
        pluginId: "acme.fixture",
        files: [...files, files[0]!],
      }),
    ).toThrow();
  });
  it.each([false, true])("resolves only compiled artifacts, packaged=%s", async (packaged) => {
    const h = await fixture(packaged);
    const launch = await resolveBuiltinLaunch(h.input);
    expect(launch).toEqual({
      sourceKey: h.input.sourceKey,
      pluginId: h.input.pluginId,
      policy: "optional",
      runtime: "node",
      packageRoot: h.leaf,
      entry: "main.cjs",
      manifest: "kobrixa-plugin.json",
      resourceIndex: "resource-index.json",
    });
  });
  it.each([
    { slug: "../motor-test" },
    { slug: "sensor-lab" },
    { pluginId: "acme.motor" },
    { sourceKey: "builtin:kobrixa.sensor-lab" },
  ])("rejects allowlist mismatch before file reads: %j", async (patch) => {
    const h = await fixture();
    await expect(resolveBuiltinLaunch({ ...h.input, ...patch })).rejects.toMatchObject({
      code: "PLUGIN_E_ENTRY",
    });
  });
  it("rejects an unexpected packaged layout", async () => {
    const h = await fixture(true);
    await expect(resolveBuiltinLaunch({ ...h.input, appPath: h.root })).rejects.toMatchObject({
      code: "PLUGIN_E_ENTRY",
    });
  });
  it.each(["main.cjs", "kobrixa-plugin.json", "resource-index.json"])(
    "rejects missing %s without fallback",
    async (name) => {
      const h = await fixture();
      await rm(path.join(h.leaf, name));
      await expect(resolveBuiltinLaunch(h.input)).rejects.toMatchObject({ code: "PLUGIN_E_ENTRY" });
    },
  );
  it("rejects tampering even at unchanged length and does not disclose a path", async () => {
    const h = await fixture();
    await writeFile(path.join(h.leaf, "main.cjs"), "'use unsafe';\n");
    const error = await resolveBuiltinLaunch(h.input).catch((value: unknown) => value);
    expect(error).toMatchObject({ code: "PLUGIN_E_ENTRY" });
    expect(String(error)).not.toContain(h.root);
  });
  it("rejects a correctly rehashed wrong manifest id or entry", async () => {
    const h = await fixture();
    for (const patch of [{ id: "acme.other" }, { runtime: { kind: "node", entry: "else.cjs" } }]) {
      const manifest = JSON.parse(h.files.get("kobrixa-plugin.json")!.toString()) as Record<
        string,
        unknown
      >;
      const bytes = Buffer.from(JSON.stringify({ ...manifest, ...patch }));
      h.files.set("kobrixa-plugin.json", bytes);
      await writeFile(path.join(h.leaf, "kobrixa-plugin.json"), bytes);
      await h.reindex();
      await expect(resolveBuiltinLaunch(h.input)).rejects.toMatchObject({ code: "PLUGIN_E_ENTRY" });
    }
  });
  it("rejects symlinked files and a symlinked leaf, including links inside the root", async () => {
    const h = await fixture();
    await writeFile(path.join(h.leaf, "other.cjs"), h.files.get("main.cjs")!);
    await rm(path.join(h.leaf, "main.cjs"));
    await symlink("other.cjs", path.join(h.leaf, "main.cjs"));
    await expect(resolveBuiltinLaunch(h.input)).rejects.toMatchObject({ code: "PLUGIN_E_ENTRY" });
    await rm(path.join(h.leaf, "main.cjs"));
    await writeFile(path.join(h.leaf, "main.cjs"), h.files.get("main.cjs")!);
    const alias = path.join(h.root, "alias");
    await symlink(h.leaf, alias, "dir");
    await expect(validateBuiltinLeaf(alias, h.input.pluginId)).rejects.toMatchObject({
      code: "PLUGIN_E_ENTRY",
    });
  });
  it("rejects a directory substituted for a regular executable", async () => {
    const h = await fixture();
    await rm(path.join(h.leaf, "main.cjs"));
    await mkdir(path.join(h.leaf, "main.cjs"));
    await expect(resolveBuiltinLaunch(h.input)).rejects.toMatchObject({ code: "PLUGIN_E_ENTRY" });
  });
  it("accepts exactly 16 MiB and rejects 16 MiB + 1 executable bytes", async () => {
    const h = await fixture();
    for (const size of [16 * 1024 * 1024, 16 * 1024 * 1024 + 1]) {
      const bytes = Buffer.alloc(size, 32);
      h.files.set("main.cjs", bytes);
      await writeFile(path.join(h.leaf, "main.cjs"), bytes);
      await h.reindex();
      if (size === 16 * 1024 * 1024)
        await expect(resolveBuiltinLaunch(h.input)).resolves.toBeDefined();
      else
        await expect(resolveBuiltinLaunch(h.input)).rejects.toMatchObject({
          code: "PLUGIN_E_ENTRY",
        });
    }
  });
  it("accepts 16 KiB index whitespace padding, rejects +1 before parsing", async () => {
    const h = await fixture();
    const index = await readFile(path.join(h.leaf, "resource-index.json"), "utf8");
    await writeFile(path.join(h.leaf, "resource-index.json"), index.padEnd(16 * 1024, " "));
    await expect(resolveBuiltinLaunch(h.input)).resolves.toBeDefined();
    await writeFile(path.join(h.leaf, "resource-index.json"), index.padEnd(16 * 1024 + 1, " "));
    await expect(resolveBuiltinLaunch(h.input)).rejects.toMatchObject({ code: "PLUGIN_E_ENTRY" });
  });
  it.each([
    "../escape.json",
    "/absolute.json",
    "a\\b.json",
    "https://x/a.json",
    "resource-index.json",
  ])("rejects indexed path %s", async (name) => {
    const h = await fixture();
    const index = JSON.parse(
      await readFile(path.join(h.leaf, "resource-index.json"), "utf8"),
    ) as BuiltinResourceIndex;
    index.files.push({ path: name, bytes: 0, sha256: "0".repeat(64) });
    await writeFile(path.join(h.leaf, "resource-index.json"), JSON.stringify(index));
    await expect(resolveBuiltinLaunch(h.input)).rejects.toMatchObject({ code: "PLUGIN_E_ENTRY" });
  });
  it("rejects extra, duplicate, unsorted and 33-file index entries", async () => {
    const h = await fixture();
    const base = JSON.parse(
      await readFile(path.join(h.leaf, "resource-index.json"), "utf8"),
    ) as BuiltinResourceIndex;
    const candidates = [
      [...base.files, { path: "extra.json", bytes: 0, sha256: "0".repeat(64) }],
      [...base.files, base.files[0]!],
      [...base.files].reverse(),
      Array.from({ length: 33 }, (_, i) => ({
        path: `f${i}.json`,
        bytes: 0,
        sha256: "0".repeat(64),
      })),
    ];
    for (const files of candidates) {
      await writeFile(path.join(h.leaf, "resource-index.json"), JSON.stringify({ ...base, files }));
      await expect(resolveBuiltinLaunch(h.input)).rejects.toMatchObject({ code: "PLUGIN_E_ENTRY" });
    }
  });
});
