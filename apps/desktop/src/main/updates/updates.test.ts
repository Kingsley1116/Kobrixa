import { describe, expect, it, vi, afterEach } from "vitest";
import {
  fetchReleases,
  selectRelease,
  validateUpdateInfo,
  type PublishedRelease,
} from "./catalog.js";
import { UpdateOperationGate, UpdateService } from "./service.js";
import {
  updateArtifactName,
  updateMetadataName,
  type UpdatePreferences,
} from "../../shared/updates.js";
const stable: UpdatePreferences = { enabled: true, channel: "stable" };
const preview: UpdatePreferences = { enabled: true, channel: "preview" };
function release(version: string, extra: Partial<PublishedRelease> = {}): PublishedRelease {
  return {
    tag_name: `v${version}`,
    draft: false,
    prerelease: version.includes("-"),
    assets: [updateArtifactName(version, "win32", "x64"), updateMetadataName("win32")].map(
      (name) => ({ name, size: 20, state: "uploaded" }),
    ),
    ...extra,
  };
}
function fixture(options: { reason?: "development"; preferences?: UpdatePreferences } = {}) {
  const backend = { download: vi.fn(async () => {}), install: vi.fn() };
  const dependencies = {
    version: "1.0.0",
    platform: "win32",
    arch: "x64",
    ...options,
    preferences: options.preferences ?? stable,
    list: vi.fn(async () => [release("1.1.0")]),
    backend,
    persist: vi.fn(async () => {}),
    publish: vi.fn(),
    open: vi.fn(async () => {}),
    busy: vi.fn(() => false),
  };
  return { service: new UpdateService(dependencies), dependencies, backend };
}
afterEach(() => vi.useRealTimers());
describe("release selection", () => {
  it("finds DMG-only Mac releases and still supports legacy ZIP releases", () => {
    for (const suffix of ["dmg", "zip"]) {
      const candidate = release("2.0.0", {
        assets: [{ name: `Kobrixa-2.0.0-darwin-arm64.${suffix}`, size: 1, state: "uploaded" }],
      });
      expect(selectRelease([candidate], "1.0.0", stable, "darwin", "arm64")).toMatchObject({
        version: "2.0.0",
        automatic: false,
      });
      expect(selectRelease([candidate], "1.0.0", stable, "darwin", "x64")).toBeUndefined();
      candidate.assets[0]!.size = 0;
      expect(selectRelease([candidate], "1.0.0", stable, "darwin", "arm64")).toBeUndefined();
    }
  });
  it("sorts SemVer instead of publication order and respects stable and custom preview tags", () => {
    const releases = [
      release("1.2.0"),
      release("1.10.0-v1-candidate.2"),
      release("1.3.0"),
      release("2.0.0", { draft: true }),
    ];
    expect(selectRelease(releases, "1.0.0", stable, "win32", "x64")?.version).toBe("1.3.0");
    expect(selectRelease(releases, "1.0.0", preview, "win32", "x64")?.version).toBe(
      "1.10.0-v1-candidate.2",
    );
    expect(
      selectRelease([release("1.0.0")], "1.0.0-v1-candidate.2", stable, "win32", "x64")?.version,
    ).toBe("1.0.0");
    expect(
      selectRelease([release("0.9.0"), release("1.0.0")], "1.0.0", preview, "win32", "x64"),
    ).toBeUndefined();
  });
  it("requires platform assets and uses manual mode for legacy archives", () => {
    expect(
      selectRelease([release("2.0.0", { assets: [] })], "1.0.0", stable, "win32", "x64"),
    ).toBeUndefined();
    expect(
      selectRelease(
        [
          release("2.0.0", {
            assets: [{ name: "Kobrixa-2.0.0-win32-x64.zip", size: 1, state: "uploaded" }],
          }),
        ],
        "1.0.0",
        stable,
        "win32",
        "x64",
      )?.automatic,
    ).toBe(false);
    expect(selectRelease([release("2.0.0")], "1.0.0", stable, "linux", "x64")).toBeUndefined();
  });
  it("reports private sources, rate limits and malformed responses", async () => {
    const signal = new AbortController().signal;
    await expect(
      fetchReleases(
        signal,
        vi.fn(async () => new Response(null, { status: 404 })),
      ),
    ).rejects.toThrow("source-unavailable");
    await expect(
      fetchReleases(
        signal,
        vi.fn(async () => new Response(null, { status: 403 })),
      ),
    ).rejects.toThrow("rate-limited");
    await expect(
      fetchReleases(
        signal,
        vi.fn(async () => new Response("{}")),
      ),
    ).rejects.toThrow();
  });
});
describe("update lifecycle", () => {
  it("downloads once, and only installs after an explicit preparation", async () => {
    const { service, dependencies, backend } = fixture();
    const first = service.check();
    expect(service.check()).toBe(first);
    await first;
    expect(backend.download).toHaveBeenCalledOnce();
    expect(service.getState().phase).toBe("ready");
    expect(() => service.install()).toThrow("busy");
    dependencies.busy.mockReturnValue(true);
    expect(() => service.prepareInstall()).toThrow("busy");
    dependencies.busy.mockReturnValue(false);
    service.prepareInstall();
    service.cancelInstall();
    expect(backend.install).not.toHaveBeenCalled();
    service.prepareInstall();
    service.install();
    expect(backend.install).toHaveBeenCalledOnce();
  });
  it("ignores late downloads after a channel switch and waits before reusing the backend", async () => {
    const { service, dependencies, backend } = fixture({ preferences: preview });
    let complete!: () => void;
    backend.download.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          complete = resolve;
        }),
    );
    const pending = service.check();
    await vi.waitFor(() => expect(backend.download).toHaveBeenCalledOnce());
    dependencies.list.mockResolvedValue([]);
    await service.setPreferences(stable);
    expect(service.getState().phase).toBe("idle");
    complete();
    await pending;
    await vi.waitFor(() => expect(service.getState().phase).toBe("no-release"));
    expect(backend.download).toHaveBeenCalledOnce();
    expect(() => service.prepareInstall()).toThrow();
  });
  it("preserves preferences when persistence fails and allows a later retry", async () => {
    const { service, dependencies } = fixture();
    dependencies.persist.mockRejectedValueOnce(new Error("disk full"));
    await expect(service.setPreferences(preview)).rejects.toThrow("disk full");
    expect(service.getState().preferences).toEqual(stable);
    await service.setPreferences({ ...preview, enabled: false });
    expect(service.getState().preferences.channel).toBe("preview");
  });
  it("keeps failed downloads out of the installable state", async () => {
    const { service, backend } = fixture();
    backend.download.mockRejectedValueOnce(new Error("checksum mismatch"));
    await service.check();
    expect(service.getState().phase).toBe("error");
    expect(() => service.prepareInstall()).toThrow();
    await service.check();
    expect(service.getState().phase).toBe("ready");
  });
  it("checks after 30 seconds and every six hours, honors opt-out and disables development", async () => {
    vi.useFakeTimers();
    const { service, dependencies } = fixture();
    dependencies.list.mockResolvedValue([]);
    service.start();
    await vi.advanceTimersByTimeAsync(29_999);
    expect(dependencies.list).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(dependencies.list).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000);
    expect(dependencies.list).toHaveBeenCalledTimes(2);
    await service.setPreferences({ ...stable, enabled: false });
    await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000);
    expect(dependencies.list).toHaveBeenCalledTimes(2);
    service.dispose();
    const development = fixture({ reason: "development" });
    development.service.start();
    await development.service.check();
    expect(development.dependencies.list).not.toHaveBeenCalled();
  });
  it("gates new operations during preparation while allowing pending saves to finish", async () => {
    const { service, dependencies } = fixture();
    const gate = new UpdateOperationGate(() => service);
    dependencies.busy.mockImplementation(() => gate.busy);
    await service.check();
    let finish!: () => void;
    const operation = gate.run(
      "device:upload",
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    expect(() => service.prepareInstall()).toThrow();
    finish();
    await operation;
    service.prepareInstall();
    await expect(gate.run("device:run", () => {})).rejects.toThrow("busy");
    await gate.run("workspace:write", () => {});
    service.install();
    await expect(gate.run("workspace:write", () => {})).rejects.toThrow("busy");
  });
});

it("validates metadata before the updater can download any file", () => {
  const selected = selectRelease([release("1.1.0")], "1.0.0", stable, "win32", "x64")!;
  const name = updateArtifactName("1.1.0", "win32", "x64");
  const digest = "A".repeat(86) + "==";
  const metadata = {
    version: "1.1.0",
    files: [{ url: name, size: 1, sha512: digest }],
    path: name,
    sha512: digest,
  };
  expect(() => validateUpdateInfo(metadata, selected, "win32", "x64")).not.toThrow();
  for (const bad of [
    { ...metadata, version: "0.9.0" },
    { ...metadata, files: [{ ...metadata.files[0], url: "https://example.com/payload.exe" }] },
    { ...metadata, packages: {} },
    { ...metadata, sha512: "bad" },
  ])
    expect(() => validateUpdateInfo(bad, selected, "win32", "x64")).toThrow();
});

it("refuses installation while a preference write could invalidate the downloaded release", async () => {
  const { service, dependencies } = fixture();
  await service.check();
  let finish!: () => void;
  dependencies.persist.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const changing = service.setPreferences({ ...preview, enabled: false });
  expect(() => service.prepareInstall()).toThrow("busy");
  await vi.waitFor(() => expect(dependencies.persist).toHaveBeenCalled());
  finish();
  await changing;
  expect(service.getState().phase).toBe("idle");
  expect(() => service.prepareInstall()).toThrow("busy");
});

it("keeps offline checks recoverable and a normal quit never installs a downloaded update", async () => {
  const { service, dependencies, backend } = fixture();
  dependencies.list.mockRejectedValueOnce(new TypeError("fetch failed"));
  await service.check();
  expect(service.getState().phase).toBe("error");
  expect(() => service.prepareInstall()).toThrow("busy");
  await service.check();
  expect(service.getState().phase).toBe("ready");
  service.dispose();
  expect(backend.install).not.toHaveBeenCalled();
});
