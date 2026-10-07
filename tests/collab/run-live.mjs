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

// Real HTTP/WebSocket transport, desktop service/session/file sync, and independent
// host/guest project directories. Remote checks require an explicit service origin.
const args = process.argv.slice(2);
const remote = args[0] === "--remote";
assert.ok(
  args.length === 0 || (remote && args.length === 2),
  "Usage: node tests/collab/run-live.mjs [--remote <service-origin>]",
);
let serverUrl;
if (remote) {
  const url = new URL(args[1]);
  assert.ok(
    (url.protocol === "https:" ||
      (url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.pathname === "/",
    "Expected an HTTPS service origin or an HTTP loopback origin",
  );
  serverUrl = url.origin;
}
const root = fileURLToPath(new URL("../../", import.meta.url));
const temporary = await mkdtemp(path.join(tmpdir(), "kobrixa-collab-live-"));
let port;
const config = path.join(temporary, "wrangler.json");
if (!remote) {
  const reservation = createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  serverUrl = `http://127.0.0.1:${port}`;
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
}
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
let server = remote ? undefined : startServer();
async function stopServer() {
  if (!server || server.exitCode !== null) return;
  const stopped = once(server, "exit");
  server.kill("SIGTERM");
  await stopped;
}
async function waitForServer() {
  if (remote) {
    const response = await fetch(`${serverUrl}/health`, { signal: AbortSignal.timeout(15000) });
    await response.arrayBuffer();
    assert.ok(response.ok, `Service health check failed: HTTP ${response.status}`);
    return;
  }
  const deadline = Date.now() + 30000;
  let ready = false;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`Wrangler exited: ${logs}`);
    try {
      const response = await fetch(`${serverUrl}/health`, { signal: AbortSignal.timeout(2000) });
      await response.arrayBuffer();
      ready = response.ok;
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
  child = spawn(process.execPath, [bundle, serverUrl, temporary, remote ? "remote" : "local"], {
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  });
  child.on("message", async (message) => {
    if (message !== "restart-worker" || remote) return;
    try {
      await stopServer();
      let stillListening = true;
      const deadline = Date.now() + 5000;
      while (stillListening && Date.now() < deadline) {
        try {
          const response = await fetch(`${serverUrl}/health`, {
            signal: AbortSignal.timeout(1000),
          });
          await response.arrayBuffer();
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
