import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { PluginPersistedState, PluginStateStore } from "@kobrixa/plugin-runtime";

const LIMIT = 1000;
const keys = z.array(z.string().max(128)).max(LIMIT);
const v1Schema = z.strictObject({ schemaVersion: z.literal(1), disabled: keys });
const v2Schema = z.strictObject({
  schemaVersion: z.literal(2),
  developerMode: z.boolean(),
  sources: z.array(z.strictObject({ directory: z.string().min(1).max(4096) })).max(LIMIT),
  disabled: keys,
  legacyDisabledIds: keys,
  python: z
    .strictObject({
      executable: z.string().min(1).max(4096),
      args: z.array(z.string().max(256)).max(8),
    })
    .optional(),
  safeModeLock: z
    .strictObject({
      since: z.iso.datetime(),
      reason: z.enum(["unclean-exit", "renderer-unresponsive"]),
    })
    .optional(),
});
export type PluginStateDocument = z.infer<typeof v2Schema>;
export type SafeModeLock = NonNullable<PluginStateDocument["safeModeLock"]>;
export type StoredPython = NonNullable<PluginStateDocument["python"]>;
export interface PluginSettingsStore extends PluginStateStore {
  /** The latest loaded or saved document. Treat it as read-only. */
  settings(): PluginStateDocument;
  /**
   * Applies `change` to the latest document and writes it, serialized with save(). The result
   * is validated first; a rejected change or a failed write leaves settings() unchanged.
   */
  update(change: (current: PluginStateDocument) => PluginStateDocument): Promise<void>;
}

const empty = (): PluginStateDocument => ({
  schemaVersion: 2,
  developerMode: false,
  sources: [],
  disabled: [],
  legacyDisabledIds: [],
});
const persisted = (document: PluginStateDocument): PluginPersistedState => ({
  disabled: new Set(document.disabled),
  legacyDisabledIds: new Set(document.legacyDisabledIds),
});

/**
 * `<userData>/plugins/state.json`. Writes are serialized and atomic (temporary file + rename), so
 * the file always holds the latest save. A corrupt file is moved aside and reported, never
 * treated as "nothing disabled".
 */
export function filePluginStateStore(
  userData: string,
  options: { now?(): Date } = {},
): PluginSettingsStore {
  const file = path.join(userData, "plugins", "state.json");
  let document = empty();
  let writes: Promise<void> = Promise.resolve();
  const write = async (next: PluginStateDocument) => {
    await mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(next), { mode: 0o600 });
      await rename(temporary, file);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  };
  const commit = (change: (current: PluginStateDocument) => PluginStateDocument) => {
    const run = writes.then(async () => {
      const next = v2Schema.parse(change(document));
      await write(next);
      document = next;
    });
    writes = run.catch(() => undefined);
    return run;
  };
  return {
    async load() {
      let text: string;
      try {
        text = await readFile(file, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        document = empty();
        return persisted(document);
      }
      let value: unknown;
      try {
        value = JSON.parse(text);
      } catch {
        value = undefined;
      }
      const current = v2Schema.safeParse(value);
      if (current.success) {
        document = current.data;
        return persisted(document);
      }
      const legacy = v1Schema.safeParse(value);
      if (legacy.success) {
        // v1 kept manifest ids; built-ins could not be disabled, so each id is a development one.
        document = { ...empty(), legacyDisabledIds: [...new Set(legacy.data.disabled)].sort() };
        return persisted(document);
      }
      const stamp = (options.now?.() ?? new Date()).toISOString().replaceAll(":", "-");
      const backup = `${file}.corrupt-${stamp}`;
      await rename(file, backup).catch(() => undefined);
      document = empty();
      return {
        ...persisted(document),
        problem: `The plugin settings file could not be read and was moved to ${backup}.`,
      };
    },
    save: (state) =>
      commit((current) => ({
        ...current,
        disabled: [...state.disabled].sort(),
        legacyDisabledIds: [...state.legacyDisabledIds].sort(),
      })),
    settings: () => document,
    update: commit,
  };
}
