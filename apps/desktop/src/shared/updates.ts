export interface UpdatePreferences {
  enabled: boolean;
  channel: "stable" | "preview";
}
export type UpdatePhase =
  | "idle"
  | "checking"
  | "current"
  | "no-release"
  | "downloading"
  | "ready"
  | "manual"
  | "preparing"
  | "installing"
  | "error";
export interface UpdateState {
  revision: number;
  currentVersion: string;
  preferences: UpdatePreferences;
  supported: boolean;
  reason?: "development" | "archive" | "unsigned-mac" | "platform" | undefined;
  phase: UpdatePhase;
  version?: string | undefined;
  progress?: number | undefined;
  error?: string | undefined;
}
export interface UpdatesApi {
  getState(): Promise<UpdateState>;
  onState(listener: (state: UpdateState) => void): () => void;
  setPreferences(preferences: UpdatePreferences): Promise<UpdateState>;
  check(): Promise<void>;
  prepareInstall(): Promise<void>;
  cancelInstall(): Promise<void>;
  install(): Promise<void>;
  openRelease(): Promise<void>;
}
export const RELEASE_REPOSITORY = "Kingsley1116/Kobrixa";
export const RELEASES_URL = `https://github.com/${RELEASE_REPOSITORY}/releases`;
export function updateMetadataName(platform: string): string {
  return platform === "darwin"
    ? "latest-mac.yml"
    : platform === "linux"
      ? "latest-linux.yml"
      : "latest.yml";
}
export function updateArtifactName(version: string, platform: string, arch: string): string {
  const suffix =
    platform === "darwin" ? "-update.zip" : platform === "linux" ? ".AppImage" : "-setup.exe";
  return `Kobrixa-${version}-${platform}-${arch}${suffix}`;
}
