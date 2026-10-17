import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { format } from "prettier";
import { CORE_STATIC_LANGUAGE_IDS } from "../packages/plugin-runtime/dist/index.js";

const file = new URL(
  "../apps/desktop/src/renderer/editor/core-static-language-ids.json",
  import.meta.url,
);
assert.equal(new Set(CORE_STATIC_LANGUAGE_IDS).size, CORE_STATIC_LANGUAGE_IDS.length);
assert.ok(CORE_STATIC_LANGUAGE_IDS.includes("plaintext"));
assert.ok(CORE_STATIC_LANGUAGE_IDS.includes("json"));
const expected = await format(JSON.stringify(CORE_STATIC_LANGUAGE_IDS), { parser: "json" });
if (process.argv.includes("--check")) {
  assert.equal(await readFile(file, "utf8"), expected, "Regenerate the core-id projection from T2");
} else {
  await writeFile(file, expected);
}
