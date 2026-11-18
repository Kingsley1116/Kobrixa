import { expect, it, vi } from "vitest";
import { createPersistenceSources170 } from "./controller.js";

vi.mock("electron", () => ({
  app: { isPackaged: false },
  dialog: {},
  clipboard: {},
  utilityProcess: {},
  MessageChannelMain: class {},
}));

function fixture() {
  let active = true;
  const currentScope = vi.fn(() => false);
  const currentRuntime = vi.fn(() => false);
  const beforeDelivery = vi.fn();
  const sources = createPersistenceSources170({
    currentScope,
    currentRuntime,
    beforeDelivery,
    hostSettings: { hostEpoch: "host", current: () => active },
  });
  const identity = { sourceKey: "builtin:test.settings", pluginId: "test.settings", generation: 7 };
  const value = {
    schemaVersion: 1,
    title: { en: "Settings" },
    fields: [{ key: "enabled", label: { en: "Enabled" }, type: "boolean", default: false }],
  };
  const admit = (digest = "a".repeat(64)) =>
    sources.admit({
      owner: {
        sourceKey: identity.sourceKey,
        pluginId: identity.pluginId,
        uiResourceGeneration: 7,
      },
      eligible: true,
      document: { value, bytes: Buffer.byteLength(JSON.stringify(value)), digest },
    });
  const read = () => sources.port.settingsNamespace!(identity.sourceKey);
  sources.reconcileCoreSources([identity]);
  return {
    sources,
    identity,
    admit,
    read,
    currentScope,
    currentRuntime,
    beforeDelivery,
    deactivate: () => {
      active = false;
    },
    activate: () => {
      active = true;
    },
  };
}

it("reads only admitted settings metadata without a window or running plugin", () => {
  const f = fixture();
  expect(f.read()).toBeNull();
  f.admit();
  const first = f.read()!;
  expect(first).toMatchObject({
    owner: { ...f.identity, hostEpoch: "host" },
    resourceDigest: "a".repeat(64),
    uiResourceGeneration: 7,
  });
  expect(first.owner.processEpoch).toBeTruthy();
  expect(f.read()).toEqual(first);
  first.owner.pluginId = "forged";
  expect(f.read()!.owner.pluginId).toBe(f.identity.pluginId);
  f.sources.retireScope({ hostEpoch: "host", workbenchInstance: "closed" });
  expect(f.read()).not.toBeNull();
  expect(f.currentScope).not.toHaveBeenCalled();
  expect(f.currentRuntime).not.toHaveBeenCalled();
  expect(f.beforeDelivery).not.toHaveBeenCalled();
  expect(f.sources.port.current(f.read()!.owner)).toBe(false);
});

it("withdraws disabled settings immediately and never revives a removed capability", () => {
  const f = fixture();
  f.admit();
  const first = f.read()!;
  f.sources.reconcileSources([{ owner: first.owner, eligible: false }]);
  expect(f.read()).toBeNull();
  f.admit();
  expect(f.read()!.owner.processEpoch).not.toBe(first.owner.processEpoch);
  const second = f.read()!;
  f.admit("b".repeat(64));
  expect(f.read()!.owner.processEpoch).not.toBe(second.owner.processEpoch);
  expect(f.read()!.uiResourceGeneration).toBeGreaterThan(second.uiResourceGeneration);
  f.sources.revoke(f.identity.sourceKey);
  expect(f.read()).toBeNull();
});

it("requires matching source identity and fences metadata after the host retires", () => {
  const f = fixture();
  f.admit();
  const first = f.read()!;
  f.sources.reconcileCoreSources([{ ...f.identity, generation: 8 }]);
  expect(f.read()).toBeNull();
  f.sources.reconcileCoreSources([f.identity]);
  expect(f.read()!.owner.processEpoch).not.toBe(first.owner.processEpoch);
  const second = f.read()!;
  f.deactivate();
  expect(f.read()).toBeNull();
  f.activate();
  expect(f.read()!.owner.processEpoch).not.toBe(second.owner.processEpoch);
  f.sources.reconcileCoreSources([]);
  expect(f.read()).toBeNull();
});
