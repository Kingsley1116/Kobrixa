import { expect, it, vi } from "vitest";
vi.mock("./bootstrap.js", () => {
  throw new Error("Plugin UI failed to load");
});
it("loads core recovery even when plugin bootstrap cannot evaluate", async () => {
  const { CoreRecoveryStore } = await import("./core-recovery.js");
  expect(CoreRecoveryStore).toBeTypeOf("function");
});
