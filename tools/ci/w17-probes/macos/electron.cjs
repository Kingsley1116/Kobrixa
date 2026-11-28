// Loaded through the paused, staged application's own CommonJS entry frame.
exports.install = function install(load, nonce) {
  const electron = load("electron");
  const client = load(__dirname + "/client.cjs");
  const { app, BrowserWindow } = electron;
  const gone = [];
  let quitting = false,
    utility,
    utilityPid,
    quitSent = false,
    acknowledged = false,
    terminal = false,
    serial = 0;
  const fs = load("node:fs");
  let sequence = 0;
  const record = (event) =>
    fs.writeSync(2, "\nW17 " + nonce + " " + process.pid + " " + sequence++ + " " + event + "\n");
  record("start");
  function lost(detail) {
    gone.push(detail);
    record(detail.reason === "clean-exit" ? "clean-exit" : "abnormal");
  }
  app.on("child-process-gone", (_, detail) => lost({ type: detail.type, reason: detail.reason }));
  app.on("render-process-gone", (_, contents, detail) =>
    lost({ type: "renderer", id: contents.id, reason: detail.reason }),
  );
  process.once("exit", () => {
    if (utility && !terminal) record("utility-missing " + (utilityPid || 0));
    record("final");
  });
  return {
    readyAtAttach: app.isReady(),
    gone,
    identity() {
      return {
        ...client.identity(),
        name: app.getName(),
        packaged: app.isPackaged,
        exe: app.getPath("exe"),
        archive: app.getAppPath(),
        profile: app.getPath("userData"),
        cwd: process.cwd(),
        path: process.env.PATH,
        clean: ["NODE_PATH", "NODE_OPTIONS", "ELECTRON_RUN_AS_NODE", "PYTHONPATH"].every(
          (k) => process.env[k] === undefined,
        ),
        disabled: process.argv.some((a) =>
          ["--no-sandbox", "--disable-setuid-sandbox"].includes(a),
        ),
        windows: BrowserWindow.getAllWindows().map((w) => {
          const { sandbox, contextIsolation, nodeIntegration } =
            w.webContents.getLastWebPreferences();
          return {
            sandbox,
            contextIsolation,
            nodeIntegration,
            pid: w.webContents.getOSProcessId(),
          };
        }),
      };
    },
    async focus() {
      const window = BrowserWindow.getAllWindows()[0];
      const pause = () => new Promise((resolve) => setTimeout(resolve, 350));
      window.focus();
      await pause();
      const focused = window.isFocused();
      window.blur();
      await pause();
      const defocused = !window.isFocused();
      window.focus();
      await pause();
      return { focused, defocused, refocused: window.isFocused() };
    },
    metrics() {
      return app.getAppMetrics().map(({ pid, type, name }) => ({ pid, type, name }));
    },
    startUtility() {
      if (utility) throw Error("Utility already launched");
      utility = electron.utilityProcess.fork(__dirname + "/client.cjs", [], {
        serviceName: "W17 diagnostic utility",
        execArgv: [],
        cwd: process.cwd(),
      });
      record("utility-launch");
      return new Promise((resolve, reject) => {
        utility.once("spawn", () => {
          utilityPid = utility.pid;
          record("utility-spawn " + utilityPid);
          resolve(utilityPid);
        });
        utility.on("message", (reply) => {
          if (!quitSent || acknowledged || reply?.action !== "quit-ack" || reply.pid !== utilityPid)
            return;
          acknowledged = true;
          record("utility-ack " + utilityPid);
          utility.postMessage({ action: "exit" });
        });
        utility.once("exit", (code) => {
          terminal = true;
          const expected = acknowledged && code === 0;
          record(
            "utility-" +
              (expected ? "quit" : "abnormal") +
              " " +
              (utilityPid || 0) +
              " " +
              (Number.isInteger(code) ? code : "unknown"),
          );
          if (!expected) lost({ type: "utility", reason: "unexpected-exit", code });
          if (quitting) setTimeout(() => app.quit(), 0);
          reject(Error("utility exit " + code));
        });
      });
    },
    execute(role, task) {
      if (role === "main") return client.execute(task);
      const id = ++serial;
      return new Promise((resolve, reject) => {
        const receive = (reply) => {
          if (reply.id !== id) return;
          clearTimeout(timer);
          utility.off("message", receive);
          if (reply.error) reject(Error(reply.error));
          else resolve(reply.value);
        };
        const timer = setTimeout(() => {
          utility.off("message", receive);
          reject(Error("utility reply deadline"));
        }, 6000);
        utility.on("message", receive);
        utility.postMessage({ id, task });
      });
    },
    quit() {
      quitting = true;
      if (utility?.pid && !terminal) {
        quitSent = true;
        utility.postMessage({ action: "quit" });
        setTimeout(() => {
          if (!terminal) app.quit();
        }, 100);
      } else setTimeout(() => app.quit(), 100);
      return true;
    },
  };
};
