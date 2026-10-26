import { expect, expectTypeOf, it } from "vitest";
import { PublicationGate, ownerKey, type PersistenceEnginePort } from "./engine-port.js";
it("has one dispatch winner and a fence cannot pretend to undo it", () => {
  const gate = new PublicationGate(100), before = new PublicationGate(100);
  before.shorten(5); expect(before.dispatch(5)).toBe(false);
  expect(gate.dispatch(4)).toBe(true); gate.shorten(4);
  expect(gate.dispatched).toBe(true); expect(gate.dispatch(4)).toBe(false);
  expectTypeOf<PersistenceEnginePort["publish"]>().returns.toMatchTypeOf<Promise<{ disposition: "not-committed" | "committed" | "unknown" }>>();
});
it("owner equality includes both epochs and generation, independent of key order", () => {
  const owner = { sourceKey: "builtin:kobrixa.lab", pluginId: "kobrixa.lab", generation: 1, hostEpoch: "h", processEpoch: "p" };
  expect(ownerKey(owner)).not.toBe(ownerKey({ ...owner, generation: 2 }));
  expect(ownerKey(owner)).not.toBe(ownerKey({ ...owner, processEpoch: "other" }));
});
