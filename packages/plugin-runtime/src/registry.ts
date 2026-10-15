import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import semver from "semver";
import { z } from "zod";
import {
  compilerDeclarationProblems,
  PLUGIN_API_VERSION,
  PLUGIN_LIMITS,
  pluginManifestSchema,
  type PluginManifest,
} from "@kobrixa/plugin-protocol";
import { markProviderConflicts } from "./compiler-resolution.js";
import { messageOf, type PluginErrorCode, type PluginProblem } from "./errors.js";

export const MANIFEST_FILE = "kobrixa-plugin.json";
/** Bound on reading one development folder, so a hung disk cannot block startup or recovery. */
export const SOURCE_READ_TIMEOUT_MS = 5_000;
export type PluginSource =
  { kind: "builtin"; manifest: unknown } | { kind: "development"; directory: string };
export type DevelopmentSource = Extract<PluginSource, { kind: "development" }>;
/** `builtin:<manifest id>` or `dev:` plus 16 hex digits; safe to accept from the renderer. */
export const sourceKeySchema = z
  .string()
  .max(160)
  .regex(/^(?:builtin:[a-z0-9.-]+|dev:[0-9a-f]{16})$/);

/** Identity of a development source that survives manifest id changes. Pure: no file access. */
export const developmentSourceKey = (directory: string): string =>
  `dev:${createHash("sha256").update(path.resolve(directory)).digest("hex").slice(0, 16)}`;

/** One source as read on its own; resolvePlugins() decides its status within the whole set. */
export interface ReadPlugin {
  sourceKey: string;
  id: string;
  source: "builtin" | "development";
  directory?: string;
  manifest?: PluginManifest;
  entry?: string;
  /** Problems of this source alone; empty means it is valid by itself. */
  problems: readonly PluginProblem[];
  /** Safe mode: the folder was deliberately not read. */
  unread?: true;
}
export interface RegisteredPlugin extends Omit<ReadPlugin, "problems"> {
  status: "enabled" | "disabled" | "invalid";
  disabledBy?: "user" | "safe-mode";
  problems: PluginProblem[];
}
type SourceRead = Omit<ReadPlugin, "sourceKey">;

const problem = (code: PluginErrorCode, message: string): PluginProblem => ({ code, message });

function semanticProblems(manifest: PluginManifest, source: ReadPlugin["source"]): PluginProblem[] {
  const problems: PluginProblem[] = [];
  problems.push(
    ...compilerDeclarationProblems(manifest).map((message) =>
      problem("PLUGIN_E_MANIFEST", message),
    ),
  );
  if (!semver.satisfies(PLUGIN_API_VERSION, manifest.apiVersion))
    problems.push(
      problem(
        "PLUGIN_E_API_VERSION",
        `This Kobrixa provides plugin API ${PLUGIN_API_VERSION}; the plugin requires ${manifest.apiVersion}.`,
      ),
    );
  const builtinRuntime = manifest.runtime.kind === "builtin";
  if (builtinRuntime !== (source === "builtin"))
    problems.push(
      problem(
        "PLUGIN_E_RUNTIME_NOT_ALLOWED",
        builtinRuntime
          ? "Only plugins shipped with Kobrixa can use the builtin runtime."
          : "Built-in plugins must use the builtin runtime in this version.",
      ),
    );
  if (manifest.contributes?.frontends !== undefined && source !== "builtin")
    problems.push(
      problem(
        "PLUGIN_E_FRONTEND_REQUIRES_BUILTIN",
        "Compiler frontends can only be contributed by built-in plugins in this version.",
      ),
    );
  if (manifest.contributes?.backends !== undefined && source !== "builtin")
    problems.push(
      problem(
        "PLUGIN_E_BACKEND_REQUIRES_BUILTIN",
        "Compiler backends can only be contributed by built-in plugins in this version.",
      ),
    );
  const commands = (manifest.contributes?.commands ?? []).map((command) => command.id);
  for (const id of commands)
    if (!id.startsWith(`${manifest.id}.`))
      problems.push(
        problem("PLUGIN_E_COMMAND_NAMESPACE", `Command ${id} must start with ${manifest.id}.`),
      );
  for (const id of new Set(commands.filter((id, index) => commands.indexOf(id) !== index)))
    problems.push(
      problem("PLUGIN_E_DUPLICATE_COMMAND", `Command ${id} is declared more than once.`),
    );
  for (const event of manifest.activationEvents ?? [])
    if (!commands.includes(event.slice("onCommand:".length)))
      problems.push(
        problem(
          "PLUGIN_E_ACTIVATION",
          `${event} does not refer to a command contributed by this plugin.`,
        ),
      );
  return problems;
}

function checkManifest(
  value: unknown,
  source: ReadPlugin["source"],
  fallbackId: string,
): SourceRead {
  const parsed = pluginManifestSchema.safeParse(value);
  if (!parsed.success)
    return {
      id: fallbackId,
      source,
      problems: [problem("PLUGIN_E_MANIFEST", z.prettifyError(parsed.error))],
    };
  return {
    id: parsed.data.id,
    source,
    manifest: parsed.data,
    problems: semanticProblems(parsed.data, source),
  };
}

async function readDevelopmentPlugin(directory: string): Promise<SourceRead> {
  const fallback = path.basename(directory);
  const invalid = (message: string, code: PluginErrorCode = "PLUGIN_E_MANIFEST"): SourceRead => ({
    id: fallback,
    source: "development",
    directory,
    problems: [problem(code, message)],
  });
  let root: string;
  let value: unknown;
  try {
    root = await realpath(directory);
    const file = path.join(root, MANIFEST_FILE);
    if ((await stat(file)).size > PLUGIN_LIMITS.manifestBytes)
      return invalid(`${MANIFEST_FILE} is larger than 64 KiB.`);
    value = JSON.parse((await readFile(file, "utf8")).replace(/^\uFEFF/, ""));
  } catch (error) {
    return invalid(`Cannot read ${MANIFEST_FILE}: ${messageOf(error)}`);
  }
  const plugin = { ...checkManifest(value, "development", fallback), directory: root };
  const runtime = plugin.manifest?.runtime;
  if (plugin.problems.length || !runtime || runtime.kind === "builtin") return plugin;
  try {
    const entry = await realpath(path.resolve(root, runtime.entry));
    const relative = path.relative(root, entry);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
      return {
        ...plugin,
        problems: [
          problem("PLUGIN_E_ENTRY", `${runtime.entry} resolves outside the plugin folder.`),
        ],
      };
    return { ...plugin, entry };
  } catch {
    return {
      ...plugin,
      problems: [problem("PLUGIN_E_ENTRY", `Entry file ${runtime.entry} was not found.`)],
    };
  }
}

/** Reads one source. Built-in manifests are bundled, so an invalid one is a build error. */
export async function readSource(
  source: PluginSource,
  options: { safeMode: boolean; timeoutMs?: number },
): Promise<ReadPlugin> {
  if (source.kind === "builtin") {
    const plugin = checkManifest(source.manifest, "builtin", "builtin");
    if (plugin.problems.length)
      throw new Error(
        `Invalid built-in plugin manifest: ${plugin.problems.map((item) => item.message).join("; ")}`,
      );
    return { ...plugin, sourceKey: `builtin:${plugin.id}` };
  }
  const directory = path.resolve(source.directory);
  const sourceKey = developmentSourceKey(directory);
  const placeholder = {
    sourceKey,
    id: path.basename(directory),
    source: "development" as const,
    directory,
  };
  // Recovery: safe mode never touches third-party folders, so a hung disk cannot block it.
  if (options.safeMode) return { ...placeholder, problems: [], unread: true };
  const timeoutMs = options.timeoutMs ?? SOURCE_READ_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<SourceRead>((resolve) => {
    timer = setTimeout(
      () =>
        resolve({
          ...placeholder,
          problems: [
            problem(
              "PLUGIN_E_SOURCE_TIMEOUT",
              `Reading ${MANIFEST_FILE} did not finish within ${timeoutMs} ms.`,
            ),
          ],
        }),
      timeoutMs,
    );
  });
  try {
    return { ...(await Promise.race([readDevelopmentPlugin(directory), timedOut])), sourceKey };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Decides every status within the whole set, in source order: built-ins come first, so their ids
 * are protected, and an earlier source keeps an id or command over a later one. `disabled` holds
 * source keys; built-ins cannot be disabled.
 */
export function resolvePlugins(
  read: readonly ReadPlugin[],
  options: { disabled: ReadonlySet<string>; safeMode: boolean },
): RegisteredPlugin[] {
  const resolved = read.map((plugin): RegisteredPlugin => ({
    ...plugin,
    problems: [...plugin.problems],
    status: plugin.problems.length ? "invalid" : "enabled",
  }));
  const seen = new Set<string>();
  // Namespaces nest ("acme.hello." also covers "acme.hello.extra."), so command ids can collide
  // across plugins. Disabled plugins are checked too, so re-enabling one can never collide.
  const commandOwners = new Map<string, string>();
  for (const plugin of resolved) {
    if (plugin.unread) {
      Object.assign(
        plugin,
        options.disabled.has(plugin.sourceKey)
          ? { status: "disabled", disabledBy: "user" }
          : { status: "disabled", disabledBy: "safe-mode" },
      );
      continue;
    }
    if (plugin.status === "invalid") continue;
    if (seen.has(plugin.id)) {
      plugin.status = "invalid";
      plugin.problems.push(
        problem("PLUGIN_E_DUPLICATE_ID", `Another plugin already uses the id ${plugin.id}.`),
      );
      continue;
    }
    const commands = (plugin.manifest?.contributes?.commands ?? []).map((command) => command.id);
    const taken = commands.filter((id) => commandOwners.has(id));
    if (taken.length) {
      plugin.status = "invalid";
      for (const id of taken)
        plugin.problems.push(
          problem(
            "PLUGIN_E_DUPLICATE_COMMAND",
            `${id} is already contributed by ${commandOwners.get(id)}.`,
          ),
        );
      continue;
    }
    seen.add(plugin.id);
    for (const id of commands) commandOwners.set(id, plugin.id);
    if (plugin.source !== "development") continue;
    // Recovery: this decision happens before any contribution is registered or process launched.
    if (options.disabled.has(plugin.sourceKey))
      Object.assign(plugin, { status: "disabled", disabledBy: "user" });
    else if (options.safeMode)
      Object.assign(plugin, { status: "disabled", disabledBy: "safe-mode" });
  }
  markProviderConflicts(resolved);
  return resolved;
}

/** Reads every source in parallel, so one slow folder costs at most one timeout, then resolves. */
export async function loadPlugins(
  sources: readonly PluginSource[],
  options: { disabled: ReadonlySet<string>; safeMode: boolean; timeoutMs?: number },
): Promise<RegisteredPlugin[]> {
  const read = await Promise.all(sources.map((source) => readSource(source, options)));
  return resolvePlugins(read, options);
}
