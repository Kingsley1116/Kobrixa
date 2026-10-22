import {
  copyNativeDependencies,
  BUILTIN_PAYLOAD_UNPACK,
  DELIVERED_BUILTIN_PROCESS_BUILDS,
  validateBuiltinPayloads,
} from "./packaging.js";
const fixtureBuild = process.env.KOBRIXA_PLUGIN_FIXTURE_BUILD === "1";
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
    asar: { unpack: BUILTIN_PAYLOAD_UNPACK },
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
    packageAfterCopy: async (_forgeConfig, buildPath, _electronVersion, platform, arch) => {
      await validateBuiltinPayloads(buildPath, fixtureBuild);
      await copyNativeDependencies(buildPath, platform, arch);
    },
  },
  plugins: [
    new VitePlugin({
      build: [
        ...DELIVERED_BUILTIN_PROCESS_BUILDS.map(({ entry, config, target }) => ({
          entry,
          config,
          target,
        })),
        ...(fixtureBuild
          ? [
              {
                entry: "../../tests/desktop/fixtures/builtin-process/src/main.ts",
                config: "vite.plugin-fixture.config.ts",
                target: "main" as const,
              },
            ]
          : []),
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
