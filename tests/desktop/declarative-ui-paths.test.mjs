import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";

// Evaluate the actual harness entry-point expressions without launching Electron.
for (const harness of [
  "declarative-ui-browser-run.mjs",
  "declarative-ui-legacy-fixtures.mjs",
  "declarative-ui-run.mjs",
]) {
  test(`${harness} passes native decoded file paths to esbuild`, async () => {
    const source = await readFile(new URL(harness, import.meta.url), "utf8");
    const expression = source.match(/entryPoints: \[([^\]\n]+)\]/)?.[1];
    assert.ok(expression, "Harness must have an entry point");
    const fixture = new URL("file:///D:/a/Kobrixa%20space/%E7%95%8C%23/tests/");
    const consumer = new URL("consumer.ts", fixture);
    assert.equal(
      runInNewContext(expression, {
        URL,
        fixture,
        consumer,
        fileURLToPath: (url) => fileURLToPath(url, { windows: true }),
      }),
      "D:\\a\\Kobrixa space\\界#\\tests\\consumer.ts",
    );
    const directory = await mkdtemp(path.join(tmpdir(), "ui paths 界# "));
    try {
      const file = path.join(directory, "consumer.ts");
      await writeFile(file, "export const value: number = 42;");
      const localConsumer = pathToFileURL(file);
      const entry = runInNewContext(expression, {
        URL,
        fixture: new URL("./", localConsumer),
        consumer: localConsumer,
        fileURLToPath,
      });
      assert.equal(entry, file);
      const result = await build({ entryPoints: [entry], bundle: true, write: false });
      assert.equal(result.errors.length, 0);
      assert.match(result.outputFiles[0].text, /42/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}
