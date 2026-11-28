import { expect, it } from "vitest";
import type { Principal } from "@kobrixa/plugin-runtime";
import { DeviceRpcBinding, ownerKey } from "./rpc-bindings.js";
const id = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, "0")}`;
const principal = (): Extract<Principal, { kind: "plugin" }> => ({
  kind: "plugin",
  owner: {
    sourceKey: "dev:one",
    pluginId: "test.consumer",
    generation: 4,
    hostEpoch: id(1),
    processEpoch: id(2),
  },
  authorityContext: { ref: id(3), epoch: id(4) },
});
it("F02 captures all owner fields and permits new requests to capture a new host authority epoch", () => {
  let p = principal();
  const binding = new DeviceRpcBinding(() => p);
  const first = binding.capture();
  p = { ...p, authorityContext: { ref: id(3), epoch: id(5) } };
  const second = binding.capture();
  expect(first.authorityContext!.epoch).toBe(id(4));
  expect(second.authorityContext!.epoch).toBe(id(5));
  expect(ownerKey(first)).toBe(ownerKey(second));
});
it.each([
  { sourceKey: "dev:two" },
  { pluginId: "test.other" },
  { generation: 5 },
  { hostEpoch: id(6) },
  { processEpoch: id(7) },
])("F02 rejects recycled channels: %j", (patch) => {
  let p = principal();
  const binding = new DeviceRpcBinding(() => p);
  p = { ...p, owner: { ...p.owner, ...patch } };
  expect(() => binding.capture()).toThrow("owner");
});
it("F17 never revives a disposed channel even if its caller callback becomes valid again", () => {
  const binding = new DeviceRpcBinding(principal);
  binding.close();
  binding.close();
  expect(() => binding.capture()).toThrow("closed");
});

it("captures detached frozen owner and authority DTOs for an in-flight request", () => {
  const current = principal();
  const binding = new DeviceRpcBinding(() => current);
  const captured = binding.capture();
  expect(Object.isFrozen(captured)).toBe(true);
  expect(captured.kind).toBe("plugin");
  if (captured.kind !== "plugin") throw new Error("plugin required");
  expect(Object.isFrozen(captured.owner)).toBe(true);
  expect(Object.isFrozen(captured.authorityContext)).toBe(true);
  current.owner.processEpoch = id(9);
  current.authorityContext!.epoch = id(10);
  expect(captured.owner.processEpoch).toBe(id(2));
  expect(captured.authorityContext!.epoch).toBe(id(4));
  expect(() => binding.capture()).toThrow("owner");
});
