import type * as FsPromises from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cp,
  mkdir,
  mkdtemp,
  open,
  realpath,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  regularBytes,
  resolveBuiltinLaunch,
  validateBuiltinLeaf,
  parseBuiltinResourceIndex,
} from "./builtin-launch.js";
import type { BuiltinResourceIndex } from "@kobrixa/plugin-runtime";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  return { ...actual, open: vi.fn(actual.open) };
});
const actualFs = await vi.importActual<typeof FsPromises>("node:fs/promises");
const roots: string[] = [];
afterEach(async () => {
  vi.mocked(open).mockReset();
  vi.restoreAllMocks();
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

describe("payload read identity races", () => {
  it.each(["ancestor", "root", "directory", "file"] as const)(
    "rejects identical-byte %s replacement before open and closes the descriptor",
    async (kind) => {
      const h = await fixture();
      const directory = path.join(h.leaf, "ui");
      await mkdir(directory);
      const target = path.join(directory, "panel.json");
      await writeFile(target, "{}");
      const replaced =
        kind === "ancestor"
          ? path.dirname(h.leaf)
          : kind === "root"
            ? h.leaf
            : kind === "directory"
              ? directory
              : target;
      let close: ReturnType<typeof vi.spyOn> | undefined;
      let read: ReturnType<typeof vi.spyOn> | undefined;
      vi.mocked(open).mockImplementationOnce(async (...args) => {
        await rename(replaced, `${replaced}.old`);
        await cp(`${replaced}.old`, replaced, { recursive: true });
        const handle = await actualFs.open(...args);
        close = vi.spyOn(handle, "close");
        read = vi.spyOn(handle, "read");
        return handle;
      });
      await expect(regularBytes(h.leaf, "ui/panel.json", 1024)).rejects.toMatchObject({
        code: "PLUGIN_E_ENTRY",
      });
      expect(read).not.toHaveBeenCalled();
      expect(close).toHaveBeenCalledOnce();
    },
  );

  it.each(["root", "directory", "file"] as const)(
    "rejects %s replacement after read even though the open descriptor is unchanged",
    async (kind) => {
      const h = await fixture();
      const directory = path.join(h.leaf, "ui");
      await mkdir(directory);
      const target = path.join(directory, "panel.json");
      await writeFile(target, "{}");
      const replaced = kind === "root" ? h.leaf : kind === "directory" ? directory : target;
      let close: ReturnType<typeof vi.spyOn> | undefined;
      vi.mocked(open).mockImplementationOnce(async (...args) => {
        const handle = await actualFs.open(...args);
        close = vi.spyOn(handle, "close");
        const read = handle.read;
        vi.spyOn(handle, "read").mockImplementationOnce((async (...readArgs: unknown[]) => {
          const result = await Reflect.apply(read, handle, readArgs);
          await rename(replaced, `${replaced}.old`);
          await cp(`${replaced}.old`, replaced, { recursive: true });
          return result;
        }) as typeof handle.read);
        return handle;
      });
      await expect(regularBytes(h.leaf, "ui/panel.json", 1024)).rejects.toMatchObject({
        code: "PLUGIN_E_ENTRY",
      });
      expect(close).toHaveBeenCalledOnce();
    },
  );

  it("rejects an ancestor symlink introduced at open, even with identical payload bytes", async () => {
    const h = await fixture();
    const moved = path.join(h.root, "moved");
    let close: ReturnType<typeof vi.spyOn> | undefined;
    vi.mocked(open).mockImplementationOnce(async (...args) => {
      await rename(h.leaf, moved);
      await symlink(moved, h.leaf, "dir");
      const handle = await actualFs.open(...args);
      close = vi.spyOn(handle, "close");
      return handle;
    });
    const error: unknown = await regularBytes(h.leaf, "main.cjs", 1024).catch(
      (error: unknown) => error,
    );
    expect(error).toMatchObject({ code: "PLUGIN_E_ENTRY" });
    expect(String(error)).not.toContain(h.root);
    expect(close).toHaveBeenCalledOnce();
  });

  it("opens nonblocking, rejects a substituted nonregular handle before read, and closes it", async () => {
    const { constants } = await import("node:fs");
    const h = await fixture();
    const close = vi.fn(async () => {});
    const read = vi.fn();
    vi.mocked(open).mockImplementationOnce(async (_file, flags) => {
      if (process.platform !== "win32")
        expect(Number(flags) & constants.O_NONBLOCK).toBe(constants.O_NONBLOCK);
      return { stat: async () => ({ isFile: () => false }), read, close } as unknown as Awaited<
        ReturnType<typeof open>
      >;
    });
    await expect(regularBytes(h.leaf, "main.cjs", 1024)).rejects.toMatchObject({
      code: "PLUGIN_E_ENTRY",
    });
    expect(read).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });

  it("closes a successfully read regular file", async () => {
    const h = await fixture();
    let close: ReturnType<typeof vi.spyOn> | undefined;
    vi.mocked(open).mockImplementationOnce(async (...args) => {
      const handle = await actualFs.open(...args);
      close = vi.spyOn(handle, "close");
      return handle;
    });
    expect(await regularBytes(h.leaf, "main.cjs", 1024)).toEqual(h.files.get("main.cjs"));
    expect(close).toHaveBeenCalledOnce();
  });
});

it.skipIf(process.platform === "win32")(
  "rejects a real FIFO substituted at open without waiting for a writer",
  async () => {
    const { constants } = await import("node:fs");
    const h = await fixture();
    let close: ReturnType<typeof vi.spyOn> | undefined;
    vi.mocked(open).mockImplementationOnce(async (file, flags, mode) => {
      // Assert before opening, so a regression fails instead of wedging the test worker.
      expect(Number(flags) & constants.O_NONBLOCK).toBe(constants.O_NONBLOCK);
      await rm(path.join(h.leaf, "main.cjs"));
      execFileSync("mkfifo", [path.join(h.leaf, "main.cjs")]);
      const handle = await actualFs.open(file, flags, mode);
      close = vi.spyOn(handle, "close");
      return handle;
    });
    await expect(regularBytes(h.leaf, "main.cjs", 1024)).rejects.toMatchObject({
      code: "PLUGIN_E_ENTRY",
    });
    expect(close).toHaveBeenCalledOnce();
  },
);

it("rejects a payload root replaced between individually valid file reads", async () => {
  const h = await fixture();
  vi.mocked(open).mockImplementationOnce(async (...args) => {
    const handle = await actualFs.open(...args);
    const close = handle.close.bind(handle);
    vi.spyOn(handle, "close").mockImplementationOnce(async () => {
      await close();
      await rename(h.leaf, `${h.leaf}.old`);
      await cp(`${h.leaf}.old`, h.leaf, { recursive: true });
    });
    return handle;
  });
  await expect(resolveBuiltinLaunch(h.input)).rejects.toMatchObject({ code: "PLUGIN_E_ENTRY" });
});
