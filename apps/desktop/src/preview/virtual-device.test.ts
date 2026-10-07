import { describe, expect, it } from "vitest";
import { VirtualDevice, type PreviewValue } from "./virtual-device.js";

function call(device: VirtualDevice, operation: string, ...args: PreviewValue[]) {
  return device.invoke(operation, args, device.snapshot().timeMs);
}
function pixel(device: VirtualDevice, x: number, y: number): number {
  return device.snapshot().lcd.pixels[y * 178 + x]!;
}

describe("virtual LCD", () => {
  it("clips shapes, commits buffered updates and preserves snapshots", () => {
    const device = new VirtualDevice();
    call(device, "LCD.StopUpdate");
    call(device, "LCD.FillRect", 1, -2, -2, 4, 4);
    expect(pixel(device, 0, 0)).toBe(0);
    call(device, "LCD.Update");
    expect(pixel(device, 0, 0)).toBe(1);
    expect(pixel(device, 1, 1)).toBe(1);
    expect(pixel(device, 2, 2)).toBe(0);
    const snapshot = device.snapshot();
    call(device, "LCD.InverseRect", 0, 0, 2, 1);
    expect(pixel(device, 0, 0)).toBe(0);
    expect(pixel(device, 0, 1)).toBe(1);
    expect(snapshot.lcd.pixels[0]).toBe(1);
    call(device, "LCD.Clear");
    expect(device.snapshot().lcd.pixels.every((value) => value === 0)).toBe(true);
  });

  it("renders lines and circle edges with bounded work for offscreen geometry", () => {
    const device = new VirtualDevice();
    call(device, "LCD.Line", 1, -1_000_000_000, 10, 1_000_000_000, 10);
    expect(pixel(device, 0, 10)).toBe(1);
    expect(pixel(device, 177, 10)).toBe(1);
    call(device, "LCD.Circle", 1, 20, 20, 5);
    expect(pixel(device, 25, 20)).toBe(1);
    expect(pixel(device, 20, 20)).toBe(0);
    call(device, "LCD.FillCircle", 1, 20, 20, 3);
    expect(pixel(device, 20, 20)).toBe(1);
    call(device, "LCD.Rect", 1, 30, 30, 4, 4);
    expect(pixel(device, 30, 30)).toBe(1);
    expect(pixel(device, 31, 31)).toBe(0);
  });

  it("rasterizes mixed-case text and displays bitmap assets in LSB-first order", () => {
    const device = new VirtualDevice({ files: { "assets/image.rgf": [8, 2, 1, 128] } });
    call(device, "LCD.Text", 1, 0, 0, 2, "Aa0");
    expect(device.snapshot().lcd.pixels.some((value) => value === 1)).toBe(true);
    expect(device.snapshot().events.at(-1)?.detail).toBe("Aa0");
    call(device, "LCD.BmpFile", 1, 10, 20, "assets/image");
    expect(pixel(device, 10, 20)).toBe(1);
    expect(pixel(device, 17, 21)).toBe(1);
    expect(pixel(device, 11, 20)).toBe(0);
    expect(() => call(device, "LCD.BmpFile", 1, 0, 0, "missing")).toThrow("resource unavailable");
  });
});

describe("virtual motor model", () => {
  it("keeps a stalled scheduled wheel pending and resumes the remaining shaft travel", () => {
    const device = new VirtualDevice();
    call(device, "Motor.Schedule", "B", 100, 0, 7.2, 0, true);
    device.advance(10);
    const attempted = device.consumeShaftDeltas().B;
    device.constrainShaftTravel("B", attempted, 0);
    expect(device.motorStates().B).toMatchObject({ count: 0, speed: 100, busy: true });
    call(device, "Motor.ResetCount", "B");
    device.advance(10);
    expect(device.consumeShaftDeltas().B).toBe(attempted);
    expect(device.motorStates().B).toMatchObject({ count: attempted, speed: 0, busy: false });
    expect(() => device.constrainShaftTravel("B", 7, -2)).toThrow("Invalid traction");
    expect(() => device.constrainShaftTravel("B", 7, 8)).toThrow("Invalid traction");
  });
  it("reports shaft motion independently of encoder resets and without LCD snapshots", () => {
    const device = new VirtualDevice();
    call(device, "Motor.Start", "AB", 100);
    device.advance(10);
    call(device, "Motor.ResetCount", "A");
    device.advance(10);
    expect(device.motorStates().A).toMatchObject({ count: 7.2, speed: 100, setting: 100 });
    expect(device.motorStates().B.count).toBe(14.4);
    expect(device.consumeShaftDeltas()).toEqual({ A: 14.4, B: 14.4, C: 0, D: 0 });
    expect(device.consumeShaftDeltas()).toEqual({ A: 0, B: 0, C: 0, D: 0 });
    call(device, "Motor.Invert", "A");
    device.advance(10);
    expect(device.consumeShaftDeltas().A).toBe(-7.2);
  });
  it("moves a fixed angle over virtual time and stops with the requested brake", () => {
    const device = new VirtualDevice();
    const result = call(device, "Motor.Move", "A", 50, 180, true);
    expect(result.waitMs).toBe(500);
    device.advance(250);
    expect(call(device, "Motor.GetCount", "A").value).toBe(90);
    expect(call(device, "Motor.IsBusy", "A").value).toBe(true);
    device.advance(500);
    expect(call(device, "Motor.GetCount", "A").value).toBe(180);
    expect(call(device, "Motor.IsBusy", "A").value).toBe(false);
    expect(device.snapshot().motors.A).toMatchObject({ speed: 0, brake: true });
  });

  it("supports scheduled motion, polarity, reset and manual stop", () => {
    const device = new VirtualDevice();
    call(device, "Motor.Invert", "B");
    call(device, "Motor.Schedule", "B", 100, 20, 40, 12, false);
    expect(call(device, "Motor.Wait", "B")).toEqual({ waitMs: 16, retry: true });
    device.advance(100);
    expect(call(device, "Motor.GetCount", "B").value).toBe(-72);
    expect(call(device, "Motor.Wait", "B")).toEqual({});
    call(device, "Motor.ResetCount", "B");
    call(device, "Motor.Start", "B", 1000);
    device.advance(100);
    expect(call(device, "Motor.GetSpeed", "B").value).toBe(-100);
    expect(call(device, "Motor.GetCount", "B").value).toBe(-72);
    call(device, "Motor.Stop", "B", true);
    device.advance(1000);
    expect(call(device, "Motor.GetCount", "B").value).toBe(-72);
  });

  it("keeps synchronized motors in proportion and supports legacy calls", () => {
    const device = new VirtualDevice();
    expect(call(device, "Motor.MoveSync", "AB", 100, -50, 720, true).waitMs).toBe(1000);
    device.advance(1000);
    expect(device.snapshot().motors.A.count).toBe(720);
    expect(device.snapshot().motors.B.count).toBe(-360);
    call(device, "MotorC.SetPower", 25);
    expect(call(device, "MotorC.GetSpeed").value).toBe(0);
    call(device, "MotorC.Start");
    device.advance(1000);
    expect(call(device, "MotorC.GetTacho").value).toBe(180);
    call(device, "MotorC.OffAndBrake");
    expect(device.snapshot().motors.C).toMatchObject({ busy: false, brake: true });
  });
});

describe("virtual controls and time", () => {
  it("orders button strings like the backend and consumes released clicks once", () => {
    const device = new VirtualDevice();
    expect(call(device, "Buttons.Wait").retry).toBe(true);
    device.setInputs({ buttons: ["enter", "up", "back"] });
    expect(call(device, "Buttons.Current").value).toBe("UE");
    expect(call(device, "Button.IsPressed", "CENTER").value).toBe(true);
    expect(call(device, "Button.IsPressed", "ANY").value).toBe(true);
    expect(call(device, "Buttons.Wait")).toEqual({});
    device.setInputs({ buttons: [] });
    expect(call(device, "Buttons.GetClicks").value).toBe("UE");
    expect(call(device, "Buttons.GetClicks").value).toBe("");
  });

  it("keeps separate SI/raw channels, updates modes and writes legacy Raw3 outputs", () => {
    const device = new VirtualDevice();
    device.setInputs({
      sensors: {
        2: { type: 29, name: "EV3-COLOR", raw: [10, 20, 30], si: [1.25, 2.5], percent: 60 },
      },
    });
    expect(call(device, "Sensor.ReadSIValue", 2, 0).value).toBe(1.25);
    expect(call(device, "Sensor.ReadRawValue", 2, 1).value).toBe(20);
    expect(call(device, "Sensor.ReadRawValue", 2, -1).value).toBe(0);
    expect(call(device, "Sensor.ReadPercent", 2).value).toBe(60);
    expect(call(device, "Sensor.ReadRaw", 2, 5).value).toEqual([10, 20, 30, 0, 0]);
    expect(call(device, "Sensor2.Raw3", 0, 0, 0).writes).toEqual({ 0: 10, 1: 20, 2: 30 });
    call(device, "Sensor.SetMode", 2, 4);
    expect(call(device, "Sensor.GetMode", 2).value).toBe(4);
    device.setInputs({ sensors: { 2: { busy: true } } });
    expect(call(device, "Sensor.Wait", 2).retry).toBe(true);
    expect(call(device, "Sensor2.Raw1").retry).toBe(true);
    const copy = device.snapshot();
    copy.sensors[2].raw[0] = 999;
    expect(call(device, "Sensor2.Raw3", 0, 0, 0).retry).toBe(true);
    device.setInputs({ sensors: { 2: { busy: false } } });
    expect(call(device, "Sensor2.Raw1").value).toBe(10);
  });

  it("uses deterministic timers, delays, batteries and speaker deadlines", () => {
    const device = new VirtualDevice();
    device.advance(100);
    call(device, "Time.Reset1");
    device.advance(250);
    expect(call(device, "Time.Get1").value).toBe(250);
    expect(call(device, "Time.Get2").value).toBe(350);
    expect(call(device, "Program.Delay", 20)).toEqual({ waitMs: 20 });
    device.setInputs({ batteryLevel: 70, batteryVoltage: 7.5 });
    expect(call(device, "EV3.BatteryLevel").value).toBe(70);
    expect(call(device, "EV3.BatteryVoltage").value).toBe(7.5);
    call(device, "Speaker.Note", 50, "A4", 100);
    expect(device.snapshot().speaker).toEqual({ busy: true, frequency: 440, volume: 50 });
    expect(call(device, "Speaker.Wait")).toEqual({ waitMs: 100 });
    device.advance(100);
    expect(call(device, "Speaker.IsBusy").value).toBe(false);
    expect(call(device, "Program.End")).toEqual({ end: true });
  });

  it("returns missing SI data as NaN without aliasing invalid dynamic arguments", () => {
    const device = new VirtualDevice();
    expect(call(device, "Sensor.ReadSIValue", 1, 0).value).toBeNaN();
    device.setInputs({ sensors: { 1: { type: 29, mode: 0, si: [0, 1.25, 1e100] } } });
    expect(call(device, "Sensor.ReadSIValue", 1, 0).value).toBe(0);
    expect(call(device, "Sensor.ReadSIValue", 1, 1).value).toBe(1.25);
    for (const index of [-1, 0.5, 2, 3, 8, NaN, Infinity])
      expect(call(device, "Sensor.ReadSIValue", 1, index).value).toBeNaN();
    for (const port of [0, 1.5, 17, NaN, Infinity])
      expect(call(device, "Sensor.ReadSIValue", port, 0).value).toBeNaN();
    device.setInputs({ sensors: { 1: { busy: true } } });
    expect(call(device, "Sensor.ReadSIValue", 1, 0)).toEqual({ value: NaN });
    device.setInputs({ sensors: { 1: { busy: false, mode: 8 } } });
    expect(call(device, "Sensor.ReadSIValue", 1, 0).value).toBeNaN();
    for (const type of [0, 125, 126, 127]) {
      device.setInputs({ sensors: { 1: { type, mode: 0 } } });
      expect(call(device, "Sensor.ReadSIValue", 1, 0).value).toBeNaN();
    }
  });

  it("reads PCM RSF duration without accessing an audio device", () => {
    const device = new VirtualDevice({
      files: { "ping.rsf": [1, 0, 0, 8, 0x1f, 0x40, 0, 0, ...new Array<number>(8).fill(128)] },
    });
    call(device, "Speaker.Play", 80, "ping");
    expect(call(device, "Speaker.Wait")).toEqual({ waitMs: 1 });
  });
});

describe("isolated preview files and limits", () => {
  it("round-trips text, bytes and little-endian number arrays within a run", () => {
    const device = new VirtualDevice({ runtimeDirectory: "/home/root/lms2012/prjs/test" });
    const writer = call(device, "EV3File.OpenWrite", "log.txt").value!;
    call(device, "EV3File.WriteLine", writer, "hello");
    call(device, "EV3File.WriteByte", writer, 255);
    call(device, "EV3File.WriteNumberArray", writer, 2, [1.5, -2.25]);
    call(device, "EV3File.Close", writer);
    const reader = call(device, "EV3File.OpenRead", "/home/root/lms2012/prjs/test/log.txt").value!;
    expect(call(device, "EV3File.ReadLine", reader).value).toBe("hello");
    expect(call(device, "EV3File.ReadByte", reader).value).toBe(255);
    expect(call(device, "EV3File.ReadNumberArray", reader, 2).value).toEqual([1.5, -2.25]);
    expect(() => call(device, "EV3File.WriteLine", reader, "no")).toThrow("read-only");
    expect(call(device, "Program.Directory").value).toBe("/home/root/lms2012/prjs/test");
    const fresh = new VirtualDevice({ runtimeDirectory: "/home/root/lms2012/prjs/test" });
    expect(() => call(fresh, "EV3File.OpenRead", "log.txt")).toThrow("does not exist");
  });

  it("supports append and byte table lookups", () => {
    const device = new VirtualDevice({ files: { "table.bin": [1, 2, 3, 4] } });
    const writer = call(device, "EV3File.OpenAppend", "table.bin").value!;
    call(device, "EV3File.WriteByte", writer, 5);
    expect(call(device, "EV3File.TableLookup", "table.bin", 2, 1, 2).value).toBe(5);
  });

  it("bounds memory and logs and rejects unavailable physical operations", () => {
    const device = new VirtualDevice();
    for (let index = 0; index < 210; index++) call(device, "EV3.SetLEDColor", "GREEN", "NORMAL");
    expect(device.snapshot().events).toHaveLength(200);
    expect(device.snapshot().events[0]?.id).toBe(11);
    expect(() => call(device, "Sensor.ReadRaw", 1, 100000)).toThrow("array limit");
    expect(() => call(device, "Motor.Start", "A2", 10)).toThrow("local motor ports");
    expect(() => call(device, "Sensor.ReadSIValue", 5, 0)).toThrow("ports 1–4");
    expect(() => call(device, "Sensor.ReadI2CRegister", 1, 0, 0)).toThrow("physical sensor bus");
    expect(() => call(device, "EV3.SystemCall", "rm anything")).toThrow(
      "unavailable in offline preview",
    );
    expect(() => call(device, "Mailbox.Send", "other", "box", "text")).toThrow(
      "unavailable in offline preview",
    );
    expect(
      () => new VirtualDevice({ files: { huge: new Array<number>(1024 * 1024 + 1).fill(0) } }),
    ).toThrow("1 MiB");
  });
});
