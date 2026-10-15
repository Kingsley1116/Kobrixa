import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import micromatch from "micromatch";
import { afterEach, describe, expect, it } from "vitest";
import { loadProject, parseManifest } from "./manifest.js";

const manifest = {
  schemaVersion: 1,
  name: "demo",
  language: "bp",
  entry: "src/main.bp",
  target: "ev3-native",
  assets: [],
  outputDir: "build",
};
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(overrides: Record<string, unknown> = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "kobrixa-manifest-"));
  roots.push(root);
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "src/main.bp"), "LCD.Clear()\n");
  await writeFile(path.join(root, "kobrixa.json"), JSON.stringify({ ...manifest, ...overrides }));
  return root;
}

describe("manifest", () => {
  it("installs parser nesting and expansion guards without truncating valid results", () => {
    const options = { expand: true, nodupes: true, keepEscaping: true };
    expect(() => micromatch.braces("{".repeat(65) + "a,b" + "}".repeat(65), options)).toThrow(
      "Brace pattern nesting exceeds 64 levels.",
    );
    expect(() => micromatch.braces("{a,b}".repeat(16), options)).toThrow(
      "Brace expansion exceeds 256 patterns.",
    );
    const expanded = micromatch.braces("item{0..255}", options);
    expect(expanded).toHaveLength(256);
    expect(expanded.at(-1)).toBe("item255");
  });

  it("retains unknown fields", () => {
    const result = parseManifest({
      schemaVersion: 1,
      name: "demo",
      language: "bp",
      entry: "src/main.bp",
      target: "ev3-native",
      assets: [],
      outputDir: "build",
      future: true,
    });
    expect(result.manifest?.future).toBe(true);
  });

  it("rejects invalid known fields", () => {
    expect(parseManifest({ schemaVersion: 2 }).diagnostics[0]?.code).toBe("MAN1001");
  });

  it.each([
    "{".repeat(5000) + "a,b" + "}".repeat(5000),
    "!" + "{".repeat(5000) + "a,b" + "}".repeat(5000),
    "(".repeat(5000) + "x" + ")".repeat(5000),
    "{".repeat(65) + "a,b" + "}".repeat(65),
    "\\{".repeat(65),
    "x".repeat(4097),
  ])("reports unsupported pattern complexity before project discovery (%#)", async (pattern) => {
    const root = await fixture({ assets: [pattern] });
    const result = await loadProject(root);
    expect(result.project).toBeUndefined();
    expect(result.diagnostics[0]?.code).toBe("MAN1001");
    expect(result.diagnostics[0]?.message).toContain("assets.0");
  });

  it("preserves numeric ranges, alternatives, exclusions, sorting and duplicate removal", async () => {
    const root = await fixture({
      assets: [
        "assets/frame{10..12}.txt",
        "assets/padded{01..03}.txt",
        "assets/step{1..5..2}.txt",
        "assets/{alpha,{beta,gamma}}.txt",
        "assets/alpha.txt",
        "!assets/{beta,frame11}.txt",
        "assets/literal\\{name\\}.txt",
        "assets/directory",
      ],
    });
    await mkdir(path.join(root, "assets/directory"), { recursive: true });
    const names = [
      "frame10",
      "frame11",
      "frame12",
      "padded01",
      "padded02",
      "padded03",
      "step1",
      "step2",
      "step3",
      "step4",
      "step5",
      "alpha",
      "beta",
      "gamma",
      "literal{name}",
    ];
    await Promise.all(names.map((name) => writeFile(path.join(root, `assets/${name}.txt`), name)));
    const result = await loadProject(root);
    expect(result.diagnostics).toEqual([]);
    expect(result.project?.assets.map((asset) => asset.path)).toEqual([
      "assets/alpha.txt",
      "assets/frame10.txt",
      "assets/frame12.txt",
      "assets/gamma.txt",
      "assets/literal{name}.txt",
      "assets/padded01.txt",
      "assets/padded02.txt",
      "assets/padded03.txt",
      "assets/step1.txt",
      "assets/step3.txt",
      "assets/step5.txt",
    ]);
  });

  it.each([
    "assets/" + "{a,b}".repeat(64),
    "!assets/" + "{a,b}".repeat(16),
    "assets/{1..1000}{1..1000}.txt",
    "assets/{0..256}.txt",
    "assets/{10000..1}.txt",
    "assets/{1..10000..1}.txt",
    "assets/{10000..1..-1}.txt",
    "assets/{0..10000..0}.txt",
  ])(
    "rejects excessive expansion without discovering a partial asset set (%#)",
    async (pattern) => {
      const root = await fixture({ assets: [pattern] });
      const result = await loadProject(root);
      expect(result.project).toBeUndefined();
      expect(result.diagnostics).toEqual([
        expect.objectContaining({
          code: "MAN1001",
          message: "assets: Assets may expand to at most 256 patterns.",
        }),
      ]);
    },
  );

  it("accepts the expansion boundary without truncating the last pattern", async () => {
    const root = await fixture({ assets: ["assets/item{0..255}.txt"] });
    await mkdir(path.join(root, "assets"));
    await writeFile(path.join(root, "assets/item0.txt"), "first");
    await writeFile(path.join(root, "assets/item255.txt"), "last");
    const result = await loadProject(root);
    expect(result.diagnostics).toEqual([]);
    expect(result.project?.assets.map((asset) => asset.path)).toEqual([
      "assets/item0.txt",
      "assets/item255.txt",
    ]);
  });

  it("preserves descending, negative and zero-step numeric range semantics", () => {
    const options = { expand: true, nodupes: true, keepEscaping: true };
    expect(micromatch.braces("{5..1..-2}", options)).toEqual(["5", "3", "1"]);
    expect(micromatch.braces("{-1..-3}", options)).toEqual(["-1", "-2", "-3"]);
    expect(micromatch.braces("{1..3..0}", options)).toEqual(["1", "2", "3"]);
    expect(micromatch.braces("{255..0..1}", options)).toHaveLength(256);
  });

  it("rejects a numeric range that cannot advance at JavaScript integer precision", () => {
    const modulePath = createRequire(import.meta.url).resolve("micromatch");
    const result = spawnSync(
      process.execPath,
      [
        "--max-old-space-size=32",
        "-e",
        `try {
          require(${JSON.stringify(modulePath)}).braces("{9007199254740992..9007199254740992}", { expand: true });
          process.exitCode = 1;
        } catch (error) {
          if (error.message !== "Brace range cannot advance safely.") throw error;
        }`,
      ],
      { timeout: 3000, encoding: "utf8", maxBuffer: 4096 },
    );
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
  });

  it("ignores empty alternatives while retaining nonempty matches", async () => {
    const root = await fixture({ assets: ["{,asset.txt}"] });
    await writeFile(path.join(root, "asset.txt"), "asset");
    const result = await loadProject(root);
    expect(result.diagnostics).toEqual([]);
    expect(result.project?.assets.map((asset) => asset.path)).toEqual(["asset.txt"]);
  });

  it("applies the expansion budget across all asset patterns", async () => {
    const root = await fixture({ assets: ["assets/a{1..200}.txt", "assets/b{1..200}.txt"] });
    const result = await loadProject(root);
    expect(result.project).toBeUndefined();
    expect(result.diagnostics[0]?.message).toContain("at most 256 patterns");
  });

  it.each([
    ['assets/{"alpha","beta"}.txt', ["alpha", "beta"], ["alpha", "beta"]],
    ['assets/{"alpha,beta",gamma}.txt', ["alpha,beta", "gamma"], ["alpha,beta", "gamma"]],
    ['assets/"{a,b}".txt', ["a", "b", "{a,b}"], ["a", "b"]],
    ['assets/{"{a,b}",a}.txt', ["a", "b", "{a,b}"], ["a", "b"]],
    [
      "assets/file[{1..3}].txt",
      ["file.", "file1", "file2", "file3", "file{", "file}"],
      ["file.", "file1", "file3", "file{", "file}"],
    ],
    [
      "assets/file[{a,b}].txt",
      ["file,", "filea", "fileb", "file{", "file}"],
      ["file,", "filea", "fileb", "file{", "file}"],
    ],
    ["assets/{a},b}.txt", ["{a},b}", "a}", "b"], ["{a},b}"]],
  ] as const)(
    "preserves quoted alternatives and literal brace syntax (%#)",
    async (pattern, names, expected) => {
      const root = await fixture({ assets: [pattern] });
      await mkdir(path.join(root, "assets"));
      await Promise.all(
        names.map((name) => writeFile(path.join(root, `assets/${name}.txt`), name)),
      );
      const result = await loadProject(root);
      expect(result.diagnostics).toEqual([]);
      expect(result.project?.assets.map((asset) => asset.path)).toEqual(
        expected.map((name) => `assets/${name}.txt`),
      );
    },
  );

  it("expands ranges after a literal brace directory", async () => {
    const root = await fixture({ assets: ["assets/{prefix}/file{1..2}.txt"] });
    await mkdir(path.join(root, "assets/{prefix}"), { recursive: true });
    await writeFile(path.join(root, "assets/{prefix}/file1.txt"), "first");
    await writeFile(path.join(root, "assets/{prefix}/file2.txt"), "last");
    const result = await loadProject(root);
    expect(result.diagnostics).toEqual([]);
    expect(result.project?.assets.map((asset) => asset.path)).toEqual([
      "assets/{prefix}/file1.txt",
      "assets/{prefix}/file2.txt",
    ]);
  });

  it.skipIf(process.platform === "win32")(
    "preserves escaped literal POSIX backslashes",
    async () => {
      const root = await fixture({ assets: ["assets/back\\\\slash.txt"] });
      await mkdir(path.join(root, "assets"));
      await writeFile(path.join(root, "assets/back\\slash.txt"), "literal backslash");
      const result = await loadProject(root);
      expect(result.diagnostics).toEqual([]);
      expect(result.project?.assets.map((asset) => asset.path)).toEqual(["assets/back\\slash.txt"]);
    },
  );

  it("treats output directory metacharacters literally and keeps sibling sources", async () => {
    const root = await fixture({ outputDir: "build{one,two}" });
    for (const directory of ["build{one,two}", "buildone", "buildtwo"]) {
      await mkdir(path.join(root, directory));
      await writeFile(path.join(root, directory, "helper.bp"), "LCD.Clear()\n");
    }
    const result = await loadProject(root);
    expect(result.diagnostics).toEqual([]);
    expect(result.project?.sources.map((source) => source.path)).toEqual([
      "buildone/helper.bp",
      "buildtwo/helper.bp",
      "src/main.bp",
    ]);
  });

  it("does not interpret output directory braces as nested patterns", async () => {
    const root = await fixture({ outputDir: "{".repeat(100) + "x" + "}".repeat(100) });
    const result = await loadProject(root);
    expect(result.diagnostics).toEqual([]);
    expect(result.project?.sources.map((source) => source.path)).toEqual(["src/main.bp"]);
  });
});

it("discovers declared extensions and overlays while excluding output and symlinks", async () => {
  const root = await fixture({ language: "toy", target: "toy-vm", entry: "src/main.toy" });
  await writeFile(path.join(root, "src/main.toy"), "disk");
  await writeFile(path.join(root, "src/module.inc"), "module");
  await mkdir(path.join(root, "build"));
  await writeFile(path.join(root, "build/old.toy"), "old");
  await symlink(path.join(root, "src/module.inc"), path.join(root, "src/link.inc"));
  const declaration = {
    language: "toy",
    entryExtensions: ["toy"],
    sourceExtensions: ["toy", "inc"],
    ir: { min: 1, max: 1 },
  };
  const overlays = new Map([
    ["src/main.toy", "overlay"],
    ["src/new.inc", "new"],
    ["build/old.toy", "ignored"],
    ["src/main.bp", "ignored"],
  ]);
  const loaded = await loadProject(root, overlays, undefined, undefined, () => declaration);
  expect(loaded.diagnostics).toEqual([]);
  expect(loaded.project!.sources).toEqual([
    { path: "src/main.toy", content: "overlay" },
    { path: "src/module.inc", content: "module" },
    { path: "src/new.inc", content: "new" },
  ]);
  const bad = await loadProject(
    root,
    new Map([["src/link.inc", "unsafe"]]),
    undefined,
    undefined,
    () => declaration,
  );
  expect(bad.project).toBeUndefined();
  const entryRejected = await loadProject(root, new Map(), undefined, undefined, () => ({
    ...declaration,
    entryExtensions: ["other"],
  }));
  expect(entryRejected.project).toBeUndefined();
});
it("accepts validated language and target ids without changing schema version", () => {
  expect(parseManifest({ ...manifest, language: "toy", target: "toy-vm" }).manifest).toMatchObject({
    schemaVersion: 1,
    language: "toy",
    target: "toy-vm",
  });
  for (const id of ["UPPER", "x".repeat(33), "../x"])
    expect(parseManifest({ ...manifest, language: id }).manifest).toBeUndefined();
});
