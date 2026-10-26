import { z } from "zod";
import { counterSchema } from "./device-types.js";
import { localIdSchema, uiScalarSchema } from "./ui-resource.js";
import { uiBindingSchema, uiResultSchema } from "./ui-types.js";
import { uiBytes, validString } from "./ui-validation.js";
import type { DefinitionMap } from "./business-result.js";

// JSON Schema carries exact map cardinality; the semantic helper enforces it
// for Zod callers without an unexportable wire refinement.
const fields = (minimum: number) =>
  z.record(localIdSchema, uiScalarSchema).meta({ minProperties: minimum, maxProperties: 32 });
export const uiFormPatchParamsSchemaV2 = z.strictObject({
  binding: uiBindingSchema.extend({ kind: z.literal("panel") }),
  baseFormRevision: counterSchema,
  set: fields(1),
});
export const uiFormPatchValueSchemaV2 = z.strictObject({
  formRevision: counterSchema,
  form: fields(0),
});
export const uiFormRequestSchemasV2 = {
  "ui/formPatch": {
    params: uiFormPatchParamsSchemaV2,
    result: uiResultSchema(uiFormPatchValueSchemaV2),
  },
};
export type UiFormRequestMapV2 = DefinitionMap<typeof uiFormRequestSchemasV2>;
export type UiFormPatchParamsV2 = z.infer<typeof uiFormPatchParamsSchemaV2>;
export type UiFormPatchValueV2 = z.infer<typeof uiFormPatchValueSchemaV2>;

// Inspect before parsing: parsing must not erase a caller's dangerous keys/prototype.
function plain(value: unknown, seen = new Set<object>()): boolean {
  if (!value || typeof value !== "object") return true;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
    return false;
  return Object.entries(value).every(
    ([key, child]) =>
      !["__proto__", "prototype", "constructor"].includes(key) && plain(child, seen),
  );
}
/** Wire semantics only. Owner, registered fields, formSync and atomic CAS are host checks. */
export function validUiFormWireV2(
  phase: "params" | "result",
  value: unknown,
  params?: unknown,
): boolean {
  try {
    if (!plain(value)) return false;
    if (phase === "result") {
      const result = uiFormRequestSchemasV2["ui/formPatch"].result.parse(value);
      if (!result.ok)
        return (
          validString(result.error.message, 2000) &&
          (result.error.detail === undefined || uiBytes(result.error.detail) <= 4096)
        );
      if (!validUiFormWireV2("params", params)) return false;
      const input = uiFormPatchParamsSchemaV2.parse(params);
      return (
        result.value.formRevision === input.baseFormRevision + 1 &&
        Object.entries(input.set).every(
          ([key, item]) => Object.hasOwn(result.value.form, key) && result.value.form[key] === item,
        ) &&
        validFields(result.value.form)
      );
    }
    const set = uiFormPatchParamsSchemaV2.parse(value).set;
    return Object.keys(set).length >= 1 && validFields(set);
  } catch {
    return false;
  }
}
function validFields(value: Record<string, unknown>): boolean {
  return (
    Object.keys(value).length <= 32 &&
    uiBytes(value) <= 16384 &&
    Object.values(value).every((item) => typeof item !== "string" || validString(item, 4000))
  );
}
