import {
  uiResourceV1Schema,
  valueSpecSchema,
  type PanelResourceV1,
  type StatusResourceV1,
  type Scalar,
  type ValueSpec,
  type ValueRef,
  type Condition,
  type Text,
  type DisplayValue,
} from "./ui-resource.js";
import {
  commandInvocationSchema,
  commandValueSchema,
  type ContextCommandDeclaration,
  type PanelDeclaration,
  type Result,
  type UiDetail,
  type CommandInvocation,
  type CommandValue,
} from "./ui-types.js";
import { UI_LIMITS_V1 as L } from "./ui-limits.js";
export type UiValidationContext = {
  pluginId: string;
  commands: readonly ContextCommandDeclaration[];
  panels: readonly PanelDeclaration[];
};
type Resource = PanelResourceV1 | StatusResourceV1;
const own = (value: object, key: string) => Object.hasOwn(value, key);
export const uiBytes = (value: unknown): number =>
  new TextEncoder().encode(JSON.stringify(value)).length;
export function uiFailure<T>(
  reason: UiDetail["reason"],
  fieldPath?: string,
  limit?: keyof typeof L,
  actual?: number,
): Result<T> {
  return {
    ok: false,
    error: {
      code:
        reason === "version" || reason === "negotiation"
          ? "PLUGIN_E_UI_VERSION"
          : "PLUGIN_E_UI_RESOURCE",
      message: "UI validation failed.",
      detail: {
        kind: "ui",
        reason,
        ...(fieldPath === undefined ? {} : { fieldPath }),
        ...(limit === undefined ? {} : { limit, allowed: L[limit] }),
        ...(actual === undefined ? {} : { actual }),
      },
    },
  };
}
export function resourceFailure<T>(
  reason: "stale" | "quota" | "rate" | "queue",
  limit?: number,
): Result<T> {
  return {
    ok: false,
    error: {
      code: reason === "stale" ? "PLUGIN_E_STALE_RESOURCE" : "PLUGIN_E_RESOURCE_LIMIT",
      message:
        reason === "stale" ? "UI binding is no longer current." : "UI resource limit reached.",
      detail: {
        kind: "resource",
        reason,
        resource: "ui-binding",
        ...(limit === undefined ? {} : { limit }),
      },
    },
  };
}
export function validString(
  value: string,
  max: number,
  multiline = true,
  nonempty = false,
): boolean {
  if ((nonempty && value.trim().length === 0) || [...value].length > max) return false;
  for (const character of value) {
    const cp = character.codePointAt(0)!;
    if (cp >= 0xd800 && cp <= 0xdfff) return false;
    if (cp === 127 || (cp < 32 && !(multiline && (cp === 9 || cp === 10)))) return false;
  }
  return true;
}
function keyValid(key: string): boolean {
  return (
    /^[a-z][a-z0-9-]{0,31}$/.test(key) && !["__proto__", "constructor", "prototype"].includes(key)
  );
}
function hasForbiddenKey(value: unknown): boolean {
  // Zod record parsing can omit __proto__. Inspect the original JSON before
  // parsing, including nested records, so an invalid key cannot become valid.
  const pending: unknown[] = [value];
  const seen = new WeakSet<object>();
  while (pending.length > 0) {
    const item = pending.pop();
    if (item === null || typeof item !== "object" || seen.has(item)) continue;
    seen.add(item);
    for (const [key, child] of Object.entries(item)) {
      if (key === "__proto__" || key === "constructor" || key === "prototype") return true;
      if (child !== null && typeof child === "object") pending.push(child);
    }
  }
  return false;
}
export function validValueSpec(spec: ValueSpec): boolean {
  if (!valueSpecSchema.safeParse(spec).success) return false;
  if (spec.type === "number")
    return (
      spec.min <= spec.max &&
      (!spec.integer || (Number.isSafeInteger(spec.min) && Number.isSafeInteger(spec.max)))
    );
  if (spec.type === "enum")
    return (
      new Set(spec.values).size === spec.values.length &&
      spec.values.every((v) => validString(v, 128, false, true))
    );
  return true;
}
export function acceptsValue(spec: ValueSpec, value: Scalar): boolean {
  if (value === null) return spec.nullable;
  switch (spec.type) {
    case "string":
      return typeof value === "string" && validString(value, spec.maxLength);
    case "number":
      return (
        typeof value === "number" &&
        Number.isFinite(value) &&
        value >= spec.min &&
        value <= spec.max &&
        (!spec.integer || Number.isSafeInteger(value))
      );
    case "boolean":
      return typeof value === "boolean";
    case "enum":
      return typeof value === "string" && spec.values.includes(value);
  }
}
export function evaluateCondition(
  condition: Condition,
  data: Readonly<Record<string, Scalar>>,
  form: Readonly<Record<string, Scalar>>,
): boolean {
  if (condition.op === "not") return !evaluateCondition(condition.item, data, form);
  if (condition.op === "all") return condition.items.every((c) => evaluateCondition(c, data, form));
  if (condition.op === "any") return condition.items.some((c) => evaluateCondition(c, data, form));
  if (!("left" in condition)) return false;
  const values = condition.left.scope === "data" ? data : form;
  const value = own(values, condition.left.key) ? values[condition.left.key] : null;
  if (condition.op === "eq") return value === condition.right;
  if (condition.op === "ne") return value !== condition.right;
  if (typeof value !== "number" || typeof condition.right !== "number") return false;
  switch (condition.op) {
    case "lt":
      return value < condition.right;
    case "lte":
      return value <= condition.right;
    case "gt":
      return value > condition.right;
    case "gte":
      return value >= condition.right;
  }
}
function compatible(source: ValueSpec, target: ValueSpec): boolean {
  if (source.nullable && !target.nullable) return false;
  if (source.type === "enum" && target.type === "string")
    return source.values.every((value) => [...value].length <= target.maxLength);
  if (source.type !== target.type) return false;
  if (source.type === "string" && target.type === "string")
    return source.maxLength <= target.maxLength;
  if (source.type === "number" && target.type === "number")
    return (
      source.min >= target.min && source.max <= target.max && (!target.integer || source.integer)
    );
  if (source.type === "enum" && target.type === "enum")
    return source.values.every((value) => target.values.includes(value));
  return true;
}
class Invalid extends Error {
  constructor(
    readonly reason: UiDetail["reason"],
    readonly path: string,
  ) {
    super("Invalid UI resource.");
  }
}
export function validateUiResource(
  value: unknown,
  context: UiValidationContext,
  rawBytes: number,
  version: number = 1,
): Result<Resource> {
  if (version !== 1) return uiFailure("version");
  if (!Number.isSafeInteger(rawBytes) || rawBytes < 0 || rawBytes > L.resourceBytes)
    return uiFailure(
      "limit",
      "$",
      "resourceBytes",
      Number.isSafeInteger(rawBytes) && rawBytes >= 0 ? rawBytes : undefined,
    );
  if (hasForbiddenKey(value)) return uiFailure("schema", "$");
  const parsed = uiResourceV1Schema.safeParse(value);
  if (!parsed.success) {
    // Classify structural failures without relaxing the resource grammar.
    const classify = (item: unknown): "translation" | "limit" | undefined => {
      if (!item || typeof item !== "object") return undefined;
      if (Array.isArray(item)) {
        for (const child of item) {
          const reason = classify(child);
          if (reason) return reason;
        }
        return undefined;
      }
      const record = item as Record<string, unknown>;
      if (Array.isArray(record.nodes) && record.nodes.length > L.nodes) return "limit";
      for (const [key, child] of Object.entries(record)) {
        if (
          ["text", "label", "help", "unit", "placeholder"].includes(key) &&
          child &&
          typeof child === "object" &&
          !Array.isArray(child) &&
          !("ref" in child) &&
          !("text" in child) &&
          !("en" in child)
        )
          return "translation";
        const reason = classify(child);
        if (reason) return reason;
      }
      return undefined;
    };
    return uiFailure(classify(value) ?? "schema", "$");
  }
  const resource = parsed.data;
  try {
    const fail = (reason: UiDetail["reason"], path: string): never => {
      throw new Invalid(reason, path);
    };
    const text = (v: Text, label: boolean, path: string) => {
      for (const s of Object.values(v)) {
        if ([...s].length > (label ? 200 : 4000)) fail("limit", path);
        if (!validString(s, label ? 200 : 4000, !label, true)) fail("translation", path);
      }
    };
    const fields = resource.kind === "panel" ? resource.fields : {};
    if (Object.keys(resource.data).length > 64 || Object.keys(fields).length > 32)
      fail("limit", "$");
    for (const [kind, record] of [
      ["data", resource.data],
      ["fields", fields],
    ] as const) {
      for (const [key, slot] of Object.entries(record)) {
        if (
          !keyValid(key) ||
          !validValueSpec(slot.schema) ||
          !acceptsValue(slot.schema, slot.initial)
        )
          fail("schema", `$.${kind}.${key}`);
      }
    }
    const ref = (r: ValueRef): ValueSpec => {
      const record = r.scope === "data" ? resource.data : fields;
      if (!own(record, r.key)) return fail("reference", "$.ref");
      return record[r.key]!.schema;
    };
    let totalConditions = 0;
    const condition = (c: Condition) => {
      let size = 0;
      const walk = (v: Condition, depth: number): void => {
        if (++size > 32 || ++totalConditions > 256 || depth > 4) fail("limit", "$.condition");
        if (v.op === "not") return walk(v.item, depth + 1);
        if (v.op === "all" || v.op === "any") {
          v.items.forEach((item) => walk(item, depth + 1));
          return;
        }
        if (!("left" in v)) return;
        const s = ref(v.left);
        if (v.op === "eq" || v.op === "ne") {
          const expected = s.type === "enum" ? "string" : s.type;
          const compatible =
            v.right === null
              ? s.nullable
              : typeof v.right === expected &&
                (typeof v.right !== "string" || validString(v.right, 4000));
          if (!compatible) fail("reference", "$.condition.right");
        } else if (s.type !== "number") fail("reference", "$.condition.left");
      };
      walk(c, 1);
    };
    const display = (d: DisplayValue) => {
      if ("ref" in d) ref(d.ref);
    };
    const displayText = (d: { text: Text } | { ref: { scope: "data"; key: string } }) => {
      if ("text" in d) text(d.text, false, "$.text");
      else if (ref(d.ref).type !== "string") fail("reference", "$.text.ref");
    };
    const command = (id: string, bindings: Record<string, DisplayValue>) => {
      const target = context.commands.find((c) => c.id === id);
      if (!id.startsWith(`${context.pluginId}.`) || !target) return fail("reference", "$.command");
      const keys = Object.keys(bindings);
      if (
        keys.length > 32 ||
        keys.length !== Object.keys(target.arguments).length ||
        uiBytes(bindings) > L.argumentBytes
      )
        fail("limit", "$.arguments");
      for (const key of keys) {
        if (!keyValid(key) || !own(target.arguments, key)) fail("reference", "$.arguments");
        const binding = bindings[key]!;
        const expected = target.arguments[key]!;
        if (
          "literal" in binding
            ? !acceptsValue(expected, binding.literal)
            : !compatible(ref(binding.ref), expected)
        )
          fail("reference", "$.arguments");
      }
    };
    if (resource.kind === "status") {
      displayText(resource.text);
      if (resource.visibleWhen) condition(resource.visibleWhen);
    } else {
      const nodes = new Map(resource.nodes.map((n) => [n.id, n]));
      if (nodes.size !== resource.nodes.length || nodes.get(resource.root)?.type !== "group")
        fail("reference", "$.nodes");
      const seen = new Set<string>();
      const walk = (id: string, depth: number) => {
        if (depth > 8) fail("limit", "$.nodes");
        if (seen.has(id)) fail("cycle", "$.nodes");
        const n = nodes.get(id);
        if (!n) return fail("reference", "$.children");
        seen.add(id);
        if (n.type === "group") n.children.forEach((child) => walk(child, depth + 1));
      };
      walk(resource.root, 1);
      if (seen.size !== nodes.size) fail("reference", "$.nodes");
      const used = new Set<string>();
      for (const n of resource.nodes) {
        if (!keyValid(n.id)) fail("schema", "$.nodes.id");
        if (n.visibleWhen) condition(n.visibleWhen);
        if (n.enabledWhen) condition(n.enabledWhen);
        if ("label" in n && n.label) text(n.label, true, "$.nodes.label");
        if ("help" in n && n.help) text(n.help, false, "$.nodes.help");
        if ("unit" in n && n.unit) text(n.unit, true, "$.nodes.unit");
        if (n.type === "textInput" && n.placeholder)
          text(n.placeholder, true, "$.nodes.placeholder");
        if ("field" in n) {
          if (!own(fields, n.field) || used.has(n.field)) fail("reference", "$.nodes.field");
          used.add(n.field);
          const f = fields[n.field]!;
          const s = f.schema;
          const type =
            n.type === "textInput"
              ? "string"
              : n.type === "choice"
                ? "enum"
                : n.type === "boolean"
                  ? "boolean"
                  : "number";
          if (s.type !== type) fail("reference", "$.nodes.field");
          if (
            n.type === "textInput" &&
            typeof f.initial === "string" &&
            !validString(f.initial, 4000, false)
          )
            fail("schema", "$.fields.initial");
          if ((n.type === "number" || n.type === "range") && s.type === "number") {
            if (s.integer && !Number.isSafeInteger(n.step)) fail("schema", "$.nodes.step");
            if (n.type === "range" && typeof f.initial === "number") {
              const q = (f.initial - s.min) / n.step;
              if (Math.abs(q - Math.round(q)) > 1e-9 * Math.max(1, Math.abs(q)))
                fail("schema", "$.fields.initial");
            }
          }
          if (n.type === "choice" && s.type === "enum") {
            const options = n.options.map((o) => o.value);
            if (
              new Set(options).size !== options.length ||
              options.length !== s.values.length ||
              options.some((v) => !s.values.includes(v)) ||
              (n.presentation === "segmented" && options.length > 8)
            )
              fail("reference", "$.nodes.options");
            n.options.forEach((o) => text(o.label, true, "$.nodes.options.label"));
          }
        }
        if (n.type === "text" || n.type === "help") displayText(n.value);
        if (n.type === "status" || n.type === "alert") displayText(n.text);
        if (n.type === "progress") {
          display(n.value);
          if ("ref" in n.value) {
            if (ref(n.value.ref).type !== "number") fail("reference", "$.nodes.value");
            const values = n.value.ref.scope === "data" ? resource.data : fields;
            const initial = values[n.value.ref.key]!.initial;
            if (initial !== null && (typeof initial !== "number" || initial < 0 || initial > n.max))
              fail("reference", "$.nodes.value");
          }
          if (
            "literal" in n.value &&
            n.value.literal !== null &&
            (typeof n.value.literal !== "number" || n.value.literal < 0 || n.value.literal > n.max)
          )
            fail("schema", "$.nodes.value");
        }
        if (n.type === "keyValue") {
          if (new Set(n.rows.map((r) => r.id)).size !== n.rows.length)
            fail("schema", "$.nodes.rows");
          n.rows.forEach((r) => {
            if (!keyValid(r.id)) fail("schema", "$.nodes.rows.id");
            text(r.label, true, "$.nodes.rows.label");
            if (r.unit) text(r.unit, true, "$.nodes.rows.unit");
            display(r.value);
          });
        }
        if (n.type === "holdAction") command(n.command, n.arguments);
        if (n.type === "action") {
          const a = n.action;
          if (a.kind === "command") command(a.command, a.arguments);
          else if (a.action === "openPanel") {
            if (
              !a.panelId.startsWith(`${context.pluginId}.`) ||
              !context.panels.some((p) => p.id === a.panelId)
            )
              fail("reference", "$.action.panelId");
          } else if (a.action === "stop" || a.action === "disconnect") {
            const s = ref(a.action === "stop" ? a.operation : a.session);
            if (s.type !== "string" || !s.nullable) fail("reference", "$.action.ref");
          }
        }
      }
      if (used.size !== Object.keys(fields).length) fail("reference", "$.fields");
      for (const field of Object.values(fields))
        if (field.requiredWhen) condition(field.requiredWhen);
      if (
        uiBytes(Object.fromEntries(Object.entries(fields).map(([k, f]) => [k, f.initial]))) >
        L.formBytes
      )
        fail("limit", "$.fields");
    }
    const initial = Object.fromEntries(
      Object.entries(resource.data).map(([key, slot]) => [key, slot.initial]),
    );
    const checked = validateUiData(resource, initial);
    if (!checked.ok) return checked;
    return { ok: true, value: resource };
  } catch (error) {
    if (error instanceof Invalid) return uiFailure(error.reason, error.path);
    throw error;
  }
}
export function validateUiData(
  resource: Resource,
  data: Record<string, Scalar>,
): Result<Record<string, Scalar>> {
  const keys = Object.keys(data);
  if (
    keys.length !== Object.keys(resource.data).length ||
    keys.some(
      (key) => !own(resource.data, key) || !acceptsValue(resource.data[key]!.schema, data[key]!),
    )
  )
    return uiFailure("schema", "$.data");
  const limit = resource.kind === "status" ? "statusDataBytes" : "dataBytes";
  if (uiBytes(data) > L[limit]) return uiFailure("limit", "$.data", limit, uiBytes(data));
  if (resource.kind === "panel")
    for (const node of resource.nodes) {
      if (node.type === "progress" && "ref" in node.value && node.value.ref.scope === "data") {
        const value = data[node.value.ref.key];
        if (value !== null && (typeof value !== "number" || value < 0 || value > node.max))
          return uiFailure("reference", "$.data");
      }
    }
  return { ok: true, value: structuredClone(data) };
}
export function validateCommandInvocation(value: unknown): Result<CommandInvocation> {
  if (hasForbiddenKey(value)) return uiFailure("schema", "$.invocation");
  const parsed = commandInvocationSchema.safeParse(value);
  if (!parsed.success) return uiFailure("schema", "$.invocation");
  const invocation = parsed.data;
  const c = invocation.context;
  if (
    uiBytes(invocation) > L.invokeBytes ||
    uiBytes(invocation.arguments) > L.argumentBytes ||
    Object.keys(invocation.arguments).length > 32
  )
    return uiFailure("limit", "$.arguments");
  if (!Object.keys(invocation.arguments).every(keyValid)) return uiFailure("schema", "$.arguments");
  if (
    c.origin === "management" &&
    (c.binding !== undefined ||
      c.form !== undefined ||
      c.motionScopeRef !== undefined ||
      c.trigger.kind !== "activate" ||
      Object.keys(invocation.arguments).length !== 0)
  )
    return uiFailure("reference", "$.context");
  if (c.origin === "panel" && (!c.binding || !c.form)) return uiFailure("reference", "$.context");
  if (c.actionRef !== undefined && c.trigger.kind === "hold" && c.trigger.phase !== "begin")
    return uiFailure("reference", "$.context.actionRef");
  if (
    c.form &&
    (uiBytes(c.form) > L.formBytes ||
      Object.keys(c.form.values).length > 32 ||
      !Object.keys(c.form.values).every(keyValid))
  )
    return uiFailure("limit", "$.context.form");
  const scalars = [...Object.values(invocation.arguments), ...Object.values(c.form?.values ?? {})];
  if (scalars.some((v) => typeof v === "string" && !validString(v, 4000)))
    return uiFailure("schema", "$.invocation");
  return { ok: true, value: invocation };
}
export function validateCommandValue(
  value: unknown,
  invocation: CommandInvocation,
): Result<CommandValue> {
  if (hasForbiddenKey(value)) return uiFailure("schema", "$.result");
  const parsed = commandValueSchema.safeParse(value);
  if (!parsed.success) return uiFailure("schema", "$.result");
  const result = parsed.data;
  if (
    uiBytes(result) > L.resultBytes ||
    Object.keys(result.output).length > 32 ||
    !Object.keys(result.output).every(keyValid)
  )
    return uiFailure("limit", "$.result");
  const fields = new Set<string>();
  for (const error of result.fieldErrors) {
    if (
      !invocation.context.form ||
      !own(invocation.context.form.values, error.field) ||
      fields.has(error.field) ||
      Object.values(error.message).some((s) => !validString(s, 4000, true, true))
    )
      return uiFailure("reference", "$.fieldErrors");
    fields.add(error.field);
  }
  if (Object.values(result.output).some((v) => typeof v === "string" && !validString(v, 4000)))
    return uiFailure("schema", "$.output");
  return { ok: true, value: result };
}

export function validUiWire(
  method: string,
  phase: "params" | "result",
  value: unknown,
  params?: unknown,
): boolean {
  const methods = new Set([
    "ui/negotiate",
    "ui/ready",
    "ui/instances",
    "ui/state",
    "ui/patch",
    "ui/subscribe",
    "ui/snapshot",
    "command/invoke",
  ]);
  if (!methods.has(method)) return true;
  try {
    if (hasForbiddenKey(value)) return false;
    const item = value as Record<string, unknown>;
    if (phase === "params") {
      if (method === "command/invoke") return validateCommandInvocation(value).ok;
      if (method === "ui/patch") {
        const set = item.set as Record<string, Scalar>;
        return (
          uiBytes(item) <= L.patchBytes &&
          Object.keys(set).length >= 1 &&
          Object.keys(set).length <= 64 &&
          Object.keys(set).every(keyValid) &&
          Object.values(set).every((v) => typeof v !== "string" || validString(v, 4000))
        );
      }
      if (method === "ui/subscribe") {
        const topics = item.topics as string[];
        return (
          new Set(topics).size === topics.length &&
          (item.binding !== undefined ||
            topics.every((t) => t === "instances" || t === "environment"))
        );
      }
      return true;
    }
    if (item.ok === false) {
      const error = item.error as { message: string; detail?: unknown };
      return (
        validString(error.message, 2000) &&
        (error.detail === undefined || uiBytes(error.detail) <= L.detailBytes)
      );
    }
    if (method === "command/invoke") {
      const invocation = validateCommandInvocation(params);
      return invocation.ok && validateCommandValue(item.value, invocation.value).ok;
    }
    const result = item.value as Record<string, unknown>;
    const snapshot =
      method === "ui/state"
        ? result
        : method === "ui/subscribe" || method === "ui/snapshot"
          ? (result.snapshot as Record<string, unknown>)
          : undefined;
    const stateValid = (state: Record<string, unknown>) => {
      const binding = state.binding as { kind: "panel" | "status" };
      const data = state.data as Record<string, Scalar>;
      const form = state.form as Record<string, Scalar>;
      return (
        Object.keys(data).length <= 64 &&
        Object.keys(form).length <= 32 &&
        uiBytes(data) <= (binding.kind === "status" ? L.statusDataBytes : L.dataBytes) &&
        uiBytes(form) <= L.formBytes &&
        [...Object.keys(data), ...Object.keys(form)].every(keyValid) &&
        [...Object.values(data), ...Object.values(form)].every(
          (v) => typeof v !== "string" || validString(v, 4000),
        )
      );
    };
    if (snapshot && method === "ui/state") return stateValid(snapshot);
    if (snapshot) return (snapshot.states as Record<string, unknown>[]).every(stateValid);
    return true;
  } catch {
    return false;
  }
}
