import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { PluginStateStore } from "@kobrixa/plugin-runtime";

const stateSchema = z.strictObject({
  schemaVersion: z.literal(1),
  disabled: z.array(z.string().max(128)).max(1000),
});

export function filePluginStateStore(userData: string): PluginStateStore {
  const file = path.join(userData, "plugins", "state.json");
  return {
    async load() {
      try {
        const parsed = stateSchema.safeParse(JSON.parse(await readFile(file, "utf8")));
        return new Set(parsed.success ? parsed.data.disabled : []);
      } catch {
        return new Set(); // First launch or unreadable state: nothing is disabled.
      }
    },
    async save(disabled) {
      await mkdir(path.dirname(file), { recursive: true });
      const temporary = `${file}.${randomUUID()}.tmp`;
      await writeFile(
        temporary,
        JSON.stringify({ schemaVersion: 1, disabled: [...disabled].sort() }),
        { mode: 0o600 },
      );
      await rename(temporary, file);
    },
  };
}
