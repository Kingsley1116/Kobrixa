import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
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

  it("applies the expansion budget across all asset patterns", async () => {
    const root = await fixture({ assets: ["assets/a{1..200}.txt", "assets/b{1..200}.txt"] });
    const result = await loadProject(root);
    expect(result.project).toBeUndefined();
    expect(result.diagnostics[0]?.message).toContain("at most 256 patterns");
  });

  it.each([
    'assets/{"alpha","beta"}.txt',
    'assets/{"alpha,beta",gamma}.txt',
    "assets/{a},b}.txt",
    "assets/{!..%}.txt",
    "assets/{Z..a}.txt",
  ])("diagnoses unsupported brace forms without silently dropping assets (%#)", async (pattern) => {
    const root = await fixture({ assets: [pattern] });
    const result = await loadProject(root);
    expect(result.project).toBeUndefined();
    expect(result.diagnostics[0]?.code).toBe("MAN1001");
    expect(result.diagnostics[0]?.message).toContain("balanced, unquoted brace expressions");
  });

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
