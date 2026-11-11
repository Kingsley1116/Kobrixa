import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { sourceRoot, resolvePersistenceSource } from "./persistence-source-loader.mjs";
const context = {
  parentURL: pathToFileURL(path.join(sourceRoot, "tests/desktop/import-preferences.ts")).href,
};
const fallback = () => ({ delegated: true });
test("maps only known source package aliases and existing relative TS counterparts", () => {
  const alias = resolvePersistenceSource("@kobrixa/plugin-protocol", context, fallback);
  assert.equal(
    alias.url,
    pathToFileURL(path.join(sourceRoot, "packages/plugin-protocol/src/index.ts")).href,
  );
  assert.equal(
    resolvePersistenceSource("./plugin-persistence-import.js", context, fallback).url,
    pathToFileURL(path.join(sourceRoot, "tests/desktop/plugin-persistence-import.ts")).href,
  );
  for (const specifier of [
    "@kobrixa/not-a-package",
    "./missing.js",
    "./plugin-persistence-run.mjs",
    "node:fs",
    "../../../../outside.js",
  ])
    assert.deepEqual(resolvePersistenceSource(specifier, context, fallback), { delegated: true });
});
test("does not intercept dependency internals, outside importers, or non-module errors", () => {
  for (const parentURL of [
    pathToFileURL(path.join(sourceRoot, "node_modules/pkg/index.js")).href,
    pathToFileURL(path.join(path.parse(sourceRoot).root, "outside/index.ts")).href,
    "node:fs",
  ])
    assert.deepEqual(
      resolvePersistenceSource("@kobrixa/plugin-protocol", { parentURL }, fallback),
      { delegated: true },
    );
  const error = Object.assign(new Error("export forbidden"), {
    code: "ERR_PACKAGE_PATH_NOT_EXPORTED",
  });
  assert.throws(
    () =>
      resolvePersistenceSource("zod", context, () => {
        throw error;
      }),
    (e) => e === error,
  );
  const missing = Object.assign(new Error("missing"), { code: "ERR_MODULE_NOT_FOUND" });
  assert.throws(
    () =>
      resolvePersistenceSource("arbitrary-package", context, () => {
        throw missing;
      }),
    (e) => e === missing,
  );
});
test("committed bootstrap imports source validators and CLI without executing native entry", () => {
  const loader = pathToFileURL(
    path.join(sourceRoot, "tests/desktop/persistence-source-loader.mjs"),
  ).href;
  const moduleUrl = pathToFileURL(
    path.join(sourceRoot, "tests/desktop/plugin-persistence-run.mjs"),
  ).href;
  const script = `const m = await import(${JSON.stringify(moduleUrl)}); if(m.selectImportTrials('preferences-four').length !== 4) throw Error('selectors'); console.log('source-only-ready');`;
  const output = execFileSync(
    process.execPath,
    ["--experimental-transform-types", "--import", loader, "--input-type=module", "-e", script],
    {
      cwd: sourceRoot,
      encoding: "utf8",
      env: process.env,
      timeout: 15000,
    },
  );
  assert.equal(output.trim(), "source-only-ready");
});

test("only exact known package dist entrypoints have a source-only fallback", () => {
  const known = resolvePersistenceSource(
    "../../packages/plugin-protocol/dist/index.js",
    context,
    fallback,
  );
  assert.ok(
    known.delegated ||
      known.url ===
        pathToFileURL(path.join(sourceRoot, "packages/plugin-protocol/src/index.ts")).href,
  );
  assert.deepEqual(
    resolvePersistenceSource("../../packages/plugin-protocol/dist/other.js", context, fallback),
    { delegated: true },
  );
});
