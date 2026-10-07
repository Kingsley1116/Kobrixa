import { defineWorkspace } from "vitest/config";

export default defineWorkspace([
  "packages/*/vitest.config.ts",
  "frontends/*/vitest.config.ts",
  "apps/web/vitest.config.ts",
  "apps/collab/vitest.config.ts",
  "apps/desktop/vitest.config.ts",
]);
