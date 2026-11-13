import { expect, it } from "vitest";
import { createSettingsClient, type PersistenceRequest } from "./settings.js";
it("forwards one update with its original revision and preserves business errors", async () => {
  const calls: unknown[] = [],
    signal = new AbortController().signal;
  const result = {
    ok: false,
    error: {
      code: "PLUGIN_E_SETTINGS_CONFLICT",
      message: "Conflict",
      detail: { kind: "persistence", reason: "revision-mismatch" },
    },
  };
  const request = (async (...args: unknown[]) => {
    calls.push(args);
    return result;
  }) as PersistenceRequest;
  const client = createSettingsClient(request);
  const params = { schemaVersion: 1, expectedRevision: null, changes: [{ key: "a", value: true }] };
  expect(await client.update(params, signal)).toBe(result);
  expect(calls).toEqual([["settings/update", params, { timeoutMs: 10000, signal }]]);
  expect("unwatch" in client).toBe(false);
});
it("leaves numeric transport errors untouched and never retries a mutation", async () => {
  let count = 0;
  const error = Object.assign(new Error("shape"), { code: -32602 });
  const request = (async () => {
    count++;
    throw error;
  }) as PersistenceRequest;
  await expect(
    createSettingsClient(request).reset({ schemaVersion: 1, expectedRevision: null, keys: ["a"] }),
  ).rejects.toBe(error);
  expect(count).toBe(1);
});

import type { SettingsResourceV1 } from "./settings.js";
import { validateSettingsResource } from "../../plugin-protocol/src/persistence-validation.js";
import { validateSettingsValues } from "../../plugin-protocol/src/settings.js";
it("public resource types carry resetWhen; shared validator rejects inconsistent complete snapshots", () => {
  const resource: SettingsResourceV1 = {
    schemaVersion: 1,
    title: { en: "T" },
    fields: [
      { key: "remember", label: { en: "Remember" }, type: "boolean", default: false },
      {
        key: "address",
        label: { en: "Address" },
        type: "string",
        default: "",
        minLength: 0,
        maxLength: 45,
        maxBytes: 180,
        resetWhen: { key: "remember", equals: false },
      },
    ],
  };
  expect(validateSettingsResource(resource, Buffer.byteLength(JSON.stringify(resource)))).toEqual(
    resource,
  );
  expect(() =>
    validateSettingsValues(
      resource,
      [
        { key: "remember", value: false },
        { key: "address", value: "old" },
      ],
      true,
    ),
  ).toThrow();
});
