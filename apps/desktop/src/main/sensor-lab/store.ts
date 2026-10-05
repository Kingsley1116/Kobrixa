import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type {
  CalibrationProfile,
  SensorRecording,
  SensorRecordingSummary,
} from "../../shared/sensor-lab.js";
import { calibrationProfileSchema, sensorLabIdSchema, sensorRecordingSchema } from "./schema.js";

type AtomicWriter = (target: string, content: string) => Promise<void>;
const envelope = z
  .object({ schemaVersion: z.literal(1), profile: calibrationProfileSchema })
  .strict();
const MAX_FILE_BYTES = 8 * 1024 * 1024;

export async function atomicSensorLabWrite(target: string, content: string): Promise<void> {
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
}

export function recordingSummary(record: SensorRecording): SensorRecordingSummary {
  const { id, name, startedAt, endedAt, durationMs, frameCount, reason } = record;
  return { id, name, startedAt, endedAt, durationMs, frameCount, reason };
}

/** Only generated UUIDs become paths. Failed writes remain in memory for an explicit retry. */
export class SensorLabStore {
  private records = new Map<string, SensorRecording>();
  private profiles = new Map<string, CalibrationProfile>();
  private dirty = new Map<string, { revision: number; kind: "recordings" | "calibrations" }>();
  private revision = 0;
  private pending: Promise<unknown> = Promise.resolve();
  private ready: Promise<string[]> | undefined;

  constructor(
    private directory: string,
    private write: AtomicWriter = atomicSensorLabWrite,
  ) {}

  initialize(): Promise<string[]> {
    this.ready ??= this.load().catch((error) => {
      this.ready = undefined;
      throw error;
    });
    return this.ready;
  }

  private file(kind: "recordings" | "calibrations", id: string): string {
    return path.join(this.directory, kind, `${sensorLabIdSchema.parse(id)}.json`);
  }

  private async load(): Promise<string[]> {
    const issues: string[] = [];
    for (const directory of [
      this.directory,
      path.join(this.directory, "recordings"),
      path.join(this.directory, "calibrations"),
    ]) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      if (!(await lstat(directory)).isDirectory())
        throw new Error("Invalid sensor lab storage directory.");
    }
    for (const kind of ["recordings", "calibrations"] as const) {
      for (const filename of await readdir(path.join(this.directory, kind))) {
        if (
          !filename.endsWith(".json") ||
          !sensorLabIdSchema.safeParse(filename.slice(0, -5)).success
        )
          continue;
        const target = path.join(this.directory, kind, filename);
        try {
          const stat = await lstat(target);
          if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error("Invalid file.");
          const data: unknown = JSON.parse(await readFile(target, "utf8"));
          if (kind === "recordings") {
            const record = sensorRecordingSchema.parse(data);
            if (`${record.id}.json` !== filename) throw new Error("Invalid identity.");
            if (record.endedAt === undefined) {
              record.endedAt = record.frames.at(-1)?.sampledAt ?? record.startedAt;
              record.reason = "interrupted";
              this.markDirty(kind, record.id);
              issues.push(`Recovered interrupted recording: ${record.name}`);
            }
            this.records.set(record.id, record);
          } else {
            const { profile } = envelope.parse(data);
            if (`${profile.id}.json` !== filename) throw new Error("Invalid identity.");
            this.profiles.set(profile.id, profile);
          }
        } catch (error) {
          // Permission and filesystem failures are actionable; they are not corrupt documents.
          if (
            error &&
            typeof error === "object" &&
            "code" in error &&
            typeof error.code === "string" &&
            error.code !== "ENOENT"
          )
            throw error;
          const quarantine = path.join(this.directory, "corrupt");
          await mkdir(quarantine, { recursive: true, mode: 0o700 });
          if (!(await lstat(quarantine)).isDirectory())
            throw new Error("Invalid recovery directory.");
          await rename(target, path.join(quarantine, `${kind}-${filename}-${randomUUID()}`));
          issues.push(
            `An unreadable ${kind === "recordings" ? "recording" : "calibration"} was moved to recovery storage: ${filename}`,
          );
        }
      }
    }
    return issues;
  }

  private markDirty(kind: "recordings" | "calibrations", id: string): void {
    this.dirty.set(id, { kind, revision: ++this.revision });
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.pending.then(work);
    this.pending = result.catch(() => {});
    return result;
  }

  get hasUnsaved(): boolean {
    return this.dirty.size > 0;
  }

  async list(): Promise<SensorRecordingSummary[]> {
    await this.initialize();
    return [...this.records.values()]
      .map(recordingSummary)
      .sort((a, b) => b.startedAt - a.startedAt || b.id.localeCompare(a.id));
  }

  async read(id: string): Promise<SensorRecording> {
    await this.initialize();
    const value = this.records.get(sensorLabIdSchema.parse(id));
    if (!value) throw new Error("Recording is no longer available.");
    return structuredClone(value);
  }

  async save(record: SensorRecording): Promise<void> {
    await this.initialize();
    const copy = sensorRecordingSchema.parse(record);
    this.records.set(copy.id, copy);
    this.markDirty("recordings", copy.id);
    await this.persist(copy.id);
  }

  private persist(id: string): Promise<void> {
    const dirty = this.dirty.get(id);
    if (!dirty) return Promise.resolve();
    const content = JSON.stringify(
      dirty.kind === "recordings"
        ? this.records.get(id)
        : { schemaVersion: 1, profile: this.profiles.get(id) },
    );
    return this.serial(async () => {
      await this.write(this.file(dirty.kind, id), content);
      if (this.dirty.get(id)?.revision === dirty.revision) this.dirty.delete(id);
    });
  }

  async flush(): Promise<void> {
    await this.initialize();
    for (const id of this.dirty.keys()) await this.persist(id);
    await this.pending;
  }

  async delete(id: string): Promise<void> {
    await this.initialize();
    sensorLabIdSchema.parse(id);
    await this.serial(async () => {
      await rm(this.file("recordings", id), { force: true });
      this.records.delete(id);
      this.dirty.delete(id);
    });
  }

  async listCalibrations(): Promise<CalibrationProfile[]> {
    await this.initialize();
    return structuredClone(
      [...this.profiles.values()].sort((a, b) => a.name.localeCompare(b.name)),
    );
  }

  async saveCalibration(profile: CalibrationProfile): Promise<CalibrationProfile> {
    await this.initialize();
    const value = calibrationProfileSchema.parse(profile);
    this.profiles.set(value.id, value);
    this.markDirty("calibrations", value.id);
    await this.persist(value.id);
    return structuredClone(value);
  }

  async deleteCalibration(id: string): Promise<void> {
    await this.initialize();
    sensorLabIdSchema.parse(id);
    await this.serial(async () => {
      await rm(this.file("calibrations", id), { force: true });
      this.profiles.delete(id);
      this.dirty.delete(id);
    });
  }
}
