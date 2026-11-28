// Only installed in a disposable worker. Synchronous pauses keep the exact edge
// stopped while its OS parent obtains the full prefix and kills the host process.
import { AsyncLocalStorage } from "node:async_hooks";
import { appendFileSync } from "node:fs";
import path from "node:path";
import { BroadcastChannel } from "node:worker_threads";
import { PublicationGate } from "../../../apps/desktop/src/main/plugins/persistence/engine-port.ts";
import { AtomicStore } from "../../../apps/desktop/src/main/plugins/persistence/atomic-store.ts";
import { NodePersistenceFs } from "../../../apps/desktop/src/main/plugins/persistence/filesystem.ts";
import { QuotaLedger } from "../../../apps/desktop/src/main/plugins/persistence/quota.ts";

export function traceImportCuts(root, config) {
  const scope = new AsyncLocalStorage(),
    files = new WeakMap(),
    counts = new Map();
  const channel = new BroadcastChannel(config.lease);
  channel.unref();
  let record = config.ticket,
    journalTicket;
  const isJournal = (phase) => ["admission", "journal", "completion"].includes(phase);
  function mark(edge, operation, file = "", diskPath, from) {
    const phase = scope.getStore();
    if (!phase) return;
    const name = [phase, edge, operation, file].filter(Boolean).join("/");
    const occurrence = (counts.get(name) ?? 0) + 1;
    counts.set(name, occurrence);
    const point = name + "#" + occurrence;
    const event = { point, ticket: record.id, target: record.target.id, file, diskPath, from };
    appendFileSync(path.join(root, "cut-trace"), JSON.stringify(event) + "\n");
    if (point === config.cut) {
      channel.postMessage({ kind: "cut", point, ticket: record, event });
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
      throw Error("cut resumed");
    }
  }
  function aroundAsync(proto, name, phaseFor) {
    const call = proto[name];
    proto[name] = async function (...args) {
      const phase = phaseFor(...args);
      if (!phase) return call.apply(this, args);
      return scope.run(phase, async () => {
        mark("before", "call");
        const value = await call.apply(this, args);
        mark("after", "reply");
        return value;
      });
    };
  }
  const store = AtomicStore.prototype;
  if (config.recovery) aroundAsync(store, "initialize", () => "recovery");
  else {
    for (const name of [
      "reserve",
      "tagImport",
      "append",
      "seal",
      "publishOne",
      "removeUnpublished",
    ]) {
      aroundAsync(store, name, (entry) => {
        const t = entry.ticket ?? entry;
        if (t.target.kind === "import" && isJournal(scope.getStore())) journalTicket = t;
        if (t.target.id !== config.ticket.target.id) return;
        record = t;
        return name;
      });
    }
    aroundAsync(store, "writeDocument", (_owner, kind, key, doc) => {
      if (kind !== "import" || key !== config.plan.id) return;
      const item = doc.items.find((i) => i.key === config.plan.items[1].key);
      if (!item?.publicationTicket) return;
      record = item.publicationTicket;
      return doc.complete ? "completion" : item.state === "committed" ? "journal" : "admission";
    });
    for (const [proto, method] of [
      [PublicationGate.prototype, "dispatch"],
      [store, "cas"],
    ]) {
      const original = proto[method];
      proto[method] = function (...args) {
        if (!scope.getStore()) return original.apply(this, args);
        mark("before", method);
        const value = original.apply(this, args);
        mark("after", method);
        return value;
      };
    }
    for (const method of ["release", "commit", "holdTemporary", "releaseTemporary"]) {
      const original = QuotaLedger.prototype[method];
      QuotaLedger.prototype[method] = function (id, ...args) {
        const abortHold =
          scope.getStore() === "removeUnpublished" &&
          typeof args[0] === "string" &&
          args[0].endsWith(record.id + ".prepublish.bin");
        if (!scope.getStore() || (!abortHold && id !== record.id && id !== journalTicket?.id))
          return original.call(this, id, ...args);
        mark("before", "quota-" + method);
        const value = original.call(this, id, ...args);
        mark("after", "quota-" + method);
        return value;
      };
    }
  }
  function role(fs, p) {
    const name = fs.name(p).split(path.sep).join("/");
    const base = name.split("/namespaces/")[1]?.split("/").slice(1).join("/") ?? "";
    if (isJournal(scope.getStore())) {
      return base
        .replace("staging/" + journalTicket?.id, "journal-stage")
        .replace(/^imports\/objects\/r_[a-f0-9]{32}\.json$/, "journal/object")
        .replace(/^imports\/[a-f0-9]{64}\.json\.[0-9a-f-]{36}\.(tmp|backup)$/, "journal/$1")
        .replace(/^imports\/[a-f0-9]{64}\.json\.previous$/, "journal/previous")
        .replace(/^imports\/[a-f0-9]{64}\.json$/, "journal/head");
    }
    return base
      .replace("staging/" + config.recoveryJournalId, "journal-stage")
      .replace("records/" + record.target.id, "record")
      .replace("staging/" + record.id, "stage")
      .replace("head." + record.id + ".tmp", "candidate")
      .replace(record.id + ".prepublish.bin", "object")
      .replace(record.id + ".prepublish-head", "candidate")
      .replace(/^record\/objects\/r_[a-f0-9]{32}\.bin$/, "record/object");
  }
  const fs = NodePersistenceFs.prototype;
  const at = fs.at;
  fs.at = async function (name, work) {
    const phase = scope.getStore();
    if (
      !phase ||
      ![
        "import-marker",
        "backup-head",
        "open-temp",
        "reserve",
        "seal-sync",
        "head-write",
        "object-rename",
        "object-dir-sync",
        "before-publish",
        "after-publish",
        "head-dir-sync",
        "cache-publish",
        "cleanup",
        "receipt-send",
      ].includes(name)
    )
      return at.call(this, name, work);
    mark("before", name);
    if (config.failure === name && name !== "head-write" && ["seal", "publishOne"].includes(phase))
      throw Error("injected-" + name);
    const result = await at.call(this, name, work);
    mark("after", name);
    if (config.failure === "head-write" && name === "head-write" && phase === "publishOne")
      throw Error("injected-candidate-write");
    return result;
  };
  for (const method of [
    "mkdir",
    "openOwned",
    "write",
    "sync",
    "closeOwned",
    "atomicReplace",
    "unlink",
    "syncDirectory",
    "removeEmpty",
  ]) {
    const original = fs[method];
    fs[method] = async function (...args) {
      const phase = scope.getStore();
      const descriptor = ["write", "sync", "closeOwned"].includes(method);
      const p = descriptor ? files.get(args[0]) : args[method === "atomicReplace" ? 1 : 0];
      const file = p && role(this, p);
      const writeFd =
        method !== "openOwned" || ["create-exclusive", "directory-sync"].includes(args[1]);
      const target =
        file &&
        /^(record|records|stage|staging|quarantine|journal|journal-stage|imports)(\/|$)/.test(file);
      const active = phase && target && writeFd && !(phase === "recovery" && method === "mkdir");
      const diskPath = active ? this.name(p) : undefined;
      const from = active && method === "atomicReplace" ? this.name(args[0]) : undefined;
      if (active) mark("before", method, file, diskPath, from);
      // Exercise a legal short write at the adapter boundary. writeAll must issue
      // the second call while the final pathname is still absent.
      if (
        method === "write" &&
        ((isJournal(phase) &&
          /^journal-stage\/journal-(intent|sealed|publication)\.tmp$/.test(file)) ||
          (phase === "reserve" &&
            ["stage/import-record-intent.tmp", "stage/intent.json"].includes(file))) &&
        args[1] === 0 &&
        args[2].length > 1
      )
        args[2] = args[2].subarray(0, Math.floor(args[2].length / 2));
      const result = await original.apply(this, args);
      if (method === "openOwned" && writeFd) files.set(result, args[0]);
      if (active) mark("after", method, file, diskPath, from);
      return result;
    };
  }
  channel.postMessage({ kind: "armed", ticket: config.ticket, cut: config.cut });
}
