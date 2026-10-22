import { expectTypeOf, it, vi } from "vitest";
import type { SettingsControlsPort, PluginUiRendererHost } from "./host-ports.js";
import type {
  SettingsScalar,
  UiScalar,
  PanelResourceV1,
  UiBinding,
  UiCatalogEntry,
  UiStateSnapshot,
  UiValidationContext,
} from "@kobrixa/plugin-protocol";
import type { PluginUiBridge, CoreRecoveryPort, UiBridgeEvent } from "@kobrixa/plugin-runtime";
it("separates settings controls from feature command forms (U01)", () => {
  expectTypeOf<SettingsScalar>().toEqualTypeOf<boolean | number | string>();
  expectTypeOf<UiScalar>().toEqualTypeOf<boolean | number | string | null>();
  expectTypeOf<Parameters<SettingsControlsPort["onChange"]>[0]>().toBeFunction();
  expectTypeOf<PluginUiRendererHost["dispose"]>().toEqualTypeOf<() => void>();
});

export const labels = {
  tools: "Plugin tools",
  open: "Open",
  close: "Close",
  empty: "No plugin panels",
  unavailable: "Unavailable",
  loading: "Loading",
  invalid: "Invalid value",
  recovery: "Recovery",
  refresh: "Refresh",
  reset: "Reset",
  previous: "Previous",
  next: "Next",
  retry: "Retry",
  export: "Export",
  discard: "Discard",
  checkpoint: "Checkpoint only",
  holdHint: "Hold to run; release to stop. Maximum 10 seconds.",
  actions: {
    stop: "Stop",
    reconcile: "Reconcile",
    "clear-resolved": "Clear resolved",
    "retry-save": "Retry save",
    manage: "Manage",
  },
};
export const validationContext: UiValidationContext = {
  pluginId: "acme.ui",
  panels: [],
  commands: ["acme.ui.go", "acme.ui.hold"].map((id) => ({
    id,
    title: { en: id },
    invocation: "context-v1" as const,
    arguments: {},
  })),
};
export const handle = (n: number): string =>
  `00000000-0000-4000-8000-${n.toString().padStart(12, "0")}`;
export const binding: UiBinding = {
  contributionId: "acme.ui.panel",
  panelInstance: handle(2),
  kind: "panel",
  uiResourceGeneration: 1,
  generation: 1,
  hostEpoch: handle(1),
  processEpoch: handle(3),
};
export const panel: PanelResourceV1 = {
  kind: "panel",
  data: {
    count: {
      schema: { type: "number", min: 0, max: 100, integer: true, nullable: false },
      initial: 0,
    },
  },
  fields: {
    speed: {
      schema: { type: "number", min: -100, max: 100, integer: false, nullable: false },
      initial: 0,
      required: true,
    },
    enabled: { schema: { type: "boolean", nullable: false }, initial: false, required: true },
  },
  root: "root",
  nodes: [
    { id: "root", type: "group", layout: "stack", children: ["speed", "enabled", "go", "hold"] },
    {
      id: "speed",
      type: "number",
      field: "speed",
      label: { en: "Speed", "zh-TW": "速度" },
      step: 0.1,
    },
    { id: "enabled", type: "boolean", field: "enabled", label: { en: "Enabled" } },
    {
      id: "go",
      type: "action",
      label: { en: "Go" },
      variant: "primary",
      action: { kind: "command", command: "acme.ui.go", arguments: {} },
    },
    {
      id: "hold",
      type: "holdAction",
      label: { en: "Hold" },
      command: "acme.ui.hold",
      arguments: {},
    },
  ],
};
export const entry: UiCatalogEntry = {
  sourceKey: "builtin:acme.ui",
  pluginId: "acme.ui",
  id: binding.contributionId,
  kind: "panel",
  title: { en: "Panel" },
  version: 1,
  resourceDigest: "a".repeat(64),
  resourceBytes: 1000,
  uiResourceGeneration: 1,
  availability: "available",
};
export const snapshot = (revision = 0): UiStateSnapshot => ({
  binding,
  revision,
  data: { count: revision },
  formRevision: 0,
  form: { speed: 0, enabled: false },
  valid: true,
  visible: true,
  locale: "en",
});
export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
export function fixture() {
  const listeners = new Set<(event: UiBridgeEvent) => void>();
  const changed = new Set<() => void>();
  const bridge = {
    catalog: vi.fn<PluginUiBridge["catalog"]>(async () => ({
      ok: true,
      value: { hostEpoch: handle(1), revision: 1, entries: [entry], nextCursor: null },
    })),
    resource: vi.fn<PluginUiBridge["resource"]>(async () => ({
      ok: true,
      value: {
        owner: entry,
        id: entry.id,
        version: 1,
        validationContext,
        rawBytes: new TextEncoder().encode(JSON.stringify(panel)).length,
        resource: panel,
      },
    })),
    open: vi.fn<PluginUiBridge["open"]>(async () => ({ ok: true, value: snapshot() })),
    close: vi.fn<PluginUiBridge["close"]>(async () => ({ ok: true, value: { closed: true } })),
    visibility: vi.fn<PluginUiBridge["visibility"]>(async () => ({
      ok: true,
      value: { accepted: true },
    })),
    invoke: vi.fn<PluginUiBridge["invoke"]>(async () => ({
      ok: true,
      value: { output: {}, fieldErrors: [] },
    })),
    hold: vi.fn<PluginUiBridge["hold"]>(async (input) => ({
      ok: true,
      value: { gesture: input.phase === "begin" ? handle(4) : null },
    })),
    pulse: vi.fn<PluginUiBridge["pulse"]>(async () => ({ ok: true, value: { accepted: true } })),
    snapshot: vi.fn<PluginUiBridge["snapshot"]>(async () => ({ ok: true, value: snapshot(1) })),
    reportFailure: vi.fn<PluginUiBridge["reportFailure"]>(async () => ({
      ok: true,
      value: { accepted: true },
    })),
    onEvent: vi.fn<PluginUiBridge["onEvent"]>((listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }),
  };
  const recovery = {
    snapshot: vi.fn<CoreRecoveryPort["snapshot"]>(async () => ({
      ok: true,
      value: { hostEpoch: handle(1), revision: 1, items: [], nextCursor: null },
    })),
    act: vi.fn<CoreRecoveryPort["act"]>(async () => ({
      ok: true,
      value: { hostEpoch: handle(1), revision: 2, items: [], nextCursor: null },
    })),
    onChanged: vi.fn<CoreRecoveryPort["onChanged"]>((listener) => {
      changed.add(listener);
      return () => {
        changed.delete(listener);
      };
    }),
  };
  return {
    bridge,
    recovery,
    emit: (event: UiBridgeEvent) => listeners.forEach((listener) => listener(event)),
    change: () => changed.forEach((listener) => listener()),
    listeners,
  };
}
