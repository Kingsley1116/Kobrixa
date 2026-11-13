import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { PluginProcess } from "@kobrixa/plugin-runtime";
import type { ResourceOwner } from "@kobrixa/plugin-protocol";
// Serialized heterogeneous RPC observations, never substitute endpoint handlers.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Wire = Record<string, any>;
export const versions = ["1.4.0", "1.5.0", "1.6.0", "1.7.0"];
export const pins = [
  "0ba37baf0ec065d5a3fb484d7b94257708df55ea",
  "48d9d7fba9c0cbcdf504de2c062ba7463320fb09",
  "20d9e7281f7c3a7f5656565c78dbc012607509c4",
  "b2bd825b02886f36b91f3eac7a4deec0fd89fb9f",
];
export const sha = (text: string | Uint8Array) => createHash("sha256").update(text).digest("hex");
export function approvedHost(version: string) {
  assert.ok(["1.7.0", "1.8.0"].includes(version), "Unapproved host publication");
  return version === "1.8.0";
}
const one = (rows: Wire[], label: string): Wire => {
  assert.equal(rows.length, 1, label);
  return rows[0]!;
};
const wait = async (condition: () => boolean, label: string) => {
  const end = Date.now() + 15000;
  while (!condition()) {
    assert.ok(Date.now() < end, `Timed out: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};
export function compatibilityObserver() {
  const rows: Wire[] = [];
  let sequence = 0;
  const event = () => ++sequence;
  return {
    rows,
    begin(owner: ResourceOwner) {
      const row: Wire = { owner: structuredClone(owner), launch: event(), wire: [], output: [] };
      rows.push(row);
      return row;
    },
    output(row: Wire, line: string) {
      row.output.push({ sequence: event(), line });
      const marker = line.indexOf("COMPAT_BOOT:");
      if (marker >= 0) {
        assert.equal(row.boot, undefined, "Duplicate process boot");
        row.boot = { ...JSON.parse(line.slice(marker + 12)), sequence: event() };
      }
    },
    attach(row: Wire, child: PluginProcess): PluginProcess {
      const observe = (direction: string, text: string) =>
        row.wire.push({ sequence: event(), direction, message: JSON.parse(text) });
      const offMessage = child.onMessage((text) => observe("plugin", text));
      child.onExit((exit) => {
        row.exit = { ...exit, sequence: event() };
        offMessage();
      });
      return {
        ...child,
        send(text) {
          observe("host", text);
          child.send(text);
        },
        kill() {
          row.kill = event();
          child.kill();
        },
        forceKill() {
          row.forceKill = event();
          child.forceKill();
        },
      };
    },
    async run(config: Wire, plugins: Wire, participant: Wire) {
      const original = participant.drain;
      participant.drain = async function (offer: Wire, dispatch: unknown) {
        const row = rows.find((r) => r.owner.processEpoch === offer.owner.processEpoch);
        const report = await original.call(this, offer, dispatch);
        if (row)
          row.drain = {
            offer: structuredClone(offer),
            report: structuredClone(report),
            sequence: event(),
          };
        return report;
      };
      try {
        for (const entry of config.cases) {
          const source = one(
            plugins.state().plugins.filter((p: Wire) => p.id === entry.id),
            entry.id,
          );
          for (const generation of [1, 2]) {
            assert.equal((await plugins.setEnabled(source.sourceKey, true)).ok, true);
            const start = rows.length;
            const result = await plugins.execute(`${entry.id}.legacy`);
            assert.equal(result.ok, true, JSON.stringify(result));
            const row = one(rows.slice(start), "Exactly one actual launch");
            row.caseId = entry.id;
            row.generation = generation;
            if (Number(entry.sdk.split(".")[1]) >= 7)
              assert.equal((await plugins.execute(`${entry.id}.seed`)).ok, true);
            assert.equal((await plugins.setEnabled(source.sourceKey, false)).ok, true);
            await wait(() => !!row.exit && !!row.boot, "original process exit and boot output");
            assert.ok(row.boot.pid > 0 && row.boot.pid !== process.pid);
            assert.throws(
              () => process.kill(row.boot.pid, 0),
              (error: unknown) =>
                !!error && typeof error === "object" && "code" in error && error.code === "ESRCH",
              "Exited child must not survive",
            );
          }
        }
      } finally {
        participant.drain = original;
      }
      const compatibility = { ...config, rows };
      return { compatibility, checks: verifyCompatibility(compatibility), events: [], samples: {} };
    },
  };
}
function pair(row: Wire, method: string) {
  const request = one(
    row.wire.filter((w: Wire) => w.direction === "host" && w.message.method === method),
    method,
  );
  const response = one(
    row.wire.filter(
      (w: Wire) =>
        w.direction === "plugin" && w.message.id === request.message.id && !w.message.method,
    ),
    `${method} response`,
  );
  assert.ok(request.sequence < response.sequence && response.sequence < row.exit.sequence);
  assert.equal(response.message.error, undefined);
  return { request: request.message, response: response.message };
}
export function verifyCompatibility(raw: Wire) {
  assert.ok(raw && Array.isArray(raw.rows), "Missing compatibility observations");
  const published = approvedHost(raw.hostVersion);
  const schema = raw.schema;
  assert.ok(schema && typeof schema.first === "string");
  assert.equal(schema.first, schema.second, "Independent serialization drift");
  assert.equal(schema.first, schema.protocol);
  assert.equal(schema.first, schema.python);
  assert.equal(
    JSON.parse(schema.first).$id,
    `https://kobrixa.com/schemas/plugin-protocol/${raw.hostVersion}.json`,
  );
  const expected = [
    ...versions.map((version, i) => ({ version, pin: pins[i] })),
    { version: raw.hostVersion, pin: raw.currentCommit },
  ];
  assert.match(raw.currentCommit, /^[a-f0-9]{40}$/);
  assert.equal(raw.cases.length, expected.length * 2);
  assert.equal(raw.rows.length, raw.cases.length * 2);
  const identities = new Set<string>();
  const pids = new Set<number>();
  for (const [index, spec] of expected.entries())
    for (const language of ["js", "py"]) {
      const entry = one(
        raw.cases.filter((c: Wire) => c.slot === index && c.language === language),
        "Matrix cell",
      );
      assert.equal(entry.sdk, spec.version);
      assert.equal(entry.commit, spec.pin);
      assert.match(entry.schemaSha256, /^[a-f0-9]{64}$/);
      assert.ok(Object.keys(entry.sourceHashes).length > 0);
      for (const hash of Object.values(entry.sourceHashes))
        assert.match(String(hash), /^[a-f0-9]{64}$/);
      const generations: Wire[] = raw.rows.filter((r: Wire) => r.caseId === entry.id);
      assert.equal(generations.length, 2);
      let first: Wire | undefined;
      for (const [i, row] of generations.entries()) {
        assert.equal(row.generation, i + 1);
        assert.equal(row.owner.pluginId, entry.id);
        assert.match(row.owner.sourceKey, /^dev:/);
        const identity = JSON.stringify(row.owner);
        assert.ok(!identities.has(identity), "Restart reused original owner");
        identities.add(identity);
        assert.ok(
          Number.isSafeInteger(row.boot.pid) && row.boot.pid > 0 && !pids.has(row.boot.pid),
          "Restart needs a distinct actual PID",
        );
        pids.add(row.boot.pid);
        assert.equal(row.boot.schemaSha256, entry.schemaSha256);
        assert.equal(
          row.boot.schemaId,
          `https://kobrixa.com/schemas/plugin-protocol/${entry.sdk}.json`,
        );
        assert.ok(row.launch < row.boot.sequence && row.boot.sequence < row.exit.sequence);
        pair(row, "shutdown");
        assert.equal(row.forceKill, undefined, "No forced cleanup");
        assert.ok(
          row.exit.code === 0 ||
            (row.exit.code === null && row.kill > row.launch && row.kill < row.exit.sequence),
          "Expected original process shutdown",
        );
        let previous = row.launch;
        for (const wire of row.wire) {
          assert.ok(wire.sequence > previous && wire.sequence < row.exit.sequence);
          previous = wire.sequence;
        }
        const init = pair(row, "initialize");
        assert.deepEqual(Object.keys(init.request.params).sort(), [
          "apiVersion",
          "grantedPermissions",
          "locale",
          "pluginId",
        ]);
        assert.equal(init.request.params.pluginId, entry.id);
        assert.equal(init.request.params.apiVersion, raw.hostVersion);
        assert.equal(init.response.result.apiVersion, entry.sdk);
        assert.deepEqual(Object.keys(init.response.result).sort(), ["apiVersion", "sdk"]);
        assert.equal(
          init.response.result.sdk.name,
          language === "js" ? "@kobrixa/plugin-sdk" : "kobrixa-plugin-sdk",
        );
        assert.deepEqual(
          init.request.params.grantedPermissions,
          Number(entry.sdk.split(".")[1]) >= 7 ? ["storage.read", "storage.write"] : [],
        );
        const execute = one(
          row.wire.filter(
            (w: Wire) =>
              w.direction === "host" &&
              w.message.method === "command/execute" &&
              w.message.params.command === `${entry.id}.legacy`,
          ),
          "Legacy command",
        );
        assert.deepEqual(execute.message.params, { command: `${entry.id}.legacy` });
        const reply = one(
          row.wire.filter(
            (w: Wire) =>
              w.direction === "plugin" && !w.message.method && w.message.id === execute.message.id,
          ),
          "Legacy result",
        );
        assert.equal(reply.message.result, null);
        assert.equal(reply.message.error, undefined);
        assert.ok(execute.sequence < reply.sequence);
        assert.equal(
          row.output.filter((o: Wire) => o.line.includes(`UI_LEGACY_EXECUTED:${entry.id}`)).length,
          1,
        );
        const drains = row.wire.filter(
          (w: Wire) => w.direction === "host" && w.message.method === "storage/drain",
        );
        if (Number(entry.sdk.split(".")[1]) < 7) assert.equal(drains.length, 0);
        else {
          const drain = pair(row, "storage/drain");
          assert.equal(drain.response.result.ok, true);
          assert.equal(drain.response.result.value.status, "submitted");
          assert.equal(row.drain.report.state, "saved");
          assert.equal(row.drain.report.blocker, false);
          assert.deepEqual(row.drain.report.errors, []);
          assert.equal(row.drain.report.records.length, 1);
          assert.equal(row.drain.report.records[0].final, true);
          assert.deepEqual(row.drain.offer.owner, row.owner);
          assert.equal(row.drain.offer.token, drain.request.params.token);
          assert.equal(drain.request.params.checkpoints.length, 1);
          assert.equal(
            row.drain.report.records[0].id,
            drain.request.params.checkpoints[0].record.id,
          );
          assert.ok(row.drain.sequence < row.exit.sequence);
          assert.equal(row.drain.report.pendingSettings, false);
        }
        const stable = {
          host: init.request.params.apiVersion,
          peer: init.response.result,
          schemaId: row.boot.schemaId,
          schemaSha256: row.boot.schemaSha256,
          legacy: reply.message.result,
        };
        if (first)
          assert.deepEqual(stable, first, "Consumer restart negotiation/payload schema drift");
        first = stable;
      }
    }
  return {
    apiVersions: versions,
    schemasEqual: true,
    secondGenerationDrift: false,
    legacyExecutePreserved: true,
    legacyInitializePreserved: true,
    drainSentBelow17: 0,
    pythonExecuted: true,
    publicApi18Published: published,
  };
}
