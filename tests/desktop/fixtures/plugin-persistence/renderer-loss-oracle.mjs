import { createHash } from "node:crypto";
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
// Pure oracle specimen only: none of these synthetic observations claim native execution.
export function rendererLossOracle() {
  const owner = {
    sourceKey: "builtin:acceptance.ui-recording",
    pluginId: "acceptance.ui-recording",
    hostEpoch: id(1),
    processEpoch: id(2),
    generation: 1,
  };
  const nextOwner = { ...owner, processEpoch: id(3), generation: 2 };
  const principal = { kind: "plugin", owner, authorityContext: { ref: id(4) } };
  const scope = { hostEpoch: id(1), workbenchInstance: id(5) };
  const binding = {
    hostEpoch: id(1),
    processEpoch: id(2),
    generation: 1,
    kind: "panel",
    contributionId: "acceptance.ui-recording.panel",
    panelInstance: id(6),
    uiResourceGeneration: 1,
  };
  const bytes = Buffer.from("Renderer loss unfinished write sentinel\n");
  const rows = [];
  const row = (name, start, end, args, result) => rows.push({ name, start, end, args, result });
  const ok = (value) => ({ ok: true, value });
  const denied = { ok: false, error: { code: "PLUGIN_E_STALE_RESOURCE" } };
  row(
    "storage/beginWrite",
    20,
    21,
    {
      principal,
      params: {
        target: { mode: "create" },
        byteLength: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
    },
    ok({ write: id(7), id: id(8), expiresAt: 30020 }),
  );
  row(
    "storage/writeChunk",
    22,
    23,
    { principal, params: { write: id(7), offset: 0, data: bytes.toString("base64") } },
    ok({ receivedBytes: bytes.length, expiresAt: 30022 }),
  );
  const params = {
    sessionId: id(9),
    contextRef: id(4),
    motionScopeRef: id(10),
    gestureRef: id(11),
    motion: { actuatorId: "motor", mode: "jog", power: 1, direction: 1, brake: true },
  };
  row(
    "prepare",
    24,
    25,
    { principal, params },
    ok({
      operation: { operationId: id(12), sessionId: id(9), stage: "prepared", startAccepted: false },
    }),
  );
  row(
    "invoke",
    26,
    28,
    { binding, nodeId: "run", formRevision: 1, form: { speed: -90, mode: "coast" } },
    ok({ output: { "action-ref": id(13) } }),
  );
  row(
    "old-action",
    42,
    43,
    { principal, params: { actionRef: id(13), text: "renderer-loss sentinel" } },
    denied,
  );
  row("old-gesture", 42, 44, { principal, params }, denied);
  row("old-epoch", 42, 45, { principal, params: { schemaVersion: 1 } }, denied);
  row("old-commit", 42, 46, { principal, params: { write: id(7) } }, denied);
  return {
    owner,
    nextOwner,
    nextPrincipal: { kind: "plugin", owner: nextOwner, authorityContext: { ref: id(14) } },
    principal,
    scope,
    rows,
    launches: [
      { owner, at: 1 },
      { owner: nextOwner, at: 205 },
    ],
    subscribedAt: 10,
    exit: { owner, at: 60, event: { code: 0 } },
    loss: {
      start: 30,
      end: 70,
      renderer: {
        pid: 123,
        at: 40,
        reason: "crashed",
        exitCode: 139,
        osExit: { at: 65, code: "ESRCH" },
      },
    },
    intent: {
      scope: id(10),
      gesture: id(11),
      binding: {
        owner,
        contextRef: id(4),
        panelInstance: id(6),
        uiResourceGeneration: 1,
        workbenchInstance: id(5),
      },
      lastPulse: 29,
    },
    mint: { owner, scope, generation: 1, action: id(13), at: 27 },
    retired: [{ owner, reason: "renderer-lost", at: 41 }],
    drains: [
      {
        owner,
        reason: "renderer-crash",
        start: 47,
        end: 59,
        offer: {
          owner,
          reason: "renderer-crash",
          deadlineMonotonicMs: 10040,
          writes: [{ write: id(7), id: id(8), state: "receiving" }],
        },
        report: {
          state: "checkpoint-only",
          records: [{ id: id(8), final: false, committedRevision: null, payload: "none" }],
        },
      },
    ],
    idle: { start: 71, end: 196, owners: [] },
    restart: {
      start: 200,
      end: 210,
      command: "acceptance.ui-recording.legacy",
      result: { ok: true },
    },
    trace: [],
  };
}
