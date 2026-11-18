import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { verifyCompatibility, approvedHost } from "./plugin-persistence-compatibility.ts";
import { compatibilityOracleFixture } from "./fixtures/plugin-persistence/outcome-oracle.mjs";

for (const version of ["1.7.0", "1.8.0"])
  test(`Derived publication under approved ${version}`, () => {
    const checks = verifyCompatibility(compatibilityOracleFixture(version));
    assert.equal(checks.publicApi18Published, version === "1.8.0");
  });
test("Future host requires a new publication ruling", () =>
  assert.throws(() => approvedHost("1.9.0")));
const corruptions = {
  "missing Python cell": (r) => r.cases.splice(1, 1),
  "missing second process": (r) => r.rows.splice(1, 1),
  "same PID restart": (r) => (r.rows[1].boot.pid = r.rows[0].boot.pid),
  "same owner restart": (r) => (r.rows[1].owner = structuredClone(r.rows[0].owner)),
  "absent exit": (r) => delete r.rows[0].exit,
  "forced kill": (r) => (r.rows[0].forceKill = 20),
  "wrong negotiation": (r) => (r.rows[0].wire[1].message.result.apiVersion = "1.8.0"),
  "new legacy initialize field": (r) => (r.rows[0].wire[0].message.params.extra = true),
  "non-null legacy result": (r) => (r.rows[0].wire[3].message.result = {}),
  "missing legacy reply": (r) => r.rows[0].wire.splice(3, 1),
  "duplicate legacy reply": (r) => r.rows[0].wire.push(structuredClone(r.rows[0].wire[3])),
  "foreign reply ID": (r) => (r.rows[0].wire[3].message.id = "foreign"),
  "early reply": (r) => (r.rows[0].wire[3].sequence = r.rows[0].wire[2].sequence - 1),
  "old peer drain": (r) => (r.rows[0].wire[4].message.method = "storage/drain"),
  "missing supported drain": (r) =>
    (r.rows[12].wire = r.rows[12].wire.filter((w) => w.message.method !== "storage/drain")),
  "callback without saved report": (r) => (r.rows[12].drain.report.state = "checkpoint-only"),
  "foreign drain token": (r) => (r.rows[12].drain.offer.token = "foreign"),
  "foreign final record": (r) => (r.rows[12].drain.report.records[0].id = "foreign"),
  "foreign drain owner": (r) => (r.rows[12].drain.offer.owner = r.rows[0].owner),
  "schema generation drift": (r) => (r.schema.second += " "),
  "Python schema drift": (r) => (r.schema.python += " "),
  "restart payload schema drift": (r) => (r.rows[1].boot.schemaSha256 = "b".repeat(64)),
  "missing original source hashes": (r) => (r.cases[0].sourceHashes = {}),
  "unpinned source": (r) => (r.cases[0].commit = "b".repeat(40)),
};
for (const [name, corrupt] of Object.entries(corruptions))
  test(`Reject ${name}`, () => {
    const raw = compatibilityOracleFixture();
    corrupt(raw);
    assert.throws(() => verifyCompatibility(raw));
  });
test("Default six-case materializer remains separate from explicit matrix", async () => {
  const source = await readFile(
    new URL("./declarative-ui-legacy-fixtures.mjs", import.meta.url),
    "utf8",
  );
  assert.match(source, /compatibility \? \["old"\] : \["old", "new", "old-ui"\]/);
  assert.match(source, /options.slot !== undefined/);
});

test("Pinned real SDK sources and bundled JS/Python schemas agree without building", async () => {
  const { execFileSync } = await import("node:child_process");
  const { pins, versions } = await import("./plugin-persistence-compatibility.ts");
  const cwd = new URL("../../", import.meta.url);
  for (const [index, pin] of pins.entries()) {
    const read = (file) =>
      execFileSync("git", ["show", `${pin}:${file}`], {
        cwd,
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
      });
    const js = read("packages/plugin-protocol/schema/plugin-protocol.schema.json");
    assert.equal(js, read("sdks/python/kobrixa/plugin-protocol.schema.json"));
    assert.equal(
      JSON.parse(js).$id,
      `https://kobrixa.com/schemas/plugin-protocol/${versions[index]}.json`,
    );
    assert.ok(
      read("packages/plugin-protocol/src/limits.ts").includes(
        `PLUGIN_API_VERSION = "${versions[index]}"`,
      ),
    );
    const python = read("sdks/python/kobrixa/_plugin.py");
    assert.ok(python.includes(`API_VERSION = "${versions[index]}"`));
    assert.ok(python.includes('"name": "kobrixa-plugin-sdk"'));
  }
});
