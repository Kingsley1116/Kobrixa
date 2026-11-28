import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  SETTINGS_NEGATIVE_IDS,
  assertSettingsNegativeError,
  assertSettingsNegativeReceipt,
  assertSettingsNegativeUnchanged,
  settingsNegativeValue,
} from "./plugin-persistence-negative-settings.ts";

// These specimens exercise rejection by the oracle, never native acceptance.
const epoch = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
function snapshot(n = 1) {
  return {
    hostEpoch: epoch(n),
    tree: [],
    diskTreeHash: createHash("sha256").update("[]").digest("hex"),
    quota: [
      {
        ok: true,
        value: {
          recordCount: 1,
          reservedCreates: 0,
          committedBytes: 25,
          reservedBytes: 0,
          pinnedBytes: 0,
          temporaryBytes: 0,
          hostAvailableBytes: 1073741799,
          writeSlotsAvailable: 2,
          exportSlotsAvailable: 1,
        },
      },
    ],
    handles: [],
    tickets: [],
    core: { items: [] },
    watchEvents: [],
  };
}
const success = (value) => ({ jsonrpc: "2.0", id: 1, result: { ok: true, value } });
const business = (code) => ({ jsonrpc: "2.0", id: 1, result: { ok: false, error: { code } } });
const invalid = () => ({
  jsonrpc: "2.0",
  id: 1,
  error: { code: -32602, message: "Invalid params" },
});
function specimen() {
  return {
    id: "B2-N03",
    scope: "attached-host-worker",
    status: "observed-slice",
    wire: ["window-a", "window-b"].map((channel, index) => ({
      channel,
      request: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "settings/update",
        params: {
          schemaVersion: 1,
          expectedRevision: "r_original",
          changes: [{ key: "count", value: index + 8 }],
        },
      }),
      response: JSON.stringify(
        index === 0
          ? success({ snapshot: { revision: "r_next" } })
          : business("PLUGIN_E_SETTINGS_CONFLICT"),
      ),
    })),
    drafts: {
      before: { windowIds: [1, 2], values: [8, 9] },
      after: { windowIds: [1, 2], values: [8, 9] },
    },
    snapshots: { baseline: snapshot(), cleaned: snapshot(), reopened: snapshot(2) },
    incomplete: [
      "W10 native composition and dual-transport acceptance not established by this receipt alone",
    ],
  };
}
test("pure N03 validator accepts a correlated specimen, without claiming execution", () => {
  assertSettingsNegativeReceipt(specimen());
});
for (const [name, mutate] of Object.entries({
  "missing renderer drafts": (r) => {
    delete r.drafts;
  },
  "discarded losing draft": (r) => {
    r.drafts.after.values[1] = 8;
  },
  "same renderer window": (r) => {
    r.drafts.before.windowIds = [1, 1];
  },
  "last-write-wins": (r) => {
    r.wire[1].response = JSON.stringify(success({ snapshot: {} }));
  },
  "wrong error class": (r) => {
    r.wire[1].response = JSON.stringify(invalid());
  },
  "missing second window": (r) => {
    r.wire.pop();
  },
  "same window twice": (r) => {
    r.wire[1].channel = "window-a";
  },
  "different initial revision": (r) => {
    const p = JSON.parse(r.wire[1].request);
    p.params.expectedRevision = "other";
    r.wire[1].request = JSON.stringify(p);
  },
  "wrong response ID": (r) => {
    const p = JSON.parse(r.wire[1].response);
    p.id++;
    r.wire[1].response = JSON.stringify(p);
  },
  "no fresh epoch": (r) => {
    r.snapshots.reopened.hostEpoch = epoch(1);
  },
  "missing cleanup": (r) => {
    delete r.snapshots.cleaned;
  },
  "leaked handle": (r) => {
    r.snapshots.cleaned.handles.push("read");
  },
  "quota drift on reopen": (r) => {
    r.snapshots.reopened.quota[0].value.committedBytes++;
  },
  "quota unavailable": (r) => {
    r.snapshots.cleaned.quota[0] = { ok: false };
  },
  "quota overflow": (r) => {
    r.snapshots.baseline.quota[0].value.recordCount = 257;
  },
  "missing quota counter": (r) => {
    delete r.snapshots.baseline.quota[0].value.reservedBytes;
  },
  "disk hash mismatch": (r) => {
    r.snapshots.baseline.diskTreeHash = "0".repeat(64);
  },
  "missing original tickets": (r) => {
    delete r.snapshots.baseline.tickets;
  },
  "unqualified pass": (r) => {
    r.status = "passed";
  },
  "omitted native dependency": (r) => {
    r.incomplete = [];
  },
  "borrowed N01 label": (r) => {
    r.id = "B2-N01";
  },
  "borrowed N02 label": (r) => {
    r.id = "B2-N02";
  },
  "borrowed N04 label": (r) => {
    r.id = "B2-N04";
  },
  "borrowed N05 label": (r) => {
    r.id = "B2-N05";
  },
  "borrowed N06 label": (r) => {
    r.id = "B2-N06";
  },
}))
  test(`pure validator rejects ${name}`, () => {
    const row = specimen();
    mutate(row);
    assert.throws(() => assertSettingsNegativeReceipt(row));
  });
for (const key of [
  "tree",
  "diskTreeHash",
  "quota",
  "handles",
  "tickets",
  "core",
  "watchEvents",
  "hostEpoch",
])
  test(`rejected operation must preserve ${key}, including original ticket expiry`, () => {
    const before = snapshot(),
      after = structuredClone(before);
    after[key] =
      key === "hostEpoch"
        ? epoch(2)
        : key === "diskTreeHash"
          ? "0".repeat(64)
          : key === "core"
            ? { items: ["invented"] }
            : ["changed"];
    assert.throws(() => assertSettingsNegativeUnchanged(before, after));
  });
test("wire business errors and invalidParams remain distinct; no success payload on rejection", () => {
  assertSettingsNegativeError(invalid(), -32602);
  assertSettingsNegativeError(business("PLUGIN_E_SETTINGS_SCHEMA"), "PLUGIN_E_SETTINGS_SCHEMA");
  assert.throws(() => assertSettingsNegativeError(invalid(), "PLUGIN_E_SETTINGS_SCHEMA"));
  assert.throws(() => assertSettingsNegativeError(business("PLUGIN_E_SETTINGS_SCHEMA"), -32602));
  const r = business("PLUGIN_E_PERMISSION_DENIED");
  r.result.value = { foreign: "leaked" };
  assert.throws(() => assertSettingsNegativeError(r, "PLUGIN_E_PERMISSION_DENIED"));
  assert.throws(() => settingsNegativeValue(invalid()));
  assert.throws(() => settingsNegativeValue(business("PLUGIN_E_STORAGE_CONFLICT")));
});
test("authoring module does not create a second persistence composition", async () => {
  const source = await readFile(
    new URL("./plugin-persistence-negative-settings.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(
    source,
    /\b(?:startPersistenceWorker|createPersistenceHost|composeDesktopMain|new AtomicStore|new QuotaLedger)\s*\(/,
  );
});
test(
  "attached W10 settings-negative receipts (explicit input required)",
  {
    skip: !process.env.W09A_SETTINGS_EVIDENCE && "NOT RUN: W10 native receipts not supplied",
  },
  async () => {
    const report = JSON.parse(await readFile(process.env.W09A_SETTINGS_EVIDENCE, "utf8"));
    assert.deepEqual(
      report.rows.map((r) => r.id).sort(),
      SETTINGS_NEGATIVE_IDS.map((id) => `B2-${id}`),
    );
    for (const row of report.rows) assertSettingsNegativeReceipt(row);
    // A successful slice oracle is not full matrix, second-instance, or UI acceptance.
    assert.equal(report.scope, "W09a-slices");
  },
);
