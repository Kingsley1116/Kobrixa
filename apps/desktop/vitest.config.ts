import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@kobrixa\/plugin-sdk$/,
        replacement: fileURLToPath(
          new URL("../../packages/plugin-sdk-js/src/index.ts", import.meta.url),
        ),
      },
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
  test: {
    name: "desktop",
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Many suites drive real worker threads and on-disk stores. Vitest's 5 s
    // default expires under parallel load on hosted runners. This is the
    // framework's hang detector only; acceptance budgets live in the tests.
    testTimeout: 30_000,
  },
});
