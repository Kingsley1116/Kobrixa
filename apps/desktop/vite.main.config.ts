import { defineConfig } from "vite";
import type {} from "@electron-forge/plugin-vite/forge-vite-env";

export default defineConfig(({ forgeConfigSelf }) => {
  const worker =
    forgeConfigSelf !== undefined &&
    "entry" in forgeConfigSelf &&
    forgeConfigSelf.entry === "src/main/plugins/persistence/worker.ts";
  return {
    build: {
      sourcemap: true,
      rollupOptions: {
        external: ["node-hid", "electron-updater"],
        output: {
          entryFileNames: worker ? "persistence-worker.cjs" : "main.cjs",
          footer: worker ? "exports.runPersistenceWorker({mappers:new Map()});" : "",
        },
      },
    },
  };
});
