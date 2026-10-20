import { expect, it } from "vitest";
import { deviceEventDataSchemas, eventEnvelopeSchema } from "./events.js";
import { validateDeviceWire } from "./device-validation.js";
const id = "00000000-0000-4000-8000-000000000001";
const event = {
  version: 1,
  subscriptionId: id,
  owner: {
    sourceKey: "builtin:acme.test",
    pluginId: "acme.test",
    generation: 0,
    hostEpoch: id,
    processEpoch: id,
  },
  sequence: 1,
  delivery: "control",
  kind: "events.resyncRequired",
  data: { reason: "overflow", affected: [id] },
};
it("F13 kind/data/delivery is closed and sequence starts at one", () => {
  expect(eventEnvelopeSchema.parse(event)).toEqual(event);
  for (const patch of [
    { kind: "events.gap" },
    { kind: "ui.changed" },
    { kind: "settings.changed" },
    { delivery: "telemetry" },
    { sequence: 0 },
    { data: { reason: "overflow", affected: [id], extra: true } },
  ])
    expect(eventEnvelopeSchema.safeParse({ ...event, ...patch }).success).toBe(false);
  expect(() =>
    validateDeviceWire("events/deliver.params", {
      ...event,
      data: { reason: "overflow", affected: [id, id] },
    }),
  ).toThrow();
});

it("pairs every published event kind with its data schema regardless of union order", () => {
  expect(Object.keys(deviceEventDataSchemas).sort()).toEqual(
    eventEnvelopeSchema.options.map((option) => option.shape.kind.value).sort(),
  );
  for (const option of eventEnvelopeSchema.options)
    expect(deviceEventDataSchemas[option.shape.kind.value]).toBe(option.shape.data);
});
