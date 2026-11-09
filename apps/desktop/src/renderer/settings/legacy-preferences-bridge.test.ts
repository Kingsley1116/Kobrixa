import { describe, expect, it, vi } from "vitest";
import type {
  LegacyPreferenceChallenge,
  LegacyPreferencesSnapshot,
} from "../../shared/plugin-persistence.js";
import { collectLegacyPreferences, submitLegacyPreferences } from "./legacy-preferences-bridge.js";

const challenge: LegacyPreferenceChallenge = {
  nonce: "10000000-0000-4000-8000-000000000002",
  scope: {
    hostEpoch: "10000000-0000-4000-8000-000000000001",
    workbenchInstance: "10000000-0000-4000-8000-000000000003",
  },
  descriptorId: "synthetic.preferences",
  keys: ["fixture.layout", "fixture.number"],
};

describe("V170 legacy preference snapshot", () => {
  it("reads only the trusted allowlist, preserves raw strings/null, and never writes originals", () => {
    const storage = {
      getItem: vi.fn((key: string) => (key === "fixture.layout" ? "001" : null)),
      setItem: vi.fn(),
      removeItem: vi.fn(),
      clear: vi.fn(),
      key: vi.fn(),
    };
    expect(collectLegacyPreferences(challenge, storage)).toEqual({
      nonce: challenge.nonce,
      scope: challenge.scope,
      entries: [
        { key: "fixture.layout", raw: "001" },
        { key: "fixture.number", raw: null },
      ],
    });
    expect(storage.getItem.mock.calls).toEqual([["fixture.layout"], ["fixture.number"]]);
    for (const method of [storage.setItem, storage.removeItem, storage.clear, storage.key])
      expect(method).not.toHaveBeenCalled();
  });

  it("keeps rejected challenge pending without reading storage", async () => {
    const storage = vi.fn(() => ({ getItem: vi.fn(() => null) }));
    const submit = vi.fn(async () => ({ state: "accepted" as const }));
    expect(
      await submitLegacyPreferences(
        {
          challenge: async () => {
            throw new Error("Descriptor not admitted");
          },
          submit,
        },
        storage,
        "synthetic.preferences",
      ),
    ).toBe("pending");
    expect(storage).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });

  it("does not submit empty data after localStorage throws", async () => {
    const submit = vi.fn(async () => ({ state: "accepted" as const }));
    expect(
      await submitLegacyPreferences(
        { challenge: async () => challenge, submit },
        () => {
          throw new Error("Access denied");
        },
        "synthetic.preferences",
      ),
    ).toBe("pending");
    expect(submit).not.toHaveBeenCalled();
  });

  it("requires the main durable acceptance result before reporting accepted", async () => {
    const submit = vi.fn(async () => ({
      state: "pending" as "pending" | "accepted" | "reconciled",
    }));
    const api = { challenge: async () => challenge, submit };
    expect(
      await submitLegacyPreferences(api, () => ({ getItem: () => null }), "synthetic.preferences"),
    ).toBe("pending");
    submit.mockResolvedValueOnce({ state: "accepted" });
    expect(
      await submitLegacyPreferences(api, () => ({ getItem: () => null }), "synthetic.preferences"),
    ).toBe("accepted");
  });

  it.each([
    { ...challenge, keys: ["a", "a"] },
    { ...challenge, keys: Array.from({ length: 129 }, (_, index) => `fixture.${index}`) },
  ])("rejects invalid allowlists before reading", (invalid) => {
    const getItem = vi.fn(() => null);
    expect(() => collectLegacyPreferences(invalid, { getItem })).toThrow();
    expect(getItem).not.toHaveBeenCalled();
  });

  it("bounds UTF-8 bytes and refuses oversized snapshots", () => {
    expect(() =>
      collectLegacyPreferences(challenge, { getItem: () => "界".repeat(22_000) }),
    ).toThrow();
  });
});

import { createDevicePreferencesMigration } from "./legacy-preferences-bridge.js";
import { SettingsStore } from "./settings.js";

const deviceChallenge: LegacyPreferenceChallenge = {
  ...challenge,
  descriptorId: "kobrixa.device-preferences",
  keys: ["kobrixa.connectionMode", "kobrixa.rememberWifiAddress", "kobrixa.lastWifiAddress"],
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function deviceFixture() {
  const raw = new Map([
    ["kobrixa.connectionMode", "wifi"],
    ["kobrixa.rememberWifiAddress", "true"],
    ["kobrixa.lastWifiAddress", " 192.168.0.2 "],
  ]);
  const backing = {
    getItem: vi.fn((key: string) => raw.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      raw.set(key, value);
    }),
  };
  const settings = new SettingsStore(() => backing, "en");
  backing.getItem.mockClear();
  const api = {
    challenge: vi.fn(async () => structuredClone(deviceChallenge)),
    submit: vi.fn(async (_snapshot: LegacyPreferencesSnapshot) => ({
      state: "pending" as "pending" | "accepted" | "reconciled",
    })),
  };
  const storage = vi.fn(() => backing);
  const migration = createDevicePreferencesMigration({ api, settings, storage });
  return { raw, backing, settings, api, storage, migration };
}

describe("per-window device preference capture", () => {
  it("freezes actual legacy writers synchronously while unrelated settings remain writable", async () => {
    const f = deviceFixture();
    expect(f.api.challenge).not.toHaveBeenCalled();
    expect(() => f.settings.set("connectionMode", "usb")).toThrow("frozen");
    expect(() => f.settings.reset("rememberWifiAddress")).toThrow("frozen");
    expect(() => f.settings.rememberAddress("other")).toThrow("frozen");
    f.settings.set("theme", "light");
    f.settings.resetLayout();
    f.settings.save();
    expect(f.backing.setItem.mock.calls.some(([key]) => deviceChallenge.keys.includes(key))).toBe(
      false,
    );
    expect(f.raw.get("kobrixa.theme")).toBe("light");
    await f.migration.retry();
    expect(f.api.challenge).toHaveBeenCalledWith("kobrixa.device-preferences");
    expect(f.api.submit.mock.calls[0]![0].entries).toEqual([
      { key: deviceChallenge.keys[0], raw: "wifi" },
      { key: deviceChallenge.keys[1], raw: "true" },
      { key: deviceChallenge.keys[2], raw: " 192.168.0.2 " },
    ]);
  });

  it("retains the original nonce and bytes across rejected submissions and pending retries", async () => {
    const f = deviceFixture();
    f.api.submit.mockRejectedValueOnce(new Error("nonce response lost"));
    expect(await f.migration.retry()).toBe("pending");
    const first = structuredClone(f.api.submit.mock.calls[0]![0]);
    f.raw.set("kobrixa.lastWifiAddress", "changed by another window");
    expect(await f.migration.retry()).toBe("pending");
    f.api.submit.mockResolvedValueOnce({ state: "reconciled" });
    expect(await f.migration.retry()).toBe("reconciled");
    expect(await f.migration.retry()).toBe("reconciled");
    expect(f.api.submit).toHaveBeenCalledTimes(3);
    for (const [value] of f.api.submit.mock.calls) expect(value).toEqual(first);
    expect(f.api.challenge).toHaveBeenCalledOnce();
    expect(f.storage).toHaveBeenCalledOnce();
    expect(f.backing.getItem).toHaveBeenCalledTimes(3);
  });

  it("does not let API mutation alter the retained capture", async () => {
    const f = deviceFixture();
    f.api.submit.mockImplementationOnce(async (value) => {
      (value.entries[0] as { raw: string | null }).raw = "tampered";
      return { state: "pending" };
    });
    await f.migration.retry();
    await f.migration.retry();
    expect(f.api.submit.mock.calls[1]![0].entries[0]!.raw).toBe("wifi");
  });

  it.each([
    { ...deviceChallenge, descriptorId: "other.preferences" },
    { ...deviceChallenge, keys: deviceChallenge.keys.slice(0, 2) },
    { ...deviceChallenge, keys: [...deviceChallenge.keys, "secret"] },
    {
      ...deviceChallenge,
      keys: [deviceChallenge.keys[0]!, deviceChallenge.keys[0]!, deviceChallenge.keys[2]!],
    },
    { ...deviceChallenge, keys: [deviceChallenge.keys[0]!, deviceChallenge.keys[1]!, "secret"] },
    { ...deviceChallenge, nonce: "invalid" },
    { ...deviceChallenge, scope: { ...deviceChallenge.scope, hostEpoch: "invalid" } },
  ])("rejects malformed or foreign challenges before obtaining storage: %j", async (invalid) => {
    const f = deviceFixture();
    f.api.challenge.mockResolvedValue(invalid);
    expect(await f.migration.retry()).toBe("pending");
    expect(f.storage).not.toHaveBeenCalled();
    expect(f.backing.getItem).not.toHaveBeenCalled();
    expect(f.api.submit).not.toHaveBeenCalled();
  });

  it("leaves unavailable challenges pending and retries without manufacturing a capture", async () => {
    const f = deviceFixture();
    f.api.challenge.mockRejectedValueOnce(new Error("already complete/headless unavailable"));
    expect(await f.migration.retry()).toBe("pending");
    expect(f.storage).not.toHaveBeenCalled();
    expect(f.api.submit).not.toHaveBeenCalled();
    f.api.submit.mockResolvedValueOnce({ state: "accepted" });
    expect(await f.migration.retry()).toBe("accepted");
    expect(await f.migration.retry()).toBe("accepted");
    expect(f.api.challenge).toHaveBeenCalledTimes(2);
    expect(f.api.submit).toHaveBeenCalledOnce();
  });

  it.each(["getter", "partial read", "oversize"])(
    "never submits fabricated empty data on %s failure",
    async (mode) => {
      const f = deviceFixture();
      if (mode === "getter")
        f.storage.mockImplementationOnce(() => {
          throw Error("denied");
        });
      if (mode === "partial read")
        f.backing.getItem
          .mockImplementationOnce(() => "wifi")
          .mockImplementationOnce(() => {
            throw Error("denied");
          });
      if (mode === "oversize") f.backing.getItem.mockReturnValueOnce("界".repeat(30_000));
      expect(await f.migration.retry()).toBe("pending");
      expect(f.api.submit).not.toHaveBeenCalled();
      expect(await f.migration.retry()).toBe("pending");
      expect(f.api.challenge).toHaveBeenCalledOnce();
      expect(f.api.submit).toHaveBeenCalledOnce();
      expect(f.api.submit.mock.calls[0]![0].entries[2]!.raw).toBe(" 192.168.0.2 ");
    },
  );

  it("accepts only the exact three-key set and preserves genuine missing values as null", async () => {
    const f = deviceFixture();
    f.raw.clear();
    f.api.challenge.mockResolvedValueOnce({
      ...deviceChallenge,
      keys: [...deviceChallenge.keys].reverse(),
    });
    await f.migration.retry();
    expect(f.backing.getItem.mock.calls.map(([key]) => key)).toEqual(
      [...deviceChallenge.keys].reverse(),
    );
    expect(f.api.submit.mock.calls[0]![0].entries).toEqual(
      [...deviceChallenge.keys].reverse().map((key) => ({ key, raw: null })),
    );
    expect(f.backing.setItem).not.toHaveBeenCalled();
  });

  it("coalesces concurrent retries through challenge and submission", async () => {
    const f = deviceFixture();
    const opening = deferred<LegacyPreferenceChallenge>();
    const submission = deferred<{ state: "pending" }>();
    f.api.challenge.mockReturnValueOnce(opening.promise);
    f.api.submit.mockReturnValueOnce(submission.promise);
    const first = f.migration.retry();
    expect(f.migration.retry()).toBe(first);
    await vi.waitFor(() => expect(f.api.challenge).toHaveBeenCalledOnce());
    opening.resolve(deviceChallenge);
    await vi.waitFor(() => expect(f.api.submit).toHaveBeenCalledOnce());
    expect(f.migration.retry()).toBe(first);
    submission.resolve({ state: "pending" });
    expect(await first).toBe("pending");
    await f.migration.retry();
    expect(f.api.submit).toHaveBeenCalledTimes(2);
    expect(f.storage).toHaveBeenCalledOnce();
  });

  it.each(["before challenge", "during challenge", "during submit"])(
    "disposal rejects callers and suppresses late application %s",
    async (phase) => {
      const f = deviceFixture();
      const opening = deferred<LegacyPreferenceChallenge>();
      const submission = deferred<{ state: "accepted" }>();
      f.api.challenge.mockReturnValueOnce(opening.promise);
      f.api.submit.mockReturnValueOnce(submission.promise);
      const pending = f.migration.retry();
      const rejected = expect(pending).rejects.toThrow("disposed");
      if (phase !== "before challenge")
        await vi.waitFor(() => expect(f.api.challenge).toHaveBeenCalledOnce());
      if (phase === "during submit") {
        opening.resolve(deviceChallenge);
        await vi.waitFor(() => expect(f.api.submit).toHaveBeenCalledOnce());
      }
      f.migration.dispose();
      f.migration.dispose();
      await rejected;
      opening.resolve(deviceChallenge);
      submission.resolve({ state: "accepted" });
      await new Promise<void>((resolve) => setImmediate(resolve));
      await expect(f.migration.retry()).rejects.toThrow("disposed");
      if (phase !== "during submit") {
        expect(f.storage).not.toHaveBeenCalled();
        expect(f.api.submit).not.toHaveBeenCalled();
      }
    },
  );

  it("freezes each replacement window independently and never revives the disposed capture", async () => {
    const old = deviceFixture();
    await old.migration.retry();
    old.migration.dispose();
    const settings = new SettingsStore(() => old.backing, "en");
    const nextChallenge = {
      ...deviceChallenge,
      nonce: "10000000-0000-4000-8000-000000000004",
      scope: {
        ...deviceChallenge.scope,
        workbenchInstance: "10000000-0000-4000-8000-000000000005",
      },
    };
    old.api.challenge.mockResolvedValueOnce(nextChallenge);
    const next = createDevicePreferencesMigration({ api: old.api, settings, storage: old.storage });
    expect(() => settings.set("connectionMode", "usb")).toThrow("frozen");
    await next.retry();
    expect(old.api.submit.mock.calls[1]![0].nonce).toBe(nextChallenge.nonce);
    expect(old.api.submit.mock.calls[0]![0].nonce).toBe(deviceChallenge.nonce);
    await expect(old.migration.retry()).rejects.toThrow("disposed");
  });
});
