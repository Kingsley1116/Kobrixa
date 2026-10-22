import { expect, it } from "vitest";
import { DraftCache, copyDraft } from "./draft-cache.js";
import { binding, entry, panel } from "./contract.test.js";

it("copies only admitted own fields and scalars without retaining caller aliases or prototypes", () => {
  const cache = new DraftCache();
  const payload = {
    draft: { speed: 12, enabled: true, foreign: "discard" },
    raw: { speed: "12", foreign: "discard" },
  };
  cache.retain(entry, binding, panel, payload);
  payload.draft.speed = 99;
  payload.raw.speed = "99";
  const restored = cache.restore(entry, binding)!;
  expect(restored).toEqual({ draft: { speed: 12, enabled: true }, raw: { speed: "12" } });
  restored.draft.speed = 50;
  restored.raw.speed = "50";
  expect(cache.restore(entry, binding)).toEqual({
    draft: { speed: 12, enabled: true },
    raw: { speed: "12" },
  });
  expect(copyDraft(panel, { draft: Object.create({ speed: 1 }), raw: {} })).toEqual({
    draft: {},
    raw: {},
  });
  expect(copyDraft(panel, { draft: { speed: {} as never, enabled: false }, raw: {} })).toEqual({
    draft: { enabled: false },
    raw: {},
  });
  cache.clear();
  expect(cache.restore(entry, binding)).toBeUndefined();
});

it("uses deterministic LRU for at most 16 contributions and refreshes on restore", () => {
  const cache = new DraftCache();
  const item = (i: number) => ({ ...entry, id: `acme.ui.panel-${i}` });
  for (let i = 0; i < 16; i++)
    cache.retain(item(i), binding, panel, { draft: { speed: i }, raw: {} });
  expect(cache.restore(item(0), binding)?.draft.speed).toBe(0);
  cache.retain(item(16), binding, panel, { draft: { speed: 16 }, raw: {} });
  expect(cache.restore(item(1), binding)).toBeUndefined();
  expect(cache.restore(item(0), binding)?.draft.speed).toBe(0);
  expect(cache.restore(item(16), binding)?.draft.speed).toBe(16);
  cache.retain(item(2), binding, panel, { draft: { speed: 22 }, raw: {} });
  cache.retain(item(17), binding, panel, { draft: { speed: 17 }, raw: {} });
  expect(cache.restore(item(3), binding)).toBeUndefined();
  expect(cache.restore(item(2), binding)?.draft.speed).toBe(22);
});

it("enforces exact UTF-8 payload bytes, the aggregate bound, and whole-entry oversize rejection", () => {
  const cache = new DraftCache();
  const resource = structuredClone(panel);
  resource.fields = Object.fromEntries(
    ["a", "b", "c"].map((key) => [
      key,
      {
        schema: { type: "string" as const, nullable: false, maxLength: 4000 },
        initial: "",
        required: false,
      },
    ]),
  );
  const payload = {
    draft: { a: "😀".repeat(4000), b: "", c: "" },
    raw: { a: "😀".repeat(4000), b: "", c: "" },
  };
  const base = new TextEncoder().encode(JSON.stringify(payload)).length;
  payload.raw.b = "x".repeat(32768 - base);
  expect(new TextEncoder().encode(JSON.stringify(payload))).toHaveLength(32768);
  for (let i = 0; i < 16; i++)
    cache.retain({ ...entry, id: `acme.ui.panel-${i}` }, binding, resource, payload);
  // Sixteen exact-limit entries reach (and do not exceed) 524,288 bytes.
  for (let i = 0; i < 16; i++)
    expect(cache.restore({ ...entry, id: `acme.ui.panel-${i}` }, binding)).toEqual(payload);
  cache.retain(entry, binding, resource, payload);
  expect(cache.restore({ ...entry, id: "acme.ui.panel-0" }, binding)).toBeUndefined();
  payload.raw.b += "x";
  cache.retain(entry, binding, resource, payload);
  expect(cache.restore(entry, binding)).toBeUndefined();
});

it("bounds raw by code points, preserves invalid null/raw, and rejects stale identities", () => {
  const cache = new DraftCache();
  const payload = { draft: { speed: null }, raw: { speed: "-" } };
  cache.retain(entry, binding, panel, payload);
  expect(cache.restore(entry, binding)).toEqual(payload);
  cache.retain(entry, binding, panel, {
    draft: { speed: null },
    raw: { speed: "😀".repeat(4001) },
  });
  expect(cache.restore(entry, binding)).toBeUndefined();
  cache.retain(entry, binding, panel, payload);
  expect(
    copyDraft(panel, { draft: { speed: null }, raw: { speed: "😀".repeat(4000) } }).raw.speed,
  ).toHaveLength(8000);
  expect(
    copyDraft(panel, { draft: { speed: null }, raw: { speed: "😀".repeat(4001) } }).raw,
  ).toEqual({});
  expect(cache.restore(entry, { ...binding, processEpoch: "new-process" })).toBeUndefined();
  // Once rejected, even the former execution cannot recover it.
  expect(cache.restore(entry, binding)).toBeUndefined();
  for (const replacement of [
    { ...entry, resourceDigest: "b".repeat(64) },
    { ...entry, uiResourceGeneration: 2 },
    { ...entry, availability: "unavailable" as const },
  ]) {
    cache.retain(entry, binding, panel, payload);
    cache.reconcile([replacement], binding.hostEpoch);
    expect(cache.restore(entry, binding)).toBeUndefined();
  }
});
