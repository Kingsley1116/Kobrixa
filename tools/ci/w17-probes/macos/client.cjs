// Shared by the staged Node executables and packaged main/utility processes.
const fs = process.getBuiltinModule("node:fs");
const net = process.getBuiltinModule("node:net");
const dgram = process.getBuiltinModule("node:dgram");
const crypto = process.getBuiltinModule("node:crypto");
const { spawnSync } = process.getBuiltinModule("node:child_process");

function identity() {
  return {
    pid: process.pid,
    ppid: process.ppid,
    uid: process.getuid(),
    euid: process.geteuid(),
    gid: process.getgid(),
    egid: process.getegid(),
    groups: process.getgroups(),
    exe: process.execPath,
  };
}
function files(paths) {
  return Object.fromEntries(
    Object.entries(paths).map(([name, path]) => {
      try {
        return [
          name,
          { hash: crypto.createHash("sha256").update(fs.readFileSync(path)).digest("hex") },
        ];
      } catch (e) {
        return [name, { code: e.code, errno: e.errno }];
      }
    }),
  );
}
async function flow({ host, port, family, nonce, localPort = 0 }) {
  const tcp = family.startsWith("tcp");
  const socket = tcp ? new net.Socket() : dgram.createSocket(family);
  const start = performance.now();
  const events = [];
  return new Promise((resolve) => {
    let settled = false;
    function mark(event) {
      events.push({ event, ms: performance.now() - start });
    }
    function finish(code, errno = null) {
      if (settled) return;
      settled = true;
      mark(code);
      clearTimeout(timer);
      let local = null;
      try {
        local = socket.address();
      } catch {
        /* Socket already closed after kernel error. */
      }
      if (tcp) socket.destroy();
      else socket.close();
      resolve({
        ...identity(),
        host,
        port,
        localPort,
        local,
        family,
        nonce,
        code,
        errno,
        events,
        elapsed: performance.now() - start,
      });
    }
    const timer = setTimeout(() => finish("TIMEOUT"), 2000);
    socket.once("error", (e) => finish(e.code, e.errno));
    if (tcp) {
      socket.once("connect", () => {
        mark("CONNECTED");
        socket.write(nonce + "\n");
      });
      let reply = "";
      socket.on("data", (b) => {
        reply += b;
        if (reply.includes("\n")) finish(reply === "reply:" + nonce + "\n" ? "REPLY" : "BAD_REPLY");
      });
      socket.once("end", () => finish("EOF"));
      socket.connect({
        host,
        port,
        localPort,
        localAddress: host,
      });
    } else {
      socket.once("message", (b, peer) =>
        finish(
          peer.address === host && peer.port === port && b.toString() === "reply:" + nonce
            ? "REPLY"
            : "BAD_REPLY",
        ),
      );
      socket.bind(localPort, host, () =>
        socket.send(nonce, port, host, (e) => {
          if (e) finish(e.code, e.errno);
          else mark("SENT");
        }),
      );
    }
  });
}
async function execute(task) {
  if (task.child) {
    const r = spawnSync(task.child, [__filename, JSON.stringify({ ...task, child: null })], {
      encoding: "utf8",
      timeout: 12000,
    });
    if (r.status !== 0) throw Error("child exit " + r.status + " " + r.stderr);
    return { parent: identity(), ...JSON.parse(r.stdout) };
  }
  if (task.action === "flow") return flow(task);
  if (task.action === "native") {
    const r = spawnSync(__dirname + "/native", task.args, { encoding: "utf8", timeout: 5000 });
    return {
      ...identity(),
      exit: r.status,
      error: r.error?.code,
      native: r.stdout?.trim() ? JSON.parse(r.stdout) : null,
    };
  }
  if (task.action === "files") return { ...identity(), files: files(task.paths) };
  if (task.action === "profile") {
    const value = crypto.randomUUID();
    fs.writeFileSync(task.path, value);
    return { ...identity(), roundTrip: fs.readFileSync(task.path, "utf8") === value };
  }
  if (task.action === "controlFile") {
    try {
      const fd = fs.openSync(
        task.path,
        task.mode === "read" ? fs.constants.O_RDONLY : fs.constants.O_WRONLY,
      );
      fs.closeSync(fd);
      return { ...identity(), mode: task.mode, code: "OPENED" };
    } catch (e) {
      return { ...identity(), mode: task.mode, code: e.code, errno: e.errno };
    }
  }
  if (task.action === "port") {
    const socket = new net.Socket();
    return new Promise((resolve) => {
      function done(code) {
        clearTimeout(timer);
        socket.destroy();
        resolve({ ...identity(), code });
      }
      const timer = setTimeout(() => done("TIMEOUT"), 2000);
      socket.once("error", (e) => done(e.code));
      socket.once("connect", () => done("CONNECTED"));
      socket.connect({ host: "127.0.0.1", port: task.port });
    });
  }
  if (task.action === "inspector") {
    const ws = new WebSocket(task.url);
    return new Promise((resolve) => {
      function done(code) {
        clearTimeout(timer);
        ws.close();
        resolve({ ...identity(), code });
      }
      const timer = setTimeout(() => done("TIMEOUT"), 2000);
      ws.addEventListener("open", () => done("ATTACHED"), { once: true });
      ws.addEventListener("error", () => done("HANDSHAKE_ERROR"), { once: true });
    });
  }
  if (task.action === "identity") return { ...identity(), home: fs.statSync(process.env.HOME).uid };
  if (task.action === "tree") {
    const child = process
      .getBuiltinModule("node:child_process")
      .spawn(task.childExe, ["-e", "setTimeout(()=>{},30000)"], { stdio: "ignore" });
    console.log(JSON.stringify({ pid: process.pid, childPid: child.pid }));
    setTimeout(() => process.exit(1), 30000);
    return;
  }
  if (task.action === "reverse") {
    const s = net.createServer((c) => {
      let data = "";
      c.on("data", (b) => {
        data += b;
        if (data.includes("\n")) c.end("reply:" + data);
      });
      c.on("close", () => s.close());
    });
    s.listen(0, "127.0.0.1", () =>
      console.log(JSON.stringify({ ...identity(), port: s.address().port })),
    );
    const deadline = setTimeout(() => process.exit(1), 8000);
    s.on("close", () => clearTimeout(deadline));
    return;
  }
  throw Error("Unknown task");
}
module.exports = { execute, identity, files, flow };
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
      process.parentPort.postMessage({ id: data.id, error: e.message });
    }
  });
} else if (require.main === module) {
  execute(JSON.parse(process.argv[2] === "--stdin" ? fs.readFileSync(0, "utf8") : process.argv[2]))
    .then((r) => {
      if (r) console.log(JSON.stringify(r));
    })
    .catch((e) => {
      console.error(e.message);
      process.exitCode = 1;
    });
}
