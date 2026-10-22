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
import { eventEnvelopeSchema, uiEventDataSchemas } from "./events.js";
it("shares UI event data schemas and keeps environment changes on control delivery", () => {
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

it("matches the common envelope for every UI kind, with state invalidation on telemetry", () => {
  const id = "00000000-0000-4000-8000-000000000001";
  const binding = {
    contributionId: "acme.ui.panel",
    kind: "panel",
    panelInstance: id,
    uiResourceGeneration: 1,
    generation: 1,
    hostEpoch: id,
    processEpoch: id,
  };
  const data = {
    "ui.instances": { instances: [binding] },
    "ui.visibility": { binding, visible: false },
    "ui.environment": { locale: "en", theme: "dark" },
    "ui.form": { binding, revision: 1, values: {} },
    "ui.state": { binding, revision: 1 },
    "ui.revoked": { binding, reason: "closed" },
  };
  for (const kind of Object.keys(data) as Array<keyof typeof data>) {
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
      kind,
      data: data[kind],
      delivery: kind === "ui.state" ? "telemetry" : "control",
    };
    for (const schema of [eventEnvelopeSchema, uiEventEnvelopeSchema]) {
      expect(schema.safeParse(envelope).success, kind).toBe(true);
      expect(
        schema.safeParse({
          ...envelope,
          delivery: envelope.delivery === "control" ? "telemetry" : "control",
        }).success,
        kind,
      ).toBe(false);
    }
  }
});
