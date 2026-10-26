import {
  validateUiResource,
  validateUiResourceV2,
  uiFailure,
  type PanelResourceV1,
  type StatusResourceV1,
  type UiResourceV2,
  type UiValidationContext,
  type Result,
} from "@kobrixa/plugin-protocol";

export type VersionedUiResource =
  | { version: 1; resource: PanelResourceV1 | StatusResourceV1 }
  | { version: 2; resource: UiResourceV2 };

/** Local host dispatch only. A v1 validator override is retained for existing
 * bounded-reader tests; it can never authorize or parse a declared v2 resource. */
export function validateVersionedUiResource(
  version: number,
  value: unknown,
  context: UiValidationContext,
  bytes: number,
  validateV1: (
    value: unknown,
    context: UiValidationContext,
    bytes: number,
  ) => Result<PanelResourceV1 | StatusResourceV1> = validateUiResource,
): Result<VersionedUiResource> {
  if (version === 1) {
    const parsed = validateV1(value, context, bytes);
    return parsed.ok ? { ok: true, value: { version: 1, resource: parsed.value } } : parsed;
  }
  if (version === 2) {
    const parsed = validateUiResourceV2(value, context, bytes);
    return parsed.ok ? { ok: true, value: { version: 2, resource: parsed.value } } : parsed;
  }
  return uiFailure("version");
}
