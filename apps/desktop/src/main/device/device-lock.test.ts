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
    readMotorTest: vi.fn<DeviceSession["readMotorTest"]>(),
    motorTimed: vi.fn<DeviceSession["motorTimed"]>(),
    motorStop: vi.fn<DeviceSession["motorStop"]>(),
    runMotorHelper: vi.fn<DeviceSession["runMotorHelper"]>(),
    readMotorHelper: vi.fn<DeviceSession["readMotorHelper"]>(),
    armMotorHelper: vi.fn<DeviceSession["armMotorHelper"]>(),
    stopMotorHelper: vi.fn<DeviceSession["stopMotorHelper"]>(),
    readMonitor: vi.fn<DeviceSession["readMonitor"]>(),
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

  it("holds the motor-test lease across delays and blocks commands, files, and monitoring", async () => {
    const h = await setup();
    const finish = deferred<void>();
    const started = deferred<void>();
    const test = h.service.withMotorTest(h.id, async (session, signal) => {
      await session.motorTimed(0, 20, 400, true, signal);
      started.resolve();
      await finish.promise;
      await session.motorStop(0, true, signal);
    });
    await started.promise;
    expect(h.service.busy).toBe(true);
    await expect(h.service.run(h.id, `${ROOT}/main.rbf`)).rejects.toThrow("in progress");
    await expect(h.service.deploy(h.id, "build", ROOT)).rejects.toThrow("in progress");
    await expect(h.service.stop(h.id)).rejects.toThrow("in progress");
    await expect(h.service.withMotorTest(h.id, async () => {})).rejects.toThrow("in progress");
    expect(await h.service.monitor(h.id)).toEqual({ status: "busy" });
    expect(await h.service.inputModes(h.id, 0, 29)).toEqual({ status: "busy" });
    expect(await h.service.setInputMode(h.id, 0, 29, 1)).toMatchObject({ status: "error" });
    expect(
      await h.service.files({
        action: "list",
        path: ROOT,
        sessionId: h.id,
        requestId: "motor-file",
        locale: "en",
      }),
    ).toMatchObject({ ok: false });
    expect(h.session.run).not.toHaveBeenCalled();
    expect(h.session.upload).not.toHaveBeenCalled();
    expect(h.session.list).not.toHaveBeenCalled();
    expect(h.session.readMonitor).not.toHaveBeenCalled();
    expect(h.session.readInputModes).not.toHaveBeenCalled();
    expect(h.session.setInputMode).not.toHaveBeenCalled();
    finish.resolve();
    await test;
    expect(h.session.motorStop).toHaveBeenCalledOnce();
    expect(h.service.busy).toBe(false);
    await expect(h.service.run(h.id, `${ROOT}/main.rbf`)).resolves.toBeUndefined();
  });

  it("reserves motor ownership before draining an existing monitor without aborting USB", async () => {
    const h = await setup();
    const reading = deferred<undefined>();
    h.session.readMonitor.mockReturnValueOnce(reading.promise);
    const monitor = h.service.monitor(h.id);
    const [signal, shouldYield] = h.session.readMonitor.mock.calls[0]!;
    const work = vi.fn(async (session: DeviceSession, motorSignal: AbortSignal) => {
      await session.motorTimed(1, 20, 400, true, motorSignal);
    });
    const test = h.service.withMotorTest(h.id, work);
    expect(signal.aborted).toBe(false);
    expect(shouldYield?.()).toBe(true);
    expect(work).not.toHaveBeenCalled();
    expect(await h.service.monitor(h.id)).toEqual({ status: "busy" });
    await expect(h.service.run(h.id, `${ROOT}/main.rbf`)).rejects.toThrow("in progress");
    reading.resolve(undefined);
    expect(await monitor).toEqual({ status: "busy" });
    await test;
    expect(work).toHaveBeenCalledOnce();
    expect(h.session.motorTimed).toHaveBeenCalledOnce();
    expect(signal.aborted).toBe(false);
    expect(h.service.busy).toBe(false);
  });

  it("awaits the motor stop hook and its lease before closing the connection", async () => {
    const h = await setup();
    const stopping = deferred<void>();
    const stopConfirmed = deferred<void>();
    const events: string[] = [];
    const test = h.service.withMotorTest(h.id, async (session, signal) => {
      await stopping.promise;
      expect(signal.aborted).toBe(false);
      await session.motorStop(0, true, signal);
      await stopConfirmed.promise;
      events.push("stopped");
    });
    h.service.setBeforeDisconnect(async (id) => {
      expect(id).toBe(h.id);
      events.push("requested");
      stopping.resolve();
      await test;
    });
    h.session.disconnect.mockImplementation(async () => {
      events.push("closed");
    });
    const disconnecting = h.service.disconnect(h.id);
    await vi.waitFor(() => expect(h.session.motorStop).toHaveBeenCalledOnce());
    expect(h.session.disconnect).not.toHaveBeenCalled();
    expect(h.service.busy).toBe(true);
    stopConfirmed.resolve();
    await disconnecting;
    expect(events).toEqual(["requested", "stopped", "closed"]);
    expect(h.service.busy).toBe(false);
  });

  it("releases motor ownership after a test error", async () => {
    const h = await setup();
    await expect(
      h.service.withMotorTest(h.id, async () => {
        throw new DeviceOperationError("device", "Motor no longer connected");
      }),
    ).rejects.toThrow("Motor no longer connected");
    expect(h.service.busy).toBe(false);
    await expect(h.service.run(h.id, `${ROOT}/main.rbf`)).resolves.toBeUndefined();
  });
});
