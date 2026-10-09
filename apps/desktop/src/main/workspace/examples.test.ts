import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { EV3Backend, inspectRbf } from "@kobrixa/backend-ev3";
import { BasicPlusFrontend } from "@kobrixa/basic-plus";
import { BuildSession, loadProject } from "@kobrixa/compiler";
import { validateIR } from "@kobrixa/ir";

const repositoryRoot = fileURLToPath(new URL("../../../../../", import.meta.url));
const examplesRoot = path.join(repositoryRoot, "examples");
const exampleHeader = "' Independently authored Kobrixa example";
// Media lessons that demonstrate choosing their own storage keep a dedicated Folder.
const runtimeDirectories: Record<string, string> = {
  "media/internal-media-folder": "/home/root/lms2012/prjs/KobrixaCard",
  "media/sd-media-folder": "/home/root/lms2012/prjs/SD_Card/KobrixaSDCard",
};
const defaultRuntimeDirectory = "/home/root/lms2012/prjs/Kobrixa";
const documentedCategories = [
  "benchmarks",
  "daisy-chain",
  "hitechnic",
  "algorithms",
  "getting-started",
  "capstones",
  "buttons",
  "collections",
  "concurrency",
  "display",
  "files",
  "media",
  "sound",
  "control-flow",
  "language",
  "mailboxes",
  "program",
  "projects",
  "motors",
  "sensors",
  "time",
  "simulation",
];

async function findExampleProjects(root: string, relative = ""): Promise<string[]> {
  const directory = path.join(root, relative);
  const entries = await readdir(directory, { withFileTypes: true });
  if (entries.some((entry) => entry.isFile() && entry.name === "kobrixa.json")) return [relative];
  const children = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      // Example identifiers also appear in manifests and Markdown links, so use forward slashes.
      .map((entry) => findExampleProjects(root, path.posix.join(relative, entry.name))),
  );
  return children.flat();
}

async function findSources(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const children = await Promise.all(
    entries.map((entry) => {
      const child = path.join(directory, entry.name);
      if (entry.isDirectory()) return entry.name === "build" ? [] : findSources(child);
      return /\.(bp|bpi|bpm)$/.test(entry.name) ? [child] : [];
    }),
  );
  return children.flat();
}

describe("shipped examples", () => {
  it("links every example from the bilingual and category indexes", async () => {
    const examples = (await findExampleProjects(examplesRoot)).sort();
    expect(examples.length).toBeGreaterThan(0);
    const indexes = await Promise.all(
      ["README.md", "README.zh-TW.md"].map((name) =>
        readFile(path.join(examplesRoot, name), "utf8"),
      ),
    );
    for (const projectPath of examples) {
      expect(documentedCategories, projectPath).toContain(projectPath.split("/")[0]);
      for (const index of indexes) expect(index, projectPath).toContain(`](${projectPath}/)`);
    }
    // Each language links to its own category page, which links back and to its translation.
    const languages = [
      { index: indexes[0]!, file: "README.md", other: "README.zh-TW.md", entry: "" },
      { index: indexes[1]!, file: "README.zh-TW.md", other: "README.md", entry: "README.zh-TW.md" },
    ];
    for (const category of documentedCategories) {
      for (const { index, file, other, entry } of languages) {
        expect(index).toContain(`href="./${category}/${entry}"`);
        const categoryIndex = await readFile(path.join(examplesRoot, category, file), "utf8");
        expect(categoryIndex, `${category}/${file}`).toContain(`href="../${file}"`);
        expect(categoryIndex, `${category}/${file}`).toContain(`href="./${other}"`);
        for (const projectPath of examples.filter((item) => item.startsWith(`${category}/`))) {
          expect(categoryIndex).toContain(`](./${path.basename(projectPath)}/)`);
        }
      }
    }
  });

  it("starts every source file with the shared example header", async () => {
    const sources = await findSources(examplesRoot);
    expect(sources.length).toBeGreaterThan(0);
    for (const source of sources) {
      const name = path.relative(examplesRoot, source);
      const [first, second, third] = (await readFile(source, "utf8")).split(/\r?\n/);
      expect(first, name).toBe(exampleHeader);
      expect(second, name).toMatch(/^' \S/);
      // Included and imported files must not repeat the entry program's Folder.
      if (source.endsWith(".bp")) expect(third, name).toMatch(/^Folder "(prjs|sd)" "[^"]+"$/);
      else expect(third, name).toBe("");
    }
  });

  it("compiles every example to a valid native RBF image in its Folder", async () => {
    for (const projectPath of (await findExampleProjects(examplesRoot)).sort()) {
      const loaded = await loadProject(path.join(examplesRoot, projectPath));
      expect(loaded.diagnostics, projectPath).toEqual([]);
      expect(loaded.project, projectPath).toBeDefined();

      const frontend = await new BasicPlusFrontend().compile(
        loaded.project!,
        new AbortController().signal,
      );
      expect(frontend.diagnostics, projectPath).toEqual([]);
      expect(frontend.ir, projectPath).toBeDefined();
      expect(validateIR(frontend.ir!), projectPath).toEqual([]);

      const result = await new BuildSession(new BasicPlusFrontend(), new EV3Backend()).compile(
        loaded.project!,
      );
      expect(result.diagnostics, projectPath).toEqual([]);
      expect(result.success, projectPath).toBe(true);
      expect(result.runtimeDirectory, projectPath).toBe(
        runtimeDirectories[projectPath] ?? defaultRuntimeDirectory,
      );
      const image = result.artifacts.find((artifact) => artifact.kind === "rbf")!;
      expect(inspectRbf(await readFile(image.path)).objectCount, projectPath).toBeGreaterThan(0);
      if (projectPath in runtimeDirectories) {
        expect(
          result.artifacts
            .filter((artifact) => artifact.kind === "asset")
            .map((artifact) => artifact.remotePath)
            .sort(),
        ).toEqual(["assets/card.rgf", "assets/ping.rsf"]);
      }
    }
  });
});

it("ships an RSF header matching its PCM payload and sample rate", async () => {
  const sound = await readFile(
    path.join(repositoryRoot, "examples/media/original-media/assets/deploy/kobrixa-chime.rsf"),
  );
  expect(sound.readUInt16BE(0)).toBe(0x0100);
  expect(sound.readUInt16BE(2)).toBe(sound.length - 8);
  expect(sound.readUInt16BE(4)).toBe(8000);
  expect(sound.readUInt16BE(6)).toBe(0);
});

it("renders the mascot outline and limbs intact using EV3 RGF pixel order", async () => {
  const bitmap = await readFile(
    path.join(repositoryRoot, "examples/media/original-media/assets/deploy/kobrixa-mascot.rgf"),
  );
  const [width, height] = bitmap;
  expect(width).toBe(176);
  expect(height).toBe(128);
  const stride = Math.ceil(width! / 8);
  expect(bitmap.length).toBe(2 + stride * height!);
  // dLcdDrawBitmap consumes bit 0 first, moving left to right.
  const black = (x: number, y: number) =>
    (bitmap[2 + y * stride + Math.floor(x / 8)]! & (1 << (x % 8))) !== 0;
  for (let y = 16; y < 76; y += 1) {
    for (const x of [44, 47, 128, 131]) expect(black(x, y), `head ${x},${y}`).toBe(true);
  }
  for (const [x, y] of [
    [26, 50],
    [149, 57],
    [64, 120],
    [111, 123],
  ])
    expect(black(x!, y!), `limb ${x},${y}`).toBe(true);
  for (const [x, y] of [
    [43, 20],
    [48, 20],
    [127, 20],
    [132, 20],
    [63, 120],
    [78, 120],
  ])
    expect(black(x!, y!), `background ${x},${y}`).toBe(false);
});
