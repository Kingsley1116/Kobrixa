import { compilerIdSchema, type FrontendDecl } from "@kobrixa/plugin-protocol";
import { BuildError } from "./build-error.js";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import micromatch from "micromatch";
import fg from "fast-glob";
import { z } from "zod";
import type { Diagnostic, ProjectManifest, SourceFile, SourceProject } from "./contracts.js";
import { diagnostic } from "./diagnostics.js";

const MAX_PATTERN_LENGTH = 4096;
const MAX_EXPANDED_PATTERNS = 256;

function validateAssetPatterns(patterns: string[]): void {
  let expandedCount = 0;
  for (const pattern of patterns) {
    let entries: string[];
    try {
      // pnpm patches the original parser to throw before excessive nesting or
      // expansion. Match fast-glob's brace options to preserve glob semantics.
      entries = micromatch.braces(pattern, { expand: true, nodupes: true, keepEscaping: true });
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
      throw new Error(`Assets may expand to at most ${MAX_EXPANDED_PATTERNS} patterns.`);
    }
    expandedCount += entries.filter((entry) => entry !== "").length;
    if (expandedCount > MAX_EXPANDED_PATTERNS)
      throw new Error(`Assets may expand to at most ${MAX_EXPANDED_PATTERNS} patterns.`);
  }
}

const manifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    name: z.string().trim().min(1),
    language: compilerIdSchema,
    entry: z.string().trim().min(1),
    target: compilerIdSchema,
    assets: z
      .array(
        z
          .string()
          .trim()
          .min(1)
          .max(MAX_PATTERN_LENGTH)
          // Count raw opening delimiters, including escaped/quoted ones, so
          // validation never depends on the glob parser's interpretation.
          .refine((pattern) => (pattern.match(/[({]/g)?.length ?? 0) <= 64, {
            message: "Asset patterns may contain at most 64 opening braces or parentheses.",
          })
          .refine((pattern) => (pattern.match(/[)}]/g)?.length ?? 0) <= 64, {
            message: "Asset patterns may contain at most 64 closing braces or parentheses.",
          }),
      )
      .default([]),
    outputDir: z.string().trim().min(1).default("build"),
  })
  .loose();

export interface ProjectDescription {
  root: string;
  manifest: ProjectManifest;
  implicit: boolean;
}
export interface ProjectDescriptionResult {
  description?: ProjectDescription;
  diagnostics: Diagnostic[];
  implicit: boolean;
  candidates?: string[];
}

export interface ProjectLoadResult {
  /** Original compiler failure for in-process callers that need to rethrow it. */
  error?: BuildError;
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
  try {
    validateAssetPatterns(parsed.data.assets);
  } catch (error) {
    return {
      diagnostics: [diagnostic("MAN1001", `assets: ${(error as Error).message}`)],
    };
  }
  return { manifest: parsed.data as ProjectManifest, diagnostics: [] };
}

// Sources keep the manifest path rules; portable artifact naming rules do not apply.
async function resolveSource(
  root: string,
  relative: string,
  allowMissing = false,
): Promise<string> {
  const absolute = await resolveInside(root, relative);
  let cursor = await realpath(root);
  for (const part of relative.replaceAll(path.sep, "/").split("/")) {
    if (!part || part === ".") continue;
    cursor = path.join(cursor, part);
    try {
      if ((await lstat(cursor)).isSymbolicLink())
        throw new Error("Source paths must not pass through symbolic links.");
    } catch (error) {
      if (allowMissing && (error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
  }
  return absolute;
}

async function loadSources(
  root: string,
  manifest: ProjectManifest,
  overlays: ReadonlyMap<string, string>,
  declaration: FrontendDecl,
  cache?: ProjectSourceCache,
): Promise<SourceFile[]> {
  const extension = (file: string): string => path.posix.extname(file).slice(1).toLowerCase();
  const entryPath = path.normalize(manifest.entry).replaceAll(path.sep, "/");
  if (!declaration.entryExtensions.includes(extension(entryPath)))
    throw new Error("The entry extension is not supported by the selected frontend.");
  const entry = await resolveSource(root, manifest.entry);
  if (!(await lstat(entry)).isFile()) throw new Error("The project entry must be a regular file.");
  const output = await resolveInside(root, manifest.outputDir);
  const excluded = async (relative: string) =>
    isInside(output, await resolveInside(root, relative));
  const sourcePaths = new Set<string>([entryPath]);
  const discovered = await fg(
    declaration.sourceExtensions.map((value) => `**/*.${value}`),
    {
      cwd: root,
      onlyFiles: true,
      dot: false,
      followSymbolicLinks: false,
      braceExpansion: false,
      caseSensitiveMatch: false,
      ignore: [`${fg.convertPathToPattern(manifest.outputDir)}/**`],
    },
  );
  for (const relative of discovered) if (!(await excluded(relative))) sourcePaths.add(relative);
  for (const relative of overlays.keys()) {
    if (!declaration.sourceExtensions.includes(extension(relative))) continue;
    await resolveSource(root, relative, true);
    if (!(await excluded(relative))) sourcePaths.add(relative);
  }
  const paths = new Set<string>();
  cache?.begin();
  const sources = await Promise.all(
    [...sourcePaths].sort().map(async (relative) => {
      const absolute = await resolveSource(root, relative, overlays.has(relative));
      paths.add(absolute);
      return {
        path: relative,
        content:
          overlays.get(relative) ??
          (cache ? await cache.read(absolute) : await readFile(absolute, "utf8")),
      };
    }),
  );
  cache?.retain(paths);
  return sources;
}

export async function readProjectDescription(
  inputPath: string,
  selectedEntry?: string,
): Promise<ProjectDescriptionResult> {
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
            braceExpansion: false,
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

    return { description: { root, manifest, implicit }, diagnostics, implicit };
  } catch (error) {
    return {
      diagnostics: [
        diagnostic(
          error instanceof SyntaxError ? "MAN1001" : "MAN1002",
          error instanceof Error ? error.message : "Unable to load project.",
        ),
      ],
      implicit: false,
    };
  }
}

export async function loadProject(
  inputPath: string,
  overlays: ReadonlyMap<string, string> = new Map(),
  selectedEntry?: string,
  sourceCache?: ProjectSourceCache,
  resolveFrontend?: (manifest: ProjectManifest) => FrontendDecl,
): Promise<ProjectLoadResult> {
  const diagnostics: Diagnostic[] = [];
  try {
    const described = await readProjectDescription(inputPath, selectedEntry);
    if (!described.description) return described;
    const { root, implicit } = described.description;
    let { manifest } = described.description;

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
    const declaration =
      resolveFrontend?.(manifest) ??
      (manifest.language === "bp"
        ? {
            language: "bp",
            entryExtensions: ["bp"],
            sourceExtensions: ["bp", "bpi", "bpm"],
            ir: { min: 1, max: 1 },
          }
        : undefined);
    if (!declaration)
      throw new BuildError("BUILD1001", `No enabled language provider: ${manifest.language}.`);
    const sources = await loadSources(root, manifest, overlays, declaration, sourceCache);

    if (diagnostics.length) return { diagnostics, implicit };
    // Validate the original path first, then expose the same spelling used by sources.
    manifest = { ...manifest, entry: path.normalize(manifest.entry).replaceAll(path.sep, "/") };
    return {
      project: { root: await realpath(root), manifest, sources, assets: assetFiles },
      diagnostics,
      implicit,
    };
  } catch (error) {
    const resolutionError =
      error instanceof BuildError && (error.code === "BUILD1001" || error.code === "BUILD1002")
        ? error
        : undefined;
    return {
      ...(resolutionError ? { error: resolutionError } : {}),
      diagnostics: [
        diagnostic(
          resolutionError?.code ?? (error instanceof SyntaxError ? "MAN1001" : "MAN1002"),
          resolutionError?.detail ??
            (error instanceof Error ? error.message : "Unable to load project."),
        ),
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
