import { createHash } from "node:crypto";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { pluginManifestSchema } from "@kobrixa/plugin-protocol";
import type { BuiltinResourceIndex } from "@kobrixa/plugin-runtime";
import {
  declaredJsonPaths,
  regularBytes,
  validateBuiltinLeaf,
} from "./src/main/plugins/builtin-launch.js";

export async function emitResourceIndex(
  sourceRoot: string,
  outputRoot: string,
  pluginId: string,
): Promise<BuiltinResourceIndex> {
  const source = await realpath(sourceRoot);
  const output = await realpath(outputRoot);
  const manifestBytes = await regularBytes(source, "kobrixa-plugin.json", 64 * 1024);
  const manifest = pluginManifestSchema.parse(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes)),
  );
  if (
    manifest.id !== pluginId ||
    manifest.runtime.kind !== "node" ||
    manifest.runtime.entry !== "main.cjs"
  )
    throw new Error("Invalid builtin process manifest.");
  const names = ["kobrixa-plugin.json", "main.cjs", ...declaredJsonPaths(manifest)].sort();
  if (names.length > 32) throw new Error("Builtin resource index exceeds 32 files.");
  const files: BuiltinResourceIndex["files"] = [];
  for (const name of names) {
    const bytes =
      name === "main.cjs"
        ? await regularBytes(output, name, 16 * 1024 * 1024)
        : name === "kobrixa-plugin.json"
          ? manifestBytes
          : await regularBytes(source, name, 1024 * 1024);
    if (name !== "main.cjs") {
      await mkdir(path.dirname(path.join(output, name)), { recursive: true });
      await writeFile(path.join(output, name), bytes);
    }
    files.push({
      path: name,
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }
  const index: BuiltinResourceIndex = { version: 1, pluginId, files };
  const encoded = Buffer.from(JSON.stringify(index));
  if (encoded.length > 16 * 1024) throw new Error("Builtin resource index exceeds 16 KiB.");
  await writeFile(path.join(output, "resource-index.json"), encoded);
  await validateBuiltinLeaf(output, pluginId);
  return index;
}
