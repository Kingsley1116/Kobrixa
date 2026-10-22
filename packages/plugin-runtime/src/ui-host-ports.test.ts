import { expect, it } from "vitest";
import { sameResourceOwner, sameUiBinding, unavailableUiCatalog } from "./ui-host-ports.js";
it("U04 compares complete identities, never only handle or plugin ID", async () => {
  const owner = {
    sourceKey: "s",
    pluginId: "test.ui",
    generation: 1,
    hostEpoch: "00000000-0000-4000-8000-000000000001",
    processEpoch: "00000000-0000-4000-8000-000000000002",
  };
  const binding = {
    contributionId: "test.ui.panel",
    panelInstance: "00000000-0000-4000-8000-000000000003",
    kind: "panel" as const,
    uiResourceGeneration: 1,
    generation: 1,
    hostEpoch: owner.hostEpoch,
    processEpoch: owner.processEpoch,
  };
  expect(sameResourceOwner(owner, { ...owner, sourceKey: "foreign" })).toBe(false);
  expect(sameResourceOwner(owner, { ...owner, generation: 2 })).toBe(false);
  expect(sameUiBinding(binding, { ...binding, uiResourceGeneration: 2 })).toBe(false);
  expect(sameUiBinding(binding, { ...binding, processEpoch: owner.hostEpoch })).toBe(false);
  expect((await unavailableUiCatalog().catalog({})).ok).toBe(false);
});
