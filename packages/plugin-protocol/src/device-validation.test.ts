import { z } from "zod";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { deviceRequestSchemas } from "./device-methods.js";
import type { ContractFixtureFile } from "./device-contract.test.js";
import { validateDeviceWire } from "./device-validation.js";
import { motionSpecSchema, deviceCandidateSchema } from "./device-types.js";
const fixtureDefinitions: Record<string, z.ZodType> = Object.fromEntries([
  ...Object.entries(deviceRequestSchemas).flatMap(([method, definition]) => [
    [`${method}.params`, definition.params],
    [`${method}.result`, definition.result],
  ]),
  ["events/deliver.params", eventEnvelopeSchema],
]);
const fixtureFileSchema = z.strictObject({
  formatVersion: z.literal(1),
  family: z.literal("device-broker-v1"),
  cases: z.array(
    z.strictObject({
      id: z.string().min(1).max(128),
      schema: z.enum(Object.keys(fixtureDefinitions)),
      phase: z.enum(["params", "result", "resource", "event"]),
      input: z.json(),
      valid: z.boolean(),
      expected: z.strictObject({
        numericCode: z.number().int().nullable(),
        businessCode: z.string().nullable(),
        reason: z.string().nullable(),
        permission: z.string().nullable(),
        lifetime: z.string().nullable(),
        persistedSha256: z
          .string()
          .regex(/^[0-9a-f]{64}$/)
          .nullable(),
      }),
    }),
  ),
});
const parseFixtureFile = (value: unknown): ContractFixtureFile => fixtureFileSchema.parse(value);
const parseFixture = (schema: string, input: unknown) => {
  const definition = fixtureDefinitions[schema];
  if (!definition) throw new Error("Unknown fixture schema");
  definition.parse(input);
  validateDeviceWire(schema, input);
};
const id = "00000000-0000-4000-8000-000000000001";
const parse = (method: string, params: unknown) => {
  const definition = Object.entries(deviceRequestSchemas).find(([name]) => name === method)?.[1];
  if (!definition) throw new Error("Unknown fixture method");
  definition.params.parse(params);
  validateDeviceWire(`${method}.params`, params);
};
describe("F16 portable device fixtures", () => {
  for (const kind of ["valid", "invalid", "maximum"] as const) {
    const cases = parseFixtureFile(
      JSON.parse(
        readFileSync(
          new URL(`../test-fixtures/device-broker-v1/${kind}.json`, import.meta.url),
          "utf8",
        ),
      ),
    );
    for (const [index, fixture] of cases.cases.entries())
      it(`${kind} ${index}`, () => {
        if (fixture.valid) expect(() => parseFixture(fixture.schema, fixture.input)).not.toThrow();
        else expect(() => parseFixture(fixture.schema, fixture.input)).toThrow();
      });
  }
});
it("F03 motion is discriminated, finite and rejects boolean integers", () => {
  const motion = {
    mode: "timed",
    actuatorId: id,
    power: 100,
    direction: 1,
    brake: true,
    durationMs: 5000,
  };
  expect(motionSpecSchema.parse(motion)).toEqual(motion);
  for (const patch of [
    { power: true },
    { power: 101 },
    { durationMs: 99 },
    { durationMs: 5001 },
    { degrees: 1 },
    { direction: 0 },
    { power: NaN },
    { power: Infinity },
  ])
    expect(motionSpecSchema.safeParse({ ...motion, ...patch }).success).toBe(false);
  expect(() =>
    parse("devices/motion/prepare", {
      sessionId: id,
      contextRef: id,
      motionScopeRef: id,
      motion: { ...motion, mode: "jog", durationMs: undefined },
    }),
  ).toThrow();
});
it("F16 code points, duplicate IDs, canonical addresses and actual bytes", () => {
  const candidate = {
    candidateId: id,
    providerId: "kobrixa.device-ev3",
    name: "😀".repeat(200),
    transport: "mock",
    identity: "session-only",
    expiresInMs: 30000,
  };
  deviceCandidateSchema.parse(candidate);
  expect(() =>
    validateDeviceWire("devices/discover.result", { ok: true, value: { candidates: [candidate] } }),
  ).not.toThrow();
  for (const name of ["😀".repeat(201), "x\u0000", "\ud800"])
    expect(() =>
      validateDeviceWire("devices/discover.result", {
        ok: true,
        value: { candidates: [{ ...candidate, name }] },
      }),
    ).toThrow();
  expect(() =>
    parse("devices/read", { sessionId: id, channelIds: [id, id], freshness: "fresh" }),
  ).toThrow();
  for (const address of [
    "01.2.3.4",
    "http://1.2.3.4",
    "1.2.3.4:80",
    "user@1.2.3.4",
    "2001:0DB8::1",
    "fe80::1%en0",
  ])
    expect(() =>
      parse("devices/connect", {
        target: { kind: "wifi-address", providerId: "kobrixa.device-ev3", address },
      }),
    ).toThrow();
  expect(() =>
    validateDeviceWire(
      "devices/list.params",
      JSON.parse("{}" + " ".repeat(16382)),
      "{}" + " ".repeat(16382),
    ),
  ).not.toThrow();
  expect(() =>
    validateDeviceWire(
      "devices/list.params",
      JSON.parse("{}" + " ".repeat(16383)),
      "{}" + " ".repeat(16383),
    ),
  ).toThrow();
});

import { eventEnvelopeSchema } from "./events.js";
it("F13/F16 maximum fixture drives structural and actual UTF-8 byte edges", () => {
  const maximum = {
    frames: { accepted: 64, rejected: 65 },
    batchBytes: { accepted: 65536, rejected: 65537 },
  };
  const sample = {
    sequence: 1,
    sampledAt: 0,
    elapsedMs: 0,
    sourceRevision: 1,
    status: "ok",
    values: [{ channelId: id, value: 1 }],
    program: "stopped",
  };
  const envelope = {
    version: 1,
    subscriptionId: id,
    owner: {
      sourceKey: "builtin:acme.test",
      pluginId: "acme.test",
      generation: 1,
      hostEpoch: id,
      processEpoch: id,
    },
    sequence: 1,
    kind: "devices.telemetry",
    delivery: "telemetry",
    data: {
      sessionId: id,
      frames: Array.from({ length: maximum.frames.accepted }, (_, i) => ({
        ...sample,
        sequence: i + 1,
      })),
      snapshot: { sessionId: id, revision: 1, status: "fresh", ageMs: 0, frame: sample },
    },
  };
  eventEnvelopeSchema.parse(envelope);
  validateDeviceWire("events/deliver.params", envelope);
  expect(
    eventEnvelopeSchema.safeParse({
      ...envelope,
      data: {
        ...envelope.data,
        frames: Array.from({ length: maximum.frames.rejected }, () => sample),
      },
    }).success,
  ).toBe(false);
  const json = JSON.stringify(envelope),
    length = new TextEncoder().encode(json).length;
  const atLimit = json + " ".repeat(maximum.batchBytes.accepted - length);
  expect(new TextEncoder().encode(atLimit).length).toBe(65536);
  expect(() =>
    validateDeviceWire("events/deliver.params", JSON.parse(atLimit), atLimit),
  ).not.toThrow();
  expect(() =>
    validateDeviceWire("events/deliver.params", JSON.parse(atLimit + " "), atLimit + " "),
  ).toThrow();
});

it("rejects malformed portable fixture envelopes and unknown schema keys", () => {
  const source = JSON.parse(
    readFileSync(new URL("../test-fixtures/device-broker-v1/valid.json", import.meta.url), "utf8"),
  );
  for (const value of [
    null,
    [],
    { ...source, formatVersion: 2 },
    { ...source, family: "other" },
    { ...source, extra: true },
    { ...source, cases: [{ ...source.cases[0], schema: "unknown.params" }] },
    { ...source, cases: [{ ...source.cases[0], valid: 1 }] },
    {
      ...source,
      cases: [{ ...source.cases[0], expected: { ...source.cases[0].expected, extra: null } }],
    },
  ])
    expect(() => parseFixtureFile(value)).toThrow();
});

import { RpcPeer, type MessageChannelLike } from "./index.js";
it("reports the fixture's numeric error for a mismatched common failure result", async () => {
  const fixtures = parseFixtureFile(
    JSON.parse(
      readFileSync(
        new URL("../test-fixtures/device-broker-v1/invalid.json", import.meta.url),
        "utf8",
      ),
    ),
  );
  const fixture = fixtures.cases.find((entry) => entry.id === "mismatched-common-failure")!;
  let receive: (text: string) => void = () => {};
  const channel: MessageChannelLike = {
    send(text) {
      const request = JSON.parse(text);
      queueMicrotask(() =>
        receive(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: fixture.input })),
      );
    },
    onMessage(listener) {
      receive = listener;
      return () => {};
    },
  };
  const peer = new RpcPeer(channel);
  try {
    await expect(peer.request("devices/list", {})).rejects.toMatchObject({
      code: fixture.expected.numericCode,
    });
  } finally {
    peer.close();
  }
});
