import {
  compileToMemory,
  diagnostic,
  failedBuild,
  readBoundedFile,
  requirePublished,
  type Diagnostic,
  type SourceProject,
} from "@kobrixa/compiler";
import type { CompilerSnapshot } from "@kobrixa/plugin-runtime";
import { PREVIEW_MAX_FILES, PREVIEW_MAX_FILE_BYTES } from "../../shared/offline-preview.js";
import type { PreparedSimulation, SimulationPrepareResult } from "../../shared/simulator.js";
import { createBuiltinCompilers } from "./builtin-compilers.js";
export async function snapshotSimulationAssets(
  project: SourceProject,
): Promise<Record<string, number[]>> {
  if (project.assets.length > PREVIEW_MAX_FILES)
    throw new Error("Simulation supports at most 64 resource files.");
  const files: Record<string, number[]> = Object.create(null);
  let total = 0;
  for (const asset of project.assets) {
    const relative = asset.path.replaceAll("\\", "/");
    try {
      const bytes = await readBoundedFile(
        project.root,
        relative,
        PREVIEW_MAX_FILE_BYTES - total,
        new AbortController().signal,
      );
      total += bytes.length;
      files[relative] = Array.from(bytes);
    } catch (error) {
      throw new Error(
        `Simulation resource snapshot exceeds the 1 MiB limit or changed while reading: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return files;
}
export async function prepareSimulation(
  project: SourceProject,
  entries: string[],
  files: Record<string, number[]>,
  signal: AbortSignal,
  compiler: CompilerSnapshot,
  create: typeof createBuiltinCompilers = createBuiltinCompilers,
): Promise<SimulationPrepareResult> {
  const diagnostics: Diagnostic[] = [];
  const programs: PreparedSimulation["programs"] = Object.create(null);
  let success = false;
  try {
    if (entries.length > 4) throw new Error("Simulation supports at most four program entries.");
    if (
      Object.keys(files).length > PREVIEW_MAX_FILES ||
      Object.values(files).reduce((sum, bytes) => sum + bytes.length, 0) > PREVIEW_MAX_FILE_BYTES
    )
      throw new Error("Simulation supports at most 64 resources totaling 1 MiB.");
    const assetSnapshots = Object.fromEntries(
      Object.entries(files).map(([name, bytes]) => [name, Uint8Array.from(bytes)]),
    );
    for (const entry of [...new Set(entries)]) {
      signal.throwIfAborted();
      if (
        !compiler.frontend.contribution.entryExtensions.includes(
          entry.split(".").at(-1)!.toLowerCase(),
        ) ||
        entry.includes("\\") ||
        entry.startsWith("/") ||
        entry.split("/").some((part) => part === ".." || part === ".") ||
        !project.sources.some((source) => source.path === entry)
      )
        throw new Error(`Unknown project program entry: ${entry}`);
      const { frontend, backend, sources } = create(compiler);
      const result = await compileToMemory(
        { ...project, assetSnapshots, manifest: { ...project.manifest, entry } },
        frontend,
        backend,
        signal,
        sources,
      );
      diagnostics.push(...result.diagnostics);
      if (!result.success) continue;
      if (result.ir.version !== 1) throw new Error("Unsupported simulation IR version.");
      programs[entry] = { ir: result.ir, files: structuredClone(files) };
    }
    signal.throwIfAborted();
    success =
      !diagnostics.some((item) => item.severity === "error") &&
      Object.keys(programs).length === new Set(entries).size;
  } catch (error) {
    diagnostics.push(
      diagnostic(
        "SIM1001",
        error instanceof Error ? error.message : String(error),
        project.manifest.entry,
      ),
    );
  }
  try {
    const published = requirePublished(diagnostics);
    return success
      ? { success: true, diagnostics: published, prepared: { programs } }
      : { success: false, diagnostics: published };
  } catch (error) {
    return {
      success: false,
      diagnostics: requirePublished(
        failedBuild("simulation", "unknown", error, "<project>").diagnostics,
      ),
    };
  }
}
