import { describe, expect, it, vi } from "vitest";
import { DeviceOperationError, UsbTransport, type DeviceSession } from "@kobrixa/device";
import { DeviceService } from "./device.js";
import type { BuildService } from "./build.js";
import type { WebContents } from "electron";
import type { DeviceEvent } from "../shared/api.js";
vi.mock("electron", () => ({ dialog: {} }));
const ROOT = "/home/root/lms2012/prjs";
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
async function setup() {
  const session = {
    descriptor: { id: "mock", name: "EV3", transport: "usb" as const },
    connected: true,
    list: vi.fn(async () => []),
    upload: vi.fn(),
    uploadStream: vi.fn(),
    download: vi.fn(),
    createDirectory: vi.fn(),
    rename: vi.fn(),
    delete: vi.fn(),
    disconnect: vi.fn(async () => {}),
    run: vi.fn(),
    stop: vi.fn(),
  } satisfies DeviceSession;
  vi.spyOn(UsbTransport.prototype, "connect").mockResolvedValueOnce(
    session as unknown as Awaited<ReturnType<UsbTransport["connect"]>>,
  );
  const files = deferred<Array<{ path: string; remotePath: string }>>();
  const builds = { deployableArtifacts: () => files.promise } as unknown as BuildService;
  const events: DeviceEvent[] = [];
  const service = new DeviceService(
    builds,
    () =>
      ({
        send: (_channel: string, event: DeviceEvent) => events.push(event),
      }) as unknown as WebContents,
  );
  const id = await service.connect(session.descriptor);
  return { service, session, id, files, events };
}
describe("main-process device lock", () => {
  it("reserves the session for the entire deployment, including gaps between files", async () => {
    const h = await setup();
    const deployment = h.service.deploy(h.id, "build", ROOT);
    const response = await h.service.files({
      action: "list",
      path: ROOT,
      sessionId: h.id,
      requestId: "r",
      locale: "en",
    });
    expect(response.ok).toBe(false);
    expect(h.session.list).not.toHaveBeenCalled();
    await expect(h.service.run(h.id, `${ROOT}/main.rbf`)).rejects.toThrow("in progress");
    h.files.resolve([]);
    await deployment;
    expect(
      (
        await h.service.files({
          action: "list",
          path: ROOT,
          sessionId: h.id,
          requestId: "r2",
          locale: "en",
        })
      ).ok,
    ).toBe(true);
  });
  it("blocks robot commands while reading files, and clears a lost session", async () => {
    const h = await setup();
    const gate = deferred<never[]>();
    h.session.list.mockImplementationOnce(() => gate.promise);
    const listing = h.service.files({
      action: "list",
      path: ROOT,
      sessionId: h.id,
      requestId: "r",
      locale: "en",
    });
    await expect(h.service.stop(h.id)).rejects.toThrow("in progress");
    gate.resolve([]);
    await listing;
    h.session.list.mockRejectedValueOnce(new DeviceOperationError("connection", "Cable removed"));
    expect(
      (
        await h.service.files({
          action: "list",
          path: ROOT,
          sessionId: h.id,
          requestId: "r2",
          locale: "en",
        })
      ).ok,
    ).toBe(false);
    expect(h.events).toContainEqual({
      type: "state",
      state: "disconnected",
      sessionId: h.id,
      message: "Cable removed",
    });
    await expect(h.service.stop(h.id)).rejects.toThrow("Unknown or disconnected");
  });
});
