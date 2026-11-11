import path from "node:path";
import { builtinModules } from "node:module";
import { build, loadConfigFromFile, mergeConfig, runnerImport } from "vite";
import { repositoryRoot } from "./common.mjs";

const desktop = path.join(repositoryRoot, "apps/desktop");
// Load the same TypeScript packaging module as Forge, including its .js-to-.ts
// source imports. Native Node type stripping alone does not resolve those imports.
const { module: packaging } = await runnerImport(path.join(desktop, "packaging.ts"), {
  configFile: false,
});
export const {
  copyNativeDependencies,
  validateBuiltinPayloads,
  BUILTIN_PAYLOAD_UNPACK,
  PERSISTENCE_WORKER_ENTRY,
  withPersistenceWorkerUnpack,
} = packaging;

export async function buildBuiltinPayloads(fixture, buildRoot = path.join(desktop, ".vite/build")) {
  for (const leaf of packaging.builtinProcessBuilds(fixture)) {
    await build({
      root: desktop,
      configFile: path.join(desktop, leaf.config),
      build: { outDir: path.join(buildRoot, "plugins", leaf.slug) },
    });
  }
}

// Shared by release packaging and native harnesses so worker entry footers and
// dependency resolution stay identical to the product build.
const external = [
  "electron",
  "electron/main",
  "electron/renderer",
  "node-hid",
  "electron-updater",
  ...builtinModules.flatMap((name) => [name, `node:${name}`]),
];
export async function buildDesktopEntry(
  config,
  entry,
  name,
  buildRoot = path.join(desktop, ".vite/build"),
) {
  const user = await loadConfigFromFile(
    { command: "build", mode: "production", forgeConfigSelf: { entry } },
    path.join(desktop, config),
  );
  await build(
    mergeConfig(
      {
        configFile: false,
        root: desktop,
        mode: "production",
        define: {
          MAIN_WINDOW_VITE_DEV_SERVER_URL: "undefined",
          MAIN_WINDOW_VITE_NAME: JSON.stringify("main_window"),
        },
        resolve: { conditions: ["node"], mainFields: ["module", "jsnext:main", "jsnext"] },
        build: {
          emptyOutDir: false,
          outDir: buildRoot,
          minify: true,
          lib: { entry, formats: ["cjs"] },
          rollupOptions: { external, output: { entryFileNames: name, inlineDynamicImports: true } },
        },
      },
      user.config,
    ),
  );
}
