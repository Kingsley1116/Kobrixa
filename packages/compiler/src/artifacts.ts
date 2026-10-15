import { serializeIR, type KobrixaIR } from "@kobrixa/ir";
import type { BackendDecl } from "@kobrixa/plugin-protocol";
import type { BackendResult, MemoryArtifact, SourceProject } from "./contracts.js";
import { BuildError } from "./build-error.js";
import { assertSafeRelative, readBoundedFile } from "./safe-files.js";
export const BUILD_LIMITS = {
  backendArtifacts: 64,
  artifacts: 1024,
  artifactBytes: 64 * 1024 * 1024,
  totalBytes: 256 * 1024 * 1024,
  filenameBytes: 128,
  relativePathBytes: 512,
} as const;
const invalid = (message: string): never => {
  throw new BuildError("BUILD1003", message);
};
export function safeProjectName(name: string): string {
  return (
    name
      .normalize("NFKD")
      .replace(/[^A-Za-z0-9_-]+/g, "_")
      .replace(/^_+|_+$/g, "") || "program"
  );
}
export function validateBuildLimits(
  backendCount: number,
  entries: readonly { relativePath: string; byteLength: number }[],
): void {
  if (backendCount > BUILD_LIMITS.backendArtifacts || entries.length > BUILD_LIMITS.artifacts)
    invalid("Too many build artifacts.");
  let total = 0;
  for (const entry of entries) {
    if (
      !Number.isSafeInteger(entry.byteLength) ||
      entry.byteLength < 0 ||
      entry.byteLength > BUILD_LIMITS.artifactBytes
    )
      invalid("A build artifact exceeds 64 MiB.");
    total += entry.byteLength;
    if (total > BUILD_LIMITS.totalBytes) invalid("Build artifacts exceed 256 MiB.");
    if (
      Buffer.byteLength(entry.relativePath, "utf8") > BUILD_LIMITS.relativePathBytes ||
      entry.relativePath
        .split("/")
        .some((part) => Buffer.byteLength(part, "utf8") > BUILD_LIMITS.filenameBytes)
    )
      invalid("Artifact path exceeds the UTF-8 byte limit.");
  }
}
export function validateArtifactLayout(
  entries: readonly { relativePath: string; remotePath?: string }[],
): void {
  const check = (paths: string[]) => {
    const names = new Set<string>();
    for (const relative of paths) {
      const normalized = assertSafeRelative(relative).normalize("NFC").toLowerCase();
      if (names.has(normalized)) invalid("Artifact paths collide after NFC/case normalization.");
      names.add(normalized);
    }
    for (const name of names) {
      const parts = name.split("/");
      for (let i = 1; i < parts.length; i++)
        if (names.has(parts.slice(0, i).join("/")))
          invalid("Artifact file and directory paths collide.");
    }
  };
  check(entries.map((entry) => entry.relativePath));
  // 同時檢查部署的相對命名空間，避免資源覆蓋同名程式。
  check(entries.map((entry) => entry.remotePath ?? entry.relativePath));
}
export async function validateArtifacts(
  project: SourceProject,
  declaration: BackendDecl,
  result: BackendResult,
  ir: KobrixaIR,
  signal: AbortSignal,
): Promise<MemoryArtifact[]> {
  try {
    signal.throwIfAborted();
    if (result.artifacts.length > BUILD_LIMITS.backendArtifacts)
      invalid("Too many backend artifacts.");
    const seen = new Set<string>();
    const base = safeProjectName(project.manifest.name);
    const artifacts: MemoryArtifact[] = [];
    let backendBytes = 0;
    const declarations = new Map(declaration.artifacts.map((item) => [item.slot, item]));
    if (
      declarations.size !== declaration.artifacts.length ||
      declarations.has("ir") ||
      declarations.has("asset")
    )
      invalid("Duplicate or reserved declared slot.");
    for (const item of result.artifacts) {
      const declared = declarations.get(item.slot);
      if (!declared || seen.has(item.slot)) invalid("Undeclared or duplicate backend slot.");
      seen.add(item.slot);
      if (!(item.data instanceof Uint8Array)) invalid("Artifact data must be Uint8Array.");
      if (declared!.role === "deploy-main" && !item.data.byteLength)
        invalid("deploy-main must not be empty.");
      if (item.data.byteLength > BUILD_LIMITS.artifactBytes)
        invalid("A build artifact exceeds 64 MiB.");
      backendBytes += item.data.byteLength;
      if (backendBytes > BUILD_LIMITS.totalBytes) invalid("Build artifacts exceed 256 MiB.");
      artifacts.push({
        slot: declared!.slot,
        kind: declared!.kind,
        role: declared!.role,
        mediaType: declared!.mediaType,
        relativePath: `${base}.${declared!.extension}`,
        data: Uint8Array.from(item.data),
      });
    }
    if (declaration.artifacts.some((item) => item.required && !seen.has(item.slot)))
      invalid("Missing required backend slot.");
    const mains = artifacts.filter((item) => item.role === "deploy-main");
    const declaredMains = declaration.artifacts.filter((item) => item.role === "deploy-main");
    if (
      declaration.capabilities.deploy &&
      (mains.length !== 1 || declaredMains.length !== 1 || !declaredMains[0]!.required)
    )
      invalid("A deployable backend requires one non-empty required main.");
    const irText = serializeIR(ir);
    const irBytes = Buffer.byteLength(irText, "utf8");
    if (irBytes > BUILD_LIMITS.artifactBytes || backendBytes + irBytes > BUILD_LIMITS.totalBytes)
      invalid("Serialized IR exceeds the remaining artifact byte budget.");
    artifacts.push({
      slot: "ir",
      kind: "ir",
      role: "aux",
      mediaType: "application/json",
      relativePath: `${base}.ir.json`,
      data: new TextEncoder().encode(irText),
    });
    const assets = project.assets.map((asset) => ({
      slot: "asset",
      kind: "asset",
      role: "deploy-asset" as const,
      mediaType: "application/octet-stream",
      relativePath: `assets/${assertSafeRelative(asset.path.replaceAll("\\", "/"))}`,
      remotePath: asset.path.replaceAll("\\", "/"),
    }));
    // 所有路徑、數量先檢查，再開來源資源；不信任傳入的 absolutePath。
    validateArtifactLayout([...artifacts, ...assets]);
    validateBuildLimits(result.artifacts.length, [
      ...artifacts.map((item) => ({ ...item, byteLength: item.data.byteLength })),
      ...assets.map((item) => ({ ...item, byteLength: 0 })),
    ]);
    let total = artifacts.reduce((sum, item) => sum + item.data.byteLength, 0);
    for (const asset of assets) {
      let data: Uint8Array;
      const remaining = Math.min(BUILD_LIMITS.artifactBytes, BUILD_LIMITS.totalBytes - total);
      if (project.assetSnapshots !== undefined) {
        const captured = project.assetSnapshots[asset.remotePath];
        if (!captured || captured.byteLength > remaining)
          invalid("Missing or oversized captured resource.");
        data = Uint8Array.from(captured!);
      } else {
        data = await readBoundedFile(project.root, asset.remotePath, remaining, signal);
      }
      total += data.byteLength;
      artifacts.push({ ...asset, data });
    }
    validateBuildLimits(
      result.artifacts.length,
      artifacts.map((item) => ({ ...item, byteLength: item.data.byteLength })),
    );
    return artifacts;
  } catch (error) {
    if (error instanceof BuildError || (error instanceof Error && error.name === "AbortError"))
      throw error;
    throw new BuildError("BUILD1003", error instanceof Error ? error.message : String(error));
  }
}
