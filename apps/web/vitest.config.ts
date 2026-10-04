import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
export default defineConfig({
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
  test: { name: "web", environment: "node", include: ["src/**/*.test.ts"] },
});
