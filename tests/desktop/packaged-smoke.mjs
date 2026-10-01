import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { readVersion, repositoryRoot } from "../../tools/release/common.mjs";

// Exercise the shipped main/preload/renderer and dependency closure with an isolated profile.
// No test update feed or test version is exposed in the production application.
const profile = await mkdtemp(path.join(tmpdir(), "kobrixa-packaged-smoke-"));
const version = await readVersion();
const appDirectory = path.join(
  repositoryRoot,
  `apps/desktop/out/Kobrixa-${process.platform}-${process.arch}`,
);
const executable = path.join(
  appDirectory,
  process.platform === "darwin"
    ? "Kobrixa.app/Contents/MacOS/kobrixa"
    : process.platform === "win32"
      ? "kobrixa.exe"
      : "kobrixa",
);
await writeFile(
  path.join(profile, "updates.json"),
  JSON.stringify({ enabled: false, channel: "stable" }),
);

async function launch(check) {
  const child = spawn(
    executable,
    [
      `--user-data-dir=${profile}`,
      "--remote-debugging-port=0",
      ...(process.platform === "linux" ? ["--no-sandbox"] : []),
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "",
    exited = false;
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });
  const exit = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      output += `\nApplication exited: code=${code}, signal=${signal}`;
      exited = true;
      resolve();
    });
  });
  const sockets = [];
  const deadline = Date.now() + 45_000;
  async function until(read) {
    while (Date.now() < deadline && !exited) {
      const result = await read();
      if (result) return result;
      await pause(100);
    }
    throw new Error(`Packaged application did not become ready:\n${output}`);
  }
  async function connect(url) {
    const socket = new WebSocket(url);
    sockets.push(socket);
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", reject, { once: true });
    });
    let id = 0;
    return (method, params = {}, waitForReply = true) =>
      new Promise((resolve, reject) => {
        const requestId = ++id;
        if (!waitForReply) {
          socket.send(JSON.stringify({ id: requestId, method, params }));
          resolve();
          return;
        }
        const timeout = setTimeout(() => {
          socket.removeEventListener("message", receive);
          reject(new Error(`CDP timeout: ${method}`));
        }, 10_000);
        function receive(event) {
          const reply = JSON.parse(event.data);
          if (reply.id !== requestId) return;
          clearTimeout(timeout);
          socket.removeEventListener("message", receive);
          if (reply.error) reject(new Error(JSON.stringify(reply.error)));
          else resolve(reply.result);
        }
        socket.addEventListener("message", receive);
        socket.send(JSON.stringify({ id: requestId, method, params }));
      });
  }
  try {
    const endpoint = await until(() => output.match(/DevTools listening on (ws:\/\/\S+)/)?.[1]);
    const origin = `http://${new URL(endpoint).host}`;
    const target = await until(async () => {
      const pages = await (await fetch(`${origin}/json/list`)).json();
      return pages.find((page) => page.type === "page" && page.url.startsWith("file:"));
    });
    const send = await connect(target.webSocketDebuggerUrl);
    const js = async (expression) => {
      const result = await send("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
      });
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
      return result.result.value;
    };
    await until(() =>
      js('Boolean(window.kobrixa?.updates && document.querySelector(".settings-trigger"))'),
    );
    await check(js);
    const browser = await connect(endpoint);
    // The browser can exit before delivering a response to this command.
    await browser("Browser.close", {}, false);
    await Promise.race([
      exit,
      pause(5000).then(() => {
        if (!exited) throw new Error("Application did not quit");
      }),
    ]);
  } finally {
    for (const socket of sockets) socket.close();
    if (!exited) child.kill();
    await exit;
  }
}

try {
  await launch(async (js) => {
    const state = await js("window.kobrixa.updates.getState()");
    assert.equal(state.currentVersion, version);
    assert.notEqual(state.reason, "development");
    assert.equal(state.phase, "idle");
    assert.deepEqual(state.preferences, { enabled: false, channel: "stable" });
    await js('window.kobrixa.updates.setPreferences({enabled:false,channel:"preview"})');
    await js('localStorage.setItem("kobrixa-packaged-smoke", "retained")');
    await js('document.querySelector(".settings-trigger").click()');
    await pause(250);
    assert.equal(await js('Boolean(document.querySelector("#settings-updates"))'), true);
  });
  await launch(async (js) => {
    assert.deepEqual((await js("window.kobrixa.updates.getState()")).preferences, {
      enabled: false,
      channel: "preview",
    });
    assert.equal(await js('localStorage.getItem("kobrixa-packaged-smoke")'), "retained");
  });
  assert.deepEqual(JSON.parse(await readFile(path.join(profile, "updates.json"), "utf8")), {
    enabled: false,
    channel: "preview",
  });
  console.log(
    "Packaged application: shipped runtime loads, update IPC works, normal quit and profile persistence pass.",
  );
} finally {
  await rm(profile, { recursive: true, force: true });
}
