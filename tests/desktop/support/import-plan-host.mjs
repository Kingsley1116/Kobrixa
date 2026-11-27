// A standalone store host lets the parent kill the initial plan writer before a
// coordinator has a plan or a record ticket. All disk inspection happens after exit.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { AtomicStore } from "../../../apps/desktop/src/main/plugins/persistence/atomic-store.ts";
import { createNodePersistenceFs } from "../../../apps/desktop/src/main/plugins/persistence/filesystem.ts";
import { Namespace } from "../../../apps/desktop/src/main/plugins/persistence/namespace.ts";
import { PublicationGate } from "../../../apps/desktop/src/main/plugins/persistence/engine-port.ts";
import { importIdFor } from "../../../apps/desktop/src/main/plugins/persistence/import-sources.ts";

const [root, mode, lease, raw] = process.argv.slice(2);
const { branch, cut, expected, retry, disposition, ticket: interrupted } = JSON.parse(raw);
const owner = {
  sourceKey: "builtin:test.synthetic",
  pluginId: "test.synthetic",
  generation: 1,
  hostEpoch: randomUUID(),
  processEpoch: randomUUID(),
};
const plan = {
  formatVersion: 1,
  id: importIdFor("test.synthetic.files", owner.sourceKey),
  descriptorId: "test.synthetic.files",
  mappingVersion: 1,
  targetSourceKey: owner.sourceKey,
  preferencesEvidence: null,
  items: [],
};
const fs = await createNodePersistenceFs(
  root,
  {
    hostEpoch: owner.hostEpoch,
    assertHeld() {
      assert.equal(readFileSync(path.join(root, "host.lock"), "utf8"), lease);
    },
  },
  { now: () => 0 },
);
const store = new AtomicStore(fs);
if (mode === "plan-blocked") await assert.rejects(store.initialize(), /recovery-blocked/);
else await store.initialize();
const update = branch === "abort-update";
if (mode === "plan-blocked") {
  assert.deepEqual(await store.reconcileImport(interrupted), { disposition: "unknown" });
  await store.dispose();
  process.send({ kind: "complete", epoch: owner.hostEpoch });
} else if (mode === "plan-restart") {
  const value = await store.loadImport(owner, plan.id);
  if (expected === "absent") assert.equal(value, null);
  else {
    assert.deepEqual(value.plan, plan);
    assert.equal(value.complete, expected === "complete");
  }
  if (interrupted) {
    const ns = await Namespace.open(fs, owner.sourceKey);
    const loc = await ns.location(interrupted.target);
    const head = await ns.head(loc);
    if (head) await ns.verify(loc, head);
    if (branch !== "initial-plan" || expected === "absent") {
      assert.deepEqual(head, JSON.parse(readFileSync(path.join(root, "plan-predecessor"), "utf8")));
    } else {
      assert.equal(head.receipt.commitId, interrupted.id);
    }
    const result = await store.reconcileImport(interrupted);
    assert.deepEqual(
      result,
      disposition === "committed" ? { disposition, receipt: head.receipt } : { disposition },
    );
  }
  if (retry) {
    await store.planImport(owner, plan);
    await store.completeImport(owner, plan.id);
    assert.equal((await store.loadImport(owner, plan.id)).complete, true);
  }
  await store.dispose();
  process.send({ kind: "complete", epoch: owner.hostEpoch });
} else {
  if (update) await store.planImport(owner, plan);
  const ns = await Namespace.open(fs, owner.sourceKey);
  const loc = await ns.location({ kind: "import", key: plan.id });
  const predecessor = await ns.head(loc);
  if (update) {
    assert.ok(predecessor);
    await ns.verify(loc, predecessor);
  } else assert.equal(predecessor, null);
  writeFileSync(path.join(root, "plan-predecessor"), JSON.stringify(predecessor), { flag: "wx" });
  const abort = branch !== "initial-plan";
  let cleaning = false,
    ticket;
  const reserve = store.reserve.bind(store);
  store.reserve = async (t, ...args) => {
    ticket = t;
    return reserve(t, ...args);
  };
  const fault = fs.fault.bind(fs);
  fs.fault = async (name) => {
    if (abort && name === "before-publish") {
      cleaning = true;
      throw Error("pre-dispatch-failure");
    }
    return fault(name);
  };
  const counts = new Map(),
    fds = new WeakMap();
  function mark(edge, method, p) {
    if (!ticket || (abort && !cleaning)) return;
    const full = p && fs.name(p);
    const rel = full
      ?.split(path.sep + "namespaces" + path.sep)[1]
      ?.split(path.sep)
      .slice(1)
      .join("/");
    if (p && !rel) return;
    const file = rel
      ?.replace("staging/" + ticket.id, "stage")
      .replace(/^imports\/objects\/r_[a-f0-9]{32}\.json$/, "imports/object")
      .replace(/^imports\/[a-f0-9]{64}\.json(?:\.[0-9a-f-]{36})?/, "imports/head");
    const name = [edge, method, file].filter(Boolean).join("/");
    const n = (counts.get(name) ?? 0) + 1;
    counts.set(name, n);
    const point = name + "#" + n;
    appendFileSync(path.join(root, "cut-trace"), JSON.stringify({ point, path: full }) + "\n");
    if (cut === point) {
      process.send({ kind: "armed", ticket });
      process.send({ kind: "cut", point, ticket: ticket.id, epoch: owner.hostEpoch });
      // Synchronous state transitions must also stay stopped until the OS kill.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
      throw Error("cut resumed");
    }
  }
  for (const [object, method, label] of [
    [PublicationGate.prototype, "dispatch", "dispatch"],
    [store, "cas", "cas"],
    ...["reserve", "commit", "release", "holdTemporary", "releaseTemporary"].map((method) => [
      store.quota,
      method,
      "quota-" + method,
    ]),
  ]) {
    const call = object[method];
    object[method] = function (...args) {
      mark("before", label);
      const value = call.apply(this, args);
      mark("after", label);
      return value;
    };
  }
  const at = fs.at.bind(fs);
  fs.at = async (point, work) => {
    mark("before", point);
    const result = await at(point, work);
    mark("after", point);
    return result;
  };
  for (const method of [
    "mkdir",
    "openOwned",
    "write",
    "sync",
    "closeOwned",
    "atomicReplace",
    "syncDirectory",
    "unlink",
    "removeEmpty",
  ]) {
    const call = fs[method].bind(fs);
    fs[method] = async (...args) => {
      const p = ["write", "sync", "closeOwned"].includes(method)
        ? fds.get(args[0])
        : args[method === "atomicReplace" ? 1 : 0];
      const active =
        p && (method !== "openOwned" || ["create-exclusive", "directory-sync"].includes(args[1]));
      if (active) mark("before", method, p);
      if (
        method === "write" &&
        args[1] === 0 &&
        p &&
        /journal-(intent|sealed|publication)\.tmp$/.test(fs.name(p))
      )
        args[2] = args[2].subarray(0, Math.floor(args[2].length / 2));
      const value = await call(...args);
      if (active && method === "openOwned") fds.set(value, p);
      if (active) mark("after", method, p);
      return value;
    };
  }
  const result = update ? store.completeImport(owner, plan.id) : store.planImport(owner, plan);
  if (abort) await assert.rejects(result, /not-committed/);
  else await result;
  await store.dispose();
  assert.ok(!cut, "missed cut " + cut);
  for (const effect of abort
    ? ["quota-release", ...(update ? ["quota-releaseTemporary"] : [])]
    : ["quota-reserve", "quota-commit", "dispatch", "cas", "receipt-send"]) {
    for (const edge of ["before", "after"])
      assert.ok(counts.has(edge + "/" + effect), "missing " + edge + "/" + effect);
  }
  process.send({ kind: "reference" });
}
