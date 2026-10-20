import type { Id } from "./ui-types.js";
export type LocalId = string; // ASCII ^[a-z][a-z0-9-]{0,31}$
export type Text = { en: string; "zh-TW"?: string };
export type Scalar = string | number | boolean | null;
export type ValueSpec =
  | { type: "string"; maxLength: number; nullable: boolean }
  | { type: "number"; min: number; max: number; integer: boolean; nullable: boolean }
  | { type: "boolean"; nullable: boolean }
  | { type: "enum"; values: string[]; nullable: boolean };
export type DataSlot = { schema: ValueSpec; initial: Scalar };
export type Field = {
  schema: ValueSpec;
  initial: Scalar;
  required: boolean;
  requiredWhen?: Condition;
};
export type ValueRef = { scope: "data" | "form"; key: LocalId };
export type DisplayValue = { literal: Scalar } | { ref: ValueRef };
export type DisplayText = { text: Text } | { ref: { scope: "data"; key: LocalId } };
export type PanelResourceV1 = {
  kind: "panel";
  data: Record<LocalId, DataSlot>;
  fields: Record<LocalId, Field>;
  root: LocalId;
  nodes: UiNodeV1[];
};
export type StatusResourceV1 = {
  kind: "status";
  text: DisplayText;
  tone: "neutral" | "info" | "success" | "warning" | "error";
  data: Record<LocalId, DataSlot>;
  visibleWhen?: Condition;
};


export type Condition =
  | { op: "eq" | "ne"; left: ValueRef; right: Scalar }
  | { op: "lt" | "lte" | "gt" | "gte"; left: ValueRef; right: number }
  | { op: "all" | "any"; items: Condition[] } // 1–8
  | { op: "not"; item: Condition };
export type ArgumentBindings = Record<LocalId, DisplayValue>;
export type UiAction =
  | { kind: "command"; command: Id; arguments: ArgumentBindings }
  | { kind: "core"; action: "openPanel"; panelId: Id }
  | { kind: "core"; action: "stop"; operation: { scope: "data"; key: LocalId } }
  | { kind: "core"; action: "disconnect"; session: { scope: "data"; key: LocalId } }
  | { kind: "core"; action: "openRecovery" };

export type UiNodeBase = {
  id: LocalId;
  visibleWhen?: Condition;
  enabledWhen?: Condition;
};
export type UiNumberNode = {
  field: LocalId;
  label: Text;
  help?: Text;
  step: number;
  unit?: Text;
};
export type UiNodeV1 = UiNodeBase &
  (
    | { type: "group"; label?: Text; help?: Text; layout: "stack" | "row"; children: LocalId[] }
    | { type: "text"; value: DisplayText; emphasis: "normal" | "strong" }
    | { type: "help"; value: DisplayText }
    | { type: "textInput"; field: LocalId; label: Text; help?: Text; placeholder?: Text }
    | ({ type: "number" } & UiNumberNode)
    | ({ type: "range" } & UiNumberNode)
    | {
        type: "choice";
        field: LocalId;
        label: Text;
        help?: Text;
        presentation: "select" | "segmented";
        options: { value: string; label: Text }[];
      }
    | { type: "boolean"; field: LocalId; label: Text; help?: Text }
    | { type: "action"; label: Text; action: UiAction; variant: "normal" | "primary" | "danger" }
    | { type: "holdAction"; label: Text; command: Id; arguments: ArgumentBindings; help?: Text }
    | {
        type: "status";
        text: DisplayText;
        tone: "neutral" | "info" | "success" | "warning" | "error";
      }
    | { type: "alert"; text: DisplayText; severity: "info" | "warning" | "error" }
    | { type: "progress"; value: DisplayValue; max: number; label: Text }
    | { type: "keyValue"; rows: { id: LocalId; label: Text; value: DisplayValue; unit?: Text }[] }
  );
