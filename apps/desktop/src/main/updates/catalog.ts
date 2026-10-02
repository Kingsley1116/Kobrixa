import semver from "semver";
import { z } from "zod";
import {
  RELEASE_REPOSITORY,
  RELEASES_URL,
  updateArtifactName,
  updateMetadataName,
} from "../../shared/updates.js";
import type { UpdatePreferences } from "../../shared/updates.js";

const releaseSchema = z.object({
  tag_name: z.string(),
  draft: z.boolean(),
  prerelease: z.boolean(),
  assets: z.array(
    z.object({ name: z.string(), size: z.number().nonnegative(), state: z.string() }),
  ),
});
export type PublishedRelease = z.infer<typeof releaseSchema>;
export interface ReleaseSelection {
  version: string;
  tag: string;
  automatic: boolean;
  url: string;
  feed: string;
}
export function selectRelease(
  releases: PublishedRelease[],
  current: string,
  preferences: UpdatePreferences,
  platform: string,
  arch: string,
): ReleaseSelection | undefined {
  const candidates = releases
    .filter((release) => {
      const version = release.tag_name.replace(/^v/, "");
      return (
        !release.draft &&
        semver.valid(version) &&
        semver.gt(version, current) &&
        (preferences.channel === "preview" || (!release.prerelease && !semver.prerelease(version)))
      );
    })
    .sort((a, b) => semver.rcompare(a.tag_name.replace(/^v/, ""), b.tag_name.replace(/^v/, "")));
  for (const release of candidates) {
    const version = release.tag_name.replace(/^v/, "");
    const names = new Set(
      release.assets
        .filter((asset) => asset.state === "uploaded" && asset.size > 0)
        .map((asset) => asset.name),
    );
    const automatic =
      names.has(updateMetadataName(platform)) &&
      names.has(updateArtifactName(version, platform, arch));
    const archive = `Kobrixa-${version}-${platform}-${arch}.${platform === "linux" ? "tar.gz" : "zip"}`;
    const manualInstaller = `Kobrixa-${version}-darwin-${arch}.dmg`;
    if (!automatic && !names.has(archive) && !(platform === "darwin" && names.has(manualInstaller)))
      continue;
    const tag = encodeURIComponent(release.tag_name);
    return {
      version,
      tag: release.tag_name,
      automatic,
      url: `${RELEASES_URL}/tag/${tag}`,
      feed: `https://github.com/${RELEASE_REPOSITORY}/releases/download/${tag}/`,
    };
  }
  return undefined;
}
export async function fetchReleases(
  signal: AbortSignal,
  request: typeof fetch = fetch,
): Promise<PublishedRelease[]> {
  const releases: PublishedRelease[] = [];
  // Follow every public page; do not assume publication order is SemVer order.
  for (let page = 1; ; page++) {
    const response = await request(
      `https://api.github.com/repos/${RELEASE_REPOSITORY}/releases?per_page=100&page=${page}`,
      {
        signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
        headers: { Accept: "application/vnd.github+json", "User-Agent": "Kobrixa-Updater" },
      },
    );
    if (response.status === 404) throw new Error("source-unavailable");
    if (response.status === 403 || response.status === 429) throw new Error("rate-limited");
    if (!response.ok) throw new Error("network");
    const batch = z.array(releaseSchema).parse(await response.json());
    releases.push(...batch);
    if (batch.length < 100) return releases;
  }
}

export function validateUpdateInfo(
  value: unknown,
  release: ReleaseSelection,
  platform: string,
  arch: string,
): void {
  const name = updateArtifactName(release.version, platform, arch);
  const checksum = z.string().regex(/^[A-Za-z0-9+/]{86}==$/);
  const metadata = z
    .object({
      version: z.literal(release.version),
      files: z
        .array(
          z
            .object({ url: z.literal(name), sha512: checksum, size: z.number().int().positive() })
            .strict(),
        )
        .length(1),
      path: z.literal(name),
      sha512: checksum,
    })
    .strict()
    .parse(value);
  if (metadata.sha512 !== metadata.files[0]!.sha512) throw new Error("invalid-metadata");
}
