import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
export const targets = [
  { platform: "linux", arch: "x64" },
  { platform: "win32", arch: "x64" },
  { platform: "darwin", arch: "arm64" },
];

export function parseVersion(version) {
  const identifier = "(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)";
  const match = new RegExp(
    `^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)(?:-(${identifier}(?:\\.${identifier})*))?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`,
  ).exec(version);
  if (!match) throw new Error(`Invalid SemVer: ${version}`);
  return { version, prerelease: Boolean(match[4]) };
}

export function archiveName(version, platform, arch) {
  parseVersion(version);
  if (!targets.some((target) => target.platform === platform && target.arch === arch)) {
    throw new Error(`Unsupported target: ${platform}-${arch}`);
  }
  return `Kobrixa-${version}-${platform}-${arch}.${platform === "linux" ? "tar.gz" : "zip"}`;
}

export function expectedAssets(version) {
  return targets.flatMap(({ platform, arch }) => {
    const name = archiveName(version, platform, arch);
    return [name, `${name}.sha256`];
  });
}

export async function readVersion(root = repositoryRoot) {
  return JSON.parse(await readFile(path.join(root, "package.json"), "utf8")).version;
}

export async function validateVersions(tag, root = repositoryRoot) {
  if (!tag?.startsWith("v")) throw new Error("Release tags must start with v");
  const info = parseVersion(tag.slice(1));
  const manifests = ["package.json"];
  // These are the three workspace globs in pnpm-workspace.yaml.
  for (const group of ["apps", "packages", "frontends"]) {
    for (const entry of await readdir(path.join(root, group), { withFileTypes: true })) {
      if (entry.isDirectory()) {
        const manifest = path.join(group, entry.name, "package.json");
        try {
          await readFile(path.join(root, manifest));
          manifests.push(manifest);
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
      }
    }
  }
  for (const manifest of manifests) {
    const { version } = JSON.parse(await readFile(path.join(root, manifest), "utf8"));
    if (version !== info.version) throw new Error(`${manifest}: ${version} does not match ${tag}`);
  }
  return info;
}

export async function sha256(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

export async function verifyChecksum(file) {
  const expected = `${await sha256(file)}  ${path.basename(file)}\n`;
  if ((await readFile(`${file}.sha256`, "utf8")) !== expected) {
    throw new Error(`Checksum mismatch: ${path.basename(file)}`);
  }
}

export function isMain(meta) {
  return Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(meta.url);
}
