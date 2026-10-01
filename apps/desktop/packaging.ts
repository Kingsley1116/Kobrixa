import { cp, mkdir, readdir, rm, copyFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
const workspaceNodeModules = fileURLToPath(new URL("../../node_modules", import.meta.url));
export async function copyNativeDependencies(
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
