import path from "node:path";
import { fileURLToPath } from "node:url";
import type { UserConfig } from "vite";
import { emitResourceIndex } from "./plugin-resource-index.js";

const desktopRoot = fileURLToPath(new URL(".", import.meta.url));
export function builtinPluginConfig(input: {
  slug: string;
  pluginId: string;
  sourceRoot: string;
  buildRoot?: string;
}): UserConfig {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(input.slug)) throw new Error("Invalid builtin slug.");
  const output = path.join(
    input.buildRoot ?? path.join(desktopRoot, ".vite/build"),
    "plugins",
    input.slug,
  );
  let resolvedOutput = output;
  return {
    // Feature/test roots are not installed workspace packages. Resolve only the
    // public SDK/protocol at build time and bundle them into the shipped leaf.
    resolve: {
      alias: [
        {
          find: /^@kobrixa\/plugin-sdk$/,
          replacement: fileURLToPath(
            new URL("../../packages/plugin-sdk-js/src/index.ts", import.meta.url),
          ),
        },
        {
          find: /^@kobrixa\/plugin-protocol$/,
          replacement: fileURLToPath(
            new URL("../../packages/plugin-protocol/src/index.ts", import.meta.url),
          ),
        },
      ],
    },
    build: {
      outDir: output,
      emptyOutDir: true,
      sourcemap: true,
      target: "node24",
      rollupOptions: {
        input: path.join(input.sourceRoot, "src/main.ts"),
        external: [],
        output: { format: "cjs", entryFileNames: "main.cjs", inlineDynamicImports: true },
      },
    },
    plugins: [
      {
        name: "kobrixa-builtin-resource-index",
        enforce: "post",
        configResolved(config) {
          resolvedOutput = path.resolve(config.root, config.build.outDir);
        },
        async writeBundle() {
          await emitResourceIndex(input.sourceRoot, resolvedOutput, input.pluginId);
        },
      },
    ],
  };
}
