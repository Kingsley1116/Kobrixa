import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { createServer } from "vite";
import { build } from "esbuild";
const root = fileURLToPath(new URL("../../", import.meta.url));
const temporary = await mkdtemp(path.join(tmpdir(), "kobrixa-desktop-smoke-"));
const require = createRequire(import.meta.url);
const server = await createServer({
  root: path.join(root, "apps/desktop"),
  configFile: path.join(root, "apps/desktop/vite.renderer.config.ts"),
  server: { host: "127.0.0.1", port: 0, watch: null, hmr: false },
});
let exitCode = 1;
try {
  await build({
    entryPoints: [path.join(root, "apps/desktop/src/main/keyboard.ts")],
    outfile: path.join(temporary, "keyboard.cjs"),
    bundle: true,
    platform: "node",
    format: "cjs",
    external: ["electron"],
  });
  await server.listen();
  const address = server.httpServer.address();
  const url = `http://127.0.0.1:${address.port}/tests/keyboard-smoke.html`;
  const child = spawn(
    process.execPath,
    [
      require.resolve("electron/cli.js"),
      fileURLToPath(new URL("./smoke-main.mjs", import.meta.url)),
      url,
      temporary,
    ],
    { stdio: "inherit" },
  );
  exitCode = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code) => resolve(code ?? 1));
  });
  if (exitCode) console.error(`Smoke test artifacts: ${temporary}`);
} finally {
  await server.close();
  if (!exitCode && !process.env.KOBRIXA_SMOKE_KEEP_ARTIFACTS)
    await rm(temporary, { recursive: true, force: true });
  else if (!exitCode) console.log(`Smoke test artifacts: ${temporary}`);
}
process.exitCode = exitCode;
