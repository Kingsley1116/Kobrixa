import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@kobrixa/plugin-protocol": fileURLToPath(
        new URL("../../packages/plugin-protocol/src/index.ts", import.meta.url),
      ),
      "@kobrixa/plugin-sdk": fileURLToPath(
        new URL("../../packages/plugin-sdk-js/src/index.ts", import.meta.url),
      ),
    },
  },
  test: {
    root: fileURLToPath(new URL(".", import.meta.url)),
    environment: "node",
    include: ["src/**/*.test.ts", "resources.test.ts"],
  },
});
