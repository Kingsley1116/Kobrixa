import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DeviceOperationError,
  UsbTransport,
  type DeviceMonitorSnapshot,
  type DeviceSession,
} from "@kobrixa/device";
import type { WebContents } from "electron";
import type { BuildService } from "../workspace/build.js";
import type { DeviceEvent } from "../../shared/api.js";
import { DeviceService } from "./device.js";

vi.mock("electron", () => ({ dialog: {} }));
afterEach(() => vi.restoreAllMocks());
const snapshot: DeviceMonitorSnapshot = {
  sampledAt: 1,
  battery: { percent: 75, voltage: 7.5 },
  program: { status: "stopped", rawStatus: 64, result: 0 },
  inputs: [],
  outputs: [],
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
async function setup() {
  const session = {
    descriptor: { id: "usb", name: "EV3", transport: "usb" as const },
    connected: true,
    readMonitor: vi.fn<DeviceSession["readMonitor"]>().mockResolvedValue(snapshot),
    readInputModes: vi
      .fn<DeviceSession["readInputModes"]>()
      .mockResolvedValue({ port: 0, type: 29, modes: [{ mode: 0, name: "COL-REFLECT" }] }),
    setInputMode: vi.fn<DeviceSession["setInputMode"]>().mockResolvedValue(snapshot),
    list: vi.fn(),
    upload: vi.fn(),
    uploadStream: vi.fn(),
    download: vi.fn(),
    createDirectory: vi.fn(),
    rename: vi.fn(),
    delete: vi.fn(),
    disconnect: vi.fn(async () => {}),
    run: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    readMotorTest: vi.fn<DeviceSession["readMotorTest"]>(),
    motorTimed: vi.fn<DeviceSession["motorTimed"]>(),
    motorStop: vi.fn<DeviceSession["motorStop"]>(),
    runMotorHelper: vi.fn<DeviceSession["runMotorHelper"]>(),
    readMotorHelper: vi.fn<DeviceSession["readMotorHelper"]>(),
    armMotorHelper: vi.fn<DeviceSession["armMotorHelper"]>(),
    stopMotorHelper: vi.fn<DeviceSession["stopMotorHelper"]>(),
  } satisfies DeviceSession;
  vi.spyOn(UsbTransport.prototype, "connect").mockResolvedValue(session as never);
  const files = deferred<Array<{ path: string; remotePath: string }>>();
  const events: DeviceEvent[] = [];
  const service = new DeviceService(
    { deployableArtifacts: () => files.promise } as unknown as BuildService,
    () =>
      ({ send: (_: string, event: DeviceEvent) => events.push(event) }) as unknown as WebContents,
  );
  const id = await service.connect(session.descriptor);
  events.length = 0;
  return { service, session, id, events, files };
}

describe("background EV3 monitoring", () => {
  it("returns a snapshot without changing connection state or emitting activity", async () => {
    const h = await setup();
    expect(await h.service.monitor(h.id)).toEqual({ status: "ok", value: snapshot });
    expect(h.events).toEqual([]);
    expect(h.service.busy).toBe(false);
  });

  it.each(["run", "stop", "upload"] as const)(
    "gives %s ownership after the in-flight read without aborting it",
    async (operation) => {
      const h = await setup();
      const read = deferred<DeviceMonitorSnapshot>();
      h.session.readMonitor.mockReturnValueOnce(read.promise);
      const pending = h.service.monitor(h.id);
      const [signal, shouldYield] = h.session.readMonitor.mock.calls[0]!;
      const foreground =
        operation === "run"
          ? h.service.run(h.id, "/robot/main.rbf")
          : operation === "stop"
            ? h.service.stop(h.id)
            : h.service.deploy(h.id, "build", "/robot");
      expect(signal.aborted).toBe(false);
      expect(shouldYield?.()).toBe(true);
      expect(h.session.run).not.toHaveBeenCalled();
      expect(h.session.stop).not.toHaveBeenCalled();
      expect(await h.service.monitor(h.id)).toEqual({ status: "busy" });
      read.resolve(snapshot);
      await pending;
      h.files.resolve([]);
      await foreground;
      if (operation !== "upload") expect(h.session[operation]).toHaveBeenCalledTimes(1);
      expect(h.service.busy).toBe(false);
      expect(signal.aborted).toBe(false);
    },
  );

  it("skips duplicate reads and mode queries, and yields between round trips", async () => {
    const h = await setup();
    const roundTrip = deferred<void>();
    h.session.readInputModes.mockImplementationOnce(async (_port, _type, _signal, shouldYield) => {
      await roundTrip.promise;
      expect(shouldYield?.()).toBe(true);
      return undefined;
    });
    const modes = h.service.inputModes(h.id, 0, 29);
    expect(await h.service.monitor(h.id)).toEqual({ status: "busy" });
    expect(await h.service.inputModes(h.id, 0, 29)).toEqual({ status: "busy" });
    const stop = h.service.stop(h.id);
    roundTrip.resolve();
    expect(await modes).toEqual({ status: "busy" });
    await stop;
    expect(h.session.readMonitor).not.toHaveBeenCalled();
    expect(h.session.readInputModes).toHaveBeenCalledTimes(1);
  });

  it("does not insert polls while a deployment is reserved between files", async () => {
    const h = await setup();
    const deployment = h.service.deploy(h.id, "build", "/robot");
    expect(await h.service.monitor(h.id)).toEqual({ status: "busy" });
    expect(h.session.readMonitor).not.toHaveBeenCalled();
    h.files.resolve([]);
    await deployment;
    expect((await h.service.monitor(h.id)).status).toBe("ok");
  });

  it("invalidates a disconnected session's delayed result", async () => {
    const h = await setup();
    const read = deferred<DeviceMonitorSnapshot>();
    h.session.readMonitor.mockReturnValueOnce(read.promise);
    const pending = h.service.monitor(h.id);
    const signal = h.session.readMonitor.mock.calls[0]![0];
    await h.service.disconnect(h.id);
    expect(signal.aborted).toBe(true);
    read.resolve(snapshot);
    expect(await pending).toEqual({ status: "busy" });
    expect((await h.service.monitor(h.id)).status).toBe("error");
    expect(h.service.busy).toBe(false);
  });

  it("routes transport failures through recovery but leaves device rejection local", async () => {
    const h = await setup();
    h.session.readMonitor.mockRejectedValueOnce(new DeviceOperationError("device", "Unavailable"));
    expect(await h.service.monitor(h.id)).toMatchObject({ status: "error", category: "device" });
    expect(h.session.disconnect).not.toHaveBeenCalled();
    h.session.readMonitor.mockRejectedValueOnce(
      new DeviceOperationError("protocol", "Truncated reply"),
    );
    expect(await h.service.monitor(h.id)).toMatchObject({ status: "error", category: "protocol" });
    expect(h.session.disconnect).toHaveBeenCalledTimes(1);
    expect(h.events).toContainEqual(
      expect.objectContaining({ type: "usb-recovery", state: "unavailable" }),
    );
    expect(h.service.busy).toBe(false);
  });

  it("serializes mode changes as foreground work and returns typed failures", async () => {
    const h = await setup();
    const change = deferred<DeviceMonitorSnapshot>();
    h.session.setInputMode.mockReturnValueOnce(change.promise);
    const pending = h.service.setInputMode(h.id, 0, 29, 1);
    expect(await h.service.monitor(h.id)).toEqual({ status: "busy" });
    expect(h.session.setInputMode).toHaveBeenCalledWith(0, 29, 1, expect.any(AbortSignal));
    change.resolve(snapshot);
    expect(await pending).toEqual({ status: "ok", value: snapshot });
    h.session.setInputMode.mockRejectedValueOnce(
      new DeviceOperationError("device", "Program running"),
    );
    expect(await h.service.setInputMode(h.id, 0, 29, 1)).toMatchObject({
      status: "error",
      category: "device",
      message: "Program running",
    });
    expect(h.service.busy).toBe(false);
  });
});
