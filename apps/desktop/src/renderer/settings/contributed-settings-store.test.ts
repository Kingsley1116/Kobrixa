import { expect, it, vi } from "vitest";
import type { SettingsMutation, SettingsSnapshot } from "@kobrixa/plugin-protocol";
import {
  createContributedSettingsStore,
  type SettingsStoreTransport,
} from "./contributed-settings-store.js";
const initial: SettingsSnapshot = {
  schemaVersion: 1,
  revision: null,
  values: [
    { key: "enabled", value: true },
    { key: "name", value: "old" },
  ],
};
const receipt = (n: number, values = initial.values): SettingsMutation => ({
  snapshot: { ...initial, values, revision: `r_${n.toString().padStart(32, "0")}` },
  receipt: {
    revision: `r_${n.toString().padStart(32, "0")}`,
    commitId: "00000000-0000-4000-8000-000000000001",
    durability: "file-sync-only",
  },
});
it("B2-12.1-1: text waits for blur, unchanged drafts do nothing, queued fields use the last receipt", async () => {
  const sends: Array<{ key: string; expectedRevision: string | null }> = [];
  const store = createContributedSettingsStore(initial, {
    validate: () => true,
    read: async () => initial,
    mutate: async (input) => {
      sends.push(input);
      return {
        ok: true,
        value: receipt(
          sends.length,
          store
            .state()
            .baseline.values.map((x) => (x.key === input.key ? { ...x, value: input.value } : x)),
        ),
      };
    },
  });
  store.edit("name", "new", "change", false);
  expect(sends).toHaveLength(0);
  store.edit("name", "new", "blur", false);
  store.edit("enabled", false, "change", true);
  await store.idle();
  expect(sends).toEqual([
    { key: "name", value: "new", reset: false, expectedRevision: null, schemaVersion: 1 },
    {
      key: "enabled",
      value: false,
      reset: false,
      expectedRevision: receipt(1).receipt.revision,
      schemaVersion: 1,
    },
  ]);
  store.edit("enabled", false, "change", true);
  await store.idle();
  expect(sends).toHaveLength(2);
});
it("B2-RF2: an external revision keeps dirty drafts and requires explicit retry", async () => {
  const mutate = vi.fn<SettingsStoreTransport["mutate"]>(async () => ({
    ok: true,
    value: receipt(3),
  }));
  const store = createContributedSettingsStore(initial, {
    validate: () => true,
    mutate,
    read: async () => receipt(2).snapshot,
  });
  store.edit("name", "draft", "change", false);
  store.external(receipt(2).snapshot);
  expect(store.state().draft.find((x) => x.key === "name")!.value).toBe("draft");
  expect(store.state().errors).toHaveLength(1);
  store.edit("enabled", false, "change", true);
  await store.idle();
  expect(mutate).not.toHaveBeenCalled();
  await store.retry("name");
  expect(mutate).toHaveBeenCalledOnce();
  expect(mutate.mock.calls[0]![0]).toMatchObject({ expectedRevision: receipt(2).receipt.revision });
});
it("B2-10 unknown: pauses the queue, reads evidence, and never auto-resends", async () => {
  const read = vi.fn(async () => receipt(2).snapshot);
  const mutate = vi.fn(async () => ({
    ok: false as const,
    error: {
      code: "PLUGIN_E_SETTINGS_SAVE" as const,
      message: "Unknown",
      detail: {
        kind: "persistence" as const,
        reason: "publish-uncertain" as const,
        disposition: "unknown" as const,
      },
    },
  }));
  const store = createContributedSettingsStore(initial, { validate: () => true, mutate, read });
  store.edit("enabled", false, "change", true);
  store.edit("name", "next", "enter", false);
  await store.idle();
  expect(mutate).toHaveBeenCalledOnce();
  expect(read).toHaveBeenCalledOnce();
  expect(store.state().draft.find((x) => x.key === "name")!.value).toBe("next");
  store.dispose();
  store.external(receipt(4).snapshot);
  expect(store.state().baseline.revision).toBe(receipt(2).receipt.revision);
});
it("B2-12.1-1: coalesces unsent drafts without changing the dispatched payload", async () => {
  let finish!: (result: { ok: true; value: SettingsMutation }) => void;
  const mutate = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    )
    .mockImplementation(async () => ({ ok: true, value: receipt(2) }));
  const store = createContributedSettingsStore(initial, {
    validate: () => true,
    mutate,
    read: async () => initial,
  });
  store.edit("name", "one", "enter", false);
  store.edit("name", "two", "enter", false);
  store.edit("name", "three", "enter", false);
  expect(mutate.mock.calls[0]![0].value).toBe("one");
  finish({ ok: true, value: receipt(1) });
  await store.idle();
  expect(mutate).toHaveBeenCalledTimes(2);
  expect(mutate.mock.calls[1]![0].value).toBe("three");
});
it("B2-RF2: an own commit watch before the receipt does not pause queued fields", async () => {
  let resolve!: (value: { ok: true; value: SettingsMutation }) => void;
  const mutate = vi
    .fn<SettingsStoreTransport["mutate"]>()
    .mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    )
    .mockResolvedValueOnce({ ok: true, value: receipt(2) });
  const store = createContributedSettingsStore(initial, {
    validate: () => true,
    mutate,
    read: async () => initial,
  });
  store.edit("enabled", false, "change", true);
  store.edit("name", "next", "enter", false);
  const own = receipt(1, [
    { key: "enabled", value: false },
    { key: "name", value: "old" },
  ]);
  store.external(own.snapshot);
  resolve({ ok: true, value: own });
  await store.idle();
  expect(mutate).toHaveBeenCalledTimes(2);
  expect(mutate.mock.calls[1]![0].expectedRevision).toBe(own.receipt.revision);
  expect(store.state().errors).toEqual([]);
});

it("retry waits for the outstanding mutation instead of creating a second writer", async () => {
  let finish!: (value: { ok: true; value: SettingsMutation }) => void;
  const mutate = vi
    .fn<SettingsStoreTransport["mutate"]>()
    .mockImplementationOnce(
      () =>
        new Promise((done) => {
          finish = done;
        }),
    )
    .mockResolvedValue({ ok: true, value: receipt(2) });
  const store = createContributedSettingsStore(initial, {
    validate: () => true,
    mutate,
    read: async () => receipt(1).snapshot,
  });
  store.edit("name", "one", "enter", false);
  store.edit("name", "two", "change", false);
  const retry = store.retry("name");
  await Promise.resolve();
  await Promise.resolve();
  expect(mutate).toHaveBeenCalledOnce();
  finish({ ok: true, value: receipt(1) });
  await retry;
  expect(mutate).toHaveBeenCalledTimes(2);
  expect(mutate.mock.calls[1]![0]).toMatchObject({
    value: "two",
    expectedRevision: receipt(1).receipt.revision,
  });
});

it("paused edits and queued fields remain visibly unsaved through retry", async () => {
  const mutate = vi
    .fn<SettingsStoreTransport["mutate"]>()
    .mockResolvedValueOnce({
      ok: false,
      error: { code: "PLUGIN_E_SETTINGS_SAVE", message: "Failed" },
    })
    .mockResolvedValue({ ok: true, value: receipt(1) });
  const store = createContributedSettingsStore(initial, {
    validate: () => true,
    mutate,
    read: async () => initial,
  });
  store.edit("enabled", false, "change", true);
  store.edit("name", "queued", "enter", false);
  await store.idle();
  expect(store.state().errors.map((x) => x.key)).toContain("name");
  store.edit("name", "paused", "enter", false);
  expect(store.state().errors.map((x) => x.key)).toContain("name");
  store.fail("Unavailable");
  expect(store.state().errors).toContainEqual({ key: "name", message: { en: "Unavailable" } });
  await store.retry("enabled");
  expect(store.state().errors.map((x) => x.key)).toContain("name");
  expect(mutate).toHaveBeenCalledTimes(2);
});
it("reload preserves edits made while the read is pending with an unsaved marker", async () => {
  let finish!: (value: SettingsSnapshot) => void;
  const read = vi.fn(
    () =>
      new Promise<SettingsSnapshot>((resolve) => {
        finish = resolve;
      }),
  );
  const mutate = vi.fn();
  const store = createContributedSettingsStore(initial, { validate: () => true, mutate, read });
  const reload = store.reload();
  await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
  store.edit("name", "during reload", "enter", false);
  finish(initial);
  await reload;
  expect(store.state().draft).toContainEqual({ key: "name", value: "during reload" });
  expect(store.state().errors.map((x) => x.key)).toContain("name");
  expect(mutate).not.toHaveBeenCalled();
});
it("failure is visible even with no dirty fields", () => {
  const store = createContributedSettingsStore(initial, {
    validate: () => true,
    mutate: vi.fn(),
    read: async () => initial,
  });
  store.fail("Catalog unavailable");
  expect(store.state().errors).toEqual(
    initial.values.map(({ key }) => ({ key, message: { en: "Catalog unavailable" } })),
  );
});

it.each(
  (["reload", "retry", "unknown"] as const).flatMap((operation) =>
    [false, true].map((afterResolution) => ({ operation, afterResolution })),
  ),
)(
  "$operation reconciliation cannot overwrite a later snapshot (read resolved: $afterResolution)",
  async ({ operation, afterResolution }) => {
    let finish!: (value: SettingsSnapshot) => void;
    const read = vi.fn(
      () =>
        new Promise<SettingsSnapshot>((resolve) => {
          finish = resolve;
        }),
    );
    const mutate = vi.fn<SettingsStoreTransport["mutate"]>(async () => ({
      ok: false,
      error: {
        code: "PLUGIN_E_SETTINGS_SAVE",
        message: "Unknown",
        detail: { kind: "persistence", reason: "publish-uncertain", disposition: "unknown" },
      },
    }));
    const store = createContributedSettingsStore(initial, { validate: () => true, mutate, read });
    store.edit("name", "draft", "change", false);
    const reconcile =
      operation === "reload"
        ? store.reload()
        : operation === "retry"
          ? store.retry("name")
          : (store.edit("name", "draft", "enter", false), store.idle());
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
    if (!afterResolution) store.external(receipt(3).snapshot);
    finish(receipt(2).snapshot);
    if (afterResolution) {
      // Replace after the transport continuation, before the store applies it.
      await Promise.resolve();
      store.external(receipt(3).snapshot);
    }
    await reconcile;
    expect(store.state().baseline).toEqual(receipt(3).snapshot);
    expect(store.state().draft).toContainEqual({ key: "name", value: "draft" });
    expect(mutate).toHaveBeenCalledTimes(operation === "unknown" ? 1 : 0);
  },
);

it.each(["reload", "retry"] as const)(
  "idle waits for actual %s reconciliation",
  async (operation) => {
    let finish!: (value: SettingsSnapshot) => void;
    const read = vi.fn(
      () =>
        new Promise<SettingsSnapshot>((resolve) => {
          finish = resolve;
        }),
    );
    const store = createContributedSettingsStore(initial, {
      validate: () => true,
      mutate: async () => ({ ok: true, value: receipt(2) }),
      read,
    });
    store.edit("name", "draft", "change", false);
    const reconciliation = operation === "reload" ? store.reload() : store.retry("name");
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
    // A second action is ignored by the existing guard; it must not release idle.
    await store.reload();
    const settled = vi.fn();
    const idle = store.idle().then(settled);
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    finish(receipt(1).snapshot);
    await reconciliation;
    await idle;
    expect(settled).toHaveBeenCalledOnce();
  },
);
