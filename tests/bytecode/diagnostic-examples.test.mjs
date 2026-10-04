import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DIAGNOSTIC_HELP,
  DIAGNOSTIC_HELP_VARIANTS,
} from "../../packages/compiler/dist/diagnostic-help.js";
import { BasicPlusFrontend } from "../../frontends/basic-plus/dist/index.js";
import { EV3Backend, inspectRbf } from "../../packages/backend-ev3/dist/index.js";

for (const help of [...DIAGNOSTIC_HELP, ...DIAGNOSTIC_HELP_VARIANTS]) {
  if (help.example?.language !== "bp") continue;
  test(`diagnostic example compiles to native RBF: ${help.code}${help.helpKey ? `/${help.helpKey}` : ""}`, async () => {
    const signal = new AbortController().signal;
    const frontend = await new BasicPlusFrontend().compile(
      {
        root: "/diagnostic-example",
        manifest: {
          schemaVersion: 1,
          name: "diagnostic-example",
          language: "bp",
          entry: "main.bp",
          target: "ev3-native",
          assets: [],
          outputDir: "build",
        },
        sources: [
          { path: "main.bp", content: help.example.after },
          // The Include example demonstrates a dependency that exists in the project.
          { path: "settings.bpi", content: "" },
        ],
        assets: [],
      },
      signal,
    );
    assert.deepEqual(frontend.diagnostics, []);
    assert.ok(frontend.ir);
    const output = await new EV3Backend().compile(frontend.ir, signal);
    assert.deepEqual(output.diagnostics, []);
    assert.ok(output.rbf);
    assert.equal(inspectRbf(output.rbf).imageSize, output.rbf.length);
  });
}
