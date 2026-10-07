import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@kobrixa/collab-protocol": fileURLToPath(
        new URL("../../packages/collab-protocol/src/index.ts", import.meta.url),
      ),
    },
  },
  test: { name: "collab", environment: "node", include: ["src/**/*.test.ts"] },
});
