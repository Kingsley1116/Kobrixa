import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";

// W10 supplies live routes from its sole composition. This module never constructs
// a host, backend, worker, SDK substitute, or profile lock. Raw JSON is necessary
// for invalidParams cases which a typed SDK correctly refuses to serialize.
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type ObjectValue = { [key: string]: Json };
export type SettingsNegativeChannel = "owner" | "other" | "denied" | "window-a" | "window-b";
export type SettingsNegativeReply = {
  id: number;
  jsonrpc: "2.0";
  result?: { ok: boolean; value?: ObjectValue; error?: { code: string; detail?: ObjectValue } };
  error?: { code: number; message: string };
};
type ManifestReplacement = {
  victimSourceKey: string;
  previous: { sourceKey: string; pluginId: string };
  current: { sourceKey: string; pluginId: string };
};
type Tree = Array<{ path: string; kind: "directory" | "file"; bytes?: number; sha256?: string }>;
export type SettingsNegativeSnapshot = {
  hostEpoch: string;
  tree: Tree;
  quota: ObjectValue[];
  handles: string[];
  tickets: Json[];
  diskTreeHash: string;
  core: ObjectValue;
  watchEvents: Json[];
};
export type SettingsNegativeSession = {
  profilePath: string;
  /** owner/other are distinct sources; denied lacks settings.write/storage.write.
   * window-a/window-b are distinct real windows sharing owner's settings source.
   * Resource: schema 1, count integer 0..10 default 1; text maxBytes 4096,
   * maxLength 4000, default "" (same resource as worker.test.ts).
   * Return original serialized response, never a synthesized business result. */
  exchange(channel: SettingsNegativeChannel, request: string): Promise<string>;
  /** Capture worker quota, live handles, core snapshot and delivered watch events
   * after an actual worker evidence barrier. Do not reset event history. */
  observe(): Promise<Omit<SettingsNegativeSnapshot, "tree" | "diskTreeHash">>;
  /** Close/drain original host, reopen same profile via W10, return fresh routes. */
  reopen(): Promise<SettingsNegativeSession>;
  close(): Promise<void>;
  /** W10 binds these to the two real renderer windows, never an in-memory draft. */
  /** Replace the actual other manifest ID and reconnect its original public route. */
  replaceOtherManifestId?(): Promise<ManifestReplacement>;
  settingsWindows?: {
    prepareDrafts(values: [number, number]): Promise<void>;
    readDrafts(): Promise<{ windowIds: [number, number]; values: [number, number] }>;
  };
};
type Wire = { channel: SettingsNegativeChannel; request: string; response: string };
export type SettingsNegativeReceipt = {
  id: string;
  scope: "attached-host-worker";
  status: "observed-slice";
  wire: Wire[];
  snapshots: Record<string, SettingsNegativeSnapshot>;
  incomplete: string[];
  manifestReplacement?: ManifestReplacement;
  drafts?: {
    before: { windowIds: [number, number]; values: [number, number] };
    after: { windowIds: [number, number]; values: [number, number] };
  };
};
export const SETTINGS_NEGATIVE_IDS = ["N01", "N02", "N03", "N04", "N05", "N06"] as const;
type RowId = (typeof SETTINGS_NEGATIVE_IDS)[number];
const digest = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
async function tree(root: string, prefix = ""): Promise<Tree> {
  const result: Tree = [];
  for (const name of (await readdir(path.join(root, prefix))).sort()) {
    const relative = path.join(prefix, name),
      absolute = path.join(root, relative);
    const stat = await lstat(absolute);
    assert.equal(stat.isSymbolicLink(), false, `Unexpected symlink: ${relative}`);
    if (stat.isDirectory()) {
      result.push({ path: relative, kind: "directory" }, ...(await tree(root, relative)));
    } else {
      assert.ok(stat.isFile());
      const bytes = await readFile(absolute);
      result.push({ path: relative, kind: "file", bytes: bytes.length, sha256: digest(bytes) });
    }
  }
  return result;
}
export function settingsNegativeValue(reply: SettingsNegativeReply): ObjectValue {
  assert.equal(reply.error, undefined);
  assert.equal(reply.result?.ok, true, JSON.stringify(reply));
  assert.ok(reply.result?.value);
  return reply.result.value;
}
export function assertSettingsNegativeError(
  reply: SettingsNegativeReply,
  code: number | string,
): void {
  if (typeof code === "number") {
    assert.equal(reply.result, undefined);
    assert.equal(reply.error?.code, code);
  } else {
    assert.equal(reply.error, undefined);
    assert.equal(reply.result?.ok, false);
    assert.equal(reply.result?.value, undefined);
    assert.equal(reply.result?.error?.code, code);
  }
}
const object = (value: Json | undefined): ObjectValue => {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value;
};
const string = (value: Json | undefined): string => {
  assert.equal(typeof value, "string");
  return value as string;
};
export function assertSettingsNegativeUnchanged(
  before: SettingsNegativeSnapshot,
  after: SettingsNegativeSnapshot,
): void {
  for (const key of [
    "hostEpoch",
    "tree",
    "diskTreeHash",
    "quota",
    "handles",
    "tickets",
    "core",
    "watchEvents",
  ] as const)
    assert.deepEqual(after[key], before[key], `Rejected operation changed ${key}`);
}
export function assertSettingsNegativeReceipt(receipt: SettingsNegativeReceipt): void {
  assert.ok(SETTINGS_NEGATIVE_IDS.some((id) => receipt.id === `B2-${id}`));
  assert.equal(receipt.scope, "attached-host-worker");
  assert.equal(receipt.status, "observed-slice");
  assert.ok(receipt.wire.length > 0);
  for (const row of receipt.wire) {
    const request = JSON.parse(row.request),
      reply = JSON.parse(row.response);
    assert.equal(request.jsonrpc, "2.0");
    assert.equal(reply.jsonrpc, "2.0");
    assert.equal(request.id, reply.id);
    assert.equal(typeof request.method, "string");
    assert.ok(Boolean(reply.error) !== Boolean(reply.result));
  }
  for (const snapshot of Object.values(receipt.snapshots)) {
    assert.match(snapshot.hostEpoch, /^[0-9a-f-]{36}$/);
    assert.ok(snapshot.quota.length > 0);
    assert.ok(Array.isArray(snapshot.handles));
    assert.ok(Array.isArray(snapshot.tickets));
    assert.equal(snapshot.diskTreeHash, digest(JSON.stringify(snapshot.tree)));
    for (const result of snapshot.quota) {
      assert.equal(result.ok, true);
      const quota = object(result.value);
      for (const key of [
        "recordCount",
        "reservedCreates",
        "committedBytes",
        "reservedBytes",
        "pinnedBytes",
        "temporaryBytes",
        "hostAvailableBytes",
        "writeSlotsAvailable",
        "exportSlotsAvailable",
      ]) {
        assert.ok(Number.isSafeInteger(quota[key]) && Number(quota[key]) >= 0, key);
      }
      assert.ok(Number(quota.recordCount) + Number(quota.reservedCreates) <= 256);
      assert.ok(Number(quota.committedBytes) + Number(quota.reservedBytes) <= 536870912);
      assert.ok(Number(quota.hostAvailableBytes) <= 1073741824);
      assert.ok(Number(quota.writeSlotsAvailable) <= 2);
      assert.ok(Number(quota.exportSlotsAvailable) <= 1);
    }
    assert.ok(snapshot.core && typeof snapshot.core === "object");
    for (const item of snapshot.tree)
      if (item.kind === "file") {
        assert.match(item.sha256!, /^[0-9a-f]{64}$/);
        assert.ok(Number.isSafeInteger(item.bytes) && item.bytes! >= 0);
      }
  }
  const required: Record<string, string[]> = {
    "B2-N01": [
      "settings/update",
      "storage/beginWrite",
      "foreign",
      "missing",
      "owner",
      "sourceKey",
      "pluginId",
      "path",
      "foreign-read",
      "foreign-write",
      "foreign-cursor",
      "renamed-manifest",
    ],
    "B2-N02": ["unknown", "coercion", "duplicate", "bytes", "total-bytes", "1e999", "-1e999"],
    "B2-N03": [],
    "B2-N04": [
      "busy-storage/beginWrite",
      "busy-storage/delete",
      "stale-storage/beginWrite",
      "stale-storage/delete",
    ],
    "B2-N05": [],
    "B2-N06": [
      "offset-1",
      "offset-262145",
      "retry",
      "overlap",
      ...[Buffer.alloc(262145).toString("base64"), "!===", "YQ=", "YR=="].map(
        (s) => `encoding-${digest(s)}`,
      ),
    ],
  };
  assert.ok(receipt.snapshots.baseline);
  for (const label of required[receipt.id]!) {
    const before = receipt.snapshots[`${label}:before`],
      after = receipt.snapshots[`${label}:after`];
    assert.ok(before && after, `Missing ${label} observations`);
    assertSettingsNegativeUnchanged(before, after);
  }
  const calls = receipt.wire.map((row) => ({
    channel: row.channel,
    request: JSON.parse(row.request),
    reply: JSON.parse(row.response) as SettingsNegativeReply,
  }));
  const denied = (method: string, code: string | number) => {
    const candidates = calls.filter(
      (r) =>
        r.request.method === method &&
        (r.reply.error?.code === code || r.reply.result?.error?.code === code),
    );
    assert.ok(candidates.length > 0, `Missing ${method} ${code}`);
    for (const row of candidates) assertSettingsNegativeError(row.reply, code);
  };
  if (receipt.id === "B2-N01") {
    const change = receipt.manifestReplacement;
    assert.ok(change, "Missing real manifest-ID replacement");
    assert.notEqual(change.previous.pluginId, change.current.pluginId);
    assert.notEqual(change.previous.sourceKey, change.victimSourceKey);
    assert.notEqual(change.current.sourceKey, change.victimSourceKey);
    for (const value of [
      change.victimSourceKey,
      change.previous.sourceKey,
      change.current.sourceKey,
      change.previous.pluginId,
      change.current.pluginId,
    ])
      assert.ok(typeof value === "string" && value.length > 0);
    denied("settings/update", "PLUGIN_E_PERMISSION_DENIED");
    denied("storage/beginWrite", "PLUGIN_E_PERMISSION_DENIED");
    for (const method of ["storage/stat", "storage/readChunk", "storage/abortWrite"])
      denied(method, "PLUGIN_E_STALE_RESOURCE");
    denied("storage/stat", -32602);
  }
  if (receipt.id === "B2-N02") {
    denied("settings/update", -32602);
    denied("settings/update", "PLUGIN_E_SETTINGS_SCHEMA");
    assert.ok(receipt.snapshots["watch-control"]!.watchEvents.length > 0);
  }
  if (receipt.id === "B2-N03") {
    const racing = calls.filter(
      (r) => r.request.method === "settings/update" && ["window-a", "window-b"].includes(r.channel),
    );
    assert.ok(receipt.drafts, "Missing actual renderer draft observations");
    assert.equal(new Set(receipt.drafts.before.windowIds).size, 2);
    for (const id of receipt.drafts.before.windowIds) assert.ok(Number.isSafeInteger(id) && id > 0);
    assert.deepEqual(receipt.drafts.after.windowIds, receipt.drafts.before.windowIds);
    assert.deepEqual(receipt.drafts.before.values, [8, 9]);
    assert.equal(racing.length, 2);
    assert.equal(new Set(racing.map((r) => r.channel)).size, 2);
    assert.equal(
      racing[0]!.request.params.expectedRevision,
      racing[1]!.request.params.expectedRevision,
    );
    assert.equal(racing.filter((r) => r.reply.result?.ok).length, 1);
    const losingChannel = racing.find((r) => !r.reply.result?.ok)!.channel;
    const loserIndex = losingChannel === "window-a" ? 0 : 1;
    assert.equal(receipt.drafts.after.values[loserIndex], receipt.drafts.before.values[loserIndex]);
    assertSettingsNegativeError(
      racing.find((r) => !r.reply.result?.ok)!.reply,
      "PLUGIN_E_SETTINGS_CONFLICT",
    );
  }
  if (receipt.id === "B2-N04") {
    denied("storage/beginWrite", "PLUGIN_E_STORAGE_CONFLICT");
    denied("storage/delete", "PLUGIN_E_STORAGE_CONFLICT");
  }
  if (receipt.id === "B2-N05") {
    denied("storage/beginWrite", "PLUGIN_E_STORAGE_QUOTA");
    const quota = object(receipt.snapshots["quota-contention"]!.quota[0]!.value);
    assert.equal(quota.reservedCreates, 2);
    assert.equal(quota.writeSlotsAvailable, 0);
  }
  if (receipt.id === "B2-N06") {
    denied("storage/writeChunk", -32602);
    denied("storage/writeChunk", "PLUGIN_E_STORAGE_CONFLICT");
    denied("storage/sealWrite", "PLUGIN_E_STORAGE_CONFLICT");
    assert.ok(receipt.snapshots["checksum-rejected"]);
  }
  const cleaned = receipt.snapshots.cleaned,
    reopened = receipt.snapshots.reopened;
  assert.ok(cleaned && reopened, "Missing cleanup/reopen observation");
  assert.notEqual(cleaned.hostEpoch, reopened.hostEpoch);
  assert.deepEqual(cleaned.handles, []);
  assert.deepEqual(reopened.handles, []);
  assert.deepEqual(reopened.quota, cleaned.quota);
  assert.ok(
    receipt.incomplete.includes(
      "W10 native composition and dual-transport acceptance not established by this receipt alone",
    ),
  );
  if (receipt.id === "B2-N05") assert.ok(receipt.incomplete.some((s) => s.startsWith("W17:")));
}

/** Execute one isolated row against an already opened W10 composition. Failures
 * propagate; partial raw observations remain in the caller-owned receipt. W10
 * must persist that receipt even on rejection, with its artifact/source binding.
 * No row here is promoted to full matrix PASS, in particular N05 without W17. */
export async function produceSettingsNegative(
  id: RowId,
  initial: SettingsNegativeSession,
  receipt: SettingsNegativeReceipt = {
    id: `B2-${id}`,
    scope: "attached-host-worker",
    status: "observed-slice",
    wire: [],
    snapshots: {},
    incomplete: [
      "W10 native composition and dual-transport acceptance not established by this receipt alone",
    ],
  },
): Promise<SettingsNegativeReceipt> {
  assert.ok(SETTINGS_NEGATIVE_IDS.includes(id));
  assert.equal(receipt.id, `B2-${id}`);
  let session = initial,
    sequence = 0;
  const writes = new Set<string>(),
    reads = new Set<string>();
  const call = async (
    method: string,
    params: ObjectValue,
    channel: SettingsNegativeChannel = "owner",
    raw?: string,
  ) => {
    const request = `{"jsonrpc":"2.0","id":${++sequence},"method":${JSON.stringify(method)},"params":${raw ?? JSON.stringify(params)}}`;
    const response = await session.exchange(channel, request);
    receipt.wire.push({ channel, request, response });
    const reply = JSON.parse(response) as SettingsNegativeReply;
    assert.equal(reply.id, JSON.parse(request).id);
    assert.equal(reply.jsonrpc, "2.0");
    return reply;
  };
  const value = async (
    method: string,
    params: ObjectValue,
    channel: SettingsNegativeChannel = "owner",
  ) => settingsNegativeValue(await call(method, params, channel));
  const capture = async (label: string) => {
    const observed = await session.observe();
    const disk = await tree(session.profilePath);
    const snapshot = {
      ...structuredClone(observed),
      tree: disk,
      diskTreeHash: digest(JSON.stringify(disk)),
    };
    receipt.snapshots[label] = snapshot;
    return snapshot;
  };
  const reject = async (
    label: string,
    method: string,
    params: ObjectValue,
    code: number | string,
    channel: SettingsNegativeChannel = "owner",
    raw?: string,
  ) => {
    const before = await capture(`${label}:before`);
    const reply = await call(method, params, channel, raw);
    assertSettingsNegativeError(reply, code);
    assertSettingsNegativeUnchanged(before, await capture(`${label}:after`));
    return reply;
  };
  const input = (bytes: Buffer, target: ObjectValue = { mode: "create" }) => ({
    target,
    kind: "test.negative",
    schemaVersion: 1,
    label: "W09a",
    mediaType: "application/octet-stream",
    byteLength: bytes.length,
    sha256: digest(bytes),
  });
  const begin = async (bytes: Buffer, target?: ObjectValue) => {
    const v = await value("storage/beginWrite", input(bytes, target));
    writes.add(string(v.write));
    return v;
  };
  const stage = async (write: string, bytes: Buffer) => {
    await value("storage/writeChunk", { write, offset: 0, data: bytes.toString("base64") });
    await value("storage/sealWrite", { write });
  };
  const seedBytes = Buffer.from("W09a original complete payload");
  let seed: ObjectValue | undefined, savedSettings: ObjectValue | undefined;
  let failure: unknown;
  try {
    savedSettings = object(
      (
        await value("settings/update", {
          schemaVersion: 1,
          expectedRevision: null,
          changes: [{ key: "count", value: 7 }],
        })
      ).snapshot,
    );
    const revision = savedSettings.revision!;
    const seeded = await begin(seedBytes);
    await stage(string(seeded.write), seedBytes);
    seed = object((await value("storage/commitWrite", { write: seeded.write! })).record);
    const update = {
      schemaVersion: 1,
      expectedRevision: revision,
      changes: [{ key: "count", value: 8 }],
    };
    await capture("baseline");
    if (id === "N01") {
      for (const [method, params] of [
        ["settings/update", update],
        ["storage/beginWrite", input(seedBytes)],
      ] as const)
        await reject(method, method, params, "PLUGIN_E_PERMISSION_DENIED", "denied");
      const foreign = await reject(
        "foreign",
        "storage/stat",
        { id: seed.id! },
        "PLUGIN_E_STALE_RESOURCE",
        "other",
      );
      const missing = await reject(
        "missing",
        "storage/stat",
        { id: randomUUID() },
        "PLUGIN_E_STALE_RESOURCE",
        "other",
      );
      assert.deepEqual(foreign.result, missing.result);
      for (const key of ["owner", "sourceKey", "pluginId", "path"])
        await reject(key, "storage/stat", { id: seed.id!, [key]: "forged" }, -32602);
      const read = string(
        (
          await value("storage/openRead", {
            id: seed.id!,
            expectedRevision: seed.revision!,
            schemaVersion: 1,
          })
        ).read,
      );
      reads.add(read);
      const write = string((await begin(seedBytes)).write);
      await reject(
        "foreign-read",
        "storage/readChunk",
        { read, offset: 0, maxBytes: 1 },
        "PLUGIN_E_STALE_RESOURCE",
        "other",
      );
      await reject(
        "foreign-write",
        "storage/abortWrite",
        { write },
        "PLUGIN_E_STALE_RESOURCE",
        "other",
      );
      const extra = await begin(Buffer.from("second page"));
      await stage(string(extra.write), Buffer.from("second page"));
      await value("storage/commitWrite", { write: extra.write! });
      const page = await value("storage/list", { limit: 1 });
      const cursor = string(page.nextCursor);
      await reject(
        "foreign-cursor",
        "storage/list",
        { limit: 1, cursor },
        "PLUGIN_E_STALE_RESOURCE",
        "other",
      );
      await value("storage/list", { limit: 1, cursor });
      assert.ok(session.replaceOtherManifestId, "W10 must attach real manifest-ID replacement");
      receipt.manifestReplacement = await session.replaceOtherManifestId();
      await reject(
        "renamed-manifest",
        "storage/stat",
        { id: seed.id! },
        "PLUGIN_E_STALE_RESOURCE",
        "other",
      );
    } else if (id === "N02") {
      const watch = await value("settings/watch", { schemaVersion: 1 });
      // Positive control: observe an actual watch event before relying on its absence.
      savedSettings = object(
        (
          await value("settings/update", {
            ...update,
            changes: [{ key: "text", value: "watch-control" }],
          })
        ).snapshot,
      );
      const watched = await capture("watch-control");
      assert.ok(watched.watchEvents.length > 0);
      const cases: [string, Json[], number | string][] = [
        ["unknown", [{ key: "unknown", value: 1 }], "PLUGIN_E_SETTINGS_SCHEMA"],
        ["coercion", [{ key: "count", value: "2" }], "PLUGIN_E_SETTINGS_SCHEMA"],
        [
          "duplicate",
          [
            { key: "count", value: 2 },
            { key: "count", value: 3 },
          ],
          -32602,
        ],
        ["bytes", [{ key: "text", value: "é".repeat(2048) + "a" }], -32602],
      ];
      const changes = Array.from({ length: 17 }, (_, i) => ({
        key: `text${i}`,
        value: i < 16 ? "a".repeat(4000) : "",
      }));
      changes[16]!.value = "a".repeat(65537 - Buffer.byteLength(JSON.stringify(changes)));
      assert.equal(Buffer.byteLength(JSON.stringify(changes)), 65537);
      cases.push(["total-bytes", changes, -32602]);
      for (const [label, changes, code] of cases)
        await reject(
          label,
          "settings/update",
          { ...update, expectedRevision: savedSettings.revision!, changes },
          code,
        );
      for (const number of ["1e999", "-1e999"])
        await reject(
          number,
          "settings/update",
          {},
          -32602,
          "owner",
          `{"schemaVersion":1,"expectedRevision":${JSON.stringify(savedSettings.revision)},"changes":[{"key":"count","value":${number}}]}`,
        );
      await value("events/unsubscribe", { subscriptionId: watch.subscriptionId! });
    } else if (id === "N03") {
      assert.ok(session.settingsWindows, "W10 must attach two real renderer draft observers");
      await session.settingsWindows.prepareDrafts([8, 9]);
      const draftBefore = await session.settingsWindows.readDrafts();
      const drafts = [update, { ...update, changes: [{ key: "count", value: 9 }] }];
      const replies = await Promise.all(
        drafts.map((draft, index) =>
          call("settings/update", draft, index === 0 ? "window-a" : "window-b"),
        ),
      );
      assert.equal(replies.filter((r) => r.result?.ok).length, 1);
      const loser = replies.findIndex((r) => !r.result?.ok);
      assertSettingsNegativeError(replies[loser]!, "PLUGIN_E_SETTINGS_CONFLICT");
      savedSettings = object(settingsNegativeValue(replies[1 - loser]!).snapshot);
      assert.notEqual(savedSettings.revision, revision);
      receipt.drafts = { before: draftBefore, after: await session.settingsWindows.readDrafts() };
    } else if (id === "N04") {
      const read = string(
        (
          await value("storage/openRead", {
            id: seed.id!,
            expectedRevision: seed.revision!,
            schemaVersion: 1,
          })
        ).read,
      );
      reads.add(read);
      const bytes = Buffer.from("W09a complete replacement");
      const target = { mode: "replace", id: seed.id!, expectedRevision: seed.revision! };
      const replacement = string((await begin(bytes, target)).write);
      await stage(replacement, bytes);
      for (const [method, params] of [
        ["storage/beginWrite", input(bytes, target)],
        ["storage/delete", { id: seed.id!, expectedRevision: seed.revision! }],
      ] as const)
        await reject(`busy-${method}`, method, params, "PLUGIN_E_STORAGE_CONFLICT");
      const committed = await value("storage/commitWrite", { write: replacement });
      assert.deepEqual(await value("storage/commitWrite", { write: replacement }), committed);
      for (const [method, params] of [
        ["storage/beginWrite", input(bytes, target)],
        ["storage/delete", { id: seed.id!, expectedRevision: seed.revision! }],
      ] as const)
        await reject(`stale-${method}`, method, params, "PLUGIN_E_STORAGE_CONFLICT");
      assert.equal(
        (await value("storage/readChunk", { read, offset: 0, maxBytes: 262144 })).data,
        seedBytes.toString("base64"),
      );
      seed = object(committed.record);
    } else if (id === "N05") {
      // Two source staging slots: three simultaneous creates must admit exactly two.
      const outcomes = await Promise.all(
        Array.from({ length: 3 }, () => call("storage/beginWrite", input(seedBytes))),
      );
      for (const r of outcomes)
        if (r.result?.ok) writes.add(string(settingsNegativeValue(r).write));
      assert.equal(outcomes.filter((r) => r.result?.ok).length, 2);
      assertSettingsNegativeError(
        outcomes.find((r) => !r.result?.ok)!,
        "PLUGIN_E_STORAGE_QUOTA",
      );
      await capture("quota-contention");
      receipt.incomplete.push(
        "W17: secondary startup before worker/store initialization, primary focus and uninterrupted recording require final installed receipt",
      );
    } else {
      const bytes = Buffer.alloc(262144, 0x61),
        write = string((await begin(bytes)).write);
      for (const data of [Buffer.alloc(262145).toString("base64"), "!===", "YQ=", "YR=="])
        await reject(
          `encoding-${digest(data)}`,
          "storage/writeChunk",
          { write, offset: 0, data },
          -32602,
        );
      await value("storage/writeChunk", { write, offset: 0, data: bytes.toString("base64") });
      for (const offset of [1, bytes.length + 1])
        await reject(
          `offset-${offset}`,
          "storage/writeChunk",
          { write, offset, data: "Yg==" },
          "PLUGIN_E_STORAGE_CONFLICT",
        );
      const before = await capture("retry:before");
      assert.equal(
        (await value("storage/writeChunk", { write, offset: 0, data: bytes.toString("base64") }))
          .receivedBytes,
        bytes.length,
      );
      assertSettingsNegativeUnchanged(before, await capture("retry:after"));
      await reject(
        "overlap",
        "storage/writeChunk",
        { write, offset: 0, data: Buffer.alloc(bytes.length, 0x62).toString("base64") },
        "PLUGIN_E_STORAGE_CONFLICT",
      );
      await value("storage/abortWrite", { write });
      writes.delete(write);
      const wrong = string((await begin(Buffer.from("expected"))).write);
      await value("storage/writeChunk", {
        write: wrong,
        offset: 0,
        data: Buffer.from("wrong!!!").toString("base64"),
      });
      assertSettingsNegativeError(
        await call("storage/sealWrite", { write: wrong }),
        "PLUGIN_E_STORAGE_CONFLICT",
      );
      const commit = await call("storage/commitWrite", { write: wrong });
      assert.equal(commit.result?.ok, false);
      await capture("checksum-rejected");
    }
    assert.deepEqual(await value("settings/read", { schemaVersion: 1 }), savedSettings);
  } catch (error) {
    failure = error;
  }
  const errors: unknown[] = [];
  for (const read of reads)
    try {
      await value("storage/closeRead", { read });
    } catch (error) {
      errors.push(error);
    }
  for (const write of writes)
    try {
      await value("storage/abortWrite", { write });
    } catch (error) {
      errors.push(error);
    }
  try {
    await capture("cleaned");
    session = await session.reopen();
    await capture("reopened");
    if (savedSettings)
      assert.deepEqual(await value("settings/read", { schemaVersion: 1 }), savedSettings);
    if (seed) assert.deepEqual((await value("storage/stat", { id: seed.id! })).record, seed);
    for (const write of writes)
      assertSettingsNegativeError(
        await call("storage/writeStatus", { write }),
        "PLUGIN_E_STALE_RESOURCE",
      );
    for (const read of reads)
      assertSettingsNegativeError(
        await call("storage/readChunk", { read, offset: 0, maxBytes: 1 }),
        "PLUGIN_E_STALE_RESOURCE",
      );
  } catch (error) {
    errors.push(error);
  }
  try {
    await session.close();
  } catch (error) {
    errors.push(error);
  }
  if (failure || errors.length)
    throw new AggregateError(
      [...(failure ? [failure] : []), ...errors],
      `B2-${id} failed; retain caller-owned raw receipt`,
    );
  assertSettingsNegativeReceipt(receipt);
  return receipt;
}
