import type * as FileSystem from "node:fs/promises";
import { rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dialog } from "electron";
import { exportSensorCsv } from "./sensor-lab-export.js";
import { sensorRecordingCsv } from "./sensor-lab/csv.js";
import { channelKey, type SensorRecording } from "../shared/sensor-lab.js";
import { identityCalibration } from "../shared/sensor-calibration.js";

vi.mock("electron", () => ({ dialog: { showSaveDialog: vi.fn() } }));
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof FileSystem>();
  return {
    ...actual,
    writeFile: vi.fn(actual.writeFile),
    rename: vi.fn(actual.rename),
    rm: vi.fn(actual.rm),
  };
});
const actual = await vi.importActual<typeof FileSystem>("node:fs/promises");
const directories: string[] = [];
beforeEach(() => {
  vi.mocked(writeFile).mockReset().mockImplementation(actual.writeFile);
  vi.mocked(rename).mockReset().mockImplementation(actual.rename);
  vi.mocked(rm).mockReset().mockImplementation(actual.rm);
  vi.mocked(dialog.showSaveDialog).mockReset();
});
afterEach(async () => {
  for (const directory of directories.splice(0))
    await actual.rm(directory, { recursive: true, force: true });
});

async function setup() {
  const directory = await actual.mkdtemp(path.join(os.tmpdir(), "kobrixa-sensor-export-"));
  directories.push(directory);
  const destination = path.join(directory, "readings.csv");
  await actual.writeFile(destination, "existing file");
  const source = {
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
  const record: SensorRecording = {
    schemaVersion: 1,
    id: "0e8e71c7-e6e0-4883-ae76-15e1c5a77f13",
    name: '校正 / Run "one"',
    startedAt: 1000,
    endedAt: 2000,
    durationMs: 1000,
    frameCount: 1,
    reason: "manual",
    device: { id: "usb", name: "EV3", transport: "usb" },
    channels: [
      { source: { ...source, id: channelKey(source) }, calibration: identityCalibration("%") },
    ],
    frames: [{ sampledAt: 1000, elapsedMs: 0, values: [42], status: "ok", segment: 0 }],
  };
  const lab = {
    read: vi.fn(async () => record),
    exportCSVContent: vi.fn(async () => sensorRecordingCsv(record)),
  };
  vi.mocked(dialog.showSaveDialog).mockResolvedValue({ canceled: false, filePath: destination });
  return { lab, record, destination, directory, run: () => exportSensorCsv(lab, record.id) };
}

describe("native sensor CSV export", () => {
  it.each([
    { canceled: true, filePath: "/unused.csv" },
    { canceled: false, filePath: "" },
  ])(
    "does not write when the native dialog is cancelled or has no path ($canceled)",
    async (answer) => {
      const h = await setup();
      vi.mocked(dialog.showSaveDialog).mockResolvedValue(answer);
      await expect(h.run()).resolves.toEqual({ cancelled: true });
      expect(writeFile).not.toHaveBeenCalled();
      expect(rename).not.toHaveBeenCalled();
      expect(rm).not.toHaveBeenCalled();
      expect(await actual.readFile(h.destination, "utf8")).toBe("existing file");
    },
  );
  it("writes a BOM-prefixed CSV atomically and cleans its temporary path", async () => {
    const h = await setup();
    await expect(h.run()).resolves.toEqual({ cancelled: false });
    expect(h.lab.exportCSVContent).toHaveBeenCalledWith(h.record.id);
    expect(dialog.showSaveDialog).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultPath: "校正 _ Run _one_.csv",
        filters: [{ name: "CSV", extensions: ["csv"] }],
      }),
    );
    const bytes = await actual.readFile(h.destination);
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(bytes.toString("utf8")).toBe(sensorRecordingCsv(h.record));
    const temporary = vi.mocked(writeFile).mock.calls[0]![0];
    expect(temporary).not.toBe(h.destination);
    expect(path.dirname(String(temporary))).toBe(h.directory);
    expect(writeFile).toHaveBeenCalledWith(temporary, expect.any(String), {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    expect(rename).toHaveBeenCalledWith(temporary, h.destination);
    expect(rm).toHaveBeenCalledWith(temporary, { force: true });
    expect(await actual.readdir(h.directory)).toEqual(["readings.csv"]);
  });
  it("rejects a failed partial write, keeps the destination and removes the partial temporary file", async () => {
    const h = await setup();
    vi.mocked(writeFile).mockImplementationOnce(async (file, _content, options) => {
      await actual.writeFile(file, "partial CSV", options);
      throw new Error("Disk full");
    });
    await expect(h.run()).rejects.toThrow("Disk full");
    expect(rename).not.toHaveBeenCalled();
    expect(rm).toHaveBeenCalledOnce();
    expect(await actual.readFile(h.destination, "utf8")).toBe("existing file");
    expect(await actual.readdir(h.directory)).toEqual(["readings.csv"]);
  });
  it("rejects a failed rename, keeps the destination and cleans the completed temporary file", async () => {
    const h = await setup();
    vi.mocked(rename).mockRejectedValueOnce(new Error("Destination is locked"));
    await expect(h.run()).rejects.toThrow("Destination is locked");
    expect(writeFile).toHaveBeenCalledOnce();
    expect(rm).toHaveBeenCalledOnce();
    expect(await actual.readFile(h.destination, "utf8")).toBe("existing file");
    expect(await actual.readdir(h.directory)).toEqual(["readings.csv"]);
  });
  it("does not mask the export error when temporary-file cleanup also fails", async () => {
    const h = await setup();
    vi.mocked(rename).mockRejectedValueOnce(new Error("Rename failed"));
    vi.mocked(rm).mockRejectedValueOnce(new Error("Cleanup failed"));
    await expect(h.run()).rejects.toThrow("Rename failed");
    expect(await actual.readFile(h.destination, "utf8")).toBe("existing file");
  });
});
