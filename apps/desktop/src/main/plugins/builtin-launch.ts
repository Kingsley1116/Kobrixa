import { createHash } from "node:crypto";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { constants, type BigIntStats } from "node:fs";
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
type PathIdentity = { path: string; stat: BigIntStats };
const sameIdentity = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino;
const sameFile = (a: BigIntStats, b: BigIntStats) =>
  sameIdentity(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;

// Installed payloads must remain immutable through validation AND process launch.
// Node pathname APIs cannot atomically defeat continuously adversarial rename/restore
// cycles. These snapshots reject observed replacements; they are not openat-style
// directory capabilities. Canonical paths avoid rejecting OS aliases such as /var.
async function snapshotPath(absolute: string, file: boolean): Promise<PathIdentity[]> {
  if (!path.isAbsolute(absolute)) fail();
  const base = path.parse(absolute).root;
  const names = [base];
  let current = base;
  for (const part of path.relative(base, absolute).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    names.push(current);
  }
  const entries: PathIdentity[] = [];
  for (const name of names) {
    const stat = await lstat(name, { bigint: true });
    if (stat.isSymbolicLink() || (file && name === absolute ? !stat.isFile() : !stat.isDirectory()))
      fail();
    entries.push({ path: name, stat });
  }
  if ((await realpath(absolute)) !== absolute) fail();
  return entries;
}
async function assertPath(entries: PathIdentity[]): Promise<void> {
  for (const entry of entries) {
    const stat = await lstat(entry.path, { bigint: true });
    if (
      stat.isSymbolicLink() ||
      !sameIdentity(entry.stat, stat) ||
      (entry.stat.isFile() ? !stat.isFile() || !sameFile(entry.stat, stat) : !stat.isDirectory())
    )
      fail();
  }
  const last = entries.at(-1)!;
  if ((await realpath(last.path)) !== last.path) fail();
}
export async function regularBytes(root: string, relative: string, limit: number): Promise<Buffer> {
  try {
    if (
      !path.isAbsolute(root) ||
      (relative !== "main.cjs" &&
        relative !== "resource-index.json" &&
        !diagnosticHelpDeclSchema.shape.path.safeParse(relative).success)
    )
      fail();
    const target = path.join(root, relative);
    const entries = await snapshotPath(target, true);
    const expected = entries.at(-1)!.stat;
    // POSIX FIFOs must not block open before fstat can reject them. On Windows
    // ordinary filesystem paths have no POSIX FIFO type; unsupported flags are 0.
    const handle = await open(
      target,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
    try {
      const before = await handle.stat({ bigint: true });
      if (!before.isFile() || before.size > BigInt(limit) || !sameFile(expected, before)) fail();
      await assertPath(entries);
      // Bounded allocation even if a file grows after stat.
      const bytes = Buffer.alloc(limit + 1);
      let size = 0;
      while (size <= limit) {
        const { bytesRead } = await handle.read(bytes, size, bytes.length - size, size);
        if (bytesRead === 0) break;
        size += bytesRead;
      }
      const after = await handle.stat({ bigint: true });
      if (
        size > limit ||
        BigInt(size) !== before.size ||
        !after.isFile() ||
        !sameFile(before, after)
      )
        fail();
      await assertPath(entries);
      return bytes.subarray(0, size);
    } finally {
      await handle.close();
    }
  } catch {
    return fail();
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
    const leaf = await lstat(packageRoot, { bigint: true });
    if (!leaf.isDirectory() || leaf.isSymbolicLink()) fail();
    const root = await realpath(packageRoot);
    const rootIdentity = await snapshotPath(root, false);
    if (!sameIdentity(leaf, rootIdentity.at(-1)!.stat)) fail();
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
    await assertPath(rootIdentity);
    const finalLeaf = await lstat(packageRoot, { bigint: true });
    if (
      finalLeaf.isSymbolicLink() ||
      !sameIdentity(leaf, finalLeaf) ||
      (await realpath(packageRoot)) !== root
    )
      fail();
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
  let validated: Awaited<ReturnType<typeof validateBuiltinLeaf>>;
  try {
    const parent = input.packaged
      ? path.join(path.dirname(input.appPath), "app.asar.unpacked")
      : input.buildRoot;
    if (!path.isAbsolute(parent)) fail();
    const parentReal = await realpath(parent);
    const rootReal = await realpath(root);
    const rootIdentity = await snapshotPath(rootReal, false);
    const relative = path.relative(parentReal, rootReal);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
      fail();
    let current = parent;
    for (const segment of path.relative(parent, root).split(path.sep)) {
      current = path.join(current, segment);
      const entry = await lstat(current);
      if (!entry.isDirectory() || entry.isSymbolicLink()) fail();
    }
    validated = await validateBuiltinLeaf(root, input.pluginId);
    await assertPath(rootIdentity);
    if (
      validated.root !== rootReal ||
      (await realpath(root)) !== rootReal ||
      (await realpath(parent)) !== parentReal
    )
      fail();
  } catch {
    return fail();
  }
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
