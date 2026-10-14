import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import semver from "semver";
import { z } from "zod";
import {
  PLUGIN_API_VERSION,
  PLUGIN_LIMITS,
  pluginManifestSchema,
  type PluginManifest,
} from "@kobrixa/plugin-protocol";
import { messageOf, type PluginErrorCode, type PluginProblem } from "./errors.js";

export const MANIFEST_FILE = "kobrixa-plugin.json";
export type PluginSource =
  { kind: "builtin"; manifest: unknown } | { kind: "development"; directory: string };
export interface RegisteredPlugin {
  id: string;
  source: "builtin" | "development";
  directory?: string;
  manifest?: PluginManifest;
  entry?: string;
  status: "enabled" | "disabled" | "invalid";
  disabledBy?: "user" | "safe-mode";
  problems: PluginProblem[];
}

const problem = (code: PluginErrorCode, message: string): PluginProblem => ({ code, message });

function semanticProblems(
  manifest: PluginManifest,
  source: RegisteredPlugin["source"],
): PluginProblem[] {
  const problems: PluginProblem[] = [];
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
  if (manifest.contributes?.frontends?.length && !builtinRuntime)
    problems.push(
      problem(
        "PLUGIN_E_FRONTEND_REQUIRES_BUILTIN",
        "Compiler frontends can only be contributed by built-in plugins in this version.",
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
  source: RegisteredPlugin["source"],
  fallbackId: string,
): RegisteredPlugin {
  const parsed = pluginManifestSchema.safeParse(value);
  if (!parsed.success)
    return {
      id: fallbackId,
      source,
      status: "invalid",
      problems: [problem("PLUGIN_E_MANIFEST", z.prettifyError(parsed.error))],
    };
  const problems = semanticProblems(parsed.data, source);
  return {
    id: parsed.data.id,
    source,
    manifest: parsed.data,
    status: problems.length ? "invalid" : "enabled",
    problems,
  };
}

async function readDevelopmentPlugin(directory: string): Promise<RegisteredPlugin> {
  const fallback = path.basename(directory);
  const invalid = (
    message: string,
    code: PluginErrorCode = "PLUGIN_E_MANIFEST",
  ): RegisteredPlugin => ({
    id: fallback,
    source: "development",
    directory,
    status: "invalid",
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
  if (plugin.status === "invalid" || !runtime || runtime.kind === "builtin") return plugin;
  try {
    const entry = await realpath(path.resolve(root, runtime.entry));
    const relative = path.relative(root, entry);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
      return {
        ...plugin,
        status: "invalid",
        problems: [
          problem("PLUGIN_E_ENTRY", `${runtime.entry} resolves outside the plugin folder.`),
        ],
      };
    return { ...plugin, entry };
  } catch {
    return {
      ...plugin,
      status: "invalid",
      problems: [problem("PLUGIN_E_ENTRY", `Entry file ${runtime.entry} was not found.`)],
    };
  }
}

export async function loadPlugins(
  sources: readonly PluginSource[],
  options: { disabled: ReadonlySet<string>; safeMode: boolean },
): Promise<RegisteredPlugin[]> {
  const loaded: RegisteredPlugin[] = [];
  for (const source of sources) {
    if (source.kind === "development") {
      loaded.push(await readDevelopmentPlugin(source.directory));
      continue;
    }
    const plugin = checkManifest(source.manifest, "builtin", "builtin");
    if (plugin.status === "invalid")
      throw new Error(
        `Invalid built-in plugin manifest: ${plugin.problems.map((item) => item.message).join("; ")}`,
      );
    loaded.push(plugin);
  }
  const seen = new Set<string>();
  // Namespaces nest ("acme.hello." also covers "acme.hello.extra."), so command ids can collide
  // across plugins. Disabled plugins are checked too, so re-enabling one can never collide.
  const commandOwners = new Map<string, string>();
  for (const plugin of loaded) {
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
    if (options.disabled.has(plugin.id))
      Object.assign(plugin, { status: "disabled", disabledBy: "user" });
    else if (options.safeMode)
      Object.assign(plugin, { status: "disabled", disabledBy: "safe-mode" });
  }
  return loaded;
}
