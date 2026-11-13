import { createHash } from "node:crypto";
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const hash = (value) => createHash("sha256").update(value).digest("hex");
// A pure oracle specimen, not a producer or a claim of native execution.
export function actionReplayOracle() {
  const owner = {
    sourceKey: "builtin:acceptance.ui-recording",
    pluginId: "acceptance.ui-recording",
    generation: 1,
    hostEpoch: id(1),
    processEpoch: id(2),
  };
  const otherOwner = {
    ...owner,
    sourceKey: "builtin:acceptance.ui-settings",
    pluginId: "acceptance.ui-settings",
    processEpoch: id(4),
  };
  const scope = { hostEpoch: id(1), workbenchInstance: id(3) };
  const rows = [],
    files = {};
  let clock = 10,
    serial = 10;
  const row = (phase, kind, method, args, result, start = clock++, end = clock++) => {
    const r = { phase, kind, method, args, result, start, end };
    rows.push(r);
    return r;
  };
  const blob = (text, inode) => ({
    path: "/private/case/destination.txt",
    identity: `1:${inode}`,
    data: Buffer.from(text).toString("base64"),
    sha256: hash(text),
  });
  let current = blob("sentinel", 1);
  const copyFile = (phase) => {
    files[phase] = { before: structuredClone(current), after: structuredClone(current) };
  };
  const binding = {
    generation: owner.generation,
    hostEpoch: owner.hostEpoch,
    processEpoch: owner.processEpoch,
    contributionId: "acceptance.ui-recording.panel",
    panelInstance: id(5),
    kind: "panel",
    uiResourceGeneration: 1,
  };
  const mint = (phase) => {
    const action = id(serial++),
      start = clock++;
    const minted = row(phase, "feature", "mint", { values: [owner, scope, 1] }, { value: action });
    const invoked = row(
      phase,
      "ui",
      "invoke",
      { binding },
      { ok: true, value: { output: { "action-ref": action } } },
      start,
      clock++,
    );
    return { action, minted, invoked };
  };
  const denied = (phase, action, caller = owner) => {
    for (const method of ["storage/exportBegin", "ui/copyText"]) {
      if (phase !== "wrong-generation")
        row(
          phase,
          "feature",
          "claim",
          {
            values: [
              { owner: caller, actionRef: action },
              method === "ui/copyText" ? "ui.clipboard" : "storage.export",
            ],
          },
          { value: { ok: false } },
        );
      row(
        phase,
        "rpc",
        method,
        { principal: { kind: "plugin", owner: caller }, params: { actionRef: action } },
        {
          ok: false,
          error: {
            code: "PLUGIN_E_PERMISSION_DENIED",
            message: "A current user action is required.",
          },
        },
      );
    }
  };
  for (const phase of ["forged", "wrong-source", "wrong-generation", "expired"]) {
    const action = phase === "forged" ? id(serial++) : mint(phase).action;
    if (phase === "expired") clock += 5100;
    denied(
      phase,
      action,
      phase === "wrong-source"
        ? otherOwner
        : phase === "wrong-generation"
          ? { ...owner, generation: 2 }
          : owner,
    );
    copyFile(phase);
  }
  let replay;
  const dialogs = [];
  let renderer;
  for (const phase of ["cancel", "identity", "registered-cancel", "core", "late"]) {
    copyFile(phase);
    let action,
      job = id(serial++),
      invoked;
    if (phase === "core") {
      const reference = { actionToken: id(serial++), scope },
        target = { kind: "persistence-export", recovery: id(5) };
      action = reference.actionToken;
      row(phase, "core", "mint", { values: [scope, target] }, { value: reference });
      row(
        phase,
        "core-rpc",
        "export",
        { action: reference, recovery: target.recovery },
        { ok: true, value: { disposition: "committed" } },
      );
      row(phase, "core", "claim", { values: [reference, target] }, { value: true });
    } else {
      ({ action, invoked } = mint(phase));
      row(
        phase,
        "feature",
        "claim",
        { values: [{ owner, actionRef: action }, "storage.export"] },
        { value: { ok: true, value: { action } } },
      );
    }
    const start = clock++;
    row(
      phase,
      "device",
      "devices/list",
      { principal: { kind: "plugin", owner } },
      {
        ok: true,
        value: { sessions: [{ sessionId: id(6), recording: false, foreground: "none" }] },
      },
    );
    if (invoked) {
      row(
        phase,
        "rpc",
        "storage/exportBegin",
        { principal: { kind: "plugin", owner }, params: { actionRef: action } },
        { ok: true, value: { export: job, state: "waiting" } },
      );
      invoked.end = clock++;
      invoked.result.value.output.export = job;
    }
    if (phase === "late")
      renderer = {
        pid: 321,
        at: clock++,
        reason: "crashed",
        exitCode: 1,
        osExit: { at: clock++, code: "ESRCH" },
      };
    const end = clock++;
    dialogs.push({
      phase,
      kind: "dialog",
      method: "choose",
      start,
      end,
      args: { name: "action.txt" },
      result: { selected: phase === "cancel" ? null : current.path },
    });
    if (phase === "cancel") {
      replay = action;
      row(
        phase,
        "rpc",
        "storage/exportStatus",
        { params: { export: job } },
        { ok: true, value: { state: "cancelled" } },
      );
      denied("replay", replay);
      copyFile("replay");
    } else if (phase !== "late") {
      const destination = id(serial++);
      row(
        phase,
        "destination",
        "register",
        { action, scope, nativePath: current.path },
        { destination },
      );
      if (phase !== "registered-cancel") {
        const data = "exported";
        row(
          phase,
          "output",
          "begin",
          { job, owner, destination, sha256: hash(data), bytes: data.length },
          { returned: true },
        );
        row(
          phase,
          "output",
          "append",
          { job, data: Buffer.from(data).toString("base64") },
          data.length,
        );
        row(
          phase,
          "output",
          "commit",
          { job },
          phase === "core"
            ? {
                disposition: "committed",
                commitId: id(serial++),
                durability: "file-and-directory-sync",
              }
            : { thrown: "Destination changed" },
        );
        if (phase === "identity") {
          current = blob("replacement", 2);
          copyFile("replacement");
          files.identity.after = structuredClone(current);
          row(
            phase,
            "rpc",
            "storage/exportCommit",
            { params: { export: job } },
            {
              ok: false,
              error: { code: "PLUGIN_E_STORAGE_IO", detail: { reason: "destination-changed" } },
            },
          );
        } else {
          current = blob(data, 3);
          files.core.after = structuredClone(current);
        }
      }
      if (phase === "registered-cancel")
        row(
          phase,
          "rpc",
          "storage/exportCancel",
          { params: { export: job } },
          { ok: true, value: { disposition: "aborted" } },
        );
      row(phase, "destination", "release", { destination }, { returned: true });
      if (phase === "core")
        row(
          phase,
          "core",
          "complete",
          { values: [{ actionToken: action, scope }] },
          { value: null },
        );
    }
  }
  rows.find((r) => r.kind === "core-rpc").end = rows.find(
    (r) => r.phase === "core" && r.kind === "core" && r.method === "complete",
  ).end;
  rows.push(...dialogs);
  return {
    owner,
    otherOwner,
    scope,
    rows,
    files,
    clipboard: {
      before: "observed",
      after: "observed",
      beforeSha256: hash("observed"),
      afterSha256: hash("observed"),
      writes: [],
    },
    renderer,
  };
}
