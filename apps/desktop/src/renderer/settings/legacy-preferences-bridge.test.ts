import { describe, expect, it, vi } from "vitest";
import type { LegacyPreferenceChallenge } from "../../shared/plugin-persistence.js";
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
