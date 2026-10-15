import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@kobrixa\/compiler$/,
        replacement: fileURLToPath(
          new URL("../../packages/compiler/src/index.ts", import.meta.url),
        ),
      },

      {
        find: /^monaco-editor$/,
        replacement: fileURLToPath(import.meta.resolve("monaco-editor")),
      },
    ],
  },
  test: { name: "desktop", environment: "node", include: ["src/**/*.test.ts"] },
});
