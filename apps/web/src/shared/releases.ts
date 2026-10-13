export const RELEASES_REPO = "Kingsley1116/Kobrixa";
export const RELEASES_URL = `https://github.com/${RELEASES_REPO}/releases`;

export type Platform = "windows" | "macos" | "linux";
export const PLATFORMS: readonly Platform[] = ["windows", "macos", "linux"];
export type ReleaseFile = { name: string; size: number; url: string };
export type PlatformDownloads = { installer: ReleaseFile | null; archive: ReleaseFile | null };
export type LatestRelease = {
  version: string;
  publishedAt: string;
  url: string;
  checksums: ReleaseFile | null;
  platforms: Record<Platform, PlatformDownloads>;
};

// Asset names follow tools/release: Kobrixa-<version>-<os>-<arch>.<ext>. The signed macOS ZIP
// only feeds the updater, so macOS offers the DMG alone.
const patterns: Record<Platform, { installer: RegExp; archive?: RegExp }> = {
  windows: { installer: /-win32-x64-setup\.exe$/, archive: /-win32-x64\.zip$/ },
  macos: { installer: /-darwin-arm64\.dmg$/ },
  linux: { installer: /-linux-x64\.AppImage$/, archive: /-linux-x64\.tar\.gz$/ },
};

type GitHubAsset = { name?: unknown; size?: unknown; browser_download_url?: unknown };
type GitHubRelease = {
  tag_name?: unknown;
  published_at?: unknown;
  html_url?: unknown;
  assets?: unknown;
};

/** Trims a GitHub "latest release" payload to the files the download page offers. */
export function parseRelease(payload: unknown): LatestRelease | null {
  if (!payload || typeof payload !== "object") return null;
  const release = payload as GitHubRelease;
  if (typeof release.tag_name !== "string" || typeof release.html_url !== "string") return null;
  const files = (Array.isArray(release.assets) ? (release.assets as GitHubAsset[]) : []).flatMap(
    (asset) =>
      typeof asset?.name === "string" &&
      typeof asset.size === "number" &&
      typeof asset.browser_download_url === "string" &&
      asset.browser_download_url.startsWith(`https://github.com/${RELEASES_REPO}/`)
        ? [{ name: asset.name, size: asset.size, url: asset.browser_download_url }]
        : [],
  );
  const find = (pattern?: RegExp) =>
    (pattern && files.find((file) => pattern.test(file.name))) ?? null;
  const platforms = Object.fromEntries(
    PLATFORMS.map((platform) => [
      platform,
      { installer: find(patterns[platform].installer), archive: find(patterns[platform].archive) },
    ]),
  ) as Record<Platform, PlatformDownloads>;
  return {
    version: release.tag_name.replace(/^v/, ""),
    publishedAt: typeof release.published_at === "string" ? release.published_at : "",
    url: release.html_url,
    checksums: find(/^SHA256SUMS\.txt$/),
    platforms,
  };
}

/** Best guess at the visitor's desktop OS; null for phones, tablets and unknown systems. */
export function detectPlatform(
  userAgent: string,
  platformHint = "",
  touchPoints = 0,
): Platform | null {
  const ua = `${platformHint} ${userAgent}`;
  if (/Android|iPhone|iPad|iPod|Mobile|CrOS/i.test(ua)) return null;
  if (/Win/i.test(ua)) return "windows";
  // iPadOS reports a Mac user agent; only a touch screen tells it apart.
  if (/Mac/i.test(ua)) return touchPoints > 1 ? null : "macos";
  if (/Linux|X11/i.test(ua)) return "linux";
  return null;
}

export function formatSize(bytes: number) {
  return `${Math.round(bytes / 1024 / 1024)} MB`;
}
