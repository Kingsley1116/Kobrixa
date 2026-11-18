import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { ResourceOwner } from "@kobrixa/plugin-protocol";
import type { CoreWindowScope, PluginUiBridge, Principal } from "@kobrixa/plugin-runtime";
import type { UserPersistenceActions } from "../../apps/desktop/src/main/plugins/user-persistence-actions.js";
import type { CaseEvidence, LifecycleCaseInput } from "./plugin-persistence-main.js";
import type { ActionObservation } from "./plugin-persistence-action-replay.js";
// Heterogeneous captured public envelopes; no executable test inputs in the receipt.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Wire = Record<string, any>;
type Row = { name: string; start: number; end: number; args: Wire; result: Wire };
export type RendererLaunch = { owner: ResourceOwner; at: number };
export type RendererLossObservation = {
  owner: ResourceOwner;
  nextOwner: ResourceOwner;
  nextPrincipal: Principal;
  principal: Principal;
  scope: CoreWindowScope;
  rows: Row[];
  launches: RendererLaunch[];
  subscribedAt: number;
  exit: { owner: ResourceOwner; at: number; event: Wire };
  loss: { start: number; end: number; renderer: ActionObservation["renderer"] };
  intent: { scope: string; gesture: string; binding: Wire; lastPulse: number };
  mint: {
    owner: ResourceOwner;
    scope: CoreWindowScope;
    generation: number;
    action: string;
    at: number;
  };
  retired: { owner: ResourceOwner; reason: string; at: number }[];
  drains: {
    owner: ResourceOwner;
    reason: string;
    start: number;
    end: number;
    offer: Wire;
    report: Wire;
  }[];
  idle: { start: number; end: number; owners: ResourceOwner[] };
  restart: { start: number; end: number; command: string; result: Wire };
  trace: readonly { ticket: string | null; point: string; time: number }[];
};
type Input = LifecycleCaseInput & {
  scope(): CoreWindowScope;
  ui: PluginUiBridge;
  actions: UserPersistenceActions;
  seed(): Promise<void>;
  launches(): RendererLaunch[];
  owners(): ResourceOwner[];
  crash(probe: () => Promise<void>): Promise<ActionObservation["renderer"]>;
  restart(): Promise<{ owner: ResourceOwner; principal: Principal; command: string; result: Wire }>;
};
const value = (r: Wire): Wire => {
  assert.equal(r.ok, true, JSON.stringify(r));
  return r.value;
};
const row = (o: RendererLossObservation, name: string) => {
  const rows = o.rows.filter((r) => r.name === name);
  assert.equal(rows.length, 1, name);
  return rows[0]!;
};
const denied = (r: Row) => {
  assert.equal(r.result.ok, false, r.name);
  assert.ok(
    ["PLUGIN_E_STALE_RESOURCE", "PLUGIN_E_PERMISSION_DENIED", "PLUGIN_E_DEVICE_AUTHORITY"].includes(
      r.result.error?.code,
    ),
    r.name,
  );
};
const digest = (s: string) => createHash("sha256").update(Buffer.from(s, "base64")).digest("hex");
export function assertRendererLossObservation(o: RendererLossObservation): void {
  assert.ok(o && o.owner && o.loss && o.exit && o.mint);
  assert.equal(o.owner.sourceKey, "builtin:acceptance.ui-recording");
  assert.equal(o.principal.kind, "plugin");
  if (o.principal.kind !== "plugin") throw new Error("Missing original principal");
  assert.deepEqual(o.principal.owner, o.owner);
  assert.equal(o.scope.hostEpoch, o.owner.hostEpoch);
  for (const r of o.rows) {
    assert.ok(
      Number.isFinite(r.start) && r.start >= 0 && Number.isFinite(r.end) && r.end >= r.start,
    );
    assert.ok(r.args && r.result);
  }
  const seed = row(o, "storage/beginWrite"),
    chunk = row(o, "storage/writeChunk");
  assert.deepEqual(seed.args.principal, o.principal);
  assert.deepEqual(chunk.args.principal, o.principal);
  assert.equal(seed.args.params.target.mode, "create");
  assert.equal(chunk.args.params.write, value(seed.result).write);
  assert.equal(chunk.args.params.offset, 0);
  assert.ok(value(chunk.result).receivedBytes > 0);
  assert.equal(
    value(chunk.result).receivedBytes,
    Buffer.from(chunk.args.params.data, "base64").length,
  );
  assert.equal(digest(chunk.args.params.data), seed.args.params.sha256);
  assert.equal(seed.args.params.byteLength, value(chunk.result).receivedBytes);
  assert.ok(seed.end <= chunk.start && chunk.end <= o.loss.start);
  assert.equal(o.rows.filter((r) => r.name === "storage/sealWrite").length, 0);
  assert.equal(o.rows.filter((r) => r.name === "storage/commitWrite").length, 0);
  assert.ok(o.loss.start < seed.start + 30000, "Write expired before renderer loss");
  const invoke = row(o, "invoke");
  const binding = invoke.args.binding;
  for (const k of ["hostEpoch", "processEpoch", "generation"] as const)
    assert.equal(binding[k], o.owner[k]);
  assert.match(
    binding.panelInstance,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  );
  assert.ok(
    Number.isSafeInteger(binding.uiResourceGeneration) && binding.uiResourceGeneration >= 0,
  );
  assert.equal(binding.kind, "panel");
  assert.equal(binding.contributionId, "acceptance.ui-recording.panel");
  assert.equal(value(invoke.result).output["action-ref"], o.mint.action);
  assert.deepEqual(o.mint.owner, o.owner);
  assert.deepEqual(o.mint.scope, o.scope);
  assert.equal(o.mint.generation, binding.uiResourceGeneration);
  assert.ok(o.mint.at >= invoke.start && o.mint.at <= invoke.end && invoke.end <= o.loss.start);
  assert.deepEqual(o.intent.binding, {
    owner: o.owner,
    contextRef: o.principal.authorityContext!.ref,
    panelInstance: binding.panelInstance,
    uiResourceGeneration: binding.uiResourceGeneration,
    workbenchInstance: o.scope.workbenchInstance,
  });
  const prepare = row(o, "prepare");
  const prepared = value(prepare.result).operation;
  assert.equal(prepared.sessionId, prepare.args.params.sessionId);
  assert.equal(prepared.stage, "prepared");
  assert.equal(prepared.startAccepted, false);
  assert.deepEqual(prepare.args.principal, o.principal);
  assert.equal(prepare.args.params.motionScopeRef, o.intent.scope);
  assert.equal(prepare.args.params.gestureRef, o.intent.gesture);
  assert.equal(prepare.args.params.contextRef, o.intent.binding.contextRef);
  assert.equal(prepare.args.params.motion.mode, "jog");
  assert.ok(prepare.end <= o.loss.start);
  const renderer = o.loss.renderer;
  assert.ok(Number.isSafeInteger(renderer.pid) && renderer.pid > 0);
  assert.ok(["crashed", "killed", "abnormal-exit"].includes(renderer.reason));
  assert.ok(Number.isSafeInteger(renderer.exitCode));
  assert.equal(renderer.osExit.code, "ESRCH");
  assert.ok(
    o.loss.start <= renderer.at &&
      renderer.at <= renderer.osExit.at &&
      renderer.osExit.at <= o.loss.end,
  );
  assert.deepEqual(o.exit.owner, o.owner);
  assert.ok(o.subscribedAt <= o.loss.start && o.exit.at >= renderer.at && o.exit.at <= o.loss.end);
  assert.ok(o.exit.event.code === null || Number.isInteger(o.exit.event.code));
  const retires = o.retired.filter((r) => JSON.stringify(r.owner) === JSON.stringify(o.owner));
  assert.equal(retires.length, 1);
  assert.equal(retires[0]!.reason, "renderer-lost");
  assert.ok(retires[0]!.at >= renderer.at);
  const drains = o.drains.filter((d) => JSON.stringify(d.owner) === JSON.stringify(o.owner));
  assert.equal(drains.length, 1);
  assert.equal(drains[0]!.reason, "renderer-crash");
  assert.ok(drains[0]!.start >= renderer.at && drains[0]!.end <= o.loss.end);
  assert.deepEqual(drains[0]!.offer.owner, o.owner);
  assert.equal(drains[0]!.offer.reason, "renderer-crash");
  assert.deepEqual(drains[0]!.offer.writes, [
    { write: value(seed.result).write, id: value(seed.result).id, state: "receiving" },
  ]);
  assert.ok(drains[0]!.offer.deadlineMonotonicMs >= drains[0]!.start);
  const drainedRecord = drains[0]!.report.records.filter(
    (r: Wire) => r.id === value(seed.result).id,
  );
  assert.equal(drainedRecord.length, 1, "Drain must account for the original unfinished write");
  assert.equal(drainedRecord[0].final, false);
  assert.equal(drainedRecord[0].committedRevision, null);
  assert.equal(o.nextPrincipal.kind, "plugin");
  if (o.nextPrincipal.kind !== "plugin") throw new Error("Missing replacement principal");
  assert.deepEqual(o.nextPrincipal.owner, o.nextOwner);
  assert.ok(o.nextPrincipal.authorityContext);
  assert.notEqual(o.nextPrincipal.authorityContext.ref, o.principal.authorityContext!.ref);
  for (const name of ["old-action", "old-gesture", "old-epoch", "old-commit"]) {
    const r = row(o, name);
    denied(r);
    assert.deepEqual(r.args.principal, o.principal);
    assert.ok(r.start >= retires[0]!.at && r.end <= o.loss.end);
  }
  const action = row(o, "old-action");
  assert.deepEqual(action.args.params, {
    actionRef: o.mint.action,
    text: "renderer-loss sentinel",
  });
  assert.ok(action.end < o.mint.at + 5000, "Action merely expired");
  const gesture = row(o, "old-gesture");
  assert.deepEqual(gesture.args.params, prepare.args.params);
  assert.ok(
    o.intent.lastPulse <= o.loss.start && gesture.end < o.intent.lastPulse + 350,
    "Gesture merely expired",
  );
  assert.deepEqual(row(o, "old-epoch").args.params, { schemaVersion: 1 });
  assert.deepEqual(row(o, "old-commit").args.params, { write: value(seed.result).write });
  assert.ok(row(o, "old-commit").end < seed.start + 30000, "Write merely expired");
  assert.ok(o.idle.start >= o.loss.end && o.idle.end >= o.idle.start + 100);
  assert.equal(o.idle.owners.filter((owner) => owner.sourceKey === o.owner.sourceKey).length, 0);
  assert.ok(o.restart.start >= o.idle.end && o.restart.end >= o.restart.start);
  assert.equal(o.restart.command, "acceptance.ui-recording.legacy");
  assert.equal(o.restart.result.ok, true);
  assert.equal(o.nextOwner.sourceKey, o.owner.sourceKey);
  assert.equal(o.nextOwner.pluginId, o.owner.pluginId);
  assert.equal(o.nextOwner.hostEpoch, o.owner.hostEpoch);
  assert.ok(o.nextOwner.generation > o.owner.generation);
  assert.notEqual(o.nextOwner.processEpoch, o.owner.processEpoch);
  const launches = o.launches.filter((l) => l.owner.sourceKey === o.owner.sourceKey);
  assert.equal(launches.length, 2, "Unrequested launch/replay");
  assert.deepEqual(launches[0]!.owner, o.owner);
  assert.ok(launches[0]!.at <= o.subscribedAt);
  assert.deepEqual(launches[1]!.owner, o.nextOwner);
  assert.ok(launches[1]!.at >= o.restart.start && launches[1]!.at <= o.restart.end);
  assert.equal(
    o.trace.filter(
      (t) =>
        t.ticket === value(seed.result).write &&
        ["before-publish", "after-publish", "receipt-send"].includes(t.point),
    ).length,
    0,
  );
}
export function rendererLossSummary(o: RendererLossObservation): CaseEvidence["checks"] {
  return {
    processExited: o.exit.at >= o.loss.renderer.at,
    explicitRestart:
      o.launches.filter((l) => l.owner.sourceKey === o.owner.sourceKey).length === 2 &&
      o.launches.find((l) => l.owner.processEpoch === o.nextOwner.processEpoch)!.at >=
        o.restart.start,
    oldActionDenied: row(o, "old-action").result.ok === false,
    oldGestureDenied: row(o, "old-gesture").result.ok === false,
    oldEpochDenied: row(o, "old-epoch").result.ok === false,
    oldCommitDenied: row(o, "old-commit").result.ok === false,
    newGeneration: o.nextOwner.generation,
    previousGeneration: o.owner.generation,
  };
}
export function assertRendererLossEvidence(
  e: { rendererLoss?: RendererLossObservation; checks: CaseEvidence["checks"] },
  hostEpoch?: string,
): void {
  assert.ok(e.rendererLoss, "Missing renderer-loss raw proof");
  assertRendererLossObservation(e.rendererLoss);
  if (hostEpoch !== undefined) assert.equal(e.rendererLoss.owner.hostEpoch, hostEpoch);
  assert.deepEqual(e.checks, rendererLossSummary(e.rendererLoss));
}
async function bounded<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("renderer-loss observation timed out")), 15000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
/** Native UNRUN until the outside runner validates the actual composition receipt. */
export async function produceRendererLoss(
  input: Input,
): Promise<CaseEvidence & { rendererLoss: RendererLossObservation }> {
  const principal = input.recording.principal();
  assert.equal(principal.kind, "plugin");
  if (principal.kind !== "plugin" || !principal.authorityContext)
    throw new Error("Original bound channel required");
  const owner = structuredClone(principal.owner),
    scope = input.scope(),
    rows: Row[] = [];
  const retired: RendererLossObservation["retired"] = [],
    drains: RendererLossObservation["drains"] = [];
  const restores: (() => void)[] = [];
  let pulse: ReturnType<typeof setInterval> | undefined;
  let exit: RendererLossObservation["exit"] | undefined,
    mint: RendererLossObservation["mint"] | undefined;
  const subscribedAt = input.now();
  restores.push(
    input.recording.child.onExit((event) => {
      exit = { owner, at: input.now(), event: structuredClone(event) };
    }),
  );
  const observe = async (name: string, args: Wire, work: () => Promise<unknown>) => {
    const start = input.now(),
      result = await bounded(work());
    rows.push({
      name,
      args: structuredClone(args),
      result: structuredClone(result) as Wire,
      start,
      end: input.now(),
    });
    return result as Wire;
  };
  const signal = new AbortController().signal;
  const host = input.host.request;
  let seeding = false;
  input.host.request = async function (this: typeof input.host, ...args) {
    if (seeding && args[0].kind === "plugin" && args[0].owner.processEpoch === owner.processEpoch)
      return observe(args[1], { principal: args[0], params: args[2] }, () =>
        host.apply(this, args),
      ) as ReturnType<typeof host>;
    return host.apply(this, args);
  } as typeof host;
  restores.push(() => {
    input.host.request = host;
  });
  const mintPort = input.actions.mint;
  input.actions.mint = function (o, s, generation) {
    const action = mintPort.call(this, o, s, generation);
    if (o.processEpoch === owner.processEpoch)
      mint = {
        owner: structuredClone(o),
        scope: structuredClone(s),
        generation,
        action,
        at: input.now(),
      };
    return action;
  };
  restores.push(() => {
    input.actions.mint = mintPort;
  });
  const retirePort = input.stage3.device.retire;
  input.stage3.device.retire = function (o, reason) {
    retired.push({ owner: structuredClone(o), reason, at: input.now() });
    return retirePort.call(this, o, reason);
  };
  restores.push(() => {
    input.stage3.device.retire = retirePort;
  });
  const drainPort = input.host.participant.drain;
  input.host.participant.drain = async function (offer, dispatch) {
    const start = input.now();
    const report = await drainPort.call(this, offer, dispatch);
    drains.push({
      owner: structuredClone(offer.owner),
      reason: offer.reason,
      start,
      end: input.now(),
      offer: structuredClone(offer),
      report: structuredClone(report),
    });
    return report;
  };
  restores.push(() => {
    input.host.participant.drain = drainPort;
  });
  let intentScope: string | undefined;
  try {
    seeding = true;
    await bounded(input.seed());
    seeding = false;
    const catalog = value(await input.ui.catalog({}));
    const panel = catalog.entries.find(
      (e: Wire) => e.sourceKey === owner.sourceKey && e.kind === "panel",
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
    // Actual broker connection, but no recording or movement is started.
    const request = (method: string, params: Wire) =>
      input.broker.request(principal, method as never, params as never, signal) as Promise<Wire>;
    const inventory = value(await request("devices/list", {}));
    let session = inventory.sessions.find((s: Wire) => s.state === "connected");
    if (!session) {
      const provider = inventory.providers.find((p: Wire) => p.state === "available");
      assert.ok(provider);
      const discovered = value(
        await request("devices/discover", { providerId: provider.providerId }),
      );
      session = value(
        await request("devices/connect", {
          target: { kind: "candidate", candidateId: discovered.candidates[0].candidateId },
        }),
      ).session;
    }
    const current = value(await request("devices/session", { sessionId: session.sessionId }));
    const actuator = current.sources.actuators.find((a: Wire) => a.state === "ready");
    assert.ok(actuator);
    const binding = {
      owner,
      contextRef: principal.authorityContext.ref,
      panelInstance: opened.binding.panelInstance,
      uiResourceGeneration: opened.binding.uiResourceGeneration,
      workbenchInstance: scope.workbenchInstance,
    };
    intentScope = input.broker.intent.bindMotionScope(binding);
    let sequence = 0;
    input.broker.intent.pulsePanel(intentScope, ++sequence);
    const gesture = input.broker.intent.beginGesture(intentScope, ++sequence);
    let lastPulse = input.now();
    const tick = () => {
      lastPulse = input.now();
      input.broker.intent.pulsePanel(intentScope!, ++sequence);
      input.broker.intent.pulseGesture(gesture, ++sequence);
    };
    pulse = setInterval(tick, 50);
    const params = {
      sessionId: session.sessionId,
      contextRef: principal.authorityContext.ref,
      motionScopeRef: intentScope,
      gestureRef: gesture,
      motion: { actuatorId: actuator.actuatorId, mode: "jog", power: 1, direction: 1, brake: true },
    };
    value(
      await observe("prepare", { principal, params }, () =>
        request("devices/motion/prepare", params),
      ),
    );
    const invocation = {
      binding: opened.binding,
      nodeId: "run",
      formRevision: opened.formRevision + 1,
      form: { ...opened.form, speed: -90 },
    };
    value(await observe("invoke", invocation, () => input.ui.invoke(invocation)));
    assert.ok(mint);
    tick();
    clearInterval(pulse);
    pulse = undefined;
    const staged = value(row({ rows } as RendererLossObservation, "storage/beginWrite").result);
    const lossStart = input.now();
    const renderer = await bounded(
      input.crash(async () => {
        await Promise.all([
          observe(
            "old-action",
            { principal, params: { actionRef: mint!.action, text: "renderer-loss sentinel" } },
            () =>
              host.call(
                input.host,
                principal,
                "ui/copyText",
                { actionRef: mint!.action, text: "renderer-loss sentinel" },
                signal,
              ),
          ),
          observe("old-gesture", { principal, params }, () =>
            request("devices/motion/prepare", params),
          ),
          observe("old-epoch", { principal, params: { schemaVersion: 1 } }, () =>
            host.call(input.host, principal, "settings/read", { schemaVersion: 1 }, signal),
          ),
          observe("old-commit", { principal, params: { write: staged.write } }, () =>
            host.call(
              input.host,
              principal,
              "storage/commitWrite",
              { write: staged.write },
              signal,
            ),
          ),
        ]);
      }),
    );
    assert.ok(exit, "Original child exit was not observed");
    const loss = { start: lossStart, end: input.now(), renderer };
    const idleStart = input.now();
    await new Promise((resolve) => setTimeout(resolve, 125));
    const idle = { start: idleStart, end: input.now(), owners: structuredClone(input.owners()) };
    const restartStart = input.now(),
      next = await bounded(input.restart());
    const o: RendererLossObservation = {
      owner,
      nextOwner: next.owner,
      nextPrincipal: next.principal,
      principal,
      scope,
      rows,
      subscribedAt,
      exit,
      mint,
      loss,
      intent: { scope: intentScope, gesture, binding, lastPulse },
      retired,
      drains,
      idle,
      restart: {
        start: restartStart,
        end: input.now(),
        command: next.command,
        result: next.result,
      },
      launches: structuredClone(input.launches()),
      trace: structuredClone(input.fault.trace()),
    };
    assertRendererLossObservation(o);
    return { rendererLoss: o, checks: rendererLossSummary(o), events: [], samples: {} };
  } finally {
    clearInterval(pulse);
    seeding = false;
    try {
      if (intentScope) input.broker.intent.revokeScope(intentScope, "closed");
    } finally {
      for (const restore of restores.reverse()) restore();
    }
  }
}
