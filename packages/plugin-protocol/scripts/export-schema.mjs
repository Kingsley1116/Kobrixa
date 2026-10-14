// Regenerates the committed public schema from the Zod definitions in dist/.
import { writeFile } from "node:fs/promises";
import { serializeJsonSchema } from "../dist/json-schema.js";

const text = serializeJsonSchema();
for (const target of [
  "../schema/plugin-protocol.schema.json",
  "../../../sdks/python/kobrixa/plugin-protocol.schema.json",
])
  await writeFile(new URL(target, import.meta.url), text);
