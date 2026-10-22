// @vitest-environment jsdom
import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { KeyboardSettings } from "../keybindings/keyboard-state.js";
import { DEFAULT_DEVICE_PREFERENCES } from "../../shared/device-preferences.js";
import { DEFAULT_FILE_PREFERENCES, type FilePreferences } from "../../shared/file-preferences.js";
import { defaultSettings, type Settings } from "./settings.js";
import { SettingsPanel, mountContributedSettings170 } from "./settings-panel.js";
import { useFilePreferences } from "./file-settings.js";
vi.mock("../keybindings/shortcuts-panel.js", () => ({ ShortcutsPanel: () => null }));
vi.mock("../updates/updates.js", () => ({ UpdatesPanel: () => null }));
let root: Root, container: HTMLDivElement, values: Settings;
const patch = vi.fn();
const filePatch = vi.fn();
const getFilePreferences = vi.fn();
let fileValues: FilePreferences;
const requestedCategory = { category: "appearance" as const, request: 0 };
let extraProps: Partial<ComponentProps<typeof SettingsPanel>> = {};
function TestPanel() {
  const filePreferences = useFilePreferences();
  return createElement(SettingsPanel, {
    settings: values,
    onChange: (key, value) => {
      values = { ...values, [key]: value };
      render();
    },
    onReset: vi.fn(),
    active: true,
    saveError: false,
    onRetry: vi.fn(),
    keyboard: {} as KeyboardSettings,
    requestedCategory,
    updates: undefined,
    updateBusy: false,
    onInstallUpdate: vi.fn(),
    reducedMotion: false,
    filePreferences,
    ...extraProps,
  });
}
const render = (extra?: typeof extraProps) => {
  if (extra) extraProps = extra;
  root.render(createElement(TestPanel));
};
const click = async (selector: string) => {
  await act(async () => {
    container.querySelector<HTMLButtonElement>(selector)!.click();
  });
};
const search = async (query: string) => {
  await act(async () => {
    const input = container.querySelector<HTMLInputElement>('input[type="search"]')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, query);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
beforeEach(async () => {
  extraProps = {};
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("kobrixa", {
    plugins: {},
    device: {
      getPreferences: vi.fn(async () => ({ ...DEFAULT_DEVICE_PREFERENCES })),
      setPreferences: patch,
    },
    workspace: {
      getPreferences: getFilePreferences,
      setPreferences: filePatch,
    },
  });
  Element.prototype.scrollTo = vi.fn();
  patch
    .mockReset()
    .mockImplementation(async (change) => ({ ...DEFAULT_DEVICE_PREFERENCES, ...change }));
  fileValues = { ...DEFAULT_FILE_PREFERENCES };
  getFilePreferences.mockReset().mockImplementation(async () => ({ ...fileValues }));
  filePatch.mockReset().mockImplementation(async (change) => {
    fileValues = { ...fileValues, ...change };
    return { ...fileValues };
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  values = defaultSettings("en");
  await act(async () => render());
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
it("filters across categories and restores focus when a modified row disappears", async () => {
  await search("word wrap");
  expect(container.querySelectorAll(".setting-entry")).toHaveLength(1);
  await click("#setting-wordWrap");
  await click('input[type="checkbox"]');
  expect(container.querySelector(".setting-footer")!.textContent).toContain("Modified");
  await click('[aria-label="Reset Word wrap"]');
  expect(values.wordWrap).toBe(false);
  expect(container.querySelectorAll(".setting-entry")).toHaveLength(0);
  expect(document.activeElement).toBe(container.querySelector('input[type="search"]'));
});
it("shows disabled dependent settings in search results, with a usable reset", async () => {
  values = { ...values, autoSaveDelay: 5000 };
  await act(async () => render());
  await search("autosavedelay");
  expect(container.querySelector<HTMLButtonElement>("#setting-autoSaveDelay")!.disabled).toBe(true);
  expect(container.textContent).toContain("Select After delay");
  expect(
    container.querySelector<HTMLButtonElement>('[aria-label="Reset Auto save delay"]')!.disabled,
  ).toBe(false);
  await click('[aria-label="Reset Auto save delay"]');
  expect(values.autoSaveDelay).toBe(1000);
});
it("keeps acknowledged device values after a failed save and retries the same patch", async () => {
  await search("device.usbAutoReconnect");
  patch.mockRejectedValueOnce(new Error("disk full"));
  await click("#setting-usbAutoReconnect");
  expect(container.querySelector("#setting-usbAutoReconnect")!.getAttribute("aria-checked")).toBe(
    "true",
  );
  expect(container.querySelector('[role="alert"]')!.textContent).toContain(
    "Existing values remain active",
  );
  await click('[role="alert"] button');
  expect(patch).toHaveBeenLastCalledWith({ usbAutoReconnect: false });
  expect(container.querySelector("#setting-usbAutoReconnect")!.getAttribute("aria-checked")).toBe(
    "false",
  );
});
it("preserves search text while switching languages", async () => {
  await search("USB 重試 interval");
  values = { ...values, locale: "zh-TW" };
  await act(async () => render());
  expect(container.querySelector<HTMLInputElement>('input[type="search"]')!.value).toBe(
    "USB 重試 interval",
  );
  expect(container.querySelectorAll(".setting-entry")).toHaveLength(1);
  expect(container.textContent).toContain("USB 重試間隔");
});
it("shares acknowledged file preferences across categories and resets one modified value", async () => {
  await search("files.externalChangesEnabled");
  expect(getFilePreferences).toHaveBeenCalledOnce();
  await click("#setting-externalChangesEnabled");
  expect(fileValues.externalChangesEnabled).toBe(false);
  expect(container.querySelector(".setting-footer")!.textContent).toContain("Modified");
  await click('input[type="checkbox"]');
  await click('[aria-label="Reset External change detection"]');
  expect(filePatch).toHaveBeenLastCalledWith({ externalChangesEnabled: true });
  expect(fileValues.externalChangesEnabled).toBe(true);
  expect(container.querySelectorAll(".setting-entry")).toHaveLength(0);
  expect(getFilePreferences).toHaveBeenCalledOnce();
});
it("disables detection dependencies and keeps retention available when recording is off", async () => {
  await search("files.");
  expect(container.querySelectorAll('[data-setting-id^="files."]')).toHaveLength(8);
  await click("#setting-externalChangesEnabled");
  expect(
    container.querySelector<HTMLButtonElement>("#setting-externalChangeInterval")!.disabled,
  ).toBe(true);
  expect(
    container.querySelector<HTMLButtonElement>("#setting-externalChangeAutoReload")!.disabled,
  ).toBe(true);
  await click("#setting-localHistoryEnabled");
  for (const key of ["Days", "Versions", "SnapshotMiB", "WorkspaceMiB"])
    expect(
      container.querySelector<HTMLButtonElement>(`#setting-localHistory${key}`)!.disabled,
    ).toBe(false);
  expect(container.textContent).toContain("existing history remains available");
  expect(container.textContent).toContain("does not remove existing larger versions");
});
it("keeps effective file values after failure and retries the exact rejected change", async () => {
  await search("files.localHistoryEnabled");
  filePatch.mockRejectedValueOnce(new Error("disk full"));
  await click("#setting-localHistoryEnabled");
  expect(
    container.querySelector("#setting-localHistoryEnabled")!.getAttribute("aria-checked"),
  ).toBe("true");
  expect(container.querySelector('[data-preferences-error="files"]')!.textContent).toContain(
    "Existing values remain active",
  );
  await click('[data-preferences-error="files"] button');
  expect(filePatch).toHaveBeenLastCalledWith({ localHistoryEnabled: false });
  expect(
    container.querySelector("#setting-localHistoryEnabled")!.getAttribute("aria-checked"),
  ).toBe("false");
  expect(container.querySelector('[data-preferences-error="files"]')).toBeNull();
});
it("does not apply a pending file preference and blocks concurrent changes", async () => {
  await search("files.");
  let complete: (preferences: FilePreferences) => void = () => {};
  filePatch.mockImplementationOnce(
    () =>
      new Promise<FilePreferences>((resolve) => {
        complete = resolve;
      }),
  );
  await click("#setting-externalChangesEnabled");
  expect(
    container.querySelector("#setting-externalChangesEnabled")!.getAttribute("aria-checked"),
  ).toBe("true");
  expect(container.querySelector<HTMLButtonElement>("#setting-localHistoryEnabled")!.disabled).toBe(
    true,
  );
  await click("#setting-localHistoryEnabled");
  expect(filePatch).toHaveBeenCalledOnce();
  await act(async () => complete({ ...fileValues, externalChangesEnabled: false }));
  expect(
    container.querySelector("#setting-externalChangesEnabled")!.getAttribute("aria-checked"),
  ).toBe("false");
  expect(container.querySelector<HTMLButtonElement>("#setting-localHistoryEnabled")!.disabled).toBe(
    false,
  );
});
it("can retry a failed initial file preference load without accepting placeholder controls", async () => {
  await act(async () => root.render(null));
  getFilePreferences.mockRejectedValueOnce(new Error("read failed"));
  await act(async () => render());
  await search("files.localHistoryEnabled");
  expect(container.querySelector<HTMLButtonElement>("#setting-localHistoryEnabled")!.disabled).toBe(
    true,
  );
  expect(container.querySelector('[data-preferences-error="files"]')).not.toBeNull();
  await click('[data-preferences-error="files"] button');
  expect(container.querySelector<HTMLButtonElement>("#setting-localHistoryEnabled")!.disabled).toBe(
    false,
  );
  expect(
    container.querySelector("#setting-localHistoryEnabled")!.getAttribute("aria-checked"),
  ).toBe("true");
});

import type { PluginsApi } from "../../shared/plugins.js";
import type { SettingsControlsPort } from "../plugin-ui/host-ports.js";

it("requests the host import challenge when Settings opens and preserves raw preference values", async () => {
  await act(async () => root.render(null));
  const challenge = {
    nonce: "10000000-0000-4000-8000-000000000002",
    scope: {
      hostEpoch: "10000000-0000-4000-8000-000000000001",
      workbenchInstance: "10000000-0000-4000-8000-000000000003",
    },
    descriptorId: "synthetic.preferences",
    keys: ["fixture.layout"],
  };
  const getItem = vi.spyOn(Storage.prototype, "getItem").mockReturnValue("001");
  const setItem = vi.spyOn(Storage.prototype, "setItem");
  const api = {
    challenge: vi.fn(async () => challenge),
    submit: vi.fn(async () => ({ state: "accepted" as const })),
  };
  Object.assign(window.kobrixa.plugins, { legacyPreferences: api });
  try {
    await act(async () => render({ legacyDescriptorId: "synthetic.preferences" }));
    expect(api.challenge).toHaveBeenCalledExactlyOnceWith("synthetic.preferences");
    expect(api.submit).toHaveBeenCalledExactlyOnceWith({
      nonce: challenge.nonce,
      scope: challenge.scope,
      entries: [{ key: "fixture.layout", raw: "001" }],
    });
    expect(getItem).toHaveBeenCalledWith("fixture.layout");
    expect(setItem).not.toHaveBeenCalled();
  } finally {
    getItem.mockRestore();
    setItem.mockRestore();
  }
});

function mountedSettings170() {
  const binding = {
    owner: {
      sourceKey: "builtin:test.settings",
      pluginId: "test.settings",
      uiResourceGeneration: 1,
    },
    scope: {
      hostEpoch: "00000000-0000-4000-8000-000000000001",
      workbenchInstance: "00000000-0000-4000-8000-000000000002",
    },
    resourceDigest: "a".repeat(64),
  };
  const resource = {
    schemaVersion: 1,
    title: { en: "Settings" },
    fields: [
      {
        key: "device.choice",
        label: { en: "Choice" },
        type: "enum" as const,
        default: 1,
        options: [
          { value: 1, label: { en: "Number" } },
          { value: "1", label: { en: "String" } },
        ],
      },
    ],
  };
  const snapshot = {
    schemaVersion: 1,
    revision: null,
    values: [{ key: "device.choice", value: 1 }],
  };
  const changed = new Set<() => void>();
  const failure = vi.fn();
  const api: PluginsApi["settings"] = {
    open: vi.fn(async () => ({ binding, resource, snapshot })),
    read: vi.fn<PluginsApi["settings"]["read"]>(async () => ({ ok: true, value: snapshot })),
    update: vi.fn<PluginsApi["settings"]["update"]>(async () => ({
      ok: false,
      error: { code: "PLUGIN_E_SETTINGS_CONFLICT", message: "Conflict" },
    })),
    reset: vi.fn<PluginsApi["settings"]["reset"]>(async () => ({
      ok: false,
      error: { code: "PLUGIN_E_SETTINGS_CONFLICT", message: "Conflict" },
    })),
    watch: vi.fn((_binding, listener) => {
      changed.add(listener);
      return () => changed.delete(listener);
    }),
    dispose: vi.fn(),
  };
  const controls: SettingsControlsPort = {
    render: vi.fn(),
    onChange: vi.fn(() => () => {}),
    dispose: vi.fn(),
  };
  return {
    binding,
    resource,
    snapshot,
    api,
    controls,
    changed,
    failure,
    mount: () =>
      mountContributedSettings170({
        api,
        controls,
        failure,
        sourceKey: binding.owner.sourceKey,
        resourceDigest: binding.resourceDigest,
      }),
  };
}
it("mount opens once, reads after watch, and removes watch/form/binding on cleanup", async () => {
  const f = mountedSettings170();
  const dispose = f.mount();
  await Promise.resolve();
  await Promise.resolve();
  expect(f.api.open).toHaveBeenCalledOnce();
  expect(f.changed.size).toBe(1);
  expect(f.api.read).toHaveBeenCalledOnce();
  for (const changed of f.changed) changed();
  await Promise.resolve();
  expect(f.api.read).toHaveBeenCalledTimes(2);
  dispose();
  dispose();
  expect(f.changed.size).toBe(0);
  expect(f.controls.dispose).toHaveBeenCalled();
  expect(f.api.dispose).toHaveBeenCalledOnce();
});
it("late open is disposed and late reads cannot redraw a retired form", async () => {
  const f = mountedSettings170();
  let release!: (value: Awaited<ReturnType<typeof f.api.open>>) => void;
  vi.mocked(f.api.open).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const dispose = f.mount();
  dispose();
  release({ binding: f.binding, resource: f.resource, snapshot: f.snapshot });
  await Promise.resolve();
  expect(f.api.dispose).toHaveBeenCalledOnce();
  expect(f.api.watch).not.toHaveBeenCalled();
  const g = mountedSettings170();
  let read!: (value: Awaited<ReturnType<typeof g.api.read>>) => void;
  vi.mocked(g.api.read).mockImplementation(
    () =>
      new Promise((resolve) => {
        read = resolve;
      }),
  );
  const close = g.mount();
  await vi.waitFor(() => expect(g.api.read).toHaveBeenCalledOnce());
  close();
  const calls = vi.mocked(g.controls.render).mock.calls.length;
  read({ ok: true, value: { ...g.snapshot, values: [{ key: "device.choice", value: "1" }] } });
  await Promise.resolve();
  expect(g.controls.render).toHaveBeenCalledTimes(calls);
});
it("stale digest rejection is visible without mounting controls or activating a process", async () => {
  const f = mountedSettings170();
  vi.mocked(f.api.open).mockRejectedValue(new Error("Stale digest"));
  const dispose = f.mount();
  await Promise.resolve();
  await Promise.resolve();
  expect(f.failure).toHaveBeenCalledOnce();
  expect(f.controls.render).not.toHaveBeenCalled();
  dispose();
});

import { SettingsControls } from "../plugin-ui/forms.js";
import type { SettingsSnapshot } from "@kobrixa/plugin-protocol";
it("ignores superseded reads and disposes once after watch setup fails", async () => {
  const f = mountedSettings170();
  const reads: Array<(value: Awaited<ReturnType<typeof f.api.read>>) => void> = [];
  vi.mocked(f.api.read).mockImplementation(() => new Promise((resolve) => reads.push(resolve)));
  const dispose = f.mount();
  await vi.waitFor(() => expect(reads).toHaveLength(1));
  for (const changed of f.changed) changed();
  await vi.waitFor(() => expect(reads).toHaveLength(2));
  reads[1]!({ ok: true, value: { ...f.snapshot, revision: "r_" + "2".repeat(32) } });
  await vi.waitFor(() =>
    expect(f.controls.render).toHaveBeenLastCalledWith(
      f.binding,
      f.resource,
      expect.objectContaining({
        baseline: expect.objectContaining({ revision: "r_" + "2".repeat(32) }),
      }),
    ),
  );
  const calls = vi.mocked(f.controls.render).mock.calls.length;
  reads[0]!({ ok: true, value: f.snapshot });
  await Promise.resolve();
  expect(f.controls.render).toHaveBeenCalledTimes(calls);
  dispose();
  expect(f.api.dispose).toHaveBeenCalledOnce();
  const g = mountedSettings170();
  vi.mocked(g.api.watch).mockImplementation(() => {
    throw new Error("Retired binding");
  });
  const close = g.mount();
  await vi.waitFor(() => expect(g.failure).toHaveBeenCalledOnce());
  close();
  expect(g.api.dispose).toHaveBeenCalledOnce();
});

it("an initial read cannot overwrite a later acknowledged edit", async () => {
  const f = mountedSettings170();
  const controls = new SettingsControls();
  let release!: (value: Awaited<ReturnType<typeof f.api.read>>) => void;
  let saved: SettingsSnapshot = f.snapshot;
  vi.mocked(f.api.read)
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    )
    .mockImplementation(async () => ({ ok: true, value: saved }));
  vi.mocked(f.api.update).mockImplementation(async (_binding, params) => {
    saved = { schemaVersion: 1, revision: "r_" + "8".repeat(32), values: params.changes };
    return {
      ok: true,
      value: {
        snapshot: saved,
        receipt: {
          revision: saved.revision!,
          commitId: "00000000-0000-4000-8000-000000000009",
          durability: "file-and-directory-sync",
        },
      },
    };
  });
  const dispose = mountContributedSettings170({
    api: f.api,
    controls,
    failure: f.failure,
    sourceKey: f.binding.owner.sourceKey,
    resourceDigest: f.binding.resourceDigest,
  });
  try {
    await vi.waitFor(() => expect(f.api.read).toHaveBeenCalledOnce());
    controls.commit("device.choice", "change", "1");
    await vi.waitFor(() =>
      expect(controls.getSnapshot()!.state.baseline.revision).toBe(saved.revision),
    );
    release({ ok: true, value: f.snapshot });
    await Promise.resolve();
    expect(controls.getSnapshot()!.state.draft).toEqual([{ key: "device.choice", value: "1" }]);
    expect(controls.getSnapshot()!.state.baseline.revision).toBe("r_" + "8".repeat(32));
  } finally {
    dispose();
    controls.destroy();
  }
});
it("mounted typed choice keeps the conflicting dotted-key draft until explicit retry or reload", async () => {
  const f = mountedSettings170();
  const controls = new SettingsControls();
  let saved: SettingsSnapshot = { ...f.snapshot, revision: "r_" + "1".repeat(32) };
  let conflict = true;
  vi.mocked(f.api.open).mockResolvedValue({
    binding: f.binding,
    resource: f.resource,
    snapshot: saved,
  });
  vi.mocked(f.api.read).mockImplementation(async () => ({
    ok: true,
    value: structuredClone(saved),
  }));
  vi.mocked(f.api.update).mockImplementation(async (_binding, params) => {
    if (conflict || params.expectedRevision !== saved.revision)
      return { ok: false, error: { code: "PLUGIN_E_SETTINGS_CONFLICT", message: "Conflict" } };
    saved = { schemaVersion: 1, revision: "r_" + "3".repeat(32), values: params.changes };
    return {
      ok: true,
      value: {
        snapshot: saved,
        receipt: {
          revision: saved.revision!,
          commitId: "00000000-0000-4000-8000-000000000009",
          durability: "file-and-directory-sync",
        },
      },
    };
  });
  const dispose = mountContributedSettings170({
    api: f.api,
    controls,
    failure: f.failure,
    sourceKey: f.binding.owner.sourceKey,
    resourceDigest: f.binding.resourceDigest,
  });
  try {
    await vi.waitFor(() => expect(controls.getSnapshot()).not.toBeNull());
    controls.commit("device.choice", "change", "1");
    await vi.waitFor(() => expect(controls.getSnapshot()!.state.errors.length).toBeGreaterThan(0));
    saved = { ...saved, revision: "r_" + "2".repeat(32) };
    for (const changed of f.changed) changed();
    await vi.waitFor(() =>
      expect(controls.getSnapshot()!.state.baseline.revision).toBe(saved.revision),
    );
    expect(controls.getSnapshot()!.state.draft).toEqual([{ key: "device.choice", value: "1" }]);
    expect(f.api.update).toHaveBeenCalledTimes(1);
    conflict = false;
    await controls.retry("device.choice");
    await vi.waitFor(() => expect(saved.values).toEqual([{ key: "device.choice", value: "1" }]));
    expect(f.api.update).toHaveBeenLastCalledWith(
      f.binding,
      expect.objectContaining({
        expectedRevision: "r_" + "2".repeat(32),
        changes: [{ key: "device.choice", value: "1" }],
      }),
    );
    saved = {
      ...saved,
      revision: "r_" + "4".repeat(32),
      values: [{ key: "device.choice", value: 1 }],
    };
    await controls.reload();
    expect(controls.getSnapshot()!.state.draft).toEqual([{ key: "device.choice", value: 1 }]);
  } finally {
    dispose();
    controls.destroy();
  }
});
