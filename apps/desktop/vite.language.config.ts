import { defineConfig } from "vite";

export default defineConfig({
  build: {
    sourcemap: true,
    rollupOptions: { output: { entryFileNames: "language-worker.cjs" } },
  },
});
