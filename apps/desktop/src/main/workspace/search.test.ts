import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { searchWorkspace, workspaceSearchLimits } from "./search.js";
import type { WorkspaceSearchRequest } from "../../shared/workspace-search.js";

const request: WorkspaceSearchRequest = {
  query: "motor",
  caseSensitive: false,
  wholeWord: false,
  overlays: {},
};

describe("workspace search filesystem", () => {
  let root: string;
  let outside: string;
  beforeEach(async () => {
    root = await realpath(await mkdtemp(path.join(tmpdir(), "kobrixa-search-")));
    outside = await realpath(await mkdtemp(path.join(tmpdir(), "kobrixa-search-outside-")));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });
  async function source(file: string, content: string): Promise<void> {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), content);
  }

  it("searches closed files and exact dirty overlays, including missing drafts, without writing", async () => {
    await source("src/main.bp", "saved motor");
    await source("src/closed.bpi", "closed MOTOR");
    await source("other.json", '{"motor":1}');
    const result = await searchWorkspace(root, {
      ...request,
      overlays: { "src/main.bp": "dirty motor motor", "src/new.bpm": "new motor" },
    });
    expect(result).toMatchObject({ matchCount: 5, truncated: false, skipped: [] });
    expect(result.files.map((file) => file.path)).toEqual([
      "other.json",
      "src/closed.bpi",
      "src/main.bp",
      "src/new.bpm",
    ]);
    expect(result.files.find((file) => file.path === "src/main.bp")).toMatchObject({
      content: "dirty motor motor",
      revision: createHash("sha256").update("saved motor").digest("hex"),
    });
    expect(result.files.find((file) => file.path === "src/new.bpm")!.revision).toBeNull();
    expect(await readFile(path.join(root, "src/main.bp"), "utf8")).toBe("saved motor");
    await expect(readFile(path.join(root, "src/new.bpm"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(
      (await searchWorkspace(root, { ...request, overlays: { "src/main.bp": "" } })).files.map(
        (file) => file.path,
      ),
    ).not.toContain("src/main.bp");
  });

  it("uses the same hidden, asset, vendor and manifest output exclusions as the project tree", async () => {
    await source(
      "kobrixa.json",
      JSON.stringify({
        schemaVersion: 1,
        name: "test",
        language: "bp",
        entry: "src/main.bp",
        target: "ev3-native",
        assets: [],
        outputDir: "generated/bin",
      }),
    );
    for (const file of [
      "src/main.bp",
      ".git/private.bp",
      "src/.hidden.bp",
      "assets/data.json",
      "node_modules/vendor.bp",
      "generated/bin/program.bp",
      "photo.rgf",
    ])
      await source(file, "motor");
    const result = await searchWorkspace(root, {
      ...request,
      overlays: { "assets/data.json": "motor motor" },
    });
    expect(result.files.map((file) => file.path)).toEqual(["src/main.bp"]);
    expect(result).toMatchObject({ truncated: false, skipped: [] });
  });

  it("rejects path escapes and malformed overlay payloads", async () => {
    for (const file of [
      "../outside.bp",
      "/absolute.bp",
      "src/../main.bp",
      "C:/outside.bp",
      "src\\main.bp",
      "bad\0.bp",
      "photo.png",
    ])
      await expect(
        searchWorkspace(root, { ...request, overlays: { [file]: "motor" } }),
      ).rejects.toThrow();
    await expect(
      searchWorkspace(root, { ...request, caseSensitive: "false" } as never),
    ).rejects.toThrow();
  });

  it("skips file and directory symlinks and refuses overlay symlinks", async () => {
    await writeFile(path.join(outside, "secret.bp"), "motor secret");
    await symlink(path.join(outside, "secret.bp"), path.join(root, "linked.bp"));
    await symlink(
      outside,
      path.join(root, "linked"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await source("main.bp", "motor");
    const result = await searchWorkspace(root, request);
    expect(result.files.map((file) => file.path)).toEqual(["main.bp"]);
    expect(result.skipped).toEqual(["linked", "linked.bp"]);
    for (const file of ["linked.bp", "linked/secret.bp"])
      await expect(
        searchWorkspace(root, { ...request, overlays: { [file]: "motor" } }),
      ).rejects.toThrow("Symbolic links");
  });

  it("rejects a registered root replaced by a symlink", async () => {
    const original = path.join(outside, "original");
    await rename(root, original);
    await symlink(original, root, process.platform === "win32" ? "junction" : "dir");
    await expect(searchWorkspace(root, request)).rejects.toThrow("root changed");
  });

  it("reports overlarge and binary files and caps total read bytes", async () => {
    await source("a.bp", "motor");
    await source("b.bp", "motor\0");
    await source("c.bp", "motor".repeat(10));
    const limited = await searchWorkspace(root, request, {
      ...workspaceSearchLimits,
      fileBytes: 20,
    });
    expect(limited.files.map((file) => file.path)).toEqual(["a.bp"]);
    expect(limited).toMatchObject({ truncated: true, skipped: ["b.bp", "c.bp"] });
    await source("b.bp", "motor");
    await source("c.bp", "motor");
    const total = await searchWorkspace(root, request, {
      ...workspaceSearchLimits,
      totalBytes: 10,
    });
    expect(total).toMatchObject({ matchCount: 2, truncated: true, skipped: ["c.bp"] });
  });

  it("caps matches and distinguishes complete results at the exact match limit", async () => {
    await source("a.bp", "motor motor motor");
    await source("b.bp", "motor");
    const result = await searchWorkspace(root, request, { ...workspaceSearchLimits, matches: 2 });
    expect(result).toMatchObject({ matchCount: 2, truncated: true, skipped: ["b.bp"] });
    expect(result.files[0]!.matches).toHaveLength(2);
    await rm(path.join(root, "b.bp"));
    await source("a.bp", "motor motor");
    expect(
      await searchWorkspace(root, request, { ...workspaceSearchLimits, matches: 2 }),
    ).toMatchObject({ matchCount: 2, truncated: false, skipped: [] });
  });

  it("bounds traversal and yields to other main-process work", async () => {
    for (let index = 0; index < 10; index += 1) await source(`${index}.bp`, "motor");
    let yielded = false;
    setImmediate(() => {
      yielded = true;
    });
    const result = await searchWorkspace(root, request, { ...workspaceSearchLimits, files: 3 });
    expect(result.files).toHaveLength(3);
    expect(result.truncated).toBe(true);
    expect(yielded).toBe(true);
  });
});
