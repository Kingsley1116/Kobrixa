import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import { z } from "zod";
import type { Diagnostic, ProjectManifest, SourceFile, SourceProject } from "./contracts.js";
import { diagnostic } from "./diagnostics.js";

const manifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    name: z.string().trim().min(1),
    language: z.literal("bp"),
    entry: z.string().trim().min(1),
    target: z.literal("ev3-native"),
    assets: z.array(z.string().trim().min(1)).default([]),
    outputDir: z.string().trim().min(1).default("build"),
  })
  .loose();

export interface ProjectLoadResult {
  project?: SourceProject;
  diagnostics: Diagnostic[];
  implicit: boolean;
  candidates?: string[];
}

/** Optional long-lived source cache for editor analysis. Discovery and path
 * validation still run on every load, so deletions and symlink changes are seen. */
export class ProjectSourceCache {
  private readonly files = new Map<string, { stamp: string; content: string }>();
  readonly readFiles: string[] = [];
  begin(): void {
    this.readFiles.length = 0;
  }
  retain(paths: Set<string>): void {
    for (const file of this.files.keys()) if (!paths.has(file)) this.files.delete(file);
  }
  async read(file: string): Promise<string> {
    const stat = await lstat(file, { bigint: true });
    const stamp = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
    const cached = this.files.get(file);
    if (cached?.stamp === stamp) return cached.content;
    const content = await readFile(file, "utf8");
    this.files.set(file, { stamp, content });
    this.readFiles.push(file);
    return content;
  }
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}

async function canonicalExistingParent(target: string): Promise<string> {
  let cursor = target;
  for (;;) {
    try {
      const canonical = await realpath(cursor);
      return path.join(canonical, path.relative(cursor, target));
    } catch {
      const parent = path.dirname(cursor);
      if (parent === cursor) throw new Error(`No existing parent for ${target}`);
      cursor = parent;
    }
  }
}

export async function resolveInside(root: string, relativePath: string): Promise<string> {
  if (relativePath.includes("\0") || path.isAbsolute(relativePath))
    throw new Error("Path must be project-relative.");
  const canonicalRoot = await realpath(root);
  const candidate = path.resolve(canonicalRoot, relativePath);
  const canonicalTarget = await canonicalExistingParent(candidate);
  if (!isInside(canonicalRoot, canonicalTarget)) throw new Error("Path escapes the project root.");
  return canonicalTarget;
}

function rangeFromZod(issue: z.core.$ZodIssue): string {
  return issue.path.length ? `${issue.path.join(".")}: ${issue.message}` : issue.message;
}

export function parseManifest(value: unknown): {
  manifest?: ProjectManifest;
  diagnostics: Diagnostic[];
} {
  const parsed = manifestSchema.safeParse(value);
  if (!parsed.success) {
    return {
      diagnostics: parsed.error.issues.map((issue) => diagnostic("MAN1001", rangeFromZod(issue))),
    };
  }
  return { manifest: parsed.data as ProjectManifest, diagnostics: [] };
}

async function loadSources(
  root: string,
  manifest: ProjectManifest,
  overlays: ReadonlyMap<string, string>,
  cache?: ProjectSourceCache,
): Promise<SourceFile[]> {
  const entry = await resolveInside(root, manifest.entry);
  await lstat(entry);
  const sourcePaths = new Set<string>([
    manifest.entry.replaceAll(path.sep, "/"),
    ...(await fg(["**/*.bp", "**/*.bpi", "**/*.bpm"], {
      cwd: root,
      onlyFiles: true,
      dot: false,
      followSymbolicLinks: false,
      ignore: [`${manifest.outputDir.replaceAll(path.sep, "/")}/**`],
    })),
  ]);
  for (const overlayPath of overlays.keys()) {
    if (/\.(bp|bpi|bpm)$/i.test(overlayPath))
      sourcePaths.add(overlayPath.replaceAll(path.sep, "/"));
  }
  const paths = new Set<string>();
  cache?.begin();
  const sources = await Promise.all(
    [...sourcePaths].sort().map(async (sourcePath) => {
      const absolute = await resolveInside(root, sourcePath);
      paths.add(absolute);
      return {
        path: sourcePath,
        content:
          overlays.get(sourcePath) ??
          (cache ? await cache.read(absolute) : await readFile(absolute, "utf8")),
      };
    }),
  );
  cache?.retain(paths);
  return sources;
}

export async function loadProject(
  inputPath: string,
  overlays: ReadonlyMap<string, string> = new Map(),
  selectedEntry?: string,
  sourceCache?: ProjectSourceCache,
): Promise<ProjectLoadResult> {
  const diagnostics: Diagnostic[] = [];
  try {
    const stat = await lstat(inputPath);
    let root: string;
    let manifest: ProjectManifest;
    let implicit = false;

    if (stat.isFile() && inputPath.toLocaleLowerCase("en-US").endsWith("kobrixa.json")) {
      root = path.dirname(inputPath);
      const raw: unknown = JSON.parse(await readFile(inputPath, "utf8"));
      const parsed = parseManifest(raw);
      if (!parsed.manifest) return { diagnostics: parsed.diagnostics, implicit: false };
      manifest = parsed.manifest;
    } else if (stat.isFile() && inputPath.toLocaleLowerCase("en-US").endsWith(".bp")) {
      root = path.dirname(inputPath);
      const entry = path.basename(inputPath);
      manifest = implicitManifest(entry);
      implicit = true;
    } else if (stat.isDirectory()) {
      root = inputPath;
      const manifestPath = path.join(root, "kobrixa.json");
      try {
        const raw: unknown = JSON.parse(await readFile(manifestPath, "utf8"));
        const parsed = parseManifest(raw);
        if (!parsed.manifest) return { diagnostics: parsed.diagnostics, implicit: false };
        manifest = parsed.manifest;
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
        const candidates = (
          await fg("**/*.bp", {
            cwd: root,
            onlyFiles: true,
            dot: false,
            followSymbolicLinks: false,
          })
        ).sort();
        const entry = selectedEntry ?? (candidates.length === 1 ? candidates[0] : undefined);
        if (!entry) return { diagnostics, implicit: true, candidates };
        manifest = implicitManifest(entry);
        implicit = true;
      }
    } else {
      return {
        diagnostics: [diagnostic("MAN1000", "Open a folder, kobrixa.json, or .bp file.")],
        implicit: false,
      };
    }

    const entryAbsolute = await resolveInside(root, manifest.entry);
    const sourceRoot = path.dirname(entryAbsolute);
    const outputAbsolute = await resolveInside(root, manifest.outputDir);
    if (isInside(outputAbsolute, sourceRoot)) {
      diagnostics.push(
        diagnostic("MAN1004", "outputDir must not equal or contain the source root."),
      );
    }

    const assets = (
      await fg(manifest.assets, {
        cwd: root,
        onlyFiles: true,
        dot: false,
        followSymbolicLinks: false,
        unique: true,
      })
    ).sort();
    const assetFiles = await Promise.all(
      assets.map(async (assetPath) => ({
        path: assetPath,
        absolutePath: await resolveInside(root, assetPath),
      })),
    );
    const sources = await loadSources(root, manifest, overlays, sourceCache);
    if (diagnostics.length) return { diagnostics, implicit };
    return {
      project: { root: await realpath(root), manifest, sources, assets: assetFiles },
      diagnostics,
      implicit,
    };
  } catch (error) {
    return {
      diagnostics: [
        diagnostic("MAN1002", error instanceof Error ? error.message : "Unable to load project."),
      ],
      implicit: false,
    };
  }
}

function implicitManifest(entry: string): ProjectManifest {
  const name = path.basename(entry, path.extname(entry));
  return {
    schemaVersion: 1,
    name,
    language: "bp",
    entry: entry.replaceAll(path.sep, "/"),
    target: "ev3-native",
    assets: [],
    outputDir: "build",
  };
}
