import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

export default defineConfig({
  plugins: [react()],
  server: { proxy: { "/api": "http://localhost:8787" } },
  resolve: {
    alias: [
      {
        find: /^@kobrixa\/compiler\/diagnostic-help$/,
        replacement: fileURLToPath(
          new URL("../../packages/compiler/src/diagnostic-help.ts", import.meta.url),
        ),
      },
      {
        find: "@kobrixa/ir",
        replacement: fileURLToPath(new URL("../../packages/ir/src/index.ts", import.meta.url)),
      },
    ],
  },
});
