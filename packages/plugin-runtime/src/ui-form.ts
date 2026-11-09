import {
  acceptsValue,
  evaluateCondition,
  uiBytes,
  type UiResourceV2,
  type UiScalar,
  type PanelResourceV1,
} from "@kobrixa/plugin-protocol";
type Panel = PanelResourceV1 | Extract<UiResourceV2, { kind: "panel" }>;
export function synchronizedForm(resource: {
  kind: string;
}): resource is Panel & { formSync: true } {
  return resource.kind === "panel" && "formSync" in resource && resource.formSync === true;
}
export function canonicalForm(resource: Panel, form: Record<string, UiScalar>): boolean {
  const keys = Object.keys(form);
  return (
    keys.length <= 32 &&
    keys.length === Object.keys(resource.fields).length &&
    uiBytes(form) <= 16384 &&
    keys.every(
      (key) =>
        !["constructor", "prototype", "__proto__"].includes(key) &&
        Object.hasOwn(resource.fields, key) &&
        acceptsValue(resource.fields[key]!.schema, form[key]!),
    )
  );
}
export function equalForm(a: Record<string, UiScalar>, b: Record<string, UiScalar>): boolean {
  return (
    Object.keys(a).length === Object.keys(b).length &&
    Object.keys(a).every((key) => Object.hasOwn(b, key) && a[key] === b[key])
  );
}
/** Admit coalesced changes in rounds rooted in the current editable form.
 * Proposed values cannot reveal/enable themselves or an unseeded cycle.
 */
export function editableFormChange(
  resource: Panel,
  data: Record<string, UiScalar>,
  before: Record<string, UiScalar>,
  after: Record<string, UiScalar>,
): boolean {
  const nodes = new Map(resource.nodes.map((n) => [n.id, n]));
  const form = { ...before };
  const pending = new Set(Object.keys(after).filter((key) => before[key] !== after[key]));
  while (pending.size) {
    const editable = new Set<string>();
    const visit = (id: string, parent: boolean) => {
      const node = nodes.get(id);
      if (!node) return;
      const active =
        parent &&
        (!node.visibleWhen || evaluateCondition(node.visibleWhen, data, form)) &&
        (!node.enabledWhen || evaluateCondition(node.enabledWhen, data, form));
      if (active && "field" in node) editable.add(node.field);
      // Dialog controls are intentionally not admitted without a separately current host view.
      if (node.type === "group") node.children.forEach((child) => visit(child, active));
    };
    visit(resource.root, true);
    const admitted = [...pending].filter((key) => editable.has(key));
    if (!admitted.length) return false;
    // Apply a round only after evaluating all conditions against admitted values.
    // Every round removes at least one field, bounded by the canonical form cap.
    for (const key of admitted) {
      form[key] = after[key]!;
      pending.delete(key);
    }
  }
  return true;
}
export function requiredFormValid(
  resource: Panel,
  data: Record<string, UiScalar>,
  form: Record<string, UiScalar>,
): boolean {
  return Object.entries(resource.fields).every(
    ([key, field]) =>
      !(
        field.required ||
        (field.requiredWhen && evaluateCondition(field.requiredWhen, data, form))
      ) ||
      (form[key] !== null && form[key] !== ""),
  );
}
