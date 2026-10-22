import { staticLanguageDeclarationProblems } from "@kobrixa/plugin-protocol";
import { readPackagedJson, SourceReadBudget } from "./packaged-json-resource.js";
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import path from "node:path";
import semver from "semver";
import { z } from "zod";
import {
  compilerDeclarationProblems,
  languageServiceDeclarationProblems,
  PLUGIN_API_VERSION,
  PLUGIN_LIMITS,
  pluginManifestSchema,
  type PluginManifest,
} from "@kobrixa/plugin-protocol";
import { markProviderConflicts } from "./compiler-resolution.js";
import type { LoadedDiagnosticHelp } from "./diagnostic-help.js";
import { messageOf, type PluginErrorCode, type PluginProblem } from "./errors.js";

export const MANIFEST_FILE = "kobrixa-plugin.json";
/** Identities Kobrixa itself uses for diagnostics; no plugin may claim them. */
export const RESERVED_PLUGIN_IDS: ReadonlySet<string> = new Set(["kobrixa.core"]);
/** Bound on reading one development folder, so a hung disk cannot block startup or recovery. */
export const SOURCE_READ_TIMEOUT_MS = 5_000;
import type { Stage3BuiltinSource, BuiltinPolicy } from "./builtin-launch.js";

export type PluginSource = Stage3BuiltinSource | { kind: "development"; directory: string };
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
  /** One metadata/resource attempt; never serialized or supplied by a plugin. */
  resourceBudget?: SourceReadBudget;

  sourceKey: string;
  id: string;
  source: "builtin" | "development";
  policy?: BuiltinPolicy;
  directory?: string;
  manifest?: PluginManifest;
  entry?: string;
  /** Loaded help resource; absent when undeclared, unread or invalid. */
  diagnosticHelp?: LoadedDiagnosticHelp;
  /** A broken help resource disables only the help, never the plugin. */
  helpProblem?: PluginProblem;
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

function semanticProblems(
  manifest: PluginManifest,
  source: ReadPlugin["source"],
  allowBuiltinNode = false,
): PluginProblem[] {
  const problems: PluginProblem[] = [];
  if (RESERVED_PLUGIN_IDS.has(manifest.id))
    problems.push(problem("PLUGIN_E_RESERVED_ID", `${manifest.id} is reserved by Kobrixa.`));
  problems.push(
    ...compilerDeclarationProblems(manifest).map((message) =>
      problem("PLUGIN_E_MANIFEST", message),
    ),
  );
  problems.push(
    ...languageServiceDeclarationProblems(manifest).map((message) =>
      problem("PLUGIN_E_MANIFEST", message),
    ),
  );
  if (manifest.contributes?.languageServices !== undefined && source !== "builtin")
    problems.push(
      problem(
        "PLUGIN_E_LANGUAGE_SERVICE_REQUIRES_BUILTIN",
        "Language services can only be contributed by built-in plugins in this version.",
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
  if (
    builtinRuntime !== (source === "builtin") &&
    !(source === "builtin" && allowBuiltinNode && manifest.runtime.kind === "node")
  )
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
    if (event.startsWith("onCommand:") && !commands.includes(event.slice("onCommand:".length)))
      problems.push(
        problem(
          "PLUGIN_E_ACTIVATION",
          `${event} does not refer to a command contributed by this plugin.`,
        ),
      );
  const sourceRejected = problems.some((item) =>
    [
      "PLUGIN_E_LANGUAGE_SERVICE_REQUIRES_BUILTIN",
      "PLUGIN_E_FRONTEND_REQUIRES_BUILTIN",
      "PLUGIN_E_BACKEND_REQUIRES_BUILTIN",
      "PLUGIN_E_RUNTIME_NOT_ALLOWED",
    ].includes(item.code),
  );
  if (
    !sourceRejected &&
    (manifest.runtime.kind === "static" || manifest.contributes?.languages !== undefined)
  )
    problems.push(
      ...staticLanguageDeclarationProblems(manifest).map((message) =>
        problem("PLUGIN_E_MANIFEST", `${manifest.id}: ${message}`),
      ),
    );
  return problems;
}

function checkManifest(
  value: unknown,
  source: ReadPlugin["source"],
  fallbackId: string,
  allowBuiltinNode = false,
): SourceRead {
  if (source !== "builtin" && value && typeof value === "object" && "contributes" in value) {
    const contributes = value.contributes;
    if (
      contributes &&
      typeof contributes === "object" &&
      Object.hasOwn(contributes, "deviceProviders")
    )
      return {
        id: fallbackId,
        source,
        problems: [
          problem(
            "PLUGIN_E_DEVICE_PROVIDER_REQUIRES_BUILTIN",
            "Device providers can only be contributed by host-allowlisted built-in sources.",
          ),
        ],
      };
    if (
      contributes &&
      typeof contributes === "object" &&
      Object.hasOwn(contributes, "languageServices")
    )
      return {
        id: fallbackId,
        source,
        problems: [
          problem(
            "PLUGIN_E_LANGUAGE_SERVICE_REQUIRES_BUILTIN",
            "Language services can only be contributed by built-in plugins in this version.",
          ),
        ],
      };
  }
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
    problems: semanticProblems(parsed.data, source, allowBuiltinNode),
  };
}

async function readDevelopmentPlugin(
  directory: string,
  budget: SourceReadBudget,
): Promise<SourceRead> {
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
    budget.check();
    value = (await readPackagedJson(root, MANIFEST_FILE, PLUGIN_LIMITS.manifestBytes, budget))
      .value;
  } catch (error) {
    return invalid(`Cannot read ${MANIFEST_FILE}: ${messageOf(error)}`);
  }
  const plugin = { ...checkManifest(value, "development", fallback), directory: root };
  const runtime = plugin.manifest?.runtime;
  if (plugin.problems.length || !runtime || runtime.kind === "builtin" || runtime.kind === "static")
    return plugin;
  try {
    const entry = await realpath(path.resolve(root, runtime.entry));
    budget.check();
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

export async function readSource(
  source: PluginSource,
  options: { safeMode: boolean; timeoutMs?: number },
): Promise<ReadPlugin> {
  const resourceBudget = new SourceReadBudget(options.timeoutMs ?? SOURCE_READ_TIMEOUT_MS);
  if (source.kind === "builtin") {
    const launch = source.launch;
    const allowNode = source.policy === "optional" && launch !== undefined;
    const plugin = await resourceBudget.run(async () =>
      checkManifest(source.manifest, "builtin", "builtin", allowNode),
    );
    const sourceKey = `builtin:${launch?.pluginId ?? plugin.id}`;
    const invalid = (message: string): ReadPlugin => ({
      ...plugin,
      sourceKey,
      resourceBudget,
      policy: source.policy,
      problems: [...plugin.problems, problem("PLUGIN_E_ENTRY", message)],
    });
    if (source.policy !== "required" && source.policy !== "optional")
      return {
        ...invalid("Builtin policy was not supplied by the host."),
        problems: [
          problem("PLUGIN_E_MANIFEST", "Built-in sources require an explicit host policy."),
        ],
      };
    if (plugin.problems.length) {
      if (source.policy === "required")
        throw new Error(
          `Invalid built-in plugin manifest: ${plugin.problems.map((item) => item.message).join("; ")}`,
        );
      return { ...plugin, sourceKey, resourceBudget, policy: source.policy };
    }
    const manifest = plugin.manifest!;
    if (
      launch &&
      (source.policy !== "optional" ||
        launch.policy !== "optional" ||
        launch.pluginId !== manifest.id ||
        launch.sourceKey !== sourceKey ||
        manifest.runtime.kind !== "node" ||
        manifest.runtime.entry !== "main.cjs" ||
        launch.runtime !== "node" ||
        launch.entry !== "main.cjs" ||
        launch.manifest !== "kobrixa-plugin.json" ||
        launch.resourceIndex !== "resource-index.json" ||
        !path.isAbsolute(launch.packageRoot))
    )
      return invalid("Invalid shipped plugin launch descriptor.");
    if (manifest.runtime.kind === "node" && !launch)
      return invalid("Shipped Node execution requires a validated descriptor.");
    return {
      ...plugin,
      sourceKey,
      resourceBudget,
      policy: source.policy,
      ...(launch
        ? { directory: launch.packageRoot, entry: path.join(launch.packageRoot, launch.entry) }
        : {}),
    };
  }

  const directory = path.resolve(source.directory);
  const placeholder = {
    sourceKey: developmentSourceKey(directory),
    id: path.basename(directory),
    source: "development" as const,
    directory,
  };
  if (options.safeMode) return { ...placeholder, problems: [], unread: true };
  try {
    const read = await resourceBudget.run(() => readDevelopmentPlugin(directory, resourceBudget));
    return { ...read, sourceKey: placeholder.sourceKey, resourceBudget };
  } catch {
    return {
      ...placeholder,
      problems: [
        problem(
          "PLUGIN_E_SOURCE_TIMEOUT",
          `Reading ${MANIFEST_FILE} did not finish within ${options.timeoutMs ?? SOURCE_READ_TIMEOUT_MS} ms.`,
        ),
      ],
    };
  }
}

/**
 * Decides every status within the whole set, reserving valid built-in ids before source order
 * decides other id and command conflicts. `disabled` holds source keys; built-ins cannot be
 * disabled.
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
  const seen = new Set<string>(
    resolved
      .filter((plugin) => plugin.source === "builtin" && plugin.status !== "invalid")
      .map((plugin) => plugin.id),
  );
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
    if (plugin.source !== "builtin" && seen.has(plugin.id)) {
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
    if (plugin.source !== "builtin") seen.add(plugin.id);
    for (const id of commands) commandOwners.set(id, plugin.id);
    if (plugin.source === "builtin" && plugin.policy !== "optional") continue;
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

export function sourcePolicy(source: PluginSource): { required: boolean; canToggle: boolean } {
  const required = source.kind === "builtin" && source.policy === "required";
  return { required, canToggle: !required };
}
