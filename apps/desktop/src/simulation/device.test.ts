import { BasicPlusFrontend } from "@kobrixa/basic-plus";
import { describe, expect, it } from "vitest";
import type { Pixy2Block, RobotConfig } from "../shared/simulator.js";
import { PreviewRuntime } from "../preview/runtime.js";
import type { PreviewValue } from "../preview/virtual-device.js";
import { SimulationDevice, type SimulationSensorReading } from "./device.js";
import { SimulationMailboxBus } from "./mailbox.js";

const robot: RobotConfig = {
  id: "a1",
  name: "Alpha",
  team: "A",
  controller: { kind: "program", entry: "main.bp" },
  pose: { x: 0, y: 0, heading: 0 },
  drive: "differential",
  width: 150,
  length: 200,
  mass: 1,
  wheels: [],
  pusher: null,
  shooter: null,
  sensors: [
    { port: 1, kind: "color", x: 0, y: 0, angle: 0, range: 10, fov: 10 },
    { port: 2, kind: "vision", x: 0, y: 0, angle: 0, range: 2000, fov: 70 },
  ],
};
const teammate: RobotConfig = { ...robot, id: "a2", name: "Beta", sensors: [] };
const bus = () => new SimulationMailboxBus([robot, teammate]);
const call = (device: SimulationDevice, operation: string, ...args: PreviewValue[]) =>
  device.invoke(operation, args, 0);

async function program(content: string) {
  const result = await new BasicPlusFrontend().compile(
    {
      root: "/simulation",
      manifest: {
        schemaVersion: 1,
        name: "test",
        language: "bp",
        entry: "main.bp",
        target: "ev3-native",
        assets: [],
        outputDir: "build",
      },
      sources: [{ path: "main.bp", content }],
      assets: [],
    },
    new AbortController().signal,
  );
  expect(result.diagnostics.filter((item) => item.severity === "error")).toEqual([]);
  return result.ir!;
}

describe("world-backed simulation device", () => {
  it("refreshes environmental values immediately when program modes change", () => {
    const device = new SimulationDevice({
      robot,
      mailbox: bus(),
      readSensor: (sensor, mode) =>
        sensor.kind === "color" ? { si: [mode === 2 ? 5 : 42], percent: 42 } : { si: [0, 0, 0, 0] },
    });
    expect(call(device, "EV3.BrickName").value).toBe("Alpha");
    expect(call(device, "Sensor.GetName", 1).value).toBe("EV3-COLOR");
    expect(call(device, "Sensor.ReadSIValue", 1, 0).value).toBe(42);
    call(device, "Sensor.SetMode", 1, 2);
    expect(call(device, "Sensor.ReadSIValue", 1, 0).value).toBe(5);
    device.setInputs({ sensors: { 1: { si: [999] } }, buttons: ["enter"] });
    expect(call(device, "Sensor.ReadSIValue", 1, 0).value).toBe(5);
    expect(call(device, "Button.IsPressed", "enter").value).toBe(true);
  });

  it("exposes the synthetic vision identity, modes and four SI/raw channels", () => {
    let reading: SimulationSensorReading = { si: [1, -12.5, 350.75, 2] };
    const device = new SimulationDevice({ robot, mailbox: bus(), readSensor: () => reading });
    expect(call(device, "Sensor.GetName", 2).value).toBe("KOBRIXA-VISION");
    expect(call(device, "Sensor.GetType", 2).value).toBe(124);
    expect(call(device, "Sensor.ReadSIValue", 2, 1).value).toBe(-12.5);
    expect(call(device, "Sensor.ReadRaw", 2, 4).value).toEqual([1, -12, 350, 2]);
    expect(call(device, "Sensor.ReadPercent", 2).value).toBe(100);
    call(device, "Sensor.SetMode", 2, 1);
    expect(call(device, "Sensor.ReadRaw", 2, 4).value).toEqual([0, 0, 0, 0]);
    call(device, "Sensor.SetMode", 2, 2);
    expect(call(device, "Sensor.ReadRaw", 2, 4).value).toEqual([1, -12, 350, 2]);
    reading = { si: [0, 999, 999, 2] };
    expect(call(device, "Sensor.ReadRaw", 2, 4).value).toEqual([0, 0, 0, 0]);
    expect(() => call(device, "Sensor.SetMode", 2, 3)).toThrow("supports modes");
    expect(device.snapshot().sensors[2].mode).toBe(2);
  });

  it("reuses a static mailbox handle when a compiled loop reopens it", async () => {
    const device = new SimulationDevice({ robot, mailbox: bus(), readSensor: () => ({ si: [0] }) });
    const runtime = new PreviewRuntime(
      await program(`
For i = 1 To 100
  box = Mailbox.Create("loop")
EndFor
second = Mailbox.Create("other")
`),
      device,
      { clock: "external", sessionInstructionLimit: null },
    );
    runtime.resume();
    const tick = runtime.executeAt(0, 2000);
    expect(tick.status).toBe("completed");
    expect(runtime.getSnapshot().globals).toMatchObject({ box: 0, second: 1 });
  });

  it("blocks a compiled receive until teammate delivery on the next shared tick", async () => {
    const mailbox = bus();
    const receiver = new SimulationDevice({
      robot: teammate,
      mailbox,
      readSensor: () => ({ si: [0] }),
    });
    const sender = new SimulationDevice({ robot, mailbox, readSensor: () => ({ si: [0] }) });
    const runtime = new PreviewRuntime(
      await program(`
box = Mailbox.CreateForNumber("target")
received = Mailbox.ReceiveNumber(box)
`),
      receiver,
      { clock: "external", sessionInstructionLimit: null },
    );
    runtime.resume();
    expect(runtime.executeAt(0).status).toBe("running");
    call(sender, "Mailbox.SendNumber", "Beta", "target", 123.5);
    expect(runtime.executeAt(0).status).toBe("running");
    mailbox.commitTick();
    receiver.advance(10);
    expect(runtime.executeAt(10).status).toBe("completed");
    expect(runtime.getSnapshot().globals.received).toBe(123.5);
  });
});

describe("EV3 gyro UART reset", () => {
  const gyroRobot: RobotConfig = {
    ...robot,
    sensors: [
      { port: 2, kind: "gyro", x: 0, y: 0, angle: 0, range: 0, fov: 0 },
      { port: 4, kind: "gyro", x: 0, y: 0, angle: 0, range: 0, fov: 0 },
    ],
  };

  it("resets only the selected device and port, preserving subsequent motion and rate", () => {
    let angle = 123.75;
    const makeDevice = () =>
      new SimulationDevice({
        robot: gyroRobot,
        mailbox: bus(),
        readSensor: (_sensor, mode) => ({
          si: mode === 3 ? [angle, -24.5] : mode === 1 || mode === 2 ? [-24.5] : [angle],
        }),
      });
    const device = makeDevice();
    const independent = makeDevice();
    expect(call(device, "Sensor.ReadRawValue", 2, 0).value).toBe(123);
    device.invoke("Sensor.SendUARTData", [2, 1, [17]], 50);
    expect(call(device, "Sensor.ReadRawValue", 2, 0).value).toBe(0);
    expect(call(device, "Sensor.ReadSIValue", 2, 0).value).toBe(0);
    expect(call(device, "Sensor.Wait", 2)).toEqual({});
    expect(device.snapshot().sensors[2]).toMatchObject({ si: [0], raw: [0] });
    expect(device.snapshot().events.at(-1)).toMatchObject({
      timeMs: 50,
      operation: "Sensor.SendUARTData",
    });
    expect(call(device, "Sensor.ReadSIValue", 4, 0).value).toBe(123.75);
    expect(call(independent, "Sensor.ReadSIValue", 2, 0).value).toBe(123.75);

    angle = 103.25;
    expect(call(device, "Sensor.ReadSIValue", 2, 0).value).toBe(-20.5);
    expect(call(device, "Sensor.ReadRawValue", 2, 0).value).toBe(-20);
    call(device, "Sensor.SetMode", 2, 3);
    expect(call(device, "Sensor.ReadRaw", 2, 2).value).toEqual([-20, -24]);
    expect(device.snapshot().sensors[2].si).toEqual([-20.5, -24.5]);
    for (const mode of [1, 2]) {
      call(device, "Sensor.SetMode", 2, mode);
      expect(call(device, "Sensor.ReadSIValue", 2, 0).value).toBe(-24.5);
    }
    // Even when invoked in rate mode, the command resets the angle reference.
    call(device, "Sensor.SendUARTData", 2, 1, [17]);
    expect(call(device, "Sensor.ReadSIValue", 2, 0).value).toBe(-24.5);
    call(device, "Sensor.SetMode", 2, 0);
    expect(call(device, "Sensor.ReadSIValue", 2, 0).value).toBe(0);
    expect(call(makeDevice(), "Sensor.ReadSIValue", 2, 0).value).toBe(103.25);
  });

  it("rejects unsupported UART commands without changing the gyro reference", () => {
    const device = new SimulationDevice({
      robot: gyroRobot,
      mailbox: bus(),
      readSensor: () => ({ si: [45] }),
    });
    for (const args of [
      [0, 1, [17]],
      [5, 1, [17]],
      [2.5, 1, [17]],
      [1, 1, [17]],
      [2, 0, [17]],
      [2, 2, [17, 17]],
      [2, 1, 17],
      [2, 1, []],
      [2, 1, [NaN]],
      [2, 1, ["17"]],
      [2, 1, [18]],
      [2, 1],
    ] satisfies PreviewValue[][])
      expect(() => call(device, "Sensor.SendUARTData", ...args)).toThrow();
    expect(call(device, "Sensor.ReadSIValue", 2, 0).value).toBe(45);
    expect(device.snapshot().events).toEqual([]);
  });

  it("executes the original module's typed-array reset and delayed reset check", async () => {
    const device = new SimulationDevice({
      robot: gyroRobot,
      mailbox: bus(),
      readSensor: () => ({ si: [72.5] }),
    });
    const runtime = new PreviewRuntime(
      await program(`
Sensor.SetMode(2, 0)
before = Sensor.ReadRawValue(2, 0)
gyroResetData[0] = 17
Sensor.SendUARTData(2, 1, gyroResetData)
Sensor.Wait(2)
Program.Delay(600)
gyroResetResult = "False"
If Sensor.ReadRawValue(2, 0) = 0 Then
  gyroResetResult = "True"
EndIf
`),
      device,
      { clock: "external", sessionInstructionLimit: null },
    );
    runtime.resume();
    expect(runtime.executeAt(0, 1000).status).toBe("running");
    expect(runtime.executeAt(590, 1000).status).toBe("running");
    expect(runtime.executeAt(600, 1000).status).toBe("completed");
    expect(runtime.getSnapshot().globals).toMatchObject({ before: 72, gyroresetresult: "True" });
  });
});

describe("Pixy2 simulation device", () => {
  const cameraRobot: RobotConfig = {
    ...robot,
    sensors: [
      { port: 1, kind: "pixy2", x: 0, y: 0, angle: 0, range: 2000, fov: 60 },
      { port: 3, kind: "pixy2", x: 0, y: 0, angle: 90, range: 2000, fov: 60 },
    ],
  };
  const blocks: Pixy2Block[] = [
    { signature: 2, x: 201, y: 181, width: 21, height: 31 },
    { signature: 1, x: 120, y: 100, width: 15, height: 24 },
    { signature: 2, x: 240, y: 190, width: 10, height: 20 },
  ];
  const makeDevice = () =>
    new SimulationDevice({
      robot: cameraRobot,
      mailbox: bus(),
      readSensor: (sensor) => ({ si: [999], pixy2: sensor.port === 1 ? blocks : [] }),
    });

  it("routes LEGO register APIs to the selected camera and returns native unsigned arrays", () => {
    const device = makeDevice();
    expect(call(device, "Sensor.ReadI2CRegisters", 1, 1, 0x50, 6).value).toEqual([
      2, 0, 201, 181, 21, 31,
    ]);
    expect(call(device, "Sensor.ReadI2CRegisters", 1, 1, 0x52, 5).value).toEqual([
      2, 201, 181, 21, 31,
    ]);
    expect(call(device, "Sensor.ReadI2CRegister", 1, 1, 0x42).value).toBe(201);
    expect(call(device, "Sensor.CommunicateI2C", 1, 1, 1, 5, [0x52, 0xff]).value).toEqual([
      2, 201, 181, 21, 31,
    ]);
    expect(call(device, "Sensor.ReadI2CRegisters", 3, 1, 0x52, 5).value).toEqual([0, 0, 0, 0, 0]);
  });

  it("exposes only X in mode-0 port view instead of synthetic vision channels", () => {
    const device = makeDevice();
    expect(call(device, "Sensor.GetName", 1).value).toBe("Pixy2");
    expect(call(device, "Sensor.GetType", 1).value).toBe(100);
    expect(call(device, "Sensor.ReadSIValue", 1, 0).value).toBe(201);
    expect(call(device, "Sensor.ReadSIValue", 1, 1).value).toBeNaN();
    expect(call(device, "Sensor.ReadRawValue", 1, 0).value).toBe(201);
    expect(call(device, "Sensor.ReadRaw", 1, 1).value).toEqual([201]);
    expect(call(device, "Sensor.ReadPercent", 1).value).toBe(79);
    expect(call(device, "Sensor.ReadSIValue", 3, 0).value).toBe(0);
    call(device, "Sensor.SetMode", 1, 0);
    expect(() => call(device, "Sensor.SetMode", 1, 1)).toThrow("select signatures with I2C");
    expect(call(device, "Sensor.GetMode", 1).value).toBe(0);
    expect(device.snapshot().sensors[1]).toMatchObject({
      name: "Pixy2",
      mode: 0,
      si: [201],
      raw: [201],
    });
  });

  it("records per-camera lamp writes, wrapping numeric bytes as the backend does", () => {
    const device = makeDevice();
    const independent = makeDevice();
    device.invoke("Sensor.WriteI2CRegister", [1, 1, 0x62, 257], 50);
    call(device, "Sensor.WriteI2CRegisters", 3, 1, 0x62, 1, [0, 1]);
    expect(call(device, "Sensor.CommunicateI2C", 1, 1, 2, 1, [354.9, -1]).value).toEqual([1]);
    const events = device.snapshot().events;
    expect(events).toHaveLength(3);
    expect(events[0]).toMatchObject({ timeMs: 50, operation: "Sensor.WriteI2CRegister" });
    expect(events[0]!.detail).toContain("Pixy2 S1 lamp on");
    expect(events[1]!.detail).toContain("Pixy2 S3 lamp off");
    expect(independent.snapshot().events).toEqual([]);
    expect(makeDevice().snapshot().events).toEqual([]);
    expect(call(device, "Sensor.ReadI2CRegisters", 1, 1, 0x52, 5).value).toEqual([
      2, 201, 181, 21, 31,
    ]);
  });

  it("rejects unsupported devices, addresses and malformed payloads without fake replies", () => {
    const device = makeDevice();
    for (const port of [0, 5, 1.5])
      expect(() => call(device, "Sensor.ReadI2CRegister", port, 1, 0x42)).toThrow("sensor port");
    for (const address of [0, 2, 84, 256, "1"])
      expect(() => call(device, "Sensor.ReadI2CRegister", 1, address, 0x42)).toThrow("address 1");
    expect(() => call(device, "Sensor.ReadI2CRegister", 2, 1, 0x42)).toThrow("no simulated Pixy2");
    expect(() => call(device, "Sensor.ReadI2CRegisters", 1, 1, 0x50, 0)).toThrow("read byte count");
    expect(() => call(device, "Sensor.ReadI2CRegisters", 1, 1, 0x50, 33)).toThrow(
      "read byte count",
    );
    expect(() => call(device, "Sensor.ReadI2CRegister", 1, 1, 256)).toThrow("register");
    expect(() => call(device, "Sensor.ReadI2CRegister", 1, 1)).toThrow("3 arguments");
    for (const payload of [0x62, "98", [], [NaN], [true], [[0x62]]])
      expect(() => call(device, "Sensor.CommunicateI2C", 1, 1, 1, 1, payload)).toThrow("payload");
    expect(() => call(device, "Sensor.CommunicateI2C", 1, 1, 2, 1, [0x62])).toThrow("at least 2");
    expect(() => call(device, "Sensor.CommunicateI2C", 1, 1, 32, 1, [])).toThrow(
      "write byte count",
    );
    expect(() => call(device, "Sensor.WriteI2CRegisters", 1, 1, 0x62, 31, [])).toThrow(
      "write byte count",
    );
    expect(() => call(device, "Sensor.WriteI2CRegister", 1, 1, 0x62, Infinity)).toThrow(
      "finite numbers",
    );
    expect(device.snapshot().events).toEqual([]);
  });

  it("executes repeated typed-array camera helpers and communication in compiled Basic Plus", async () => {
    const device = makeDevice();
    const runtime = new PreviewRuntime(
      await program(`
For i = 1 To 100
  ReadTarget(1, 2, count, x)
EndFor
command[0] = 98
command[1] = 1
ack = Sensor.CommunicateI2C(1, 1, 2, 1, command)
Sensor.WriteI2CRegister(1, 1, 98, 0)
lamp[0] = 1
Sensor.WriteI2CRegisters(1, 1, 98, 1, lamp)
Function ReadTarget(in number port, in number signature, out number count, out number x)
  result = Sensor.ReadI2CRegisters(port, 1, 80 + signature, 5)
  count = result[0]
  x = result[1]
EndFunction
`),
      device,
      { clock: "external", sessionInstructionLimit: null },
    );
    runtime.resume();
    for (let time = 0; time < 200 && runtime.status === "running"; time += 10)
      runtime.executeAt(time, 1000);
    expect(runtime.getSnapshot().status).toBe("completed");
    expect(runtime.getSnapshot().globals).toMatchObject({ count: 2, x: 201, ack: [1] });
    expect(
      device.snapshot().events.filter((event) => event.operation.startsWith("Sensor.")),
    ).toHaveLength(3);
  });
});
