import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test(
  "U06 preserved 1.4 JS/Python and current SDK legacy envelopes through production host",
  {
    skip: !process.env.KOBRIXA_UI_LEGACY_REPORT,
  },
  async () => {
    const report = JSON.parse(await readFile(process.env.KOBRIXA_UI_LEGACY_REPORT, "utf8"));
    assert.equal(report.productionMain, true);
    assert.equal(report.productionPreload, true);
    assert.equal(report.normalClose, true);
    assert.deepEqual(report.remainingPids, []);
    const source = report.artifact.legacy;
    assert.match(source.sha, /^[a-f0-9]{40}$/);
    for (const file of [
      "packages/plugin-sdk-js/src/index.ts",
      "packages/plugin-protocol/src/limits.ts",
      "sdks/python/kobrixa/_plugin.py",
      "sdks/python/kobrixa/plugin-protocol.schema.json",
    ])
      assert.match(source.hashes[file], /^[a-f0-9]{64}$/);
    assert.equal(report.legacy.cases.length, 6);
    assert.equal(report.legacy.pluginPids.length, 6);
    assert.equal(new Set(report.legacy.pluginPids).size, 6);
    for (const row of report.legacy.cases) {
      const definition = source.cases.find((item) => item.id === row.id);
      assert.ok(definition);
      const sent = row.wire.filter((event) => event.direction === "host");
      const replies = row.wire.filter((event) => event.direction === "plugin");
      const initialize = sent.find((event) => event.message.method === "initialize").message;
      assert.deepEqual(Object.keys(initialize.params).sort(), [
        "apiVersion",
        "grantedPermissions",
        "locale",
        "pluginId",
      ]);
      const initialized = replies.find((event) => event.message.id === initialize.id).message;
      const execute = sent.filter((event) => event.message.method === "command/execute");
      if (definition.ui) {
        assert.equal(row.result.ok, false);
        assert.equal(row.result.code, "PLUGIN_E_HANDSHAKE");
        assert.equal(execute.length, 0);
        if (initialized.error) assert.equal(initialized.error.code, -32602);
        else {
          assert.equal(initialized.result.apiVersion, "1.4.0");
          const negotiate = sent.find((event) => event.message.method === "ui/negotiate").message;
          assert.equal(
            replies.find((event) => event.message.id === negotiate.id).message.error.code,
            -32601,
          );
        }
      } else {
        assert.equal(row.result.ok, true);
        assert.equal(
          initialized.result.apiVersion,
          definition.sdk === "current" ? "1.6.0" : "1.4.0",
        );
        assert.equal(execute.length, 1);
        assert.equal(
          replies.find((event) => event.message.id === execute[0].message.id).message.result,
          null,
        );
        assert.ok(
          sent.every((event) => ["initialize", "command/execute"].includes(event.message.method)),
        );
        assert.ok(
          row.wire.every((event) => !event.message.method || Object.hasOwn(event.message, "id")),
        );
      }
    }
  },
);
