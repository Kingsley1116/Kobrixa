import { expect, expectTypeOf, it } from "vitest";
import { PLUGIN_API_VERSION, requestMethods, notificationMethods } from "./index.js";
import { DEVICE_LIMITS_V1 } from "./device-limits.js";
import type { ResourceOwner, MotionSpec } from "./device-types.js";
import type { DeviceRequestMap } from "./device-methods.js";
import type { Sha256 } from "./settings.js";
export type ContractFixtureFile = {
  formatVersion: 1;
  family: "device-broker-v1" | "declarative-ui-v1" | "settings-storage-v1";
  cases: Array<{
    id: string;
    schema: string;
    phase: "params" | "result" | "resource" | "event";
    input: unknown;
    valid: boolean;
    expected: {
      numericCode: number | null;
      businessCode: string | null;
      reason: string | null;
      permission: string | null;
      lifetime: string | null;
      persistedSha256: Sha256 | null;
    };
  }>;
};
it("F18 freezes identity and preserves the legacy envelope", () => {
  expectTypeOf<ResourceOwner>().toEqualTypeOf<{
    sourceKey: string;
    pluginId: string;
    generation: number;
    hostEpoch: string;
    processEpoch: string;
  }>();
  expectTypeOf<DeviceRequestMap["devices/motion/start"]["params"]>().toEqualTypeOf<{
    operationId: string;
  }>();
  expectTypeOf<Extract<MotionSpec, { mode: "timed" }>["durationMs"]>().toBeNumber();
  expect(Object.keys(requestMethods.initialize.params.shape)).toEqual([
    "apiVersion",
    "pluginId",
    "locale",
    "grantedPermissions",
  ]);
  expect(requestMethods["command/execute"].result.parse(null)).toBeNull();
  expect(
    requestMethods["command/execute"].params.safeParse({ command: "acme.test.run", args: {} })
      .success,
  ).toBe(false);
  expect(DEVICE_LIMITS_V1).toMatchObject({ prepareMs: 5000, intentMs: 350, stopMs: 15000 });
  expect(Object.isFrozen(DEVICE_LIMITS_V1)).toBe(true);
  expect(PLUGIN_API_VERSION).toMatch(/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/);
  const [major = 0, minor = 0] = PLUGIN_API_VERSION.split(".").map(Number);
  expect(major > 1 || (major === 1 && minor >= 5)).toBe(true);
  expect(Object.keys(notificationMethods)).toContain("events/deliver");
});

import { createMemoryChannelPair, RpcPeer } from "./index.js";
import type { RequestContext } from "./peer.js";
it("publishes the frozen afterReply continuation after the reply", async () => {
  expectTypeOf<RequestContext["afterReply"]>().toEqualTypeOf<
    (published: () => void, abandoned: () => void) => void
  >();
  const [a, b] = createMemoryChannelPair();
  const caller = new RpcPeer(a),
    receiver = new RpcPeer(b);
  let published = 0,
    abandoned = 0;
  receiver.handle("shutdown", (_params, context) => {
    context.afterReply(
      () => {
        published++;
      },
      () => {
        abandoned++;
      },
    );
    return null;
  });
  try {
    await expect(caller.request("shutdown", {})).resolves.toBeNull();
    expect(published).toBe(1);
    expect(abandoned).toBe(0);
  } finally {
    caller.close();
    receiver.close();
  }
});
