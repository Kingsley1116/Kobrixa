import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ResourceOwner } from "@kobrixa/plugin-protocol";
import type { PluginUiBridge, CoreWindowScope } from "@kobrixa/plugin-runtime";
import type { UserPersistenceActions } from "../../apps/desktop/src/main/plugins/user-persistence-actions.js";
import type { CoreActionLedger } from "../../apps/desktop/src/main/plugins/core-recovery.js";
import type { LifecycleCaseInput, CaseEvidence } from "./plugin-persistence-main.js";

// Serialized heterogeneous RPC and host-port observations, never a service substitute.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Wire = Record<string, any>;
type Row = {
  phase: string;
  kind: string;
  method: string;
  start: number;
  end: number;
  args: Wire;
  result: Wire;
};
type File = { path: string; identity: string; data: string; sha256: string };
export type ActionObservation = {
  owner: ResourceOwner;
  otherOwner: ResourceOwner;
  scope: CoreWindowScope;
  rows: Row[];
  files: Record<string, { before: File; after: File }>;
  clipboard: {
    before: string;
    after: string;
    beforeSha256: string;
    afterSha256: string;
    writes: { phase: string; text: string; at: number }[];
  };
  renderer: {
    pid: number;
    at: number;
    reason: string;
    exitCode: number;
    osExit: { at: number; code: string };
  };
};
export type NativeActionControl = {
  choose(name: string): Promise<string | null>;
  copy(text: string): void;
  select(value: string | null): void;
  opened(): Promise<void>;
  phase: string;
  dialogs: { phase: string; name: string; start: number; end: number; selected: string | null }[];
  writes: ActionObservation["clipboard"]["writes"];
  text: string;
};
export function nativeActionControl(now: () => number): NativeActionControl {
  let resolve: ((value: string | null) => void) | undefined;
  let opened: (() => void) | undefined;
  const control: NativeActionControl = {
    phase: "setup",
    dialogs: [],
    writes: [],
    text: "T7 clipboard observation sentinel",
    choose(name) {
      assert.equal(resolve, undefined, "Overlapping native selections");
      const row = {
        phase: control.phase,
        name,
        start: now(),
        end: 0,
        selected: null as string | null,
      };
      control.dialogs.push(row);
      const pending = new Promise<string | null>((done) => {
        resolve = done;
      });
      opened?.();
      opened = undefined;
      return pending.then((selected) => {
        row.end = now();
        row.selected = selected;
        return selected;
      });
    },
    copy(text) {
      control.writes.push({ phase: control.phase, text, at: now() });
      control.text = text;
    },
    select(value) {
      assert.ok(resolve, "No actual adapter dialog is pending");
      const done = resolve;
      resolve = undefined;
      done(value);
    },
    opened() {
      return resolve
        ? Promise.resolve()
        : new Promise<void>((done) => {
            opened = done;
          });
    },
  };
  return control;
}
const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const value = (result: Wire): Wire => {
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.value;
};
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
async function bounded<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Action replay observation deadline")), 15000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
export type ActionCaseInput = LifecycleCaseInput & {
  profilePath: string;
  scope(): CoreWindowScope;
  ui: PluginUiBridge;
  actions: CoreActionLedger;
  featureActions: UserPersistenceActions;
  native: NativeActionControl;
  command(step: string): Promise<void>;
  prepareCore(): Promise<void>;
  coreExport(): Promise<unknown>;
  destroyRenderer(): Promise<ActionObservation["renderer"]>;
};
export async function produceActionReplay(
  input: ActionCaseInput,
): Promise<CaseEvidence & { actionReplay: ActionObservation }> {
  const principal = input.recording.principal();
  assert.equal(principal.kind, "plugin");
  if (principal.kind !== "plugin") throw new Error("Missing actual consumer principal");
  const other = input.settings.principal();
  assert.equal(other.kind, "plugin");
  if (other.kind !== "plugin") throw new Error("Missing second actual consumer");
  const owner = principal.owner,
    scope = input.scope(),
    native = input.native;
  const rows: Row[] = [],
    files: ActionObservation["files"] = {},
    restores: (() => void)[] = [];
  const clipboardBefore = native.text;
  let phase = "setup";
  const setPhase = (next: string) => {
    phase = next;
    native.phase = next;
  };
  const pending = new Set<Promise<unknown>>();
  const observe = async (kind: string, method: string, args: Wire, run: () => Promise<unknown>) => {
    const row: Row = {
      phase,
      kind,
      method,
      start: input.now(),
      end: 0,
      args: structuredClone(args),
      result: {},
    };
    rows.push(row);
    try {
      const operation = run();
      pending.add(operation);
      void operation.then(
        () => pending.delete(operation),
        () => pending.delete(operation),
      );
      const result = await bounded(operation);
      row.result = structuredClone(result === undefined ? { returned: true } : result) as Wire;
      return result;
    } catch (error) {
      row.result = { thrown: error instanceof Error ? error.message : String(error) };
      throw error;
    } finally {
      row.end = input.now();
    }
  };
  const settle = () =>
    bounded(
      (async () => {
        do {
          await new Promise((resolve) => setImmediate(resolve));
          await Promise.allSettled([...pending]);
        } while (pending.size);
      })(),
    );
  const signal = new AbortController().signal;
  const request = (method: string, params: Wire, caller = principal) =>
    input.host.request(caller, method as never, params as never, signal) as Promise<Wire>;
  const deviceSnapshot = () =>
    input.broker.request(input.recording.principal(), "devices/list", {}, signal);
  const root = path.join(input.profilePath, "action-replay-native-path-sentinel");
  await mkdir(root);
  const target = path.join(root, "destination.txt");
  await writeFile(target, "T7 destination sentinel", { flag: "wx" });
  const file = async (): Promise<File> => {
    const bytes = await readFile(target),
      stat = await lstat(target, { bigint: true });
    assert.ok(stat.isFile() && !stat.isSymbolicLink());
    return {
      path: target,
      identity: `${stat.dev}:${stat.ino}`,
      data: bytes.toString("base64"),
      sha256: hash(bytes),
    };
  };
  const capture = async (name: string, run: () => Promise<void>) => {
    setPhase(name);
    const before = await file();
    await run();
    await settle();
    files[name] = { before, after: await file() };
  };
  const catalog = value(await input.ui.catalog({}));
  const panel = catalog.entries.find(
    (entry: Wire) => entry.sourceKey === owner.sourceKey && entry.kind === "panel",
  );
  assert.ok(panel);
  const opened = value(
    await input.ui.open({
      sourceKey: panel.sourceKey,
      id: panel.id,
      uiResourceGeneration: panel.uiResourceGeneration,
    }),
  );
  value(await input.ui.visibility({ binding: opened.binding, visible: true, reason: "tab" }));
  let revision = opened.formRevision;
  const invoke = async (speed: number) => {
    const params = {
      binding: opened.binding,
      nodeId: "run",
      formRevision: ++revision,
      form: { ...opened.form, speed },
    };
    const result = await observe("ui", "invoke", params, () => input.ui.invoke(params));
    const output = value(result as Wire).output;
    return { ...output, actionRef: output["action-ref"] };
  };
  const status = async (job: string, expected: string) => {
    await bounded(
      (async () => {
        for (;;) {
          const response = value(await request("storage/exportStatus", { export: job }));
          if (response.state === expected) return;
          assert.ok(["waiting", "receiving"].includes(response.state), JSON.stringify(response));
          await new Promise((done) => setTimeout(done, 10));
        }
      })(),
    );
  };
  const begin = async () => {
    const result = await bounded(invoke(-91));
    await bounded(native.opened());
    await deviceSnapshot();
    return result;
  };
  const params = (actionRef: string) => ({
    actionRef,
    suggestedName: "action.txt",
    mediaType: "text/plain",
    byteLength: 0,
    sha256: hash(""),
  });
  const jobs: string[] = [];
  let renderer: ActionObservation["renderer"] | undefined, failure: unknown;
  const original = input.host.request;
  input.host.request = new Proxy(original, {
    apply(target, receiver, args) {
      const [caller, method, params] = args;
      return observe("rpc", method, { principal: caller, params }, () =>
        Reflect.apply(target, receiver, args),
      );
    },
  });
  restores.push(() => {
    input.host.request = original;
  });
  const coreExport = input.host.recovery.export;
  input.host.recovery.export = (args) =>
    observe("core-rpc", "export", args, () =>
      coreExport.call(input.host.recovery, args),
    ) as ReturnType<typeof coreExport>;
  restores.push(() => {
    input.host.recovery.export = coreExport;
  });
  const destinations = new Map<unknown, string>();
  let holdRegistration = false,
    releaseRegistration: (() => void) | undefined;
  let registered: (() => void) | undefined;
  const registry = input.backend.destinations,
    register = registry.register,
    release = registry.release;
  registry.register = async function (registration) {
    const destination = await register.call(this, registration);
    const id = randomUUID();
    destinations.set(destination, id);
    await observe("destination", "register", registration, async () => ({ destination: id }));
    if (holdRegistration) {
      const wait = new Promise<void>((done) => {
        releaseRegistration = done;
      });
      registered?.();
      await wait;
    }
    return destination;
  };
  registry.release = function (destination) {
    return observe("destination", "release", { destination: destinations.get(destination) }, () =>
      release.call(this, destination),
    ).then(() => {});
  };
  restores.push(() => {
    registry.register = register;
    registry.release = release;
  });
  for (const method of ["begin", "append", "commit", "abort", "reconcile"] as const) {
    const originalOutput = input.backend.output[method];
    // Proxy observes the exact production port and preserves opaque destination identity.
    Object.assign(input.backend.output, {
      [method]: new Proxy(originalOutput, {
        apply(target, receiver, args) {
          const serialized =
            method === "begin"
              ? {
                  job: args[0],
                  owner: args[1],
                  destination: destinations.get(args[2]),
                  bytes: args[3],
                  sha256: args[4],
                  deadline: args[5],
                }
              : method === "append"
                ? { job: args[0], offset: args[1], data: Buffer.from(args[2]).toString("base64") }
                : { job: args[0] };
          return observe("output", method, serialized, () => Reflect.apply(target, receiver, args));
        },
      }),
    });
    restores.push(() => {
      Object.assign(input.backend.output, { [method]: originalOutput });
    });
  }
  for (const method of ["mint", "claim", "complete"] as const) {
    const previous = input.actions[method];
    Object.assign(input.actions, {
      [method]: new Proxy(previous, {
        apply(target, receiver, args) {
          const start = input.now(),
            result = Reflect.apply(target, receiver, args);
          rows.push({
            phase,
            kind: "core",
            method,
            start,
            end: input.now(),
            args: { values: structuredClone(args) },
            result: { value: structuredClone(result ?? null) },
          });
          return result;
        },
      }),
    });
    restores.push(() => {
      Object.assign(input.actions, { [method]: previous });
    });
  }
  for (const method of ["mint", "claim"] as const) {
    const previous = input.featureActions[method];
    Object.assign(input.featureActions, {
      [method]: new Proxy(previous, {
        apply(target, receiver, args) {
          const start = input.now(),
            result = Reflect.apply(target, receiver, args);
          rows.push({
            phase,
            kind: "feature",
            method,
            start,
            end: input.now(),
            args: { values: structuredClone(args) },
            result: { value: structuredClone(result) },
          });
          return result;
        },
      }),
    });
    restores.push(() => {
      Object.assign(input.featureActions, { [method]: previous });
    });
  }
  const brokerRequest = input.broker.request;
  input.broker.request = new Proxy(brokerRequest, {
    apply(target, receiver, args) {
      return observe("device", args[1], { principal: args[0], params: args[2] }, () =>
        Reflect.apply(target, receiver, args),
      );
    },
  });
  restores.push(() => {
    input.broker.request = brokerRequest;
  });
  try {
    setPhase("core-prepare");
    await bounded(input.prepareCore());
    for (const kind of ["forged", "wrong-source", "wrong-generation", "expired"] as const) {
      await capture(kind, async () => {
        const minted = kind === "forged" ? { actionRef: randomUUID() } : await invoke(-90);
        if (kind === "expired") await new Promise((done) => setTimeout(done, 5100));
        const caller =
          kind === "wrong-source"
            ? other
            : kind === "wrong-generation"
              ? { ...principal, owner: { ...owner, generation: owner.generation + 1 } }
              : principal;
        await request("storage/exportBegin", params(minted.actionRef), caller);
        await request(
          "ui/copyText",
          { actionRef: minted.actionRef, text: "T7 action export value sentinel" },
          caller,
        );
      });
    }
    let consumed = "";
    await capture("cancel", async () => {
      const started = await begin();
      jobs.push(started.export);
      consumed = started.actionRef;
      native.select(null);
      await status(started.export, "cancelled");
      await deviceSnapshot();
    });
    await capture("replay", async () => {
      await request("storage/exportBegin", params(consumed));
      await request("ui/copyText", {
        actionRef: consumed,
        text: "T7 action export value sentinel",
      });
    });
    await capture("identity", async () => {
      const started = await begin();
      jobs.push(started.export);
      native.select(target);
      await status(started.export, "receiving");
      await bounded(input.command("chunk"));
      await rename(target, path.join(root, "original.saved"));
      await writeFile(target, "T7 replacement inode sentinel", { flag: "wx" });
      files.replacement = { before: await file(), after: await file() };
      await bounded(input.command("commit"));
      files.replacement.after = await file();
      await deviceSnapshot();
    });
    await capture("registered-cancel", async () => {
      holdRegistration = true;
      const acknowledgement = new Promise<void>((done) => {
        registered = done;
      });
      const started = await begin();
      jobs.push(started.export);
      native.select(target);
      await bounded(acknowledgement);
      await request("storage/exportCancel", { export: started.export });
      releaseRegistration!();
      holdRegistration = false;
      await bounded(
        (async () => {
          while (
            !rows.some(
              (row) =>
                row.phase === phase && row.kind === "destination" && row.method === "release",
            )
          )
            await new Promise((done) => setTimeout(done, 10));
        })(),
      );
      await deviceSnapshot();
    });
    await capture("core", async () => {
      const exporting = input.coreExport();
      void exporting.catch(() => {});
      await bounded(native.opened());
      await deviceSnapshot();
      native.select(target);
      await bounded(exporting);
      await deviceSnapshot();
    });
    await capture("late", async () => {
      const started = await begin();
      jobs.push(started.export);
      renderer = await bounded(input.destroyRenderer());
      native.select(target);
      // The native adapter's continuation and action cleanup settle before inspection.
      await new Promise((done) => setImmediate(done));
      await new Promise((done) => setImmediate(done));
    });
  } catch (error) {
    failure = error;
  }
  const cleanupErrors: unknown[] = [];
  const cleanup = async (task: () => unknown | Promise<unknown>) => {
    try {
      await task();
    } catch (error) {
      cleanupErrors.push(error);
    }
  };
  await cleanup(() => {
    if (native.dialogs.some((row) => row.end === 0)) native.select(null);
  });
  await cleanup(() => releaseRegistration?.());
  for (const job of jobs) await cleanup(() => request("storage/exportCancel", { export: job }));
  await cleanup(settle);
  for (const restore of restores.reverse()) {
    try {
      restore();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  for (const dialog of native.dialogs)
    rows.push({
      phase: dialog.phase,
      kind: "dialog",
      method: "choose",
      start: dialog.start,
      end: dialog.end,
      args: { name: dialog.name },
      result: { selected: dialog.selected },
    });
  const observation = {
    owner,
    otherOwner: other.owner,
    scope,
    rows,
    files,
    clipboard: {
      before: clipboardBefore,
      after: native.text,
      beforeSha256: hash(clipboardBefore),
      afterSha256: hash(native.text),
      writes: native.writes,
    },
    renderer: renderer!,
  };
  await writeFile(
    path.join(input.profilePath, "action-replay-observation.json"),
    JSON.stringify(observation, null, 2),
    { flag: "wx" },
  );
  if (failure || cleanupErrors.length)
    throw new AggregateError(
      [...(failure ? [failure] : []), ...cleanupErrors],
      "Action replay producer failed",
    );
  assertActionObservation(observation);
  return { actionReplay: observation, checks: actionSummary(observation), events: [], samples: {} };
}

const selectedRows = (o: ActionObservation, phase: string, kind?: string, method?: string) =>
  o.rows.filter(
    (row) =>
      row.phase === phase && (!kind || row.kind === kind) && (!method || row.method === method),
  );
const writes = (o: ActionObservation, phase: string) =>
  selectedRows(o, phase, "output").filter((row) =>
    ["begin", "append", "commit"].includes(row.method),
  );
const unchanged = (o: ActionObservation, phase: string) =>
  same(o.files[phase]?.before, o.files[phase]?.after);
const errors = (o: ActionObservation) =>
  o.rows
    .filter(
      (row) =>
        ["rpc", "ui"].includes(row.kind) &&
        (row.result.ok === false || row.result.thrown || row.result.value?.error),
    )
    .map((row) => JSON.stringify(row.result));
const leaks = (o: ActionObservation) =>
  errors(o).filter(
    (text) =>
      text.includes(o.files.cancel!.before.path) ||
      text.includes("T7 action export value sentinel") ||
      text.includes("T7 replacement inode sentinel"),
  ).length;
const locks = (o: ActionObservation) =>
  o.rows
    .filter((row) => row.kind === "dialog")
    .flatMap((dialog) =>
      o.rows.filter(
        (row) =>
          row.start >= dialog.start &&
          row.start <= dialog.end &&
          ((row.kind === "reservation" && row.result.state !== "ended") ||
            (row.kind === "device" &&
              ["devices/recording/reserve", "devices/motion/start"].includes(row.method) &&
              row.result.ok)),
      ),
    );
export function actionSummary(o: ActionObservation): CaseEvidence["checks"] {
  const mint = selectedRows(o, "core", "core", "mint")[0],
    claim = selectedRows(o, "core", "core", "claim")[0];
  return {
    forgedDestinationWrites: writes(o, "forged").length,
    replayedDestinationWrites: writes(o, "replay").length,
    expiredDestinationWrites: writes(o, "expired").length,
    lateDialogWrites: writes(o, "late").length,
    deniedClipboardWrites: o.clipboard.writes.length,
    deviceLocksDuringDialog: locks(o).length,
    leakedPathsOrValues: leaks(o),
    freshCoreAction:
      !!mint &&
      !!claim &&
      same(mint.result.value, claim.args.values[0]) &&
      claim.result.value === true,
    cancelNoWrite: unchanged(o, "cancel") && writes(o, "cancel").length === 0,
    lateDialogReleased: selectedRows(o, "registered-cancel", "destination", "release").length === 1,
    identitySwapRejected:
      unchanged(o, "replacement") &&
      selectedRows(o, "identity", "rpc", "storage/exportCommit").some(
        (row) =>
          row.result.ok === false && row.result.error.detail.reason === "destination-changed",
      ),
  };
}
export function assertActionObservation(o: ActionObservation): void {
  assert.ok(o && o.owner && o.scope && Array.isArray(o.rows), "Missing action replay observations");
  assert.equal(o.scope.hostEpoch, o.owner.hostEpoch);
  assert.equal(o.owner.sourceKey, "builtin:acceptance.ui-recording");
  assert.equal(o.owner.pluginId, "acceptance.ui-recording");
  const mintedTokens = o.rows
    .filter((row) => ["feature", "core"].includes(row.kind) && row.method === "mint")
    .map((row) => (row.kind === "core" ? row.result.value.actionToken : row.result.value));
  assert.equal(new Set(mintedTokens).size, mintedTokens.length, "Action token reused across mints");
  assert.ok(o.owner.generation > 0);
  assert.equal(o.otherOwner.sourceKey, "builtin:acceptance.ui-settings");
  assert.equal(o.otherOwner.pluginId, "acceptance.ui-settings");
  assert.equal(o.otherOwner.hostEpoch, o.owner.hostEpoch);
  assert.notEqual(o.otherOwner.processEpoch, o.owner.processEpoch);
  assert.ok(o.otherOwner.generation > 0);
  assert.ok(
    o.rows.every((row) =>
      [
        "core-prepare",
        "forged",
        "wrong-source",
        "wrong-generation",
        "expired",
        "replay",
        "cancel",
        "identity",
        "registered-cancel",
        "core",
        "late",
      ].includes(row.phase),
    ),
  );
  assert.equal(
    o.rows.filter(
      (row) => row.kind === "output" && ["begin", "append", "commit"].includes(row.method),
    ).length,
    6,
    "Unaccounted native output calls",
  );
  for (const row of o.rows) {
    assert.ok(
      Number.isFinite(row.start) && row.start >= 0 && row.end >= row.start,
      "Unsettled/invalid observation time",
    );
    assert.ok(row.args && row.result);
  }
  for (const pair of Object.values(o.files))
    for (const f of [pair.before, pair.after]) {
      assert.ok(path.isAbsolute(f.path));
      assert.match(f.identity, /^\d+:\d+$/);
      assert.equal(f.sha256, hash(Buffer.from(f.data, "base64")));
      assert.equal(Buffer.from(f.data, "base64").toString("base64"), f.data);
      assert.equal(f.path, o.files.cancel!.before.path);
    }
  for (const phase of ["forged", "wrong-source", "wrong-generation", "expired", "replay"]) {
    assert.ok(unchanged(o, phase), `${phase} destination changed`);
    assert.equal(writes(o, phase).length, 0);
    assert.equal(selectedRows(o, phase, "dialog").length, 0);
    assert.equal(selectedRows(o, phase, "destination").length, 0);
    const calls = selectedRows(o, phase, "rpc");
    assert.deepEqual(
      calls.map((row) => row.method),
      ["storage/exportBegin", "ui/copyText"],
    );
    assert.equal(calls[0]!.args.params.actionRef, calls[1]!.args.params.actionRef);
    for (const call of calls) {
      assert.equal(call.result.ok, false);
      assert.ok(
        ["PLUGIN_E_PERMISSION_DENIED", "PLUGIN_E_STALE_RESOURCE"].includes(call.result.error.code),
      );
      assert.equal(call.args.principal.kind, "plugin");
      const expected =
        phase === "wrong-source"
          ? o.otherOwner
          : phase === "wrong-generation"
            ? { ...o.owner, generation: o.owner.generation + 1 }
            : o.owner;
      assert.deepEqual(call.args.principal.owner, expected);
    }
    const action = calls[0]!.args.params.actionRef;
    if (phase !== "wrong-generation") {
      const claims = selectedRows(o, phase, "feature", "claim");
      assert.equal(claims.length, 2, "Denied request never reached the actual feature ledger");
      for (const claim of claims) {
        assert.equal(claim.result.value.ok, false);
        assert.equal(claim.args.values[0].actionRef, action);
      }
    }
    const mint = o.rows.find(
      (row) => row.kind === "feature" && row.method === "mint" && row.result.value === action,
    );
    if (phase === "forged") assert.equal(mint, undefined);
    else {
      assert.ok(mint, "Missing real feature ledger mint");
      assert.deepEqual(mint.args.values.slice(0, 2), [o.owner, o.scope]);
      const invoke = o.rows.find(
        (row) =>
          row.kind === "ui" &&
          row.start <= mint.start &&
          row.end >= mint.end &&
          row.result.value?.output?.["action-ref"] === action,
      );
      assert.ok(invoke, "Mint not enclosed by actual trusted UI dispatch");
      assert.equal(invoke.args.binding.generation, o.owner.generation);
      assert.equal(invoke.args.binding.processEpoch, o.owner.processEpoch);
      if (phase === "expired") assert.ok(calls[0]!.start >= mint.end + 5000, "Expiry not reached");
      else assert.ok(calls[1]!.end < mint.start + 5000, "Wrong owner probe was merely expired");
      if (phase === "replay") {
        const consumed = o.rows.filter(
          (row) =>
            row.kind === "feature" &&
            row.method === "claim" &&
            row.args.values[0].actionRef === action &&
            row.result.value.ok,
        );
        assert.equal(consumed.length, 1);
        assert.equal(consumed[0]!.phase, "cancel");
        assert.ok(consumed[0]!.end < calls[0]!.start);
      }
    }
  }
  const phases = ["cancel", "identity", "registered-cancel", "core", "late"];
  assert.deepEqual(
    o.rows.filter((row) => row.kind === "dialog").map((row) => row.phase),
    phases,
  );
  let sessionId: string | undefined;
  for (const phase of phases) {
    const dialog = selectedRows(o, phase, "dialog")[0]!;
    assert.ok(dialog.end > dialog.start);
    const snapshot = selectedRows(o, phase, "device", "devices/list").find(
      (row) => row.start >= dialog.start && row.end <= dialog.end,
    );
    assert.ok(snapshot, "Missing actual device snapshot while dialog waits");
    assert.equal(snapshot.result.ok, true);
    assert.deepEqual(snapshot.args.principal.owner, o.owner);
    assert.ok(snapshot.result.value.sessions.length > 0, "Device session was never exercised");
    for (const session of snapshot.result.value.sessions) {
      assert.match(session.sessionId, /^[0-9a-f-]{36}$/);
      sessionId ??= session.sessionId;
      assert.equal(session.sessionId, sessionId);
      assert.equal(session.recording, false);
      assert.equal(session.foreground, "none");
    }
    if (phase !== "core") {
      const begin = selectedRows(o, phase, "rpc", "storage/exportBegin");
      assert.equal(begin.length, 1);
      assert.equal(begin[0]!.result.ok, true);
      assert.equal(begin[0]!.result.value.state, "waiting");
      assert.deepEqual(begin[0]!.args.principal.owner, o.owner);
      const action = begin[0]!.args.params.actionRef;
      const claim = selectedRows(o, phase, "feature", "claim");
      assert.equal(claim.length, 1);
      assert.deepEqual(claim[0]!.args.values, [
        { owner: o.owner, actionRef: action },
        "storage.export",
      ]);
      assert.deepEqual(claim[0]!.result.value, { ok: true, value: { action } });
      const mint = selectedRows(o, phase, "feature", "mint");
      assert.equal(mint.length, 1);
      assert.equal(mint[0]!.result.value, action);
      const ui = selectedRows(o, phase, "ui", "invoke");
      assert.equal(ui.length, 1);
      assert.ok(ui[0]!.start <= mint[0]!.start && ui[0]!.end >= begin[0]!.end);
      assert.equal(ui[0]!.result.value.output.export, begin[0]!.result.value.export);
      assert.equal(ui[0]!.result.value.output["action-ref"], action);
      for (const output of writes(o, phase))
        assert.equal(output.args.job, begin[0]!.result.value.export);
    }
  }
  assert.equal(selectedRows(o, "cancel", "dialog")[0]!.result.selected, null);
  assert.ok(
    selectedRows(o, "cancel", "rpc", "storage/exportStatus").some(
      (row) => row.result.value?.state === "cancelled",
    ),
  );
  assert.ok(unchanged(o, "cancel"));
  assert.equal(selectedRows(o, "cancel", "destination").length, 0);
  const identity = selectedRows(o, "identity", "rpc", "storage/exportCommit");
  assert.equal(identity.length, 1);
  assert.equal(identity[0]!.result.ok, false);
  assert.equal(identity[0]!.result.error.detail.reason, "destination-changed");
  assert.notEqual(o.files.identity!.before.identity, o.files.replacement!.before.identity);
  assert.deepEqual(o.files.identity!.after, o.files.replacement!.after);
  assert.ok(unchanged(o, "replacement"));
  assert.deepEqual(
    writes(o, "identity").map((row) => row.method),
    ["begin", "append", "commit"],
  );
  for (const phase of ["identity", "registered-cancel", "core"]) {
    const registrations = selectedRows(o, phase, "destination", "register"),
      releases = selectedRows(o, phase, "destination", "release");
    assert.equal(registrations.length, 1);
    assert.equal(releases.length, 1);
    assert.equal(registrations[0]!.args.nativePath, o.files.cancel!.before.path);
    assert.deepEqual(registrations[0]!.args.scope, o.scope);
    assert.equal(releases[0]!.args.destination, registrations[0]!.result.destination);
    assert.ok(releases[0]!.start >= registrations[0]!.end);
    const output = writes(o, phase);
    if (phase === "registered-cancel") {
      assert.equal(output.length, 0);
      assert.ok(unchanged(o, phase));
      const cancelled = selectedRows(o, phase, "rpc", "storage/exportCancel");
      assert.equal(cancelled.length, 1);
      assert.equal(cancelled[0]!.result.ok, true);
      assert.equal(cancelled[0]!.result.value.disposition, "aborted");
      assert.ok(
        cancelled[0]!.start >= registrations[0]!.end && releases[0]!.start >= cancelled[0]!.end,
      );
    } else {
      assert.equal(output[0]!.args.destination, registrations[0]!.result.destination);
      assert.ok(output[0]!.start >= registrations[0]!.end);
      assert.deepEqual(output[0]!.args.owner.sourceKey, o.owner.sourceKey);
      assert.equal(output[0]!.args.sha256, hash(Buffer.from(output[1]!.args.data, "base64")));
    }
  }
  const core = writes(o, "core");
  assert.deepEqual(
    core.map((row) => row.method),
    ["begin", "append", "commit"],
  );
  assert.equal(core[2]!.result.disposition, "committed");
  assert.match(core[2]!.result.commitId, /^[0-9a-f-]{36}$/);
  assert.ok(["file-sync-only", "file-and-directory-sync"].includes(core[2]!.result.durability));
  assert.equal(o.files.core!.after.sha256, core[0]!.args.sha256);
  assert.notEqual(o.files.core!.before.sha256, o.files.core!.after.sha256);
  assert.ok(core.every((row) => row.args.job === core[0]!.args.job));
  const mint = selectedRows(o, "core", "core", "mint"),
    claim = selectedRows(o, "core", "core", "claim"),
    complete = selectedRows(o, "core", "core", "complete");
  assert.equal(mint.length, 1);
  assert.equal(claim.length, 1);
  assert.ok(complete.length >= 1);
  assert.deepEqual(mint[0]!.args.values[0], o.scope);
  assert.equal(mint[0]!.args.values[1].kind, "persistence-export");
  assert.deepEqual(claim[0]!.args.values, [mint[0]!.result.value, mint[0]!.args.values[1]]);
  assert.equal(claim[0]!.result.value, true);
  assert.ok(claim[0]!.start >= mint[0]!.end);
  assert.equal(
    selectedRows(o, "core", "destination", "register")[0]!.args.action,
    mint[0]!.result.value.actionToken,
  );
  assert.ok(complete.every((row) => same(row.args.values[0], mint[0]!.result.value)));
  const coreRpc = selectedRows(o, "core", "core-rpc", "export");
  assert.equal(coreRpc.length, 1);
  assert.deepEqual(coreRpc[0]!.args, {
    action: mint[0]!.result.value,
    recovery: mint[0]!.args.values[1].recovery,
  });
  assert.deepEqual(coreRpc[0]!.result, { ok: true, value: { disposition: "committed" } });
  assert.ok(
    coreRpc[0]!.start >= mint[0]!.end &&
      coreRpc[0]!.start <= claim[0]!.start &&
      coreRpc[0]!.end >= core[2]!.end,
  );
  assert.equal(selectedRows(o, "core", "feature").length, 0);
  const late = selectedRows(o, "late", "dialog")[0]!;
  assert.ok(o.renderer.pid > 0 && Number.isSafeInteger(o.renderer.pid));
  assert.ok(["crashed", "killed", "abnormal-exit"].includes(o.renderer.reason));
  assert.ok(Number.isSafeInteger(o.renderer.exitCode));
  assert.ok(
    late.start < o.renderer.at && o.renderer.at < late.end,
    "Actual renderer exit must precede late selected destination",
  );
  assert.equal(o.renderer.osExit.code, "ESRCH");
  assert.ok(o.renderer.osExit.at >= o.renderer.at && o.renderer.osExit.at < late.end);
  assert.equal(late.result.selected, o.files.late!.before.path);
  assert.ok(unchanged(o, "late"));
  assert.equal(writes(o, "late").length, 0);
  assert.equal(selectedRows(o, "late", "destination").length, 0);
  assert.equal(o.clipboard.beforeSha256, hash(o.clipboard.before));
  assert.equal(o.clipboard.afterSha256, hash(o.clipboard.after));
  assert.equal(o.clipboard.before, o.clipboard.after);
  assert.deepEqual(o.clipboard.writes, []);
  assert.equal(locks(o).length, 0);
  assert.equal(leaks(o), 0);
  const summary = actionSummary(o);
  for (const key of [
    "freshCoreAction",
    "cancelNoWrite",
    "lateDialogReleased",
    "identitySwapRejected",
  ])
    assert.equal(summary[key], true, key);
}
