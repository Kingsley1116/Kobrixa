import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

function parseRuntimeConfig(filename) {
  const config = fileURLToPath(
    new URL(`../../packages/plugin-runtime/${filename}`, import.meta.url),
  );
  const parsed = ts.getParsedCommandLineOfConfigFile(
    config,
    {},
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic(diagnostic) {
        throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
      },
    },
  );
  assert.ok(parsed);
  assert.deepEqual(parsed.errors, []);
  return parsed;
}

test("the runtime build excludes test helpers and their test-only importers", () => {
  const parsed = parseRuntimeConfig("tsconfig.json");
  assert.ok(parsed.fileNames.some((file) => file.endsWith("/src/manager.ts")));
  assert.deepEqual(
    parsed.fileNames.filter((file) => /\/(?:test-[^/]+|[^/]+\.test)\.ts$/.test(file)),
    [],
  );
});

test("the runtime test config checks all source files without emitting", () => {
  const parsed = parseRuntimeConfig("tsconfig.test.json");
  const sourceDir = fileURLToPath(new URL("../../packages/plugin-runtime/src/", import.meta.url));
  assert.deepEqual(
    [...parsed.fileNames].sort(),
    ts.sys.readDirectory(sourceDir, [".ts"], [], ["**/*.ts"]).sort(),
  );
  assert.equal(parsed.options.noEmit, true);
  assert.equal(parsed.options.composite, false);
  assert.equal(parsed.options.incremental, false);
  assert.equal(parsed.options.tsBuildInfoFile, undefined);
  assert.deepEqual(parsed.projectReferences, parseRuntimeConfig("tsconfig.json").projectReferences);
});
