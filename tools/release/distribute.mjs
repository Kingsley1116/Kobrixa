import { build, Platform } from "electron-builder";
import path from "node:path";
import { readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { repositoryRoot, readVersion } from "./common.mjs";
import { updateArtifactName } from "../../apps/desktop/src/shared/updates.ts";
import { signingModes, windowsVersion } from "../../apps/desktop/signing.ts";
const desktop = path.join(repositoryRoot, "apps/desktop");
const version = await readVersion(),
  platform = process.platform,
  arch = process.arch;
const modes = process.env.KOBRIXA_RELEASE_BUILD === "true" ? signingModes() : { macos: false };
const output = path.join(desktop, "out/installers");
await rm(output, { recursive: true, force: true });
const target =
  platform === "darwin" ? Platform.MAC : platform === "win32" ? Platform.WINDOWS : Platform.LINUX;
await build({
  publish: "never",
  prepackaged: path.join(
    desktop,
    `out/Kobrixa-${platform}-${arch}`,
    ...(platform === "darwin" ? ["Kobrixa.app"] : []),
  ),
  targets: target.createTarget(
    platform === "darwin"
      ? modes.macos
        ? ["dmg", "zip"]
        : ["dmg"]
      : [platform === "win32" ? "nsis" : "AppImage"],
  ),
  config: {
    publish: null, // Never infer a provider from CI tokens or rewrite the signed app's resources.
    appId: "com.kobrixa.ide",
    productName: "Kobrixa",
    executableName: "kobrixa",
    buildVersion: platform === "win32" ? windowsVersion(version) : version.split(/[+-]/)[0],
    directories: {
      app: path.join(desktop, "out/stage"),
      output,
      buildResources: path.join(desktop, "resources"),
    },
    electronVersion: JSON.parse(
      await readFile(createRequire(import.meta.url).resolve("electron/package.json"), "utf8"),
    ).version,
    npmRebuild: false,
    mac: {
      identity: null,
      notarize: false,
      artifactName: updateArtifactName(version, platform, arch),
      icon: path.join(desktop, "resources/icons/kobrixa.icns"),
    },
    dmg: { sign: false, artifactName: `Kobrixa-${version}-${platform}-${arch}.dmg` },
    win: {
      artifactName: updateArtifactName(version, platform, arch),
      icon: path.join(desktop, "resources/icons/kobrixa.ico"),
      signAndEditExecutable: false,
    },
    nsis: {
      oneClick: true,
      perMachine: false,
      allowElevation: false,
      differentialPackage: false,
      deleteAppDataOnUninstall: false,
    },
    linux: {
      artifactName: updateArtifactName(version, platform, arch),
      icon: path.join(desktop, "resources/icons/png"),
      category: "Development",
    },
  },
});
