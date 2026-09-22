import type { ForgeConfig } from "@electron-forge/shared-types";
import { VitePlugin } from "@electron-forge/plugin-vite";
import { cp, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const workspaceNodeModules = fileURLToPath(new URL("../../node_modules", import.meta.url));
const platformIcon = path.resolve(
  "resources/icons",
  process.platform === "darwin"
    ? "kobrixa.icns"
    : process.platform === "win32"
      ? "kobrixa.ico"
      : "png/512x512.png",
);

async function copyNativeDependencies(buildPath: string): Promise<void> {
  const destination = path.join(buildPath, "node_modules");
  await mkdir(destination, { recursive: true });
  await Promise.all(
    ["node-addon-api", "node-hid", "pkg-prebuilds"].map((name) =>
      cp(path.join(workspaceNodeModules, name), path.join(destination, name), {
        recursive: true,
      }),
    ),
  );
}

const config: ForgeConfig = {
  packagerConfig: {
    name: "Kobrixa",
    executableName: "kobrixa",
    icon: platformIcon,
    asar: { unpack: "**/*.node" },
    ignore: (file) =>
      Boolean(file) &&
      ![
        "/.vite",
        "/node_modules/node-addon-api",
        "/node_modules/node-hid",
        "/node_modules/pkg-prebuilds",
      ].some((included) => file.startsWith(included)),
  },
  rebuildConfig: {},
  makers: [],
  hooks: {
    packageAfterCopy: async (_forgeConfig, buildPath) => copyNativeDependencies(buildPath),
  },
  plugins: [
    new VitePlugin({
      build: [
        { entry: "src/main/index.ts", config: "vite.main.config.ts", target: "main" },
        { entry: "src/preload/index.ts", config: "vite.preload.config.ts", target: "preload" },
      ],
      renderer: [{ name: "main_window", config: "vite.renderer.config.ts" }],
    }),
  ],
};

export default config;
