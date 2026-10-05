import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { createServer } from "vite";
import { build } from "esbuild";

// Use the production main and preload: the UI smoke's IPC fixture cannot detect
// exceptions in BrowserWindow teardown or the application's quit listeners.
const root = fileURLToPath(new URL("../../", import.meta.url));
const desktop = path.join(root, "apps/desktop");
const require = createRequire(path.join(desktop, "package.json"));
const temporary = await mkdtemp(path.join(tmpdir(), "kobrixa-close-smoke-"));
const server = await createServer({
  root: desktop,
  configFile: path.join(desktop, "vite.renderer.config.ts"),
  server: { host: "127.0.0.1", port: 0, watch: null, hmr: false },
});
let passed = false;
try {
  await server.listen();
  const url = `http://127.0.0.1:${server.httpServer.address().port}`;
  await build({
    entryPoints: {
      main: path.join(desktop, "src/main/index.ts"),
      preload: path.join(desktop, "src/preload/index.ts"),
      "language-worker": path.join(desktop, "src/main/language/language-worker.ts"),
    },
    outdir: temporary,
    outExtension: { ".js": ".cjs" },
    bundle: true,
    platform: "node",
    format: "cjs",
    external: ["electron"],
    define: {
      MAIN_WINDOW_VITE_DEV_SERVER_URL: JSON.stringify(url),
      MAIN_WINDOW_VITE_NAME: JSON.stringify("main_window"),
    },
    plugins: [
      {
        name: "desktop-native-dependencies",
        setup(build) {
          build.onResolve({ filter: /^(node-hid|electron-updater)$/ }, (args) => ({
            path: require.resolve(args.path),
            external: true,
          }));
        },
      },
    ],
  });
  for (const scenario of ["close", "quit", "early-close", "reopen"]) {
    const child = spawn(
      process.execPath,
      [
        require.resolve("electron/cli.js"),
        fileURLToPath(new URL("./close-smoke-main.mjs", import.meta.url)),
        temporary,
        scenario,
        `--user-data-dir=${path.join(temporary, scenario)}`,
      ],
      { stdio: "inherit" },
    );
    const code = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => resolve(code));
    });
    if (code !== 0) throw new Error(`Close smoke failed: ${scenario} (${code})`);
  }
  passed = true;
  console.log("PASS production main: close, quit, early close and window recreation");
} finally {
  await server.close();
  if (passed) await rm(temporary, { recursive: true, force: true });
  else console.error(`Close smoke artifacts: ${temporary}`);
}
