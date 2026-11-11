import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertClipboardObservation,
  assertLifecycleCapture,
  assertLifecycleSubproof,
  assertNegativeLifecycleReport,
  lifecycleDiskTree,
  lifecycleRequirements,
  probeClipboard,
  produceNegativeLifecycle,
} from "./plugin-persistence-negative-lifecycle.ts";
import { sealedTtlOracle } from "./fixtures/plugin-persistence/sealed-ttl-oracle.mjs";

// Synthetic oracle specimens only. These tests do not execute native acceptance.
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
function capture(epoch = id(1)) {
  const s = {
    hostEpoch: epoch,
    disk: [],
    quotas: { logical: 0, reserved: 0 },
    handles: { reads: 0, writes: 0 },
    core: { items: [] },
  };
  return {
    before: structuredClone(s),
    after: structuredClone(s),
    reopened: { ...structuredClone(s), hostEpoch: id(99) },
  };
}
function clipboard(scenario) {
  return {
    scenario,
    request: {
      method: "ui/copyText",
      params: {
        actionRef: id(4),
        text:
          scenario === "clipboard-bytes"
            ? "😀".repeat(16384) + "a"
            : scenario === "clipboard-codepoints"
              ? "a".repeat(16385)
              : "synthetic",
      },
    },
    result: {
      ok: false,
      error: {
        code:
          scenario === "clipboard-permission"
            ? "PLUGIN_E_PERMISSION_DENIED"
            : scenario === "clipboard-os-failure"
              ? "PLUGIN_E_STORAGE_IO"
              : -32602,
        ...(scenario === "clipboard-os-failure"
          ? { detail: { reason: "clipboard-unavailable" } }
          : {}),
      },
    },
    adapter: {
      reads: 0,
      otherFormats: 0,
      writes: scenario === "clipboard-os-failure" ? 1 : 0,
      failures: scenario === "clipboard-os-failure" ? 1 : 0,
    },
  };
}
test("every assigned row stays visibly incomplete without W10/W18 execution", async () => {
  const report = await produceNegativeLifecycle({});
  assert.equal(report.rows.length, 13);
  assertNegativeLifecycleReport(report);
  for (const row of report.rows) {
    assert.ok(row.missing.length > 1);
    assert.deepEqual(row.observations, []);
  }
  for (const mutate of [
    (r) => r.rows.pop(),
    (r) => r.rows[0].missing.pop(),
    (r) => (r.rows[0].status = "passed"),
    (r) => (r.level = "real-process"),
  ]) {
    const bad = structuredClone(report);
    mutate(bad);
    assert.throws(() => assertNegativeLifecycleReport(bad));
  }
});
test("all native clipboard failures require exact classes and no copied success", () => {
  for (const scenario of lifecycleRequirements["B2-N25"]) {
    const o = clipboard(scenario);
    assertClipboardObservation(o);
    for (const mutate of [
      (r) => (r.result.ok = true),
      (r) => (r.result.value = { copied: true }),
      (r) => (r.result.error.code = "PLUGIN_E_STALE_RESOURCE"),
      (r) => r.adapter.reads++,
      (r) => r.adapter.otherFormats++,
      (r) => r.adapter.writes++,
    ]) {
      const bad = structuredClone(o);
      mutate(bad);
      assert.throws(() => assertClipboardObservation(bad), scenario);
    }
  }
  const bad = clipboard("clipboard-os-failure");
  bad.result.error.detail.reason = "disk-full";
  assert.throws(() => assertClipboardObservation(bad));
});
test("clipboard limits cannot be replaced by smaller inputs", () => {
  for (const scenario of ["clipboard-bytes", "clipboard-codepoints"]) {
    const o = clipboard(scenario);
    o.request.params.text = "small";
    assert.throws(() => assertClipboardObservation(o));
  }
  const o = clipboard("clipboard-codepoints");
  o.request.params.text = "😀".repeat(16385);
  assert.throws(() => assertClipboardObservation(o), /Isolate/);
});
test("capture requires disk hashes, counters, core snapshot and a new epoch", () => {
  assertLifecycleCapture(capture());
  for (const mutate of [
    (c) => (c.reopened.hostEpoch = c.before.hostEpoch),
    (c) => (c.after.hostEpoch = id(8)),
    (c) => (c.after.quotas = {}),
    (c) => (c.before.handles.reads = -1),
    (c) => (c.reopened.core = {}),
    (c) => c.after.disk.push({ name: "../outside", bytes: 1, sha256: "a".repeat(64) }),
  ]) {
    const c = capture();
    mutate(c);
    assert.throws(() => assertLifecycleCapture(c));
  }
});
test("copy observation is bound to disk, quota and handles after reopening", () => {
  const proof = {
    scenario: "clipboard-permission",
    raw: clipboard("clipboard-permission"),
    capture: capture(),
  };
  assertLifecycleSubproof("B2-N25", proof);
  for (const mutate of [
    (p) => p.capture.reopened.disk.push({ name: "unexpected", bytes: 1, sha256: "a".repeat(64) }),
    (p) => p.capture.after.quotas.logical++,
    (p) => p.capture.reopened.handles.writes++,
  ]) {
    const bad = structuredClone(proof);
    mutate(bad);
    assert.throws(() => assertLifecycleSubproof("B2-N25", bad));
  }
});
test("real filesystem snapshot hashes bytes and refuses linked evidence", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "w09c-tree-"));
  try {
    await writeFile(path.join(root, "sample"), "abc");
    assert.deepEqual(await lifecycleDiskTree(root), [
      {
        name: "sample",
        bytes: 3,
        sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
      },
    ]);
    await symlink(path.join(root, "sample"), path.join(root, "alias"));
    await assert.rejects(lifecycleDiskTree(root), /Linked/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("existing TTL raw oracle remains partial and cannot stand for total-age expiry", async () => {
  const raw = sealedTtlOracle();
  const proof = { scenario: "idle-expiry-30s", raw, capture: capture(raw.owner.hostEpoch) };
  const report = await produceNegativeLifecycle({ "B2-N19": async () => [proof] });
  assertNegativeLifecycleReport(report);
  const row = report.rows.find((r) => r.id === "B2-N19");
  assert.ok(row.missing.includes("total-expiry-120s"));
  assert.ok(row.missing.includes("repeated-failed-retry"));
  proof.raw.recovery.after.expiresAt++;
  assert.throws(() => assertLifecycleSubproof("B2-N19", proof));
});
test("unknown adapters and failed producers cannot become passing summaries", async () => {
  await assert.rejects(
    produceNegativeLifecycle({
      "B2-N16": async () => [{ scenario: "full-queue", raw: { passed: true }, capture: capture() }],
    }),
    /Missing independent/,
  );
  await assert.rejects(
    produceNegativeLifecycle({
      "B2-N17": async () => {
        throw Error("worker failed");
      },
    }),
    /worker failed/,
  );
});
test("probe forwards actual input/result and always restores adapter injection (unit driver only)", async () => {
  for (const scenario of lifecycleRequirements["B2-N25"]) {
    let restored = 0,
      calls = 0;
    const expected = clipboard(scenario);
    const result = await probeClipboard({
      scenario,
      prepare: async (permission, failCopy) => {
        assert.equal(permission, scenario !== "clipboard-permission");
        assert.equal(failCopy, scenario === "clipboard-os-failure");
        return {
          actionRef: id(4),
          restore: async () => {
            restored++;
          },
        };
      },
      request: async (params) => {
        assert.equal(params.actionRef, id(4));
        calls++;
        return expected.result;
      },
      counters: () =>
        calls ? expected.adapter : { reads: 0, otherFormats: 0, writes: 0, failures: 0 },
    });
    assert.deepEqual(result.result, expected.result);
    assert.equal(restored, 1);
    assert.equal(calls, 1);
  }
  let restored = false;
  await assert.rejects(
    probeClipboard({
      scenario: "clipboard-permission",
      prepare: async () => ({
        actionRef: id(4),
        restore: async () => {
          restored = true;
        },
      }),
      request: async () => {
        throw Error("channel lost");
      },
      counters: () => ({ reads: 0, otherFormats: 0, writes: 0, failures: 0 }),
    }),
    /channel lost/,
  );
  assert.equal(restored, true);
});
