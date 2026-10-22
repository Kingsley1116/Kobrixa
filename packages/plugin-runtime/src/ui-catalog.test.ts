import { expect, it, vi } from "vitest";
import { validateUiResource, uiBytes } from "@kobrixa/plugin-protocol";
import { mkdtemp, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { UiCatalog } from "./ui-catalog.js";
import type { UiCatalogSource } from "./ui-host-ports.js";
const h = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const raw = JSON.stringify({
  kind: "status",
  text: { text: { en: "Ready" } },
  tone: "neutral",
  data: {},
});
const source = (n = 1): UiCatalogSource => ({
  owner: {
    sourceKey: `source-${String(n).padStart(2, "0")}`,
    pluginId: `test.p${n}`,
    generation: 1,
    hostEpoch: h(1),
    processEpoch: h(n + 1),
  },
  eligible: true,
  resources: { kind: "builtin", files: { "status.json": raw } },
  commands: [],
  panels: [],
  status: [
    {
      id: `test.p${n}.status`,
      title: { en: "Status" },
      resource: { version: 1, path: "status.json" },
    },
  ],
});
const entry = async (catalog: UiCatalog) => {
  const result = await catalog.catalog({});
  if (!result.ok) throw new Error("catalog failed");
  return result.value.entries[0]!;
};
it("U04/B1-RF1 subscribes before fetching; retirement rejects old pages, resources and late reads", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const catalog = new UiCatalog(h(1), {
    read: async () => {
      await gate;
      return { value: JSON.parse(raw), bytes: raw.length, digest: "a".repeat(64) };
    },
  });
  const events: string[] = [];
  catalog.onEvent((event) => events.push(event.type));
  const input = source();
  const loading = catalog.replace([input]);
  catalog.retire(input.owner);
  release();
  await loading;
  expect(await catalog.catalog({})).toMatchObject({ ok: true, value: { entries: [] } });
  expect(events.length).toBeGreaterThanOrEqual(2);
  await catalog.replace([source(2)]);
  const old = await entry(catalog);
  catalog.retire(source(2).owner);
  expect(
    await catalog.resource({
      sourceKey: old.sourceKey,
      id: old.id,
      uiResourceGeneration: old.uiResourceGeneration,
      resourceDigest: old.resourceDigest,
    }),
  ).toMatchObject({
    ok: false,
    error: { code: "PLUGIN_E_STALE_RESOURCE", detail: { kind: "resource" } },
  });
});
it("U03 admits in sorted order and charges repeated paths separately", async () => {
  const seen: string[] = [];
  const read = vi.fn(async (input: UiCatalogSource, file: string, limit: number) => {
    seen.push(`${input.owner.sourceKey}/${file}`);
    if (limit < 262144) throw new Error("over budget");
    return { value: JSON.parse(raw), bytes: 262144, digest: "b".repeat(64) };
  });
  const sources = Array.from({ length: 9 }, (_, n) => {
    const input = source(n + 1);
    input.panels = Array.from({ length: 4 }, (_, i) => ({
      id: `${input.owner.pluginId}.p${i}`,
      title: { en: "Panel" },
      location: "right" as const,
      resource: { version: 1, path: "same.json" },
    }));
    input.status = [];
    return input;
  });
  const catalog = new UiCatalog(h(1), {
    read,
    validate: () => ({
      ok: true,
      value: {
        kind: "panel",
        data: {},
        fields: {},
        root: "root",
        nodes: [
          { id: "root", type: "group", layout: "stack", children: ["text"] },
          { id: "text", type: "help", value: { text: { en: "Test" } } },
        ],
      },
    }),
  });
  await catalog.replace(sources.reverse());
  expect(seen[0]).toBe("source-01/same.json");
  expect(read).toHaveBeenCalledTimes(32);
  const entries = [];
  let page = await catalog.catalog({});
  while (page.ok) {
    entries.push(...page.value.entries);
    if (!page.value.nextCursor) break;
    page = await catalog.catalog({ cursor: page.value.nextCursor });
  }
  expect(entries.filter((e) => e.availability === "available")).toHaveLength(32);
  expect(entries.filter((e) => e.availability === "unavailable")).toHaveLength(4);
});
it("U03/U04 pages at 16 entries and binds cursors to revision and 30-second expiry", async () => {
  let now = 0;
  const catalog = new UiCatalog(h(1), { now: () => now });
  await catalog.replace(Array.from({ length: 20 }, (_, n) => source(n + 1)));
  const first = await catalog.catalog({});
  if (!first.ok) throw new Error("catalog failed");
  expect(first.value.entries).toHaveLength(16);
  expect(first.value.nextCursor).not.toBeNull();
  expect(Buffer.byteLength(JSON.stringify(first.value))).toBeLessThanOrEqual(262144);
  now = 30000;
  expect((await catalog.catalog({ cursor: first.value.nextCursor! })).ok).toBe(false);
  const fresh = await catalog.catalog({});
  if (!fresh.ok) throw new Error("catalog failed");
  catalog.retire(source().owner);
  expect((await catalog.catalog({ cursor: fresh.value.nextCursor! })).ok).toBe(false);
});
it("U04 resource retry advances UI generation without changing execution or static identity", async () => {
  const input = source();
  const catalog = new UiCatalog(h(1));
  await catalog.replace([input]);
  const old = await entry(catalog);
  expect(
    await catalog.reportFailure({
      sourceKey: old.sourceKey,
      id: old.id,
      uiResourceGeneration: old.uiResourceGeneration,
      catalogRevision: ((await catalog.catalog({})) as { ok: true; value: { revision: number } })
        .value.revision,
      reason: "renderer",
    }),
  ).toMatchObject({ ok: true, value: { accepted: true } });
  expect((await entry(catalog)).availability).toBe("unavailable");
  await catalog.retry(input.owner.sourceKey);
  const current = await entry(catalog);
  expect(current.uiResourceGeneration).toBeGreaterThan(old.uiResourceGeneration);
  expect(input.owner.generation).toBe(1);
  expect(current.availability).toBe("available");
  expect(
    (
      await catalog.resource({
        sourceKey: old.sourceKey,
        id: old.id,
        uiResourceGeneration: old.uiResourceGeneration,
        resourceDigest: old.resourceDigest,
      })
    ).ok,
  ).toBe(false);
});
it("U02 excludes safe-mode sources before any I/O and rejects escaping symlinks", async () => {
  const read = vi.fn();
  const catalog = new UiCatalog(h(1), { read });
  await catalog.replace([{ ...source(), eligible: false }]);
  expect(read).not.toHaveBeenCalled();
  const root = await mkdtemp(path.join(tmpdir(), "kobrixa-ui-"));
  try {
    const inside = path.join(root, "plugin");
    const outside = path.join(root, "outside.json");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(inside);
    await writeFile(outside, raw);
    await symlink(outside, path.join(inside, "status.json"));
    const real = new UiCatalog(h(1));
    await real.replace([{ ...source(), resources: { kind: "packaged", root: inside } }]);
    expect((await entry(real)).availability).toBe("unavailable");
    expect((await entry(real)).problem?.message).not.toContain(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it("U03 source reads share one five-second budget and a timed-out result never revives", async () => {
  vi.useFakeTimers();
  try {
    const catalog = new UiCatalog(h(1), { read: () => new Promise(() => {}) });
    const pending = catalog.replace([source()]);
    await vi.advanceTimersByTimeAsync(5000);
    await pending;
    expect((await entry(catalog)).availability).toBe("unavailable");
  } finally {
    vi.useRealTimers();
  }
});

it("U03 accounts BOM and whitespace from original bytes and rejects maximum plus one", async () => {
  const catalog = new UiCatalog(h(1));
  const input = source();
  const padded = "\ufeff" + raw + " ".repeat(262144 - Buffer.byteLength(raw) - 3);
  input.resources = { kind: "builtin", files: { "status.json": padded } };
  await catalog.replace([input]);
  expect(await entry(catalog)).toMatchObject({ availability: "available", resourceBytes: 262144 });
  const admitted = await entry(catalog);
  const response = await catalog.resource({
    sourceKey: admitted.sourceKey,
    id: admitted.id,
    uiResourceGeneration: admitted.uiResourceGeneration,
    resourceDigest: admitted.resourceDigest,
  });
  if (!response.ok) throw new Error("resource read failed");
  expect(response.value.rawBytes).toBe(admitted.resourceBytes);
  expect(response.value.validationContext.pluginId).toBe(admitted.pluginId);
  expect(
    validateUiResource(
      response.value.resource,
      response.value.validationContext,
      Math.max(response.value.rawBytes, uiBytes(response.value.resource)),
    ).ok,
  ).toBe(true);
  const digest = (await entry(catalog)).resourceDigest;
  input.resources = { kind: "builtin", files: { "status.json": padded + " " } };
  await catalog.replace([input]);
  expect((await entry(catalog)).availability).toBe("unavailable");
  expect(
    (
      await catalog.resource({
        sourceKey: input.owner.sourceKey,
        id: input.status[0]!.id,
        uiResourceGeneration: 1,
        resourceDigest: digest,
      })
    ).ok,
  ).toBe(false);
});
it("U04 explicit retry preserves unrelated source resource generations", async () => {
  const catalog = new UiCatalog(h(1));
  await catalog.replace([source(1), source(2)]);
  const before = await catalog.catalog({});
  if (!before.ok) throw new Error("catalog failed");
  await catalog.retry(source(1).owner.sourceKey);
  const after = await catalog.catalog({});
  if (!after.ok) throw new Error("catalog failed");
  expect(after.value.entries[0]!.uiResourceGeneration).toBeGreaterThan(
    before.value.entries[0]!.uiResourceGeneration,
  );
  expect(after.value.entries[1]!.uiResourceGeneration).toBe(
    before.value.entries[1]!.uiResourceGeneration,
  );
});
