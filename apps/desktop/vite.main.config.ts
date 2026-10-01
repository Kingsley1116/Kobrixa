import { defineConfig } from "vite";

export default defineConfig({
  build: {
    sourcemap: true,
    rollupOptions: {
      external: ["node-hid", "electron-updater"],
      output: { entryFileNames: "main.cjs" },
    },
  },
});
