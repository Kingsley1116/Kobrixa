import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  DEFAULT_FILE_PREFERENCES,
  FILE_PREFERENCE_CHOICES,
  type FilePreferences,
} from "../../shared/file-preferences.js";

const choice = <T extends number>(choices: readonly T[]) =>
  z.custom<T>((value) => choices.includes(value as T));

export const filePreferencesSchema = z
  .object({
    externalChangesEnabled: z.boolean(),
    externalChangeInterval: choice(FILE_PREFERENCE_CHOICES.externalChangeInterval),
    externalChangeAutoReload: z.boolean(),
    localHistoryEnabled: z.boolean(),
    localHistoryDays: choice(FILE_PREFERENCE_CHOICES.localHistoryDays),
    localHistoryVersions: choice(FILE_PREFERENCE_CHOICES.localHistoryVersions),
    localHistorySnapshotMiB: choice(FILE_PREFERENCE_CHOICES.localHistorySnapshotMiB),
    localHistoryWorkspaceMiB: choice(FILE_PREFERENCE_CHOICES.localHistoryWorkspaceMiB),
  })
  .strict();

export const filePreferencesPatchSchema = filePreferencesSchema
  .partial()
  .transform(
    (value) =>
      Object.fromEntries(
        Object.entries(value).filter(([, item]) => item !== undefined),
      ) as Partial<FilePreferences>,
  );

/** Load before use; all callers share one queue so concurrent patches cannot lose settings. */
export class FilePreferencesStore {
  private value: FilePreferences = { ...DEFAULT_FILE_PREFERENCES };
  private loaded: Promise<void> | undefined;
  private writes: Promise<unknown> = Promise.resolve();

  constructor(private readonly userDataPath: () => string) {}

  private load(): Promise<void> {
    this.loaded ??= this.read();
    return this.loaded;
  }

  private async read(): Promise<void> {
    try {
      const raw: unknown = JSON.parse(
        await readFile(path.join(this.userDataPath(), "file-settings.json"), "utf8"),
      );
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
      // Preserve independently valid fields when a setting was removed or an older file is damaged.
      for (const key of Object.keys(DEFAULT_FILE_PREFERENCES) as (keyof FilePreferences)[]) {
        const parsed = filePreferencesPatchSchema.safeParse({
          [key]: (raw as Record<string, unknown>)[key],
        });
        if (parsed.success) this.value = { ...this.value, ...parsed.data };
      }
    } catch {
      /* First launch or unreadable settings: use the documented defaults. */
    }
  }

  async get(): Promise<FilePreferences> {
    await this.load();
    await this.writes.catch(() => undefined);
    return { ...this.value };
  }

  set(patch: Partial<FilePreferences>): Promise<FilePreferences> {
    const validated = filePreferencesPatchSchema.parse(patch);
    const write = this.writes
      .catch(() => undefined)
      .then(async () => {
        await this.load();
        const next = { ...this.value, ...validated };
        const directory = this.userDataPath();
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const target = path.join(directory, "file-settings.json");
        const temporary = `${target}.${randomUUID()}.tmp`;
        try {
          await writeFile(temporary, JSON.stringify(next), {
            encoding: "utf8",
            flag: "wx",
            mode: 0o600,
          });
          await rename(temporary, target);
        } finally {
          await rm(temporary, { force: true });
        }
        this.value = next;
        return { ...this.value };
      });
    this.writes = write;
    return write;
  }
}
