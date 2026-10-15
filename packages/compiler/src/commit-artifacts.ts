import { createHash } from "node:crypto";
import { lstat, mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { BuildArtifact, MemoryArtifact, SourceProject } from "./contracts.js";
import { BUILD_LIMITS, validateArtifactLayout, validateBuildLimits } from "./artifacts.js";
import { assertNoSymlinks, readBoundedFile } from "./safe-files.js";
import { resolveInside } from "./manifest.js";
import { acquireOutputLock, type LockOptions } from "./output-lock.js";
import { BuildError } from "./build-error.js";
export interface CommitOptions {
  io?: {
    write(file: string, data: Uint8Array): Promise<void>;
    rename(from: string, to: string): Promise<void>;
  };
  lock?: LockOptions;
  beforeRename?(index: number): void;
}
const hash = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
export async function commitArtifacts(
  project: SourceProject,
  buildId: string,
  artifacts: MemoryArtifact[],
  signal: AbortSignal,
  options: CommitOptions = {},
): Promise<BuildArtifact[]> {
  if (!/^[a-zA-Z0-9-]+$/.test(buildId)) throw new BuildError("BUILD1003", "Invalid build id.");
  validateArtifactLayout(artifacts);
  validateBuildLimits(
    artifacts.filter((item) => item.slot !== "ir" && item.slot !== "asset").length,
    artifacts.map((item) => ({
      relativePath: item.relativePath,
      byteLength: item.data.byteLength,
    })),
  );
  const output = await resolveInside(project.root, project.manifest.outputDir);
  const staging = path.join(output, `.kobrixa-${buildId}.tmp`);
  const io = options.io ?? {
    write: (file: string, bytes: Uint8Array) => writeFile(file, bytes),
    rename,
  };
  let ownsStaging = false;
  let release: (() => Promise<void>) | undefined;
  let started = false;
  try {
    signal.throwIfAborted();
    await mkdir(output, { recursive: true });
    await mkdir(staging);
    ownsStaging = true;
    const staged: Array<{ memory: MemoryArtifact; artifact: BuildArtifact }> = [];
    let total = 0;
    for (const memory of artifacts) {
      signal.throwIfAborted();
      const file = path.join(staging, memory.relativePath);
      await mkdir(path.dirname(file), { recursive: true });
      await io.write(file, memory.data);
      const actual = await readBoundedFile(
        staging,
        memory.relativePath,
        Math.min(BUILD_LIMITS.artifactBytes, BUILD_LIMITS.totalBytes - total),
        signal,
      );
      total += actual.byteLength;
      const sha256 = hash(actual);
      if (actual.byteLength !== memory.data.byteLength || sha256 !== hash(memory.data))
        throw new BuildError(
          "BUILD1003",
          "Staged artifact differs from the validated memory snapshot.",
        );
      staged.push({
        memory,
        artifact: {
          slot: memory.slot,
          kind: memory.kind,
          role: memory.role,
          mediaType: memory.mediaType,
          path: path.join(output, memory.relativePath),
          sha256,
          byteLength: actual.byteLength,
          ...(memory.remotePath === undefined ? {} : { remotePath: memory.remotePath }),
        },
      });
    }
    release = await acquireOutputLock(output, signal, options.lock);
    for (const item of staged) {
      const destination = await assertNoSymlinks(output, item.memory.relativePath, true);
      const info = await lstat(destination).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
        return undefined;
      });
      if (info && !info.isFile())
        throw new BuildError("BUILD1003", "An artifact destination is not a regular file.");
    }
    const priority = { aux: 0, "deploy-asset": 1, "deploy-main": 2 };
    staged.sort(
      (a, b) =>
        priority[a.artifact.role] - priority[b.artifact.role] ||
        a.memory.relativePath.localeCompare(b.memory.relativePath, "en"),
    );
    for (let index = 0; index < staged.length; index++) {
      const item = staged[index]!;
      await mkdir(path.dirname(item.artifact.path), { recursive: true });
      options.beforeRename?.(index);
      if (!started) signal.throwIfAborted(); // 第一次 rename 前最後一個取消檢查。
      started = true;
      await io.rename(path.join(staging, item.memory.relativePath), item.artifact.path);
    }
    return staged.map((item) => item.artifact);
  } catch (error) {
    if (
      !started &&
      (error instanceof BuildError || (error instanceof Error && error.name === "AbortError"))
    )
      throw error;
    throw new BuildError("BUILD9000", error instanceof Error ? error.message : String(error));
  } finally {
    // There is no cleanup-warning channel here. Best-effort cleanup must neither
    // invalidate committed artifacts nor replace the original build/cancellation error.
    await release?.().catch(() => undefined);
    if (ownsStaging) await rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }
}
