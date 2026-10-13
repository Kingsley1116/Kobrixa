import { useEffect, useState } from "react";
import type { IconName } from "../components/ui/icon.js";
import { detectPlatform, type LatestRelease, type Platform } from "./releases.js";

export type ReleaseState = LatestRelease | "loading" | "error";

export const platformInfo: Record<
  Platform,
  { name: string; icon: IconName; arch: string; installer: string; archive?: string }
> = {
  windows: { name: "Windows", icon: "windows", arch: "x64", installer: "EXE", archive: "ZIP" },
  macos: { name: "macOS", icon: "mac", arch: "Apple Silicon", installer: "DMG" },
  linux: { name: "Linux", icon: "terminal", arch: "x64", installer: "AppImage", archive: "tar.gz" },
};

export function visitorPlatform() {
  if (typeof navigator === "undefined") return null;
  const hint = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData
    ?.platform;
  return detectPlatform(navigator.userAgent, hint, navigator.maxTouchPoints);
}

/** Latest GitHub release, fetched through the worker's cached `/api/releases/latest`. */
export function useLatestRelease() {
  const [release, setRelease] = useState<ReleaseState>("loading");
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/releases/latest", { signal: controller.signal })
      .then((res) => (res.ok ? res.json() : null))
      .then((payload: unknown) =>
        setRelease(
          payload && typeof payload === "object" && "platforms" in payload
            ? (payload as LatestRelease)
            : "error",
        ),
      )
      .catch(() => {
        if (!controller.signal.aborted) setRelease("error");
      });
    return () => controller.abort();
  }, []);
  return release;
}
