import { expect, it } from "vitest";
import { deviceRequestSchemas } from "./device-methods.js";
import { buildJsonSchema } from "./json-schema.js";
import { PLUGIN_API_VERSION } from "./index.js";
it("F18 publishes all twenty-one methods without changing legacy methods", () => {
  expect(Object.keys(deviceRequestSchemas)).toHaveLength(21);
  const schema = buildJsonSchema();
  expect(schema.$id).toBe(`https://kobrixa.com/schemas/plugin-protocol/${PLUGIN_API_VERSION}.json`);
  for (const method of Object.keys(deviceRequestSchemas)) {
    expect(schema.$defs).toHaveProperty(`${method}.params`);
    expect(schema.$defs).toHaveProperty(`${method}.result`);
  }
  expect(
    deviceRequestSchemas["events/ack"].result.parse({ ok: true, value: { acknowledged: 0 } }),
  ).toEqual({ ok: true, value: { acknowledged: 0 } });
});
