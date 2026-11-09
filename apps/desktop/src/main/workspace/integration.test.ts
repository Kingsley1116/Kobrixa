import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BuildSession, loadProject } from "@kobrixa/compiler";
import { createBuiltinCompilers, resolveBuiltinCompiler } from "./builtin-compilers.js";
import { inspectRbf } from "@kobrixa/backend-ev3";

describe("v1 compiler pipeline", () => {
  it("builds Basic Plus into a verified committed main artifact", async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "kobrixa-integration-")));
    await writeFile(
      path.join(root, "kobrixa.json"),
      JSON.stringify({
        schemaVersion: 1,
        name: "hello",
        language: "bp",
        entry: "main.bp",
        target: "ev3-native",
        assets: ["assets/**/*"],
        outputDir: "build",
      }),
    );
    await writeFile(
      path.join(root, "main.bp"),
      'LCD.Clear()\nLCD.Text(1, 0, 0, 1, "Hello")\nLCD.Update()\n',
    );
    await mkdir(path.join(root, "assets"));
    await writeFile(path.join(root, "assets", "lesson.txt"), "asset");
    const loaded = await loadProject(root);
    expect(loaded.diagnostics).toEqual([]);
    const selection = resolveBuiltinCompiler(
      loaded.project!.manifest.language,
      loaded.project!.manifest.target,
    );
    if (!selection.ok) throw new Error(selection.message);
    const { frontend: buildFrontend, backend } = createBuiltinCompilers(selection);
    const result = await new BuildSession(buildFrontend, backend).compile(loaded.project!);
    expect(result.success).toBe(true);
    const artifact = result.artifacts.find((item) => item.role === "deploy-main");
    expect(artifact).toBeDefined();
    expect(inspectRbf(await readFile(artifact!.path)).objectCount).toBe(1);
    expect(result.artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "deploy-asset", remotePath: "assets/lesson.txt" }),
      ]),
    );
  });
});
