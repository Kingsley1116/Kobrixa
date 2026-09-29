import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

export default defineConfig({
  plugins: [react()],
  server: { proxy: { "/api": "http://localhost:8787" } },
  resolve: {
    alias: {
      "@kobrixa/ir": fileURLToPath(new URL("../../packages/ir/src/index.ts", import.meta.url)),
    },
  },
});
