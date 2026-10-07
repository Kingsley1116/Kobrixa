import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
const require = createRequire(new URL("../../apps/collab/package.json", import.meta.url));
const { build } = require("esbuild");

// Real Wrangler HTTP/WebSocket transport, real desktop service/session/file sync,
// and independent host/guest project directories. No production account is used.
const root = fileURLToPath(new URL("../../", import.meta.url));
const temporary = await mkdtemp(path.join(tmpdir(), "kobrixa-collab-live-"));
const reservation = createServer();
reservation.listen(0, "127.0.0.1");
await once(reservation, "listening");
const port = reservation.address().port;
await new Promise((resolve) => reservation.close(resolve));
const serverUrl = `http://127.0.0.1:${port}`;
const config = path.join(temporary, "wrangler.json");
await writeFile(
  config,
  JSON.stringify({
    name: "kobrixa-collab-live-test",
    main: path.join(root, "apps/collab/src/index.ts"),
    compatibility_date: "2026-09-06",
    vars: { COLLAB_SECRET: "local-integration-test-secret-only", ALLOWED_ORIGINS: "" },
    durable_objects: { bindings: [{ name: "ROOMS", class_name: "CollabRoom" }] },
    migrations: [{ tag: "v1", new_sqlite_classes: ["CollabRoom"] }],
  }),
);
let logs = "";
function startServer() {
  const worker = spawn(
    process.execPath,
    [
      path.join(path.dirname(require.resolve("wrangler/package.json")), "bin/wrangler.js"),
      "dev",
      "--config",
      config,
      "--local",
      "--ip",
      "127.0.0.1",
      "--port",
      String(port),
      "--inspector-port",
      "0",
      "--persist-to",
      path.join(temporary, "state"),
      "--show-interactive-dev-session=false",
    ],
    {
      cwd: root,
      env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  worker.stdout.on("data", (chunk) => {
    logs += chunk;
  });
  worker.stderr.on("data", (chunk) => {
    logs += chunk;
  });
  return worker;
}
let server = startServer();
async function stopServer() {
  if (server.exitCode !== null) return;
  const stopped = once(server, "exit");
  server.kill("SIGTERM");
  await stopped;
}
async function waitForServer() {
  const deadline = Date.now() + 30000;
  let ready = false;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`Wrangler exited: ${logs}`);
    try {
      ready = (await fetch(`${serverUrl}/health`)).ok;
    } catch {
      /* starting */
    }
    if (ready) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(ready, `Wrangler did not start: ${logs}`);
}
let child;
try {
  await waitForServer();
  const bundle = path.join(temporary, "client.cjs");
  await build({
    entryPoints: [path.join(root, "tests/collab/live-client.ts")],
    outfile: bundle,
    bundle: true,
    platform: "node",
    format: "cjs",
    plugins: [
      {
        name: "electron-test-host",
        setup(builder) {
          builder.onResolve({ filter: /^electron$/ }, () => ({
            path: "electron",
            namespace: "test-host",
          }));
          builder.onLoad({ filter: /.*/, namespace: "test-host" }, () => ({
            contents: `export const app = {getPath: () => ${JSON.stringify(temporary)}}; export const dialog = {}; export const shell = {trashItem: async (file) => { const fs = await import('node:fs/promises'); await fs.rm(file, {recursive: true, force: true}); }};`,
            loader: "js",
          }));
        },
      },
    ],
  });
  child = spawn(process.execPath, [bundle, serverUrl, temporary], {
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  });
  child.on("message", async (message) => {
    if (message !== "restart-worker") return;
    try {
      await stopServer();
      let stillListening = true;
      const deadline = Date.now() + 5000;
      while (stillListening && Date.now() < deadline) {
        try {
          await fetch(`${serverUrl}/health`);
          await new Promise((resolve) => setTimeout(resolve, 25));
        } catch {
          stillListening = false;
        }
      }
      assert.equal(stillListening, false, "Old Worker must stop listening before restart");
      server = startServer();
      await waitForServer();
      child.send("worker-restarted");
    } catch (error) {
      console.error(error);
      child.kill("SIGTERM");
    }
  });
  const [code] = await once(child, "exit");
  assert.equal(code, 0, "Live collaboration client checks failed");
} catch (error) {
  console.error(logs);
  throw error;
} finally {
  if (child && child.exitCode === null) child.kill("SIGTERM");
  await stopServer();
  await rm(temporary, { recursive: true, force: true });
}
