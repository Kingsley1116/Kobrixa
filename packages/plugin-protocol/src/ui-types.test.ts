import { expect, it } from "vitest";
import {
  uiResultSchema,
  commandValueSchema,
  uiEventSchema,
  uiResourceDeclarationSchema,
} from "./ui-types.js";
it("U02 preserves contribution quarantine and code/detail pairing", () => {
  expect(uiResourceDeclarationSchema.safeParse({ version: 2, path: "../bad.json" }).success).toBe(
    true,
  );
  expect(uiResourceDeclarationSchema.safeParse({ version: "1", path: "a.json" }).success).toBe(
    false,
  );
  const schema = uiResultSchema(commandValueSchema);
  for (const [code, reason] of [
    ["PLUGIN_E_STALE_RESOURCE", "schema"],
    ["PLUGIN_E_RESOURCE_LIMIT", "limit"],
    ["PLUGIN_E_UI_RESOURCE", "negotiation"],
    ["PLUGIN_E_UI_VERSION", "read"],
  ])
    expect(
      schema.safeParse({
        ok: false,
        error: { code, message: "Invalid.", detail: { kind: "ui", reason } },
      }).success,
    ).toBe(false);
  expect(
    schema.safeParse({
      ok: false,
      error: {
        code: "PLUGIN_E_UI_RESOURCE",
        message: "Invalid.",
        detail: { kind: "ui", reason: "schema", currentRevision: 1 },
      },
    }).success,
  ).toBe(false);
  expect(
    uiEventSchema.safeParse({ kind: "ui.state", data: { locale: "en", theme: "dark" } }).success,
  ).toBe(false);
});

import { uiEventEnvelopeSchema } from "./ui-types.js";
import { uiEventDataSchemas } from "./events.js";
it("shares UI event data schemas and accepts only control delivery", () => {
  for (const option of uiEventSchema.options) {
    expect(uiEventDataSchemas[option.shape.kind.value]).toBe(option.shape.data);
  }
  const id = "00000000-0000-4000-8000-000000000001";
  const envelope = {
    version: 1,
    subscriptionId: id,
    sequence: 1,
    owner: {
      sourceKey: "builtin:acme.ui",
      pluginId: "acme.ui",
      generation: 1,
      hostEpoch: id,
      processEpoch: id,
    },
    kind: "ui.environment",
    data: { locale: "en", theme: "dark" },
    delivery: "control",
  };
  expect(uiEventEnvelopeSchema.safeParse(envelope).success).toBe(true);
  expect(uiEventEnvelopeSchema.safeParse({ ...envelope, delivery: "telemetry" }).success).toBe(
    false,
  );
});
