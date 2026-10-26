import { settingsResourceV1Schema, validateSettingsValues, type SettingsResourceV1 } from "./settings.js";
import { PersistenceValidationError } from "./persistence-primitives.js";
export * from "./persistence-primitives.js";

export function validateSettingsResource(input: unknown, rawBytes: number): SettingsResourceV1 {
  if (!Number.isSafeInteger(rawBytes) || rawBytes < 0 || rawBytes > 65536) throw new PersistenceValidationError("size-limit");
  const parsed = settingsResourceV1Schema.safeParse(input);
  if (!parsed.success) throw new PersistenceValidationError("invalid-resource");
  const resource = parsed.data;
  if (new Set(resource.fields.map(f => f.key)).size !== resource.fields.length) throw new PersistenceValidationError("duplicate-key");
  for (const f of resource.fields) {
    if ((f.type === "number" || f.type === "integer") && f.minimum > f.maximum) throw new PersistenceValidationError("invalid-resource");
    if (f.type === "string" && f.minLength > f.maxLength) throw new PersistenceValidationError("invalid-resource");
    if (f.type === "enum" && new Set(f.options.map(o => JSON.stringify([typeof o.value, o.value]))).size !== f.options.length) throw new PersistenceValidationError("duplicate-key");
  }
  validateSettingsValues(resource, resource.fields.map(f => ({ key: f.key, value: f.default })), true);
  return resource;
}
