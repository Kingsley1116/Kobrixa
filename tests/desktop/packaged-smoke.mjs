import { connect, descendants, processTable } from "./builtin-installed-client.mjs";
import { createHash } from "node:crypto";
import { devicePreferencesExpression } from "./builtin-process-installed.mjs";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as pause } from "node:timers/promises";
import { readVersion, repositoryRoot } from "../../tools/release/common.mjs";
import { developmentSourceKey } from "../../packages/plugin-runtime/dist/index.js";
import { writeStaticLanguageFixtures } from "./static-languages-fixtures.mjs";
import { checkPackagedStaticLanguages } from "./static-languages-packaged.mjs";

// Exercise the shipped main/preload/renderer and dependency closure with an isolated profile.
// No test update feed or test version is exposed in the production application.
const devicePreferences = (js, until, digest) =>
  until(() => js(devicePreferencesExpression(digest)));

// Fix the verdict before collecting diagnostics. An exit during the OS process
// query or a disconnected debugger must never retroactively satisfy the deadline.
export async function waitForQuit(exit, evidence, delay = pause) {
  const expired = Symbol();
  const result = await Promise.race([exit, delay(5000, expired, { ref: false })]);
  if (result === expired)
    throw new Error(`Application did not quit within 5000 ms: ${JSON.stringify(await evidence())}`);
  assert.deepEqual(result, { code: 0, signal: null }, "Unexpected packaged application exit");
}

// The browser may close its debugger before it acknowledges the quit request.
export async function closePackagedBrowser(socket, exit, evidence, lifecycle) {
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Debug attach deadline")), 5000);
      const finish = (callback) => {
        clearTimeout(timer);
        callback();
      };
      socket.addEventListener("open", () => finish(resolve), { once: true });
      const failed = () => finish(() => reject(new Error("Debug attach failed")));
      socket.addEventListener("error", failed, { once: true });
      socket.addEventListener("close", failed, { once: true });
    });
    socket.addEventListener("message", ({ data }) => {
      const reply = JSON.parse(data);
      if (reply.id === 1)
        lifecycle.browserClose = reply.error ? JSON.stringify(reply.error) : "acknowledged";
    });
    socket.addEventListener("close", () => {
      lifecycle.browserTransport = "closed";
    });
    if (socket.readyState !== WebSocket.OPEN)
      throw new Error("Browser.close transport unavailable");
    socket.send(JSON.stringify({ id: 1, method: "Browser.close" }));
    lifecycle.browserClose = "sent";
    await waitForQuit(exit, evidence);
  } finally {
    socket.close();
  }
}

async function observe(read) {
  try {
    return await read();
  } catch (error) {
    return { unavailable: String(error) };
  }
}

export async function collectQuitEvidence(js, profile, pid, table = processTable) {
  const [workbench, plugins, recovery, processes, sessionMarker, journalEntries] =
    await Promise.all([
      observe(() =>
        js(`({
            dirtyTabs: document.querySelectorAll(".project-tab .dirty").length,
            sessionIssues: document.querySelector(".session-issues")?.textContent ?? null,
            openDialogs: [...document.querySelectorAll('dialog[open], [role="alertdialog"]')]
              .map(element => element.textContent.slice(0, 512))
          })`),
      ),
      observe(() =>
        js(`window.kobrixa.plugins.state().then(({ safeMode, stateProblem, plugins }) =>
            ({ safeMode, stateProblem, plugins: plugins.map(({ sourceKey, running, status, problems }) =>
              ({ sourceKey, running, status, problems })) }))`),
      ),
      observe(() =>
        js(`(async () => {
            const pages = [], seen = new Set();
            let cursor;
            do {
              const page = await window.kobrixa.plugins.recovery.snapshot(cursor ? {cursor} : {});
              pages.push(page);
              if (!page.ok) break;
              cursor = page.value.nextCursor;
              if (cursor && seen.has(cursor)) throw Error("Repeated recovery cursor");
              seen.add(cursor);
            } while (cursor);
            return pages;
          })()`),
      ),
      observe(async () => {
        const rows = await table();
        if (!rows.some((row) => row.pid === pid))
          throw new Error("Parent absent at OS process sample");
        return descendants(rows, pid, new Map());
      }),
      observe(async () =>
        JSON.parse(await readFile(path.join(profile, "plugins/session.json"), "utf8")),
      ),
      observe(() => readdir(path.join(profile, "device-broker"))),
    ]);
  return { workbench, plugins, recovery, processes, sessionMarker, journalEntries };
}

async function checkPackage(profile, cp) {
  const version = await readVersion();
  const appDirectory = path.join(
    repositoryRoot,
    `apps/desktop/out/Kobrixa-${process.platform}-${process.arch}`,
  );
  const installedDirectory = path.join(profile, "installed");
  await cp(appDirectory, installedDirectory, { recursive: true, verbatimSymlinks: true });
  const staticFixtures = await writeStaticLanguageFixtures(path.join(profile, "static-fixtures"));
  const staticSourceKey = developmentSourceKey(await realpath(staticFixtures.toy));
  const executable = path.join(
    installedDirectory,
    process.platform === "darwin"
      ? "Kobrixa.app/Contents/MacOS/kobrixa"
      : process.platform === "win32"
        ? "kobrixa.exe"
        : "kobrixa",
  );
  const resources = path.join(
    installedDirectory,
    process.platform === "darwin" ? "Kobrixa.app/Contents/Resources" : "resources",
  );
  const settingsDigest = createHash("sha256")
    .update(
      await readFile(
        path.join(
          resources,
          "app.asar.unpacked/.vite/build/plugins/device-ev3/settings/preferences.json",
        ),
      ),
    )
    .digest("hex");
  await writeFile(
    path.join(profile, "updates.json"),
    JSON.stringify({ enabled: false, channel: "stable" }),
  );
  const projectIds = [1, 2, 3].map((n) => `00000000-0000-4000-8000-00000000000${n}`);
  const inputPaths = projectIds.map((_, i) => path.join(profile, `project-${i + 1}`));
  for (const inputPath of inputPaths) {
    await mkdir(inputPath);
    await writeFile(path.join(inputPath, "main.bp"), "LCD.Clear()\n");
    await writeFile(path.join(inputPath, "sample.toy"), "value 1\n");
    await writeFile(path.join(inputPath, "unknown.xyz"), "unknown text\n");
    await writeFile(path.join(inputPath, "data.json"), '{"value":1}\n');
  }
  await writeFile(
    path.join(profile, "workspace-session.json"),
    JSON.stringify({
      version: 1,
      projects: projectIds.map((workspaceId, index) => ({
        workspaceId,
        inputPath: inputPaths[index],
        files: ["main.bp"],
        activeFile: "main.bp",
        selectedTreePath: "main.bp",
        expandedTreePaths: [""],
        locations: {},
      })),
      activeWorkspaceId: projectIds[1],
    }),
  );

  async function launch(phase, check) {
    const child = spawn(
      executable,
      [
        `--user-data-dir=${profile}`,
        "--remote-debugging-port=0",
        `--plugin-dev-dir=${staticFixtures.toy}`,
        ...(process.platform === "linux" ? ["--no-sandbox"] : []),
      ],
      { cwd: profile, stdio: ["ignore", "pipe", "pipe"] },
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
        resolve({ code, signal });
      });
    });
    const clients = [];
    const deadline = Date.now() + 45_000;
    async function until(read) {
      while (Date.now() < deadline && !exited) {
        const result = await read();
        if (result) return result;
        await pause(100);
      }
      throw new Error(`Packaged application did not become ready:\n${output}`);
    }
    try {
      const endpoint = await until(() => output.match(/DevTools listening on (ws:\/\/\S+)/)?.[1]);
      const origin = `http://${new URL(endpoint).host}`;
      const target = await until(async () => {
        const pages = await (await fetch(`${origin}/json/list`)).json();
        return pages.find((page) => page.type === "page" && page.url.startsWith("file:"));
      });
      const renderer = await connect(target.webSocketDebuggerUrl);
      clients.push(renderer);
      const { js, send } = renderer;
      await until(() =>
        js('Boolean(window.kobrixa?.updates && document.querySelector(".settings-trigger"))'),
      );
      await until(() =>
        js(
          'document.querySelectorAll(".project-tab").length === 3 && Boolean(document.querySelector(".monaco-editor textarea"))',
        ),
      );
      await check(js, send, until);
      const lifecycle = { phase, browserTransport: "open", rendererTransport: "open" };
      renderer.onClose((error) => {
        lifecycle.rendererTransport = error.message;
      });
      await closePackagedBrowser(
        new WebSocket(endpoint),
        exit,
        async () => {
          const atDeadline = { ...lifecycle };
          const details = await collectQuitEvidence(js, profile, child.pid);
          return {
            pid: child.pid,
            atDeadline,
            ...details,
            exitCodeAfterDiagnostics: child.exitCode,
            outputTail: output.slice(-16384),
          };
        },
        lifecycle,
      );
    } finally {
      for (const client of clients) client.close();
      if (!exited) child.kill();
      await exit;
    }
  }

  let initialPreferences;
  await launch("initial edit", async (js, send, until) => {
    await checkPackagedStaticLanguages({ js, send, until, profile, sourceKey: staticSourceKey });
    const restored = await js("window.kobrixa.workspace.restoreSession()");
    const workspaceId = restored.activeWorkspaceId;
    assert.ok(workspaceId);
    const compiled = await js(`new Promise((resolve, reject) => {
      const unsubscribe = window.kobrixa.build.onEvent(event => {
        if (event.type === "complete" && event.workspaceId === ${JSON.stringify(workspaceId)}) {
          unsubscribe();
          resolve(event.result);
        }
      });
      window.kobrixa.build.start(${JSON.stringify(workspaceId)}, {"main.bp": "LCD.Clear()\\nLCD.Update()\\n"}).catch(error => { unsubscribe(); reject(error); });
    })`);
    assert.equal(compiled.success, true, JSON.stringify(compiled.diagnostics));
    assert.equal(compiled.deploy, "ev3");
    assert.ok(compiled.artifacts.some((artifact) => artifact.role === "deploy-main"));
    const state = await js("window.kobrixa.updates.getState()");
    assert.equal(state.currentVersion, version);
    assert.notEqual(state.reason, "development");
    assert.equal(state.phase, "idle");
    assert.deepEqual(state.preferences, { enabled: false, channel: "stable" });
    await js('window.kobrixa.updates.setPreferences({enabled:false,channel:"preview"})');
    initialPreferences = await devicePreferences(js, until, settingsDigest);
    assert.equal(initialPreferences.usbAutoReconnect, true);
    // The retired write bridge cannot bypass the contributed settings form.
    assert.equal(await js("typeof window.kobrixa.device.setPreferences"), "undefined");
    await js('localStorage.setItem("kobrixa-packaged-smoke", "retained")');
    await js('document.querySelector(".settings-trigger").click()');
    await pause(250);
    await js(
      'Array.from(document.querySelectorAll(".settings-categories button")).find(button => button.textContent === "About & updates" || button.textContent === "關於與更新").click()',
    );
    await pause(100);
    assert.equal(await js('Boolean(document.querySelector("#settings-updates"))'), true);
    await js('document.querySelector(".settings-tab .tab-close").click()');
    for (let i = 0; i < 50 && (await js('document.querySelector(".editor-stage").hidden')); i++)
      await pause(20);
    await send("Page.bringToFront");
    await js('document.querySelector(".monaco-editor textarea").focus()');
    // Quit immediately after typing, before the 400 ms draft debounce.
    await send("Input.insertText", { text: "' shutdown recovery\n" });
    await js("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
    assert.match(
      await js('document.querySelector(".view-lines").textContent'),
      /shutdown.recovery/,
    );
  });
  const persisted = JSON.parse(
    await readFile(path.join(profile, "workspace-session.json"), "utf8"),
  );
  assert.equal(persisted.projects.length, 3);
  assert.equal(
    persisted.projects.find((item) => item.workspaceId === persisted.activeWorkspaceId).inputPath,
    await realpath(inputPaths[1]),
  );
  assert.equal(await readFile(path.join(inputPaths[1], "main.bp"), "utf8"), "LCD.Clear()\n");
  assert.equal(await readFile(path.join(inputPaths[1], "sample.toy"), "utf8"), "value 1\n");
  await launch("restored dirty draft", async (js, _send, until) => {
    assert.deepEqual((await js("window.kobrixa.updates.getState()")).preferences, {
      enabled: false,
      channel: "preview",
    });
    assert.equal(await js('localStorage.getItem("kobrixa-packaged-smoke")'), "retained");
    // The absent legacy write bridge changed nothing, and the settings survive a restart.
    assert.deepEqual(await devicePreferences(js, until, settingsDigest), initialPreferences);
    await pause(250);
    assert.match(
      await js('document.querySelector(".view-lines").textContent'),
      /shutdown.recovery/,
    );
    assert.equal(await js('document.querySelectorAll(".project-tab .dirty").length'), 1);
  });
  await assert.rejects(readFile(path.join(profile, "plugins/session.json")), { code: "ENOENT" });
  assert.deepEqual(JSON.parse(await readFile(path.join(profile, "updates.json"), "utf8")), {
    enabled: false,
    channel: "preview",
  });
  console.log(
    "Packaged application: shipped build worker, runtime, device preference validation/persistence, update IPC, three-project restore and immediate-quit draft recovery pass.",
  );
}

export async function runPackagedSmoke({ copy = cp, cleanup = rm } = {}) {
  const profile = await mkdtemp(path.join(tmpdir(), "kobrixa-packaged-smoke-"));
  try {
    await checkPackage(profile, copy);
  } finally {
    await cleanup(profile, { recursive: true, force: true });
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url)
  await runPackagedSmoke();
