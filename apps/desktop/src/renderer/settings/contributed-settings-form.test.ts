import { expect, it, vi } from "vitest";
import type { SettingsResourceV1 } from "@kobrixa/plugin-protocol";
import type { SettingsFormBinding, BoundSettingsService } from "@kobrixa/plugin-runtime";
import {
  createSettingsFieldMap,
  createContributedSettingsForm,
} from "./contributed-settings-form.js";
const binding: SettingsFormBinding = {
  owner: { sourceKey: "builtin:test.settings", pluginId: "test.settings", uiResourceGeneration: 1 },
  scope: {
    hostEpoch: "00000000-0000-4000-8000-000000000001",
    workbenchInstance: "00000000-0000-4000-8000-000000000002",
  },
  resourceDigest: "a".repeat(64),
};
const resource: SettingsResourceV1 = {
  schemaVersion: 1,
  title: { en: "Settings" },
  fields: [
    {
      key: "connection.mode",
      type: "enum",
      label: { en: "Mode" },
      default: 1,
      options: [
        { value: 1, label: { en: "Number" } },
        { value: "1", label: { en: "String" } },
      ],
    },
  ],
};
it("B2-RF2: dotted keys and mixed enum types round-trip; stale maps cannot submit", () => {
  const map = createSettingsFieldMap(resource);
  expect(map.field("connection.mode")).toBe("field-0");
  expect(map.key("field-0")).toBe("connection.mode");
  expect(map.option("connection.mode", 1)).toBe("option-0");
  expect(map.option("connection.mode", "1")).toBe("option-1");
  expect(map.value("connection.mode", "option-1")).toBe("1");
  expect(() => map.key("connection.mode")).toThrow();
  expect(() => map.value("connection.mode", "option-32")).toThrow();
  expect(() => map.field("unknown")).toThrow();
});
it("B2-12.1-1: 128 fields make eight 16-field pages, with one mounted host form", () => {
  const large: SettingsResourceV1 = {
    ...resource,
    fields: Array.from({ length: 128 }, (_, n) => ({
      key: `field${n}`,
      type: "boolean",
      default: false,
      label: { en: `Field ${n}` },
    })),
  };
  const map = createSettingsFieldMap(large);
  expect(map.field("field127")).toBe("field-127");
  expect(() =>
    createSettingsFieldMap({ ...large, fields: [...large.fields, large.fields[0]!] }),
  ).toThrow();
  const render = vi.fn(),
    dispose = vi.fn();
  const service: BoundSettingsService = {
    open: async () => ({ binding, resource, snapshot }),
    read: async () => ({ ok: true, value: snapshot }),
    update: async () => ({
      ok: false,
      error: { code: "PLUGIN_E_SETTINGS_CONFLICT", message: "Changed." },
    }),
    reset: async () => ({
      ok: false,
      error: { code: "PLUGIN_E_SETTINGS_CONFLICT", message: "Changed." },
    }),
    watch: () => () => {},
    dispose: vi.fn(),
  };
  const form = createContributedSettingsForm(
    { render, dispose, onChange: () => () => {} },
    service,
  );
  const snapshot = {
    schemaVersion: 1,
    revision: null,
    values: [{ key: "connection.mode", value: 1 }],
  };
  form.open(binding, resource, snapshot);
  form.open({ ...binding, resourceDigest: "b".repeat(64) }, resource, snapshot);
  expect(dispose).toHaveBeenCalledWith(binding);
  form.replaceSnapshot(binding, { ...snapshot, revision: `r_${"1".repeat(32)}` });
  expect(render).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(render.mock.calls)).not.toContain("Apply");
});

import type { SettingsControlsPort, SettingsDraftState } from "../plugin-ui/host-ports.js";
it("B1 attach: old bindings cannot submit; invalid scalar drafts stay local; conflict requires retry", async () => {
  const fields: SettingsResourceV1 = {
    ...resource,
    fields: [{ key: "enabled", type: "boolean", label: { en: "Enabled" }, default: true }],
  };
  const snapshot = { schemaVersion: 1, revision: null, values: [{ key: "enabled", value: true }] };
  let change!: Parameters<SettingsControlsPort["onChange"]>[0];
  let state!: SettingsDraftState;
  const controls: SettingsControlsPort = {
    render: (_b, _r, s) => {
      state = s;
    },
    onChange: (listener) => {
      change = listener;
      return () => {};
    },
    dispose: vi.fn(),
  };
  const update = vi.fn<BoundSettingsService["update"]>(async () => ({
    ok: false,
    error: { code: "PLUGIN_E_SETTINGS_CONFLICT", message: "Changed." },
  }));
  const service: BoundSettingsService = {
    open: async () => ({ binding, resource: fields, snapshot }),
    read: async () => ({ ok: true, value: snapshot }),
    update,
    reset: async () => ({
      ok: true,
      value: {
        snapshot,
        receipt: {
          revision: `r_${"1".repeat(32)}`,
          commitId: crypto.randomUUID(),
          durability: "file-sync-only",
        },
      },
    }),
    watch: () => () => {},
    dispose: vi.fn(),
  };
  const form = createContributedSettingsForm(controls, service);
  form.open(binding, fields, snapshot);
  const next = { ...binding, resourceDigest: "b".repeat(64) };
  form.open(next, fields, snapshot);
  change(binding, "enabled", false, "change");
  expect(update).not.toHaveBeenCalled();
  change(next, "enabled", "invalid", "change");
  expect(update).not.toHaveBeenCalled();
  change(next, "enabled", false, "change");
  await vi.waitFor(() => expect(state.errors).toHaveLength(1));
  expect(state.draft).toEqual([{ key: "enabled", value: false }]);
  expect(update).toHaveBeenCalledOnce();
  await form.retry(binding, "enabled");
  expect(update).toHaveBeenCalledOnce();
  await form.retry(next, "enabled");
  expect(update).toHaveBeenCalledTimes(2);
  await form.reload(next);
  expect(state.draft).toEqual(snapshot.values);
});

it("failed watch setup disposes controls and permits another open", () => {
  const snapshot = {
    schemaVersion: 1,
    revision: null,
    values: [{ key: "connection.mode", value: 1 }],
  };
  const service: BoundSettingsService = {
    open: vi.fn(),
    read: vi.fn(async () => ({ ok: true as const, value: snapshot })),
    update: vi.fn(),
    reset: vi.fn(),
    dispose: vi.fn(),
    watch: vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error("Stale settings binding.");
      })
      .mockReturnValue(() => {}),
  };
  const controls = { render: vi.fn(), dispose: vi.fn(), onChange: vi.fn(() => () => {}) };
  const form = createContributedSettingsForm(controls, service);
  expect(() => form.open(binding, resource, snapshot)).toThrow("Stale settings binding.");
  expect(controls.dispose).toHaveBeenCalledWith(binding);
  expect(service.dispose).toHaveBeenCalledWith(binding);
  expect(controls.onChange).not.toHaveBeenCalled();
  form.open(binding, resource, snapshot);
  expect(controls.render).toHaveBeenCalledOnce();
});

it("renderer browser bundle resolves the cross-package T1 validators", async () => {
  const { build } = await import("vite");
  const { fileURLToPath } = await import("node:url");
  const built = await build({
    configFile: false,
    logLevel: "silent",
    build: {
      write: false,
      minify: false,
      lib: {
        entry: fileURLToPath(new URL("./contributed-settings-form.tsx", import.meta.url)),
        formats: ["es"],
      },
    },
  });
  const outputs = Array.isArray(built) ? built : [built];
  const chunks = outputs.flatMap((output) => ("output" in output ? output.output : []));
  expect(chunks.length).toBeGreaterThan(0);
  for (const chunk of chunks) {
    if (chunk.type === "chunk") expect(chunk.imports).toEqual([]);
  }
});
