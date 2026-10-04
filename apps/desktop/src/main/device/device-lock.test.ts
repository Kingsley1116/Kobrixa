import { describe, expect, it, vi } from "vitest";
import {
  DeviceOperationError,
  UsbTransport,
  type DeviceSession,
  type RemoteEntry,
} from "@kobrixa/device";
import { DeviceService } from "./device.js";
import type { BuildService } from "../workspace/build.js";
import type { WebContents } from "electron";
import type { DeviceEvent } from "../../shared/api.js";
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
    list: vi.fn(async (): Promise<RemoteEntry[]> => []),
    upload: vi.fn(),
    uploadStream: vi.fn(),
    download: vi.fn(),
    createDirectory: vi.fn(),
    rename: vi.fn(),
    delete: vi.fn(),
    disconnect: vi.fn(async () => {}),
    run: vi.fn(),
    stop: vi.fn(),
    readMonitor: vi.fn(),
    readInputModes: vi.fn(),
    setInputMode: vi.fn(),
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
  it("keeps a prepared file batch exclusive until confirmation is cancelled", async () => {
    const h = await setup();
    h.session.list.mockResolvedValue([{ name: "a", path: `${ROOT}/a`, kind: "file", size: 0 }]);
    const owner = { id: 1, once: vi.fn(), on: vi.fn() } as unknown as WebContents;
    const plan = await h.service.prepareFiles(
      {
        sessionId: h.id,
        requestId: "request",
        action: "delete",
        path: ROOT,
        paths: [`${ROOT}/a`],
        source: "files",
        locale: "en",
      },
      owner,
    );
    expect(plan.phase).toBe("ready");
    expect(h.service.busy).toBe(true);
    await expect(h.service.run(h.id, `${ROOT}/a`)).rejects.toThrow("in progress");
    await expect(h.service.executeFiles(plan, "replace", 2)).rejects.toThrow("expired");
    await h.service.stopFiles(plan, 1);
    expect(h.service.busy).toBe(false);
    await expect(h.service.run(h.id, `${ROOT}/a`)).resolves.toBeUndefined();
    expect(h.session.delete).not.toHaveBeenCalled();
  });
  it("reserves the session for the entire deployment, including gaps between files", async () => {
    const h = await setup();
    const deployment = h.service.deploy(h.id, "build", ROOT);
    expect(h.service.busy).toBe(true);
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
    expect(h.service.busy).toBe(false);
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
      type: "usb-recovery",
      state: "unavailable",
      previousSessionId: h.id,
      descriptor: h.session.descriptor,
    });
    await expect(h.service.stop(h.id)).rejects.toThrow("Unknown or disconnected");
  });
});
