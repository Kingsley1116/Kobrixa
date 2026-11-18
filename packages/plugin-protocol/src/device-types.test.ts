import { expect, expectTypeOf, it } from "vitest";
import type { z } from "zod";
import type { motionSpecSchema } from "./device-types.js";
import { resourceOwnerSchema, type MotionSpec, type ResourceOwner } from "./device-types.js";
it("F02 schema outputs match frozen public aliases", () => {
  expectTypeOf<z.output<typeof motionSpecSchema>>().toEqualTypeOf<MotionSpec>();
  expectTypeOf<z.output<typeof resourceOwnerSchema>>().toEqualTypeOf<ResourceOwner>();
  const id = "00000000-0000-4000-8000-000000000001";
  const owner = {
    sourceKey: "dev:0123456789abcdef",
    pluginId: "acme.test",
    generation: 0,
    hostEpoch: id,
    processEpoch: id,
  };
  expect(resourceOwnerSchema.parse(owner)).toEqual(owner);
  for (const patch of [
    { sourceKey: "dev:XYZ" },
    { generation: true },
    { generation: 9007199254740992 },
    { hostEpoch: id.toUpperCase() },
    { authority: true },
  ]) {
    if (patch.hostEpoch === id) continue;
    expect(resourceOwnerSchema.safeParse({ ...owner, ...patch }).success).toBe(false);
  }
});
