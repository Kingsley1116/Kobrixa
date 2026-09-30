import type { ForgeConfig } from "@electron-forge/shared-types";
import { VitePlugin } from "@electron-forge/plugin-vite";
import { cp, mkdir, readdir, rm, copyFile, readFile, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { macSigningConfig, windowsVersion } from "./signing.js";

const { version } = JSON.parse(readFileSync(new URL("package.json", import.meta.url), "utf8")) as {
  version: string;
};

const workspaceNodeModules = fileURLToPath(new URL("../../node_modules", import.meta.url));
const platformIcon = path.resolve(
  "resources/icons",
  process.platform === "darwin"
    ? "kobrixa.icns"
    : process.platform === "win32"
      ? "kobrixa.ico"
      : "png/512x512.png",
);

async function copyNativeDependencies(
  buildPath: string,
  platform: string,
  arch: string,
): Promise<void> {
  const destination = path.join(buildPath, "node_modules");
  await mkdir(destination, { recursive: true });
  await Promise.all(
    ["node-addon-api", "node-hid", "pkg-prebuilds"].map((name) =>
      cp(path.join(workspaceNodeModules, name), path.join(destination, name), {
        recursive: true,
      }),
    ),
  );
  // node-hid ships binaries for every OS. Keep only the target's prebuilds so
  // macOS signing/notarization does not process foreign native executables.
  const prebuilds = path.join(destination, "node-hid/prebuilds");
  for (const entry of await readdir(prebuilds)) {
    if (!entry.endsWith(`-${platform}-${arch}`))
      await rm(path.join(prebuilds, entry), { recursive: true, force: true });
  }
  await copyFile(
    fileURLToPath(new URL("../../LICENSE", import.meta.url)),
    path.join(buildPath, "LICENSE"),
  );
  const licenses = await Promise.all(
    [
      ["react", "LICENSE"],
      ["react-dom", "LICENSE"],
      ["scheduler", "LICENSE"],
      ["monaco-editor", "LICENSE"],
      ["zod", "LICENSE"],
      ["node-hid", "LICENSE-bsd.txt"],
      ["node-addon-api", "LICENSE.md"],
      ["pkg-prebuilds", "LICENSE"],
    ].map(async ([name, license]) => {
      const packageDirectory = path.join(workspaceNodeModules, name!);
      const metadata = JSON.parse(
        await readFile(path.join(packageDirectory, "package.json"), "utf8"),
      ) as { version: string };
      return `${name} ${metadata.version}\n\n${await readFile(path.join(packageDirectory, license!), "utf8")}`;
    }),
  );
  await writeFile(
    path.join(buildPath, "THIRD-PARTY-NOTICES.txt"),
    `Kobrixa runtime dependency notices\n\nElectron and Chromium notices accompany the application distribution. Additional HIDAPI licenses are included under node_modules/node-hid/hidapi.\n\n${licenses.join("\n\n--------------------\n\n")}\n`,
  );
}

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
        { entry: "src/main/language-worker.ts", config: "vite.language.config.ts", target: "main" },
        { entry: "src/preload/index.ts", config: "vite.preload.config.ts", target: "preload" },
      ],
      renderer: [{ name: "main_window", config: "vite.renderer.config.ts" }],
    }),
  ],
};

export default config;
