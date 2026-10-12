import { describe, expect, it } from "vitest";
import { detectPlatform, formatSize, parseRelease } from "./releases.js";

const base = "https://github.com/Kingsley1116/Kobrixa/releases/download/v1.0.0/";
const asset = (name: string, size = 100 * 1024 * 1024) => ({
  name,
  size,
  browser_download_url: base + name,
});

describe("parseRelease", () => {
  it("maps release assets to platform downloads", () => {
    const release = parseRelease({
      tag_name: "v1.0.0",
      published_at: "2026-10-12T12:20:53Z",
      html_url: "https://github.com/Kingsley1116/Kobrixa/releases/tag/v1.0.0",
      assets: [
        asset("Kobrixa-1.0.0-darwin-arm64.dmg"),
        asset("Kobrixa-1.0.0-linux-x64.AppImage"),
        asset("Kobrixa-1.0.0-linux-x64.tar.gz"),
        asset("Kobrixa-1.0.0-win32-x64-setup.exe"),
        asset("Kobrixa-1.0.0-win32-x64.zip"),
        asset("latest.yml", 387),
        asset("SHA256SUMS.txt", 487),
      ],
    });
    expect(release?.version).toBe("1.0.0");
    expect(release?.platforms.windows.installer?.name).toBe("Kobrixa-1.0.0-win32-x64-setup.exe");
    expect(release?.platforms.windows.archive?.name).toBe("Kobrixa-1.0.0-win32-x64.zip");
    expect(release?.platforms.macos.installer?.url).toBe(base + "Kobrixa-1.0.0-darwin-arm64.dmg");
    expect(release?.platforms.macos.archive).toBeNull();
    expect(release?.platforms.linux.archive?.name).toBe("Kobrixa-1.0.0-linux-x64.tar.gz");
    expect(release?.checksums?.name).toBe("SHA256SUMS.txt");
  });

  it("rejects malformed payloads and foreign download hosts", () => {
    expect(parseRelease(null)).toBeNull();
    expect(parseRelease({ message: "Not Found" })).toBeNull();
    const release = parseRelease({
      tag_name: "v1.0.0",
      html_url: "https://github.com/Kingsley1116/Kobrixa/releases/tag/v1.0.0",
      assets: [
        {
          name: "Kobrixa-1.0.0-win32-x64-setup.exe",
          size: 1,
          browser_download_url: "https://evil.example/x.exe",
        },
      ],
    });
    expect(release?.platforms.windows.installer).toBeNull();
  });
});

describe("detectPlatform", () => {
  it("recognises desktop systems", () => {
    expect(detectPlatform("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toBe("windows");
    expect(detectPlatform("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)")).toBe("macos");
    expect(detectPlatform("Mozilla/5.0 (X11; Linux x86_64)")).toBe("linux");
    expect(detectPlatform("", "macOS")).toBe("macos");
  });

  it("returns null for mobile and ChromeOS", () => {
    expect(detectPlatform("Mozilla/5.0 (Linux; Android 14; Pixel 8) Mobile")).toBeNull();
    expect(detectPlatform("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)")).toBeNull();
    expect(detectPlatform("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", "", 5)).toBeNull();
    expect(detectPlatform("Mozilla/5.0 (X11; CrOS x86_64 14541.0.0)")).toBeNull();
  });
});

it("formats sizes in megabytes", () => {
  expect(formatSize(117508359)).toBe("112 MB");
});
