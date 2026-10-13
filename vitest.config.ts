import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      "packages/*/vitest.config.ts",
      "frontends/*/vitest.config.ts",
      "apps/web/vitest.config.ts",
      "apps/collab/vitest.config.ts",
      "apps/desktop/vitest.config.ts",
    ],
  },
});
