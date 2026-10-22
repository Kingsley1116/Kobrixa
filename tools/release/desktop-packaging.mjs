import path from "node:path";
import { build, runnerImport } from "vite";
import { repositoryRoot } from "./common.mjs";

const desktop = path.join(repositoryRoot, "apps/desktop");
// Load the same TypeScript packaging module as Forge, including its .js-to-.ts
// source imports. Native Node type stripping alone does not resolve those imports.
const { module: packaging } = await runnerImport(path.join(desktop, "packaging.ts"), {
  configFile: false,
});
export const { copyNativeDependencies, validateBuiltinPayloads, BUILTIN_PAYLOAD_UNPACK } =
  packaging;

export async function buildBuiltinPayloads(fixture, buildRoot = path.join(desktop, ".vite/build")) {
  for (const leaf of packaging.builtinProcessBuilds(fixture)) {
    await build({
      root: desktop,
      configFile: path.join(desktop, leaf.config),
      build: { outDir: path.join(buildRoot, "plugins", leaf.slug) },
    });
  }
}
