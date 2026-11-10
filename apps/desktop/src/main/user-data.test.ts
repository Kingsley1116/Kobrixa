import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalUserData } from "./user-data.js";

const roots: string[] = [];

async function fixture(): Promise<{ root: string; real: string; link: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "kobrixa-user-data-"));
  roots.push(root);
  const real = path.join(await realpath(root), "real");
  await mkdir(real);
  const link = path.join(root, "link");
  await symlink(real, link, process.platform === "win32" ? "junction" : "dir");
  return { root, real, link };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("canonicalUserData", () => {
  it("resolves a profile that goes through a symlinked ancestor", async () => {
    const { real, link } = await fixture();
    expect(canonicalUserData(link)).toBe(real);
    // os.tmpdir() itself is a symlink on macOS; the result must not depend on it.
    expect(canonicalUserData(path.join(link, ".."))).toBe(path.dirname(real));
  });

  it("keeps components Electron has not created yet", async () => {
    const { real, link } = await fixture();
    expect(canonicalUserData(path.join(link, "profile", "nested"))).toBe(
      path.join(real, "profile", "nested"),
    );
  });

  it("returns an absolute path when nothing of it exists", () => {
    const missing = path.join(path.parse(process.cwd()).root, "kobrixa-missing-user-data", "x");
    expect(canonicalUserData(missing)).toBe(missing);
    expect(path.isAbsolute(canonicalUserData("relative/profile"))).toBe(true);
  });
});
