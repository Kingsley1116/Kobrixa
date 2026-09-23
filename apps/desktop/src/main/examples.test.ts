import { readFile, readdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { EV3Backend, inspectRbf } from "@kobrixa/backend-ev3";
import { BasicPlusFrontend } from "@kobrixa/basic-plus";
import { BuildSession, loadProject } from "@kobrixa/compiler";
import { validateIR } from "@kobrixa/ir";

const repositoryRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const newExamples = JSON.parse(
  readFileSync(path.join(repositoryRoot, "examples/new-examples.json"), "utf8"),
) as Array<{ project: string; checks: unknown[] }>;
const parityExamples = JSON.parse(
  readFileSync(path.join(repositoryRoot, "examples/clev3r-parity.json"), "utf8"),
) as Array<{ project: string; checks: unknown[]; reference: string }>;
const documentedExamples = [
  ...parityExamples.map((example) => example.project),
  ...newExamples.map((example) => example.project),
  "buttons/button-feedback",
  "capstones/button-car",
  "capstones/obstacle-rover",
  "capstones/sensor-dashboard",
  "collections/row-vector",
  "collections/vector-workbench",
  "control-flow/boolean-logic",
  "control-flow/break-and-continue",
  "control-flow/comparison-operators",
  "control-flow/control-flow",
  "control-flow/if-elseif",
  "control-flow/labels-and-goto",
  "control-flow/nested-control",
  "control-flow/while-loop",
  "display/display-fonts",
  "display/display-shapes",
  "display/display-write",
  "display/double-buffer-animation",
  "display/drawing-primitives",
  "files/file-round-trip",
  "files/binary-record",
  "getting-started/hello-ev3",
  "language/case-insensitive",
  "language/byte-logic",
  "language/text-and-math",
  "language/local-functions",
  "mailboxes/mailbox-local",
  "motors/motor-counter",
  "motors/motor-move",
  "motors/motor-reverse",
  "motors/motor-sequence",
  "motors/motor-start-stop",
  "motors/motor-steer-sync",
  "motors/motor-schedule",
  "media/original-media",
  "program/program-end",
  "projects/include-multiple",
  "projects/include-settings",
  "projects/import-functions",
  "projects/import-module",
  "program/brick-status",
  "sensors/color-sensor",
  "sensors/gyro-sensor",
  "sensors/sensor-sampling",
  "sensors/sensor-threshold",
  "sensors/sensor-details",
  "sensors/i2c-registers",
  "sensors/raw-and-mode",
  "sound/speaker-melody",
  "sound/speaker-interrupt",
  "sound/speaker-scale",
  "concurrency/thread-mutex",
  "time/timer-slots",
].sort();
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

describe("shipped examples", () => {
  it("compiles newly added examples and checks their lesson documentation", async () => {
    expect(newExamples).toHaveLength(20);
    const index = await readFile(path.join(repositoryRoot, "examples/NEW-EXAMPLES.md"), "utf8");
    for (const example of newExamples) {
      const projectPath = path.join(repositoryRoot, "examples", example.project);
      expect(index, example.project).toContain(`](${example.project}/)`);
      const readme = await readFile(path.join(projectPath, "README.md"), "utf8");
      expect(readme).toContain("Expected result / 預期結果");
      expect(example.checks.length).toBeGreaterThan(0);
      const loaded = await loadProject(projectPath);
      expect(loaded.diagnostics, example.project).toEqual([]);
      const front = await new BasicPlusFrontend().compile(
        loaded.project!,
        new AbortController().signal,
      );
      expect(front.diagnostics, example.project).toEqual([]);
      expect(validateIR(front.ir!), example.project).toEqual([]);
      const back = await new EV3Backend().compile(front.ir!, new AbortController().signal);
      expect(back.diagnostics, example.project).toEqual([]);
      expect(inspectRbf(back.rbf!).objectCount, example.project).toBeGreaterThan(0);
    }
  });

  it("builds the 41 Clev3r topic counterparts with lesson notes and Folder deployment metadata", async () => {
    expect(parityExamples).toHaveLength(41);
    const index = await readFile(path.join(repositoryRoot, "examples/CLEV3R-PARITY.md"), "utf8");
    for (const lesson of parityExamples) {
      const projectPath = path.join(repositoryRoot, "examples", lesson.project);
      expect(index).toContain(`](${lesson.project}/)`);
      expect(await readFile(path.join(projectPath, "README.md"), "utf8")).toContain(
        "Expected result / 預期結果",
      );
      const loaded = await loadProject(projectPath);
      expect(loaded.diagnostics).toEqual([]);
      const result = await new BuildSession(new BasicPlusFrontend(), new EV3Backend()).compile(
        loaded.project!,
      );
      expect(result.diagnostics, lesson.project).toEqual([]);
      expect(result.success, lesson.project).toBe(true);
      const image = result.artifacts.find((artifact) => artifact.kind === "rbf")!;
      expect(inspectRbf(await readFile(image.path)).objectCount).toBeGreaterThan(0);
      if (lesson.project.endsWith("media-folder")) {
        expect(result.runtimeDirectory).toBe(
          lesson.project.includes("sd-")
            ? "/home/root/lms2012/prjs/SD_Card/KobrixaSDCard"
            : "/home/root/lms2012/prjs/KobrixaCard",
        );
        expect(
          result.artifacts
            .filter((artifact) => artifact.kind === "asset")
            .map((artifact) => artifact.remotePath)
            .sort(),
        ).toEqual(["assets/card.rgf", "assets/ping.rsf"]);
      }
    }
  });

  it("compiles every example to a valid native RBF image", async () => {
    const examplesRoot = path.join(repositoryRoot, "examples");
    const examples = (await findExampleProjects(examplesRoot)).sort();
    expect(examples).toEqual(documentedExamples);
    const indexes = await Promise.all(
      ["README.md", "README.zh-TW.md"].map((name) =>
        readFile(path.join(examplesRoot, name), "utf8"),
      ),
    );
    for (const projectPath of documentedExamples) {
      for (const index of indexes) expect(index).toContain(`](${projectPath}/)`);
    }
    for (const category of documentedCategories) {
      for (const index of indexes) expect(index).toContain(`href="./${category}/"`);
      const categoryIndex = await readFile(path.join(examplesRoot, category, "README.md"), "utf8");
      expect(categoryIndex).toContain('href="../README.md"');
      expect(categoryIndex).toContain('href="../README.zh-TW.md"');
      for (const projectPath of documentedExamples.filter((item) =>
        item.startsWith(`${category}/`),
      )) {
        expect(categoryIndex).toContain(`](./${path.basename(projectPath)}/)`);
      }
    }

    for (const projectPath of examples) {
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

      const backend = await new EV3Backend().compile(frontend.ir!, new AbortController().signal);
      expect(backend.diagnostics, projectPath).toEqual([]);
      expect(backend.rbf, projectPath).toBeDefined();
      expect(inspectRbf(backend.rbf!).objectCount, projectPath).toBeGreaterThan(0);
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
