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

const panelV2 = () => ({
  kind: "panel" as const,
  root: "root",
  data: {
    presentation: {
      schema: {
        type: "number" as const,
        min: 0,
        max: Number.MAX_SAFE_INTEGER,
        integer: true,
        nullable: false,
      },
      initial: 0,
    },
  },
  fields: {},
  presentationKey: "presentation",
  datasets: {
    rows: {
      kind: "table" as const,
      columns: [{ id: "value", label: { en: "Value" }, value: "number" as const }],
    },
  },
  nodes: [
    { id: "root", type: "group" as const, layout: "stack" as const, children: ["rows"] },
    { id: "rows", type: "table" as const, dataset: "rows", label: { en: "Rows" } },
  ],
});
const v2Source = (n = 1): UiCatalogSource => ({
  ...source(n),
  resources: { kind: "builtin", files: { "panel.json": JSON.stringify(panelV2()) } },
  status: [],
  panels: [
    {
      id: `test.p${n}.panel`,
      title: { en: "Panel" },
      location: "right",
      resource: { version: 2, path: "panel.json" },
    },
  ],
});
const load = async (catalog: UiCatalog) => {
  const item = await entry(catalog);
  return catalog.resource({
    sourceKey: item.sourceKey,
    id: item.id,
    uiResourceGeneration: item.uiResourceGeneration,
    resourceDigest: item.resourceDigest,
  });
};
it("keeps production defaults v1 and quarantines declared v2 before reading", async () => {
  const read = vi.fn();
  const catalog = new UiCatalog(h(1), { read });
  await catalog.replace([v2Source()]);
  expect(read).not.toHaveBeenCalled();
  expect(await entry(catalog)).toMatchObject({
    version: 2,
    availability: "unavailable",
    problem: { code: "PLUGIN_E_UI_VERSION" },
  });
  expect((await load(catalog)).ok).toBe(false);
  const normal = new UiCatalog(h(1));
  await normal.replace([source()]);
  expect(await load(normal)).toMatchObject({
    ok: true,
    value: { version: 1, resource: { kind: "status" } },
  });
});
it("returns discriminated v1/v2 resources using only their declared parser", async () => {
  const validate = vi.fn(validateUiResource);
  const versions: (1 | 2)[] = [1, 2];
  const catalog = new UiCatalog(h(1), { supportedResourceVersions: versions, validate });
  versions.pop(); // Configuration is captured, not mutable authority.
  await catalog.replace([v2Source()]);
  const result = await load(catalog);
  if (!result.ok || result.value.version !== 2 || result.value.resource.kind !== "panel")
    throw new Error("Expected v2 panel");
  expect(result.value.resource.datasets.rows?.kind).toBe("table");
  expect(result.value.resource.nodes.some((n) => n.type === "table")).toBe(true);
  expect(result.value.validationContext.panels[0]?.resource.version).toBe(2);
  expect(validate).not.toHaveBeenCalled();
  result.value.resource.presentationKey = "changed";
  expect(await load(catalog)).toMatchObject({
    ok: true,
    value: { version: 2, resource: { presentationKey: "presentation" } },
  });
  await catalog.replace([source()]);
  expect(await load(catalog)).toMatchObject({ ok: true, value: { version: 1 } });
  expect(validate).toHaveBeenCalledTimes(1);
});
it("fails closed on wrong-version content and unsupported declarations without relabeling", async () => {
  const catalog = new UiCatalog(h(1), { supportedResourceVersions: [1, 2] });
  const input = v2Source();
  input.panels = input.panels.map((p) => ({ ...p, resource: { ...p.resource, version: 1 } }));
  await catalog.replace([input]);
  expect(await entry(catalog)).toMatchObject({
    version: 1,
    availability: "unavailable",
    problem: { code: "PLUGIN_E_UI_RESOURCE" },
  });
  const read = vi.fn();
  const unknown = new UiCatalog(h(1), { supportedResourceVersions: [1, 2], read });
  for (const version of [3, 65535]) {
    await unknown.replace([
      {
        ...input,
        panels: input.panels.map((p) => ({ ...p, resource: { ...p.resource, version } })),
      },
    ]);
    expect(await entry(unknown)).toMatchObject({
      version,
      availability: "unavailable",
      problem: { code: "PLUGIN_E_UI_VERSION" },
    });
  }
  expect(read).not.toHaveBeenCalled();
  const missing = panelV2();
  missing.presentationKey = "missing";
  await catalog.replace([
    {
      ...v2Source(),
      resources: { kind: "builtin", files: { "panel.json": JSON.stringify(missing) } },
    },
  ]);
  expect(await entry(catalog)).toMatchObject({
    version: 2,
    availability: "unavailable",
    problem: { code: "PLUGIN_E_UI_RESOURCE" },
  });
});
it("validates opt-in v2 status actions and rejects contribution-kind mismatch", async () => {
  const catalog = new UiCatalog(h(1), { supportedResourceVersions: [1, 2] });
  const input = source();
  input.status = input.status.map((d) => ({ ...d, resource: { ...d.resource, version: 2 } }));
  input.resources = {
    kind: "builtin",
    files: {
      "status.json": JSON.stringify({
        kind: "status",
        data: {},
        text: { text: { en: "Ready" } },
        tone: "neutral",
        actions: [],
      }),
    },
  };
  await catalog.replace([input]);
  expect(await load(catalog)).toMatchObject({
    ok: true,
    value: { version: 2, resource: { kind: "status", actions: [] } },
  });
  input.resources = { kind: "builtin", files: { "status.json": JSON.stringify(panelV2()) } };
  await catalog.replace([input]);
  expect(await entry(catalog)).toMatchObject({
    availability: "unavailable",
    problem: { code: "PLUGIN_E_UI_RESOURCE" },
  });
});
it("retains original v2 byte accounting/digest and rejects maximum plus one", async () => {
  const catalog = new UiCatalog(h(1), { supportedResourceVersions: [1, 2] });
  const input = v2Source(),
    json = JSON.stringify(panelV2());
  const padded = "\ufeff" + json + " ".repeat(262144 - Buffer.byteLength(json) - 3);
  input.resources = { kind: "builtin", files: { "panel.json": padded } };
  await catalog.replace([input]);
  const accepted = await entry(catalog);
  expect(accepted).toMatchObject({ version: 2, availability: "available", resourceBytes: 262144 });
  expect(await load(catalog)).toMatchObject({ ok: true, value: { version: 2, rawBytes: 262144 } });
  const { createHash } = await import("node:crypto");
  expect(accepted.resourceDigest).toBe(createHash("sha256").update(padded).digest("hex"));
  expect((await catalog.resource({ ...accepted, resourceDigest: "f".repeat(64) })).ok).toBe(false);
  input.resources = { kind: "builtin", files: { "panel.json": padded + " " } };
  await catalog.replace([input]);
  expect(await entry(catalog)).toMatchObject({ version: 2, availability: "unavailable" });
  expect((await catalog.resource(accepted)).ok).toBe(false);
});
it("charges v2 repeated reads to the same host budget and preserves sorted admission", async () => {
  const limits: number[] = [];
  const catalog = new UiCatalog(h(1), {
    supportedResourceVersions: [1, 2],
    read: async (_input, _path, limit) => {
      limits.push(limit);
      return { value: panelV2(), bytes: 262144, digest: "a".repeat(64) };
    },
  });
  const inputs = Array.from({ length: 9 }, (_, i) => {
    const input = v2Source(i + 1);
    input.panels = Array.from({ length: 4 }, (_, j) => ({
      ...input.panels[0]!,
      id: `${input.owner.pluginId}.panel${j}`,
    }));
    return input;
  });
  await catalog.replace(inputs.reverse());
  const entries = [];
  let page = await catalog.catalog({});
  while (page.ok) {
    entries.push(...page.value.entries);
    if (!page.value.nextCursor) break;
    page = await catalog.catalog({ cursor: page.value.nextCursor });
  }
  expect(limits).toHaveLength(32);
  expect(limits.every((limit) => limit === 262144)).toBe(true);
  expect(entries.filter((e) => e.availability === "available")).toHaveLength(32);
  expect(entries.every((e) => e.version === 2)).toBe(true);
  expect(entries[0]?.sourceKey).toBe("source-01");
});
it("v2 quarantine/retry preserves version and invalidates old generations, not unrelated owners", async () => {
  const catalog = new UiCatalog(h(1), { supportedResourceVersions: [1, 2] });
  await catalog.replace([v2Source(), source(2)]);
  const before = await catalog.catalog({});
  if (!before.ok) throw new Error("catalog failed");
  const old = before.value.entries[0]!,
    other = before.value.entries[1]!;
  expect(
    await catalog.reportFailure({
      ...old,
      catalogRevision: before.value.revision,
      reason: "validation",
    }),
  ).toMatchObject({ ok: true, value: { accepted: true } });
  expect(await entry(catalog)).toMatchObject({ version: 2, availability: "unavailable" });
  expect((await catalog.resource(old)).ok).toBe(false);
  await catalog.retry(old.sourceKey);
  expect(await load(catalog)).toMatchObject({ ok: true, value: { version: 2 } });
  expect((await catalog.resource(old)).ok).toBe(false);
  expect((await catalog.resource(other)).ok).toBe(true);
});
it("late v2 reads cannot revive a retired owner or overwrite its replacement", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reads = 0;
  const catalog = new UiCatalog(h(1), {
    supportedResourceVersions: [1, 2],
    read: async () => {
      if (++reads === 1) await gate;
      return { value: panelV2(), bytes: 1000, digest: "a".repeat(64) };
    },
  });
  const old = v2Source();
  const pending = catalog.replace([old]);
  catalog.retire(old.owner);
  await catalog.replace([v2Source(2)]);
  release();
  await pending;
  const page = await catalog.catalog({});
  if (!page.ok) throw new Error("catalog failed");
  expect(page.value.entries).toHaveLength(1);
  expect(page.value.entries[0]).toMatchObject({
    sourceKey: "source-02",
    version: 2,
    availability: "available",
  });
});
