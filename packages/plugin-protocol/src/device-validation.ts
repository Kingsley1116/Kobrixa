import { deviceReasonByCode } from "./business-result.js";
const bytes = (text: string) => new TextEncoder().encode(text).byteLength;
const fail = (): never => {
  throw new Error("Invalid device wire value");
};
export function canonicalIp(address: string): boolean {
  if (/^(?:0|[1-9][0-9]{0,2})(?:\.(?:0|[1-9][0-9]{0,2})){3}$/.test(address))
    return address.split(".").every((n) => Number(n) <= 255);
  if (!address.includes(":") || !/^[0-9a-f:]+$/.test(address)) return false;
  try {
    return new URL(`http://[${address}]/`).hostname === `[${address}]`;
  } catch {
    return false;
  }
}
export function validateDeviceWire(name: string, value: unknown, serialized?: string): void {
  if (!name.startsWith("devices/") && !name.startsWith("events/")) return;
  const text = serialized ?? JSON.stringify(value);
  const size = bytes(text);
  if (
    size > 1_048_576 ||
    (name.endsWith(".params") && name !== "events/deliver.params" && size > 16_384)
  )
    fail();
  if (name === "devices/recording/read.result" && size > 65_536) fail();
  if (
    (name.startsWith("devices/motion/") || name === "devices/recording/query.result") &&
    name.endsWith(".result") &&
    size > 16_384
  )
    fail();
  const visit = (node: unknown, key: string, parent: Record<string, unknown> | null): void => {
    if (typeof node === "number" && !Number.isFinite(node)) fail();
    if (typeof node === "string") {
      if (
        node.includes("\0") ||
        /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(node)
      )
        fail();
      let max: number | undefined;
      if (key === "name")
        max =
          parent && ("channelId" in parent || "actuatorId" in parent || "modeId" in parent)
            ? 80
            : 200;
      if (key === "modeName") max = 80;
      if (key === "unit") max = 32;
      if (key === "message") max = 2000;
      if (max !== undefined && [...node].length > max) fail();
      if (key === "address" && !canonicalIp(node)) fail();
    }
    if (Array.isArray(node)) {
      if (
        ["channelIds", "capabilities", "affected"].includes(key) &&
        new Set(node.map((v) => (typeof v === "object" && v !== null ? JSON.stringify(v) : v)))
          .size !== node.length
      )
        fail();
      const uniqueKey = (
        {
          channels: "channelId",
          actuators: "actuatorId",
          values: "channelId",
          candidates: "candidateId",
          providers: "providerId",
          sessions: "sessionId",
          modes: "modeId",
        } as Record<string, string>
      )[key];
      if (
        uniqueKey &&
        new Set(node.map((v) => (v as Record<string, unknown>)[uniqueKey])).size !== node.length
      )
        fail();
      for (const child of node) visit(child, key, null);
    } else if (node !== null && typeof node === "object") {
      const item = node as Record<string, unknown>;
      if (
        "fromSequence" in item &&
        "toSequence" in item &&
        Number(item.fromSequence) > Number(item.toSequence)
      )
        fail();
      if ("motionScopeRef" in item) {
        const motion = item.motion as Record<string, unknown>;
        if ((motion.mode === "jog") !== Object.hasOwn(item, "gestureRef")) fail();
      }
      if (typeof item.code === "string" && item.detail !== undefined) {
        const d = item.detail as Record<string, unknown>;
        if (d.kind === "permission") {
          if (item.code !== "PLUGIN_E_PERMISSION_DENIED") fail();
        } else if (d.kind === "resource") {
          if (
            d.reason === "stale"
              ? item.code !== "PLUGIN_E_STALE_RESOURCE"
              : item.code !== "PLUGIN_E_RESOURCE_LIMIT"
          )
            fail();
        } else if (d.kind === "device") {
          const allowed = (deviceReasonByCode as Record<string, readonly string[]>)[item.code];
          if (!allowed?.includes(String(d.reason))) fail();
        } else fail();
      }
      if (item.version === 1 && "delivery" in item) {
        if (item.delivery === "control" && size > 16_384) fail();
        if (item.delivery === "telemetry" && size > 65_536) fail();
      }
      for (const [k, v] of Object.entries(item)) visit(v, k, item);
    }
  };
  visit(value, "", null);
}
