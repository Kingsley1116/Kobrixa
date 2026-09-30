import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^monaco-editor$/,
        replacement: fileURLToPath(
          import.meta.resolve("monaco-editor/esm/vs/editor/editor.main.js"),
        ),
      },
    ],
  },
  test: { name: "desktop", environment: "node", include: ["src/**/*.test.ts"] },
});
