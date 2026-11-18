// Test/CLI bootstrap only. Electron entries use the existing bundler, never this hook.
import { registerHooks, createRequire } from "node:module";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const sourceRoot = path.resolve(
  process.env.RF5_SOURCE_ROOT || fileURLToPath(new URL("../..", import.meta.url)),
);
const dependencyRoot = path.resolve(process.env.RF5_DEPS_ROOT || sourceRoot);
const dependencies = createRequire(path.join(dependencyRoot, "package.json"));
const packages = {
  "@kobrixa/plugin-protocol": "packages/plugin-protocol/src/index.ts",
  "@kobrixa/plugin-runtime": "packages/plugin-runtime/src/index.ts",
  "@kobrixa/plugin-sdk": "packages/plugin-sdk-js/src/index.ts",
};
// These are the only external dependencies needed by the persistence source oracles.
const external = new Set(["zod", "typescript", "esbuild", "@eslint-community/regexpp", "semver"]);
const inside = (file) => {
  const relative = path.relative(sourceRoot, file);
  return (
    relative !== "" &&
    !relative.startsWith(`..${path.sep}`) &&
    relative !== ".." &&
    !path.isAbsolute(relative) &&
    !relative.split(path.sep).includes("node_modules")
  );
};
export function resolvePersistenceSource(specifier, context, nextResolve) {
  const parent = context.parentURL?.startsWith("file:") ? fileURLToPath(context.parentURL) : null;
  if (!parent || !inside(parent)) return nextResolve(specifier, context);
  if (Object.hasOwn(packages, specifier)) {
    const file = path.join(sourceRoot, packages[specifier]);
    if (existsSync(file)) return { url: pathToFileURL(file).href, shortCircuit: true };
  }
  if (/^\.{1,2}\//.test(specifier) && specifier.endsWith(".js")) {
    const requested = new URL(specifier, context.parentURL);
    const file = fileURLToPath(requested);
    const knownEntry = Object.values(packages).find(
      (entry) => path.join(sourceRoot, entry.replace("/src/index.ts", "/dist/index.js")) === file,
    );
    const candidate = knownEntry ? path.join(sourceRoot, knownEntry) : file.slice(0, -3) + ".ts";
    // A real JS file wins. Never redirect escapes or dependency internals into TS.
    if (inside(candidate) && !existsSync(file) && existsSync(candidate))
      return { url: pathToFileURL(candidate).href, shortCircuit: true };
  }
  try {
    return nextResolve(specifier, context);
  } catch (error) {
    if (error.code !== "ERR_MODULE_NOT_FOUND" || !external.has(specifier)) throw error;
    return { url: pathToFileURL(dependencies.resolve(specifier)).href, shortCircuit: true };
  }
}
registerHooks({ resolve: resolvePersistenceSource });

// Existing in-memory esbuild unit tests have an independent dependency resolver.
export function persistenceTestNodePaths() {
  const owners = {
    zod: "packages/plugin-protocol/package.json",
    "@eslint-community/regexpp": "packages/plugin-protocol/package.json",
    semver: "apps/desktop/package.json",
  };
  return [
    ...new Set(
      Object.entries(owners).map(([name, manifest]) => {
        let file;
        try {
          file = dependencies.resolve(`${name}/package.json`);
        } catch (error) {
          if (error.code !== "MODULE_NOT_FOUND") throw error;
          file = createRequire(path.join(dependencyRoot, manifest)).resolve(`${name}/package.json`);
        }
        let directory = path.dirname(file);
        for (let remaining = name.split("/").length; remaining > 0; remaining--)
          directory = path.dirname(directory);
        return directory;
      }),
    ),
  ];
}
