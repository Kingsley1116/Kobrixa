// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { DevicePreferenceCaptureNotice } from "../device/device-panel.js";
import { afterEach, expect, it, vi } from "vitest";
import { fixture, entry, handle, deferred } from "../plugin-ui/contract.test.js";
import { SettingsStore } from "./settings.js";
import { createPluginUiWindow } from "./settings-state.js";
import type {
  LegacyPreferenceChallenge,
  LegacyPreferencesApi,
} from "../../shared/plugin-persistence.js";
const challenge: LegacyPreferenceChallenge = {
  descriptorId: "kobrixa.device-preferences",
  nonce: handle(8),
  scope: { hostEpoch: handle(1), workbenchInstance: handle(2) },
  keys: ["kobrixa.connectionMode", "kobrixa.rememberWifiAddress", "kobrixa.lastWifiAddress"],
};
const owners: ReturnType<typeof createPluginUiWindow>[] = [];
afterEach(() => owners.splice(0).forEach((o) => o.dispose()));
function setup(api: LegacyPreferencesApi) {
  const f = fixture();
  const values = new Map([["kobrixa.connectionMode", '"wifi"']]);
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
  const settings = new SettingsStore(() => storage, "en");
  const owner = createPluginUiWindow({ ...f, settings, storage, legacyPreferences: api });
  owners.push(owner);
  return { ...f, owner, settings, values };
}
it("freezes before startup I/O, captures without opening tools, and keeps unrelated settings writable", async () => {
  const pending = deferred<LegacyPreferenceChallenge>();
  const api = {
    challenge: vi.fn(() => pending.promise),
    submit: vi.fn<LegacyPreferencesApi["submit"]>(async () => ({ state: "accepted" as const })),
  };
  const h = setup(api);
  expect(() => h.settings.set("connectionMode", "usb")).toThrow();
  expect(() => h.settings.set("wordWrap", true)).not.toThrow();
  expect(h.owner.deviceMigration.getSnapshot()).toBe("pending");
  pending.resolve(challenge);
  await h.owner.ready;
  await h.owner.deviceMigration.retry();
  expect(api.challenge).toHaveBeenCalledTimes(1);
  expect(api.submit).toHaveBeenCalledTimes(1);
  expect(api.submit.mock.calls[0]?.[0]).toMatchObject({
    entries: [
      { key: "kobrixa.connectionMode", raw: '"wifi"' },
      { key: "kobrixa.rememberWifiAddress", raw: null },
      { key: "kobrixa.lastWifiAddress", raw: null },
    ],
  });
  expect(h.owner.deviceMigration.getSnapshot()).toBe("captured");
  expect(h.bridge.open).not.toHaveBeenCalled();
});
it("retries rejected admission on a later device catalog publication and never spins on unchanged catalogs", async () => {
  let admitted = false;
  const api = {
    challenge: vi.fn(async () => {
      if (!admitted) throw new Error("disabled");
      return challenge;
    }),
    submit: vi.fn<LegacyPreferencesApi["submit"]>(async () => ({ state: "accepted" as const })),
  };
  const h = setup(api);
  await h.owner.ready;
  await h.owner.deviceMigration.retry();
  expect(h.owner.deviceMigration.getSnapshot()).toBe("pending");
  admitted = true;
  const device = {
    ...entry,
    sourceKey: "builtin:kobrixa.device-ev3",
    pluginId: "kobrixa.device-ev3",
    id: "kobrixa.device-ev3.panel",
  };
  h.bridge.catalog.mockResolvedValue({
    ok: true,
    value: { hostEpoch: handle(1), revision: 2, entries: [device], nextCursor: null },
  });
  h.emit({ type: "catalog", hostEpoch: handle(1), revision: 2, owners: [device] });
  await vi.waitFor(() => expect(h.owner.deviceMigration.getSnapshot()).toBe("captured"));
  const count = api.challenge.mock.calls.length;
  h.emit({ type: "catalog", hostEpoch: handle(1), revision: 2, owners: [device] });
  await h.owner.session.catalog.refresh();
  expect(api.challenge).toHaveBeenCalledTimes(count);
  expect(api.submit).toHaveBeenCalledTimes(1);
});
it("window retirement rejects late capture without notifying or submitting", async () => {
  const pending = deferred<LegacyPreferenceChallenge>();
  const submit = vi.fn(async () => ({ state: "accepted" as const }));
  const h = setup({ challenge: () => pending.promise, submit });
  const notify = vi.fn();
  h.owner.deviceMigration.subscribe(notify);
  await Promise.resolve();
  h.owner.dispose();
  pending.resolve(challenge);
  await h.owner.deviceMigration.retry();
  await Promise.resolve();
  expect(submit).not.toHaveBeenCalled();
  expect(notify).not.toHaveBeenCalled();
});

it("completed-profile challenge rejection keeps a neutral capture check, not a false import failure", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const submit = vi.fn();
  const h = setup({
    challenge: async () => {
      throw new Error("Import already completed");
    },
    submit,
  });
  await h.owner.ready;
  await h.owner.deviceMigration.retry();
  expect(h.owner.deviceMigration.getSnapshot()).toBe("pending");
  const container = document.createElement("div"),
    root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        createElement(DevicePreferenceCaptureNotice, {
          locale: "en",
          retry: () => {
            void h.owner.deviceMigration.retry();
          },
        }),
      ),
    );
    expect(container.textContent).toContain("Completed imports are not repeated");
    expect(container.textContent).not.toMatch(/pending|enable the EV3|failed/i);
    await act(async () => container.querySelector("button")!.click());
    expect(submit).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});
