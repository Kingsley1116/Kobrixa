import { describe, expect, it, vi } from "vitest";
const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>());
vi.mock("electron", () => ({
  ipcMain: {
    handle: (name: string, handler: (...args: unknown[]) => unknown) => handlers.set(name, handler),
  },
}));
import { registerIpc } from "../ipc.js";
import { channelKey } from "../../shared/sensor-lab.js";
import { identityCalibration } from "../../shared/sensor-calibration.js";

function setup() {
  const renderer = { id: 1, mainFrame: {} };
  const event = { sender: renderer, senderFrame: renderer.mainFrame };
  const monitor = { watch: vi.fn(), inputModes: vi.fn(), setInputMode: vi.fn() };
  const lab = {
    start: vi.fn(),
    stop: vi.fn(),
    flush: vi.fn(async () => {}),
    getState: vi.fn(),
    read: vi.fn(),
    delete: vi.fn(),
    list: vi.fn(),
    retrySave: vi.fn(),
    listCalibrations: vi.fn(),
    saveCalibration: vi.fn(),
    deleteCalibration: vi.fn(),
  };
  const gate = { run: vi.fn((_channel: string, work: () => unknown) => work()) };
  registerIpc(
    () => renderer as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    gate as never,
    undefined,
    undefined,
    { monitor, lab } as never,
  );
  const call = (name: string, ...args: unknown[]) => handlers.get(name)!(event, ...args);
  return { event, lab, monitor, gate, call };
}
const id = "00000000-0000-4000-8000-000000000101";
const source = {
  id: "",
  kind: "input" as const,
  port: 0,
  type: 29,
  mode: 0,
  channel: 0,
  name: "Color",
  modeName: "COL-REFLECT",
  unit: "%",
  decimals: 0,
};
source.id = channelKey(source);
const request = {
  sessionId: id,
  name: "Trial",
  channels: [{ source, calibration: identityCalibration("%") }],
};

describe("sensor lab privileged IPC", () => {
  it("rejects other frames and validates recording IDs, channels and visibility", async () => {
    const { event, call, lab, monitor } = setup();
    for (const [name, fn] of handlers) {
      if (!name.startsWith("sensor-lab:") && name !== "device:watch-monitor") continue;
      expect(() => fn({ ...event, senderFrame: {} }, request)).toThrow("untrusted");
      expect(() => fn({ ...event, sender: { id: 2 } }, request)).toThrow("untrusted");
    }
    for (const name of ["read", "delete", "delete-calibration", "export"])
      expect(() => call(`sensor-lab:${name}`, "../../escape")).toThrow();
    for (const patch of [
      { sessionId: "invalid" },
      { channels: [] },
      { channels: Array(5).fill(request.channels[0]) },
      { path: "/tmp/escape" },
    ])
      expect(() => call("sensor-lab:start", { ...request, ...patch })).toThrow();
    expect(() =>
      call("sensor-lab:save-calibration", {
        ...request.channels[0],
        name: "Invalid",
        calibration: { ...identityCalibration("%"), sourceA: Infinity },
      }),
    ).toThrow();
    expect(() => call("device:watch-monitor", id, "true")).toThrow();
    await expect(call("sensor-lab:stop", "suspend")).rejects.toThrow();
    expect(lab.start).not.toHaveBeenCalled();
    expect(lab.saveCalibration).not.toHaveBeenCalled();
    expect(monitor.watch).not.toHaveBeenCalled();
  });
  it("routes operations through the update gate and requires a successful flush for close/update", async () => {
    const { call, lab, monitor, gate } = setup();
    call("device:watch-monitor", id, true);
    call("sensor-lab:start", request);
    expect(monitor.watch).toHaveBeenCalledWith(id, true);
    expect(lab.start).toHaveBeenCalledWith(request);
    expect(gate.run.mock.calls.map(([name]) => name)).toEqual([
      "device:watch-monitor",
      "sensor-lab:start",
    ]);
    await call("sensor-lab:stop");
    expect(lab.stop).toHaveBeenCalledWith("manual");
    lab.flush.mockRejectedValueOnce(new Error("disk full"));
    await expect(call("sensor-lab:stop", "close")).rejects.toThrow("disk full");
    expect(lab.getState).not.toHaveBeenCalled();
    await call("sensor-lab:stop", "update");
    expect(lab.flush).toHaveBeenLastCalledWith("update");
    expect(lab.getState).toHaveBeenCalledOnce();
  });
});
