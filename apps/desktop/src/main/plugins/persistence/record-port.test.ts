import { expect, expectTypeOf, it } from "vitest";
import type { Principal } from "@kobrixa/plugin-runtime";
import type { StorageRequestMap } from "@kobrixa/plugin-protocol";
import { ownerKey, decodeChunk, PersistenceFault, type RecordServicePort } from "./record-port.js";
it("pins the frozen request signature without widening the wire map", () => {
  type Begin = RecordServicePort["request"];
  expectTypeOf<Begin>().toExtend<
    <M extends keyof StorageRequestMap>(
      p: Principal,
      m: M,
      value: StorageRequestMap[M]["params"],
      s: AbortSignal,
    ) => Promise<StorageRequestMap[M]["result"]>
  >();
});
it("B2-12.1-3: rejects noncanonical, oversized and invalid-tail base64 before append", () => {
  for (const value of ["", "YQ", "YQ===", "YQ==\n", "YR==", "_w==", "-w==", "YQ=", "é"])
    expect(() => decodeChunk(value)).toThrow();
  expect(decodeChunk(Buffer.alloc(262144, 1).toString("base64"))).toHaveLength(262144);
  expect(() => decodeChunk(Buffer.alloc(262145, 1).toString("base64"))).toThrow();
});
it("binds handles to all five owner fields and never echoes an I/O path", () => {
  const owner = {
    sourceKey: "builtin:test.records",
    pluginId: "test.records",
    generation: 1,
    hostEpoch: "a",
    processEpoch: "b",
  };
  for (const changed of [
    { ...owner, processEpoch: "c" },
    { ...owner, hostEpoch: "c" },
    { ...owner, generation: 2 },
    { ...owner, sourceKey: "builtin:test.other" },
  ])
    expect(ownerKey(changed)).not.toBe(ownerKey(owner));
  expect(JSON.stringify(new PersistenceFault("PLUGIN_E_STORAGE_IO", "io").result)).not.toContain(
    "path",
  );
});
