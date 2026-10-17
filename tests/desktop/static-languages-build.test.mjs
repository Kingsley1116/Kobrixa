import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

test("the runtime build excludes test helpers and their test-only importers", () => {
  const config = fileURLToPath(
    new URL("../../packages/plugin-runtime/tsconfig.json", import.meta.url),
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
  assert.ok(parsed.fileNames.some((file) => file.endsWith("/src/manager.ts")));
  assert.deepEqual(
    parsed.fileNames.filter((file) => /\/(?:test-[^/]+|[^/]+\.test)\.ts$/.test(file)),
    [],
  );
});
