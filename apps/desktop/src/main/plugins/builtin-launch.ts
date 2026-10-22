import { createHash } from "node:crypto";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { constants } from "node:fs";
import { z } from "zod";
import {
  diagnosticHelpDeclSchema,
  pluginManifestSchema,
  type PluginManifest,
} from "@kobrixa/plugin-protocol";
import {
  PluginError,
  type BuiltinLaunchDescriptor,
  type BuiltinResourceIndex,
} from "@kobrixa/plugin-runtime";

type Id = string;
export const BUILTIN_PROCESS_IDS = Object.freeze({
  "motor-test": "kobrixa.motor-test",
  "sensor-lab": "kobrixa.sensor-lab",
  "device-ev3": "kobrixa.device-ev3",
});
const indexSchema = z.strictObject({
  version: z.literal(1),
  pluginId: z.string(),
  files: z
    .array(
      z.strictObject({
        path: z.string().max(600),
        bytes: z
          .number()
          .int()
          .min(0)
          .max(16 * 1024 * 1024),
        sha256: z.string().regex(/^[0-9a-f]{64}$/),
      }),
    )
    .min(2)
    .max(32),
});
const fail = (): never => {
  throw new PluginError("PLUGIN_E_ENTRY", "Shipped plugin payload is unavailable or invalid.");
};
const utf8 = (bytes: Uint8Array) => new TextDecoder("utf-8", { fatal: true }).decode(bytes);
export function parseBuiltinResourceIndex(value: unknown): BuiltinResourceIndex {
  return indexSchema.parse(value);
}
export function declaredJsonPaths(manifest: PluginManifest): string[] {
  const declarations: Array<{ path: string; version: number }> = [];
  const contributes = manifest.contributes;
  for (const item of contributes?.panels ?? []) declarations.push(item.resource);
  for (const item of contributes?.status ?? []) declarations.push(item.resource);
  for (const item of contributes?.languages ?? [])
    declarations.push(item.tokenizer, item.configuration);
  if (contributes?.diagnosticHelp) declarations.push(contributes.diagnosticHelp);
  const paths = new Set<string>();
  for (const declaration of declarations) {
    if (
      declaration.version !== 1 ||
      !diagnosticHelpDeclSchema.shape.path.safeParse(declaration.path).success
    )
      fail();
    if (["kobrixa-plugin.json", "resource-index.json"].includes(declaration.path)) fail();
    paths.add(declaration.path);
  }
  return [...paths].sort();
}
export async function regularBytes(root: string, relative: string, limit: number): Promise<Buffer> {
  if (
    relative !== "main.cjs" &&
    relative !== "resource-index.json" &&
    !diagnosticHelpDeclSchema.shape.path.safeParse(relative).success
  )
    fail();
  const parts = relative.split("/");
  let current = root;
  for (let index = 0; index < parts.length; index++) {
    current = path.join(current, parts[index]!);
    const stat = await lstat(current);
    if (
      stat.isSymbolicLink() ||
      (index + 1 === parts.length ? !stat.isFile() : !stat.isDirectory())
    )
      fail();
  }
  const resolved = await realpath(current);
  const inside = path.relative(root, resolved);
  if (inside === ".." || inside.startsWith(`..${path.sep}`) || path.isAbsolute(inside)) fail();
  const handle = await open(resolved, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > limit) fail();
    // Bounded allocation; readFile could allocate an unbounded file grown after stat.
    const bytes = Buffer.alloc(limit + 1);
    let size = 0;
    while (size <= limit) {
      const { bytesRead } = await handle.read(bytes, size, bytes.length - size, size);
      if (bytesRead === 0) break;
      size += bytesRead;
    }
    const after = await handle.stat();
    if (
      size > limit ||
      size !== before.size ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ino !== after.ino
    )
      fail();
    return bytes.subarray(0, size);
  } finally {
    await handle.close();
  }
}
export async function validateBuiltinLeaf(
  packageRoot: string,
  pluginId: Id,
): Promise<{
  root: string;
  manifest: PluginManifest;
  index: BuiltinResourceIndex;
  resources: Readonly<Record<string, string>>;
}> {
  try {
    if (!path.isAbsolute(packageRoot)) fail();
    const leaf = await lstat(packageRoot);
    if (!leaf.isDirectory() || leaf.isSymbolicLink()) fail();
    const root = await realpath(packageRoot);
    const index = parseBuiltinResourceIndex(
      JSON.parse(utf8(await regularBytes(root, "resource-index.json", 16 * 1024))),
    );
    if (index.pluginId !== pluginId) fail();
    const names = index.files.map((file) => file.path);
    if (
      new Set(names).size !== names.length ||
      JSON.stringify(names) !== JSON.stringify([...names].sort())
    )
      fail();
    const manifestBytes = await regularBytes(root, "kobrixa-plugin.json", 64 * 1024);
    const manifest = pluginManifestSchema.parse(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes)),
    );
    if (
      manifest.id !== pluginId ||
      manifest.runtime.kind !== "node" ||
      manifest.runtime.entry !== "main.cjs"
    )
      fail();
    const expected = ["main.cjs", "kobrixa-plugin.json", ...declaredJsonPaths(manifest)].sort();
    if (JSON.stringify(names) !== JSON.stringify(expected)) fail();
    const resources: Record<string, string> = Object.create(null) as Record<string, string>;
    for (const file of index.files) {
      const data =
        file.path === "kobrixa-plugin.json"
          ? manifestBytes
          : await regularBytes(
              root,
              file.path,
              file.path === "main.cjs" ? 16 * 1024 * 1024 : 1024 * 1024,
            );
      if (
        data.length !== file.bytes ||
        createHash("sha256").update(data).digest("hex") !== file.sha256
      )
        fail();
      if (file.path.endsWith(".json") && file.path !== "kobrixa-plugin.json")
        resources[file.path] = utf8(data);
    }
    return { root, manifest, index, resources };
  } catch {
    return fail();
  }
}
export async function resolveBuiltinLaunch(input: {
  sourceKey: string;
  pluginId: Id;
  slug: string;
  packaged: boolean;
  appPath: string;
  buildRoot: string;
}): Promise<BuiltinLaunchDescriptor> {
  if (
    !Object.hasOwn(BUILTIN_PROCESS_IDS, input.slug) ||
    BUILTIN_PROCESS_IDS[input.slug as keyof typeof BUILTIN_PROCESS_IDS] !== input.pluginId ||
    input.sourceKey !== `builtin:${input.pluginId}`
  )
    fail();
  if (input.packaged && path.basename(input.appPath) !== "app.asar") fail();
  const root = input.packaged
    ? path.join(
        path.dirname(input.appPath),
        "app.asar.unpacked",
        ".vite",
        "build",
        "plugins",
        input.slug,
      )
    : path.join(input.buildRoot, "plugins", input.slug);
  try {
    const parent = input.packaged
      ? path.join(path.dirname(input.appPath), "app.asar.unpacked")
      : input.buildRoot;
    if (!path.isAbsolute(parent)) fail();
    const parentReal = await realpath(parent);
    const rootReal = await realpath(root);
    const relative = path.relative(parentReal, rootReal);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
      fail();
    let current = parent;
    for (const segment of path.relative(parent, root).split(path.sep)) {
      current = path.join(current, segment);
      const entry = await lstat(current);
      if (!entry.isDirectory() || entry.isSymbolicLink()) fail();
    }
  } catch {
    return fail();
  }
  const validated = await validateBuiltinLeaf(root, input.pluginId);
  return {
    sourceKey: input.sourceKey,
    pluginId: input.pluginId,
    policy: "optional",
    runtime: "node",
    packageRoot: validated.root,
    entry: "main.cjs",
    manifest: "kobrixa-plugin.json",
    resourceIndex: "resource-index.json",
  };
}
