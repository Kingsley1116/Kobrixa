import { randomUUID } from "node:crypto";
import { rename, rm, writeFile } from "node:fs/promises";
import { dialog } from "electron";
import type { SensorLabService } from "./sensor-lab/service.js";

export async function exportSensorCsv(
  lab: Pick<SensorLabService, "read" | "exportCSVContent">,
  id: string,
): Promise<{ cancelled: boolean }> {
  const recording = await lab.read(id);
  const content = await lab.exportCSVContent(id);
  const result = await dialog.showSaveDialog({
    title: "Export sensor data / 匯出感測器資料",
    defaultPath: `${recording.name.replace(/[^\p{L}\p{N}_. -]/gu, "_").slice(0, 80) || "sensor-data"}.csv`,
    filters: [{ name: "CSV", extensions: ["csv"] }],
  });
  if (result.canceled || !result.filePath) return { cancelled: true };
  const temporary = `${result.filePath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporary, result.filePath);
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
  return { cancelled: false };
}
