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
  // Count real App renders without adding instrumentation to the shipped renderer.
  plugins: [
    {
      name: "smoke-app-render-counter",
      enforce: "pre",
      transform(code, id) {
        if (id === path.join(root, "apps/desktop/src/renderer/editor/completion-session.ts")) {
          return code.replace(
            "for (const listener of this.listeners) listener();",
            'for (const listener of this.listeners) listener(); window.dispatchEvent(new CustomEvent("smoke-completion-applied",{detail:{time:performance.now()}}));',
          );
        }
        if (id === path.join(root, "apps/desktop/src/renderer/editor/analysis-session.ts")) {
          return code
            .replace(
              "private emit(event: Event): void {",
              "private emit(event: Event): void { const smokeStart=performance.now();",
            )
            .replace(
              "for (const listener of this.listeners) listener(this.getCurrent(), event);",
              'for (const listener of this.listeners) listener(this.getCurrent(), event); if(event === "result") window.dispatchEvent(new CustomEvent("smoke-analysis-applied",{detail:{duration:performance.now()-smokeStart,time:performance.now()}}));',
            );
        }
        if (id === path.join(root, "apps/desktop/src/renderer/editor/analysis-transport.ts")) {
          return code.replace(
            /this.result\s*=\s*applyAnalysis\(this.result,\s*reply.patch\);/,
            'const smokeStart=performance.now(); this.result=applyAnalysis(this.result,reply.patch); window.dispatchEvent(new CustomEvent("smoke-analysis-merged",{detail:{duration:performance.now()-smokeStart,time:performance.now()}}));',
          );
        }
        if (id !== path.join(root, "apps/desktop/src/renderer/app.tsx")) return;
        const entry = "export function App(): React.JSX.Element {";
        if (!code.includes(entry)) throw new Error("Update the smoke App render probe.");
        return code.replace(
          entry,
          `${entry}\nwindow.dispatchEvent(new Event("smoke-app-render"));`,
        );
      },
    },
  ],
  server: { host: "127.0.0.1", port: 0, watch: null, hmr: false },
});
let exitCode = 1;
try {
  await build({
    entryPoints: [
      path.join(root, "apps/desktop/src/main/window/keyboard.ts"),
      path.join(root, "apps/desktop/src/shared/workspace-search.ts"),
      path.join(root, "apps/desktop/src/main/language/language.ts"),
      path.join(root, "apps/desktop/src/main/language/language-worker.ts"),
    ],
    outdir: temporary,
    entryNames: "[name]",
    outExtension: { ".js": ".cjs" },
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
