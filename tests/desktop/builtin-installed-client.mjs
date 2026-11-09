import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as pause } from "node:timers/promises";

const execute = promisify(execFile);
export async function until(read, label, milliseconds = 15_000) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    const result = await read();
    if (result) return result;
    await pause(100);
  }
  throw new Error(`Deadline: ${label}`);
}

// One bounded request table per socket; transport closure rejects pending work.
export async function connect(url) {
  const socket = new WebSocket(url);
  const pending = new Map();
  const events = new Map();
  const waitingEvents = new Set();
  let serial = 0;
  const fail = (error) => {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    pending.clear();
    for (const request of waitingEvents) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    waitingEvents.clear();
    events.clear();
  };
  socket.addEventListener("message", ({ data }) => {
    const reply = JSON.parse(data);
    if (reply.method) {
      for (const receive of events.get(reply.method) ?? []) receive(reply.params);
    }
    const request = pending.get(reply.id);
    if (!request) return;
    pending.delete(reply.id);
    clearTimeout(request.timer);
    if (reply.error) request.reject(new Error(JSON.stringify(reply.error)));
    else request.resolve(reply.result);
  });
  socket.addEventListener("close", () => fail(new Error("Debug transport closed")));
  socket.addEventListener("error", () => fail(new Error("Debug transport error")));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error("Debug attach deadline"));
    }, 5000);
    socket.addEventListener(
      "open",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
    socket.addEventListener(
      "error",
      () => {
        clearTimeout(timer);
        reject(new Error("Debug attach failed"));
      },
      { once: true },
    );
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++serial;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Debug request deadline: ${method}`));
      }, 10_000);
      pending.set(id, { resolve, reject, timer });
      try {
        socket.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        clearTimeout(timer);
        pending.delete(id);
        reject(error);
      }
    });
  return {
    send,
    event(method) {
      return new Promise((resolve, reject) => {
        const listeners = events.get(method) ?? new Set();
        events.set(method, listeners);
        const receive = (params) => {
          clearTimeout(timer);
          listeners.delete(receive);
          waitingEvents.delete(request);
          resolve(params);
        };
        const timer = setTimeout(() => {
          listeners.delete(receive);
          waitingEvents.delete(request);
          reject(new Error(`Debug event deadline: ${method}`));
        }, 10_000);
        const request = { timer, reject };
        waitingEvents.add(request);
        listeners.add(receive);
      });
    },
    async js(expression) {
      const reply = await send("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
      });
      if (reply.exceptionDetails) throw new Error(JSON.stringify(reply.exceptionDetails));
      return reply.result.value;
    },
    close() {
      fail(new Error("Debug client disposed"));
      socket.close();
    },
  };
}

export async function processTable() {
  const { stdout } = await execute("/bin/ps", ["-axo", "pid=,ppid=,pgid="], {
    timeout: 5000,
    maxBuffer: 4 * 1024 * 1024,
  });
  return stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [pid, ppid, pgid] = line.trim().split(/\s+/).map(Number);
      assert.ok([pid, ppid, pgid].every(Number.isSafeInteger), "Malformed OS process evidence");
      return { pid, ppid, pgid };
    });
}
export function descendants(table, parent, known = new Set()) {
  known.add(parent);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of table)
      if ((known.has(row.ppid) || row.pgid === parent) && !known.has(row.pid)) {
        known.add(row.pid);
        changed = true;
      }
  }
  return table.filter((row) => known.has(row.pid));
}

export async function command(file, args, options = {}) {
  return execute(file, args, { timeout: 30_000, maxBuffer: 4 * 1024 * 1024, ...options });
}

// A vanished group is normal during exit; other failures are retained without
// preventing cleanup of observed descendants that changed process groups.
export function signalProcess(pid, signal, errors, kill = process.kill) {
  try {
    kill(pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") errors.push(error);
  }
}
