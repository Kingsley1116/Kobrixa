import { readFile, stat } from "node:fs/promises";
import { BasicPlusFrontend } from "@kobrixa/basic-plus";
import { EV3Backend } from "@kobrixa/backend-ev3";
import {
  diagnostic,
  diagnosticFromSpan,
  resolveInside,
  type SourceProject,
} from "@kobrixa/compiler";
import { validateIR } from "@kobrixa/ir";
import { PREVIEW_MAX_FILES, PREVIEW_MAX_FILE_BYTES } from "../../shared/offline-preview.js";
import type { PreparedSimulation, SimulationPrepareResult } from "../../shared/simulator.js";

/** Read original assets once; preparation never commits build artifacts. */
export async function snapshotSimulationAssets(
  project: SourceProject,
): Promise<Record<string, number[]>> {
  if (project.assets.length > PREVIEW_MAX_FILES)
    throw new Error("Simulation supports at most 64 resource files.");
  const files: Record<string, number[]> = Object.create(null);
  let total = 0;
  for (const asset of project.assets) {
    const relative = asset.path.replaceAll("\\", "/");
    const target = await resolveInside(project.root, relative);
    const before = await stat(target);
    if (!before.isFile() || before.size > PREVIEW_MAX_FILE_BYTES - total)
      throw new Error("Simulation resource files exceed the 1 MiB limit.");
    const bytes = await readFile(target);
    const after = await stat(target);
    if (
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      bytes.length !== after.size
    )
      throw new Error("A resource changed while preparing the simulation. Try again.");
    total += bytes.length;
    if (total > PREVIEW_MAX_FILE_BYTES)
      throw new Error("Simulation resource files exceed the 1 MiB limit.");
    files[relative] = Array.from(bytes);
  }
  return files;
}

export async function prepareSimulation(
  project: SourceProject,
  entries: string[],
  files: Record<string, number[]>,
  signal: AbortSignal,
): Promise<SimulationPrepareResult> {
  const diagnostics: SimulationPrepareResult["diagnostics"] = [];
  const programs: PreparedSimulation["programs"] = Object.create(null);
  try {
    if (entries.length > 4) throw new Error("Simulation supports at most four program entries.");
    const frontend = new BasicPlusFrontend();
    const backend = new EV3Backend();
    for (const entry of [...new Set(entries)]) {
      signal.throwIfAborted();
      if (
        !/\.bp$/i.test(entry) ||
        entry.includes("\\") ||
        entry.startsWith("/") ||
        entry.split("/").some((part) => part === ".." || part === ".") ||
        !project.sources.some((source) => source.path === entry)
      )
        throw new Error(`Unknown project program entry: ${entry}`);
      const result = await frontend.compile(
        { ...project, manifest: { ...project.manifest, entry } },
        signal,
      );
      diagnostics.push(...result.diagnostics);
      if (!result.ir || result.diagnostics.some((item) => item.severity === "error")) continue;
      const issues = validateIR(result.ir);
      diagnostics.push(
        ...issues.map((issue) => diagnosticFromSpan(issue.code, issue.message, issue.span)),
      );
      if (issues.length) continue;
      const native = await backend.compile(result.ir, signal);
      diagnostics.push(...native.diagnostics);
      if (!native.rbf || native.diagnostics.some((item) => item.severity === "error")) continue;
      programs[entry] = { ir: result.ir, files };
    }
    signal.throwIfAborted();
    if (
      diagnostics.some((item) => item.severity === "error") ||
      Object.keys(programs).length !== new Set(entries).size
    )
      return { success: false, diagnostics };
    return { success: true, diagnostics, prepared: { programs } };
  } catch (error) {
    diagnostics.push(
      diagnostic(
        "SIM1001",
        error instanceof Error ? error.message : String(error),
        project.manifest.entry,
      ),
    );
    return { success: false, diagnostics };
  }
}
