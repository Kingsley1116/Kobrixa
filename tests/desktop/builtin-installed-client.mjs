import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as pause } from "node:timers/promises";

const execute = promisify(execFile);
export async function until(read, label, milliseconds = 15_000, diagnostics) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    const result = await read(Math.max(1, deadline - Date.now()));
    if (result) return result;
    await pause(Math.min(100, Math.max(0, deadline - Date.now())));
  }
  let detail;
  if (diagnostics) {
    try {
      detail = await diagnostics();
    } catch (error) {
      detail = { diagnosticsError: error.message };
    }
  }
  throw new Error(`Deadline: ${label}${detail === undefined ? "" : `: ${JSON.stringify(detail)}`}`);
}

// One bounded request table per socket; transport closure rejects pending work.
export async function connect(url) {
  const socket = new WebSocket(url);
  const pending = new Map();
  const events = new Map();
  const waitingEvents = new Set();
  const closeListeners = new Set();
  let closedError;
  let serial = 0;
  const fail = (error) => {
    if (closedError) return;
    closedError = error;
    for (const receive of closeListeners) receive(error);
    closeListeners.clear();
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
      if (closedError) return reject(closedError);
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
    on(method, receive) {
      const listeners = events.get(method) ?? new Set();
      events.set(method, listeners);
      listeners.add(receive);
      return () => listeners.delete(receive);
    },
    onClose(receive) {
      if (closedError) receive(closedError);
      else closeListeners.add(receive);
      return () => closeListeners.delete(receive);
    },
    event(method) {
      return new Promise((resolve, reject) => {
        if (closedError) return reject(closedError);
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

// --inspect-brk is inherited by Worker threads whose options omit execArgv.
// Enable attachment BEFORE releasing the main thread. Do not enable Debugger
// in workers: release the inherited wait without introducing another breakpoint.
// NodeWorker's envelope ACK is not the worker's Runtime reply. Correlate both,
// then detach promptly: an attached worker inspector can prevent natural exit.
// Release even when waitingForDebugger is false: Node reports the auto-attach
// wait flag there, while inherited --inspect-brk can independently require a wait.
export async function releaseStartingWorkers(client, evidence, timeoutMs = 5000) {
  evidence.enabled = false;
  evidence.waitForDebuggerOnStart = false;
  evidence.targets = [];
  const pending = new Map();
  const tasks = new Set();
  let failure,
    disposed = false;
  const rejectPending = (error) => {
    for (const request of pending.values()) request.reject(error);
  };
  const off = [
    client.on("NodeWorker.receivedMessageFromWorker", ({ sessionId, message }) => {
      const request = pending.get(sessionId);
      if (!request) return;
      try {
        const reply = JSON.parse(message);
        if (reply.id !== 1) return;
        if (reply.error) request.reject(new Error(JSON.stringify(reply.error)));
        else request.resolve(reply.result);
      } catch (error) {
        request.reject(error);
      }
    }),
    client.on("NodeWorker.detachedFromWorker", ({ sessionId }) => {
      pending
        .get(sessionId)
        ?.reject(new Error(`Worker detached before release reply: ${sessionId}`));
    }),
    client.onClose(rejectPending),
  ];
  off.push(
    client.on("NodeWorker.attachedToWorker", ({ sessionId, workerInfo, waitingForDebugger }) => {
      const row = { sessionId, workerInfo, waitingForDebugger, attachedAt: Date.now() };
      evidence.targets.push(row);
      const task = (async () => {
        let timer;
        try {
          const deadline = new Promise((resolve, reject) => {
            timer = setTimeout(
              () => reject(new Error(`Worker release deadline: ${sessionId}`)),
              timeoutMs,
            );
          });
          const reply = new Promise((resolve, reject) => {
            pending.set(sessionId, { resolve, reject });
          });
          await Promise.race([
            deadline,
            Promise.all([
              reply,
              client.send("NodeWorker.sendMessageToWorker", {
                sessionId,
                message: JSON.stringify({
                  id: 1,
                  method: "Runtime.runIfWaitingForDebugger",
                  params: {},
                }),
              }),
            ]),
          ]);
          row.releasedAt = Date.now();
        } finally {
          clearTimeout(timer);
          pending.delete(sessionId);
        }
        await client.send("NodeWorker.detach", { sessionId });
        row.detachedAt = Date.now();
      })().catch((error) => {
        row.error = { name: error.name, message: error.message };
        if (!disposed)
          failure ??= new Error(`Worker startup inspector: ${sessionId}: ${error.message}`);
      });
      tasks.add(task);
      void task.then(() => tasks.delete(task));
    }),
  );
  const dispose = () => {
    disposed = true;
    for (const remove of off) remove();
    rejectPending(new Error("Worker startup observer disposed"));
  };
  try {
    await client.send("NodeWorker.enable", { waitForDebuggerOnStart: false });
    evidence.enabled = true;
  } catch (error) {
    dispose();
    throw error; // Unsupported protocol cannot silently downgrade pre-ready evidence.
  }
  return {
    check() {
      if (failure) throw failure;
    },
    async settled() {
      await Promise.all([...tasks]);
      if (failure) throw failure;
    },
    dispose,
  };
}

// Only transport failures are retryable. Invalid JSON, HTTP failures, and caller
// assertions remain failures. Each request (including its body) shares the
// remaining overall budget, and the last transport error survives in evidence.
export async function waitForRendererTarget(
  browserUrl,
  {
    evidence,
    check = () => {},
    diagnostics = () => ({}),
    timeoutMs = 30_000,
    requestTimeoutMs = 2000,
    fetchImpl = fetch,
  },
) {
  evidence.url = `http://${new URL(browserUrl).host}/json/list`;
  evidence.attempts = 0;
  const detail = () => ({ ...diagnostics(), rendererTargetWait: evidence });
  try {
    return await until(
      async (remaining) => {
        check();
        evidence.attempts++;
        let pages;
        try {
          const response = await fetchImpl(evidence.url, {
            signal: AbortSignal.timeout(Math.min(requestTimeoutMs, remaining)),
          });
          assert.ok(response.ok, `/json/list HTTP ${response.status}`);
          pages = await response.json();
        } catch (error) {
          if (
            !["TimeoutError", "AbortError"].includes(error.name) &&
            !["ECONNREFUSED", "ECONNRESET", "UND_ERR_SOCKET"].includes(error.cause?.code)
          )
            throw error;
          evidence.lastTransportError = {
            name: error.name,
            message: error.message,
            code: error.cause?.code,
          };
          check();
          return false;
        }
        assert.ok(Array.isArray(pages), "/json/list must return a target array");
        evidence.targets = pages.map(({ type, url }) => ({ type, url }));
        check();
        return pages.find(
          (page) =>
            page.type === "page" &&
            page.url.startsWith("file:") &&
            typeof page.webSocketDebuggerUrl === "string",
        );
      },
      "renderer /json/list target",
      timeoutMs,
    );
  } catch (error) {
    throw new Error(`Renderer target wait failed: ${error.message}: ${JSON.stringify(detail())}`, {
      cause: error,
    });
  }
}

// --inspect-brk waits for a debugger, then pauses at the original entry point.
// Register before releasing the wait: the paused event can precede the reply.
export async function observeBeforeStartup(client, install) {
  await client.send("Debugger.enable");
  const paused = client.event("Debugger.paused");
  const [, snapshot] = await Promise.all([client.send("Runtime.runIfWaitingForDebugger"), paused]);
  const callFrameId = snapshot.callFrames?.[0]?.callFrameId;
  assert.equal(typeof callFrameId, "string", "Startup pause must expose a call frame");
  // No awaitPromise here: the paused VM cannot service promise microtasks.
  // The frame also exposes the entry module's CommonJS require.
  await install(async (expression) => {
    const reply = await client.send("Debugger.evaluateOnCallFrame", {
      callFrameId,
      expression,
      returnByValue: true,
    });
    if (reply.exceptionDetails) throw new Error(JSON.stringify(reply.exceptionDetails));
    return reply.result.value;
  });
  await client.send("Debugger.resume");
  await client.send("Debugger.disable");
}
