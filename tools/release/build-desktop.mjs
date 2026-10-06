import { build as viteBuild, loadConfigFromFile, mergeConfig } from "vite";
import { build as packageElectron } from "electron-builder";
import { builtinModules, createRequire } from "node:module";
import { cp, mkdir, readFile, rm, writeFile, readdir } from "node:fs/promises";
import path from "node:path";
import { repositoryRoot, readVersion } from "./common.mjs";
import { copyNativeDependencies } from "../../apps/desktop/packaging.ts";
import { macIdentity, required, signingModes, windowsVersion } from "../../apps/desktop/signing.ts";

const desktop = path.join(repositoryRoot, "apps/desktop");
const version = await readVersion();
const platform = process.platform,
  arch = process.arch;
const release = process.env.KOBRIXA_RELEASE_BUILD === "true";
const modes = release ? signingModes() : { macos: false, windows: false };
const stage = path.join(desktop, "out/stage");
const output = path.join(desktop, "out");
process.chdir(desktop);
await rm(path.join(desktop, ".vite"), { recursive: true, force: true });
const external = [
  "electron",
  "electron/main",
  "electron/renderer",
  "node-hid",
  "electron-updater",
  ...builtinModules.flatMap((name) => [name, `node:${name}`]),
];
for (const [config, entry, name] of [
  ["vite.main.config.ts", "src/main/index.ts", "main.cjs"],
  ["vite.language.config.ts", "src/main/language/language-worker.ts", "language-worker.cjs"],
  ["vite.build-worker.config.ts", "src/main/workspace/build-worker.ts", "build-worker.cjs"],
  ["vite.preload.config.ts", "src/preload/index.ts", "preload.cjs"],
]) {
  const user = await loadConfigFromFile(
    { command: "build", mode: "production" },
    path.join(desktop, config),
  );
  await viteBuild(
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
          outDir: ".vite/build",
          minify: true,
          lib: { entry, formats: ["cjs"] },
          rollupOptions: { external, output: { entryFileNames: name, inlineDynamicImports: true } },
        },
      },
      user.config,
    ),
  );
}
await viteBuild({
  configFile: path.join(desktop, "vite.renderer.config.ts"),
  root: desktop,
  base: "./",
  build: { outDir: ".vite/renderer/main_window" },
});
await rm(stage, { recursive: true, force: true });
await mkdir(stage, { recursive: true });
await cp(path.join(desktop, ".vite"), path.join(stage, ".vite"), { recursive: true });
await copyNativeDependencies(stage, platform, arch);
// Stage a standalone app: workspace packages are bundled, only actual runtime dependencies remain.
const dependencyVersions = new Map();
const notices = [];
async function copyDependency(name, from = desktop) {
  const resolve = createRequire(path.join(from, "package.json"));
  const manifest = resolve.resolve(`${name}/package.json`);
  const source = path.dirname(manifest);
  const metadata = JSON.parse(await readFile(manifest, "utf8"));
  if (dependencyVersions.has(name)) {
    if (dependencyVersions.get(name) !== metadata.version)
      throw new Error(`Conflicting runtime dependency: ${name}`);
    return;
  }
  dependencyVersions.set(name, metadata.version);
  await cp(source, path.join(stage, "node_modules", name), {
    recursive: true,
    filter: (entry) => !path.relative(source, entry).split(path.sep).includes("node_modules"),
  });
  const license = (await readdir(source)).find((file) =>
    /^(license|licence|copying)(\.|$)/i.test(file),
  );
  if (license)
    notices.push(
      `${name} ${metadata.version}\n${await readFile(path.join(source, license), "utf8")}`,
    );
  for (const child of Object.keys(metadata.dependencies ?? {})) await copyDependency(child, source);
}
await copyDependency("electron-updater");
const licensePath = path.join(stage, "THIRD-PARTY-NOTICES.txt");
await writeFile(
  licensePath,
  `${await readFile(licensePath, "utf8")}\n${notices.join("\n\n--------------------\n\n")}`,
);
await writeFile(
  path.join(stage, "package.json"),
  JSON.stringify(
    {
      name: "@kobrixa/desktop",
      version,
      main: ".vite/build/main.cjs",
      description: "Kobrixa IDE",
      author: "Kobrixa contributors",
      license: "Apache-2.0",
      dependencies: {
        "node-hid": JSON.parse(
          await readFile(path.join(stage, "node_modules/node-hid/package.json"), "utf8"),
        ).version,
        "electron-updater": dependencyVersions.get("electron-updater"),
      },
    },
    null,
    2,
  ),
);
const resources = path.join(output, "update-config");
await mkdir(resources, { recursive: true });
await writeFile(
  path.join(resources, "kobrixa-update.json"),
  JSON.stringify({ signedMac: modes.macos }),
);
const publish = {
  provider: "generic",
  url: "https://github.com/Kingsley1116/Kobrixa/releases/download/",
  channel: "latest",
};
// Dir-only packaging does not always emit updater config. Installers consume this exact signed resource.
const updaterConfiguration = {
  ...publish,
  updaterCacheDirName: "kobrixa-updater",
  ...(modes.windows
    ? { publisherName: required(process.env, "SIGNPATH_CERTIFICATE_SUBJECT") }
    : {}),
};
await writeFile(path.join(resources, "app-update.yml"), JSON.stringify(updaterConfiguration));
const signMac = platform === "darwin" && modes.macos;
const identity = signMac
  ? macIdentity(process.env).identity.replace(/^Developer ID Application: /, "")
  : "-"; // Apple Silicon needs a valid ad-hoc signature even without Developer ID.
if (signMac) {
  process.env.CSC_KEYCHAIN = required(process.env, "MACOS_KEYCHAIN_PATH");
  required(process.env, "APPLE_ID");
  required(process.env, "APPLE_APP_SPECIFIC_PASSWORD");
}
await packageElectron({
  publish: "never",
  config: {
    publish: null, // Preserve the fixed updater resource; metadata is generated after signing.
    appId: "com.kobrixa.ide",
    productName: "Kobrixa",
    executableName: "kobrixa",
    forceCodeSigning: signMac,
    directories: {
      app: stage,
      output: path.join(output, "builder"),
      buildResources: path.join(desktop, "resources"),
    },
    electronVersion: JSON.parse(
      await readFile(createRequire(import.meta.url).resolve("electron/package.json"), "utf8"),
    ).version,
    // The staging tree already contains the complete, target-filtered runtime graph.
    // Returning false also disables builder's workspace dependency collector.
    beforeBuild: async () => false,
    nodeGypRebuild: false,
    asar: { smartUnpack: false },
    asarUnpack: ["**/*.node"],
    files: [
      "**/*",
      { from: path.join(stage, "node_modules"), to: "node_modules", filter: ["**/*"] },
    ],
    extraResources: ["kobrixa-update.json", "app-update.yml"].map((name) => ({
      from: path.join(resources, name),
      to: name,
    })),
    mac: {
      target: "dir",
      icon: path.join(desktop, "resources/icons/kobrixa.icns"),
      identity,
      hardenedRuntime: signMac,
      entitlements: path.join(desktop, "resources/entitlements.plist"),
      entitlementsInherit: path.join(desktop, "resources/entitlements.plist"),
      notarize: signMac ? { teamId: process.env.APPLE_TEAM_ID } : false,
    },
    win: {
      target: "dir",
      icon: path.join(desktop, "resources/icons/kobrixa.ico"),
      signAndEditExecutable: true,
      signtoolOptions: { sign: async () => {} },
    },
    linux: {
      target: "dir",
      icon: path.join(desktop, "resources/icons/png"),
      category: "Development",
    },
    buildVersion: platform === "win32" ? windowsVersion(version) : version.split(/[+-]/)[0],
  },
});
const nativeOutput = path.join(
  output,
  "builder",
  platform === "darwin"
    ? `mac${arch === "arm64" ? "-arm64" : ""}`
    : platform === "win32"
      ? "win-unpacked"
      : "linux-unpacked",
);
const destination = path.join(output, `Kobrixa-${platform}-${arch}`);
await rm(destination, { recursive: true, force: true });
await cp(nativeOutput, destination, { recursive: true, verbatimSymlinks: true });

if (platform === "win32") {
  const { editWindowsResources } = await import("app-builder-lib/out/util/resEdit.js");
  await editWindowsResources({
    file: path.join(destination, "kobrixa.exe"),
    fileVersion: windowsVersion(version),
    productVersion: windowsVersion(version),
    versionStrings: {
      OriginalFilename: "kobrixa.exe",
      InternalName: "kobrixa",
      ProductName: "Kobrixa",
    },
  });
}
