import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { assertSealedTtlObservation } from "./plugin-persistence-sealed-ttl.js";
import { assertRendererLossObservation } from "./plugin-persistence-renderer-loss.js";
import { assertDisconnectObservation } from "./plugin-persistence-disconnect.js";
import { assertSuspendObservation } from "./plugin-persistence-suspend.js";
import { assertActionObservation } from "./plugin-persistence-action-replay.js";
import { assertImportSlice } from "./plugin-persistence-import.js";
import { assertOptionalEvidence } from "./plugin-persistence-optional-off.js";

/** W10 attachment only: never constructs a second host, worker or private router.
 * Existing producers remain responsible for their real injections and cleanup.
 * A subproof is NOT a passing B2 row. Missing scenarios stay explicit even when
 * all attached subproofs validate. W18 owns product loss/safe-mode observations;
 * W12 owns import kill/recovery observations. No historical receipts are loaded.
 */
export const lifecycleRequirements = {
  "B2-N16": ["slow-callback", "full-queue", "sequence-gap", "unsubscribe-twice"],
  "B2-N17": ["crash-memory-only", "crash-receiving", "crash-sealed"],
  "B2-N18": ["hanging-drain-10s", "shutdown-request-2s-manager-4s", "blocker-after-kill"],
  "B2-N19": ["idle-expiry-30s", "total-expiry-120s", "repeated-failed-retry"],
  "B2-N20": ["renderer-loss", "last-window-loss", "provider-loss", "W18-product-lifetimes"],
  "B2-N21": ["disconnect-retry", "suspend-wake", "cross-owner-busy", "W18-product-close"],
  "B2-N22": ["optional-off", "cold-safe-mode", "W18-product-startup"],
  "B2-N23": ["action-replay", "invocation-id-substitution"],
  "B2-N24": [
    "export-disk-full",
    "destination-replacement",
    "cancel-before-publication",
    "cancel-after-publication",
  ],
  "B2-N25": [
    "clipboard-permission",
    "clipboard-bytes",
    "clipboard-codepoints",
    "clipboard-os-failure",
  ],
  "B2-N26": ["import-invalid", "import-version", "import-quota"],
  "B2-N27": ["kill-item-head", "kill-before-receipt", "three-recoveries", "newer-target-preserved"],
  "B2-N28": [
    "kill-before-marker",
    "kill-after-marker",
    "nonce-replay",
    "no-renderer",
    "terminal-after-delete",
  ],
} as const;
export type LifecycleRow = keyof typeof lifecycleRequirements;
export type State = {
  hostEpoch: string;
  disk: { name: string; bytes: number; sha256: string }[];
  quotas: Record<string, number>;
  handles: Record<string, number>;
  core: Record<string, unknown>;
};
export type Capture = { before: State; after: State; reopened: State };
export type ClipboardObservation = {
  scenario: string;
  request: { method: string; params: { actionRef: string; text: string } };
  result: {
    ok: boolean;
    value?: unknown;
    error?: { code: string | number; detail?: { reason?: string } };
  };
  adapter: { reads: number; otherFormats: number; writes: number; failures: number };
};
export type Subproof = {
  scenario: string;
  raw: unknown;
  capture: Capture;
};
export type LifecycleReport = {
  level: "partial-observation";
  rows: { id: LifecycleRow; status: "incomplete"; observations: Subproof[]; missing: string[] }[];
};
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** Hash the actual isolated synthetic profile after its worker has settled.
 * Refuse links rather than traversing outside the run. Never pass a user profile.
 * Relative names are retained; bytes/settings values and physical paths are not.
 */
export async function lifecycleDiskTree(root: string): Promise<State["disk"]> {
  assert.ok(path.isAbsolute(root), "Expected absolute synthetic profile");
  const rows: State["disk"] = [];
  async function visit(relative: string): Promise<void> {
    const file = path.join(root, relative);
    const stat = await lstat(file);
    assert.ok(!stat.isSymbolicLink(), "Linked evidence tree is not supported");
    if (stat.isDirectory()) {
      for (const name of (await readdir(file)).sort()) await visit(path.join(relative, name));
    } else {
      assert.ok(stat.isFile() && stat.nlink === 1, "Nonregular/aliased evidence file");
      const bytes = await readFile(file);
      const after = await lstat(file);
      assert.equal(after.ino, stat.ino);
      assert.equal(after.dev, stat.dev);
      assert.equal(after.size, bytes.length);
      assert.equal(after.mtimeMs, stat.mtimeMs, "Profile changed during capture");
      rows.push({
        name: relative.split(path.sep).join("/"),
        bytes: bytes.length,
        sha256: digest(bytes),
      });
    }
  }
  await visit("");
  return rows;
}
function state(s: State): void {
  assert.match(s.hostEpoch, /^[0-9a-f-]{36}$/);
  assert.ok(Array.isArray(s.disk));
  assert.equal(new Set(s.disk.map((f) => f.name)).size, s.disk.length);
  for (const f of s.disk) {
    assert.ok(f.name && !path.isAbsolute(f.name) && !f.name.split(/[\\/]/).includes(".."));
    assert.ok(Number.isSafeInteger(f.bytes) && f.bytes >= 0);
    assert.match(f.sha256, /^[0-9a-f]{64}$/);
  }
  for (const counts of [s.quotas, s.handles]) {
    assert.ok(counts && Object.keys(counts).length > 0, "Missing measured counters");
    for (const n of Object.values(counts)) assert.ok(Number.isSafeInteger(n) && n >= 0);
  }
  assert.ok(s.core && Object.keys(s.core).length > 0, "Missing core snapshot");
}
export function assertLifecycleCapture(c: Capture): void {
  for (const s of [c.before, c.after, c.reopened]) state(s);
  assert.equal(c.before.hostEpoch, c.after.hostEpoch);
  assert.notEqual(c.after.hostEpoch, c.reopened.hostEpoch, "Reopen must use a fresh host epoch");
}

/** Error classes remain distinct: invalid wire params are not permission or I/O. */
export function assertClipboardObservation(o: ClipboardObservation): void {
  assert.ok(lifecycleRequirements["B2-N25"].some((s) => s === o.scenario));
  assert.equal(o.request.method, "ui/copyText");
  assert.match(o.request.params.actionRef, /^[0-9a-f-]{36}$/);
  assert.equal(o.result.ok, false);
  assert.equal(o.result.value, undefined, "Failed copy cannot advertise copied success");
  assert.equal(o.adapter.reads, 0);
  assert.equal(o.adapter.otherFormats, 0);
  const { text } = o.request.params;
  if (o.scenario === "clipboard-os-failure") {
    assert.equal(o.result.error?.code, "PLUGIN_E_STORAGE_IO");
    assert.equal(o.result.error?.detail?.reason, "clipboard-unavailable");
    assert.deepEqual(o.adapter, { reads: 0, otherFormats: 0, writes: 1, failures: 1 });
  } else {
    assert.equal(o.adapter.writes, 0);
    assert.equal(o.adapter.failures, 0);
    assert.equal(
      o.result.error?.code,
      o.scenario === "clipboard-permission" ? "PLUGIN_E_PERMISSION_DENIED" : -32602,
    );
  }
  if (o.scenario === "clipboard-bytes") assert.ok(Buffer.byteLength(text) > 65536);
  else if (o.scenario === "clipboard-codepoints") {
    assert.ok([...text].length > 16384);
    assert.ok(Buffer.byteLength(text) <= 65536, "Isolate code-point bound from byte overflow");
  } else
    assert.ok(text.length > 0 && [...text].length <= 16384 && Buffer.byteLength(text) <= 65536);
}

/** Reuse the existing independent raw oracles, never their boolean summaries. */
export function assertLifecycleSubproof(id: LifecycleRow, p: Subproof): void {
  assert.ok((lifecycleRequirements[id] as readonly string[]).includes(p.scenario));
  assertLifecycleCapture(p.capture);
  const raw = p.raw;
  switch (p.scenario) {
    case "idle-expiry-30s": {
      const o = raw as Parameters<typeof assertSealedTtlObservation>[0];
      assertSealedTtlObservation(o);
      assert.equal(o.owner.hostEpoch, p.capture.before.hostEpoch);
      break;
    }
    case "renderer-loss": {
      const o = raw as Parameters<typeof assertRendererLossObservation>[0];
      assertRendererLossObservation(o);
      assert.equal(o.owner.hostEpoch, p.capture.before.hostEpoch);
      break;
    }
    case "kill-item-head":
    case "kill-before-receipt":
    case "kill-before-marker":
    case "kill-after-marker": {
      const receipts = raw as Parameters<typeof assertImportSlice>[0];
      assertImportSlice(receipts);
      const expected = {
        "kill-item-head": "after-publish",
        "kill-before-receipt": "before-receipt",
        "kill-before-marker": "before-marker",
        "kill-after-marker": "after-marker",
      }[p.scenario];
      assert.equal(receipts[0]!.evidence.importSlice.slice, expected);
      assert.equal(receipts[0]!.hostEpoch, p.capture.before.hostEpoch);
      assert.equal(receipts[1]!.hostEpoch, p.capture.reopened.hostEpoch);
      break;
    }
    case "disconnect-retry": {
      const o = raw as Parameters<typeof assertDisconnectObservation>[0];
      assertDisconnectObservation(o);
      for (const offer of o.offers) assert.equal(offer.owner.hostEpoch, p.capture.before.hostEpoch);
      break;
    }
    case "suspend-wake": {
      const o = raw as Parameters<typeof assertSuspendObservation>[0];
      assertSuspendObservation(o);
      assert.equal(o.offerBefore.owner.hostEpoch, p.capture.before.hostEpoch);
      break;
    }
    case "optional-off":
      assertOptionalEvidence(
        raw as Parameters<typeof assertOptionalEvidence>[0],
        p.capture.before.hostEpoch,
      );
      break;
    case "destination-replacement":
    case "cancel-before-publication":
    case "action-replay": {
      const o = raw as Parameters<typeof assertActionObservation>[0];
      assertActionObservation(o);
      assert.equal(o.owner.hostEpoch, p.capture.before.hostEpoch);
      break;
    }
    case "invocation-id-substitution":
      assertInvocationSubstitution(raw as InvocationSubstitutionObservation);
      assertUnchangedCapture(p.capture);
      break;
    case "clipboard-permission":
    case "clipboard-bytes":
    case "clipboard-codepoints":
    case "clipboard-os-failure": {
      const o = raw as ClipboardObservation;
      assert.equal(o.scenario, p.scenario);
      assertClipboardObservation(o);
      // Copy has no persistence mutation, quota admission or handle allocation.
      assertUnchangedCapture(p.capture);
      break;
    }
    default:
      throw new Error(`Missing independent observation adapter: ${id}/${p.scenario}`);
  }
}

/** Input must come from W10's sole composition. Calls are deliberately serial:
 * loss, reopen and native actions cannot share a mutable profile concurrently.
 * No absent driver, failed assertion or unavailable prerequisite becomes a pass.
 */
export async function produceNegativeLifecycle(
  drivers: Partial<Record<LifecycleRow, () => Promise<Subproof[]>>>,
): Promise<LifecycleReport> {
  const rows: LifecycleReport["rows"] = [];
  for (const id of Object.keys(lifecycleRequirements) as LifecycleRow[]) {
    const observations = (await drivers[id]?.()) ?? [];
    const seen = new Set<string>();
    for (const proof of observations) {
      assert.ok(!seen.has(proof.scenario), "Duplicate subproof");
      assertLifecycleSubproof(id, proof);
      seen.add(proof.scenario);
    }
    rows.push({
      id,
      status: "incomplete",
      observations,
      missing: [
        ...lifecycleRequirements[id].filter((s) => !seen.has(s)),
        "W10-native-row-acceptance",
      ],
    });
  }
  return { level: "partial-observation", rows };
}
export function assertNegativeLifecycleReport(report: LifecycleReport): void {
  assert.equal(report.level, "partial-observation");
  assert.deepEqual(
    report.rows.map((r) => r.id),
    Object.keys(lifecycleRequirements),
  );
  for (const row of report.rows) {
    assert.equal(row.status, "incomplete", "Subproofs cannot close native acceptance");
    const seen = new Set<string>();
    for (const proof of row.observations) {
      assert.ok(!seen.has(proof.scenario));
      assertLifecycleSubproof(row.id, proof);
      seen.add(proof.scenario);
    }
    assert.deepEqual(row.missing, [
      ...lifecycleRequirements[row.id].filter((s) => !seen.has(s)),
      "W10-native-row-acceptance",
    ]);
  }
}

/** W10 supplies an original public consumer with/without ui.clipboard, an actual
 * trusted UI action, and a forwarding adapter counter. failCopy injects only at
 * the native adapter boundary; request must traverse the real public router.
 * Restore is attempted even on rejected/throwing requests. No service substitute.
 */
export async function probeClipboard(input: {
  scenario: (typeof lifecycleRequirements)["B2-N25"][number];
  prepare(
    permission: boolean,
    failCopy: boolean,
  ): Promise<{ actionRef: string; restore(): Promise<void> }>;
  request(params: { actionRef: string; text: string }): Promise<ClipboardObservation["result"]>;
  counters(): ClipboardObservation["adapter"];
}): Promise<ClipboardObservation> {
  const context = await input.prepare(
    input.scenario !== "clipboard-permission",
    input.scenario === "clipboard-os-failure",
  );
  try {
    const text =
      input.scenario === "clipboard-bytes"
        ? "😀".repeat(16384) + "a"
        : input.scenario === "clipboard-codepoints"
          ? "a".repeat(16385)
          : "W09c synthetic copy";
    const params = { actionRef: context.actionRef, text };
    const before = structuredClone(input.counters());
    const result = await input.request(params);
    const after = input.counters();
    const observation: ClipboardObservation = {
      scenario: input.scenario,
      request: { method: "ui/copyText", params },
      result,
      adapter: {
        reads: after.reads - before.reads,
        otherFormats: after.otherFormats - before.otherFormats,
        writes: after.writes - before.writes,
        failures: after.failures - before.failures,
      },
    };
    assertClipboardObservation(observation);
    return observation;
  } finally {
    await context.restore();
  }
}

/** No-op action failures must not mutate even the core recovery state. */
function assertUnchangedCapture(c: Capture): void {
  for (const s of [c.after, c.reopened]) {
    assert.deepEqual(s.disk, c.before.disk);
    assert.deepEqual(s.quotas, c.before.quotas);
    assert.deepEqual(s.handles, c.before.handles);
    assert.deepEqual(s.core, c.before.core);
  }
}

export type InvocationSubstitutionObservation = {
  invocationId: string;
  genuineActionRef: string;
  calls: {
    method: "storage/exportBegin" | "ui/copyText";
    params: Record<string, unknown>;
    result: ClipboardObservation["result"];
  }[];
  effects: {
    dialogs: number;
    destinationWrites: number;
    clipboardWrites: number;
    deviceLocks: number;
  };
};
export function assertInvocationSubstitution(o: InvocationSubstitutionObservation): void {
  // A schema-valid invocation UUID is essential: an invalid string tests only validation.
  assert.match(
    o.invocationId,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  assert.match(o.genuineActionRef, /^[0-9a-f-]{36}$/);
  assert.notEqual(o.invocationId, o.genuineActionRef);
  assert.deepEqual(
    o.calls.map((c) => c.method),
    ["storage/exportBegin", "ui/copyText"],
  );
  for (const call of o.calls) {
    assert.equal(call.params.actionRef, o.invocationId);
    assert.equal(call.result.ok, false);
    assert.equal(call.result.value, undefined);
    assert.equal(call.result.error?.code, "PLUGIN_E_PERMISSION_DENIED");
  }
  assert.deepEqual(o.calls[0]!.params, {
    actionRef: o.invocationId,
    suggestedName: "w09c.txt",
    mediaType: "text/plain",
    byteLength: 0,
    sha256: digest(new Uint8Array()),
  });
  assert.deepEqual(o.calls[1]!.params, {
    actionRef: o.invocationId,
    text: "W09c invocation substitution",
  });
  assert.deepEqual(o.effects, {
    dialogs: 0,
    destinationWrites: 0,
    clipboardWrites: 0,
    deviceLocks: 0,
  });
}

/** W10 supplies a real trusted invocation and forwards requests via the original
 * consumer transport. The invocation remains active until both requests settle.
 * Counters observe cumulative side effects, so acquire/release cannot hide a lock.
 */
export async function probeInvocationSubstitution(input: {
  prepare(): Promise<{ invocationId: string; actionRef: string; restore(): Promise<void> }>;
  request(
    method: InvocationSubstitutionObservation["calls"][number]["method"],
    params: Record<string, unknown>,
  ): Promise<ClipboardObservation["result"]>;
  counters(): InvocationSubstitutionObservation["effects"];
}): Promise<InvocationSubstitutionObservation> {
  const context = await input.prepare();
  try {
    const before = structuredClone(input.counters());
    const calls: InvocationSubstitutionObservation["calls"] = [];
    for (const [method, params] of [
      [
        "storage/exportBegin",
        {
          actionRef: context.invocationId,
          suggestedName: "w09c.txt",
          mediaType: "text/plain",
          byteLength: 0,
          sha256: digest(new Uint8Array()),
        },
      ],
      ["ui/copyText", { actionRef: context.invocationId, text: "W09c invocation substitution" }],
    ] as const) {
      const result = await input.request(method, params);
      calls.push({ method, params: structuredClone(params), result: structuredClone(result) });
    }
    const after = input.counters();
    const effects = Object.fromEntries(
      Object.entries(after).map(([key, value]) => [
        key,
        value - before[key as keyof typeof before],
      ]),
    ) as InvocationSubstitutionObservation["effects"];
    const observation = {
      invocationId: context.invocationId,
      genuineActionRef: context.actionRef,
      calls,
      effects,
    };
    assertInvocationSubstitution(observation);
    return observation;
  } finally {
    await context.restore();
  }
}

/** Execute one existing producer with actual settled measurements, followed by
 * the sole composition's close/reopen. Never reuse the before snapshot as after.
 * The caller must stop other writers to this synthetic profile for the capture.
 * Reopen is attempted after failed producers too; failures are propagated.
 */
export async function captureLifecycleSubproof(input: {
  id: LifecycleRow;
  scenario: string;
  profilePath: string;
  settle(): Promise<void>;
  measure(): Promise<Omit<State, "disk">>;
  run(): Promise<unknown>;
  reopen(): Promise<void>;
}): Promise<Subproof> {
  assert.ok((lifecycleRequirements[input.id] as readonly string[]).includes(input.scenario));
  const snapshot = async (): Promise<State> => {
    await input.settle();
    const measured = structuredClone(await input.measure());
    const disk = await lifecycleDiskTree(input.profilePath);
    const result = { ...measured, disk };
    state(result);
    return result;
  };
  const before = await snapshot();
  let raw: unknown;
  let after: State;
  try {
    raw = await input.run();
    after = await snapshot();
  } catch (error) {
    try {
      await input.reopen();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Producer and reopen failed");
    }
    throw error;
  }
  await input.reopen();
  const reopened = await snapshot();
  const proof = { scenario: input.scenario, raw, capture: { before, after, reopened } };
  assertLifecycleSubproof(input.id, proof);
  return proof;
}
