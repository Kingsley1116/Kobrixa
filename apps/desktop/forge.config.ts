import { copyNativeDependencies } from "./packaging.js";
import type { ForgeConfig } from "@electron-forge/shared-types";
import { VitePlugin } from "@electron-forge/plugin-vite";
import { readFileSync } from "node:fs";
import path from "node:path";
import { macSigningConfig, windowsVersion } from "./signing.js";

const { version } = JSON.parse(readFileSync(new URL("package.json", import.meta.url), "utf8")) as {
  version: string;
};

const platformIcon = path.resolve(
  "resources/icons",
  process.platform === "darwin"
    ? "kobrixa.icns"
    : process.platform === "win32"
      ? "kobrixa.ico"
      : "png/512x512.png",
);

const config: ForgeConfig = {
  packagerConfig: {
    name: "Kobrixa",
    executableName: "kobrixa",
    appBundleId: "com.kobrixa.ide",
    appVersion: process.platform === "win32" ? windowsVersion(version) : version.split(/[+-]/)[0]!,
    win32metadata: {
      CompanyName: "Kobrixa contributors",
      ProductName: "Kobrixa",
      FileDescription: "Kobrixa IDE",
      InternalName: "kobrixa",
      OriginalFilename: "kobrixa.exe",
    },
    ...macSigningConfig(),
    icon: platformIcon,
    asar: { unpack: "**/*.node" },
    ignore: (file) =>
      Boolean(file) &&
      ![
        "/.vite",
        "/node_modules/node-addon-api",
        "/node_modules/node-hid",
        "/node_modules/pkg-prebuilds",
        "/node_modules/electron-updater",
      ].some((included) => file.startsWith(included)),
  },
  rebuildConfig: {},
  makers: [],
  hooks: {
    packageAfterCopy: async (_forgeConfig, buildPath, _electronVersion, platform, arch) =>
      copyNativeDependencies(buildPath, platform, arch),
  },
  plugins: [
    new VitePlugin({
      build: [
        { entry: "src/main/index.ts", config: "vite.main.config.ts", target: "main" },
        {
          entry: "src/main/workspace/build-worker.ts",
          config: "vite.build-worker.config.ts",
          target: "main",
        },
        {
          entry: "src/main/language/language-worker.ts",
          config: "vite.language.config.ts",
          target: "main",
        },
        { entry: "src/preload/index.ts", config: "vite.preload.config.ts", target: "preload" },
      ],
      renderer: [{ name: "main_window", config: "vite.renderer.config.ts" }],
    }),
  ],
};

export default config;
