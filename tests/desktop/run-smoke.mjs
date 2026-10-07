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
  // The worker discovers physics lazily; optimize it before opening the UI so
  // Vite cannot reload the workbench halfway through the simulator assertions.
  optimizeDeps: { include: ["planck"] },
  // Count real App renders without adding instrumentation to the shipped renderer.
  plugins: [
    {
      name: "smoke-app-render-counter",
      enforce: "pre",
      transform(code, id) {
        if (
          process.env.KOBRIXA_SMOKE_COLLAB_LINKED &&
          id === path.join(root, "apps/desktop/src/renderer/collab/collab-session.ts")
        ) {
          // Exercise the real App and room controls with deterministic linked peers.
          // This replacement exists only in this smoke Vite server, never in a build.
          return `import { createLinkedSessions } from "./testing.js";
            import * as Y from "yjs";
            import { DeviceControl } from "./device-control.js";
            import { ChatController } from "./chat.js";
            export function createCollabSession(connection) {
              const previous = window.__collabSmoke;
              const state = previous?.session.connection.roomId === connection.roomId
                ? Y.encodeStateAsUpdate(previous.room.sessions[2].doc) : null;
              const room = createLinkedSessions([connection.role, "editor", "viewer"], connection.roomId);
              if (state) Y.applyUpdate(room.sessions[1].doc, state);
              const session = room.sessions[0];
              Object.assign(session.connection, connection);
              session.setRole(connection.role);
              session.awareness.setLocalState({ ...session.awareness.getLocalState(), name: connection.name });
              window.__collabSmoke = { room, session, peerControl: new DeviceControl(room.sessions[1]), peerChat: new ChatController(room.sessions[1]) };
              previous?.peerControl.dispose();
              previous?.peerChat.dispose();
              return session;
            }`;
        }

        // Exercise the internal simulator covered by this suite even while its
        // release feature flag keeps the production toolbar entry hidden.
        if (id === path.join(root, "apps/desktop/src/shared/features.ts")) {
          return code.replace("SIMULATOR_ENABLED = false", "SIMULATOR_ENABLED = true");
        }
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
      path.join(root, "apps/desktop/src/main/device/monitor-service.ts"),
      path.join(root, "apps/desktop/src/main/device/motor-test-service.ts"),
      path.join(root, "apps/desktop/src/main/sensor-lab/service.ts"),
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
