import { expect, expectTypeOf, it } from "vitest";
import { PLUGIN_API_VERSION, requestMethods, notificationMethods } from "./index.js";
import { DEVICE_LIMITS_V1 } from "./device-limits.js";
import type { ResourceOwner, MotionSpec } from "./device-types.js";
import type { DeviceRequestMap } from "./device-methods.js";
import type { Sha256 } from "./settings.js";
export type ContractFixtureFile={formatVersion:1;family:"device-broker-v1"|"declarative-ui-v1"|"settings-storage-v1";
  cases:Array<{id:string;schema:string;phase:"params"|"result"|"resource"|"event";input:unknown;valid:boolean;
    expected:{numericCode:number|null;businessCode:string|null;reason:string|null;permission:string|null;lifetime:string|null;persistedSha256:Sha256|null}}>};
it("F18 freezes identity and preserves the legacy envelope", () => {
  expectTypeOf<ResourceOwner>().toEqualTypeOf<{
    sourceKey: string; pluginId: string; generation: number; hostEpoch: string; processEpoch: string;
  }>();
  expectTypeOf<DeviceRequestMap["devices/motion/start"]["params"]>()
    .toEqualTypeOf<{ operationId: string }>();
  expectTypeOf<Extract<MotionSpec, { mode: "timed" }>["durationMs"]>().toBeNumber();
  expect(Object.keys(requestMethods.initialize.params.shape)).toEqual([
    "apiVersion", "pluginId", "locale", "grantedPermissions",
  ]);
  expect(requestMethods["command/execute"].result.parse(null)).toBeNull();
  expect(requestMethods["command/execute"].params.safeParse({ command: "acme.test.run", args: {} }).success).toBe(false);
  expect(DEVICE_LIMITS_V1).toMatchObject({ prepareMs: 5000, intentMs: 350, stopMs: 15000 });
  expect(Object.isFrozen(DEVICE_LIMITS_V1)).toBe(true);
  if (PLUGIN_API_VERSION === "1.4.0") {
    expect(Object.keys(requestMethods).some((m) => m.startsWith("devices/"))).toBe(false);
    expect(Object.keys(notificationMethods)).not.toContain("events/deliver");
  }
});

import { createMemoryChannelPair, RpcPeer, RPC_ERRORS } from "./index.js";
import type { RequestContext } from "./peer.js";
it("freezes afterReply without publishing an unavailable T0 continuation", async () => {
  expectTypeOf<RequestContext["afterReply"]>().toEqualTypeOf<
    (published: () => void, abandoned: () => void) => void
  >();
  const [a, b] = createMemoryChannelPair();
  const caller = new RpcPeer(a), receiver = new RpcPeer(b);
  let published = 0, abandoned = 0;
  receiver.handle("shutdown", (_params, context) => {
    context.afterReply(() => { published++; }, () => { abandoned++; });
    return null;
  });
  try {
    await expect(caller.request("shutdown", {})).rejects.toMatchObject({ code: RPC_ERRORS.internalError });
    expect(published).toBe(0);
    expect(abandoned).toBe(1);
  } finally {
    caller.close(); receiver.close();
  }
});
