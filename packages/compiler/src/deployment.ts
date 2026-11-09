import { createHash } from "node:crypto";
import path from "node:path";
import type { CompileResult } from "./contracts.js";
import { BuildError } from "./build-error.js";
import { BUILD_LIMITS, validateArtifactLayout, validateBuildLimits } from "./artifacts.js";
import { readBoundedFile } from "./safe-files.js";
export interface DeploymentFile {
  role: "deploy-asset" | "deploy-main";
  path: string;
  remotePath: string;
  bytes: Uint8Array;
  sha256: string;
}
export async function readDeploymentSnapshot(
  result: CompileResult,
  supported: "ev3",
  signal = new AbortController().signal,
): Promise<DeploymentFile[]> {
  const mains = result.artifacts.filter((item) => item.role === "deploy-main");
  if (!result.success || result.deploy !== supported || mains.length !== 1 || !mains[0]!.byteLength)
    throw new BuildError("BUILD1005", "This target cannot be deployed to the selected device.");
  const assets = result.artifacts
    .filter((item) => item.role === "deploy-asset")
    .sort((a, b) =>
      (a.remotePath ?? "") < (b.remotePath ?? "")
        ? -1
        : (a.remotePath ?? "") > (b.remotePath ?? "")
          ? 1
          : 0,
    );
  const selected = [...assets, mains[0]!];
  try {
    const paths = selected.map((item) => ({
      relativePath:
        item.role === "deploy-main" ? path.basename(item.path) : (item.remotePath ?? ""),
      byteLength: item.byteLength,
    }));
    validateArtifactLayout(paths);
    validateBuildLimits(0, paths);
    const files: DeploymentFile[] = [];
    let total = 0;
    for (let index = 0; index < selected.length; index++) {
      signal.throwIfAborted();
      const artifact = selected[index]!;
      const bytes = await readBoundedFile(
        path.dirname(artifact.path),
        path.basename(artifact.path),
        Math.min(artifact.byteLength, BUILD_LIMITS.artifactBytes, BUILD_LIMITS.totalBytes - total),
        signal,
      );
      total += bytes.byteLength;
      if (
        bytes.byteLength !== artifact.byteLength ||
        createHash("sha256").update(bytes).digest("hex") !== artifact.sha256
      )
        throw new Error("The artifact hash or byte length changed.");
      files.push({
        role: artifact.role as DeploymentFile["role"],
        path: artifact.path,
        remotePath: paths[index]!.relativePath,
        bytes,
        sha256: artifact.sha256,
      });
    }
    return files;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    throw new BuildError("BUILD1006", "Build artifacts changed or are missing; build again.");
  }
}
