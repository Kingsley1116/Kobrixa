import { createHash } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DeviceOperationError,
  UsbTransport,
  WiFiTransport,
  type DeviceDescriptor,
  type DeviceSession,
  type RemoteEntry,
} from "@kobrixa/device";
import type { WebContents } from "electron";
import type { BuildService } from "../workspace/build.js";
import type { DeviceEvent } from "../../shared/api.js";
import { DeviceService } from "./device.js";

vi.mock("electron", () => ({ dialog: {} }));
const ROOT = "/home/root/lms2012/prjs";
const target: DeviceDescriptor = {
  id: "usb:serial",
  name: "EV3",
  transport: "usb",
  serialNumber: "serial",
  metadata: { path: "old-path" },
};
type Restored = Extract<DeviceEvent, { state: "restored" }>;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
function robot(descriptor = target) {
  const listeners = new Set<(error: Error) => void>();
  const session = {
    descriptor,
    connected: true as boolean,
    onDisconnect: (listener: (error: Error) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    disconnect: vi.fn(async () => {
      session.connected = false;
      listeners.clear();
    }),
    list: vi.fn(async (_directory: string, _signal: AbortSignal): Promise<RemoteEntry[]> => []),
    upload: vi.fn(async () => {}),
    uploadStream: vi.fn(),
    download: vi.fn(),
    createDirectory: vi.fn(),
    rename: vi.fn(),
    delete: vi.fn(),
    run: vi.fn(),
    stop: vi.fn(),
    drop() {
      session.connected = false;
      for (const listener of [...listeners])
        listener(new DeviceOperationError("connection", "Cable removed"));
    },
  } satisfies DeviceSession & { drop(): void };
  return session;
}
const services: DeviceService[] = [];
let directory: string;
beforeEach(async () => {
  vi.useFakeTimers();
  directory = await mkdtemp(path.join(tmpdir(), "kobrixa-recovery-"));
});
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.reset()));
  vi.restoreAllMocks();
  vi.useRealTimers();
  await rm(directory, { recursive: true, force: true });
});
const settle = () => vi.advanceTimersByTimeAsync(0);
async function setup(descriptor = target) {
  const original = robot(descriptor);
  const replacement = robot({ ...descriptor, metadata: { path: "new-path" } });
  const connect = vi.spyOn(UsbTransport.prototype, "connect");
  connect.mockResolvedValueOnce(original as never).mockResolvedValue(replacement as never);
  const discover = vi
    .spyOn(UsbTransport.prototype, "discover")
    .mockResolvedValue([replacement.descriptor]);
  const events: DeviceEvent[] = [];
  const program = path.join(directory, "main.rbf"),
    asset = path.join(directory, "image.rgf");
  await writeFile(program, "program");
  await writeFile(asset, "asset");
  const builds = {
    deployableArtifacts: vi.fn(async () => [
      { path: asset, remotePath: "assets/image.rgf" },
      { path: program, remotePath: "main.rbf" },
    ]),
  };
  const service = new DeviceService(
    builds as unknown as BuildService,
    () =>
      ({
        send: (_channel: string, event: DeviceEvent) => events.push(event),
      }) as unknown as WebContents,
  );
  services.push(service);
  const id = await service.connect(descriptor);
  return { original, replacement, connect, discover, events, service, id, program, asset };
}
function restored(events: DeviceEvent[]): Restored {
  const result = events
    .filter(
      (event): event is Restored => event.type === "usb-recovery" && event.state === "restored",
    )
    .at(-1);
  expect(result).toBeDefined();
  return result!;
}
function listing(file: string, bytes: string): RemoteEntry {
  return {
    name: path.posix.basename(file),
    path: file,
    kind: "file",
    size: Buffer.byteLength(bytes),
    checksum: createHash("md5").update(bytes).digest("hex"),
  };
}
function validListings(session: ReturnType<typeof robot>) {
  session.list.mockImplementation(async (directory) =>
    directory === `${ROOT}/demo`
      ? [listing(`${ROOT}/demo/main.rbf`, "program")]
      : directory === `${ROOT}/demo/assets`
        ? [listing(`${ROOT}/demo/assets/image.rgf`, "asset")]
        : [],
  );
}

describe("USB recovery", () => {
  it("recovers idle unplug with a fresh path and session, without robot commands or continued polling", async () => {
    const h = await setup();
    h.original.drop();
    await settle();
    const event = restored(h.events);
    expect(event.previousSessionId).toBe(h.id);
    expect(event.sessionId).not.toBe(h.id);
    expect(h.connect).toHaveBeenLastCalledWith(h.replacement.descriptor, expect.any(AbortSignal));
    expect(h.replacement.run).not.toHaveBeenCalled();
    expect(h.replacement.stop).not.toHaveBeenCalled();
    expect(h.replacement.upload).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(h.discover).toHaveBeenCalledOnce();
    expect(h.service.busy).toBe(false);
    await h.service.stop(event.sessionId);
    expect(h.replacement.stop).toHaveBeenCalledOnce();
  });

  it("waits for the matching serial with 1, 2, then 5 second backoff", async () => {
    const h = await setup();
    h.discover.mockResolvedValue([{ ...target, serialNumber: "another" }]);
    h.original.drop();
    await settle();
    expect(h.discover).toHaveBeenCalledTimes(1);
    for (const [delay, calls] of [
      [1000, 2],
      [2000, 3],
      [5000, 4],
      [5000, 5],
    ]) {
      await vi.advanceTimersByTimeAsync(delay! - 1);
      expect(h.discover).toHaveBeenCalledTimes(calls! - 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(h.discover).toHaveBeenCalledTimes(calls!);
    }
    expect(h.connect).toHaveBeenCalledOnce();
    h.discover.mockResolvedValue([h.replacement.descriptor]);
    await vi.advanceTimersByTimeAsync(5000);
    restored(h.events);
  });

  it.each(["missing", "duplicate"])(
    "requires manual selection for %s serial identity",
    async (kind) => {
      const descriptor = { ...target, serialNumber: kind === "missing" ? " " : "serial" };
      const h = await setup(descriptor);
      if (kind === "duplicate")
        h.discover.mockResolvedValue([
          h.replacement.descriptor,
          { ...target, metadata: { path: "third" } },
        ]);
      h.original.drop();
      await settle();
      expect(h.events).toContainEqual({
        type: "usb-recovery",
        state: "unavailable",
        previousSessionId: h.id,
        descriptor,
      });
      expect(h.connect).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("cancels waiting and a connection which finishes after cancellation", async () => {
    const h = await setup();
    const open = deferred<ReturnType<typeof robot>>();
    h.connect.mockImplementationOnce(() => open.promise as never);
    h.original.drop();
    await settle();
    await h.service.disconnect(h.id);
    open.resolve(h.replacement);
    await settle();
    expect(h.replacement.connected).toBe(false);
    expect(
      h.events.some((event) => event.type === "usb-recovery" && event.state === "restored"),
    ).toBe(false);
    expect(h.service.busy).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("honors a late cancellation even after recovery was published", async () => {
    const h = await setup();
    h.original.drop();
    await settle();
    const event = restored(h.events);
    await h.service.disconnect(h.id);
    expect(h.replacement.connected).toBe(false);
    await expect(h.service.stop(event.sessionId)).rejects.toThrow("disconnected");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cleans up on reset and on manually selecting Wi-Fi", async () => {
    const h = await setup();
    h.discover.mockResolvedValue([]);
    h.original.drop();
    await settle();
    const wifi = robot({ id: "wifi:1", name: "EV3", transport: "wifi" });
    vi.spyOn(WiFiTransport.prototype, "connect").mockResolvedValue(wifi as never);
    const id = await h.service.connectWifi("192.168.0.2");
    expect(vi.getTimerCount()).toBe(0);
    wifi.drop();
    await settle();
    expect(h.events).toContainEqual({
      type: "state",
      state: "disconnected",
      sessionId: id,
      message: "Cable removed",
    });
    expect(h.discover).toHaveBeenCalledOnce();
    await h.service.reset();
    expect(h.service.busy).toBe(false);
  });

  it("retries transient open failure and a second unplug during verification", async () => {
    const h = await setup();
    h.connect.mockRejectedValueOnce(new Error("not ready"));
    h.original.drop();
    await settle();
    h.replacement.list.mockImplementationOnce(async () => {
      h.replacement.drop();
      throw new DeviceOperationError("connection", "removed again");
    });
    await vi.advanceTimersByTimeAsync(1000);
    const third = robot(h.replacement.descriptor);
    h.connect.mockResolvedValueOnce(third as never);
    await vi.advanceTimersByTimeAsync(2000);
    const event = restored(h.events);
    expect(h.replacement.connected).toBe(false);
    third.drop();
    const fourth = robot(target);
    h.connect.mockResolvedValueOnce(fourth as never);
    await settle();
    expect(restored(h.events).previousSessionId).toBe(event.sessionId);
  });

  it("unlocks interrupted work and ignores its late completion", async () => {
    const h = await setup();
    const pending = deferred<RemoteEntry[]>();
    h.original.list.mockReturnValueOnce(pending.promise);
    const request = h.service.files({
      sessionId: h.id,
      requestId: "r",
      path: ROOT,
      action: "list",
      locale: "en",
    });
    await settle();
    h.original.drop();
    expect((await request).ok).toBe(false);
    await settle();
    const count = h.events.length;
    pending.resolve([]);
    await settle();
    expect(h.events).toHaveLength(count);
    expect(h.service.busy).toBe(false);
  });

  it("intentional disconnect aborts work without starting recovery", async () => {
    const h = await setup();
    h.original.list.mockImplementationOnce(
      (_directory, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              h.original.drop();
              reject(signal.reason);
            },
            { once: true },
          );
        }),
    );
    const request = h.service.files({
      sessionId: h.id,
      requestId: "r",
      path: ROOT,
      action: "list",
      locale: "en",
    });
    await settle();
    await h.service.disconnect(h.id);
    expect((await request).ok).toBe(false);
    await settle();
    expect(h.discover).not.toHaveBeenCalled();
    expect(h.service.busy).toBe(false);
  });
});

describe("deployment verification after USB recovery", () => {
  it("verifies program and assets against the bytes uploaded, even if local build files changed", async () => {
    const h = await setup();
    await h.service.deploy(h.id, "build", `${ROOT}/demo`);
    await writeFile(h.program, "new build");
    validListings(h.replacement);
    h.original.drop();
    await settle();
    expect(restored(h.events)).toMatchObject({ deployment: "verified", buildId: "build" });
    expect(h.replacement.list).toHaveBeenCalledWith(`${ROOT}/demo/assets`, expect.any(AbortSignal));
    expect(h.replacement.run).not.toHaveBeenCalled();
  });

  it.each(["changed", "missing", "unreadable"])(
    "keeps connection but requires upload when assets are %s",
    async (kind) => {
      const h = await setup();
      await h.service.deploy(h.id, "build", `${ROOT}/demo`);
      h.replacement.list.mockImplementation(async (directory) => {
        if (directory === `${ROOT}/demo`) return [listing(`${ROOT}/demo/main.rbf`, "program")];
        if (directory === `${ROOT}/demo/assets`) {
          if (kind === "unreadable") throw new DeviceOperationError("permission", "denied");
          if (kind === "changed") return [listing(`${ROOT}/demo/assets/image.rgf`, "other")];
        }
        return [];
      });
      h.original.drop();
      await settle();
      expect(restored(h.events)).toMatchObject({ deployment: "changed" });
      expect(restored(h.events).buildId).toBeUndefined();
      expect(h.replacement.connected).toBe(true);
    },
  );

  it("invalidates a previous version before a failed replacement upload and preserves connection errors", async () => {
    const h = await setup();
    await h.service.deploy(h.id, "old", `${ROOT}/demo`);
    h.original.upload.mockRejectedValueOnce(new DeviceOperationError("connection", "removed"));
    await expect(h.service.deploy(h.id, "new", `${ROOT}/demo`)).rejects.toMatchObject({
      category: "connection",
    });
    validListings(h.replacement);
    await settle();
    expect(restored(h.events).deployment).toBe("none");
    expect(h.original.run).not.toHaveBeenCalled();
  });

  it("invalidates a deployment before a file mutation that partially fails", async () => {
    const h = await setup();
    await h.service.deploy(h.id, "build", `${ROOT}/demo`);
    h.original.delete.mockRejectedValueOnce(new DeviceOperationError("device", "partial delete"));
    await expect(h.service.delete(h.id, `${ROOT}/demo/main.rbf`)).rejects.toThrow("partial delete");
    validListings(h.replacement);
    h.original.drop();
    await settle();
    expect(restored(h.events).deployment).toBe("none");
  });
});
