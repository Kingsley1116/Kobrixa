import { traceImportCuts } from "../../support/import-cut-trace.mjs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { AtomicStore } from "../../../../apps/desktop/src/main/plugins/persistence/atomic-store.ts";
import { existsSync, readFileSync, appendFileSync } from "node:fs";
import { parentPort, workerData } from "node:worker_threads";
import {
  runPersistenceWorker,
  WorkerSources,
} from "../../../../apps/desktop/src/main/plugins/persistence/worker.ts";
import { Namespace } from "../../../../apps/desktop/src/main/plugins/persistence/namespace.ts";
import { NodePersistenceFs } from "../../../../apps/desktop/src/main/plugins/persistence/filesystem.ts";
import { syntheticImportDescriptor as descriptor } from "../../../../apps/desktop/src/main/plugins/persistence/import-fixtures.ts";
import { sensorLabImportDescriptors } from "../../../../apps/desktop/src/main/plugins/persistence/sensor-lab-import.ts";

// Emit after-edges through the real worker fault port. Scope instrumentation to the
// record attempt so a journal publication cannot consume its kill or failure.
function traceRecordSteps() {
  // Fault control and RPC use separate ports. Acknowledge arming on the fault
  // port before the parent dispatches an operation whose first edge can be synchronous.
  workerData.faultPort?.on("message", (message) => {
    if (message.kind === "arm")
      workerData.faultPort.postMessage({
        point: "armed/" + message.point,
        time: performance.now(),
        ticket: null,
      });
  });
  const scope = new AsyncLocalStorage();
  const ticketCounts = new WeakMap();
  const descriptorPaths = new WeakMap();

  function role(fs, p, entry) {
    const name = fs.name(p);
    if (fs !== entry.ns.fs) return "original";
    const relative = path.relative(fs.name(entry.ns.path()), name).split(path.sep).join("/");
    return relative
      .replace("quarantine/" + entry.ticket.id + ".prepublish.bin", "quarantine/object")
      .replace("quarantine/" + entry.ticket.id + ".prepublish-head", "quarantine/candidate")
      .replace("records/" + entry.ticket.target.id, "record")
      .replace("staging/" + entry.ticket.id, "stage")
      .replace("head." + entry.ticket.id + ".tmp", "candidate")
      .replace("head.json." + entry.ticket.id + ".backup", "backup")
      .replace(/^record\/objects\/[^/]+\.bin$/, "record/object")
      .replace(/^imports\/objects\/[^/]+\.json$/, "journal/object")
      .replace(/^imports\/[^/]+\.json$/, "journal/head");
  }
  for (const [method, phase] of [
    ["publishOne", "publish"],
    ["removeUnpublished", "abort"],
  ]) {
    const original = AtomicStore.prototype[method];
    AtomicStore.prototype[method] = function (entry, ...args) {
      if (!entry.tag) return original.call(this, entry, ...args);
      const counts = ticketCounts.get(entry) ?? new Map();
      ticketCounts.set(entry, counts);
      return scope.run({ entry, phase, counts }, async () => {
        const result = await original.call(this, entry, ...args);
        // A terminal marker on the same FIFO port binds the complete reference
        // trace to the successful return from this exact phase.
        await fault.call(entry.ns.fs, "finished/" + phase + "/" + counts.get(phase));
        return result;
      });
    };
  }
  const fault = NodePersistenceFs.prototype.fault;
  async function after(label) {
    const { entry, phase, counts } = scope.getStore();
    const key = phase + "/" + label;
    const count = (counts.get(key) ?? 0) + 1;
    counts.set(key, count);
    counts.set(phase, (counts.get(phase) ?? 0) + 1);
    await fault.call(entry.ns.fs, key + (count > 1 ? "/" + count : ""));
  }
  const fs = NodePersistenceFs.prototype;
  for (const method of [
    "openOwned",
    "write",
    "sync",
    "closeOwned",
    "atomicReplace",
    "syncDirectory",
    "unlink",
    "removeEmpty",
    "pathStamp",
    "exists",
    "readInto",
  ]) {
    const original = fs[method];
    fs[method] = async function (...args) {
      const active = scope.getStore();
      if (
        active &&
        method === "atomicReplace" &&
        path.basename(this.name(args[1])) === "head.json"
      ) {
        if (!active.entry.gate.dispatched) throw Error("head rename before dispatch");
        await after("dispatch");
      }
      const result = await original.apply(this, args);
      if (method === "openOwned") descriptorPaths.set(result, args[0]);
      if (active) {
        const p = ["readInto", "write", "sync", "closeOwned"].includes(method)
          ? descriptorPaths.get(args[0])
          : args[method === "atomicReplace" ? 1 : 0];
        await after(method + "/" + role(this, p, active.entry));
      }
      return result;
    };
  }
  const at = fs.at;
  fs.at = async function (point, work) {
    const result = await at.call(this, point, work);
    if (scope.getStore() && !point.includes("/")) await after(point);
    return result;
  };
}
const recording = sensorLabImportDescriptors[0];
const checked = { ...descriptor };
delete checked.identityRecord;
checked.id = "test.checked-import";
checked.checkedFileRecord = checked.map;
runPersistenceWorker({
  mappers: new Map([
    [descriptor.id, descriptor],
    [checked.id, checked],
    [recording.id, recording],
  ]),
  sourceRootsForStore(root) {
    const base = path.resolve(root, "../.."),
      legacy = path.join(base, "legacy");
    const faultFile = path.join(base, "fault");
    if (existsSync(faultFile)) {
      const fault = readFileSync(faultFile, "utf8");
      if (fault === "process-steps")
        traceImportCuts(base, JSON.parse(readFileSync(path.join(base, "cut-config"), "utf8")));
      else if (fault === "record-steps") traceRecordSteps();
      else if (fault === "drop-map") {
        const post = parentPort.postMessage.bind(parentPort);
        parentPort.postMessage = (frame, ...args) => {
          if (frame.value?.mapped) {
            parentPort.postMessage = post;
            return;
          }
          return post(frame, ...args);
        };
      } else if (fault === "cancel-before-map") {
        // Deliver cancellation before the first allocation exists. Subsequent
        // requests wait for its terminal reply, including worker-side cleanup.
        const terminal = Promise.withResolvers();
        const map = WorkerSources.prototype.map;
        let waiting = true;
        WorkerSources.prototype.map = async function (id, key, requestId) {
          if (waiting) {
            waiting = false;
            const post = parentPort.postMessage.bind(parentPort);
            parentPort.postMessage = (frame, ...args) => {
              if (frame.id === requestId) {
                parentPort.postMessage = post;
                terminal.resolve();
              }
              return post(frame, ...args);
            };
            await new Promise((resolve) => {
              const cancelled = (frame) => {
                if (frame.kind !== "cancel" || frame.id !== requestId) return;
                parentPort.off("message", cancelled);
                resolve();
              };
              parentPort.on("message", cancelled);
            });
          } else await terminal.promise;
          return map.call(this, id, key, requestId);
        };
      } else if (fault === "destination-close" || fault === "candidate-head-close") {
        const verify = Namespace.prototype.verifyFd;
        const close = NodePersistenceFs.prototype.close;
        let armed,
          failed = false;
        const open = NodePersistenceFs.prototype.open;
        NodePersistenceFs.prototype.open = async function (p, mode, ...rest) {
          const fd = await open.call(this, p, mode, ...rest);
          if (
            !failed &&
            fault === "candidate-head-close" &&
            mode === "read" &&
            path.basename(this.name(p)).startsWith("head.") &&
            this.name(p).endsWith(".tmp")
          )
            armed = fd;
          return fd;
        };
        Namespace.prototype.verifyFd = async function (fd, head) {
          await verify.call(this, fd, head);
          if (
            !failed &&
            fault === "destination-close" &&
            head.importTag &&
            head.target.kind === "record"
          )
            armed = fd;
        };
        NodePersistenceFs.prototype.close = async function (fd) {
          if (fd === armed) {
            armed = undefined;
            failed = true;
            throw Error("injected-close");
          }
          return close.call(this, fd);
        };
      } else if (fault === "late-file") {
        const inventoryPage = WorkerSources.prototype.inventoryPage;
        let added = false;
        WorkerSources.prototype.inventoryPage = async function (...args) {
          const page = await inventoryPage.apply(this, args);
          if (page.cursor && !added) {
            await writeFile(path.join(legacy, "late"), '{"formatVersion":1,"late":true}', {
              flag: "wx",
            });
            added = true;
          }
          return page;
        };
      } else if (fault === "source-close" || fault === "inventory-directory-close") {
        const targets = new WeakSet();
        const open = NodePersistenceFs.prototype.open;
        NodePersistenceFs.prototype.open = async function (p, mode, ...rest) {
          const fd = await open.call(this, p, mode, ...rest);
          if (
            this.root === legacy &&
            mode === (fault === "source-close" ? "read" : "directory-list")
          )
            targets.add(fd);
          return fd;
        };
        const close = NodePersistenceFs.prototype.close;
        NodePersistenceFs.prototype.close = async function (fd) {
          await close.call(this, fd);
          if (targets.has(fd) && existsSync(path.join(base, "armed"))) {
            appendFileSync(path.join(base, "attempts"), "x");
            throw new Error("injected-close");
          }
        };
      }
    }
    const roots = new Map([[descriptor.id, legacy]]);
    if (existsSync(path.join(base, "checked"))) roots.set(checked.id, path.join(base, "checked"));
    if (existsSync(path.join(base, "recordings")))
      roots.set(recording.id, path.join(base, "recordings"));
    return roots;
  },
});
