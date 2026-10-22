import { cp, mkdir, readdir, rm, copyFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { validateBuiltinLeaf } from "./src/main/plugins/builtin-launch.js";
const workspaceNodeModules = fileURLToPath(new URL("../../node_modules", import.meta.url));
const licenseFile = /^(license|licence|copying)(\.|$)/i;

interface Notice {
  name: string;
  version: string;
  text: string;
}

async function findSourceMaps(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const children = await Promise.all(
    entries.map((entry) => {
      const child = path.join(directory, entry.name);
      if (entry.isDirectory()) return findSourceMaps(child);
      return entry.name.endsWith(".map") ? [child] : [];
    }),
  );
  return children.flat();
}

async function readNotice(packageDirectory: string, license?: string): Promise<Notice> {
  const metadata = JSON.parse(
    await readFile(path.join(packageDirectory, "package.json"), "utf8"),
  ) as { name: string; version: string };
  const file = license ?? (await readdir(packageDirectory)).find((name) => licenseFile.test(name));
  if (!file) throw new Error(`No license file for bundled dependency ${metadata.name}`);
  const text = await readFile(path.join(packageDirectory, file), "utf8");
  return { name: metadata.name, version: metadata.version, text };
}

/**
 * Lists the third-party packages that Vite bundled into the staged `.vite` output.
 * Source map paths are matched from their first node_modules segment, so bundles
 * emitted at different depths (such as Monaco workers) resolve the same way.
 */
export async function collectBundledNotices(
  buildPath: string,
  nodeModules = workspaceNodeModules,
): Promise<Notice[]> {
  const maps = await findSourceMaps(path.join(buildPath, ".vite"));
  if (maps.length === 0) throw new Error("No source maps found; bundled notices cannot be listed");
  const packageDirectories = new Set<string>();
  for (const map of maps) {
    const { sources } = JSON.parse(await readFile(map, "utf8")) as { sources: string[] };
    for (const source of sources) {
      const segments = source.split(/(?:^|[\\/])node_modules[\\/]/).slice(1);
      if (segments.length === 0) continue;
      // Earlier segments are parent directories (nested or .pnpm copies); the last one owns the file.
      const owner = segments.at(-1)!.split(/[\\/]/);
      const name = owner[0]!.startsWith("@") ? owner.slice(0, 2) : owner.slice(0, 1);
      const parents = segments.slice(0, -1).flatMap((parent) => [parent, "node_modules"]);
      packageDirectories.add(path.join(nodeModules, ...parents, ...name));
    }
  }
  const notices = await Promise.all(
    [...packageDirectories].map((directory) => readNotice(directory)),
  );
  return notices.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}

export async function copyNativeDependencies(
  buildPath: string,
  platform: string,
  arch: string,
  desktopPackage = fileURLToPath(new URL("./package.json", import.meta.url)),
): Promise<void> {
  const desktopRequire = createRequire(desktopPackage);
  const hidPackage = desktopRequire.resolve("node-hid/package.json");
  const hidRequire = createRequire(hidPackage);
  // Resolve transitive packages from their consumer; pnpm need not hoist them.
  const nativeDirectories: Record<string, string> = {
    "node-hid": path.dirname(hidPackage),
    "node-addon-api": path.dirname(hidRequire.resolve("node-addon-api/package.json")),
    "pkg-prebuilds": path.dirname(hidRequire.resolve("pkg-prebuilds/package.json")),
  };
  const destination = path.join(buildPath, "node_modules");
  await mkdir(destination, { recursive: true });
  await Promise.all(
    Object.entries(nativeDirectories).map(([name, source]) =>
      cp(source, path.join(destination, name), {
        recursive: true,
        filter: (entry) => !path.relative(source, entry).split(path.sep).includes("node_modules"),
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
  const native = await Promise.all(
    [
      ["node-hid", "LICENSE-bsd.txt"],
      ["node-addon-api", "LICENSE.md"],
      ["pkg-prebuilds", "LICENSE"],
    ].map(([name, license]) => readNotice(nativeDirectories[name!]!, license)),
  );
  const notices = new Map<string, Notice>();
  const bundled = await collectBundledNotices(
    buildPath,
    path.resolve(path.dirname(desktopPackage), "../../node_modules"),
  );
  for (const notice of [...bundled, ...native])
    notices.set(`${notice.name}@${notice.version}`, notice);
  const licenses = [...notices.values()].map(
    ({ name, version, text }) => `${name} ${version}\n\n${text}`,
  );
  await writeFile(
    path.join(buildPath, "THIRD-PARTY-NOTICES.txt"),
    `Kobrixa runtime dependency notices\n\nElectron and Chromium notices are distributed as LICENSE.electron.txt and LICENSES.chromium.html next to the application executable (in Kobrixa.app/Contents/Resources on macOS). Additional HIDAPI licenses are included under node_modules/node-hid/hidapi.\n\n${licenses.join("\n\n--------------------\n\n")}\n`,
  );
}

export const BUILTIN_PAYLOAD_UNPACK = "{**/*.node,**/.vite/build/plugins/**}";
export const DELIVERED_BUILTIN_PROCESS_BUILDS: readonly {
  entry: string;
  config: string;
  target: "main";
  slug: string;
  pluginId: string;
}[] = Object.freeze([]);
export function builtinProcessBuilds(fixture: boolean) {
  // The installed acceptance fixture uses an already allowed identity without
  // registering a product. Never broaden the production launch allowlist for a test,
  // or overwrite a real motor payload once the 3C product is delivered.
  if (fixture && DELIVERED_BUILTIN_PROCESS_BUILDS.some((leaf) => leaf.slug === "motor-test"))
    throw new Error("Installed acceptance fixture conflicts with the delivered motor payload.");
  return [
    ...DELIVERED_BUILTIN_PROCESS_BUILDS,
    ...(fixture
      ? [
          {
            entry: "../../tests/desktop/fixtures/builtin-process/src/main.ts",
            config: "vite.plugin-fixture.config.ts",
            target: "main" as const,
            slug: "motor-test",
            pluginId: "kobrixa.motor-test",
          },
        ]
      : []),
  ];
}
export async function validateBuiltinPayloads(buildPath: string, fixture: boolean): Promise<void> {
  for (const leaf of builtinProcessBuilds(fixture))
    await validateBuiltinLeaf(
      path.join(buildPath, ".vite/build/plugins", leaf.slug),
      leaf.pluginId,
    );
}
