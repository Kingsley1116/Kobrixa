// Runs in the staged node.exe, a renamed Node child and the packaged app.
const fs = process.getBuiltinModule("node:fs");
const net = process.getBuiltinModule("node:net");
const dgram = process.getBuiltinModule("node:dgram");
const crypto = process.getBuiltinModule("node:crypto");
const path = process.getBuiltinModule("node:path");
const cp = process.getBuiltinModule("node:child_process");
const { performance } = process.getBuiltinModule("node:perf_hooks");

function identity() {
  return { pid: process.pid, ppid: process.ppid, exe: process.execPath };
}
function files(paths) {
  return Object.fromEntries(
    Object.entries(paths).map(([label, file]) => {
      try {
        return [label, { hash: crypto.hash("sha256", fs.readFileSync(file)) }];
      } catch (e) {
        return [label, { code: e.code, errno: e.errno }];
      }
    }),
  );
}
async function flow(t) {
  const tcp = t.protocol === "tcp";
  const socket = tcp
    ? new net.Socket()
    : dgram.createSocket(t.host.includes(":") ? "udp6" : "udp4");
  const events = [],
    start = performance.now();
  return new Promise((resolve) => {
    let settled = false;
    const mark = (event) => events.push({ event, ms: performance.now() - start });
    function finish(code, errno = null) {
      if (settled) return;
      settled = true;
      mark(code);
      clearTimeout(timer);
      if (tcp) socket.destroy();
      else socket.close();
      resolve({ ...identity(), code, errno, events, elapsed: performance.now() - start });
    }
    const timer = setTimeout(() => finish("TIMEOUT"), 2000);
    socket.on("error", (e) => {
      events.push({
        event: "error",
        code: e.code,
        errno: e.errno,
        syscall: e.syscall,
        ms: performance.now() - start,
      });
      finish(e.code, e.errno);
    });
    if (tcp) {
      socket.once("connect", () => {
        mark("CONNECTED");
        socket.write(t.nonce + "\n");
      });
      let data = "";
      socket.on("data", (b) => {
        data += b;
        if (data.includes("\n")) finish(data === "reply:" + t.nonce + "\n" ? "REPLY" : "BAD_REPLY");
      });
      socket.once("end", () => finish("EOF"));
      socket.connect({
        host: t.host,
        port: t.port,
        localAddress: t.source,
        localPort: t.localPort,
      });
    } else {
      socket.once("message", (b, peer) =>
        finish(
          peer.address === t.host && peer.port === t.port && b.toString() === "reply:" + t.nonce
            ? "REPLY"
            : "BAD_REPLY",
        ),
      );
      socket.bind(t.localPort, t.source, () =>
        socket.send(t.nonce, t.port, t.host, (e) => (e ? finish(e.code, e.errno) : mark("SENT"))),
      );
    }
  });
}
async function execute(t, deadline = performance.now() + 10000) {
  if (t.action === "files") {
    const value = crypto.randomUUID();
    fs.writeFileSync(t.writable, value);
    return {
      ...identity(),
      files: files(t.paths),
      roundTrip: fs.readFileSync(t.writable, "utf8") === value,
    };
  }
  if (t.action === "flow") return flow(t);
  if (t.action === "batch")
    return Promise.all(
      t.tasks.map(async (task) => {
        try {
          return await execute(task, deadline);
        } catch (e) {
          return { error: e.code ?? e.name };
        }
      }),
    );
  if (t.action === "native") {
    const name = t.child ? "native-child.exe" : "subject.exe";
    const output = path.join(process.env.TEMP, crypto.randomUUID() + ".json");
    const remaining = Math.min(6000, Math.floor(deadline - performance.now()));
    if (remaining <= 0) return { error: "BATCH_DEADLINE", exit: null };
    const result = await new Promise((resolve) => {
      cp.execFile(
        path.join(__dirname, name),
        [output, ...t.args],
        { timeout: remaining, windowsHide: true },
        (error) =>
          resolve({
            error: error?.killed ? "NATIVE_TIMEOUT" : error?.code,
            exit: error ? null : 0,
          }),
      );
    });
    if (result.error || !fs.existsSync(output))
      return { ...result, error: result.error ?? "MISSING_OUTPUT" };
    return { ...JSON.parse(fs.readFileSync(output, "utf8")), exit: result.exit };
  }
  if (t.action === "reverse") {
    const server = net.createServer((c) => {
      let data = "";
      c.on("data", (b) => {
        data += b;
        if (data.includes("\n")) c.end("reply:" + data);
      });
      c.once("close", () => server.close());
    });
    const timer = setTimeout(() => process.exit(3), 8000);
    server.once("close", () => clearTimeout(timer));
    server.listen(0, "127.0.0.1", () =>
      fs.writeFileSync(t.ready, JSON.stringify({ ...identity(), port: server.address().port })),
    );
    return null;
  }
  if (t.action === "tree") {
    const child = cp.spawn(t.childExe, ["-e", "setTimeout(()=>{},60000)"], { stdio: "ignore" });
    fs.writeFileSync(t.ready, JSON.stringify({ pid: process.pid, child: child.pid }));
    await new Promise((resolve) => setTimeout(resolve, 60000));
    return null;
  }
  if (t.action === "inspect") {
    const outcomes = [];
    for (const url of t.urls) {
      const result = await new Promise((resolve) => {
        const ws = new WebSocket(url);
        const done = (code) => {
          clearTimeout(timer);
          resolve(code);
          ws.close();
        };
        const timer = setTimeout(() => done("TIMEOUT"), 2000);
        ws.addEventListener("open", () => done("ATTACHED"), { once: true });
        ws.addEventListener("error", () => done("HANDSHAKE_ERROR"), { once: true });
      });
      const transport = await flow({
        protocol: "tcp",
        host: "127.0.0.1",
        port: Number(new URL(url).port),
        nonce: crypto.randomUUID(),
      });
      outcomes.push({ result, transport });
    }
    return { ...identity(), outcomes };
  }
  if (t.action === "controllerAccess") {
    function open(flags) {
      try {
        fs.closeSync(fs.openSync(t.control, flags));
        return "OPENED";
      } catch (e) {
        return e.code;
      }
    }
    const memory = {};
    for (const [name, target] of Object.entries(t.targets)) {
      memory[name] = {
        ...target,
        ...(await execute({ action: "native", args: ["memory", String(target.pid)] })),
      };
    }
    return {
      ...identity(),
      write: open(fs.constants.O_WRONLY),
      read: open(fs.constants.O_RDONLY),
      memory,
    };
  }
  throw Error("Unknown task");
}
module.exports = { flow, execute, identity };
if (process.parentPort) {
  let quitRequested = false;
  process.parentPort.on("message", async ({ data }) => {
    if (data.action === "quit") {
      quitRequested = true;
      process.parentPort.postMessage({ action: "quit-ack", pid: process.pid });
      return;
    }
    if (quitRequested && data.action === "exit") return process.exit(0);
    try {
      process.parentPort.postMessage({ id: data.id, value: await execute(data.task) });
    } catch (e) {
      process.parentPort.postMessage({ id: data.id, error: e.code ?? e.name });
    }
  });
} else if (require.main === module) {
  const plan = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
  if (plan.child && process.argv[3] !== "child") {
    const r = cp.spawnSync(plan.child, [__filename, process.argv[2], "child"], {
      stdio: "ignore",
      timeout: 30000,
    });
    process.exitCode = r.status ?? 1;
  } else
    execute(plan.task)
      .then((r) => fs.writeFileSync(plan.output, JSON.stringify(r)))
      .catch((e) => {
        fs.writeFileSync(plan.output, JSON.stringify({ error: e.code ?? e.name }));
        process.exitCode = 1;
      });
}
